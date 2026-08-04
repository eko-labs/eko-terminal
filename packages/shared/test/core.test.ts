import { describe, expect, it } from 'vitest';
import {
  RULE_STRATEGIES,
  bollinger,
  ema,
  formatPrice,
  getMarket,
  macd,
  positionSize,
  riskReward,
  rsi,
  runBacktest,
  sma,
  type Candle,
  type RuleStrategy,
} from '../src/index.js';

/** Seeded random walk with occasional trends so every strategy produces signals. */
function series(n: number, seed = 7, start = 100): Candle[] {
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out: Candle[] = [];
  let p = start;
  let drift = 0;
  for (let i = 0; i < n; i++) {
    if (i % 60 === 0) drift = (rand() - 0.5) * 0.01;
    const o = p;
    const c = o * (1 + drift + (rand() - 0.5) * 0.02);
    const h = Math.max(o, c) * (1 + rand() * 0.006);
    const l = Math.min(o, c) * (1 - rand() * 0.006);
    out.push({ time: 1_700_000_000 + i * 3600, open: o, high: h, low: l, close: c, volume: 100 + rand() * 200 + (rand() < 0.05 ? 800 : 0) });
    p = c;
  }
  return out;
}

describe('indicators', () => {
  it('SMA and EMA of a constant series equal the constant after warm-up', () => {
    const xs = Array(50).fill(42);
    expect(sma(xs, 10)[9]).toBe(42);
    expect(Number.isNaN(sma(xs, 10)[8]!)).toBe(true);
    expect(ema(xs, 10).slice(9).every((v) => Math.abs(v - 42) < 1e-12)).toBe(true);
  });

  it('SMA matches a hand-computed value', () => {
    expect(sma([1, 2, 3, 4, 5], 3)[4]).toBeCloseTo(4, 12);
  });

  it('RSI is 100 for a strictly rising series and 0 for a strictly falling one', () => {
    const up = Array.from({ length: 40 }, (_, i) => 100 + i);
    const down = Array.from({ length: 40 }, (_, i) => 100 - i);
    expect(rsi(up, 14)[39]).toBe(100);
    expect(rsi(down, 14)[39]).toBeCloseTo(0, 10);
  });

  it('Bollinger bands collapse onto the mean for a constant series; MACD is zero', () => {
    const xs = Array(60).fill(10);
    const b = bollinger(xs, 20, 2);
    expect(b.upper[30]).toBe(10);
    expect(b.lower[30]).toBe(10);
    const m = macd(xs);
    expect(Math.abs(m.macd[59]!)).toBeLessThan(1e-12);
    expect(Math.abs(m.histogram[59]!)).toBeLessThan(1e-12);
  });
});

describe('strategies are point-in-time (no look-ahead)', () => {
  const candles = series(700);
  for (const strat of Object.values(RULE_STRATEGIES) as RuleStrategy[]) {
    it(`${strat.id}: decision at bar i is identical with or without future bars`, () => {
      const full = strat.prepare(candles, {});
      let checked = 0;
      let signals = 0;
      for (let i = strat.warmup({}); i < candles.length; i += 7) {
        const truncated = strat.prepare(candles.slice(0, i + 1), {})(i);
        const withFuture = full(i);
        expect(withFuture).toEqual(truncated);
        checked++;
        if (withFuture) signals++;
      }
      expect(checked).toBeGreaterThan(50);
      void signals;
    });
  }

  it('every strategy emits at least one signal on a trending random walk', () => {
    const c = series(3000, 11);
    for (const strat of Object.values(RULE_STRATEGIES)) {
      const f = strat.prepare(c, {});
      let n = 0;
      for (let i = 0; i < c.length; i++) if (f(i)) n++;
      expect(n, strat.id).toBeGreaterThan(0);
    }
  });

  it('buy invalidation levels are below the reference price and sell levels above', () => {
    const c = series(3000, 5);
    for (const strat of Object.values(RULE_STRATEGIES)) {
      const f = strat.prepare(c, {});
      for (let i = 0; i < c.length; i++) {
        const d = f(i);
        if (!d || d.invalidation.price === null) continue;
        if (d.action === 'buy') expect(d.invalidation.price).toBeLessThan(d.referencePrice);
        if (d.action === 'sell') expect(d.invalidation.price).toBeGreaterThan(d.referencePrice);
        expect(d.referencePrice).toBe(c[i]!.close);
      }
    }
  });
});

