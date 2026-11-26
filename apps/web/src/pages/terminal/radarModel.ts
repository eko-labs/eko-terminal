import { z } from 'zod';
import { PLAYBOOK_LABELS, RadarRowSchema, type CoinCard, type RadarRow } from '@eko/shared';
import type { ChannelEvent } from '../../lib/realtime';
import { activityRatio, displayHeat, heatOf } from '../../lib/heat';
import { NO_FLAGS, SCAN_DELAYED_AFTER_SEC } from '../../copy/availability';
import { pick } from '../../lib/chain';
export { RadarResponseSchema } from '@eko/shared';
export const SORTS = ['Rank', 'Hottest', 'Score', '1h move', 'Price', 'Market cap', 'Agent flow', 'Newest', 'Exit cost'] as const;
export type Sort = typeof SORTS[number];
export const ascending = (sort: Sort) => ['Rank', 'Newest', 'Exit cost'].includes(sort);
// The EKO score sorts only when asked (Score). Hot ranking uses last-hour activity against the usual hour, the 1h move and, when
// measured, agent buying; Rank keeps the exact server order.
export const heatScore = (c: RadarRow) => activityRatio(c) * (1 + Math.max(0, c.unavailable?.includes('change') ? 0 : c.change1hPct) / 100)
  + (c.unavailable?.includes('flow') ? 0 : c.flow.agentPct / 10);
export type HotWindow = '1h' | '24h';
export function hotMetrics(c: RadarRow, window: HotWindow) {
  const day = window === '24h';
  return {
    volume: c.unavailable?.includes('volume') ? undefined : day ? c.volume24hUsd : c.volume1hUsd,
    change: c.unavailable?.includes('change') ? undefined : day ? c.change24hPct : c.change1hPct,
    trades: day ? c.trades24h : c.trades1h,
  };
}
/**
 * Hot right now: Hot coins first, then the most active of the rest, so the strip shows where trading is when
 * nothing clears the Hot bar. Danger, unscanned and falling coins are never featured; a coin needs some real trades.
 * At a quiet window the strip can show fewer than three, or none.
 */
export const hottest = (rows: readonly RadarRow[], n = 3, window: HotWindow = '1h'): RadarRow[] => rows
  .flatMap((c) => {
    const { volume, change, trades } = hotMetrics(c, window);
    if (c.verdictPending || (c.verdict !== 'clear' && c.verdict !== 'monitor') || volume === undefined
      || (trades ?? 0) < 5 || (change ?? 0) < 0) return [];
    if (window === '1h') return [{ c, hot: heatOf(c) === 'hot', score: heatScore(c) }];
    // TODO(spec): No 24h baseline or agent flow is supplied, so weight daily USD volume by the daily price move.
    return [{ c, hot: false, score: volume * (1 + (change ?? 0) / 100) }];
  })
  .sort((a, b) => Number(b.hot) - Number(a.hot) || b.score - a.score || a.c.address.localeCompare(b.c.address)).slice(0, n).map(({ c }) => c);
/** When each row version arrived, in client milliseconds. `ageSec` is only meaningful relative to it. */
export type ReceivedAt = ReadonlyMap<string, number>;
/**
 * Launch time on the client clock. A row's `ageSec` is its age when the server sent it, so rows received at
 * different times cannot be compared by `ageSec`: a quiet row keeps the small age it had on arrival and would
 * outrank every later launch. Without receipt times all rows share one clock and this reduces to `ageSec`.
 */
