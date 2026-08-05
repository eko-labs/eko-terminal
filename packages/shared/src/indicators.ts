/**
 * Deterministic technical indicators.
 *
 * Every function is point-in-time: the value at index i only uses inputs[0..i].
 * Outputs are arrays aligned to the input, with `NaN` during the warm-up period.
 * The same implementation feeds the live signal worker, the backtester and the
 * chart overlays, so a signal can always be recomputed from stored candles.
 */

export interface Candle {
  /** Bar open time, unix seconds UTC. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export function sma(values: readonly number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (period <= 0) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** Exponential moving average seeded with the SMA of the first `period` values. */
export function ema(values: readonly number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (period <= 0 || values.length < period) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i]!;
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder's RSI. */
export function rsi(values: readonly number[], period = 14): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = values[i]! - values[i - 1]!;
    if (ch >= 0) gain += ch;
    else loss -= ch;
  }
  let avgG = gain / period;
  let avgL = loss / period;
  out[period] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  for (let i = period + 1; i < values.length; i++) {
    const ch = values[i]! - values[i - 1]!;
    const g = ch > 0 ? ch : 0;
    const l = ch < 0 ? -ch : 0;
    avgG = (avgG * (period - 1) + g) / period;
    avgL = (avgL * (period - 1) + l) / period;
    out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  }
  return out;
}

export interface MacdResult {
  macd: number[];
  signal: number[];
  histogram: number[];
}

export function macd(values: readonly number[], fast = 12, slow = 26, signalPeriod = 9): MacdResult {
  const f = ema(values, fast);
  const s = ema(values, slow);
  const line = values.map((_, i) => f[i]! - s[i]!);
  // Signal EMA is computed over the defined part of the MACD line only.
  const firstDefined = line.findIndex((v) => Number.isFinite(v));
  const signal = new Array<number>(values.length).fill(NaN);
  if (firstDefined >= 0) {
    const sig = ema(line.slice(firstDefined), signalPeriod);
    for (let i = 0; i < sig.length; i++) signal[firstDefined + i] = sig[i]!;
  }
  const histogram = line.map((v, i) => v - signal[i]!);
  return { macd: line, signal, histogram };
}

export interface BollingerResult {
  middle: number[];
  upper: number[];
  lower: number[];
  /** (upper - lower) / middle */
  bandwidth: number[];
  /** (close - lower) / (upper - lower) */
  percentB: number[];
}

/** Bollinger Bands using population standard deviation (the conventional definition). */
export function bollinger(values: readonly number[], period = 20, mult = 2): BollingerResult {
  const middle = sma(values, period);
  const upper = new Array<number>(values.length).fill(NaN);
  const lower = new Array<number>(values.length).fill(NaN);
  const bandwidth = new Array<number>(values.length).fill(NaN);
  const percentB = new Array<number>(values.length).fill(NaN);
  for (let i = period - 1; i < values.length; i++) {
    const m = middle[i]!;
    let v = 0;
    for (let j = i - period + 1; j <= i; j++) v += (values[j]! - m) ** 2;
    const sd = Math.sqrt(v / period);
    upper[i] = m + mult * sd;
    lower[i] = m - mult * sd;
    bandwidth[i] = m !== 0 ? (upper[i]! - lower[i]!) / m : NaN;
    const w = upper[i]! - lower[i]!;
    percentB[i] = w !== 0 ? (values[i]! - lower[i]!) / w : 0.5;
  }
  return { middle, upper, lower, bandwidth, percentB };
}

/** Wilder's Average True Range. */
export function atr(candles: readonly Candle[], period = 14): number[] {
  const out = new Array<number>(candles.length).fill(NaN);
  if (candles.length <= period) return out;
  const tr: number[] = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const pc = candles[i - 1]!.close;
    return Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
  });
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i]!;
  let prev = sum / period;
  out[period] = prev;
  for (let i = period + 1; i < candles.length; i++) {
    prev = (prev * (period - 1) + tr[i]!) / period;
    out[i] = prev;
  }
  return out;
}

/** Highest high / lowest low over the previous `period` bars, EXCLUDING the current bar. */
export function donchian(candles: readonly Candle[], period = 20): { upper: number[]; lower: number[] } {
  const upper = new Array<number>(candles.length).fill(NaN);
  const lower = new Array<number>(candles.length).fill(NaN);
  for (let i = period; i < candles.length; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - period; j < i; j++) {
      hi = Math.max(hi, candles[j]!.high);
      lo = Math.min(lo, candles[j]!.low);
    }
    upper[i] = hi;
    lower[i] = lo;
  }
  return { upper, lower };
}

/** Volume z-score of the current bar against the previous `period` bars (excluding current). */
export function volumeZ(candles: readonly Candle[], period = 20): number[] {
  const out = new Array<number>(candles.length).fill(NaN);
  for (let i = period; i < candles.length; i++) {
    let mean = 0;
    for (let j = i - period; j < i; j++) mean += candles[j]!.volume;
    mean /= period;
    let v = 0;
    for (let j = i - period; j < i; j++) v += (candles[j]!.volume - mean) ** 2;
    const sd = Math.sqrt(v / period);
    out[i] = sd > 0 ? (candles[i]!.volume - mean) / sd : 0;
  }
  return out;
}

/** Relative volume: current volume / mean of previous `period` volumes. */
export function relativeVolume(candles: readonly Candle[], period = 20): number[] {
  const out = new Array<number>(candles.length).fill(NaN);
  for (let i = period; i < candles.length; i++) {
    let mean = 0;
    for (let j = i - period; j < i; j++) mean += candles[j]!.volume;
    mean /= period;
    out[i] = mean > 0 ? candles[i]!.volume / mean : NaN;
  }
  return out;
}

/** Wilder's ADX (trend strength). */
export function adx(candles: readonly Candle[], period = 14): number[] {
  const n = candles.length;
  const out = new Array<number>(n).fill(NaN);
  if (n <= period * 2) return out;
  const plusDM: number[] = [0];
  const minusDM: number[] = [0];
  const tr: number[] = [candles[0]!.high - candles[0]!.low];
  for (let i = 1; i < n; i++) {
    const c = candles[i]!;
    const p = candles[i - 1]!;
    const up = c.high - p.high;
    const down = p.low - c.low;
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  let trS = 0;
  let pS = 0;
  let mS = 0;
  for (let i = 1; i <= period; i++) {
    trS += tr[i]!;
    pS += plusDM[i]!;
    mS += minusDM[i]!;
  }
  const dx: number[] = new Array<number>(n).fill(NaN);
  const calcDx = (i: number) => {
    const pdi = trS > 0 ? (100 * pS) / trS : 0;
    const mdi = trS > 0 ? (100 * mS) / trS : 0;
    dx[i] = pdi + mdi > 0 ? (100 * Math.abs(pdi - mdi)) / (pdi + mdi) : 0;
  };
  calcDx(period);
  for (let i = period + 1; i < n; i++) {
    trS = trS - trS / period + tr[i]!;
    pS = pS - pS / period + plusDM[i]!;
    mS = mS - mS / period + minusDM[i]!;
    calcDx(i);
  }
  let sum = 0;
  for (let i = period; i < period * 2; i++) sum += dx[i]!;
  let prev = sum / period;
  out[period * 2 - 1] = prev;
  for (let i = period * 2; i < n; i++) {
    prev = (prev * (period - 1) + dx[i]!) / period;
    out[i] = prev;
  }
  return out;
}

export function last<T>(arr: readonly T[]): T | undefined {
  return arr[arr.length - 1];
}

export function round(v: number, dp = 6): number {
  if (!Number.isFinite(v)) return v;
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}
