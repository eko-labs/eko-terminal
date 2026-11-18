/**
 * The one chain this build targets.
 *
 * Every chain-ID check, schema literal and built transaction reads CHAIN_ID from here, so moving EKO to
 * another chain is this one value plus that chain's address registry (packages/chain/addresses.<id>.yaml).
 *
 * Still Robinhood Chain (4663) while the code is converted; the Elysium cut-over switches it to
 * ELYSIUM_CHAIN_ID in one change. See docs/elysium/ for the plan.
 */
export const CHAIN_ID = 4663 as const;
export type ChainId = typeof CHAIN_ID;

/** Kinetiq's Elysium (Arbitrum Orbit L2 settling to HyperEVM). Verified with eth_chainId on 2026-11-10. */
export const ELYSIUM_CHAIN_ID = 99901 as const;
/** Robinhood Chain (Arbitrum Orbit). */
export const ROBINHOOD_CHAIN_ID = 4663 as const;

/**
 * One codebase, one chain per deployment. The edge picks its chain at start-up (EKO_CHAIN=elysium|robinhood) and
 * reports it in PublicConfig.chain; the web reads that at boot. CHAIN_ID above is the old build-time constant and is
 * being replaced by the runtime chain everywhere.
 */
export type ChainKey = 'elysium' | 'robinhood';
export const CHAIN_KEYS = ['elysium', 'robinhood'] as const satisfies readonly ChainKey[];
export const CHAIN_IDS = { elysium: ELYSIUM_CHAIN_ID, robinhood: ROBINHOOD_CHAIN_ID } as const;
export type SupportedChainId = (typeof CHAIN_IDS)[ChainKey];
/** The NETWORKS entry (networks.ts) for each chain. */
export const CHAIN_NETWORK = { elysium: 'elysium-mainnet', robinhood: 'robinhood-mainnet' } as const satisfies Record<ChainKey, string>;
export const isSupportedChainId = (id: number): id is SupportedChainId => id === ELYSIUM_CHAIN_ID || id === ROBINHOOD_CHAIN_ID;