export const launchedAt = (row: { address: string; ageSec: number }, received?: ReceivedAt) => (received?.get(row.address) ?? 0) - row.ageSec * 1000;
/** Map a WS envelope's server timestamp onto the client clock, never into the future. */
export const receivedAt = (serverTs: number, clientNow: number, serverOffsetMs: number) => Math.min(clientNow, serverTs - serverOffsetMs);
/** A row's age now, from the age it carried when it arrived. */
export const currentAgeSec = (row: { address: string; ageSec: number }, received: ReceivedAt | undefined, now: number) => row.ageSec + Math.max(0, now - (received?.get(row.address) ?? now)) / 1000;
/** "Scanning…" only while a first scan is plausibly running; after that the row says the scan is delayed. */
export const scanDelayed = (row: { verdictPending?: boolean }, ageNowSec: number) => !!row.verdictPending && ageNowSec >= SCAN_DELAYED_AFTER_SEC;
const priceOf = (c: RadarRow) => c.priceUnavailable ? undefined : c.priceUsd;
export const marketCapOf = (c: RadarRow) => c.unavailable?.includes('marketCap') ? undefined : c.marketCapUsd;
export const sortAvailable = (rows: readonly RadarRow[], sort: Sort) => sort === 'Price' ? rows.some(c => priceOf(c) !== undefined) : sort === 'Market cap' ? rows.some(c => marketCapOf(c) !== undefined)
  : sort === 'Score' ? rows.some(c => c.ekoScore !== undefined)
  : rows.some(c => sortField(sort) === undefined || !c.unavailable?.includes(sortField(sort)!));
const sortField = (sort: Sort): NonNullable<RadarRow['unavailable']>[number] | undefined => ({ '1h move':'change', 'Agent flow':'flow', 'Exit cost':'exitCost' } as const)[sort as '1h move'|'Agent flow'|'Exit cost'];
export function sortRows(rows: readonly RadarRow[], sort: Sort, received?: ReceivedAt): RadarRow[] {
  const list = [...rows];
  if (sort === 'Rank') return list;
  // Score: the EKO score (its band follows the verdict); a coin without one (pending) sorts last.
  const value = (c: RadarRow) => sort === 'Score' ? c.ekoScore?.value : sort === 'Price' ? priceOf(c) : sort === 'Market cap' ? marketCapOf(c) : (sortField(sort) && c.unavailable?.includes(sortField(sort)!)) || (sort === 'Hottest' && (c.unavailable?.includes('volume') || c.volume1hUsd === undefined)) ? undefined : sort === 'Hottest' ? heatScore(c) : sort === '1h move' ? c.change1hPct : sort === 'Agent flow' ? c.flow.agentPct : sort === 'Newest' ? -launchedAt(c, received) : c.exitCost1kPct;
  return list.sort((a, b) => { const av = value(a), bv = value(b); return av === undefined ? bv === undefined ? 0 : 1 : bv === undefined ? -1 : ascending(sort) ? av - bv : bv - av; });
}
/**
 * The table's optional columns, in display order. Coin, Guard and Trade always show. A reader picks the rest in the
 * Columns menu; the choice is remembered on this device (COLUMNS_KEY).
 */
export const COLUMNS = [
  { id: 'watch', label: 'Watch for' }, { id: 'sig', label: 'Score' }, { id: 'price', label: 'Price' }, { id: 'mcap', label: 'Market cap' },
  { id: '1h', label: '1h move' }, { id: 'spark', label: 'Last 8h' }, { id: 'flow', label: 'Who’s buying' }, { id: 'liq', label: 'Liquidity' },
  { id: 'exit', label: 'Exit at $1K' },
] as const;
export type ColumnId = typeof COLUMNS[number]['id'];
export const DEFAULT_COLUMNS: readonly ColumnId[] = ['watch', 'sig', 'mcap', '1h', 'spark', 'flow', 'liq', 'exit'];
export const COLUMNS_KEY = 'eko.radar.columns';
/** The saved column choice, keeping only known ids; the defaults when nothing usable is saved. */
export function parseColumns(saved: string | null): ColumnId[] {
  try {
    const ids = JSON.parse(saved ?? 'null') as unknown;
    if (Array.isArray(ids)) return COLUMNS.map(c => c.id).filter(id => ids.includes(id));
  } catch { /* fall through */ }
  return [...DEFAULT_COLUMNS];
}
/** Table classes that hide the columns not chosen. */
export const hiddenColumnClasses = (shown: readonly ColumnId[]) => COLUMNS.filter(c => !shown.includes(c.id)).map(c => ` hide-${c.id}`).join('');
export type RiskMode = 'safe' | 'balanced' | 'degen';
/**
 * A coin the guard refuses to buy in this risk mode: its sell failed in the buy-then-sell check, or it is graded
 * Danger. Degen mode accepts a Danger grade with a warning unless a finding is one no mode accepts (`hardDanger`).
 * The server decides again on every quote; this only says what the row's Trade button will meet.
 */
