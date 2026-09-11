import { describe, expect, it, vi } from 'vitest';
import { daysUntil, exitCostAt, normalizeInstrument, notionalOf } from '../src/index.js';
import { ASSET, card, deps, NOW, request } from './fixtures.js';

describe('sketch helpers', () => {
  it.each([
    ['rhc', ` ${ASSET.toUpperCase()} `, ASSET], ['base', ASSET.toUpperCase(), ASSET],
    ['robinhood', ' nvda ', 'NVDA'], ['perp', ' eth-usd ', 'ETH-USD'],
  ] as const)('normalizes %s instruments', (venue, instrument, expected) => {
    expect(normalizeInstrument(venue, instrument)).toBe(expected);
  });
  it('uses explicit notional, limit price, then cached price, without unnecessary lookups', () => {
    const priceFor = vi.fn(() => 20);
    expect(notionalOf({ ...request.order, qty: 10, limitPrice: 5 }, { priceFor })).toBe(100);
    const qty = { ...request.order, notionalUsd: undefined, qty: 10, instrument: ASSET.toUpperCase() };
    expect(notionalOf({ ...qty, limitPrice: 5 }, { priceFor })).toBe(50);
    expect(priceFor).not.toHaveBeenCalled();
    expect(notionalOf(qty, { priceFor })).toBe(200);
    expect(priceFor).toHaveBeenCalledExactlyOnceWith('rhc', ASSET);
    expect(notionalOf(qty, deps)).toBeUndefined();
    expect(notionalOf({ ...qty, qty: undefined }, { priceFor })).toBeUndefined();
  });
  it.each([[0, 1], [100, 1], [550, 2], [1_000, 3], [5_500, 9], [10_000, 15], [20_000, 15]])(
    'interpolates/clamps exit cost at $%s', (size, expected) => expect(exitCostAt(card, size)).toBe(expected));
  it('leaves unknown size to missing_notional', () => expect(exitCostAt(card, undefined)).toBeNaN());
  it('computes signed fractional UTC days', () => {
    expect(daysUntil('2026-10-02', NOW)).toBe(0.5);
    expect(daysUntil('2026-09-30', NOW)).toBe(-1.5);
    expect(daysUntil('2026-10-02T12:00:00+00:00', NOW)).toBe(1);
  });
});
