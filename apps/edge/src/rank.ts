import type { CoinState } from './tracker.js';

/** Native currency a coin traded in the hour before `nowSec`. Trades are kept in chain order, so it reads back from the
 *  newest and stops at the first one older than the hour (as views.ts hourFlow does). */
export function hourVolume(c: Pick<CoinState, 'trades'>, nowSec: number): number {
  const from = nowSec - 3600;
  let sum = 0;
  for (let i = c.trades.length - 1; i >= 0 && c.trades[i]!.ts >= from; i--) sum += c.trades[i]!.hype;
  return sum;
}

/**
 * The radar list's order: the last hour's volume, then the newest launch. Verdict never re-ranks (a ranking is not a
 * recommendation). The background checks use the same order (Edge.schedule), so the coins people see first are the
 * first refreshed, and the probe snapshot keeps them first when it has to drop some (probe-snapshot.ts).
 */
export function rankCoins(coins: Iterable<CoinState>, nowSec: number): CoinState[] {
  return [...coins].map(c => ({ c, vol: hourVolume(c, nowSec) })).sort((x, y) => y.vol - x.vol || y.c.ts - x.c.ts).map(x => x.c);
}
