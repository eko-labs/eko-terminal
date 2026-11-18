import { ElysiumRegistry } from '@eko/chain';
import { HypeUsd } from '../../hype.js';
import { ELYSIUM_PROFILE } from '../profiles.js';
import type { ChainAdapter } from '../types.js';
import { elysiumFacts, excludedFor, probeCoin } from './assess.js';
import { elysiumHistorian } from './historian.js';
import { elysiumTrade } from './trade.js';
import { elysiumLogs } from './tracker.js';

/** Kinetiq's Elysium (99901): native HYPE, Montra and the other launchpads in launchpads.ts, all on Uniswap v4. */
export function elysiumChain(registry: ElysiumRegistry): ChainAdapter {
  return {
    profile: ELYSIUM_PROFILE, multicall3: registry.address('multicall3'),
    ...elysiumLogs(registry),
    excluded: (coin) => excludedFor(registry, coin),
    probe: (coin, block, deps, priorTips) => probeCoin(coin, block, { ...deps, registry }, priorTips),
    facts: (coin, p, nowSec) => elysiumFacts(registry, coin, p, nowSec),
    trade: elysiumTrade(registry),
    historian: elysiumHistorian(registry),
    // HYPE from Hyperliquid's public mids.
    price: () => new HypeUsd(fetch, ELYSIUM_PROFILE.price.url, 30_000, () => Date.now(), ELYSIUM_PROFILE.price.symbol),
  };
}

const built = new WeakMap<ElysiumRegistry, ChainAdapter>();
/** The adapter itself, or Elysium's for a bare Elysium registry (how tests and older callers pass the chain). */
export function chainOf(chain: ChainAdapter | ElysiumRegistry): ChainAdapter {
  if (!(chain instanceof ElysiumRegistry)) return chain;
  let a = built.get(chain);
  if (!a) built.set(chain, a = elysiumChain(chain));
  return a;
}
