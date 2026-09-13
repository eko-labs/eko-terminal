import { expect, it } from 'vitest';
import { CoinCardSchema, CoinSignalSchema } from '@eko/shared';
import type { CoinSignal } from '@eko/shared';
import { compositeFromReadings, computeSignal, explainSignal, inputFromCard, shouldRecomputeSignal, SIGNAL_REFRESH_MS, SIGNAL_VERSION, SIGNAL_WEIGHTS } from '../src/index.js';
import { base, card, extras, match } from './fixtures.js';

it('uses version 1 fixed weights, rounded composite, beta and the input block', () => {
  expect(SIGNAL_VERSION).toBe(1);
  expect(SIGNAL_WEIGHTS).toEqual({ momentum: 0.30, liquidity: 0.25, holders: 0.20, narrative: 0.15, risk: 0.10 });
  expect(Object.values(SIGNAL_WEIGHTS).reduce((sum, weight) => sum + weight, 0)).toBe(1);
  expect(computeSignal(base())).toEqual({ composite: 60,
    readings: { momentum: 50, liquidity: 70, holders: 50, narrative: 50, risk: 100 },
    weights: SIGNAL_WEIGHTS, beta: true, asOfBlock: 123, lowData: ['narrative'] });
});

it('explains the landing example: 86/80/58/70/44 gives 72 from the five exact contributions', () => {
  const signal: CoinSignal = { composite: 72,
    readings: { momentum: 86, liquidity: 80, holders: 58, narrative: 70, risk: 44 },
    weights: { ...SIGNAL_WEIGHTS }, beta: true, asOfBlock: 123 };
  const breakdown = explainSignal(signal);
  expect(compositeFromReadings(signal.readings)).toBe(72);
  expect(breakdown.map((part) => part.reading)).toEqual(['momentum', 'liquidity', 'holders', 'narrative', 'risk']);
  expect(breakdown.map((part) => part.value)).toEqual([86, 80, 58, 70, 44]);
  const points = [25.8, 20, 11.6, 10.5, 4.4];
  breakdown.forEach((part, i) => expect(part.points).toBeCloseTo(points[i], 10));
  expect(Math.round(breakdown.reduce((sum, part) => sum + part.points, 0))).toBe(72);
});

it('composite boundaries are 0 and 100, rounding only the total', () => {
  expect(compositeFromReadings({ momentum: 0, liquidity: 0, holders: 0, narrative: 0, risk: 0 })).toBe(0);
  expect(compositeFromReadings({ momentum: 100, liquidity: 100, holders: 100, narrative: 100, risk: 100 })).toBe(100);
  expect(compositeFromReadings({ momentum: 50.49, liquidity: 50.49, holders: 50.49, narrative: 50.49, risk: 50.49 })).toBe(50);
  expect(compositeFromReadings({ momentum: 50.51, liquidity: 50.51, holders: 50.51, narrative: 50.51, risk: 50.51 })).toBe(51);
  for (const value of [-1, 101, NaN, Infinity]) {
    expect(() => compositeFromReadings({ momentum: value, liquidity: 50, holders: 50, narrative: 50, risk: 50 })).toThrow(RangeError);
  }
});

it('computed composites match their breakdown across boundary fixtures and always validate', () => {
  for (const value of [0, 1, 10, 50, 100]) {
    for (const level of ['clear', 'info', 'monitor', 'danger'] as const) {
      const input = { ...base(), priceChange5mPct: value - 50, priceChange1hPct: value - 50,
        buyVolumeUsd1h: value * 100, buyVolumeUsdPrevious1h: (100 - value) * 100,
        depth2Usd: value * 2500, exitCost1kPct: value,
        holdersNow: value, holdersPrevious1h: 100 - value,
        top10Pct: value, freshWalletsPct: value, bundlesHeldPct: value,
        trendingRank: value + 1, agentBuyPct: value, xMentionPace: value,
        playbooks: [match(level)], asOfBlock: value };
      const before = JSON.parse(JSON.stringify(input));
      const signal = computeSignal(input);
      expect(CoinSignalSchema.parse(signal)).toEqual(signal);
      expect(signal.composite).toBe(Math.round(explainSignal(signal).reduce((sum, part) => sum + part.points, 0)));
      if (level === 'danger') expect(signal.readings.risk).toBe(0);
      expect(computeSignal(input)).toEqual(signal);
      expect(input).toEqual(before);
    }
  }
  expect(CoinSignalSchema.parse(computeSignal(base()))).toEqual(computeSignal(base()));
});

it('returned weights cannot mutate the versioned weights or future signals', () => {
  const signal = computeSignal(base());
  signal.weights.momentum = 0;
  expect(computeSignal(base()).weights.momentum).toBe(0.30);
});

it('maps only specified CoinCard fields and extras without mutating the card', () => {
  const source = card();
  expect(CoinCardSchema.parse(source)).toEqual(source);
  const before = JSON.parse(JSON.stringify(source));
  const input = inputFromCard(source, extras);
  expect(input).toEqual({ ...extras, depth2Usd: 40000, exitCost1kPct: 6,
    top10Pct: 20, freshWalletsPct: 10, bundlesHeldPct: 5, agentBuyPct: 60,
    playbooks: source.playbooks, control: { canChangeTax: true, canBlacklist: false, canMint: true },
    lpStatus: 'removable', asOfBlock: 123 });
  expect(input.control).not.toHaveProperty('canPause');
  expect(input.control).not.toHaveProperty('upgradeable');
  expect(CoinSignalSchema.safeParse(computeSignal(input)).success).toBe(true);
  expect(source).toEqual(before);
  const { trendingRank, xMentionPace, ...required } = extras;
  expect(computeSignal(inputFromCard(source, required)).readings.narrative).toBe(60);
});

it('rejects invalid block stamps', () => {
  for (const asOfBlock of [NaN, Infinity, -1, 0.5, Number.MAX_VALUE]) {
    expect(() => computeSignal({ ...base(), asOfBlock })).toThrow(RangeError);
  }
});

it('throttles each coin at the exact 15 s boundary, including a timestamp of zero', () => {
  expect(SIGNAL_REFRESH_MS).toBe(15000);
  expect(shouldRecomputeSignal(null, 0)).toBe(true);
  expect(shouldRecomputeSignal(undefined, 0)).toBe(true);
  expect(shouldRecomputeSignal(0, 14999)).toBe(false);
  expect(shouldRecomputeSignal(0, 15000)).toBe(true);
  expect(shouldRecomputeSignal(1000, 15999)).toBe(false);
  expect(shouldRecomputeSignal(1000, 16000)).toBe(true);
  expect(shouldRecomputeSignal(1000, 20000)).toBe(true);
  expect(shouldRecomputeSignal(1000, 999)).toBe(false);
  // Callers pass a different last-computed time for each coin; the helper retains no state.
  expect(shouldRecomputeSignal(9000, 16000)).toBe(false);
  expect(shouldRecomputeSignal(1000, 16000)).toBe(true);
  expect(() => shouldRecomputeSignal(NaN, 0)).toThrow(RangeError);
  expect(() => shouldRecomputeSignal(null, Infinity)).toThrow(RangeError);
});

it('marks narrative as low data on the signal when there is nothing to read it from', () => {
  const input = base();
  expect(narrativeOf(input)).toBe(true);
  expect(computeSignal(input).lowData).toEqual(['narrative']);
  expect(computeSignal({ ...input, agentBuyPct: 40 }).lowData).toBeUndefined();
});

function narrativeOf(input: ReturnType<typeof base>): boolean {
  return input.trendingRank === undefined && input.agentBuyPct === undefined && input.xMentionPace === undefined;
}
