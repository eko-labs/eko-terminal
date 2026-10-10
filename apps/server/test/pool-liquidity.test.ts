import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { binary } from '@eko/db';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { curveState, poolValueUsd, readCurveStates, readPoolLiquidity } from '../src/read/pool-liquidity.js';
import { seedReadFixture, sampleAddress } from './read-fixture.js';

// Synthetic rows only: a full-range position and one priced trade, never a live chain reading.
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const pool = `0x${'ab'.repeat(32)}`;
const now = 1_790_986_600_000;
let built: Awaited<ReturnType<typeof buildApp>>, coin: ReturnType<typeof sampleAddress>;
beforeAll(async () => {
  built = await buildApp(loadConfig({ NODE_ENV: 'test', PGLITE_DIR: ':memory:', SESSION_SECRET: 'test-only-placeholder'.repeat(2), LEGACY_API: 'false', RUN_WORKER: 'false', MARKET_DATA_SOURCE: 'onchain' }), { startBackground: false });
  built.ctx.reads.store.now = () => now;
  coin = (await seedReadFixture(built.ctx.dbh.chain, now)).identity.address;
  await built.ctx.dbh.chain.ensurePartitions(new Date(now));
});
afterAll(async () => { await built.close(); });

describe('where a launch curve stands', () => {
  // Graduation reserve 10 quote units, supply 1,000 coins: a virtual quote reserve of 4, so the starting price is 0.004.
  it('reads no progress at the starting price and the whole reserve at graduation', () => {
    expect(curveState(10, 1000, 1000, 4, 8)).toEqual({ curvePct: 0, usd: 0 });
    // With s of supply bought the reserve is 4 x s/(1-s): half the supply bought puts 4 in the curve, 40% of the way.
    const half = curveState(10, 1000, 100, 1.6, 3.2)!;
    expect(half.curvePct).toBeCloseTo(40, 6); expect(half.usd).toBeCloseTo(8, 6);
    // Past graduation the reserve stops at the graduation reserve.
    expect(curveState(10, 1000, 1, 10, 20)!.curvePct).toBe(100);
    for (const bad of [[0, 1000, 1, 1, 1], [10, 0, 1, 1, 1], [10, 1000, 0, 1, 1], [10, 1000, 1, 0, 1], [10, 1000, 1, 1, 0]]) expect(curveState(bad[0], bad[1], bad[2], bad[3], bad[4])).toBeNull();
  });
});
describe('pool liquidity of a graduated coin', () => {
  it('values both sides of a full-range position at the price of a trade', () => {
    // Liquidity 1e12 at a price of 4 quote units per coin unit: reserves 2e12 quote and 5e11 coin. A trade of 100 coin
    // units for 400 quote units worth $0.0004 prices a quote unit at $0.000001, so each side is worth $2,000,000.
    expect(poolValueUsd(1e12, 100, 400, 0.0004)).toBeCloseTo(4_000_000, 3);
    expect(poolValueUsd(0, 100, 400, 0.0004)).toBe(0);
    for (const [coinAmount, quoteAmount, usd] of [[0, 400, 1], [100, 0, 1], [100, 400, 0]]) expect(poolValueUsd(1e12, coinAmount, quoteAmount, usd)).toBeNull();
  });
  it('reads the position and the pool\'s latest priced trade, and nothing before graduation or before a trade', async () => {
    const db = built.ctx.dbh.chain;
    expect((await readPoolLiquidity(db, [coin])).size).toBe(0);
    // Before graduation the same coin is read as a curve: its launch record's graduation reserve and its latest trade.
    await db.sql.query(`UPDATE tokens SET launchpad='pons',total_supply=1000,graduated_block=NULL,graduated_pool=NULL WHERE address=$1`, [binary(coin)]);
    await db.sql.query('DELETE FROM swaps WHERE coin=$1', [binary(coin)]);
    expect((await readCurveStates(db, [coin])).size).toBe(0);
    await db.insert('pons_events', { block: '40', tx_hash: binary(hash(9400)), log_index: 0, emitter: binary(sampleAddress(63)), token: binary(coin), kind: 'launch', data: JSON.stringify({ kind: 'launch', graduationThreshold: '10' }) });
    await db.insert('swaps', { ts: new Date(now - 3_700_000), block: 41, tx_hash: binary(hash(9401)), log_index: 0, venue: 'pons_curve', pool_id: binary(coin), coin: binary(coin), quote_asset: binary(sampleAddress(0)),
      trader: binary(sampleAddress(61)), tx_from: binary(sampleAddress(61)), tx_to: binary(coin), side: 1, amount_coin: '1000', amount_quote: '16', price_quote: 0.016, usd: 32, priced_block: 41 });
    const curve = (await readCurveStates(db, [coin])).get(coin)!;
    expect(curve.curvePct).toBeCloseTo(40, 6); expect(curve.usd).toBeCloseTo(8, 6);
    await db.sql.query('UPDATE tokens SET graduated_pool=$2,graduated_block=50 WHERE address=$1', [binary(coin), binary(pool)]);
    expect((await readCurveStates(db, [coin])).size).toBe(0);
    const position = (n: number, delta: string, lower = -887200, upper = 887200) => db.insert('liquidity_events', { block: String(n), ts: new Date(now - 3_600_000 + n * 1000), tx_hash: binary(hash(9000 + n)), log_index: 0,
      venue: 'uniswap_v4', pool_id: binary(pool), kind: 'ModifyLiquidity', actor: binary(sampleAddress(60)), data: JSON.stringify({ id: pool, tickLower: lower, tickUpper: upper, liquidityDelta: delta }) });
    await position(50, '1000000000000');
    // A position on record but no trade on the pool yet: not known.
    expect((await readPoolLiquidity(db, [coin])).size).toBe(0);
    const trade = (n: number, usd: number | null) => db.insert('swaps', { ts: new Date(now - 3_600_000 + n * 1000), block: n, tx_hash: binary(hash(9100 + n)), log_index: 0, venue: 'uniswap_v4', pool_id: binary(pool),
      coin: binary(coin), quote_asset: binary(sampleAddress(0)), trader: binary(sampleAddress(61)), tx_from: binary(sampleAddress(61)), tx_to: binary(sampleAddress(62)), side: 1, amount_coin: '100', amount_quote: '400', price_quote: 4, usd, priced_block: n });
    await trade(60, 0.0004); await trade(61, null);
    expect((await readPoolLiquidity(db, [coin])).get(coin)).toBeCloseTo(4_000_000, 3);
    // A narrower position is not counted; a withdrawal of half the full-range one is.
    await position(62, '5000000000000', -1000, 1000); await position(63, '-500000000000');
    expect((await readPoolLiquidity(db, [coin])).get(coin)).toBeCloseTo(2_000_000, 3);
  });
});