export const refused = (c: Pick<RadarRow, 'verdict' | 'sellCheck' | 'hardDanger'>, mode: RiskMode = 'balanced') =>
  c.sellCheck?.status === 'refused' || (c.verdict === 'danger' && (mode !== 'degen' || c.hardDanger === true));
export const filterRows = (rows: readonly RadarRow[], show: string, stage: string, hideRefused = false, mode: RiskMode = 'balanced') => rows.filter((c) =>
  !(hideRefused && refused(c, mode)) &&
  (show === 'All' || (show === 'Hot' ? displayHeat(c) === 'hot' : show === NO_FLAGS ? c.verdict === 'clear' && !isLifeless(noMatchLabel(c)) : c.verdict === show.toLowerCase())) &&
  // Curve and Migrated are a Pons coin's two stages; a coin that launched in a Uniswap pool has neither.
  (stage === 'All' || (stage === 'Uniswap' ? c.launchpad !== 'pons' : c.launchpad === 'pons' && c.stage === (stage === 'Curve' ? 'curve' : 'graduated'))));
export function applyRadarEvents(rows: readonly RadarRow[], events: readonly ChannelEvent<'radar'>[]): RadarRow[] {
  let next = [...rows];
  for (const event of events) {
    // An update without features' figures (extras) keeps the row's last ones until the next list.
    if (event.kind === 'row_upsert') { const index = next.findIndex((c) => c.address === event.data.address); if (index < 0) next.push(event.data); else next[index] = { ...event.data, ...(event.data.guardV2 === undefined && next[index].guardV2 !== undefined ? {guardV2:next[index].guardV2,guardRefreshFailed:next[index].guardRefreshFailed} : {}), ...(event.data.extras === undefined && next[index].extras !== undefined ? { extras: next[index].extras } : {}) }; }
    else if (event.kind === 'row_remove') next = next.filter((c) => c.address !== event.data.address);
    else { const byAddress = new Map(next.map((c) => [c.address, c])); next = event.data.order.flatMap((a) => byAddress.has(a) ? [byAddress.get(a)!] : []).concat(next.filter((c) => !event.data.order.includes(c.address))); }
  }
  return next;
}
/** What each check is called on screen: in the words a trader uses, not the rule's internal name. One map in
 *  @eko/shared (score.ts), so the EKO score's "why" names a finding exactly as the row does. */
export const PLAYBOOK_NAMES: Readonly<Record<string, string>> = PLAYBOOK_LABELS;
/** A playbook's display name at the level it matched. `malicious_hook` at Monitor means only that the pool's hook may
 *  change swap amounts and EKO has not reviewed it (no measured anomaly: those are Danger), so it reads "Unreviewed hook". */
