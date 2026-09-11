import type { CoinCard, PreflightRequest } from '@eko/shared';

type Order = PreflightRequest['order'];
export interface Prices {
  /** Cached USD unit price; the lookup must perform no I/O. */
  priceFor(venue: Order['venue'], instrument: string): number | undefined;
}

export function normalizeInstrument(venue: Order['venue'], instrument: string): string {
  // TODO(spec): trim instruments; lowercase chain addresses and uppercase venue tickers.
  const trimmed = instrument.trim();
  return venue === 'rhc' || venue === 'base' ? trimmed.toLowerCase() : trimmed.toUpperCase();
}

export function notionalOf(order: Order, prices: Prices): number | undefined {
  // TODO(spec): prefer explicit notional, then qty × limitPrice, then qty × cached USD price.
  if (order.notionalUsd !== undefined) return order.notionalUsd;
  if (order.qty === undefined) return undefined;
  const price = order.limitPrice ?? prices.priceFor(order.venue, normalizeInstrument(order.venue, order.instrument));
  return price === undefined ? undefined : order.qty * price;
}

export function exitCostAt(card: CoinCard, notional: number | undefined): number {
  // TODO(spec): linear USD interpolation; clamp beyond $100/$10k. Unknown size is handled by missing_notional.
  if (notional === undefined) return NaN;
  const { usd100, usd1k, usd10k } = card.tradeability.exitCostPct;
  if (notional <= 100) return usd100;
  if (notional >= 10_000) return usd10k;
  const [low, high, start, end] = notional <= 1_000
    ? [100, 1_000, usd100, usd1k] : [1_000, 10_000, usd1k, usd10k];
  return start + (end - start) * (notional - low) / (high - low);
}

export function daysUntil(date: string, now: number): number {
  // TODO(spec): signed fractional UTC days, as used by the sketch's <= blackout comparison.
  return (Date.parse(date) - now) / 86_400_000;
}