describe('money in the pools of a coin that launched on Uniswap', () => {
  it('counts the quote side of each position at the pool price: nothing above the price, everything below', async () => {
    const { positionQuote } = await import('../src/read/pool-liquidity.js');
    // Ticks -6932 and 6932 are prices of about 0.5 and 2 (token1 per token0); `low` is the square root of the lower one.
    // At a price of 1, token1 as the quote: L x (1 - sqrt(0.5)); token0 as the quote: L x (1 - 1/sqrt(2)), the same.
    const low = 1.0001 ** (-6932 / 2);
    expect(positionQuote(1e6, -6932, 6932, 1, true)).toBeCloseTo(1e6 * (1 - low), 3);
    expect(positionQuote(1e6, -6932, 6932, 1, false)).toBeCloseTo(1e6 * (1 - low), 3);
    expect(1 - low).toBeCloseTo(1 - Math.SQRT1_2, 4);
    // A launch's coins placed above the price hold no quote currency until they are bought; a position wholly below the price is all quote.
    expect(positionQuote(1e6, 6932, 13864, 1, true)).toBe(0);
    expect(positionQuote(1e6, -13864, -6932, 1, true)).toBeCloseTo(1e6 * (low - low * low), 3);
    expect(positionQuote(0, -10, 10, 1, true)).toBe(0); expect(positionQuote(1e6, 10, -10, 1, true)).toBe(0);
  });
  it('sums a coin\'s pools from indexed events and its latest priced trades, and skips coins with a curve', async () => {
    const { readPoolMoney } = await import('../src/read/pool-liquidity.js');
    const db = built.ctx.dbh.chain, other = sampleAddress(0x77), quote = sampleAddress(0), poolId = `0x${'cd'.repeat(32)}`;
    await db.insert('tokens', { address: binary(other), name: 'Sample token', symbol: 'DEMO', decimals: 0, first_block: '10', block: '10' });
    // The coin sorts after the native currency: token0 is the quote. One position around the price, one above it in coin terms.
    await db.insert('pools', { id: binary(poolId), venue: 'uniswap_v4', currency0: binary(quote), currency1: binary(other), fee: 3000, tick_spacing: 60, created_block: '10', block: '10' });
    const event = (n: number, data: Record<string, string | number>) => db.insert('liquidity_events', { block: '10', tx_hash: binary(hash(0x900 + n)), log_index: n, ts: new Date(now - 60_000), venue: 'uniswap_v4', pool_id: binary(poolId),
      kind: 'ModifyLiquidity', actor: null, senders_pending: false, data: JSON.stringify(data) });
    await event(1, { liquidityDelta: '3000000', tickLower: -6932, tickUpper: 6932 });
    await event(2, { liquidityDelta: '-1000000', tickLower: -6932, tickUpper: 6932 });
    // A trade of 100 coin units for 100 quote units worth $200: the price is 1 and a quote unit is worth $2.
    await db.insert('swaps', { ts: new Date(now - 30_000), block: '11', tx_hash: binary(hash(0x950)), log_index: 0, venue: 'uniswap_v4', pool_id: binary(poolId), coin: binary(other), quote_asset: binary(quote),
      trader: null, tx_from: null, tx_to: null, side: 1, amount_coin: '100', amount_quote: '100', price_quote: 1, usd: 200, priced_block: '11' });
    const money = await readPoolMoney(db, [other, coin], now);
    // Net liquidity 2,000,000 around a price of 1: 2e6 x (1 - sqrt(0.5)) quote units, about 585,800, worth $2 each.
    expect(money.get(other)).toBeCloseTo(2e6 * (1 - 1.0001 ** (-6932 / 2)) * 2, 2);
    expect(money.get(other)! / 1e6).toBeCloseTo(1.1716, 3);
    // The fixture's own coin has a Pons curve: its figure comes from the curve, not from here.
    expect(money.has(coin)).toBe(false);
    // All of it taken out (a pull). Positions are used as read for a minute; two minutes on, a request still gets the
    // figure on hand at once and the pool is read again behind it, so the next one says $0.
    await event(3, { liquidityDelta: '-2000000', tickLower: -6932, tickUpper: 6932 });
    expect((await readPoolMoney(db, [other], now + 30_000)).get(other)! / 1e6).toBeCloseTo(1.1716, 3);
    expect((await readPoolMoney(db, [other], now + 120_000)).get(other)! / 1e6).toBeCloseTo(1.1716, 3);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect((await readPoolMoney(db, [other], now + 121_000)).get(other)).toBe(0);
    // Positions more than three minutes old are read before answering.
    await event(4, { liquidityDelta: '1000000', tickLower: -6932, tickUpper: 6932 });
    expect((await readPoolMoney(db, [other], now + 400_000)).get(other)! / 1e6).toBeCloseTo(1.1716 / 2, 3);
  });
});
