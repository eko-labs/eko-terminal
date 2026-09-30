import { afterEach, describe, expect, it, vi } from 'vitest';
import { binary, migrate, migrateEngines, type ChainDb } from '@eko/db';
import type { Address } from '@eko/shared';
import { RpcGuardError } from '@eko/chain';
import { encodeAbiParameters } from 'viem';
import { openDb } from '../../../packages/db/test/helpers/historical-db.js';
import { SellChecker, SellCheckScheduler, persistSellCheck, sellRoute, type SellCheckSchedule, type SellCheckStatus } from '../src/sell-check.js';
import { logThroughput } from '../src/throughput.js';
const address = (n: number): Address => `0x${n.toString(16).padStart(40, '0')}`;
const now = Date.parse('2026-10-17T12:00:00Z'), hour = 3600_000, day = 24 * hour;
const handles: ChainDb[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(handles.splice(0).map(db => db.close())); });
async function fixture() {
  const db = await openDb({ pgliteDir: ':memory:' }); handles.push(db);
  await migrate(db); await migrateEngines(db);
  await db.sql.query("INSERT INTO ingest_cursors(stream,block) VALUES('head',1000)");
  for (let n = 1; n <= 8; n++) {
    await db.insert('tokens', { address: binary(address(n)), first_block: n, block: n, launchpad: 'pons', curve: binary(address(n + 100)) });
    await db.sql.query("INSERT INTO engine_block_times(number,ts,source) VALUES($1,$2,'fixture')", [n, new Date(now - day)]);
    if (n % 2) await db.sql.query("INSERT INTO read_coins(coin,tier,activity,first_block,pair_column,pair_block) VALUES($1,2,$2,$3,'new',$3)", [binary(address(n)), new Date(now - 100_000), n]);
    else await db.sql.query('DELETE FROM read_coins WHERE coin=$1', [binary(address(n))]);
  }
  const rpc = { request: vi.fn(async () => encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bool' }, { type: 'bool' }, { type: 'bytes' }],
    [100n, 90n, 90n, 100n, true, true, '0x'])) };
  const checker = new SellChecker(db, rpc, { now: () => now });
  vi.spyOn(checker, 'ethUsd').mockResolvedValue(2000);
  const scheduler = (options: SellCheckSchedule = {}) => new SellCheckScheduler(db, checker, { batch: 32, ...options });
  const record = async (n: number, status: SellCheckStatus, at = now - hour) => {
    await persistSellCheck(db, { coin: address(n), block: 900, route: await sellRoute(db, address(n), 900), status,
      requests: 4, probes: [], ethUsd: 2000, exit100: null, exit1k: null }, new Date(at), null);
  };
  const due = async (at = now, options: SellCheckSchedule = {}) => (await scheduler(options).due(at)).map(c => c.coin);
  return { db, rpc, checker, scheduler, record, due };
}

