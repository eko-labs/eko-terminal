import type { ScoreboardResponse, ScoreboardRow } from '@eko/shared';
// The API still serves a `milestones` record kind; milestone buys were dropped (owner decision 2026-10-05), so it has no tab.
export const SCOREBOARD_TABS = [
  ['calls', 'Calls'], ['honeypots_refused', 'Refused'], ['honeypots_missed', 'Missed'], ['cohort', 'Weekly cohort'],
] as const;
export function availabilityMessage(value: ScoreboardResponse['availability']['cohort']) {
  if (value.status === 'observed') return `Measured through ${value.through}`;
  return ({ monitoring_missing: 'Monitoring is unavailable.', coverage_gap: 'Monitoring coverage has a gap.', outcomes_unaccepted: 'Measured outcomes have not been accepted yet.', forecast_dependency: 'Forecast grades are unavailable.', d0_gated: 'This record is not available.', milestones_unaccepted: 'This record is not available.' })[value.reason];
}
export function counterText(data: ScoreboardResponse | null, metric: 'refused' | 'missed') {
  if (!data || data.availability[metric].status !== 'observed' || data.counters[metric] === null) return NOT_CHECKED;
  return data.counters[metric]!.toLocaleString('en-US');
}
export function safePostMortem(value: unknown): value is string {
  return typeof value === 'string' && /^\/[a-z0-9/_-]+$/.test(value);
}
export function receiptPath(id: string) { return `/receipt/${encodeURIComponent(id)}`; }
export function rowAnchor(id: string) { return `record-${encodeURIComponent(id)}`; }
export function gradeText(row: ScoreboardRow) {
  return row.grade ?? (row.detail.gradeStatus === 'immature' ? 'Immature' : NOT_CHECKED);
}
/** The one phrase for a value the record has not measured yet (03-FRONTEND's "not checked yet"). */
export const NOT_CHECKED = 'not checked yet';
/** Shown instead of two empty counters until either is measured. */
export const RECORD_NOT_STARTED = 'Counting starts once live monitoring runs and graded outcomes are accepted. Until then, no honeypot is counted as refused or missed.';
/** ISO timestamps as short UTC ("2026-10-04 13:22 UTC"); plain dates stay as they are. */
export function recordTime(ts: string) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(ts);
  return m ? `${m[1]} ${m[2]} UTC` : ts;
}
export const shortCoin = (address: string) => /^0x[0-9a-fA-F]{40}$/.test(address) ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
/** Repeated ungraded calls for one coin collapse into the latest row plus a count of earlier ones. */
export function collapsePendingCalls(rows: readonly ScoreboardRow[]) {
  const earlier = new Map<string, number>(), kept: ScoreboardRow[] = [], seen = new Set<string>();
  for (const row of rows) {
    const pending = row.kind === 'calls' && !row.grade && row.coin;
    if (pending && seen.has(row.coin!)) { earlier.set(row.coin!, (earlier.get(row.coin!) ?? 0) + 1); continue; }
    if (pending) seen.add(row.coin!);
    kept.push(row);
  }
  return { rows: kept, earlier };
}

