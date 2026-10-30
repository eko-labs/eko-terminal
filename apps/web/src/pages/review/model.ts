import { Bytes32Schema, ReviewQuestionsSchema, ReviewLabelInputSchema, ReviewAdjudicationInputSchema, type ReviewView, type ReviewRole } from '@eko/shared';
import { toUntrusted } from '@eko/untrusted';

export type Answers = ReviewView['labels'][number]['answers'];
export type Panel = ReviewView['case']['panels'][number];
export const emptyAnswers = (): Answers => ReviewQuestionsSchema.parse(Object.fromEntries(Object.keys(ReviewQuestionsSchema.shape).map(key => [key, 'unresolved'])));
export function currentLabels(view: ReviewView) {
  return (['reviewer_1', 'reviewer_2'] as const).map(slot => view.labels.filter(label => label.slot === slot).at(-1));
}
export function currentJudgment(view: ReviewView, role: ReviewRole) {
  return role === 'adjudicator' ? view.adjudications.at(-1) : view.labels.filter(label => label.slot === role).at(-1);
}
export function canWrite(view: ReviewView, role: ReviewRole) {
  return role === 'reviewer_1' || role === 'reviewer_2' || role === 'adjudicator' && !view.blinded && currentLabels(view).every(Boolean);
}
export function judgmentInput(view: ReviewView, role: ReviewRole, answers: Answers, evidenceIds: string[], rationale: string, labelVersion: string) {
  if (!canWrite(view, role)) throw new Error('Review role cannot submit at this stage');
  if (!rationale.trim() || !evidenceIds.length || new Set(evidenceIds).size !== evidenceIds.length || evidenceIds.some(id => !view.case.evidenceIds.includes(Bytes32Schema.parse(id)))) throw new Error('Pinned evidence and rationale required');
  const input = ReviewLabelInputSchema.parse({ supersedes: currentJudgment(view, role)?.id ?? null, labelVersion, answers, evidenceIds, rationale: toUntrusted(rationale, 4000) });
  return role === 'adjudicator' ? ReviewAdjudicationInputSchema.parse({ ...input, labelIds: currentLabels(view).map(label => label!.id) }) : input;
}
export function factText(value: Panel['facts'][number]['value']): string {
  if (value === null) return 'Unknown';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return typeof value === 'object' ? `${value.numerator}/${value.denominator}` : value;
}
/** Exact bigint normalization, bounded to SVG pixels. Source rationals remain visible. */
export function plotPoints(panels: Panel[]) {
  const points = panels.flatMap((panel, index) => {
    const times = panel.facts.filter(f => f.field === 'timestamp_sec'), returns = panel.facts.filter(f => f.field === 'net_return_pct');
    if (panel.status !== 'supported' || times.length !== 1 || returns.length !== 1 || typeof times[0].value !== 'string' || !/^\d+$/.test(times[0].value)) return [];
    const value = returns[0].value;
    if (value === null || typeof value === 'boolean' || typeof value === 'string' && !/^\d+$/.test(value)) return [];
    const ratio = typeof value === 'string' ? { numerator: value, denominator: '1' } : value;
    return [{ index, timestamp: times[0].value, returnText: factText(value), n: BigInt(ratio.numerator), d: BigInt(ratio.denominator) }];
  });
  const compare = (a: typeof points[number], b: typeof points[number]) => a.n * b.d - b.n * a.d;
  const low = points.reduce<typeof points[number] | undefined>((a, b) => !a || compare(b, a) < 0n ? b : a, undefined);
  const high = points.reduce<typeof points[number] | undefined>((a, b) => !a || compare(b, a) > 0n ? b : a, undefined);
  const times = points.map(p => BigInt(p.timestamp)), start = times.reduce((a, b) => a < b ? a : b, times[0] ?? 0n), end = times.reduce((a, b) => a > b ? a : b, start);
  return points.map(p => ({ index: p.index, timestamp: p.timestamp, returnText: p.returnText,
    x: end === start ? 300 : 40 + Number((BigInt(p.timestamp) - start) * 520n / (end - start)),
    y: compare(low!, high!) === 0n ? 100 : 160 - Number((p.n * low!.d - low!.n * p.d) * high!.d * 120n / ((high!.n * low!.d - low!.n * high!.d) * p.d)),
  }));
}
