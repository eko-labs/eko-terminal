import { afterEach, describe, expect, it } from 'vitest';
import { binary, ChainDb, migrate, migrateEngines, rebuildBalances, runRetention } from '@eko/db';
import { openDb } from '../../../packages/db/test/helpers/historical-db.js';
import type { Address } from '@eko/shared';
import { EngineWorker } from '../src/worker.js';
import { RULES_VERSION } from '@eko/playbooks';
import { ACTIVITY_LOOKBACK_BLOCKS, blockIndex, checkpoints, coinActivity, type BlockReader, type Checkpoint, type CoinActivity } from '../src/activity.js';
import { digest } from '../src/card.js';
import { historyPrunes } from '../src/history-prunes.js';
import { LiveActivity } from '../src/live-activity.js';

// Live polls read only what changed since the previous poll (live-activity.ts). These tests run the same chain history
// through two databases, one engine reading every coin's full history on every poll (the previous implementation, still
// used by replay) and one reading incrementally, and require identical plans and outputs.
const epoch = Date.parse('2026-10-01T00:00:00Z') / 1000;
/** Two-second blocks from a high start, so the re-read window (256 blocks) covers only the newest ~8.5 minutes. */
const B0 = 5_000_000, DAY = 43_200;
const at = (day: number) => B0 + Math.round(day * DAY);
const secOf = (n: number) => epoch + (n - B0) * 2;
const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as const;
const zero = address(0), deployer = address(0xd1), second = address(0xd2);
const [t1, t2, t3, t4] = [0x101, 0x102, 0x103, 0x104].map(address);
const A = address(0x1a), B = address(0x1b), C = address(0x1c), D = address(0x1d), E = address(0x1e);
const pool = (coin: Address) => address(Number(BigInt(coin)) + 0x200), curve = address(0x3d), graduated = address(0x4d);
const readBlock: BlockReader = async n => ({ timestamp: BigInt(secOf(n)), hash: hash(n) });
readBlock.readMany = blocks => Promise.all(blocks.map(n => readBlock(n)));
const handles: ChainDb[] = [];
afterEach(async () => { await Promise.all(handles.splice(0).map(db => db.close())); });

