/** Terminal ages, in seconds: compact units without fractional hours or days. */
export function formatAge(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  if (whole < 60) return `${whole}s`;
  if (whole < 3600) return `${Math.floor(whole / 60)}m`;
  if (whole < 86400) return `${Math.floor(whole / 3600)}h ${Math.floor(whole % 3600 / 60)}m`;
  return `${Math.floor(whole / 86400)}d`;
}
export const formatFeedSize = (value: number) => Math.abs(value) >= 1e6 ? `$${(value / 1e6).toFixed(2)}M`
  : Math.abs(value) >= 1000 ? `$${(value / 1000).toFixed(1)}K` : `$${value.toLocaleString('en-US')}`;

/**
 * Compact USD for large figures such as FDV: $850, $2.31K, $1.24M, $3.10B (three significant digits).
 * With `step`, the gap between neighbouring axis ticks, it adds decimals until neighbours cannot print the same text.
 */
export function formatCompactUsd(value: number, step?: number): string {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  const [unit, suffix] = abs >= 1e9 ? [1e9, 'B'] : abs >= 1e6 ? [1e6, 'M'] : abs >= 1e3 ? [1e3, 'K'] : [1, ''];
  const scaled = abs / unit;
  let digits = suffix ? (scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2) : (abs >= 100 ? 0 : 2);
  if (step !== undefined && Number.isFinite(step) && step > 0) while (digits < 6 && step / unit < 10 ** -digits) digits++;
  return `${value < 0 ? '-' : ''}$${scaled.toFixed(digits)}${suffix}`;
}

/** Prototype price labels: three significant digits for small token prices. */
export function formatCoinPrice(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return `$${value >= 1 ? value.toFixed(4) : value >= .01 ? value.toFixed(5) : value.toPrecision(3)}`;
}

/** Exact decimal display; monetary presentation never passes through float rounding. */
export function formatUsd(value: string | number, fractionDigits: 0 | 2 = 2): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(value));
  if (!match) return '—';
  const fraction = match[3] ?? '', scale = 10n ** BigInt(fractionDigits);
  let units = BigInt(match[2]) * scale + BigInt(fraction.slice(0, fractionDigits).padEnd(fractionDigits, '0') || '0');
  const rest = fraction.slice(fractionDigits), tie = rest[0] === '5' && !/[1-9]/.test(rest.slice(1));
  if (rest[0] > '5' || rest[0] === '5' && (!tie || units % 2n === 1n)) units++;
  const whole = (units / scale).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${match[1] && units ? '-' : ''}$${whole}${fractionDigits ? `.${(units % scale).toString().padStart(fractionDigits, '0')}` : ''}`;
}

export function formatUtcTime(timestampSec: string | number): string {
  const date = new Date(Number(timestampSec) * 1000);
  return Number.isFinite(date.getTime()) ? `${date.toISOString().slice(0, 19).replace('T', ' ')} UTC` : '—';
}
