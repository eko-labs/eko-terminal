/** Display precision: 2 dp above $100, 3 above $1, 5 above 1¢, otherwise 4 significant digits (e.g. PEPE $0.000004210). */
export function priceDecimals(v: number): number {
  const a = Math.abs(v);
  if (a >= 100) return 2;
  if (a >= 1) return 3;
  if (a >= 0.01) return 5;
  if (a === 0 || !Number.isFinite(a)) return 2;
  return Math.min(12, Math.max(6, 3 - Math.floor(Math.log10(a))));
}

export function formatPrice(v: number | null | undefined, dp?: number): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const d = dp ?? priceDecimals(v);
  return v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

export function formatUsd(v: number | null | undefined, dp = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const sign = v < 0 ? '-' : '';
  return `${sign}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
}

export function formatQty(v: number | null | undefined, maxDp = 6): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  const dp = a >= 1000 ? 2 : a >= 1 ? Math.min(4, maxDp) : maxDp;
  return v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: dp });
}

export function formatPct(v: number | null | undefined, dp = 2, signed = true): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const s = signed && v > 0 ? '+' : '';
  return `${s}${v.toFixed(dp)}%`;
}

export function formatBps(bps: number | null | undefined): string {
  if (bps === null || bps === undefined || !Number.isFinite(bps)) return '—';
  return `${(bps / 100).toFixed(bps < 10 ? 2 : bps < 100 ? 2 : 1)}%`;
}

export function formatCompact(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(v);
}

export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1) return '<1 ms';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

export function shortAddress(a: string | null | undefined): string {
  if (!a) return '—';
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}
