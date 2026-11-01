import type { Address, Hex } from 'viem';

/** One swap in a coin's pool, from the PoolManager's Swap event. Amounts are from the trader's side. */
export interface Trade { ts: number; block: number; tx: Hex; sender: Address; side: 'buy' | 'sell'; hype: number; tokens: number; priceHype: number }

const Q96 = 2 ** 96;
/**
 * HYPE per token from a v4 pool's sqrtPriceX96, for a pool whose currency0 is native HYPE and currency1 the coin,
 * both 18 decimals (every native-quoted Montra launch). sqrtPriceX96² / 2¹⁹² = token1 per token0.
 */
export function priceHypeFromSqrt(sqrtPriceX96: bigint): number {
  const root = Number(sqrtPriceX96) / Q96;
  const tokensPerHype = root * root;
  return tokensPerHype > 0 ? 1 / tokensPerHype : 0;
}

/**
 * A trade from a v4 Swap of a HYPE/coin pool. On Elysium, checked on a captured Montra launch: a buy pays HYPE
 * (amount0 < 0) and receives the coin (amount1 > 0); a sell is the reverse.
 */
export function tradeFromSwap(input: { amount0: bigint; amount1: bigint; sqrtPriceX96: bigint; sender: Address; tx: Hex; block: number; ts: number }): Trade | null {
  if (input.amount0 === 0n || input.amount1 === 0n || (input.amount0 < 0n) === (input.amount1 < 0n)) return null;
  const abs = (v: bigint) => Number(v < 0n ? -v : v) / 1e18;
  return { ts: input.ts, block: input.block, tx: input.tx, sender: input.sender, side: input.amount0 < 0n ? 'buy' : 'sell',
    hype: abs(input.amount0), tokens: abs(input.amount1), priceHype: priceHypeFromSqrt(input.sqrtPriceX96) };
}

export const TIMEFRAMES = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 } as const;
export type Timeframe = keyof typeof TIMEFRAMES;
export interface Bar { ts: number; o: number; h: number; l: number; c: number; vUsd: number }

/** OHLC bars in USD from trades (ascending by ts). Only buckets with trades are emitted; the chart fills gaps. */
export function barsFromTrades(trades: readonly Trade[], tf: Timeframe, hypeUsd: number, from: number, to: number): Bar[] {
  const step = TIMEFRAMES[tf], out: Bar[] = [];
  let bar: Bar | null = null;
  for (const t of trades) {
    if (t.ts < from || t.ts > to) continue;
    const bucket = Math.floor(t.ts / step) * step, price = t.priceHype * hypeUsd, vol = t.hype * hypeUsd;
    if (!bar || bar.ts !== bucket) { bar = { ts: bucket, o: price, h: price, l: price, c: price, vUsd: 0 }; out.push(bar); }
    bar.h = Math.max(bar.h, price); bar.l = Math.min(bar.l, price); bar.c = price; bar.vUsd += vol;
  }
  return out;
}

/** Percentage change from the last price at or before `sinceTs` to the latest; 0 without an earlier price. */
export function changePct(trades: readonly Trade[], sinceTs: number): number {
  if (!trades.length) return 0;
  let before: Trade | undefined;
  for (const t of trades) { if (t.ts <= sinceTs) before = t; else break; }
  const base = before ?? trades[0]!, last = trades.at(-1)!;
  return base.priceHype > 0 ? ((last.priceHype - base.priceHype) / base.priceHype) * 100 : 0;
}

/** Up to `points` evenly spaced closing prices over the last `windowSec`, oldest first (for the radar sparkline). */
export function spark(trades: readonly Trade[], nowSec: number, windowSec = 8 * 3600, points = 32): number[] {
  if (!trades.length) return [];
  const step = windowSec / points, out: number[] = [];
  let i = 0, last = trades[0]!.priceHype;
  for (let p = 1; p <= points; p++) {
    const until = nowSec - windowSec + p * step;
    while (i < trades.length && trades[i]!.ts <= until) last = trades[i++]!.priceHype;
    out.push(last);
  }
  return out;
}