describe('sell-check budget discipline', () => {
  it('adds the shared ceiling above unchanged 0219 scheduling: listed first checks remain eligible',async()=>{
    const {checker,scheduler,rpc}=await fixture();
    checker.options.paidWorkAllowed=vi.fn(async work=>work==='first_rating' || work==='crash');
    expect(await scheduler().tick()).toBe(4);expect(rpc.request).toHaveBeenCalledTimes(8);
    expect(checker.options.paidWorkAllowed).toHaveBeenCalledWith('first_rating');
    expect(checker.options.paidWorkAllowed).toHaveBeenCalledWith('routine');
  });

  it('keeps unsupported readings for seven days across restarts, with a configurable cooldown and route/pool invalidation', async () => {
    const { db, record, due } = await fixture();
    await record(1, 'unsupported', now - 6 * day);
    expect(await due()).not.toContain(address(1));
    expect(await due(now, { unsupportedDays: 2 })).toContain(address(1));
    expect(await due(now + day)).toContain(address(1));
    // A changed curve invalidates a recent unsupported reading.
    await db.sql.query('UPDATE tokens SET curve=$2 WHERE address=$1', [binary(address(1)), binary(address(200))]);
    expect(await due()).toContain(address(1));
    await record(1, 'unsupported');
    expect(await due()).not.toContain(address(1));
    await db.insert('pools', { id: binary(address(201)), venue: 'uniswap_v3', currency0: binary(address(1)), currency1: binary(address(202)), fee: 3000, tick_spacing: 60, created_block: 901, block: 901 });
    expect(await due()).toContain(address(1));
  });
  it('doubles consecutive failed buys from 24 hours to seven days; transient failures preserve and success resets the streak', async () => {
    const { db, record, due } = await fixture();
    for (const [streak, hours] of [[1, 24], [2, 48], [3, 96], [4, 168], [5, 168]]) {
      await record(1, 'buy_failed');
      expect(Number((await db.sql.query('SELECT buy_failures FROM sell_check_latest WHERE coin=$1', [binary(address(1))])).rows[0]!.buy_failures)).toBe(streak);
      const base = now - hour;
      expect(await due(base + hours! * hour - 1)).not.toContain(address(1));
      expect(await due(base + hours! * hour)).toContain(address(1));
    }
    await record(1, 'unavailable');
    expect(Number((await db.sql.query('SELECT buy_failures FROM sell_check_latest WHERE coin=$1', [binary(address(1))])).rows[0]!.buy_failures)).toBe(5);
    await record(1, 'sellable'); await record(1, 'buy_failed');
    expect(await due(now - hour + 24 * hour)).toContain(address(1));
    expect(await due(now, { buyFailedHours: 1 })).toContain(address(1));
  });
  it('requires actual new trades or the sellable timeout; read-model refreshes alone do not spend requests', async () => {
    const { db, record, due } = await fixture();
    await record(1, 'sellable');
    await db.sql.query('UPDATE read_coins SET activity=$1 WHERE coin=$2', [new Date(now), binary(address(1))]);
    expect(await due()).not.toContain(address(1));
    expect(await due(now - hour + day - 1)).not.toContain(address(1));
    expect(await due(now - hour + day)).toContain(address(1));
    expect(await due(now, { sellableHours: 1 })).toContain(address(1));
    await db.sql.query('INSERT INTO engine_swap_versions(coin,revision,high_block) VALUES($1,0,901)', [binary(address(1))]);
    expect(await due()).toContain(address(1));
    await record(1, 'sellable', now - 1000);
    expect(await due()).not.toContain(address(1));
  });
  it('spends in live-first, crash, unlisted-first, routine order and sorts oldest launches within each class', async () => {
    const { db, record, scheduler } = await fixture();
    await record(1, 'unsupported'); await record(2, 'buy_failed');
    await record(7, 'sellable', now - 2 * day); await record(8, 'sellable', now - 2 * day);
    for (const n of [1, 2]) {
      await db.sql.query('UPDATE sell_check_latest SET price=100 WHERE coin=$1', [binary(address(n))]);
      await db.sql.query('INSERT INTO coin_rating_prices(coin,price,peak,ts,block,log_index,tx_hash) VALUES($1,40,100,$2,901,0,$3)', [binary(address(n)), new Date(now - 1000), binary(`0x${'01'.repeat(32)}`)]);
    }
    const queue = await scheduler().due(now);
    expect(queue.map(c => [c.coin, c.class])).toEqual([
      [address(3), 'first_live'], [address(5), 'first_live'], [address(1), 'crash'], [address(2), 'crash'],
      [address(4), 'first_unlisted'], [address(6), 'first_unlisted'], [address(7), 'routine'], [address(8), 'routine'],
    ]);
    expect(await scheduler({ parallel: 1 }).tick()).toBe(8);
    const classes = (await db.sql.query('SELECT schedule_class FROM sell_check_runs WHERE schedule_class IS NOT NULL ORDER BY id')).rows.map(r => r.schedule_class);
    expect(classes).toEqual(queue.map(c => c.class));
    // The same old crash cannot force a check on every tick.
    expect((await scheduler().due(now)).map(c => c.class)).not.toContain('crash');
  });
  it('forces the existing 50 percent price crash or first 80 percent peak drawdown through every cooldown', async () => {
    const { db, record, scheduler } = await fixture();
    for (const [n, status] of [[1, 'sellable'], [2, 'unsupported'], [3, 'buy_failed']] as const) {
      await record(n, status, now - 1000);
      await db.sql.query('UPDATE sell_check_latest SET price=100 WHERE coin=$1', [binary(address(n))]);
      await db.sql.query('INSERT INTO coin_rating_prices(coin,price,peak,ts,block,log_index,tx_hash) VALUES($1,50,100,$2,901,0,$3)', [binary(address(n)), new Date(now), binary(`0x${'02'.repeat(32)}`)]);
    }
    // Late indexing and subsecond block times must not hide a crash behind the wall-clock attempt timestamp.
    await db.sql.query('UPDATE coin_rating_prices SET ts=$1', [new Date(now - hour)]);
    expect((await scheduler().due(now)).filter(c => c.class === 'crash').map(c => c.coin)).toEqual([address(1), address(2), address(3)]);
    await db.sql.query('UPDATE coin_rating_prices SET price=51 WHERE coin=$1', [binary(address(1))]);
    expect((await scheduler().due(now)).filter(c => c.class === 'crash').map(c => c.coin)).not.toContain(address(1));
    await db.sql.query('UPDATE coin_rating_prices SET price=20,peak=100 WHERE coin=$1', [binary(address(1))]);
    await db.sql.query('UPDATE sell_check_latest SET price=30 WHERE coin=$1', [binary(address(1))]);
    expect((await scheduler().due(now)).find(c => c.coin === address(1))?.class).toBe('crash');
    await db.sql.query('UPDATE sell_check_latest SET peak_crash=true WHERE coin=$1', [binary(address(1))]);
    expect((await scheduler().due(now)).find(c => c.coin === address(1))?.class).not.toBe('crash');
  });
  it('reserves the last 20 percent for live first checks and crashes, survives restarts, and resets at UTC midnight', async () => {
    const { db, record, scheduler, checker } = await fixture();
    // Only unlisted coins remain first checks; all listed readings are recent.
    for (const n of [1, 3, 5, 7]) await record(n, 'sellable');
    // 16 spent today, cap 20; routine and unlisted work cannot touch the last four requests.
    expect(await scheduler({ dailyRequests: 20 }).tick()).toBe(0);
    await db.sql.query('DELETE FROM sell_check_latest WHERE coin=$1', [binary(address(1))]);
    expect(await scheduler({ dailyRequests: 20 }).tick()).toBe(1);
    expect(await scheduler({ dailyRequests: 20 }).tick()).toBe(0);
    checker.options.now = () => now + day;
    expect(await scheduler({ dailyRequests: 20 }).tick()).toBeGreaterThan(0);
  });
  it('enforces request admission for expensive pair discovery and persists the actual request count', async () => {
    const { db, rpc, scheduler } = await fixture();
    // All coins pair with an unpriced token; discovery would otherwise cost four requests per coin.
    for (let n = 1; n <= 8; n++) await db.insert('pons_events', { token: binary(address(n)), block: 1, tx_hash: binary(`0x${n.toString(16).padStart(64, '0')}`), log_index: 0,
      emitter: binary(address(300)), kind: 'launch', data: JSON.stringify({ pairToken: address(400) }) });
    await db.insert('tokens', { address: binary(address(400)), first_block: 1, block: 1, decimals: 18 });
    // Pool discovery gets invalid output, but still counts each dispatched request.
    rpc.request.mockResolvedValue(`0x${'00'.repeat(32)}`);
    expect(await scheduler({ dailyRequests: 7, parallel: 1 }).tick()).toBe(1);
    expect(rpc.request).toHaveBeenCalledTimes(4);
    expect(Number((await db.sql.query('SELECT sum(requests) AS n FROM sell_check_runs')).rows[0]!.n)).toBe(4);
    // Direct guard proves even a single expensive check cannot overrun its remaining allowance.
    const checker = new SellChecker(db, rpc, { now: () => now });
    let remaining = 2;
    const result = await checker.check(address(3), 1000, [100, 1000], 2000, () => remaining-- > 0);
    expect(result).toMatchObject({ status: 'unavailable', requests: 2, probes: [] });
    expect(rpc.request).toHaveBeenCalledTimes(6);
  });
  it('accounts for dispatched requests before pausing on the process RPC budget', async () => {
    const { db, rpc, scheduler } = await fixture();
    rpc.request.mockRejectedValue(new RpcGuardError('rpc_budget_exhausted'));
    await expect(scheduler({ parallel: 1 }).tick()).rejects.toMatchObject({ code: 'rpc_budget_exhausted' });
    const rows = (await db.sql.query('SELECT status,requests FROM sell_check_runs')).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'unavailable', requests: 2 });
  });
  it('adds class counts and UTC-day remaining requests to the engine throughput minute line', async () => {
    const { db } = await fixture();
    await db.sql.query(`INSERT INTO sell_check_runs(coin,block,checked_at,status,requests,data,schedule_class)
      VALUES($1,1,date_trunc('minute',now())-interval '1 minute','sellable',4,'{}','first_live')`, [binary(address(1))]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await logThroughput(db, { dailyRequests: 100, reservePct: 20 });
    const line = JSON.parse(log.mock.calls[0]![0]);
    expect(line.sellCheck).toMatchObject({ enabled: true, remainingRequests: 96, routineRemainingRequests: 76 });
    expect(line.sellCheck.classes.map((r: { class: string }) => r.class)).toEqual(['first_live']);
  });
});
