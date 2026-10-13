import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { binary } from '@eko/db';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { seedReadFixture, sampleAddress } from './read-fixture.js';
import { GRADE_RULES_SINCE, UNISWAP_GRADES_SINCE } from '../src/read/grade-outcomes.js';

// Synthetic bars and trades only.
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const now = 1_790_986_620_000, minute = (ago: number) => new Date(Math.floor(now / 60000) * 60000 - ago * 60000);
let built: Awaited<ReturnType<typeof buildApp>>, coin: ReturnType<typeof sampleAddress>;
const spark = async () => (await built.ctx.reads.store.rows(coin))[0].row.spark8h!;
const bars = async (minutesAgo: number[], close: (ago: number) => number) => {
  for (const ago of minutesAgo) await built.ctx.dbh.chain.sql.query('INSERT INTO bars_1m VALUES($1,$2,$3,$3,$3,$3,10,1,1,1)', [binary(coin), minute(ago), close(ago)]);
};
beforeAll(async () => {
  built = await buildApp(loadConfig({ NODE_ENV: 'test', PGLITE_DIR: ':memory:', SESSION_SECRET: 'test-only-placeholder'.repeat(2), LEGACY_API: 'false', RUN_WORKER: 'false', MARKET_DATA_SOURCE: 'onchain' }), { startBackground: false });
  built.ctx.reads.store.now = () => now;
  coin = (await seedReadFixture(built.ctx.dbh.chain, now)).identity.address;
  await built.ctx.dbh.chain.ensurePartitions(new Date(now));
});
afterAll(async () => { await built.close(); });
const reset = async () => { await built.ctx.dbh.chain.sql.query('DELETE FROM bars_1m WHERE coin=$1', [binary(coin)]); await built.ctx.dbh.chain.sql.query('DELETE FROM swaps WHERE coin=$1', [binary(coin)]); };

