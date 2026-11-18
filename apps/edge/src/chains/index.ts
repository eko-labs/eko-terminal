import { loadElysiumRegistry } from '@eko/chain';
import { CHAIN_KEYS, type ChainKey } from '@eko/shared';
import { elysiumChain } from './elysium/index.js';
import { robinhoodChain } from './robinhood/index.js';
import { ELYSIUM_PROFILE, ROBINHOOD_PROFILE } from './profiles.js';
import type { ChainAdapter, ChainProfile } from './types.js';

export type { ChainAdapter, ChainProfile } from './types.js';
export { ELYSIUM_PROFILE, ROBINHOOD_PROFILE } from './profiles.js';
export const PROFILES: Record<ChainKey, ChainProfile> = { elysium: ELYSIUM_PROFILE, robinhood: ROBINHOOD_PROFILE };

/**
 * The deployment's chain from EKO_CHAIN: "elysium" (the default, unset or blank) or "robinhood". Anything else stops
 * the edge at start-up: a typo must never quietly serve the other chain.
 */
export function chainKeyFrom(value: string | undefined): ChainKey {
  const v = (value ?? '').trim();
  if (!v) return 'elysium';
  if ((CHAIN_KEYS as readonly string[]).includes(v)) return v as ChainKey;
  throw new Error(`EKO_CHAIN must be one of ${CHAIN_KEYS.join(', ')}; got "${v.slice(0, 40)}".`);
}

/** The adapter for a chain, with its registry loaded. `flags` are the features on (EKO_FLAGS): a chain's adapter may read
 *  the ones that change what it follows (more_launchpads on Robinhood Chain). */
export function loadChain(key: ChainKey, flags: ReadonlySet<string> = new Set()): ChainAdapter {
  return key === 'elysium' ? elysiumChain(loadElysiumRegistry()) : robinhoodChain(undefined, { moreLaunchpads: flags.has('more_launchpads') });
}
