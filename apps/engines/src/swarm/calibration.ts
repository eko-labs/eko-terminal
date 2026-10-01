/** BACKEND §8.7. No I/O, no model calls, and no ranking switch. */
export interface CalibrationRow {
  id: string; coin: string; evidence: 'fixture' | 'measured'; startMs: number; endMs: number;
  committed: boolean; complete: boolean; probability: number; baseline: number | null; netAgentUsd: number | null;
}
export interface MomentumExample { endMs: number; growth5m: number; change5mPct: number; outcome: 0 | 1 }
export interface MomentumModel { trainedThroughMs: number; coefficients: number[]; means: number[]; scales: number[]; samples: number }
export const SWARM_WEEK_MS = 7 * 86400000;
const sigmoid = (x: number) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, x))));

/** Weekly walk-forward fit. Neither labels nor features from the evaluation week enter training. */
export function fitMomentum(history: readonly MomentumExample[], forecastMs: number): MomentumModel | null {
  const through = Math.floor(forecastMs / SWARM_WEEK_MS) * SWARM_WEEK_MS;
  const rows = history.filter(r => r.endMs <= through && [r.endMs, r.growth5m, r.change5mPct].every(Number.isFinite));
  // TODO(spec): minimum training size/regularisation are unspecified. Require 30 prior outcomes and both classes, with ridge 0.01.
  if (rows.length < 30 || !rows.some(r => r.outcome === 0) || !rows.some(r => r.outcome === 1)) return null;
  const features = rows.map(r => [r.growth5m, r.change5mPct]);
  const means = [0, 1].map(j => features.reduce((s, x) => s + x[j], 0) / rows.length);
  const scales = means.map((mean, j) => Math.sqrt(features.reduce((s, x) => s + (x[j] - mean) ** 2, 0) / rows.length) || 1);
  const xs = features.map(x => [1, ...x.map((v, j) => (v - means[j]) / scales[j])]);
  const coefficients = [0, 0, 0];
  for (let iteration = 0; iteration < 1000; iteration++) {
    const gradient = coefficients.map((v, j) => j ? 0.01 * v : 0);
    xs.forEach((x, i) => {
      const error = sigmoid(x.reduce((s, v, j) => s + v * coefficients[j], 0)) - rows[i].outcome;
      x.forEach((v, j) => { gradient[j] += error * v / xs.length; });
    });
    coefficients.forEach((_, j) => { coefficients[j] -= 0.1 * gradient[j]; });
  }
  return { trainedThroughMs: through, coefficients, means, scales, samples: rows.length };
}
/**
 * Apply a supplied fitted momentum model to finite growth/change features using its normalization
 * and bounded sigmoid. Pure computation; nonfinite features throw. The caller supplies a valid
 * trained model; no training or acceptance occurs.
 */
export function momentumProbability(model: MomentumModel, growth5m: number, change5mPct: number): number {
  if (![growth5m, change5mPct].every(Number.isFinite)) throw new Error('Momentum features unavailable');
  return sigmoid(model.coefficients[0] + [growth5m, change5mPct].reduce((s, v, j) => s + (v - model.means[j]) / model.scales[j] * model.coefficients[j + 1], 0));
}

