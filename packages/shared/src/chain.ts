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
