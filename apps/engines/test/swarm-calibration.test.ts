import { describe, expect, it } from 'vitest';
import { calibrationReport, fitMomentum, momentumProbability, SWARM_WEEK_MS, type CalibrationRow, type MomentumExample } from '../src/swarm/calibration.js';
const day = 86400000;
function cohort(evidence: 'fixture' | 'measured' = 'measured'): CalibrationRow[] {
  // Twenty coins per probability stratum, exactly calibrated outcomes. Synthetic data even when exercising the measured branch.
  return Array.from({ length: 1000 }, (_, i) => {
    const stratum = Math.floor(i / 100), p = (stratum + 1) / 11, positive = i % 100 < Math.round(p * 100);
    const startMs = 100 * day + i % 15 * day;
    return { id: `forecast-${i}`, coin: `coin-${i}`, evidence, startMs, endMs: startMs + 900000, committed: true, complete: true, probability: p, baseline: 0.5, netAgentUsd: positive ? 500 : 499.99 };
  });
}
describe('106 pure Swarm calibration, synthetic evidence only', () => {
  it('reports calibrated probabilities and a negative paired coin-bootstrap Brier interval', () => {
    const r = calibrationReport(cohort(), { nowMs: 120 * day });
    expect(r.acceptanceCandidate).toBe(true); expect(r.swarmRanking).toBe(false); expect(r.beta).toBe(true);
    expect(r.denominator).toMatchObject({ coins: 1000, days: 15, elapsedMs: 14 * day + 900000, censored: 0 });
    expect(r.reliabilitySlope).toBeGreaterThan(0.8); expect(r.reliabilitySlope).toBeLessThan(1.2);
    expect(r.brier.difference95![1]).toBeLessThan(0);
    expect(calibrationReport(cohort(), { nowMs: 120 * day })).toEqual(r);
  });
  it('does not turn fixtures, repeated coins, sparse elapsed coverage or a censored denominator into acceptance', () => {
    expect(calibrationReport(cohort('fixture'), { nowMs: 120 * day }).acceptanceCandidate).toBe(false);
    const repeated = cohort().map(r => ({ ...r, coin: 'one-coin' }));
    expect(calibrationReport(repeated, { nowMs: 120 * day }).reasons).toContain('coins_below_500');
    const short = cohort().map(r => ({ ...r, startMs: 100 * day, endMs: 100 * day + 900000 }));
    expect(calibrationReport(short, { nowMs: 120 * day }).reasons).toContain('coverage_below_14_days');
    for (const change of [{ complete: false }, { committed: false }, { netAgentUsd: null }, { baseline: null }, { endMs: 200 * day }]) {
      const rows = cohort(); rows[0] = { ...rows[0], ...change };
      const r = calibrationReport(rows, { nowMs: 120 * day });
      expect(r.acceptanceCandidate).toBe(false); expect(r.denominator.forecasts).toBe(1000);
    }
    expect(() => calibrationReport([cohort()[0], cohort()[0]], { nowMs: 120 * day })).toThrow('Duplicate');
  });
  it('rejects a worse baseline comparison and undefined reliability slope', () => {
    const worse = cohort().map(r => ({ ...r, baseline: r.netAgentUsd! >= 500 ? 1 : 0 }));
    expect(calibrationReport(worse, { nowMs: 120 * day }).reasons).toContain('brier_interval');
    const flat = cohort().map(r => ({ ...r, probability: 0.5 }));
    expect(calibrationReport(flat, { nowMs: 120 * day }).reliabilitySlope).toBeNull();
  });
  it('fits weekly momentum from prior completed windows only, using both prescribed features', () => {
    const cutoff = 100 * SWARM_WEEK_MS;
    const history: MomentumExample[] = Array.from({ length: 80 }, (_, i) => ({ endMs: cutoff - day, growth5m: i - 40, change5mPct: i / 10 - 4, outcome: i < 40 ? 0 : 1 }));
    const model = fitMomentum(history, cutoff + day)!;
    expect(model.samples).toBe(80); expect(model.trainedThroughMs).toBe(cutoff);
    expect(momentumProbability(model, 20, 2)).toBeGreaterThan(momentumProbability(model, -20, -2));
    expect(fitMomentum([...history, { endMs: cutoff + 1, growth5m: -999, change5mPct: -999, outcome: 1 }], cutoff + day)).toEqual(model);
    expect(fitMomentum(history.slice(0, 20), cutoff + day)).toBeNull();
  });
});
