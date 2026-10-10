import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { binary, ChainDb, migrate, migrateEngines, pruneSwaps, type SqlClient } from '@eko/db';
import { openDb } from '../../../packages/db/test/helpers/historical-db.js';
import { CoinsService } from '../src/read/coins.js';
import { FEED_SHARED_TTL_MS, FeedService } from '../src/read/feed.js';
import { GuardReadStore } from '../src/read/guard-store.js';
import { PairsService } from '../src/read/pairs.js';
import { ScanService } from '../src/read/scan.js';
import { ReadStore, REFRESH_BATCH, REFRESH_REST_MS } from '../src/read/store.js';

// Read-model refreshes must leave unchanged projection rows alone (no new row versions) and produce exactly the rows
// the 0114 refresh produced. The 0114 function is loaded from its migration file and run side by side.
const now = Date.parse('2026-10-07T12:00:00Z'), window = Math.floor(now / 60000) * 60;
const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as `0x${string}`;
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as `0x${string}`;
const coinA = address(0xa1), coinB = address(0xb1), coinC = address(0xc1), coinD = address(0xd1);
const curveA = address(0xca), weth = address(0xee), deployer = address(0xde);
const poolA = address(0xa9), poolB1 = address(0xb8), poolB2 = address(0xb9);
const traders = [address(0x11), address(0x12), address(0x13), address(0x14)];
const at = (n: number) => new Date(now - (40 - n) * 60_000);
const handles: ChainDb[] = [];
afterEach(async () => { await Promise.all(handles.splice(0).map(db => db.close())); });

