import { describe, expect, it } from 'vitest';
import { holdersReading, liquidityReading, momentumReading, narrativeReading, riskReading } from '../src/index.js';
import type { SignalInput } from '../src/index.js';
import { base, match } from './fixtures.js';

function monotonic(values: number[], increasing = true): void {
  for (let i = 1; i < values.length; i++) {
    if (increasing) expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]);
    else expect(values[i]).toBeLessThanOrEqual(values[i - 1]);
  }
  // Ensure a constant reading cannot accidentally satisfy these checks.
  expect(values[0]).not.toBe(values[values.length - 1]);
}

describe('Momentum', () => {
  it('unchanged prices and volume, including zero/zero volume, are neutral', () => {
    expect(momentumReading(base())).toBe(50);
    expect(momentumReading({ ...base(), buyVolumeUsd1h: 0, buyVolumeUsdPrevious1h: 0 })).toBe(50);
  });
  it('is bounded at extremes and handles a zero prior hour', () => {
    expect(momentumReading({ ...base(), priceChange5mPct: 1e6, priceChange1hPct: 1e6,
      buyVolumeUsd1h: Number.MAX_VALUE, buyVolumeUsdPrevious1h: 0 })).toBe(100);
    expect(momentumReading({ ...base(), priceChange5mPct: -100, priceChange1hPct: -100,
      buyVolumeUsd1h: 0, buyVolumeUsdPrevious1h: Number.MAX_VALUE })).toBeCloseTo(0, 1);
    expect(momentumReading({ ...base(), buyVolumeUsdPrevious1h: 0 })).toBeGreaterThan(50);
  });
  it.each(['priceChange5mPct', 'priceChange1hPct'] as const)('increases with %s', (key) => {
    monotonic([-100, -25, -10, 0, 10, 25, 100].map((value) => momentumReading({ ...base(), [key]: value })));
  });
  it.each(['buyVolumeUsd1h', 'buyVolumeUsdPrevious1h'] as const)('responds monotonically to %s', (key) => {
    monotonic([0, 1, 500, 1000, 2000, 10000, 1e6].map((value) => momentumReading({ ...base(), [key]: value })), key === 'buyVolumeUsd1h');
  });
});

describe('Liquidity', () => {
  it.each([[0, 0], [2000, 20], [50000, 70], [250000, 95], [1e9, 95]])('depth $%s gives %s before penalties', (depth2Usd, score) => {
    expect(liquidityReading({ depth2Usd, exitCost1kPct: 5 })).toBeCloseTo(score, 10);
  });
  it('is monotonic across depth anchors and continuous at each join', () => {
    monotonic([0, 10, 100, 1999, 2000, 2001, 10000, 49999, 50000, 50001, 100000, 249999, 250000, 250001]
      .map((depth2Usd) => liquidityReading({ depth2Usd, exitCost1kPct: 5 })));
    for (const depth of [2000, 50000, 250000]) {
      const below = liquidityReading({ depth2Usd: depth - 0.001, exitCost1kPct: 5 });
      const above = liquidityReading({ depth2Usd: depth + 0.001, exitCost1kPct: 5 });
      expect(above).toBeCloseTo(below, 4);
    }
  });
  it('penalizes only above 5%, is monotonic in cost and clamps to zero', () => {
    for (const exitCost1kPct of [-1, 0, 4.999, 5]) expect(liquidityReading({ depth2Usd: 50000, exitCost1kPct })).toBe(70);
    expect(liquidityReading({ depth2Usd: 50000, exitCost1kPct: 5.001 })).toBeCloseTo(69.998);
    expect(liquidityReading({ depth2Usd: 50000, exitCost1kPct: 10 })).toBe(60);
    monotonic([0, 5, 6, 10, 25, 100].map((exitCost1kPct) => liquidityReading({ depth2Usd: 50000, exitCost1kPct })), false);
    expect(liquidityReading({ depth2Usd: 250000, exitCost1kPct: Number.MAX_VALUE })).toBe(0);
  });
});

describe('Holders', () => {
  it('unchanged counts are neutral without concentrations, including zero counts', () => {
    expect(holdersReading(base())).toBe(50);
    expect(holdersReading({ ...base(), holdersNow: 0, holdersPrevious1h: 0 })).toBe(50);
  });
  it('has bounded growth, decline and cumulative penalties', () => {
    expect(holdersReading({ ...base(), holdersNow: Number.MAX_VALUE, holdersPrevious1h: 0 })).toBe(100);
    expect(holdersReading({ ...base(), holdersNow: 0, holdersPrevious1h: Number.MAX_VALUE })).toBe(0);
    expect(holdersReading({ ...base(), top10Pct: 100, freshWalletsPct: 100, bundlesHeldPct: 100 })).toBe(0);
    expect(holdersReading({ ...base(), top10Pct: 10, freshWalletsPct: 10, bundlesHeldPct: 10 })).toBe(40);
  });
  it.each(['holdersNow', 'holdersPrevious1h'] as const)('responds monotonically to %s', (key) => {
    monotonic([0, 1, 50, 100, 200, 1000].map((value) => holdersReading({ ...base(), [key]: value })), key === 'holdersNow');
  });
  it.each(['top10Pct', 'freshWalletsPct', 'bundlesHeldPct'] as const)('decreases with %s', (key) => {
    monotonic([0, 10, 25, 50, 75, 100].map((value) => holdersReading({ ...base(), [key]: value })), false);
  });
});

