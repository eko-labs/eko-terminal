import { erc20Abi, type Address, type Hex } from 'viem';
import { createSiweMessage } from 'viem/siwe';
import { getConnection, sendTransaction, signMessage, switchChain, waitForTransactionReceipt, writeContract } from 'wagmi/actions';
import { MeSchema, SIWE_STATEMENT, SiweNonceSchema, type Order, type Quote } from '@eko/shared';
import { api, fetchParsed } from './api';
import { wagmiConfig, type SupportedChainId } from './wallet';
import { useApp } from '../store/app';
import { useShell } from '../store/shell';
import { capturedReferral, clearReferral } from './referral';
import { rememberPending, forgetPending } from './pendingReports';
import { CHAIN_ID } from '@eko/shared';
export { flushPendingReports } from './pendingReports';

export function newIdempotencyKey() {
  return `ik_${crypto.randomUUID()}`;
}

/** Sign-In With Ethereum: binds the wallet to this account so on-chain orders are attributable. */
export async function siweSignIn(_chainId: number = CHAIN_ID) {
  await ensureChain(CHAIN_ID);
  const conn = getConnection(wagmiConfig);
  if (!conn.address) throw new Error('Connect a wallet first');
  const { nonce, domain, uri, issuedAt, expirationTime } = await fetchParsed('/auth/siwe/nonce', SiweNonceSchema, { method: 'POST' });
  const message = createSiweMessage({
    domain,
    address: conn.address,
    statement: SIWE_STATEMENT,
    uri,
    version: '1',
    chainId: CHAIN_ID,
    nonce,
    issuedAt: new Date(issuedAt),
    expirationTime: new Date(expirationTime),
  });
  const signature = await signMessage(wagmiConfig, { message });
  if (getConnection(wagmiConfig).address?.toLowerCase() !== conn.address.toLowerCase() || getConnection(wagmiConfig).chainId !== CHAIN_ID) throw new Error('Wallet changed — sign in again or switch back.');
  const ref = capturedReferral();
  await fetchParsed('/auth/siwe/verify', MeSchema, { body: { message, signature, ...(ref ? { ref } : {}) } });
  clearReferral();
  await useApp.getState().refreshSession();
  useShell.getState().realtime?.reconnect();
  return useShell.getState().me;
}

export async function ensureChain(chainId: number) {
  const conn = getConnection(wagmiConfig);
  if (conn.chainId !== chainId) await switchChain(wagmiConfig, { chainId: chainId as SupportedChainId });
}

/** Exact-amount ERC-20 approval (no unlimited allowances), waits for confirmation. */
export async function approveToken(q: Quote): Promise<Hex> {
  if (!q.tx?.approval) throw new Error('No approval needed');
  return approveExactToken(q.tx.approval, q.tx.chainId);
}

/** Shared exact ERC-20 primitive; guarded callers pin the account and revalidate immediately before signing. */
export async function approveExactToken(step: { token: string; spender: string; amount: string }, chainId: number = CHAIN_ID, account?: string, check?: () => void): Promise<Hex> {
  const { token, spender, amount } = step;
  check?.();
  const hash = await writeContract(wagmiConfig, {
    address: token as Address, abi: erc20Abi, functionName: 'approve',
    args: [spender as Address, BigInt(amount)], chainId: chainId as SupportedChainId,
    ...(account ? { account: account as Address } : {}),
  });
  const receipt = await waitForTransactionReceipt(wagmiConfig, { hash, chainId: chainId as SupportedChainId });
  if (receipt.status !== 'success') throw new Error('Approval transaction reverted');
  return hash;
}

const permit2Abi = [{ type: 'function', name: 'approve', stateMutability: 'nonpayable', outputs: [], inputs: [{ type: 'address', name: 'token' },
  { type: 'address', name: 'spender' }, { type: 'uint160', name: 'amount' }, { type: 'uint48', name: 'expiration' }] }] as const;
/** Exact, expiring Permit2 allowance (Uniswap v4 sells); guarded callers validated the step, the router and Permit2. */
export async function approveExactPermit2(step: { token: string; spender: string; amount: string; expiration?: number }, permit2: string, chainId: number = CHAIN_ID, account?: string, check?: () => void): Promise<Hex> {
  if (step.expiration === undefined) throw new Error('Permit2 approval needs an expiration');
  check?.();
  const hash = await writeContract(wagmiConfig, {
    address: permit2 as Address, abi: permit2Abi, functionName: 'approve',
    args: [step.token as Address, step.spender as Address, BigInt(step.amount), step.expiration], chainId: chainId as SupportedChainId,
    ...(account ? { account: account as Address } : {}),
  });
  const receipt = await waitForTransactionReceipt(wagmiConfig, { hash, chainId: chainId as SupportedChainId });
  if (receipt.status !== 'success') throw new Error('Approval transaction reverted');
  return hash;
}

export function isUserRejection(err: unknown): boolean {
  const e = err as { name?: string; code?: number; shortMessage?: string; message?: string; cause?: unknown };
  if (e?.name === 'UserRejectedRequestError' || e?.code === 4001) return true;
  if (/user (rejected|denied)|rejected the request/i.test(e?.shortMessage ?? e?.message ?? '')) return true;
  return e?.cause ? isUserRejection(e.cause) : false;
}

/**
 * Wallet signs and broadcasts the server-built swap. The order is marked SUBMITTED on hash —
 * confirmation comes only from the server's receipt reconciliation.
 */
export async function signAndSubmit(order: Order, tx: NonNullable<Quote['tx']>): Promise<{ order: Order }> {
  const t0 = performance.now();
  let hash: Hex;
  try {
    hash = await sendTransaction(wagmiConfig, {
      to: tx.swap.to as Address,
      data: tx.swap.data as Hex,
      value: BigInt(tx.swap.value),
      chainId: tx.chainId as SupportedChainId,
    });
  } catch (err) {
    const rejected = isUserRejection(err);
    await api(`/api/orders/${order.id}/rejected`, {
      body: {
        code: rejected ? 'user_rejected' : 'wallet_error',
        message: rejected ? 'Rejected in wallet' : ((err as { shortMessage?: string }).shortMessage ?? (err as Error).message ?? 'Wallet error').slice(0, 280),
      },
    }).catch(() => undefined);
    throw err;
  }
  rememberPending(order.id, hash);
  const r = await api<{ order: Order }>(`/api/orders/${order.id}/submitted`, { body: { txHash: hash, walletMs: performance.now() - t0 } });
  forgetPending(order.id);
  return r;
}
