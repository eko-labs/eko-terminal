import type { InstantResult } from '../../lib/instant';

/** The one line under the trade buttons (and the toast that goes with it). */
export interface Outcome {
  /** ok: filled/confirmed · pending: submitted on-chain · confirm: a large live trade waits for a yes · warn: nothing happened (e.g. cancelled in the wallet) */
  tone: 'ok' | 'pending' | 'confirm' | 'warn' | 'error';
  text: string;
}

/** "$50", "$100", "$42", "$7.50": preset-style dollars, never rounded up (a $99.93 holding is "$99"). */
export function money(v: number): string {
  const whole = v >= 10 || Number.isInteger(v);
  const shown = whole ? Math.floor(v) : Math.floor(v * 100) / 100;
  return `$${shown.toLocaleString('en-US', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 })}`;
}

/** An instant trade's result as one line; null for a tap swallowed by the double-tap guard. */
export function describeResult(r: InstantResult): Outcome | null {
  if (r.ok) return { tone: r.order.status === 'submitted' || r.order.status === 'awaiting_signature' ? 'pending' : 'ok', text: r.message };
  if (r.code === 'busy') return null;
  if (r.code === 'confirm_required') return { tone: 'confirm', text: r.message };
  if (r.code === 'user_rejected') return { tone: 'warn', text: r.message };
  return { tone: 'error', text: r.message };
}