let log = 0;
async function swap(db: ChainDb, n: number, coin: `0x${string}`, pool: `0x${string}`, trader: `0x${string}` | null, side: 1 | -1, extra: Record<string, unknown> = {}) {
  await db.insertMany('swaps', [{ ts: at(n), block: String(n), tx_hash: binary(hash(1000 + ++log)), log_index: 0, venue: pool === poolA ? 'pons_curve' : 'uniswap_v3',
    pool_id: binary(pool), coin: binary(coin), quote_asset: binary(weth), trader: trader ? binary(trader) : null, tx_from: trader ? binary(trader) : null, tx_to: null,
    senders_pending: trader == null, pricing_pending: false, side, amount_coin: '1000', amount_quote: '10', price_quote: 0.01, usd: 20, priced_block: String(n), ...extra }]);
}
async function card(db: ChainDb, coin: `0x${string}`, n: number, level: string, curvePct?: number) {
  const data = { verdict: { level }, identity: { createdAt: at(1).toISOString(), ...(curvePct == null ? {} : { curvePct }) } };
  await db.sql.query('INSERT INTO coin_cards VALUES($1,$2,$3,$4,$5,$6)', [`card:${coin}:${n}`, binary(coin), n, `sample-hash-${n}`, JSON.stringify(data), '1.0.0']);
  await db.sql.query(`INSERT INTO coin_card_latest VALUES($1,$2,$3,$4) ON CONFLICT(coin) DO UPDATE SET card_id=excluded.card_id,as_of_block=excluded.as_of_block,data=excluded.data`,
    [binary(coin), `card:${coin}:${n}`, n, JSON.stringify(data)]);
}
async function fixture() {
  const db = await openDb({ pgliteDir: ':memory:' }); handles.push(db);
  await migrate(db); await migrateEngines(db); await db.ensurePartitions(new Date(now));
  for (let n = 1; n <= 40; n++) await db.insert('chain_blocks', { number: String(n), block: String(n), hash: binary(hash(n)), parent_hash: binary(hash(n - 1)), ts: at(n) });
  const token = (coin: `0x${string}`, n: number, extra: Record<string, unknown>) => db.insert('tokens', { address: binary(coin), deployer: binary(deployer), name: 'Sample token',
    symbol: 'DEMO', decimals: 18, total_supply: '1000000', supply_block: String(n), first_block: String(n), block: String(n), launchpad: null, curve: null, ...extra });
  await token(coinA, 1, { launchpad: 'pons', curve: binary(curveA) });
  await token(coinB, 2, {});
  await token(coinC, 3, { launchpad: 'pons', curve: binary(address(0xcc)) });
  await token(coinD, 4, { deployer: null });
  for (const [pool, coin, n] of [[poolB1, coinB, 3], [poolB2, coinB, 5], [address(0xd9), coinD, 4]] as const)
    await db.insert('pools', { id: binary(pool), venue: 'uniswap_v3', currency0: binary(coin), currency1: binary(weth), fee: 3000, tick_spacing: 60, created_block: String(n), block: String(n), creation_verified: true });
  await swap(db, 2, coinA, poolA, traders[0]!, 1); await swap(db, 3, coinA, poolA, traders[1]!, 1); await swap(db, 4, coinA, poolA, traders[0]!, -1);
  await swap(db, 5, coinA, poolA, null, 1);
  await swap(db, 6, coinB, poolB1, traders[2]!, 1); await swap(db, 7, coinB, poolB1, traders[2]!, 1, { pricing_pending: true, usd: null });
  await swap(db, 8, coinD, address(0xd9), traders[3]!, 1);
  for (const [coin, minute, volume] of [[coinA, 3, 100], [coinB, 6, 50], [coinB, 39, 25]] as const)
    await db.sql.query('INSERT INTO bars_1m VALUES($1,$2,1,1,1,1,$3,1,$4,$4)', [binary(coin), new Date(Math.floor(at(minute).getTime() / 60000) * 60000), volume, minute]);
  await card(db, coinA, 10, 'danger', 80); await card(db, coinB, 10, 'monitor');
  await db.sql.query('INSERT INTO verdicts VALUES($1,$2,$3,$4,$5,$6)', ['sample-verdict-a', binary(coinA), '9', '1.0.0', 'sample-signature', JSON.stringify({ level: 'danger' })]);
  await db.sql.query('INSERT INTO verdict_events VALUES($1,$2,$3,$4,$5)', ['sample-verdict-a:created', 'sample-verdict-a', 'created', '9', '{}']);
  await db.sql.query('INSERT INTO playbook_matches VALUES($1,$2,$3,$4,$5)', [binary(coinA), '9', '1.0.0', 'deployer_dump', JSON.stringify({ id: 'deployer_dump', level: 'danger' })]);
  // The 0114 refresh, renamed, as the reference implementation.
  const legacy = (await readFile(new URL('../../../packages/db/drizzle/0114_batched_read_models.sql', import.meta.url), 'utf8'))
    .split('-- statement-breakpoint').find(s => s.includes('CREATE FUNCTION refresh_read_models'))!;
  await db.sql.query(legacy.replace('CREATE FUNCTION refresh_read_models', 'CREATE FUNCTION refresh_read_models_0114'));
  return db;
}
const coins = [coinA, coinB, coinC, coinD].map(binary);
const tables = ['read_coins', 'read_buyers', 'read_feed', 'read_first_verdict'] as const;
const order = { read_coins: 'coin', read_buyers: 'coin,trader', read_feed: 'id', read_first_verdict: 'coin' };
/**
 * Every projection row, by value, of the coins that can be listed. coinD has no launch wallet: the 0114 refresh still
 * wrote its buyers and pool rows, the current one leaves a token that can never be listed alone (0193), so its rows
 * are compared separately (`unlisted`).
 */
