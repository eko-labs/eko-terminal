import { zeroAddress } from 'viem';
import type { CoinState } from './tracker.js';

/** From when EKO holds a coin's history: `complete` when from its launch, else `since` is where it starts (unix seconds). */
export interface Coverage { complete: boolean; since: number }

/**
 * Whether EKO holds every transfer of a coin since its launch, and if not, from when. Holders, the deployer's balance,
 * bundles and early buyers are all sums over these transfers, so they are only known when the history is complete.
 *
 * The first transfer EKO holds must be the mint, or one in the launch transaction: anything later means it started
 * following the coin after launch (a restart that restored it, or a coin found late) and the transfers before were never
 * seen. Transfers folded to stay under the per-coin cap (tracker.ts compactFlows) keep every balance, so they still
 * count as held. A coin with no transfers at all is complete, unless EKO first saw it more than an hour after its launch
 * (CoinState.firstScanSec -1): then it starts at the first trade EKO holds, or now.
 */
export function transferCoverage(c: Pick<CoinState, 'flows' | 'trades' | 'ts' | 'tx' | 'firstScanSec'>, nowSec = Date.now() / 1000): Coverage {
  const first = c.flows[0];
  if (!first) return c.firstScanSec === -1 ? { complete: false, since: Math.max(c.ts, c.trades[0]?.ts ?? Math.floor(nowSec)) } : { complete: true, since: c.ts };
  if (first.from === zeroAddress || first.tx.toLowerCase() === c.tx.toLowerCase()) return { complete: true, since: c.ts };
  const since = Math.max(c.ts, first.ts);
  return { complete: since === c.ts, since };
}