describe('Narrative', () => {
  it('no data is neutral and lowData, while observed zeros count as data', () => {
    expect(narrativeReading({})).toEqual({ score: 50, lowData: true });
    expect(narrativeReading({ agentBuyPct: 0, xMentionPace: 0 })).toEqual({ score: 0, lowData: false });
    expect(narrativeReading({ trendingRank: 21, agentBuyPct: 50, xMentionPace: 10 })).toEqual({ score: 50, lowData: false });
  });
  it('each available component contributes without treating absent components as zero', () => {
    expect(narrativeReading({ trendingRank: 1 })).toEqual({ score: 100, lowData: false });
    expect(narrativeReading({ agentBuyPct: 100 })).toEqual({ score: 100, lowData: false });
    expect(narrativeReading({ xMentionPace: Number.MAX_VALUE }).score).toBe(100);
    expect(narrativeReading({ trendingRank: Number.MAX_VALUE }).score).toBeCloseTo(0);
    expect(narrativeReading({ trendingRank: 1, agentBuyPct: 0 }).score).toBe(50);
  });
  it('increases with agent share and mention pace; decreases with numerical rank', () => {
    monotonic([0, 10, 50, 90, 100].map((agentBuyPct) => narrativeReading({ agentBuyPct }).score));
    monotonic([0, 1, 10, 20, 100, 10000].map((xMentionPace) => narrativeReading({ xMentionPace }).score));
    monotonic([1, 2, 10, 21, 50, 1000].map((trendingRank) => narrativeReading({ trendingRank }).score), false);
  });
});

describe('Risk', () => {
  it('starts at 100; Info and Clear do not deduct', () => {
    expect(riskReading(base())).toBe(100);
    expect(riskReading({ ...base(), playbooks: [match('info'), match('clear')] })).toBe(100);
  });
  it('subtracts 25 per Monitor and clamps cumulative deductions', () => {
    const scores = Array.from({ length: 7 }, (_, count) => riskReading({ ...base(), playbooks: Array.from({ length: count }, () => match('monitor')) }));
    expect(scores).toEqual([100, 75, 50, 25, 0, 0, 0]);
  });
  it('Danger forces zero regardless of order, powers or LP', () => {
    for (const playbooks of [[match('danger')], [match('info'), match('monitor'), match('danger')], [match('danger'), match('monitor')]]) {
      expect(riskReading({ ...base(), playbooks })).toBe(0);
      expect(riskReading({ ...base(), playbooks, control: { canChangeTax: true, canBlacklist: true, canMint: true }, lpStatus: 'removable' })).toBe(0);
    }
  });
  it.each(['canChangeTax', 'canBlacklist', 'canMint'] as const)('subtracts 10 for %s', (key) => {
    expect(riskReading({ ...base(), control: { ...base().control, [key]: true } })).toBe(90);
  });
  it.each(['burned', 'locked', 'pons_locked', 'removable'] as const)('handles %s LP', (lpStatus) => {
    expect(riskReading({ ...base(), lpStatus })).toBe(lpStatus === 'removable' ? 85 : 100);
  });
  it('combines matches, all powers and removable LP exactly', () => {
    expect(riskReading({ ...base(), playbooks: [match('monitor')], control: { canChangeTax: true, canBlacklist: true, canMint: true }, lpStatus: 'removable' })).toBe(30);
  });
});

it('rejects invalid numeric measurements instead of emitting NaN or treating them as observations', () => {
  const cases: [keyof SignalInput, number, (input: SignalInput) => unknown][] = [
    ['priceChange5mPct', NaN, momentumReading], ['priceChange1hPct', Infinity, momentumReading],
    ['buyVolumeUsd1h', -1, momentumReading], ['buyVolumeUsdPrevious1h', -1, momentumReading],
    ['depth2Usd', -1, liquidityReading], ['exitCost1kPct', NaN, liquidityReading],
    ['holdersNow', -1, holdersReading], ['holdersPrevious1h', Infinity, holdersReading],
    ['top10Pct', 101, holdersReading], ['freshWalletsPct', -1, holdersReading], ['bundlesHeldPct', NaN, holdersReading],
    ['trendingRank', 0, narrativeReading], ['agentBuyPct', 101, narrativeReading], ['xMentionPace', -1, narrativeReading],
  ];
  for (const [key, value, reading] of cases) expect(() => reading({ ...base(), [key]: value })).toThrow(RangeError);
});