async function rows(db: ChainDb, unlisted = false) {
  const result: Record<string, unknown[]> = {};
  for (const table of tables) result[table] = (await db.sql.query(`SELECT * FROM ${table} ORDER BY ${order[table]}`)).rows
    .map(row => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v instanceof Date ? v.toISOString() : v])))
    .filter(row => ((row as { coin?: string }).coin === coinD.slice(2)) === unlisted);
  return result;
}
/** Every projection row version: a rewritten or reinserted row gets a new xmin and ctid. */
async function versions(db: ChainDb) {
  const result: Record<string, string[]> = {};
  for (const table of tables) result[table] = (await db.sql.query<{ v: string }>(`SELECT xmin::text||'@'||ctid::text AS v FROM ${table} ORDER BY ${order[table]}`)).rows.map(r => r.v);
  return result;
}
const refresh = (db: ChainDb, fn = 'refresh_read_models') => db.tx(async tx => { await tx.sql.query(`SELECT ${fn}($1::bytea[],$2::bigint)`, [coins, window]); });

describe('read-model refresh churn', () => {
  it('writes nothing when no source changed', async () => {
    const db = await fixture(), store = new ReadStore(db, () => now);
    await store.refreshModels();
    const before = await versions(db), values = await rows(db);
    expect(values.read_buyers).toHaveLength(3);
    // A token without a launch wallet is never listed, so the refresh does not read it: no buyer, no pool row.
    expect(Object.values(await rows(db, true)).flat()).toEqual([]);
    expect(values.read_feed.map(r => (r as { id: string }).id)).toEqual(expect.arrayContaining([`pool:${poolB1.slice(2)}:${coinB.slice(2)}`, `token:${coinA.slice(2)}`]));
    // Every coin is queued again with no source change: no projection row gets a new version.
    await db.sql.query('INSERT INTO read_dirty(coin) SELECT unnest($1::bytea[]) ON CONFLICT(coin) DO UPDATE SET revision=excluded.revision', [coins]);
    await store.refreshModels();
    await refresh(db);
    expect(await versions(db)).toEqual(before);
    expect(await rows(db)).toEqual(values);
    // Rank refreshes write only coins whose volume changed.
    await db.sql.query('UPDATE read_rank_clock SET window_sec=0'); await store.refreshRanks();
    const ranked = await versions(db);
    await db.sql.query('UPDATE read_rank_clock SET window_sec=0'); await store.refreshRanks();
    expect(await versions(db)).toEqual(ranked);
    // The 0114 refresh rewrote every row of the same coins, which is the churn this removes.
    await refresh(db, 'refresh_read_models_0114');
    const legacy = await versions(db);
    expect(legacy.read_buyers.some((v, i) => v !== ranked.read_buyers[i])).toBe(true);
    expect(legacy.read_feed.filter((v, i) => v !== ranked.read_feed[i]).length).toBe(legacy.read_feed.length);
    expect(await rows(db)).toEqual(values);
  });

  it('produces the same rows as the 0114 refresh after every kind of source change', async () => {
    const db = await fixture(), store = new ReadStore(db, () => now);
    const same = async () => { await store.refreshModels(); await refresh(db); const fresh = await rows(db); await refresh(db, 'refresh_read_models_0114'); expect(fresh).toEqual(await rows(db)); return fresh; };
    const first = await same();
    expect(first.read_coins).toHaveLength(3);
    // New buyers, repeat buys and a reorg that removes a buyer.
    await swap(db, 30, coinA, poolA, traders[3]!, 1); await swap(db, 31, coinA, poolA, traders[0]!, 1);
    expect((await same()).read_buyers).toHaveLength(4);
    await db.sql.query('DELETE FROM swaps WHERE coin=$1 AND trader=$2', [binary(coinA), binary(traders[1]!)]);
    expect((await same()).read_buyers).toHaveLength(3);
    // Sender enrichment fills a pending buyer; pricing enrichment clears the pending price.
    await db.sql.query('UPDATE swaps SET trader=$1,tx_from=$1,senders_pending=false WHERE trader IS NULL', [binary(traders[2]!)]);
    await db.sql.query('UPDATE swaps SET pricing_pending=false,usd=20 WHERE pricing_pending');
    expect((await same()).read_coins.every(r => !(r as { buyers_pending: boolean }).buyers_pending)).toBe(true);
    // Identity changes: a new symbol, a graduation, a moved and a removed pool.
    await db.sql.query("UPDATE tokens SET symbol='DEMO2' WHERE address=$1", [binary(coinB)]);
    await db.sql.query('UPDATE tokens SET graduated_block=32,graduated_pool=$2 WHERE address=$1', [binary(coinA), binary(poolB1)]);
    await db.sql.query('UPDATE pools SET created_block=4 WHERE id=$1', [binary(poolB1)]);
    await db.sql.query('DELETE FROM pools WHERE id=$1', [binary(poolB2)]);
    const changed = await same();
    expect(changed.read_feed.map(r => (r as { id: string }).id)).toContain(`graduation:${coinA.slice(2)}:32`);
    expect(changed.read_feed.map(r => (r as { id: string }).id)).not.toContain(`pool:${poolB2.slice(2)}:${coinB.slice(2)}`);
    // Card changes move the tier; a deleted token drops every projection row.
    await card(db, coinB, 33, 'clear'); await card(db, coinC, 33, 'monitor');
    await db.sql.query('DELETE FROM tokens WHERE address=$1', [binary(coinD)]);
    // (The 0114 reference run above wrote coinD's buyer and pool rows; with the token gone the current refresh drops them.)
    expect(Object.values(await rows(db, true)).flat().length).toBeGreaterThan(0);
    const last = await same();
    await refresh(db);
    expect(Object.values(await rows(db, true)).flat()).toEqual([]);
    expect(last.read_coins.map(r => (r as { tier: number }).tier)).toEqual([3, 0, 1]);
  });

  it('keeps the buyers, last trade and trade range of a coin whose swaps retention deleted', async () => {
    const db = await fixture(), store = new ReadStore(db, () => now), coinsService = new CoinsService(store);
    await store.refreshModels();
    const summary = async () => (await db.sql.query('SELECT buyers::text,activity FROM read_coins WHERE coin=$1', [binary(coinA)])).rows[0];
    const range = async () => { const c = await coinsService.candles(coinA, '1m', Math.floor(now / 1000) - 3600, Math.floor(now / 1000)); return [c.firstTradeTs, c.lastTradeTs]; };
    const before = await summary(), traded = await range(), buyers = (await rows(db)).read_buyers;
    expect(before).toMatchObject({ buyers: '2' });
    // What retention records before deleting a quiet coin's swaps (packages/db/src/retention.ts), then the deletion.
    await db.sql.query(`INSERT INTO history_prunes(coin,rule,through_block,swaps_through_block,first_trade_ts,last_trade_ts,buyers)
      SELECT $1,'quiet_coin',40,40,min(ts),max(ts),2 FROM swaps WHERE coin=$1`, [binary(coinA)]);
    while (await pruneSwaps(db, binary(coinA), 40n, 100) > 0);
    expect((await db.sql.query('SELECT 1 FROM swaps WHERE coin=$1', [binary(coinA)])).rows).toHaveLength(0);
    await store.refreshModels();
    expect(await summary()).toEqual(before);
    expect(await range()).toEqual(traded);
    expect((await rows(db)).read_buyers).toEqual(buyers);
  });
  it('adds the buyers of new swaps without rebuilding the coin, and rebuilds when its history is rewritten', async () => {
    // 2026-10-13: every refresh rebuilt a coin's buyers from all of its swaps (0.86 s for a 71,000-swap coin on a copy).
    const db = await fixture(), store = new ReadStore(db, () => now);
    const state = async () => {
      const coin = (await db.sql.query<{ buyers: string; buyers_block: string | null }>('SELECT buyers,buyers_block FROM read_coins WHERE coin=$1', [binary(coinB)])).rows[0]!;
      const pairs = (await db.sql.query<{ n: string }>('SELECT count(*) AS n FROM read_buyers WHERE coin=$1', [binary(coinB)])).rows[0]!.n;
      return { buyers: Number(coin.buyers), through: Number(coin.buyers_block), pairs: Number(pairs) };
    };
    const rebuild = async () => (await db.sql.query<{ rebuild: boolean }>('SELECT rebuild FROM read_dirty WHERE coin=$1', [binary(coinB)])).rows[0]?.rebuild;
    await store.refreshModels();
    expect(await state()).toEqual({ buyers: 1, through: 7, pairs: 1 });
    // A new buyer far above the block counted through: added on its own.
    await swap(db, 5000, coinB, poolB1, traders[0]!, 1);
    expect(await rebuild()).toBe(false);
    await store.refreshModels();
    expect(await state()).toEqual({ buyers: 2, through: 5000, pairs: 2 });
    // Proof that only the new swaps were read: a pair removed by hand is not put back by the next new swap...
    await db.sql.query('DELETE FROM read_buyers WHERE coin=$1 AND trader=$2', [binary(coinB), binary(traders[2]!)]);
    await swap(db, 5001, coinB, poolB1, traders[0]!, -1);
    expect(await rebuild()).toBe(false);
    await store.refreshModels();
    expect(await state()).toEqual({ buyers: 1, through: 5001, pairs: 1 });
    // ...and is put back as soon as the coin's history is rewritten: here an old swap gets its trader (onboarding does this).
    await db.sql.query('UPDATE swaps SET trader=$2,senders_pending=false WHERE coin=$1 AND block=6', [binary(coinB), binary(traders[1]!)]);
    expect(await rebuild()).toBe(true);
    await store.refreshModels();
    expect(await state()).toEqual({ buyers: 3, through: 5001, pairs: 3 });
    // A swap stored below the block counted through (a pool's old events turned into rows) also rebuilds.
    await swap(db, 100, coinB, poolB1, traders[3]!, 1);
    expect(await rebuild()).toBe(true);
    await store.refreshModels();
    expect(await state()).toEqual({ buyers: 4, through: 5001, pairs: 4 });
    // A deleted swap (a reorganisation) takes its buyer with it and moves the block counted through back.
    await db.sql.query('DELETE FROM swaps WHERE coin=$1 AND block>=5000', [binary(coinB)]);
    expect(await rebuild()).toBe(true);
    await store.refreshModels();
    expect(await state()).toEqual({ buyers: 3, through: 100, pairs: 3 });
  });
  it('leaves a coin it has just refreshed for a few seconds in the background, without losing its newer change', async () => {
    // 2026-10-13: a coin that trades in every block was refreshed on every 250 ms pass, its whole history read each time.
    let clock = now;
    const db = await fixture(), store = new ReadStore(db, () => clock);
    const marked = async () => (await db.sql.query('SELECT 1 FROM read_dirty WHERE coin=$1', [binary(coinB)])).rows.length;
    const buyers = async () => Number((await db.sql.query<{ buyers: string }>('SELECT buyers FROM read_coins WHERE coin=$1', [binary(coinB)])).rows[0]!.buyers);
    const settle = () => new Promise(resolve => setTimeout(resolve, 700));
    store.start();
    try {
      await settle();
      expect([await marked(), await buyers()]).toEqual([0, 1]);
      // A new buyer right after the refresh: the coin stays marked and the projection waits.
      await swap(db, 9, coinB, poolB1, traders[0]!, 1);
      await settle();
      expect([await marked(), await buyers()]).toEqual([1, 1]);
      clock += REFRESH_REST_MS;
      await settle();
      expect([await marked(), await buyers()]).toEqual([0, 2]);
    } finally { await store.close(); }
  });
  it('serves requests from the current projection while the background refresher works', async () => {
    const db = await fixture(), store = new ReadStore(db, () => now);
    await store.refreshModels();
    store.start();
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    try {
      // A refresh that has not finished must not hold up a request (production saw 40+ s waits on 2026-10-09).
      store.refreshModels = () => blocked;
      // Settling at all (the fixture's minimal cards fail the row schema) proves the request did not wait on the refresh.
      const within = <T>(work: Promise<T>) => Promise.race([work.then(() => 'done', () => 'done'), new Promise<string>(r => setTimeout(() => r('timeout'), 2000))]);
      expect(await within(store.rows(undefined, [coinA]))).toBe('done');
      expect(await within(store.refreshRanks())).toBe('done');
      // New pairs, the feed, scans and Guard lists waited on it too.
      const guard = new GuardReadStore(store);
      const reads: Promise<unknown>[] = [new PairsService(store).list('new'), new FeedService(store).all(), new ScanService(store).scan(coinA), guard.list(), guard.totals()];
      for (const read of reads)
        expect(await within(read)).toBe('done');
      // A rank refresh in progress must not hold up a request either: the background timer owns it.
      store.refreshRanks = () => blocked;
      expect(await within(store.currentRanks())).toBe('done');
    } finally { release(); await store.close(); }
  });
  it('refreshes a large backlog in short transactions, so card writes never wait behind a long one', async () => {
    const db = await fixture();
    await db.sql.query("INSERT INTO read_dirty(coin) SELECT decode(lpad(to_hex(4096+n),40,'0'),'hex') FROM generate_series(1,$1::int) n", [REFRESH_BATCH * 2 + 7]);
    const batches: number[] = [];
    const wrap = (sql: SqlClient): SqlClient => ({ query: async <T,>(text: string, params?: unknown[]) => {
      if (text.startsWith('SELECT refresh_read_models')) batches.push((params![0] as unknown[]).length);
      return sql.query<T>(text, params);
    } });
    await new ReadStore(new ChainDb(wrap(db.sql), fn => db.tx(tx => fn(wrap(tx.sql)))), () => now).refreshModels();
    expect(batches.length).toBeGreaterThanOrEqual(3);expect(Math.max(...batches)).toBeLessThanOrEqual(REFRESH_BATCH);
    expect(batches.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(REFRESH_BATCH * 2 + 7);
    expect((await db.sql.query('SELECT 1 FROM read_dirty')).rows).toHaveLength(0);
  });
  it('reads the feed availability once per interval with the background refresher, and on every call without it', async () => {
    const db = await fixture();
    let clock = now, reads = 0;
    const wrap = (sql: SqlClient): SqlClient => ({ query: async <T,>(text: string, params?: unknown[]) => {
      if (text.includes('AS available')) reads++;
      return sql.query<T>(text, params);
    } });
    const traced = new ChainDb(wrap(db.sql), fn => db.tx(tx => fn(wrap(tx.sql))));
    const inline = new FeedService(new ReadStore(traced, () => clock));
    // The fixture's minimal cards fail the feed item schema; the shared inputs are read before that.
    const read = (feed: FeedService, coin?: `0x${string}`) => feed.all(undefined, coin).catch(() => undefined);
    await read(inline); await read(inline, coinA); expect(reads).toBe(2);
    reads = 0;
    const store = new ReadStore(traced, () => clock); await store.refreshModels(); store.start();
    try {
      const feed = new FeedService(store);
      // Live pushes read one coin's feed per refreshed coin and engine event; the whole-database inputs are shared.
      for (const coin of [undefined, coinA, coinB, coinC]) await read(feed, coin);
      expect(reads).toBe(1);
      clock += FEED_SHARED_TTL_MS; await read(feed, coinA); expect(reads).toBe(2);
    } finally { await store.close(); }
  });
  it('re-ranks volumes from the background timer, not from the first request of the minute', async () => {
    const db = await fixture(), store = new ReadStore(db, () => now);
    await store.refreshModels();
    await db.sql.query('UPDATE read_rank_clock SET window_sec=0');
    store.start(20);
    try {
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(Number((await db.sql.query<{ window_sec: string }>('SELECT window_sec FROM read_rank_clock WHERE singleton=true')).rows[0].window_sec)).toBe(Math.floor(now / 60000) * 60);
    } finally { await store.close(); }
  });
});
