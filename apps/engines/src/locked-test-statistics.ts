import { createHash } from 'node:crypto';
import type { DevelopmentMetricRow } from './development-fit-statistics.js';

export interface BinaryRateRow { groupId: string; weight: number; numerator: boolean; denominator: boolean }
const ratio = (n: number, d: number) => d > 0 ? n / d : null;
/** Inclusion weights stay within components; repeated paths resample together. */
export function weightedComponentRate(rows: BinaryRateRow[], seed: string) {
  const groups = new Map<string, { n: number; d: number }>();
  for (const r of rows) {
    if (!Number.isFinite(r.weight) || r.weight <= 0 || r.numerator && !r.denominator)
      throw new Error('Invalid weighted binary row');
    const g = groups.get(r.groupId) ?? { n: 0, d: 0 };
    g.n += r.numerator ? r.weight : 0; g.d += r.denominator ? r.weight : 0; groups.set(r.groupId, g);
  }
  const values = [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v);
  const n = values.reduce((s, g) => s + g.n, 0), d = values.reduce((s, g) => s + g.d, 0);
  let counter = 0;
  const random = () => {
    const limit = 0x100000000 - 0x100000000 % values.length;
    for (;;) {
      const v = createHash('sha256').update(`${seed}:${counter++}`).digest().readUInt32BE(0);
      if (v < limit) return v % values.length;
    }
  };
  const samples: (number | null)[] = [];
  if (values.length) for (let i = 0; i < 2000; i++) {
    let numerator = 0, denominator = 0;
    for (let j = 0; j < values.length; j++) { const g = values[random()]; numerator += g.n; denominator += g.d; }
    samples.push(ratio(numerator, denominator));
  }
  const interval = (s: (number | null)[]) => {
    const valid = s.filter((v): v is number => v !== null).sort((a, b) => a - b);
    return valid.length === s.length && valid.length > 0
      ? { lower: valid[Math.ceil(valid.length * .025) - 1], upper: valid[Math.ceil(valid.length * .975) - 1] }
      : { lower: null, upper: null };
  };
  return { point: ratio(n, d), weightedNumerator: n, weightedDenominator: d, ...interval(samples),
    undefinedResamples: 2000 - samples.filter(v => v !== null).length, components: values.length,
    bootstrap: { seed, resamples: 2000, confidencePct: 95, method: 'weighted_component_percentile',
      stability: { first1000: interval(samples.slice(0, 1000)), last1000: interval(samples.slice(1000)) } } };
}

/** Only declared unweighted independent binary audits may use Wilson. */
export function independentWilsonAudit(rows: (BinaryRateRow & { coin: string })[], declaredIndependent: boolean) {
  if (!declaredIndependent) return null;
  if (rows.some(r => r.weight !== 1 || !r.denominator) || new Set(rows.map(r => r.groupId)).size !== rows.length ||
      new Set(rows.map(r => r.coin)).size !== rows.length) throw new Error('Wilson requires unweighted independent audit units');
  const n = rows.length, successes = rows.filter(r => r.numerator).length;
  if (!n) return { n, successes, point: null, lower: null, upper: null, confidencePct: 95 };
  const z = 1.959963984540054, p = successes / n, divisor = 1 + z * z / n;
  const center = (p + z * z / (2 * n)) / divisor;
  const half = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / divisor;
  return { n, successes, point: p, lower: Math.max(0, center - half), upper: Math.min(1, center + half), confidencePct: 95 };
}

export function lockedPrimaryMetrics(rows: DevelopmentMetricRow[], seed: string) {
  const futureHigh = (r: DevelopmentMetricRow) => r.level === 'high' && !r.factualHigh;
  const elevated = (r: DevelopmentMetricRow) => r.level === 'elevated' && r.complete && !r.gapFloor;
  const detected = (r: DevelopmentMetricRow) => futureHigh(r) || r.level === 'elevated' && !r.gapFloor;
  const lower = (r: DevelopmentMetricRow) => r.level === 'lower' && r.complete;
  const rate = (numerator: (r: DevelopmentMetricRow) => boolean, denominator: (r: DevelopmentMetricRow) => boolean) =>
    weightedComponentRate(rows.map(r => ({ ...r, numerator: numerator(r), denominator: denominator(r) })), seed);
  const highPrecision = rate(r => futureHigh(r) && r.truth === true, r => futureHigh(r) && r.truth !== null);
  const elevatedHighRecall = rate(r => detected(r) && r.truth === true, r => r.truth === true);
  const highOnlyRecall = rate(r => futureHigh(r) && r.truth === true, r => r.truth === true);
  const lowerHarmRate = rate(r => lower(r) && r.truth === true, r => lower(r) && r.truth !== null);
  const elevatedHarmRate = rate(r => elevated(r) && r.truth === true, r => elevated(r) && r.truth !== null);
  const factualHighHarmRate = rate(r => r.factualHigh && r.truth === true, r => r.factualHigh && r.truth !== null);
  const distinct = (p: (r: DevelopmentMetricRow) => boolean) => new Set(rows.filter(p).map(r => r.coin)).size;
  const denominators = { knownHigh: distinct(r => futureHigh(r) && r.truth !== null), hurt: distinct(r => r.truth === true),
    knownLower: distinct(r => lower(r) && r.truth !== null), missedCriticalLower: distinct(r => lower(r) && r.criticalRestriction),
    entries: rows.length, knownOutcomes: distinct(r => r.truth !== null), unknownOutcomes: distinct(r => r.truth === null),
    independentComponents: new Set(rows.map(r => r.groupId)).size };
  const orderedBands = lowerHarmRate.upper !== null && elevatedHarmRate.lower !== null && elevatedHarmRate.upper !== null &&
    highPrecision.lower !== null && lowerHarmRate.upper < elevatedHarmRate.lower && elevatedHarmRate.upper < highPrecision.lower;
  return { highPrecision, elevatedHighRecall, highOnlyRecall, lowerHarmRate, elevatedHarmRate, factualHighHarmRate,
    denominators, requiredHeldOut: { knownHigh: 100, hurt: 100, knownLower: 100, developmentCredit: 0 }, orderedBands,
    numericalGates: {
      high: denominators.knownHigh >= 100 && (highPrecision.point ?? -1) >= .9 && (highPrecision.lower ?? -1) >= .85,
      recall: denominators.hurt >= 100 && (elevatedHighRecall.point ?? -1) >= .85 && (elevatedHighRecall.lower ?? -1) >= .75 && (highOnlyRecall.point ?? -1) >= .5,
      lower: denominators.knownLower >= 100 && (lowerHarmRate.point ?? 1) <= .1 && (lowerHarmRate.upper ?? 1) <= .15 && denominators.missedCriticalLower === 0 && orderedBands,
    } };
}
