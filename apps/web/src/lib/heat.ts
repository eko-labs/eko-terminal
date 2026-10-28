import type { RadarRow } from '@eko/shared';
export type HeatRow = Omit<RadarRow, 'rank' | 'exitCost1kPct'> & { exitCost1kPct?: number };
export type Heat = 'hot' | 'fading' | 'normal' | 'avoid' | 'scanning';
export type Mark = { kind: 'shimmer' | 'ember'; level: 1 | 2 | 3 } | null;
/**
 * Hot is unusual trading for any coin: last-hour USD volume at least `ratio` times the coin's usual hour (its average
 * over up to 23 earlier hours), with enough trades that one wallet cannot make it. A coin with less than an hour of
 * earlier trading has no usual hour, so it needs a busy first hour instead. A coin trading heavily in absolute terms
 * is Hot whatever its usual hour: a coin a few hours past its launch is measured against that launch and never
 * qualified (on 2026-10-12, $21,600 and 202 trades in the hour against a $271,650 usual hour). Agent buying, when
 * measured, is another path. None is a recommendation.
 */
export const HOT = { ratio: 3, trades: 10, volumeUsd: 1_000, newTrades: 25, newVolumeUsd: 5_000, heavyTrades: 50, heavyVolumeUsd: 10_000 } as const;
/** Last-hour volume against the usual hour; a new coin is measured against a nominal $250 hour. */
export const activityRatio = (c: Pick<HeatRow, 'volume1hUsd' | 'volumeBaselineUsd'>) =>
  c.volume1hUsd === undefined ? 0 : c.volume1hUsd / Math.max(c.volumeBaselineUsd ?? 0, 250);
export function activityHot(c: HeatRow): boolean {
  if (c.unavailable?.includes('volume') || c.volume1hUsd === undefined || c.trades1h === undefined) return false;
  if (!c.unavailable?.includes('change') && c.change1hPct < 0) return false;
  if (c.trades1h < HOT.trades || c.volume1hUsd < HOT.volumeUsd) return false;
  if (c.trades1h >= HOT.heavyTrades && c.volume1hUsd >= HOT.heavyVolumeUsd) return true;
  if (c.volumeBaselineUsd === undefined) return c.trades1h >= HOT.newTrades && c.volume1hUsd >= HOT.newVolumeUsd;
  return c.volume1hUsd >= HOT.ratio * c.volumeBaselineUsd;
}
/** The original agent path: strong signal, rising price and agents at least 30% of buyers. Needs measured flow. */
const agentHot = (c: HeatRow) => !c.unavailable?.includes('flow') && !c.unavailable?.includes('change')
  && (c.signal === undefined || c.signal.composite >= 70) && c.change1hPct >= 0 && c.flow.agentPct >= 30;
export function heatOf(c: HeatRow, { pending = false } = {}): Heat {
  if (pending || c.verdictPending || c.verdict === 'pending') return 'scanning';
  if (c.verdict === 'danger') return 'avoid';
  if (activityHot(c) || agentHot(c)) return 'hot';
  if (!c.unavailable?.includes('change') && c.change1hPct <= -2 && (c.signal === undefined || c.signal.composite < 62)) return 'fading';
  return 'normal';
}
/** The tag a row shows: Danger rows keep their Danger styling but still say Hot when trading is unusual. */
export function displayHeat(c: HeatRow, options: { pending?: boolean } = {}): Heat {
  const heat = heatOf(c, options);
  return heat === 'avoid' && activityHot(c) ? 'hot' : heat;
}
export function marking(c: HeatRow, { pending = false, redFlag = false } = {}): Mark {
  if (pending || c.verdictPending || c.verdict === 'pending') return null;
  if (c.verdict === 'danger') {
    // TODO(spec): RadarRow has no match confidence; the inspector supplies CoinCard's redFlag predicate.
    return { kind: 'ember', level: redFlag || (c.exitCost1kPct ?? 0) >= 75 || c.topPlaybook === 'honeypot' ? 3 : 2 };
  }
  if (!c.unavailable?.includes('change') && c.change1hPct <= -8 && (c.signal === undefined || c.signal.composite < 65)) return { kind: 'ember', level: 1 };
  if (heatOf(c) === 'hot') return { kind: 'shimmer', level: c.change1hPct >= 10 && (activityRatio(c) >= 6 || (!c.unavailable?.includes('flow') && c.flow.agentPct >= 40)) ? 3 : 2 };
  if (!c.unavailable?.includes('change') && !c.unavailable?.includes('flow') && c.change1hPct >= 3 && c.flow.agentPct >= 25 && (c.signal === undefined || c.signal.composite >= 60)) return { kind: 'shimmer', level: 1 };
  return null;
}
export const markClass = (m: Mark) => m ? `mk-${m.kind}-${m.level}` : '';
