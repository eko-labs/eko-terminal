import { describe, expect, it } from 'vitest';
import { zeroAddress } from 'viem';
import { DEFAULT_OPEN_MCAP_HYPE, graduationBps, HALF_WAY_BPS, openPriceAt } from '../src/graduation.js';
import { pairColumn } from '../src/views.js';
import type { CoinState } from '../src/tracker.js';

const OPEN = 4.2272e-8;
const coin = (over: Partial<CoinState>, price?: number): CoinState => ({
  launchpad: 'montra', quote: zeroAddress, supply: 10n ** 27n, graduated: false, ts: 0, openPrice: OPEN,
  trades: price === undefined ? [] : [{ ts: 1, block: 1, tx: '0x01', sender: zeroAddress, side: 'buy', hype: 1, tokens: 1, priceHype: price }],
  ...over,
} as CoinState);
const ctx = { nowSec: 10_000, head: 1, hypeUsd: 70 };

describe('graduation', () => {
  it("matches Montra's own progress figures", () => {
    // Montra's API on 2026-11-12: 7,211 and 6,059 basis points at these prices.
    expect(graduationBps(coin({}, 4.4167e-7))).toBeGreaterThanOrEqual(7190);
    expect(graduationBps(coin({}, 4.4167e-7))).toBeLessThanOrEqual(7230);
    expect(Math.abs(graduationBps(coin({}, 3.4962e-7))! - 6059)).toBeLessThan(20);
    expect(graduationBps(coin({}))).toBe(0);
    expect(graduationBps(coin({}, OPEN * 100))).toBe(10_000);
  });
  it('reads the opening price from the start tick', () => {
    const tick = Math.round(-Math.log(OPEN) / Math.log(1.0001));
    expect(openPriceAt(tick, true) / OPEN).toBeCloseTo(1, 3);
  });
  it('cannot measure a Montra coin without its opening price or with another quote', () => {
    expect(graduationBps(coin({ openPrice: undefined }, 1e-7))).toBeNull();
    expect(graduationBps(coin({ quote: '0x0000000000000000000000000000000000000001' }, 1e-7))).toBeNull();
  });
  it('measures other launchpads against the same line in market cap', () => {
    const montra = graduationBps(coin({}, 3.4962e-7))!;
    // Same supply and price, so the same market cap: the same progress.
    expect(graduationBps(coin({ launchpad: 'flaunch', openPrice: undefined }, 3.4962e-7), DEFAULT_OPEN_MCAP_HYPE)).toBeCloseTo(montra, -1);
  });
  it('sorts coins into the three columns', () => {
    expect(pairColumn(coin({}, OPEN * 2), ctx)).toBe('new');
    expect(pairColumn(coin({}, OPEN * 8), ctx)).toBe('near_grad');
    expect(graduationBps(coin({}, OPEN * 8))!).toBeGreaterThanOrEqual(HALF_WAY_BPS);
    expect(pairColumn(coin({ graduated: true }, OPEN * 2), ctx)).toBe('migrated');
    // Age alone no longer moves a coin out of New.
    expect(pairColumn(coin({ ts: -100_000 }, OPEN * 2), ctx)).toBe('new');
  });
});

describe('price before the first trade', () => {
  it("shows a Montra coin's opening market cap", async () => {
    const { coinSummary } = await import('../src/views.js');
    const row = coinSummary({ ...coin({}), token: zeroAddress, creator: zeroAddress, trades: [], flows: [], netHype: 0, name: 'x', symbol: 'x' } as CoinState, undefined, ctx);
    expect(row.marketCapUsd).toBeCloseTo(DEFAULT_OPEN_MCAP_HYPE * 70, 0);
  });
});
