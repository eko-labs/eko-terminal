import { EventEmitter } from 'node:events';
import { TIMEFRAMES, TIMEFRAME_SECONDS, bucketStart, type Candle, type Timeframe } from '@eko/shared';

interface Series {
  closed: Candle[];
  forming: Candle | null;
}

export interface CandleStoreEvents {
  update: [market: string, tf: Timeframe, candle: Candle];
  close: [market: string, tf: Timeframe, candle: Candle, closedAtMs: number];
}

/**
 * In-memory OHLCV series per (market, timeframe), built from trades.
 * - A bar closes when a trade arrives in a later bucket OR when the sweep sees its end time pass.
 * - Late trades for an already-closed bar are ignored (and counted), never rewrite history.
 */
export class CandleStore extends EventEmitter<CandleStoreEvents> {
  private series = new Map<string, Series>();
  lateTrades = 0;

  constructor(
    private cap = 3000,
    /** Late-trade window before a quiet bar is closed by the sweep (busy markets close on the next trade). */
    private graceMs = 600,
  ) {
    super();
  }

  private key(market: string, tf: Timeframe) {
    return `${market}|${tf}`;
  }

  private get(market: string, tf: Timeframe): Series {
    const k = this.key(market, tf);
    let s = this.series.get(k);
    if (!s) {
      s = { closed: [], forming: null };
      this.series.set(k, s);
    }
    return s;
  }

  /**
   * Merge history (ascending). Bars whose bucket has not ended at `nowMs` become the forming bar.
   * Existing closed bars in the overlapping range are replaced (used for gap repair after reconnects).
   */
  mergeHistory(market: string, tf: Timeframe, bars: Candle[], nowMs: number) {
    if (!bars.length) return;
    const s = this.get(market, tf);
    const step = TIMEFRAME_SECONDS[tf];
    const nowSec = nowMs / 1000;
    const byTime = new Map<number, Candle>();
    for (const c of s.closed) byTime.set(c.time, c);
    for (const b of bars) {
      if (b.time + step <= nowSec) byTime.set(b.time, { ...b });
      else if (!s.forming || s.forming.time < b.time) s.forming = { ...b };
      else if (s.forming.time === b.time) {
        // Keep the larger-volume view of the forming bar (history vs. live trades so far).
        const f = s.forming;
        f.high = Math.max(f.high, b.high);
        f.low = Math.min(f.low, b.low);
        if (b.volume > f.volume) {
          f.volume = b.volume;
          f.open = b.open;
        }
      }
    }
    s.closed = [...byTime.values()].sort((a, b) => a.time - b.time);
    if (s.closed.length > this.cap) s.closed.splice(0, s.closed.length - this.cap);
    if (s.forming && s.closed.length && s.forming.time <= s.closed[s.closed.length - 1]!.time) s.forming = null;
  }

  ingestTrade(market: string, price: number, size: number, timeMs: number) {
    if (!(price > 0) || !Number.isFinite(size)) return;
    const tSec = Math.floor(timeMs / 1000);
    for (const tf of TIMEFRAMES) {
      const s = this.get(market, tf);
      const b = bucketStart(tSec, tf);
      const lastClosed = s.closed[s.closed.length - 1];
      if (lastClosed && b <= lastClosed.time) {
        if (tf === '1m') this.lateTrades++;
        continue;
      }
      if (s.forming && b > s.forming.time) this.closeForming(market, tf, s, timeMs);
      if (!s.forming) {
        s.forming = { time: b, open: price, high: price, low: price, close: price, volume: size };
      } else {
        const f = s.forming;
        f.high = Math.max(f.high, price);
        f.low = Math.min(f.low, price);
        f.close = price;
        f.volume += size;
      }
      this.emit('update', market, tf, s.forming);
    }
  }

  private closeForming(market: string, tf: Timeframe, s: Series, atMs: number) {
    const f = s.forming;
    if (!f) return;
    s.closed.push(f);
    if (s.closed.length > this.cap) s.closed.splice(0, s.closed.length - this.cap);
    s.forming = null;
    this.emit('close', market, tf, f, atMs);
  }

  /** Close any forming bars whose bucket ended more than graceMs ago. */
  sweep(nowMs: number) {
    for (const [k, s] of this.series) {
      if (!s.forming) continue;
      const [market, tf] = k.split('|') as [string, Timeframe];
      const endMs = (s.forming.time + TIMEFRAME_SECONDS[tf]) * 1000;
      if (nowMs >= endMs + this.graceMs) this.closeForming(market, tf, s, nowMs);
    }
  }

  /** Closed bars only (what strategies see). */
  closed(market: string, tf: Timeframe, limit = 500): Candle[] {
    const s = this.series.get(this.key(market, tf));
    if (!s) return [];
    return s.closed.slice(-limit);
  }

  forming(market: string, tf: Timeframe): Candle | null {
    return this.series.get(this.key(market, tf))?.forming ?? null;
  }

  /** Chart snapshot: closed bars (optionally before a time) plus the forming bar. */
  snapshot(market: string, tf: Timeframe, limit: number, beforeSec?: number): Candle[] {
    const s = this.series.get(this.key(market, tf));
    if (!s) return [];
    let arr = s.closed;
    if (beforeSec !== undefined) arr = arr.filter((c) => c.time < beforeSec);
    const out = arr.slice(-limit).map((c) => ({ ...c }));
    if (beforeSec === undefined && s.forming) out.push({ ...s.forming });
    return out;
  }

  earliest(market: string, tf: Timeframe): number | null {
    return this.series.get(this.key(market, tf))?.closed[0]?.time ?? null;
  }

  lastPrice(market: string): number | null {
    const s = this.series.get(this.key(market, '1m'));
    return s?.forming?.close ?? s?.closed[s.closed.length - 1]?.close ?? null;
  }
}
