import { bucketStart as sharedBucketStart, type Bar, type Tick, type Timeframe } from '@eko/shared';
export const COIN_TIMEFRAMES = ['1s', '15s', '30s', '1m', '5m', '15m', '30m', '1h', '4h', '1d'] as const;
export type CoinTimeframe = typeof COIN_TIMEFRAMES[number];
export const seconds = (tf: CoinTimeframe) => ({ '1s': 1, '15s': 15, '30s': 30, '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400 })[tf];
// Coin intervals the retained market/backtest Timeframe contract does not have are anchored here.
const OWN: readonly CoinTimeframe[] = ['1s', '15s', '30s', '30m'];
export const bucketStart = (ts: number, tf: CoinTimeframe) => OWN.includes(tf) ? Math.floor(ts / seconds(tf)) * seconds(tf) : sharedBucketStart(ts, tf as Timeframe);
export const anchorTime = bucketStart;
export interface View { s: number; e: number }
export const slotWidth = (width: number, view: View) => width / (view.e - view.s);
export { candleWidth } from '../../lib/phosphor';
/** Zoom runs from 5 bars to every loaded bar (at least 40 slots, so a short history can still go thin); a view wider
 *  than the data keeps it against the right edge, as trading charts do. */
export function clampView(v: View, n: number): View {
  if (!n) return { s: 0, e: 1 };
  const span = Math.max(Math.min(5, n), Math.min(Math.max(n * 1.15, 40), v.e - v.s));
  const right = n + span * .15 - span, s = Math.max(Math.min(-span * .05, right), Math.min(v.s, right));
  return { s, e: s + span };
}
/** Exponential moving average of closes (seeded with the first close). */
export function emaOf(closes: readonly number[], period: number): number[] {
  const k = 2 / (period + 1), out: number[] = [];
  let prev = closes[0] ?? 0;
  for (const c of closes) { prev = c * k + prev * (1 - k); out.push(prev); }
  return out;
}
/** Time-axis label for a bar: seconds on sub-minute intervals, the date on day-long ones (local time). */
export function timeLabel(ts: number, tf: CoinTimeframe): string {
  const d = new Date(ts * 1000), two = (n: number) => String(n).padStart(2, '0'), hm = `${two(d.getHours())}:${two(d.getMinutes())}`;
  if (tf.endsWith('s')) return `${hm}:${two(d.getSeconds())}`;
  if (tf === '1d') return `${d.toLocaleString('en', { month: 'short' })} ${d.getDate()}`;
  if (tf === '1h' || tf === '4h') return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
  return hm;
}
export function zoomView(v: View, factor: number, fraction: number): View {
  const at = v.s + fraction * (v.e - v.s), span = (v.e - v.s) * factor;
  return { s: at - fraction * span, e: at + (1 - fraction) * span };
}
export const panView = (v: View, dx: number, width: number): View => ({ s: v.s - dx / slotWidth(width, v), e: v.e - dx / slotWidth(width, v) });
export const stretchScale = (k: number, delta: number) => Math.max(.25, Math.min(6, k * Math.exp(delta * .002)));
export function aggregateTick(bars: readonly Bar[], tick: Tick, tf: CoinTimeframe): Bar[] {
  const ts = bucketStart(tick.ts, tf), last = bars.at(-1);
  if (last && ts < last.ts) return [...bars];
  const bar: Bar = last?.ts === ts ? { ...last, h: Math.max(last.h, tick.price), l: Math.min(last.l, tick.price), c: tick.price, vUsd: last.vUsd + tick.volumeUsd } : { ts, o: tick.price, h: tick.price, l: tick.price, c: tick.price, vUsd: tick.volumeUsd };
  return [...(last?.ts === ts ? bars.slice(0, -1) : bars), bar];
}

/** The prototype's 30m view composes supported 15m bars; the REST contract stays unchanged. */
export function barsForTimeframe(bars: Bar[], tf: CoinTimeframe): Bar[] {
  if (tf !== '30m') return bars;
  const out: Bar[] = [];
  for (const bar of bars) {
    const ts = bucketStart(bar.ts, tf), last = out.at(-1);
    if (last?.ts === ts) { last.h = Math.max(last.h, bar.h); last.l = Math.min(last.l, bar.l); last.c = bar.c; last.vUsd += bar.vUsd; }
    else out.push({ ...bar, ts });
  }
  return out;
}

/** REST covers [from,to); buffered ticks at the exclusive end belong to the live tail. */
export function reconcileCandleTicks(bars: Bar[], ticks: Tick[], to: number, tf: CoinTimeframe): Bar[] {
  let data = barsForTimeframe(bars, tf);
  for (const tick of ticks.filter(t => t.ts >= to).sort((a, b) => a.ts - b.ts || a.block - b.block)) data = aggregateTick(data, tick, tf);
  return data;
}
