import { createConfig, http, type Transport } from 'wagmi';
import { defineChain } from 'viem';
import { injected } from 'wagmi/connectors';
import { CHAIN_IDS, CHAIN_NETWORK, NETWORKS, type ChainKey } from '@eko/shared';
import { getPublicClient } from 'wagmi/actions';
import { API_BASE } from './api';
import { BUILD_CHAIN_ID, CHAIN_KEY } from './chain';
import { assertDeploymentChain } from './deployment';

/** Per-chain wallet labels the network registry does not carry. */
const WALLET_LABELS = {
  elysium: { native: 'HYPE', explorer: 'Elysium Explorer' },
  robinhood: { native: 'Ether', explorer: 'Blockscout' },
} as const satisfies Record<ChainKey, { native: string; explorer: string }>;

/**
 * A wallet chain built from the shared network registry. Elysium (Kinetiq's L2 on HyperEVM) and Robinhood Chain
 * (Arbitrum Orbit, native ETH, Blockscout explorer) are both added by wallets as custom networks if missing.
 */
export function walletChain(key: ChainKey) {
  const net = NETWORKS[CHAIN_NETWORK[key]], labels = WALLET_LABELS[key];
  return defineChain({
    id: CHAIN_IDS[key], name: net.name, nativeCurrency: { name: labels.native, symbol: net.nativeSymbol, decimals: 18 },
    rpcUrls: { default: { http: [net.publicRpcUrl] } },
    blockExplorers: { default: { name: labels.explorer, url: net.explorerUrl } },
    contracts: { multicall3: { address: net.contracts.multicall3 } },
  });
}
/** The one chain this build signs on (VITE_EKO_CHAIN). */
export const buildChain = walletChain(CHAIN_KEY);
const NET = NETWORKS[CHAIN_NETWORK[CHAIN_KEY]];

/**
 * Wallet configuration. Injected wallets are discovered via EIP-6963 (wagmi default).
 * Wallet reads use the keyless API endpoint; receipts read the public chain RPC directly.
 */
export const chains = [buildChain] as const;
export const READ_RPC_URL = `${API_BASE}/rpc`;
export const readRpcTransport = () => http(READ_RPC_URL, {
  batch: false, retryCount: 0, fetchOptions: { credentials: 'omit' },
});
// One chain per build: the id type is still the union of both, so the single-entry map is widened to it.
const onBuildChain = (transport: Transport) => ({ [buildChain.id]: transport }) as Record<typeof buildChain.id, Transport>;

export const wagmiConfig = createConfig({
  // The lazy terminal can remount after landing navigation; hydrate in an effect, after render.
  ssr: true,
  chains,
  batch: { multicall: false },
  connectors: [injected()],
  transports: onBuildChain(readRpcTransport()),
});

// Packet 113: a separate keyless read configuration has no connectors or paid
// endpoint. Registry checks never consume an EKO server's RPC response.
const receiptReadConfig = createConfig({
  chains: [buildChain],
  batch: { multicall: false },
  transports: onBuildChain(http(NET.publicRpcUrl, { batch: false, retryCount: 0, fetchOptions: { credentials: 'omit' } })),
});
export const receiptReadClient = getPublicClient(receiptReadConfig, { chainId: buildChain.id })!;

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig;
  }
}

export type SupportedChainId = (typeof chains)[number]['id'];

/**
 * The chain a wallet transaction is sent on. EKO signs on this build's chain only: a transaction built for any other
 * chain is refused, never re-targeted, and nothing is signed while the server reports a different chain.
 */
export function walletChainId(chainId: number): SupportedChainId {
  assertDeploymentChain();
  if (chainId !== BUILD_CHAIN_ID) throw new Error(`This transaction is for chain ${chainId}; EKO signs on ${NET.name} (${BUILD_CHAIN_ID}) only.`);
  return BUILD_CHAIN_ID;
}