describe('what happened after a grade', () => {
  it('counts a coin graded under the current rules that traded before its grade, and whether its price halved by the horizon', async () => {
    await reset();
    const db = built.ctx.dbh.chain, since = Date.parse(GRADE_RULES_SINCE), at = since + 600_000, later = since + 3 * 3_600_000;
    await db.ensurePartitions(new Date(at));
    await db.sql.query(`UPDATE read_coins SET launchpad='pons' WHERE coin=$1`, [binary(coin)]);
    const block = async (n: number, ms: number) => { await db.sql.query(`INSERT INTO engine_block_times(number,ts,hash,source) VALUES($1,$2,$3,'head') ON CONFLICT DO NOTHING`, [n, new Date(ms), binary(hash(30000 + n))]); };
    await block(20001, since + 1000); await block(20010, at); await block(20020, at + 1_800_000);
    await db.sql.query('INSERT INTO verdicts(id,coin,valid_from_block,rules_version,signature,data) VALUES($1,$2,$3,$4,$1,$5)', ['grade-test-danger', binary(coin), 20010, '1.0.2', JSON.stringify({ level: 'danger' })]);
    const swap = (n: number, ms: number, usd: number) => db.insert('swaps', { ts: new Date(ms), block: n, tx_hash: binary(hash(9700 + n)), log_index: 0, venue: 'pons_curve', pool_id: binary(coin), coin: binary(coin), quote_asset: binary(sampleAddress(0)),
      trader: binary(sampleAddress(74)), tx_from: binary(sampleAddress(74)), tx_to: binary(coin), side: 1, amount_coin: '1000000000000000000', amount_quote: '1', price_quote: 1, usd, priced_block: n });
    // Traded at 10 ten minutes before the grade; 11 right after it (never 20% up); 4 half an hour later.
    await swap(20005, at - 600_000, 10); await swap(20011, at + 60_000, 11); await swap(20020, at + 1_800_000, 4);
    built.ctx.reads.store.now = () => later;
    try {
      const hour = (await built.ctx.reads.grades.read()).rows.find(r => r.level === 'danger' && r.horizonSec === 3600)!;
      expect(hour).toMatchObject({ ratings: 1, down50: 1, down50NeverUp20: 1 });
      // Freshness and an additional same-level price-move record cannot move the first-grade horizon.
      await db.sql.query('UPDATE coin_rating_checks SET checked_at=$2,checked_block=20020 WHERE coin=$1',[binary(coin),new Date(later)]);
      await db.sql.query('INSERT INTO verdicts(id,coin,valid_from_block,rules_version,signature,data) VALUES($1,$2,$3,$4,$1,$5)', ['grade-test-price-move',binary(coin),20020,'1.0.2',JSON.stringify({level:'danger'})]);
      expect((await built.ctx.reads.grades.read()).rows.find(r=>r.level==='danger' && r.horizonSec===3600)).toEqual(hour);
      // A day has not passed since the grade, so the 24-hour horizon has no coin yet.
      expect((await built.ctx.reads.grades.read()).rows.find(r => r.level === 'danger' && r.horizonSec === 86400)!.ratings).toBe(0);
      expect((await built.app.inject('/v1/scoreboard/grades')).json()).toMatchObject({ since: GRADE_RULES_SINCE });
      // The same coin as a Uniswap launch is counted in the other table, from the time its grades began.
      await db.sql.query(`UPDATE read_coins SET launchpad=NULL WHERE coin=$1`, [binary(coin)]);
      const apart = await built.ctx.reads.grades.read();
      expect(apart.rows.find(r => r.level === 'danger' && r.horizonSec === 3600)!.ratings).toBe(0);
      expect(apart.uniswap.since).toBe(UNISWAP_GRADES_SINCE);
      expect(apart.uniswap.rows.find(r => r.level === 'danger' && r.horizonSec === 3600)!.ratings).toBe(Date.parse(UNISWAP_GRADES_SINCE) <= at ? 1 : 0);
    } finally { built.ctx.reads.store.now = () => now; }
  });
});
describe('large trades in the Feed', () => {
  it('lists a trade of $500 or more on a Radar coin with its size, side and wallet, and leaves smaller ones out', async () => {
    await reset();
    const db = built.ctx.dbh.chain, buyer = sampleAddress(71), seller = sampleAddress(72);
    const swap = (n: number, usd: number, side: 1 | -1, trader: string, recipient?: string) => db.insert('swaps', { ts: new Date(now - 600_000 + n * 1000), block: 9500 + n, tx_hash: binary(hash(9500 + n)), log_index: 0, venue: 'pons_curve', pool_id: binary(coin),
      coin: binary(coin), quote_asset: binary(sampleAddress(0)), trader: binary(trader), tx_from: binary(trader), tx_to: binary(coin), ...(recipient ? { recipient: binary(recipient) } : {}), side, amount_coin: '1000000000000000000', amount_quote: '1', price_quote: 1, usd, priced_block: 9500 + n });
    for (const n of [1, 2, 3]) await db.insert('chain_blocks', { number: 9500 + n, block: 9500 + n, hash: binary(hash(19500 + n)), parent_hash: binary(hash(19499 + n)), ts: new Date(now - 600_000 + n * 1000) });
    // A router pays for a buy the buyer receives; the seller sells for itself; a $499 buy is not a Feed row.
    await swap(1, 750, 1, sampleAddress(73), buyer); await swap(2, 1200, -1, seller); await swap(3, 499, 1, buyer);
    const rows = ((await built.app.inject('/v1/feed?kinds=trade')).json() as { rows: { kind: string; coin: string; sizeUsd: number; side: string; wallet: string }[] }).rows;
    expect(rows.map(r => [r.kind, r.sizeUsd, r.side, r.wallet])).toEqual([['trade', 1200, 'sell', seller], ['trade', 750, 'buy', buyer]]);
    expect(rows.every(r => r.coin === coin)).toBe(true);
    // A trade older than the hour the Feed reads is gone.
    built.ctx.reads.store.now = () => now + 3_600_000; expect(((await built.app.inject('/v1/feed?kinds=trade')).json() as { rows: unknown[] }).rows).toHaveLength(0);
    built.ctx.reads.store.now = () => now;
  });
});
describe('the price series on a row', () => {
  it('gives a young coin one point per minute', async () => {
    await reset(); await bars(Array.from({ length: 30 }, (_, i) => 30 - i), (ago) => 100 - ago);
    expect(await spark()).toEqual(Array.from({ length: 30 }, (_, i) => 70 + i));
  });
  it('covers eight hours in about 96 points, oldest first, ending on the latest close', async () => {
    await reset(); await bars(Array.from({ length: 480 }, (_, i) => 479 - i), (ago) => 1000 - ago);
    const points = await spark();
    expect(points.length).toBeGreaterThan(90); expect(points.length).toBeLessThanOrEqual(97);
    expect(points.at(-1)).toBe(1000); expect(points).toEqual([...points].sort((a, b) => a - b));
    // A bar older than eight hours is outside the series.
    await bars([600], () => 5); expect((await spark())[0]).toBeGreaterThan(5);
  });
  it('uses the latest trades when there are only a few minutes of bars', async () => {
    await reset(); await bars([1, 0], (ago) => 3 - ago);
    const db = built.ctx.dbh.chain;
    for (const [n, usd] of [[1, 1], [2, 2], [3, 4], [4, 3]] as const) await db.insert('swaps', { ts: new Date(now - 120_000 + n * 1000), block: 9000 + n, tx_hash: binary(hash(9200 + n)), log_index: 0, venue: 'pons_curve', pool_id: binary(coin),
      coin: binary(coin), quote_asset: binary(sampleAddress(0)), trader: binary(sampleAddress(70)), tx_from: binary(sampleAddress(70)), tx_to: binary(coin), side: 1, amount_coin: '1000000000000000000', amount_quote: '1', price_quote: 1, usd, priced_block: 9000 + n });
    expect(await spark()).toEqual([1, 2, 4, 3]);
  });
});
