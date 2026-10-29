import { createConfig, http } from 'wagmi';
import { defineChain } from 'viem';
import { injected } from 'wagmi/connectors';
import { NETWORKS } from '@eko/shared';
import { getPublicClient } from 'wagmi/actions';
import { API_BASE } from './api';

const NET = NETWORKS['elysium-mainnet'];
/** Elysium (Kinetiq's L2 on HyperEVM). Wallets add it as a custom network (no wallet ships it built in yet). */
export const elysium = defineChain({
  id: NET.chainId, name: NET.name, nativeCurrency: { name: 'HYPE', symbol: NET.nativeSymbol, decimals: 18 },
  rpcUrls: { default: { http: [NET.publicRpcUrl] } },
  blockExplorers: { default: { name: 'Elysium Explorer', url: NET.explorerUrl } },
  contracts: { multicall3: { address: NET.contracts.multicall3 } },
});

/**
 * Wallet configuration. Injected wallets are discovered via EIP-6963 (wagmi default).
 * Wallet reads use the keyless API endpoint; receipts read the public chain RPC directly.
 */
export const chains = [elysium] as const;
export const READ_RPC_URL = `${API_BASE}/rpc`;
export const readRpcTransport = () => http(READ_RPC_URL, {
  batch: false, retryCount: 0, fetchOptions: { credentials: 'omit' },
});

export const wagmiConfig = createConfig({
  // The lazy terminal can remount after landing navigation; hydrate in an effect, after render.
  ssr: true,
  chains,
  batch: { multicall: false },
  connectors: [injected()],
  transports: { [elysium.id]: readRpcTransport() },
});

// Packet 113: a separate keyless read configuration has no connectors or paid
// endpoint. Registry checks never consume an EKO server's RPC response.
const receiptReadConfig = createConfig({
  chains: [elysium],
  batch: { multicall: false },
  transports: { [elysium.id]: http(NET.publicRpcUrl, { batch: false, retryCount: 0, fetchOptions: { credentials: 'omit' } }) },
});
export const receiptReadClient = getPublicClient(receiptReadConfig, { chainId: elysium.id })!;

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig;
  }
}

export type SupportedChainId = (typeof chains)[number]['id'];

/**
 * The chain a wallet transaction is sent on. EKO signs on Elysium only: a transaction built for any other chain is
 * refused, never re-targeted. (Server-built transactions still carry the shared CHAIN_ID until trading moves over.)
 */
export function walletChainId(chainId: number): SupportedChainId {
  if (chainId !== elysium.id) throw new Error(`This transaction is for chain ${chainId}; EKO signs on Elysium (${elysium.id}) only.`);
  return elysium.id;
}