/** Indexed rows for one database. Every call sequence is applied to both databases in the same order. */
class Chain {
  private id = 1;
  constructor(public db: ChainDb) {}
  async header(n: number, variant = 0) {
    await this.db.sql.query('INSERT INTO chain_blocks VALUES($1,$1,$2,$3,$4) ON CONFLICT(number) DO UPDATE SET hash=excluded.hash',
      [n, binary(hash(n * 10 + variant)), binary(hash((n - 1) * 10)), new Date(secOf(n) * 1000)]);
  }
  async token(coin: Address, n: number, pons = false, owner = deployer) {
    await this.db.insert('tokens', { address: binary(coin), deployer: binary(owner), curve: pons ? binary(curve) : null, name: 'Sample token', symbol: 'DEMO',
      launchpad: pons ? 'pons' : 'other', decimals: 0, total_supply: '1000000', supply_block: String(n), first_block: String(n), block: String(n) });
  }
  async swap(coin: Address, n: number, side: 1 | -1, trader: Address | null, price = 1, usd: number | null = 25) {
    await this.db.insert('swaps', { ts: new Date(secOf(n) * 1000), block: String(n), tx_hash: binary(hash(this.id++)), log_index: 0, venue: coin === D ? 'pons_curve' : 'uniswap_v3',
      pool_id: binary(coin === D ? curve : pool(coin)), coin: binary(coin), quote_asset: binary(zero), trader: trader && binary(trader), tx_from: trader && binary(trader),
      tx_to: binary(pool(coin)), side, amount_coin: '1000', amount_quote: '100', price_quote: price, usd, priced_block: usd == null ? null : String(n),
      senders_pending: trader == null });
  }
  async transfer(coin: Address, n: number, from: Address, to: Address, amount = 1000) {
    await this.db.insert('token_transfers', { ts: new Date(secOf(n) * 1000), block: String(n), tx_hash: binary(hash(this.id++)), log_index: 0, token: binary(coin),
      from_address: binary(from), to_address: binary(to), amount: String(amount) });
    await this.db.tx(tx => rebuildBalances(tx));
  }
  async pair(coin: Address, n: number, id = pool(coin)) {
    await this.db.insert('pools', { id: binary(id), venue: 'uniswap_v3', currency0: binary(coin), currency1: binary(zero), fee: 3000, tick_spacing: 60,
      creation_verified: true, created_block: String(n), block: String(n) });
  }
  async liquidity(coin: Address, n: number, actor: Address, kind = 'Mint', id = pool(coin)) {
    await this.db.insert('liquidity_events', { block: String(n), ts: new Date(secOf(n) * 1000), tx_hash: binary(hash(this.id++)), log_index: 0, venue: 'uniswap_v3',
      pool_id: binary(id), kind, actor: binary(actor), data: JSON.stringify({ owner: actor, amount: '5000', tickLower: '-600', tickUpper: '600' }) });
  }
  async pons(coin: Address, n: number, kind: string, data: Record<string, unknown>) {
    await this.db.insert('pons_events', { block: String(n), tx_hash: binary(hash(this.id++)), log_index: 0, token: binary(coin), emitter: binary(curve), kind, data: JSON.stringify(data) });
  }
  async exemption(coin: Address, wallet: Address, n: number) {
    await this.db.insert('pons_exemptions', { token: binary(coin), wallet: binary(wallet), block: String(n), tx_hash: binary(hash(this.id++)), log_index: 0 });
  }
}
async function database() {
  const db = await openDb({ pgliteDir: ':memory:' }); handles.push(db);
  await migrate(db); await migrateEngines(db); await db.ensurePartitions(new Date(epoch * 1000));
  return db;
}
/** A new process on the same database: refreshClock keeps its watermark per handle. */
const reopen = (db: ChainDb) => new ChainDb(db.sql, fn => db.tx(tx => fn(tx.sql)));
/** engine_runs.created_at is the wall-clock write time (0191), the only column two equal runs never share. */
const durable = (table: string) => table === 'engine_runs' ? "(to_jsonb(r) - 'created_at')" : 'row_to_json(r)';
const tables = ['verdicts', 'verdict_events', 'coin_cards', 'coin_card_latest', 'playbook_matches', 'engine_runs', 'engine_schedule', 'engine_activity_state',
  'deployer_stats', 'outcomes', 'receipt_publications', 'engine_card_failures'];
const snapshot = async (db: ChainDb) => Object.fromEntries(await Promise.all([...tables.map(async table => [table,
  (await db.sql.query<{ data: string }>(`SELECT ${durable(table)}::text AS data FROM ${table} r ORDER BY 1`)).rows.map(row => row.data)] as const),
['engine_block_times', (await db.sql.query<{ data: string }>(`SELECT concat_ws(':',number,extract(epoch FROM ts),encode(hash,'hex'),source) AS data FROM engine_block_times ORDER BY number`)).rows.map(row => row.data)] as const]));
const head = async (db: ChainDb) => Number((await db.sql.query<{ block: string }>("SELECT block FROM engine_cursors WHERE stream='engines'")).rows[0]!.block);
const lastActivity = (coin: CoinActivity) => coin.events.reduce((latest, event) => Math.max(latest, event.sec), coin.createdSec);

