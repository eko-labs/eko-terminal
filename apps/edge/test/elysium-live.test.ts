import { describe, expect, it } from 'vitest';
import { decodeFunctionResult, encodeFunctionData, getAddress, type Address, type Hex } from 'viem';
import { ELYSIUM_PUBLIC_RPC, loadElysiumRegistry } from '@eko/chain';
import { ELYSIUM_CHAIN_ID } from '@eko/shared';
import { buildSwap, MSG_SENDER, v4QuoterAbi } from '../src/trade.js';
import { TRANSFER_TOPIC } from '../src/tracker.js';

/**
 * Integration against Elysium itself (chain 99901), read-only: the registry's Uniswap contracts exist, the V4 quoter
 * prices a buy in a real Montra pool, and the exact swap EKO builds simulates successfully from a fresh wallet with the
 * coins arriving at the signer (MSG_SENDER). Nothing is signed or sent; the simulation uses eth_simulateV1 with a
 * balance override.
 *
 *   ELYSIUM_LIVE=1 pnpm --filter @eko/edge exec vitest run test/elysium-live.test.ts   (RPC: ELYSIUM_RPC or the public one)
 *
 * Skipped otherwise, so the normal suite never depends on the network.
 */
const live = process.env.ELYSIUM_LIVE === '1';
const rpcUrl = process.env.ELYSIUM_RPC ?? ELYSIUM_PUBLIC_RPC;
const registry = loadElysiumRegistry();
// The pool of the Universal Router swaps captured from Elysium mainnet in test/fixtures/ur-swaps.json.
const KEY = { currency0: '0x0000000000000000000000000000000000000000', currency1: getAddress('0x4da0ff60be75fdff37bfb2252adf23ea27a9acce'), fee: 0, tickSpacing: 60,
  hooks: getAddress('0x3ab88ddc3cf2a012af88b60828edb4553697e5dc') } as const;

let id = 0;
async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
  const body = await res.json() as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}

describe.skipIf(!live)('Elysium mainnet, read-only (ELYSIUM_LIVE=1)', () => {
  it('has the registry\'s Uniswap contracts on chain 99901', async () => {
    expect(Number(await rpc<Hex>('eth_chainId', []))).toBe(ELYSIUM_CHAIN_ID);
    for (const name of ['uniswapV4.universalRouter212', 'uniswapV4.permit2', 'uniswapV4.v4Quoter', 'uniswapV4.poolManager'] as const) {
      const code = await rpc<Hex>('eth_getCode', [registry.address(name), 'latest']);
      expect(code.length, name).toBeGreaterThan(2);
    }
  }, 60_000);

  it('quotes a real Montra pool and simulates EKO\'s exact buy, paying the coins to whoever signs', async () => {
    const amountIn = 10n ** 15n; // 0.001 HYPE
    const quoted = await rpc<Hex>('eth_call', [{ to: registry.address('uniswapV4.v4Quoter'),
      data: encodeFunctionData({ abi: v4QuoterAbi, functionName: 'quoteExactInputSingle', args: [{ poolKey: KEY, zeroForOne: true, exactAmount: amountIn, hookData: '0x' }] }) }, 'latest']);
    const [expectedOut] = decodeFunctionResult({ abi: v4QuoterAbi, functionName: 'quoteExactInputSingle', data: quoted }) as readonly [bigint, bigint];
    expect(expectedOut).toBeGreaterThan(0n);

    const block = await rpc<{ timestamp: Hex }>('eth_getBlockByNumber', ['latest', false]);
    const swap = buildSwap(KEY, 'buy', amountIn, expectedOut / 2n, MSG_SENDER, BigInt(block.timestamp) + 300n);
    const signer = getAddress(`0x${'5e'.repeat(20)}`) as Address; // a fresh address, funded only inside the simulation
    const [result] = await rpc<{ calls: { status: Hex; logs: { address: string; topics: Hex[]; data: Hex }[]; error?: unknown }[] }[]>('eth_simulateV1', [{
      blockStateCalls: [{ stateOverrides: { [signer]: { balance: '0xde0b6b3a7640000' } },
        calls: [{ from: signer, to: registry.address('uniswapV4.universalRouter212'), data: swap.data, value: `0x${swap.value.toString(16)}` }] }],
      validation: false }, 'latest']);
    const call = result!.calls[0]!;
    expect(call.status, JSON.stringify(call.error ?? null)).toBe('0x1');
    const received = call.logs.find(l => l.address.toLowerCase() === KEY.currency1.toLowerCase() && l.topics[0] === TRANSFER_TOPIC
      && `0x${l.topics[2]!.slice(26)}`.toLowerCase() === signer.toLowerCase());
    expect(received, 'the coins go to the signer').toBeTruthy();
    expect(BigInt(received!.data)).toBeGreaterThanOrEqual(expectedOut / 2n);
  }, 60_000);
});
