import { createHash } from 'node:crypto';

export interface DevelopmentMetricRow {
  coin: string; groupId: string; weight: number;
  truth: boolean | null; level: 'lower' | 'elevated' | 'high' | 'incomplete';
  complete: boolean; gapFloor: boolean; factualHigh: boolean; criticalRestriction: boolean;
}
const ratio = (n: number, d: number) => d > 0 ? n / d : null;
function totals(rows: DevelopmentMetricRow[]) {
  const sum = (predicate: (r: DevelopmentMetricRow) => boolean) => rows.reduce((n, r) => n + (predicate(r) ? r.weight : 0), 0);
  // Current facts/capabilities are a separate audit, never future predictions.
  const high = (r: DevelopmentMetricRow) => r.level === 'high' && !r.factualHigh;
  const detected = (r: DevelopmentMetricRow) => r.level === 'high' || r.level === 'elevated' && !r.gapFloor;
  const lower = (r: DevelopmentMetricRow) => r.level === 'lower' && r.complete;
  return {
    highPrecision: ratio(sum(r => high(r) && r.truth === true), sum(r => high(r) && r.truth !== null)),
    elevatedHighRecall: ratio(sum(r => detected(r) && r.truth === true), sum(r => r.truth === true)),
    highOnlyRecall: ratio(sum(r => high(r) && r.truth === true), sum(r => r.truth === true)),
    lowerHarmRate: ratio(sum(r => lower(r) && r.truth === true), sum(r => lower(r) && r.truth !== null)),
    factualHighHarmRate: ratio(sum(r => r.factualHigh && r.truth === true), sum(r => r.factualHigh && r.truth !== null)),
    elevatedHarmRate: ratio(sum(r => r.level === 'elevated' && r.truth === true), sum(r => r.level === 'elevated' && r.truth !== null)),
  };
}
type Rates = ReturnType<typeof totals>;
/** Seeded operator/component resampling. All correlated paths travel together.
 * Null denominator resamples invalidate that interval rather than disappear. */
export function developmentMetrics(rows: DevelopmentMetricRow[], seed: string) {
  const point = totals(rows), groups = [...new Set(rows.map(r => r.groupId))].sort();
  const grouped = groups.map(id => rows.filter(r => r.groupId === id));
  const samples = Object.fromEntries(Object.keys(point).map(k => [k, [] as (number | null)[]])) as Record<keyof Rates, (number | null)[]>;
  let counter = 0;
  const random = () => {
    // 32-bit rejection avoids modulo bias; workload is bounded by the frozen draw.
    const bound = groups.length, limit = 0x100000000 - 0x100000000 % bound;
    for (;;) {
      const value = createHash('sha256').update(`${seed}:${counter++}`).digest().readUInt32BE(0);
      if (value < limit) return value % bound;
    }
  };
  // Cache group multiplicity totals would change no semantics; small offline grids
  // use the direct implementation for transparent correlated-denominator handling.
  if (groups.length) for (let i = 0; i < 2000; i++) {
    const draw = Array.from({ length: groups.length }, () => grouped[random()]).flat();
    const result = totals(draw);
    for (const key of Object.keys(point) as (keyof Rates)[]) samples[key].push(result[key]);
  }
  const intervals = Object.fromEntries((Object.keys(point) as (keyof Rates)[]).map(key => {
    const values = samples[key], valid = values.filter((v): v is number => v !== null).sort((a, b) => a - b);
    return [key, { lower: valid.length === 2000 ? valid[49] : null, upper: valid.length === 2000 ? valid[1949] : null,
      undefinedResamples: 2000 - valid.length }];
  })) as Record<keyof Rates, { lower: number | null; upper: number | null; undefinedResamples: number }>;
  const distinct = (predicate: (r: DevelopmentMetricRow) => boolean) => new Set(rows.filter(predicate).map(r => r.coin)).size;
  const knownHigh = distinct(r => r.level === 'high' && !r.factualHigh && r.truth !== null);
  const hurt = distinct(r => r.truth === true), knownLower = distinct(r => r.level === 'lower' && r.complete && r.truth !== null);
  const missedCriticalLower = distinct(r => r.level === 'lower' && r.criticalRestriction);
  const orderedBands = point.lowerHarmRate !== null && point.elevatedHarmRate !== null && point.highPrecision !== null &&
    intervals.lowerHarmRate.upper !== null && intervals.elevatedHarmRate.lower !== null &&
    intervals.elevatedHarmRate.upper !== null && intervals.highPrecision.lower !== null &&
    intervals.lowerHarmRate.upper < intervals.elevatedHarmRate.lower && intervals.elevatedHarmRate.upper < intervals.highPrecision.lower;
  // The 100-coin minima are explicitly untouched-test requirements.
  // Development must have defined denominators/intervals; its counts never
  // discharge any held-out release requirement.
  const gates = {
    high: knownHigh > 0 && (point.highPrecision ?? -1) >= .9 && (intervals.highPrecision.lower ?? -1) >= .85,
    recall: hurt > 0 && (point.elevatedHighRecall ?? -1) >= .85 && (intervals.elevatedHighRecall.lower ?? -1) >= .75 && (point.highOnlyRecall ?? -1) >= .5,
    lower: knownLower > 0 && (point.lowerHarmRate ?? 1) <= .1 && (intervals.lowerHarmRate.upper ?? 1) <= .15 && missedCriticalLower === 0 && orderedBands,
  };
  return { point, intervals, heldOutRequirements: { highCoins: 100, hurtCoins: 100, fullyCheckedLowerCoins: 100,
    developmentCountsCredit: false }, knownHigh, hurt, knownLower, missedCriticalLower, orderedBands, gates,
    entries: rows.length, knownOutcomes: rows.filter(r => r.truth !== null).length,
    missingOutcomes: rows.filter(r => r.truth === null).length, incomplete: rows.filter(r => r.level === 'incomplete').length,
    factualHigh: distinct(r => r.factualHigh), independentGroups: groups.length,
    bootstrap: { seed, resamples: 2000, confidencePct: 95, method: 'component_percentile', undefinedDenominators: 'interval_unavailable' } };
}

export interface DevelopmentRank {
  parametersHash: string; enabledHeuristicFactors: number; highPrecision: number;
  highOnlyRecall: number; deviation: number; eligible: boolean;
}
/** The only selector; fitting/test metrics cannot enter this comparator. */
export function selectDevelopmentCandidate<T extends DevelopmentRank>(rows: T[]): T | null {
  return rows.filter(r => r.eligible).sort((a, b) => a.enabledHeuristicFactors - b.enabledHeuristicFactors ||
    b.highPrecision - a.highPrecision || b.highOnlyRecall - a.highOnlyRecall || a.deviation - b.deviation ||
    a.parametersHash.localeCompare(b.parametersHash))[0] ?? null;
}
