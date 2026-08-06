import {
  adx,
  atr,
  bollinger,
  donchian,
  ema,
  macd,
  relativeVolume,
  round,
  rsi,
  type Candle,
} from './indicators.js';

export type SignalAction = 'buy' | 'sell' | 'hold';
export type StrategyCategory = 'trend' | 'momentum' | 'mean_reversion' | 'breakout' | 'multi_model' | 'ensemble';

export type ParamValue = number | boolean | string;
export type Params = Record<string, ParamValue>;

export interface ParamSpec {
  key: string;
  label: string;
  type: 'int' | 'float' | 'bool' | 'enum';
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  default: ParamValue;
  description: string;
}

export interface Invalidation {
  /** Human-readable condition that would make the signal wrong. */
  condition: string;
  /** Price level that invalidates the idea, if one exists. */
  price: number | null;
}

export interface StrategyDecision {
  action: SignalAction;
  /** Close of the evaluated bar — the price the idea was formed at. */
  referencePrice: number;
  metrics: Record<string, number>;
  rationale: string;
  invalidation: Invalidation;
  /** Bars until the signal is no longer actionable. */
  expiryBars: number;
}

export interface RuleStrategy {
  kind: 'rules';
  id: string;
  version: string;
  name: string;
  category: StrategyCategory;
  summary: string;
  description: string;
  params: ParamSpec[];
  dataInputs: string[];
  warmup(p: Params): number;
  /**
   * Returns a function that evaluates bar i using only candles[0..i].
   * Precomputes causal indicator arrays once so backtests stay O(n).
   */
  prepare(candles: readonly Candle[], p: Params): (i: number) => StrategyDecision | null;
}