describe('incremental live activity', () => {
  // 900 s coalesces backlog as the CLI does by default; without it every historical checkpoint is planned.
  it.each([[900], [undefined]])('plans and evaluates exactly like full-history polls (backlog %s) across new coins, a reorg, old-block writes, retention and a restart', async backlog => {
    const full = new Chain(await database()), live = new Chain(await database());
    const both = async (step: (chain: Chain) => Promise<void>) => { await step(full); await step(live); };
    let now = 0;
    const plans = { full: [] as Checkpoint[][], live: [] as Checkpoint[][] };
    const worker = (chain: Chain, mode: 'full' | 'incremental') => new EngineWorker(chain.db, { now: () => now, readBlock, liveBacklogSec: backlog, liveActivity: mode,
      onLiveTasks: tasks => plans[mode === 'full' ? 'full' : 'live'].push([...tasks]) });
    let workers = { full: worker(full, 'full'), live: worker(live, 'incremental') };
    // A second incremental reader that is never restarted, compared coin by coin with the full-history read.
    const probe = new LiveActivity(live.db);
    const evaluations: number[] = [];
    const poll = async (sec: number) => {
      now = sec;
      const completed = await workers.full.poll();
      expect(await workers.live.poll()).toBe(completed);
      evaluations.push(completed);
      expect(plans.live.at(-1)).toEqual(plans.full.at(-1));
      expect(await snapshot(live.db)).toEqual(await snapshot(full.db));
      // The incremental reader against the full-history read of the same rows: revisions, bases, times, block clock and
      // plans from the stored progress, from the launch and from points in between.
      const to = await head(full.db);
      const reference = await coinActivity(full.db, to, readBlock, new Map());
      const incremental = (await probe.refresh(to, now, await historyPrunes(live.db), { cache: new Map(), readBlock, concurrency: 4, stopped: () => false }))!;
      const byCoin = new Map(reference.map(coin => [coin.coin, coin]));
      for (const coin of incremental.coins) {
        const expected = byCoin.get(coin.coin)!;
        expect([coin.firstBlock, coin.createdSec, coin.lastSec, coin.revision]).toEqual([expected.firstBlock, expected.createdSec, lastActivity(expected),
          digest({ activity: expected.revision, rulesVersion: RULES_VERSION })]);
        if (coin.base) expect(coin.base).toEqual(expected.base);
      }
      const planned = reference.filter(coin => now - lastActivity(coin) < 7 * 86400);
      expect(incremental.coins.map(coin => coin.coin)).toEqual(expect.arrayContaining(planned.map(coin => coin.coin)));
      const clock = (await full.db.sql.query<{ number: string; ts: Date }>('SELECT number,ts FROM engine_block_times WHERE number<=$1 ORDER BY number', [to]))
        .rows.map(row => ({ number: Number(row.number), sec: row.ts.getTime() / 1000 }));
      expect(incremental.clock).toEqual(clock.filter(point => point.number >= incremental.clock[0]!.number));
      expect(clock.filter(point => point.number < incremental.clock[0]!.number).every(point => point.sec < now - 8 * 86400)).toBe(true);
      const through = new Map((await live.db.sql.query<{ coin: Uint8Array; through_block: string }>('SELECT coin,through_block FROM engine_activity_state')).rows
        .map(row => [`0x${Buffer.from(row.coin).toString('hex')}`, Number(row.through_block)]));
      for (const from of [(coin: CoinActivity) => (through.get(coin.coin) ?? -1) + 1, () => 0, (coin: CoinActivity) => Math.floor((coin.firstBlock + to) / 2)]) {
        const requests = planned.map(coin => ({ coin: coin.coin, from: from(coin) }));
        const resumed = await probe.plans(requests, to);
        for (const request of requests) expect(resumed.get(request.coin)).toEqual(checkpoints(byCoin.get(request.coin)!, clock, request.from, to, blockIndex(clock)));
      }
      return probe.stats!;
    };

    // History: A traded on days 0-1 and went quiet; B trades throughout (one swap still waits for its sender); C launched on
    // day 6 and went quiet on day 7; D is a Pons launch with an exemption, a pool and Pons trades, one in a block with no
    // indexed time at all (an archive header fills it).
    await both(async chain => {
      for (const n of [at(0), at(0) + 10, at(0.5), at(1)]) await chain.header(n);
      await chain.token(A, at(0)); await chain.transfer(A, at(0) + 10, zero, t1); await chain.swap(A, at(0) + 10, 1, t1); await chain.swap(A, at(0.5), -1, t1, 1.2);
      await chain.swap(A, at(1), 1, t2, 0.9); await chain.transfer(A, at(1), t1, t2, 100);
      await chain.token(B, at(0.5)); await chain.pair(B, at(0.5)); await chain.liquidity(B, at(0.5), deployer); await chain.transfer(B, at(0.5), zero, deployer, 100000);
      for (const [day, side, trader, price] of [[1, 1, t1, 1], [2, 1, t2, 1.1], [3, -1, null, 1.3], [5, 1, t3, 1.2], [8, -1, t1, 1.25], [8.9, 1, t2, 1.4], [8.95, 1, t3, 1.5], [8.99, -1, t1, 1.45]] as const) {
        await chain.header(at(day)); await chain.swap(B, at(day), side, trader, price);
      }
      await chain.transfer(B, at(2), deployer, t2, 5000); await chain.transfer(B, at(8.9), t2, t3, 200);
      for (const n of [at(6), at(6) + 1, at(6.5), at(7)]) await chain.header(n);
      await chain.token(C, at(6), false, second); await chain.transfer(C, at(6) + 1, zero, t4); await chain.swap(C, at(6) + 1, 1, t4);
      await chain.swap(C, at(6.5), 1, t1, 2); await chain.swap(C, at(7), -1, t4, 1.6);
      await chain.header(at(8.9)); await chain.token(D, at(8.9), true); await chain.pons(D, at(8.9), 'launch', { graduationThreshold: '1000000' });
      await chain.exemption(D, deployer, at(8.9) + 1); await chain.header(at(8.9) + 1);
      // Block +20 is known only from its transfer; block +40 only from its Pons event.
      await chain.pons(D, at(8.9) + 20, 'trade', { side: 1, amountEth: '5000', feeEth: '50', taxEth: '10' }); await chain.transfer(D, at(8.9) + 20, curve, t1);
      await chain.swap(D, at(8.9) + 20, 1, t1);
      await chain.pons(D, at(8.9) + 40, 'trade', { side: 1, amountEth: '7000', feeEth: '70', taxEth: '10' });
      await chain.header(at(8.98)); await chain.swap(D, at(8.98), 1, t2, 1.3);
      await chain.header(at(9)); await chain.swap(B, at(9), 1, t4, 1.5);
    });
    const cold = await poll(secOf(at(9)) + 30);
    expect(cold).toMatchObject({ cold: true });
    expect(plans.live.at(-1)!.length).toBeGreaterThan(0);

    // New blocks: B trades, E launches and trades, D adds liquidity.
    await both(async chain => {
      await chain.header(at(9.005)); await chain.token(E, at(9.005), false, second);
      await chain.header(at(9.006)); await chain.transfer(E, at(9.006), zero, t2); await chain.swap(E, at(9.006), 1, t2);
      await chain.header(at(9.01)); await chain.swap(B, at(9.01), -1, t2, 1.2); await chain.pair(D, at(9.01)); await chain.liquidity(D, at(9.01), deployer);
      await chain.header(at(9.02)); await chain.swap(E, at(9.02), 1, t3, 1.1);
    });
    const warm = await poll(secOf(at(9.02)) + 30);
    // Only the new launch and the coin with a new pool are summed in the database; B's new trade comes from the window.
    expect(warm).toMatchObject({ cold: false, summedCoins: 2, rangeRows: 0 });

    // Rows that a reorg inside the re-read window will replace, then the reorg itself (the engine cursor block survives).
    const r = at(9.02);
    await both(async chain => {
      await chain.header(r + 150); await chain.swap(E, r + 150, 1, t1, 1.3);
      await chain.header(r + 180); await chain.transfer(B, r + 180, t3, t4, 10);
      // A Pons trade in a new block with no indexed time: the window fills it, D itself is not read again.
      await chain.pons(D, r + 200, 'trade', { side: 1, amountEth: '900', feeEth: '9', taxEth: '1' });
      await chain.header(r + 300); await chain.swap(B, r + 300, 1, t1, 1.25);
    });
    expect(await poll(secOf(r + 300) + 30)).toMatchObject({ summedCoins: 0 });
    await both(async chain => {
      await chain.db.sql.query('DELETE FROM swaps WHERE block=$1', [r + 150]); await chain.db.sql.query('DELETE FROM token_transfers WHERE block=$1', [r + 180]);
      await chain.db.tx(tx => rebuildBalances(tx));
      await chain.header(r + 150, 1); await chain.swap(E, r + 150, -1, t4, 0.8);
      await chain.header(r + 180, 1);
      await chain.header(r + 320); await chain.swap(E, r + 320, 1, t2, 1);
    });
    // The replaced rows are inside the re-read window: no coin is summed again.
    expect(r + 320 - ACTIVITY_LOOKBACK_BLOCKS).toBeLessThan(r + 150);
    expect(await poll(secOf(r + 320) + 30)).toMatchObject({ summedCoins: 0 });

    // Writes far below the re-read window: a backfilled C trade, B's pending sender resolved, a late Pons event with
    // no stored time, a backfilled transfer of quiet A, and D graduating to a new pool.
    await both(async chain => {
      await chain.header(at(6.8)); await chain.swap(C, at(6.8), 1, t3, 1.7);
      await chain.db.sql.query('UPDATE swaps SET trader=$1,tx_from=$1,senders_pending=false WHERE coin=$2 AND block=$3', [binary(t4), binary(B), at(3)]);
      await chain.pons(D, at(8.9) + 70, 'trade', { side: -1, amountEth: '1000', feeEth: '10', taxEth: '2' });
      await chain.transfer(A, at(1.5), t2, t3, 10);
      await chain.header(at(9.03)); await chain.pair(D, at(9.03), graduated); await chain.liquidity(D, at(9.03), deployer, 'Mint', graduated);
      await chain.db.sql.query('UPDATE tokens SET graduated_block=$1,graduated_pool=$2 WHERE address=$3', [at(9.03), binary(graduated), binary(D)]);
      await chain.swap(D, at(9.03), 1, t3, 2);
    });
    const old = await poll(secOf(at(9.03)) + 30);
    expect(old.summedCoins).toBeGreaterThanOrEqual(3);

    // Restart both engines on new handles after more writes, one of them far below the window.
    await both(async chain => {
      await chain.header(at(9.2)); await chain.swap(B, at(9.2), 1, t2, 1.3);
      await chain.transfer(B, at(4), t2, t1, 30);
      chain.db = reopen(chain.db);
    });
    workers = { full: worker(full, 'full'), live: worker(live, 'incremental') };
    await poll(secOf(at(9.2)) + 30);

    // C is rated Danger with every outcome labeled; after two quiet days retention drops its transfers.
    await both(async chain => {
      await chain.db.sql.query(`UPDATE coin_card_latest SET data=jsonb_set(data,'{verdict,level}','"danger"') WHERE coin=$1`, [binary(C)]);
      for (const horizon of ['1h', '24h', '7d']) await chain.db.sql.query("INSERT INTO outcomes VALUES($1,$2,$3,'rugged','{}') ON CONFLICT DO NOTHING", [binary(C), horizon, at(7)]);
      await chain.header(at(9.3)); await chain.swap(E, at(9.3), -1, t3, 0.9);
      expect(await runRetention(chain.db, { dryRun:false,pauseMs:0,quoteTokens: [], dangerQuietDays: 2, now: () => (secOf(at(9.3)) + 30) * 1000 })).toMatchObject({ dangerCoins: 1 });
    });
    await poll(secOf(at(9.3)) + 30);

    // Five days later: C has been quiet for over seven days, quiet A trades again.
    await both(async chain => {
      await chain.header(at(14.5)); await chain.swap(B, at(14.5), -1, t3, 1.1); await chain.swap(A, at(14.5), 1, t4, 0.5);
    });
    const later = await poll(secOf(at(14.5)) + 30);
    expect(later.coins).toBeLessThan(5);
    expect(plans.live.at(-1)!.map(task => task.coin)).toContain(A);
    expect(evaluations.reduce((sum, n) => sum + n, 0)).toBeGreaterThan(10);
  }, 240_000);
  it('fills every missing block time once when the change log lapsed, and starts cold after a stopped refresh', async () => {
    const full = new Chain(await database()), live = new Chain(await database());
    const both = async (step: (chain: Chain) => Promise<void>) => { await step(full); await step(live); };
    let now = 0;
    const plans: Record<string, Checkpoint[]> = {};
    const worker = (chain: Chain, mode: 'full' | 'incremental') => new EngineWorker(chain.db, { now: () => now, readBlock, liveBacklogSec: 900, liveActivity: mode,
      onLiveTasks: tasks => { plans[mode] = [...tasks]; } });
    const poll = async (workers: EngineWorker[], sec: number) => {
      now = sec;
      expect(await workers[1]!.poll()).toBe(await workers[0]!.poll());
      expect(plans.incremental).toEqual(plans.full);
      expect(await snapshot(live.db)).toEqual(await snapshot(full.db));
    };
    await both(async chain => {
      for (const n of [at(0), at(5), at(8.9), at(9)]) await chain.header(n);
      await chain.token(C, at(0)); await chain.swap(C, at(0), 1, t1); await chain.swap(C, at(5), -1, t1, 1.1);
      await chain.token(B, at(8.9)); await chain.swap(B, at(8.9), 1, t2); await chain.swap(B, at(9), 1, t3, 1.2);
    });
    await poll([worker(full, 'full'), worker(live, 'incremental')], secOf(at(9)) + 30);
    // No live engine for a day: the triggers stop writing. Meanwhile C gets a Pons event at an old block with no stored time.
    await live.db.sql.query("UPDATE engine_activity_feed SET seen_at=now()-interval '2 days'");
    const logged = async () => Number((await live.db.sql.query<{ n: string }>('SELECT count(*) AS n FROM engine_activity_changes')).rows[0]!.n);
    const before = await logged();
    await both(async chain => {
      await chain.pons(C, at(4), 'trade', { side: 1, amountEth: '100', feeEth: '1', taxEth: '0' });
      await chain.header(at(9.1)); await chain.swap(B, at(9.1), -1, t2, 1.3);
      chain.db = reopen(chain.db);
    });
    expect(await logged()).toBe(before);
    // A refresh stopped while filling a missing time leaves the next refresh cold.
    const probe = new LiveActivity(live.db), options = { cache: new Map(), readBlock, concurrency: 4 };
    expect(await probe.refresh(at(9.1), secOf(at(9.1)), new Map(), { ...options, stopped: () => true })).toBeUndefined();
    await poll([worker(full, 'full'), worker(live, 'incremental')], secOf(at(9.1)) + 30);
    expect((await live.db.sql.query('SELECT 1 FROM engine_block_times WHERE number=$1', [at(4)])).rows).toHaveLength(1);
    await probe.refresh(at(9.1), secOf(at(9.1)) + 30, new Map(), { ...options, stopped: () => false });
    expect(probe.stats).toMatchObject({ cold: true });
    // The log is followed again.
    await both(async chain => { await chain.header(at(9.2)); await chain.swap(B, at(9.2), 1, t1, 1.4); });
    expect(await logged()).toBeGreaterThan(before);
  });
  it('adds a block time stored later below the held clock without reloading the whole clock', async () => {
    const chain = new Chain(await database());
    for (const n of [at(2), at(5), at(8.9), at(9)]) await chain.header(n);
    await chain.token(B, at(2)); await chain.swap(B, at(2), 1, t1); await chain.swap(B, at(9), 1, t2, 1.1);
    const now = secOf(at(9)) + 30, options = { cache: new Map(), readBlock, concurrency: 4, stopped: () => false };
    expect(await new EngineWorker(chain.db, { now: () => now, readBlock, liveBacklogSec: 900 }).poll()).toBeGreaterThan(0);
    const probe = new LiveActivity(chain.db);
    const held = (await probe.refresh(at(9), now, new Map(), options))!.clock;
    expect(probe.stats).toMatchObject({ cold: true });
    // A time for a block inside the eight-day window but below the held range arrives later (a filled gap).
    const late = at(1) + 100;
    await chain.db.sql.query("INSERT INTO engine_block_times VALUES($1,to_timestamp($2),NULL,'archive')", [late, secOf(late)]);
    const clock = (await probe.refresh(at(9), now, new Map(), options))!.clock;
    expect(probe.stats).toMatchObject({ cold: false });
    expect(probe.stats!.clockPoints).toBeLessThan(held.length);
    expect(clock[0]).toEqual({ number: late, sec: secOf(late) });expect(clock.slice(1)).toEqual(held);
  });
  it('does not hold a token without a launch wallet, and takes it once it has one', async () => {
    // WETH and USDG are in most new pools: held, their whole history was summed again on every poll (2026-10-13).
    const chain = new Chain(await database());
    for (const n of [at(8), at(8.5), at(9)]) await chain.header(n);
    await chain.token(B, at(8)); await chain.swap(B, at(8), 1, t1);
    await chain.db.insert('tokens', { address: binary(C), deployer: null, curve: null, name: null, symbol: null, launchpad: null, decimals: null, first_block: String(at(8)), block: String(at(8)) });
    await chain.pair(C, at(8)); await chain.swap(C, at(8.5), 1, t2);
    const now = secOf(at(9)) + 30, live = new LiveActivity(reopen(chain.db)), options = { cache: new Map(), readBlock, concurrency: 4, stopped: () => false };
    expect((await live.refresh(at(8.5), now, new Map(), options))!.coins.map(coin => coin.coin)).toEqual([B]);
    // Onboarded (name, supply and launch wallet), then traded again: held from that poll on, with its whole history.
    await chain.db.sql.query("UPDATE tokens SET deployer=$2,name='Sample token',symbol='DEMO',decimals=0,total_supply=1000000,supply_block=$3 WHERE address=$1", [binary(C), binary(deployer), at(8.5)]);
    await chain.swap(C, at(9), -1, t2);
    const held = (await live.refresh(at(9), now, new Map(), options))!.coins;
    expect(held.map(coin => coin.coin).sort()).toEqual([B, C].sort());
    expect(await new EngineWorker(chain.db, { now: () => now, readBlock, liveBacklogSec: 900 }).poll()).toBeGreaterThanOrEqual(2);
    expect((await chain.db.sql.query('SELECT 1 FROM coin_card_latest WHERE coin=$1', [binary(C)])).rows).toHaveLength(1);
  });
  it('takes recent launches without stored progress on a cold start that follows the log', async () => {
    const chain = new Chain(await database());
    for (const n of [at(8), at(8.5), at(9)]) await chain.header(n);
    await chain.token(B, at(8)); await chain.swap(B, at(8), 1, t1);
    await chain.token(C, at(8.5)); await chain.transfer(C, at(8.5), zero, t2);
    const now = secOf(at(9)) + 30;
    expect(await new EngineWorker(chain.db, { now: () => now, readBlock, liveBacklogSec: 900 }).poll()).toBe(2);
    // A process stopped before C's first state write (a yielded poll, then a restart). Nothing has changed since.
    await chain.db.sql.query('DELETE FROM engine_activity_state WHERE coin=$1', [binary(C)]);
    const probe = new LiveActivity(reopen(chain.db));
    const coins = (await probe.refresh(at(9), now, new Map(), { cache: new Map(), readBlock, concurrency: 4, stopped: () => false }))!.coins;
    expect(probe.stats).toMatchObject({ cold: true });
    expect(coins.map(coin => coin.coin)).toEqual(expect.arrayContaining([B, C]));
  });
});
