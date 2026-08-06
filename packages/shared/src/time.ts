export const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

export const TIMEFRAME_SECONDS: Record<Timeframe, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '4h': 14400,
  '1d': 86400,
};

export const TIMEFRAME_LABEL: Record<Timeframe, string> = {
  '1m': '1 minute',
  '5m': '5 minutes',
  '15m': '15 minutes',
  '1h': '1 hour',
  '4h': '4 hours',
  '1d': '1 day',
};

export function isTimeframe(v: unknown): v is Timeframe {
  return typeof v === 'string' && (TIMEFRAMES as readonly string[]).includes(v);
}

/** Open time (unix seconds, UTC) of the bar containing `tsSec` for timeframe `tf`. */
export function bucketStart(tsSec: number, tf: Timeframe): number {
  const s = TIMEFRAME_SECONDS[tf];
  return Math.floor(tsSec / s) * s;
}

/** Close time (exclusive) of the bar that opens at `openSec`. */
export function bucketEnd(openSec: number, tf: Timeframe): number {
  return openSec + TIMEFRAME_SECONDS[tf];
}

export function msToSec(ms: number): number {
  return Math.floor(ms / 1000);
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  const neg = ms < 0;
  let s = Math.round(Math.abs(ms) / 1000);
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  let out: string;
  if (d > 0) out = `${d}d ${h}h`;
  else if (h > 0) out = `${h}h ${m}m`;
  else if (m > 0) out = `${m}m ${String(s).padStart(2, '0')}s`;
  else out = `${s}s`;
  return neg ? `-${out}` : out;
}