/** Deterministic coin-cluster paired bootstrap retains repeated forecasts within a coin. */
export function calibrationReport(cohort: readonly CalibrationRow[], options: { nowMs: number; bootstrapSamples?: number; seed?: number }) {
  const repetitions = options.bootstrapSamples ?? 2000;
  if (!Number.isSafeInteger(repetitions) || repetitions < 1000 || repetitions > 10000 || !Number.isFinite(options.nowMs)) throw new Error('Invalid report bounds');
  if (new Set(cohort.map(r => r.id)).size !== cohort.length) throw new Error('Duplicate forecast denominator');
  const mature = cohort.filter(r => r.committed && r.endMs <= options.nowMs);
  const valid = mature.filter(r => r.complete && r.endMs - r.startMs === 900000 && Number.isFinite(r.startMs) &&
    r.netAgentUsd !== null && Number.isFinite(r.netAgentUsd) && r.baseline !== null && r.baseline >= 0 && r.baseline <= 1 && r.probability >= 0 && r.probability <= 1);
  const eligible = valid.filter(r => r.evidence === 'measured');
  const coins = new Set(eligible.map(r => r.coin.toLowerCase()));
  const starts = eligible.map(r => r.startMs);
  const elapsedMs = starts.length ? eligible.map(r => r.endMs).reduce((a, b) => Math.max(a, b)) - starts.reduce((a, b) => Math.min(a, b)) : 0;
  const days = new Set(starts.map(ms => Math.floor(ms / 86400000))).size;
  // Diagnostic metrics may use fixtures, but fixtures never satisfy acceptance coverage.
  const metricRows = valid;
  const scored = metricRows.map(r => {
    const y = r.netAgentUsd! >= 500 ? 1 : 0;
    return { coin: r.coin.toLowerCase(), p: r.probability, y, swarm: (r.probability - y) ** 2, baseline: (r.baseline! - y) ** 2 };
  });
  const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  const curve = Array.from({ length: 10 }, (_, bin) => {
    const rows = scored.filter(r => Math.min(9, Math.floor(r.p * 10)) === bin);
    return { bin, count: rows.length, predicted: mean(rows.map(r => r.p)), observed: mean(rows.map(r => r.y)) };
  });
  // TODO(spec): reliability estimator is unspecified. Use count-weighted linear slope of ten reliability bins, with intercept.
  const pMean = mean(scored.map(r => r.p)), yMean = mean(scored.map(r => r.y));
  const variance = curve.reduce((s, b) => s + (b.predicted === null ? 0 : b.count * (b.predicted - pMean!) ** 2), 0);
  const covariance = curve.reduce((s, b) => s + (b.predicted === null ? 0 : b.count * (b.predicted - pMean!) * (b.observed! - yMean!)), 0);
  const reliabilitySlope = variance > 1e-12 ? covariance / variance : null;
  const groups = new Map<string, number[]>();
  for (const row of scored) { const g = groups.get(row.coin) ?? []; g.push(row.swarm - row.baseline); groups.set(row.coin, g); }
  const clusters = [...groups.values()];
  let seed = (options.seed ?? 106) >>> 0;
  const random = () => { seed = (Math.imul(1664525, seed) + 1013904223) >>> 0; return seed / 4294967296; };
  const bootstrap: number[] = [];
  if (clusters.length > 1) for (let i = 0; i < repetitions; i++) {
    let sum = 0, n = 0;
    for (let j = 0; j < clusters.length; j++) { const g = clusters[Math.floor(random() * clusters.length)]; sum += g.reduce((a, b) => a + b, 0); n += g.length; }
    bootstrap.push(sum / n);
  }
  bootstrap.sort((a, b) => a - b);
  const difference95 = bootstrap.length ? [bootstrap[Math.floor(repetitions * 0.025)], bootstrap[Math.ceil(repetitions * 0.975) - 1]] : null;
  const reasons: string[] = [];
  if (cohort.length !== eligible.length) reasons.push('incomplete_or_non_measured_denominator');
  if (coins.size < 500) reasons.push('coins_below_500');
  if (elapsedMs < 14 * 86400000 || days < 14) reasons.push('coverage_below_14_days');
  if (reliabilitySlope === null || reliabilitySlope < 0.8 || reliabilitySlope > 1.2) reasons.push('reliability_slope');
  if (!difference95 || difference95[1] >= 0) reasons.push('brier_interval');
  return { schemaVersion: 'swarm-calibration-1', beta: true, swarmRanking: false, acceptanceCandidate: !reasons.length, reasons,
    denominator: { forecasts: cohort.length, committedMature: mature.length, scored: valid.length, measured: eligible.length, censored: mature.length - valid.length, coins: coins.size, days, elapsedMs },
    brier: { swarm: mean(scored.map(r => r.swarm)), baseline: mean(scored.map(r => r.baseline)), difference: mean(scored.map(r => r.swarm - r.baseline)), difference95 },
    reliabilitySlope, reliabilityCurve: curve, bootstrap: { unit: 'coin', samples: repetitions, seed: options.seed ?? 106 } };
}
