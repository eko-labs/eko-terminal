import type { TradeOrder } from '@eko/shared';
import { BUILD_NETWORK } from '../../lib/deployment';

/**
 * A wei amount as a readable decimal, with exact bigint arithmetic (no float rounding):
 * 1,234,567.89 for large amounts, 1.2346 under a thousand, four significant digits under one (0.00001235).
 * Trailing zeros are dropped. A positive amount never shows as 0. Not a whole number of wei: '—'.
 */
export function formatWei(wei: string | bigint | null | undefined, decimals = 18): string {
  if (typeof wei !== 'bigint' && !/^-?\d+$/.test(wei ?? '')) return '—';
  const value = BigInt(wei!);
  const negative = value < 0n, abs = negative ? -value : value, unit = 10n ** BigInt(decimals), whole = abs / unit;
  let places: number;
  if (whole >= 1000n) places = 2;
  else if (whole >= 1n) places = 4;
  else {
    // Four significant digits: the leading zeros after the point, plus four.
    const zeros = abs === 0n ? 0 : decimals - abs.toString().length;
    places = Math.min(decimals, zeros + 4);
  }
  places = Math.min(places, decimals);
  const scale = 10n ** BigInt(decimals - places), half = scale / 2n;
  // Half-up at the last shown place.
  const units = scale === 1n ? abs : (abs + half) / scale;
  const shown = 10n ** BigInt(places), int = units / shown;
  const frac = places ? (units % shown).toString().padStart(places, '0').replace(/0+$/, '') : '';
  const text = `${int.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${frac ? `.${frac}` : ''}`;
  return `${negative && units ? '-' : ''}${text}`;
}

/** What an order settled: the native coin and the coin, each paid or received. A buy pays native for the coin; a sell the reverse. */
export interface OrderAmounts {
  native: { wei?: string; text: string | null; dir: 'paid' | 'received' };
  coin: { wei?: string; text: string | null; dir: 'paid' | 'received' };
}
export function orderAmounts(order: Pick<TradeOrder, 'side' | 'filledIn' | 'filledOut'>): OrderAmounts {
  const [nativeWei, coinWei] = order.side === 'buy' ? [order.filledIn, order.filledOut] : [order.filledOut, order.filledIn];
  const text = (wei?: string) => wei === undefined ? null : formatWei(wei);
  return {
    native: { wei: nativeWei, text: text(nativeWei), dir: order.side === 'buy' ? 'paid' : 'received' },
    coin: { wei: coinWei, text: text(coinWei), dir: order.side === 'buy' ? 'received' : 'paid' },
  };
}

/** Orders still waiting for the chain. The page refreshes while any is left, then stops. */
export const hasOpenOrders = (rows: readonly Pick<TradeOrder, 'status'>[]) => rows.some(row => row.status === 'submitted');
export const OPEN_ORDER_REFRESH_MS = 5_000;

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
/** The transaction on this build's chain explorer (Blockscout on Robinhood Chain), or null for a malformed hash. */
export function explorerTxUrl(hash: string | undefined, base = BUILD_NETWORK.explorerUrl): string | null {
  return hash && TX_HASH.test(hash) ? `${base.replace(/\/$/, '')}/tx/${hash}` : null;
}
export const shortHash = (hash: string) => `${hash.slice(0, 6)}…${hash.slice(-4)}`;
export const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

/** Status tone, for the dot beside the status label. */
export const statusTone = (status: TradeOrder['status']): 'ok' | 'live' | 'bad' | 'idle' =>
  status === 'confirmed' ? 'ok' : status === 'submitted' || status === 'awaiting_signature' ? 'live' : status === 'failed' ? 'bad' : 'idle';

/** The order's time in the viewer's zone, short: "Nov 17, 14:32". Invalid: '—'. */
export function formatOrderTime(iso: string, timeZone?: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '—';
  return date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone });
}
