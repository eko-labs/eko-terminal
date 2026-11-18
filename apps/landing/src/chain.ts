/** The chain this landing build serves (see apps/web/src/lib/chain.ts): set at build time by VITE_EKO_CHAIN. */
export type ChainKey = 'elysium' | 'robinhood';
export const CHAIN_KEY: ChainKey = import.meta.env.VITE_EKO_CHAIN === 'robinhood' ? 'robinhood' : 'elysium';
export const pick = <T>(byChain: Record<ChainKey, T>): T => byChain[CHAIN_KEY];

/**
 * Chain wording shared by several sections. The Elysium strings are the ones the page has always shown (its build must
 * stay byte-identical); the Robinhood ones come from the earlier Robinhood landing, minus anything the light build
 * dropped (bots, receipts registry, burns, points, a token, AI analysis of coins). The non-affiliation line names
 * Robinhood Markets, Inc., as the earlier product did.
 */
export const CHAIN_NAME = pick({ elysium: 'Elysium', robinhood: 'Robinhood Chain' });
export const NON_AFFILIATION = pick({
  elysium: 'Not affiliated with, endorsed by, or officially connected with Kinetiq or Hyperliquid.',
  robinhood: 'Not affiliated with, endorsed by, or officially connected with Robinhood Markets, Inc.',
});
