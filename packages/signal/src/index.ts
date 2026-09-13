import type { CoinSignal } from '@eko/shared';
import type { SignalInput } from './types.js';
import { holdersReading, liquidityReading, momentumReading, narrativeReading, riskReading } from './readings.js';

export type { SignalInput, SignalExtras } from './types.js';
export { inputFromCard } from './types.js';
export * from './readings.js';

export const SIGNAL_VERSION = 1;
export const SIGNAL_WEIGHTS = Object.freeze({ momentum: 0.30, liquidity: 0.25, holders: 0.20, narrative: 0.15, risk: 0.10 });
export const SIGNAL_REFRESH_MS = 15_000;

/** Pure; callers own card.updated events and per-coin timestamps. Never feeds rankings or guards. */
export function computeSignal(input: SignalInput): CoinSignal {
  if (!Number.isSafeInteger(input.asOfBlock) || input.asOfBlock < 0) throw new RangeError('asOfBlock must be a nonnegative safe integer');
  const narrative = narrativeReading(input);
  const readings: CoinSignal['readings'] = {
    momentum: momentumReading(input),
    liquidity: liquidityReading(input),
    holders: holdersReading(input),
    narrative: narrative.score,
    risk: riskReading(input),
  };
  const weights = { ...SIGNAL_WEIGHTS };
  const composite = compositeFromReadings(readings);
  const signal: CoinSignal = { composite, readings, weights, beta: true, asOfBlock: input.asOfBlock };
  if (narrative.lowData) signal.lowData = ['narrative'];
  return signal;
}

export type SignalReading = keyof CoinSignal['readings'];

/** Keep the unrounded reading contributions; round only their total (§7.7). */
export function compositeFromReadings(readings: CoinSignal['readings']): number {
  return Math.round((Object.keys(SIGNAL_WEIGHTS) as SignalReading[]).reduce((sum, reading) => {
    const value = readings[reading];
    if (!Number.isFinite(value) || value < 0 || value > 100) throw new RangeError(`${reading} must be between 0 and 100`);
    return sum + value * SIGNAL_WEIGHTS[reading];
  }, 0));
}

export interface SignalExplanation {
  reading: SignalReading;
  value: number;
  /** Fraction, e.g. 0.30; multiply by 100 for display. */
  weight: number;
  points: number;
}

export function explainSignal(signal: CoinSignal): SignalExplanation[] {
  return (Object.keys(SIGNAL_WEIGHTS) as SignalReading[]).map((reading) => ({
    reading, value: signal.readings[reading], weight: signal.weights[reading],
    points: signal.readings[reading] * signal.weights[reading],
  }));
}

/** Times are milliseconds. Pass null/undefined for a coin never computed; clock rollback waits. */
export function shouldRecomputeSignal(lastComputedMs: number | null | undefined, nowMs: number): boolean {
  if (!Number.isFinite(nowMs)) throw new RangeError('nowMs must be finite');
  if (lastComputedMs == null) return true;
  if (!Number.isFinite(lastComputedMs)) throw new RangeError('lastComputedMs must be finite');
  return nowMs - lastComputedMs >= SIGNAL_REFRESH_MS;
}

export * from './v2.js';
