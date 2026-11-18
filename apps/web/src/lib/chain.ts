import { CHAIN_IDS, type ChainKey, type SupportedChainId } from '@eko/shared';

/**
 * The chain this web build serves. One deployment serves one chain: the image is built with EKO_CHAIN
 * (Dockerfile.edge passes it to Vite as VITE_EKO_CHAIN), so chain-specific copy and wallet setup are fixed at build
 * time. The server reports the same chain in PublicConfig.chain; a mismatch is a deployment error.
 */
export const CHAIN_KEY: ChainKey = import.meta.env.VITE_EKO_CHAIN === 'robinhood' ? 'robinhood' : 'elysium';
export const BUILD_CHAIN_ID: SupportedChainId = CHAIN_IDS[CHAIN_KEY];

/** Pick this build's value from a per-chain table: `pick({ elysium: 'HYPE', robinhood: 'ETH' })`. */
export const pick = <T>(byChain: Record<ChainKey, T>): T => byChain[CHAIN_KEY];
