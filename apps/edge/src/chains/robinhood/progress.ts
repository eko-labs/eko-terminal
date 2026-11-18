import type { PonsCurve } from './events.js';
import { reserveDelta } from './events.js';

/**
 * Pons curve progress in basis points (0 to 10,000), ported from apps/engines/src/curve-progress.ts. A curve graduates
 * when its real quote reserve reaches the launch's graduationThreshold (4.2 ETH on every native launch so far). The
 * real reserve excludes trading fees (anti-snipe included) and creator tax: a buy's quoteIn is gross, so it adds
 * quoteIn − fee − tax; a sell's quoteOut is the net payout, so it removes quoteOut + fee + tax. Arithmetic stays in
 * bigint; only the shown value is capped.
 */
export const GRADUATED_BPS = 10_000;

/** Progress of a curve now; graduated coins are 10,000. Null when the threshold is unknown or zero. */
export function curveProgressBps(curve: Pick<PonsCurve, 'realQuoteReserve' | 'graduationThreshold'>, graduated = false): number | null {
  if (graduated) return GRADUATED_BPS;
  if (curve.graduationThreshold <= 0n) return null;
  const bps = curve.realQuoteReserve * 10_000n / curve.graduationThreshold;
  return bps > 10_000n ? GRADUATED_BPS : Number(bps < 0n ? 0n : bps);
}

export type ProgressEvent =
  | { kind: 'launch'; block: number; graduationThreshold: bigint }
  | { kind: 'trade'; block: number; side: 'buy' | 'sell'; native: bigint; fee: bigint; tax: bigint };
export interface ProgressPoint { block: number; bps?: number }

/**
 * Progress after each event of one coin, in order. The threshold counts only from a launch at `launchBlock`. A trade
 * with a negative net buy, or a reserve that would go below zero, means history is missing: every later point is left
 * without a value rather than shown wrong (never substituted with total-supply inventory).
 */
export function curveProgressSeries(events: readonly ProgressEvent[], launchBlock: number): ProgressPoint[] {
  let threshold: bigint | undefined, reserve = 0n, valid = true;
  const points: ProgressPoint[] = [];
  for (const e of events) {
    if (e.kind === 'launch') threshold = e.block === launchBlock && e.graduationThreshold > 0n ? e.graduationThreshold : undefined;
    else {
      const delta = reserveDelta(e);
      if (e.side === 'buy' && delta < 0n) valid = false;
      reserve += delta;
      if (reserve < 0n) valid = false;
    }
    const bps = valid && threshold !== undefined ? curveProgressBps({ realQuoteReserve: reserve, graduationThreshold: threshold }) : null;
    points.push({ block: e.block, ...(bps !== null ? { bps } : {}) });
  }
  return points;
}

/** The progress at a block: the last point at or before it (points ascending by block). */
export function curveProgressAt(points: readonly ProgressPoint[], block: number): number | undefined {
  let low = 0, high = points.length;
  while (low < high) { const mid = (low + high) >>> 1; if (points[mid]!.block <= block) low = mid + 1; else high = mid; }
  return points[low - 1]?.bps;
}