describe('backtester', () => {
  // A strategy stub that buys on a chosen bar and sells on another.
  const scripted = (buyAt: number, sellAt: number, inv: number | null = null): RuleStrategy => ({
    ...RULE_STRATEGIES.trend_ema_cross!,
    id: 'scripted',
    warmup: () => 1,
    prepare: (c) => (i) =>
      i === buyAt
        ? { action: 'buy', referencePrice: c[i]!.close, metrics: {}, rationale: 'x', invalidation: { condition: 'x', price: inv }, expiryBars: 1 }
        : i === sellAt
          ? { action: 'sell', referencePrice: c[i]!.close, metrics: {}, rationale: 'x', invalidation: { condition: 'x', price: null }, expiryBars: 1 }
          : null,
  });
  const flat = (n: number, px = 100): Candle[] => Array.from({ length: n }, (_, i) => ({ time: i * 60, open: px, high: px, low: px, close: px, volume: 1 }));

  it('executes at the NEXT bar open, never the signal bar', () => {
    const c = flat(20).map((x, i) => ({ ...x, open: 100 + i, close: 100 + i + 0.5, high: 100 + i + 1, low: 100 + i - 1 }));
    const r = runBacktest(scripted(5, 10), c, {}, { feeBps: 0, slippageBps: 0, useInvalidationStop: false });
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0]!.entryTime).toBe(c[6]!.time);
    expect(r.trades[0]!.entryPrice).toBe(c[6]!.open);
    expect(r.trades[0]!.exitPrice).toBe(c[11]!.open);
  });

  it('charges fees and slippage on both sides (flat market loses ~2×(fee+slip))', () => {
    const r = runBacktest(scripted(2, 8), flat(20), {}, { feeBps: 30, slippageBps: 10, useInvalidationStop: false, startingEquity: 10_000 });
    const t = r.trades[0]!;
    expect(t.returnPct).toBeLessThan(0);
    expect(t.returnPct).toBeCloseTo(-0.8, 1);
    expect(r.metrics.overall.feesPaid).toBeGreaterThan(0);
  });

  it('a SELL with no open position never opens a short', () => {
    const r = runBacktest(scripted(-1, 3), flat(20), {}, {});
    expect(r.trades).toHaveLength(0);
    expect(r.metrics.overall.totalReturnPct).toBe(0);
  });

  it('exits at the stop when the invalidation level is breached (gap-aware)', () => {
    const c = flat(20);
    c[9] = { ...c[9]!, open: 95, low: 90, close: 92 };
    const r = runBacktest(scripted(2, 15, 97), c, {}, { feeBps: 0, slippageBps: 0, useInvalidationStop: true });
    expect(r.trades[0]!.exitReason).toBe('stop');
    expect(r.trades[0]!.exitPrice).toBe(95); // gapped below the 97 stop → worse of open and stop
  });

  it('splits trades into in-sample and out-of-sample segments by bar index', () => {
    const c = series(1500, 3);
    const r = runBacktest(RULE_STRATEGIES.trend_ema_cross!, c, {}, { inSampleFraction: 0.6 });
    const ins = r.trades.filter((t) => t.segment === 'in_sample').length;
    const oos = r.trades.filter((t) => t.segment === 'out_of_sample').length;
    expect(ins + oos).toBe(r.trades.length);
    expect(r.metrics.inSample.trades).toBe(ins);
    expect(r.metrics.outOfSample.trades).toBe(oos);
    expect(r.period.splitTime).toBe(c[900]!.time);
    expect(r.limitations.length).toBeGreaterThan(0);
  });
});

describe('risk calculators', () => {
  it('position size risks exactly the chosen fraction of the account', () => {
    const r = positionSize({ accountSize: 10_000, riskPct: 1, entry: 100, stop: 95 });
    expect(r.error).toBeNull();
    expect(r.quantity).toBeCloseTo(20, 10);
    expect(r.quantity * (100 - 95)).toBeCloseTo(100, 10);
  });
  it('caps size at the account (spot, no leverage)', () => {
    const r = positionSize({ accountSize: 1000, riskPct: 5, entry: 100, stop: 99.9 });
    expect(r.capped).toBe(true);
    expect(r.notional).toBe(1000);
  });
  it('rejects a stop above entry for a spot long', () => {
    expect(positionSize({ accountSize: 1000, riskPct: 1, entry: 100, stop: 101 }).error).not.toBeNull();
  });
  it('risk/reward and breakeven win rate', () => {
    const r = riskReward({ entry: 100, stop: 95, target: 110 });
    expect(r.ratio).toBeCloseTo(2, 10);
    expect(r.breakevenWinRate).toBeCloseTo(1 / 3, 10);
  });
});

describe('markets and sub-cent formatting', () => {
  it('lists the demo markets with deterministic seeds', () => {
    for (const id of ['UNI-USD', 'ARB-USD', 'SUI-USD', 'PEPE-USD']) {
      const m = getMarket(id)!;
      expect(m.id).toBe(id);
      expect(m.demo.seedPrice).toBeGreaterThan(0);
      expect(m.accent).toMatch(/^#[0-9A-F]{6}$/i);
    }
    expect(getMarket('PEPE-USD')!.qtyDecimals).toBe(0);
  });

  it('keeps four significant digits for prices below one cent', () => {
    expect(formatPrice(0.0000071)).toBe('0.000007100');
    expect(formatPrice(0.00000421)).toBe('0.000004210');
    expect(formatPrice(0.005)).toBe('0.005000');
    expect(formatPrice(0.121)).toBe('0.12100');
    expect(formatPrice(8.7957)).toBe('8.796');
    expect(formatPrice(2687.41)).toBe('2,687.41');
    expect(formatPrice(0)).toBe('0.00');
  });

});
