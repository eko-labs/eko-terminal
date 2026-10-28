import { expect, it } from 'vitest';
import { runUpMultiple, runUpScore } from './runUp';

// Curve progress p = 40 x s/(1-s) for s = share of supply bought; the price is (1 + p/40)^2 times the start.
it('scores how far the price would fall back to the curve start', () => {
  expect(runUpScore({ stage: 'curve', curvePct: 0 })).toBe(0);
  // 15% of supply bought: progress 7.06, a 28% fall. 30% bought (the Monitor line): progress 17.14, a 51% fall.
  expect(runUpScore({ stage: 'curve', curvePct: 40 * 0.15 / 0.85 })).toBe(28);
  expect(runUpScore({ stage: 'curve', curvePct: 40 * 0.3 / 0.7 })).toBe(51);
  expect(runUpScore({ stage: 'curve', curvePct: 40 })).toBe(75);
  expect(runUpScore({ stage: 'curve', curvePct: 100 })).toBe(92);
  expect(runUpMultiple(40)).toBe(4);
});
it('has no score after graduation or without curve progress', () => {
  expect(runUpScore({ stage: 'graduated', curvePct: 100 })).toBeUndefined();
  expect(runUpScore({ stage: 'curve' })).toBeUndefined();
  expect(runUpScore({ stage: 'curve', curvePct: Number.NaN })).toBeUndefined();
  expect(runUpScore({ stage: 'curve', curvePct: -1 })).toBeUndefined();
});