export function playbookName(id: string, level?: string): string {
  if (id === 'malicious_hook' && level === 'monitor') return 'Unreviewed hook';
  return PLAYBOOK_NAMES[id] ?? id;
}
export const pct = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1)}%`;
export const usd = (v: number) => v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1000 ? `$${Math.round(v / 1000)}K` : `$${Math.round(v).toLocaleString('en-US')}`;
export const price = (v: number) => `$${v.toFixed(v < .01 ? 7 : 2)}`;
// TODO(spec): These are display thresholds. Give launches five minutes to find buyers and require both
// negligible progress (1%) and negligible reserves ($1) before calling a quiet curve dead.
const NEW_CURVE_GRACE_SEC = 5 * 60;
const TRADE_WINDOW_SEC = 60 * 60;
const NEAR_EMPTY_CURVE_PCT = 1;
const NEAR_EMPTY_CURVE_USD = 1;
// The Pons run-up calibration starts watching at 15% progress.
const EARLY_GRADUATION_PCT = 15;
const GRADUATED_NO_MATCH = pick({ robinhood: 'On Uniswap · no flags', elysium: 'Graduated · no flags' });

export type VerdictActivity = Partial<Pick<RadarRow, 'stage' | 'launchpad' | 'curvePct' | 'graduationPct' | 'ageSec' | 'trades1h' | 'volume1hUsd' | 'liquidityUsd' | 'flow' | 'unavailable'>> & { buyers?: number };
type VerdictStatus = Pick<RadarRow, 'verdict' | 'verdictPending' | 'guardV2'>;

/** Context for a completed no-match verdict, using measured activity and leaving risk grades intact. */
export function noMatchLabel(c: VerdictActivity & VerdictStatus): string | undefined {
  if (c.verdict !== 'clear' || c.verdictPending || c.guardV2?.mode === 'active') return undefined;

  const hour = c.flow?.window === '1h' ? c.flow.activity : undefined;
  // `unavailable: ['flow']` refers to wallet labels. The activity counts, when present, are measured separately.
  const flowTrades = hour && hour.buys + hour.sells;
  const trades = c.trades1h ?? flowTrades;
  const volume = c.volume1hUsd ?? (hour && hour.buyUsd + hour.sellUsd);
  const quiet = !c.unavailable?.includes('volume') && trades === 0 && !flowTrades && (volume === undefined || volume === 0);
  const age = c.ageSec ?? 0;
  if (quiet && c.stage === 'curve' && c.launchpad === 'pons' && age >= NEW_CURVE_GRACE_SEC
    && c.curvePct !== undefined && c.curvePct >= 0 && c.curvePct <= NEAR_EMPTY_CURVE_PCT
    && !c.unavailable?.includes('liquidity') && c.liquidityUsd !== undefined && c.liquidityUsd >= 0 && c.liquidityUsd <= NEAR_EMPTY_CURVE_USD) {
    // A quiet first hour covers the coin's whole life. Check any buyer counts for contradictory evidence.
    const buyers = c.unavailable?.includes('buyers') ? undefined : c.buyers;
    if (age < TRADE_WINDOW_SEC && !buyers && !hour?.buyers) return 'Dead · no buyers';
    return 'Dead · curve ≤$1';
  }
  if (quiet) return age >= TRADE_WINDOW_SEC ? 'Inactive · no trades in 1h' : 'Quiet · no trades';
  if (c.stage === 'graduated') return GRADUATED_NO_MATCH;
  const progress = c.graduationPct ?? c.curvePct;
  if (progress === undefined) return undefined;
  const pct = `${progress < 10 ? progress.toFixed(1) : Math.round(progress)}%`;
  return progress < EARLY_GRADUATION_PCT ? `Early · ${pct} to graduation` : `${pct} to graduation · no flags`;
}

/** A no-flags coin that is over (Dead, Inactive): not a "No flags" pick, no run-up suffix, no bright Trade. A Quiet coin
 *  (under an hour old, no trades yet) is not: its run-up can still mean something. */
export const isLifeless = (label?: string) => !!label && /^(Dead|Inactive)\b/.test(label);

export function coinVerdictActivity(card: CoinCard, nowMs: number): VerdictActivity {
  const { identity, flow } = card;
  return { ...identity, flow, ageSec: (nowMs - Date.parse(identity.createdAt)) / 1000,
    liquidityUsd: identity.pools.find(pool => pool.venue === 'pons_curve')?.liquidityUsd };
}
/** Reasons as sentences: each ends in a full stop, so joined reasons never run together. */
export const sentences = (rs: string[]) => rs.map(r => r.trim()).filter(Boolean).map(r => /[.!?…]$/.test(r) ? r : `${r}.`).join(' ');
export const age = (sec: number) => sec < 3600 ? `${Math.round(sec / 60)}m` : sec < 86400 ? `${(sec / 3600).toFixed(1)}h` : `${(sec / 86400).toFixed(1)}d`;
export const exitText = (v: number) => v >= 100 ? 'Blocked' : `${v.toFixed(1)}%`;

/** A failed/missing V2 refresh cannot erase an already persisted compact verdict. */
export function retainCompactGuard<T extends import('@eko/shared').CoinSummary>(previous: T | undefined, incoming: T): T {
  if (previous?.guardV2 && incoming.guardV2 === null) return {...incoming,guardV2:previous.guardV2,guardRefreshFailed:true};
  return incoming;
}