const num = (p: Params, k: string, d: number): number => {
  const v = p[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
};

const fmt = (v: number, dp = 2) => (Number.isFinite(v) ? v.toFixed(dp) : 'n/a');

const EXPIRY_PARAM: ParamSpec = {
  key: 'expiryBars',
  label: 'Signal lifetime (bars)',
  type: 'int',
  min: 1,
  max: 20,
  step: 1,
  default: 3,
  description: 'How many bars after the signal bar closes it remains actionable.',
};

export const trendEmaCross: RuleStrategy = {
  kind: 'rules',
  id: 'trend_ema_cross',
  version: '1.2.0',
  name: 'EMA Trend Cross',
  category: 'trend',
  summary: 'Fast/slow EMA crossover filtered by ADX trend strength.',
  description:
    'Emits BUY when the fast EMA crosses above the slow EMA and ADX confirms a trending market; emits SELL (exit an owned position) on the opposite cross. No signal is produced while ADX is below the threshold. Invalidation sits one ATR multiple beyond the slow EMA.',
  params: [
    { key: 'fast', label: 'Fast EMA', type: 'int', min: 3, max: 50, step: 1, default: 9, description: 'Fast EMA period.' },
    { key: 'slow', label: 'Slow EMA', type: 'int', min: 5, max: 200, step: 1, default: 21, description: 'Slow EMA period.' },
    { key: 'minAdx', label: 'Min ADX', type: 'float', min: 0, max: 50, step: 1, default: 18, description: 'Minimum ADX(14) required to act on a cross.' },
    { key: 'atrMult', label: 'Invalidation ATR ×', type: 'float', min: 0.5, max: 5, step: 0.25, default: 1.5, description: 'ATR multiple beyond the slow EMA used as invalidation.' },
    EXPIRY_PARAM,
  ],
  dataInputs: ['OHLCV candles (closed bars only)', 'EMA(fast)', 'EMA(slow)', 'ADX(14)', 'ATR(14)'],
  warmup: (p) => Math.max(num(p, 'slow', 21), 28) + 2,
  prepare(candles, p) {
    const closes = candles.map((c) => c.close);
    const fast = ema(closes, num(p, 'fast', 9));
    const slow = ema(closes, num(p, 'slow', 21));
    const a = adx(candles, 14);
    const r = atr(candles, 14);
    const minAdx = num(p, 'minAdx', 18);
    const mult = num(p, 'atrMult', 1.5);
    const expiryBars = num(p, 'expiryBars', 3);
    return (i) => {
      if (i < 1) return null;
      const f0 = fast[i - 1]!, f1 = fast[i]!, s0 = slow[i - 1]!, s1 = slow[i]!;
      if (![f0, f1, s0, s1, a[i]!, r[i]!].every(Number.isFinite)) return null;
      const crossUp = f0 <= s0 && f1 > s1;
      const crossDown = f0 >= s0 && f1 < s1;
      if (!crossUp && !crossDown) return null;
      if (a[i]! < minAdx) return null;
      const close = candles[i]!.close;
      const metrics = {
        emaFast: round(f1, 6),
        emaSlow: round(s1, 6),
        adx14: round(a[i]!, 2),
        atr14: round(r[i]!, 6),
        emaSpreadPct: round(((f1 - s1) / s1) * 100, 4),
      };
      if (crossUp) {
        const inv = s1 - mult * r[i]!;
        return {
          action: 'buy',
          referencePrice: close,
          metrics,
          rationale: `EMA${num(p, 'fast', 9)} crossed above EMA${num(p, 'slow', 21)} with ADX ${fmt(a[i]!, 1)} ≥ ${minAdx}, indicating an established up-trend.`,
          invalidation: { condition: `Close below slow EMA − ${mult}×ATR`, price: round(inv, 6) },
          expiryBars,
        };
      }
      const inv = s1 + mult * r[i]!;
      return {
        action: 'sell',
        referencePrice: close,
        metrics,
        rationale: `EMA${num(p, 'fast', 9)} crossed below EMA${num(p, 'slow', 21)} with ADX ${fmt(a[i]!, 1)} ≥ ${minAdx}; trend support lost — exit long exposure.`,
        invalidation: { condition: `Close above slow EMA + ${mult}×ATR`, price: round(inv, 6) },
        expiryBars,
      };
    };
  },
};

export const momentumMacdRsi: RuleStrategy = {
  kind: 'rules',
  id: 'momentum_macd_rsi',
  version: '1.1.0',
  name: 'MACD Momentum',
  category: 'momentum',
  summary: 'MACD histogram zero-cross confirmed by RSI regime.',
  description:
    'Emits BUY when the MACD histogram turns positive while RSI sits in the bullish regime but is not overbought; emits SELL when the histogram turns negative with RSI below 50. Invalidation is the lowest low (or highest high) of the lookback window.',
  params: [
    { key: 'fast', label: 'MACD fast', type: 'int', min: 3, max: 30, step: 1, default: 12, description: 'Fast EMA period.' },
    { key: 'slow', label: 'MACD slow', type: 'int', min: 10, max: 60, step: 1, default: 26, description: 'Slow EMA period.' },
    { key: 'signal', label: 'Signal', type: 'int', min: 3, max: 20, step: 1, default: 9, description: 'Signal line period.' },
    { key: 'rsiMax', label: 'RSI ceiling', type: 'float', min: 55, max: 90, step: 1, default: 72, description: 'Do not buy above this RSI.' },
    { key: 'swing', label: 'Swing lookback', type: 'int', min: 3, max: 50, step: 1, default: 10, description: 'Bars used for the invalidation swing level.' },
    EXPIRY_PARAM,
  ],
  dataInputs: ['OHLCV candles (closed bars only)', 'MACD(fast, slow, signal)', 'RSI(14)'],
  warmup: (p) => num(p, 'slow', 26) + num(p, 'signal', 9) + 2,
  prepare(candles, p) {
    const closes = candles.map((c) => c.close);
    const m = macd(closes, num(p, 'fast', 12), num(p, 'slow', 26), num(p, 'signal', 9));
    const r = rsi(closes, 14);
    const rsiMax = num(p, 'rsiMax', 72);
    const swing = num(p, 'swing', 10);
    const expiryBars = num(p, 'expiryBars', 3);
    return (i) => {
      if (i < swing) return null;
      const h0 = m.histogram[i - 1]!, h1 = m.histogram[i]!, rv = r[i]!;
      if (![h0, h1, rv].every(Number.isFinite)) return null;
      const close = candles[i]!.close;
      const metrics = {
        macd: round(m.macd[i]!, 6),
        macdSignal: round(m.signal[i]!, 6),
        histogram: round(h1, 6),
        rsi14: round(rv, 2),
      };
      let lo = Infinity, hi = -Infinity;
      for (let j = i - swing + 1; j <= i; j++) {
        lo = Math.min(lo, candles[j]!.low);
        hi = Math.max(hi, candles[j]!.high);
      }
      if (h0 <= 0 && h1 > 0 && rv >= 50 && rv <= rsiMax) {
        return {
          action: 'buy',
          referencePrice: close,
          metrics,
          rationale: `MACD histogram turned positive (${fmt(h1, 4)}) with RSI ${fmt(rv, 1)} in the bullish regime and below the ${rsiMax} ceiling.`,
          invalidation: { condition: `Close below the ${swing}-bar swing low`, price: round(lo, 6) },
          expiryBars,
        };
      }
      if (h0 >= 0 && h1 < 0 && rv < 50) {
        return {
          action: 'sell',
          referencePrice: close,
          metrics,
          rationale: `MACD histogram turned negative (${fmt(h1, 4)}) and RSI ${fmt(rv, 1)} dropped below 50; momentum has rolled over.`,
          invalidation: { condition: `Close above the ${swing}-bar swing high`, price: round(hi, 6) },
          expiryBars,
        };
      }
      return null;
    };
  },
};

export const meanReversionBands: RuleStrategy = {
  kind: 'rules',
  id: 'mean_reversion_bb',
  version: '1.0.3',
  name: 'Band Reversion',
  category: 'mean_reversion',
  summary: 'Re-entry into Bollinger Bands after an RSI extreme.',
  description:
    'Emits BUY when price closes back inside the lower Bollinger Band after closing outside it, with RSI oversold; emits SELL when price closes back inside the upper band after an overbought excursion. Designed for ranging markets; it will be wrong in strong trends.',
  params: [
    { key: 'period', label: 'Band period', type: 'int', min: 10, max: 60, step: 1, default: 20, description: 'Bollinger SMA period.' },
    { key: 'mult', label: 'Band width σ', type: 'float', min: 1, max: 3.5, step: 0.1, default: 2, description: 'Standard deviations.' },
    { key: 'rsiLow', label: 'RSI oversold', type: 'float', min: 10, max: 45, step: 1, default: 35, description: 'RSI required for BUY.' },
    { key: 'rsiHigh', label: 'RSI overbought', type: 'float', min: 55, max: 90, step: 1, default: 65, description: 'RSI required for SELL.' },
    EXPIRY_PARAM,
  ],
  dataInputs: ['OHLCV candles (closed bars only)', 'Bollinger(period, σ)', 'RSI(14)', 'ATR(14)'],
  warmup: (p) => Math.max(num(p, 'period', 20), 15) + 2,
  prepare(candles, p) {
    const closes = candles.map((c) => c.close);
    const bb = bollinger(closes, num(p, 'period', 20), num(p, 'mult', 2));
    const r = rsi(closes, 14);
    const a = atr(candles, 14);
    const rsiLow = num(p, 'rsiLow', 35);
    const rsiHigh = num(p, 'rsiHigh', 65);
    const expiryBars = num(p, 'expiryBars', 3);
    return (i) => {
      if (i < 1) return null;
      const c0 = closes[i - 1]!, c1 = closes[i]!;
      const l0 = bb.lower[i - 1]!, l1 = bb.lower[i]!, u0 = bb.upper[i - 1]!, u1 = bb.upper[i]!;
      // RSI is checked on the excursion bar (i-1), the bar that was outside the band.
      const rv = r[i - 1]!;
      if (![l0, l1, u0, u1, rv, a[i]!].every(Number.isFinite)) return null;
      const metrics = {
        bbUpper: round(u1, 6),
        bbMiddle: round(bb.middle[i]!, 6),
        bbLower: round(l1, 6),
        percentB: round(bb.percentB[i]!, 4),
        rsi14Prev: round(rv, 2),
        atr14: round(a[i]!, 6),
      };
      if (c0 < l0 && c1 > l1 && rv <= rsiLow) {
        return {
          action: 'buy',
          referencePrice: c1,
          metrics,
          rationale: `Price closed back inside the lower band after an oversold excursion (RSI ${fmt(rv, 1)} ≤ ${rsiLow}); reversion toward the ${num(p, 'period', 20)}-bar mean at ${fmt(bb.middle[i]!, 2)}.`,
          invalidation: { condition: 'Close below lower band − 0.5×ATR', price: round(l1 - 0.5 * a[i]!, 6) },
          expiryBars,
        };
      }
      if (c0 > u0 && c1 < u1 && rv >= rsiHigh) {
        return {
          action: 'sell',
          referencePrice: c1,
          metrics,
          rationale: `Price closed back inside the upper band after an overbought excursion (RSI ${fmt(rv, 1)} ≥ ${rsiHigh}); take profit / exit toward the mean.`,
          invalidation: { condition: 'Close above upper band + 0.5×ATR', price: round(u1 + 0.5 * a[i]!, 6) },
          expiryBars,
        };
      }
      return null;
    };
  },
};

export const breakoutDonchian: RuleStrategy = {
  kind: 'rules',
  id: 'breakout_donchian',
  version: '1.0.1',
  name: 'Range Breakout',
  category: 'breakout',
  summary: 'Donchian channel break confirmed by relative volume.',
  description:
    'Emits BUY when a bar closes above the prior N-bar high on above-average volume; emits SELL when a bar closes below the prior N-bar low on above-average volume. The channel excludes the current bar, so no future data is used.',
  params: [
    { key: 'period', label: 'Channel bars', type: 'int', min: 5, max: 100, step: 1, default: 20, description: 'Lookback for the high/low channel.' },
    { key: 'minRelVol', label: 'Min relative volume', type: 'float', min: 0.5, max: 5, step: 0.1, default: 1.4, description: 'Volume vs. trailing average required.' },
    EXPIRY_PARAM,
  ],
  dataInputs: ['OHLCV candles (closed bars only)', 'Donchian(period, excluding current bar)', 'Relative volume(20)', 'ATR(14)'],
  warmup: (p) => Math.max(num(p, 'period', 20), 20) + 2,
  prepare(candles, p) {
    const period = num(p, 'period', 20);
    const ch = donchian(candles, period);
    const rv = relativeVolume(candles, 20);
    const a = atr(candles, 14);
    const minRelVol = num(p, 'minRelVol', 1.4);
    const expiryBars = num(p, 'expiryBars', 3);
    return (i) => {
      const up = ch.upper[i]!, lo = ch.lower[i]!, v = rv[i]!, at = a[i]!;
      if (![up, lo, v, at].every(Number.isFinite)) return null;
      const c = candles[i]!;
      if (v < minRelVol) return null;
      const metrics = {
        channelHigh: round(up, 6),
        channelLow: round(lo, 6),
        relVolume: round(v, 3),
        atr14: round(at, 6),
      };
      if (c.close > up) {
        return {
          action: 'buy',
          referencePrice: c.close,
          metrics,
          rationale: `Closed above the ${period}-bar high (${fmt(up, 2)}) on ${fmt(v, 2)}× average volume.`,
          invalidation: { condition: 'Close back below the broken channel high − 1×ATR', price: round(up - at, 6) },
          expiryBars,
        };
      }
      if (c.close < lo) {
        return {
          action: 'sell',
          referencePrice: c.close,
          metrics,
          rationale: `Closed below the ${period}-bar low (${fmt(lo, 2)}) on ${fmt(v, 2)}× average volume; range support failed.`,
          invalidation: { condition: 'Close back above the broken channel low + 1×ATR', price: round(lo + at, 6) },
          expiryBars,
        };
      }
      return null;
    };
  },
};

export const RULE_STRATEGIES: Record<string, RuleStrategy> = {
  [trendEmaCross.id]: trendEmaCross,
  [momentumMacdRsi.id]: momentumMacdRsi,
  [meanReversionBands.id]: meanReversionBands,
  [breakoutDonchian.id]: breakoutDonchian,
};

/** Merge user params over defaults and clamp to spec bounds. Unknown keys are dropped. */
export function resolveParams(specs: readonly ParamSpec[], input: Params | undefined): Params {
  const out: Params = {};
  for (const s of specs) {
    const raw = input?.[s.key];
    let v: ParamValue = s.default;
    if (s.type === 'int' || s.type === 'float') {
      if (typeof raw === 'number' && Number.isFinite(raw)) v = raw;
      let n = v as number;
      if (s.type === 'int') n = Math.round(n);
      if (s.min !== undefined) n = Math.max(s.min, n);
      if (s.max !== undefined) n = Math.min(s.max, n);
      v = n;
    } else if (s.type === 'bool') {
      if (typeof raw === 'boolean') v = raw;
    } else if (s.type === 'enum') {
      if (typeof raw === 'string' && s.options?.includes(raw)) v = raw;
    }
    out[s.key] = v;
  }
  return out;
}

/** Returns human-readable problems with a param set, or [] if valid. */
export function validateParams(specs: readonly ParamSpec[], input: Params): string[] {
  const errs: string[] = [];
  const known = new Set(specs.map((s) => s.key));
  for (const k of Object.keys(input)) if (!known.has(k)) errs.push(`Unknown parameter "${k}"`);
  for (const s of specs) {
    const v = input[s.key];
    if (v === undefined) continue;
    if (s.type === 'int' || s.type === 'float') {
      if (typeof v !== 'number' || !Number.isFinite(v)) errs.push(`${s.label} must be a number`);
      else {
        if (s.type === 'int' && !Number.isInteger(v)) errs.push(`${s.label} must be an integer`);
        if (s.min !== undefined && v < s.min) errs.push(`${s.label} must be ≥ ${s.min}`);
        if (s.max !== undefined && v > s.max) errs.push(`${s.label} must be ≤ ${s.max}`);
      }
    } else if (s.type === 'bool' && typeof v !== 'boolean') errs.push(`${s.label} must be true/false`);
    else if (s.type === 'enum' && (typeof v !== 'string' || !s.options?.includes(v))) errs.push(`${s.label} must be one of ${s.options?.join(', ')}`);
  }
  return errs;
}
