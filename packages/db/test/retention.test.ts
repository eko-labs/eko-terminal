import { afterEach, describe, expect, it } from 'vitest';
import { binary, FEED_BATCH_ROWS, hex, migrate, migrateEngines, rebuildBalances, runRetention, type ChainDb } from '../src/index.js';
import { openDb } from './helpers/historical-db.js';

const epoch = Date.parse('2026-10-01T00:00:00Z');
const DAY = 86_400_000;
const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as `0x${string}`;
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as `0x${string}`;
const zero = address(0), quote = address(0xa1), idle = address(0xb1), active = address(0xc1);
const holders = [address(0x11), address(0x12), address(0x13)];
const handles: ChainDb[] = [];
afterEach(async () => { await Promise.all(handles.splice(0).map(db => db.close())); });

let eventId = 1;
async function database() {
  const db = await openDb({ pgliteDir: ':memory:' }); handles.push(db);
  await migrate(db); await db.ensurePartitions(new Date(epoch));
  return db;
}
const at = (day: number) => new Date(epoch + day * DAY);
async function block(db: ChainDb, n: number, day: number) {
  await db.insert('chain_blocks', { number: String(n), block: String(n), hash: binary(hash(n)), parent_hash: binary(hash(n - 1)), ts: at(day) });
}
async function transfer(db: ChainDb, n: number, day: number, token: `0x${string}`, from: `0x${string}`, to: `0x${string}`, amount: number, kind = 'Transfer') {
  await db.insert('token_transfers', { ts: at(day), block: String(n), tx_hash: binary(hash(eventId++)), log_index: 0,
    token: binary(token), from_address: binary(from), to_address: binary(to), amount: String(amount), kind });
}
async function token(db: ChainDb, address: `0x${string}`) {
  await db.insert('tokens', { address: binary(address), deployer: binary(zero), curve: null, name: 'Sample token', symbol: 'DEMO',
    launchpad: null, decimals: 0, total_supply: '1000000', supply_block: '1', first_block: '1', block: '1' });
}
const balances = async (db: ChainDb) => (await db.sql.query<{ token: Uint8Array; holder: Uint8Array; amount: string }>(
  'SELECT token, holder, amount::text FROM balances ORDER BY token, holder')).rows.map(r => `${hex(r.token)}:${hex(r.holder)}:${r.amount}`);
const count = async (db: ChainDb, token: `0x${string}`) => Number((await db.sql.query<{ n: string }>(
  'SELECT count(*)::text AS n FROM token_transfers WHERE token=$1', [binary(token)])).rows[0]!.n);

async function fixture() {
  const db = await database();
  for (const t of [quote, idle, active]) await token(db, t);
  // Days 0-9: mints and churn on every token; days 18-20: only the quote and active tokens keep moving.
  let n = 1;
  for (let day = 0; day <= 20; day++) {
    await block(db, n, day);
    for (const t of [quote, idle, active]) {
      if (day > 9 && t === idle) continue;
      if (day > 9 && day < 18) continue;
      if (day === 0) for (const h of holders) await transfer(db, n, day, t, zero, h, 1000);
      else await transfer(db, n, day, t, holders[day % 3]!, holders[(day + 1) % 3]!, day * 3);
      if (t === quote && day % 4 === 0) await transfer(db, n, day, t, holders[0]!, zero, 0, 'Deposit');
    }
    n++;
  }
  await db.tx(tx => rebuildBalances(tx));
  return db;
}

describe('chain retention roll-up', () => {
  it('compacts old quote and idle-token transfers while every recomputed balance stays exact', async () => {
    const db = await fixture(), before = await balances(db);
    const quoteBefore = await count(db, quote), activeBefore = await count(db, active);
    const result = await runRetention(db, { dryRun: false, pauseMs: 0, quoteTokens: [quote], quoteDays: 2, idleTokenDays: 8, batchRows: 5, now: () => epoch + 20.5 * DAY });
    expect(result).toMatchObject({ finished: true, idleTokens: 1 });
    expect(result.quoteRows).toBeGreaterThan(0);
    // Quote: only the last two days remain. Idle token: nothing remains. Active token: untouched.
    expect(await count(db, quote)).toBeLessThan(quoteBefore);
    expect(Number((await db.sql.query<{ n: string }>("SELECT count(*)::text AS n FROM token_transfers WHERE token=$1 AND ts < $2", [binary(quote), at(18.5)])).rows[0]!.n)).toBe(0);
    expect(await count(db, idle)).toBe(0);
    expect(await count(db, active)).toBe(activeBefore);
    // A full rebuild and a touched recompute both reproduce the original balances.
    await db.tx(tx => rebuildBalances(tx));
    expect(await balances(db)).toEqual(before);
    await db.tx(tx => rebuildBalances(tx, holders.map(h => ({ token: binary(quote), holder: binary(h) }))));
    expect(await balances(db)).toEqual(before);
    // A new transfer after compaction moves the balance by exactly its amount.
    await block(db, 99, 20.6); await transfer(db, 99, 20.6, quote, holders[0]!, holders[1]!, 7);
    await db.tx(tx => rebuildBalances(tx, [holders[0]!, holders[1]!].map(h => ({ token: binary(quote), holder: binary(h) }))));
    const after = await balances(db), key = (h: `0x${string}`) => `${quote}:${h}:`;
    const amount = (rows: string[], h: `0x${string}`) => BigInt(rows.find(r => r.startsWith(key(h)))!.split(':')[2]!);
    expect(amount(after, holders[0]!)).toBe(amount(before, holders[0]!) - 7n);
    expect(amount(after, holders[1]!)).toBe(amount(before, holders[1]!) + 7n);
    // A second pass has nothing left to do.
    expect(await runRetention(db, { dryRun: false, pauseMs: 0, quoteTokens: [quote], quoteDays: 2, idleTokenDays: 8, now: () => epoch + 20.5 * DAY }))
      .toMatchObject({ quoteRows: 0, idleRows: 0, idleTokens: 0, finished: true });
  });

  it('is off unless configured, refuses a zero-day idle window, and stops at its time budget', async () => {
    const db = await fixture(), total = await count(db, quote) + await count(db, idle) + await count(db, active);
    expect(await runRetention(db, { dryRun: false, pauseMs: 0, quoteTokens: [quote], now: () => epoch + 20.5 * DAY })).toMatchObject({ quoteRows: 0, idleRows: 0, pendingRows: 0, feedRows: 0 });
    expect(await count(db, quote) + await count(db, idle) + await count(db, active)).toBe(total);
    await expect(runRetention(db, { dryRun: false, pauseMs: 0, quoteTokens: [quote], idleTokenDays: 0, now: () => epoch + 20.5 * DAY })).rejects.toThrow('at least one quiet day');
    let clock = epoch + 20.5 * DAY;
    const partial = await runRetention(db, { dryRun: false, pauseMs: 0, quoteTokens: [quote], quoteDays: 2, batchRows: 2, budgetMs: 1, now: () => (clock += 1) });
    expect(partial.finished).toBe(false);
  });

  it('deletes old events of pools that are still unknown and keeps known or recent ones', async () => {
    const db = await fixture(), pool = (n: number) => binary(address(0xd0 + n));
    await db.insert('pools', { id: pool(1), venue: 'uniswap_v3', currency0: binary(active), currency1: binary(zero), fee: 3000, tick_spacing: 1, creation_verified: true, created_block: '1', block: '1' });
    for (const [n, emitter, blockNumber] of [[1, 1, 2], [2, 2, 2], [3, 2, 20]] as const) {
      await db.sql.query('INSERT INTO pending_pool_events(block,tx_hash,log_index,emitter,currency_hints,data) VALUES($1,$2,0,$3,$4,$5)',
        [String(blockNumber), binary(hash(5000 + n)), pool(emitter), '[]', '{}']);
    }
    expect(await runRetention(db, { dryRun: false, pauseMs: 0, quoteTokens: [], pendingPoolDays: 3, now: () => epoch + 20.5 * DAY })).toMatchObject({ pendingRows: 1 });
    expect((await db.sql.query<{ block: string; emitter: Uint8Array }>('SELECT block::text, emitter FROM pending_pool_events ORDER BY block')).rows
      .map(r => [r.block, hex(r.emitter)])).toEqual([['2', address(0xd1)], ['20', address(0xd2)]]);
  });

  it('gives every rule its own time budget, so a transfer backlog cannot starve the unknown-pool rule', async () => {
    const db = await fixture();
    for (const n of [1, 2, 3]) {
      await db.sql.query('INSERT INTO pending_pool_events(block,tx_hash,log_index,emitter,currency_hints,data) VALUES($1,$2,0,$3,$4,$5)',
        ['2', binary(hash(6000 + n)), binary(address(0xe0)), '[]', '{}']);
    }
    // One row per batch and a three-tick budget: the quote rule runs out with old quote transfers left over.
    let clock = epoch + 20.5 * DAY;
    const result = await runRetention(db, { dryRun: false, pauseMs: 0, quoteTokens: [quote], quoteDays: 2, pendingPoolDays: 3, batchRows: 1, budgetMs: 3, now: () => (clock += 1) });
    expect(result.finished).toBe(false);
    expect(result.quoteRows).toBeGreaterThan(0);
    expect(Number((await db.sql.query<{ n: string }>('SELECT count(*)::text AS n FROM token_transfers WHERE token=$1 AND ts < $2', [binary(quote), at(18.5)])).rows[0]!.n)).toBeGreaterThan(0);
    // The unknown-pool rule still ran in the same pass.
    expect(result.pendingRows).toBeGreaterThan(0);
  });
});

describe('Feed retention', () => {
  const coin = active, other = idle;
  const ids = async (db: ChainDb) => (await db.sql.query<{ id: string }>('SELECT id FROM read_feed ORDER BY block, id')).rows.map(r => r.id);
  const firstVerdict = async (db: ChainDb, c: `0x${string}`) => (await db.sql.query<{ block: string }>('SELECT block::text FROM read_first_verdict WHERE coin=$1', [binary(c)])).rows[0]?.block;
  const matchId = (c: `0x${string}`, n: number, playbook: string) => `match:${c.slice(2)}:${n}:1.0.0:${playbook}`;
  async function verdict(db: ChainDb, id: string, c: `0x${string}`, n: number) {
    await db.sql.query('INSERT INTO verdicts VALUES($1,$2,$3,$4,$5,$6)', [id, binary(c), String(n), '1.0.0', `sample-signature-${id}`, JSON.stringify({ level: 'monitor' })]);
    await db.sql.query('INSERT INTO verdict_events VALUES($1,$2,$3,$4,$5)', [`${id}:created`, id, 'created', String(n), '{}']);
  }
  async function match(db: ChainDb, c: `0x${string}`, n: number, playbook: string, level = 'danger') {
    await db.sql.query('INSERT INTO playbook_matches VALUES($1,$2,$3,$4,$5)', [binary(c), String(n), '1.0.0', playbook, JSON.stringify({ id: playbook, level })]);
  }
  // Chain block n is on day n-1. At day 20.5 a three-day window keeps blocks after 18 (day 17).
  async function feedFixture() {
    const db = await database(); await migrateEngines(db);
    for (const t of [coin, other]) await token(db, t);
    for (let n = 1; n <= 21; n++) await block(db, n, n - 1);
    // Projection triggers write the Feed rows, as the engines do.
    await verdict(db, 'sample-verdict-a1', coin, 2); await verdict(db, 'sample-verdict-a2', coin, 5); await verdict(db, 'sample-verdict-a3', coin, 19);
    await match(db, coin, 4, 'deployer_dump', 'clear'); await match(db, coin, 6, 'deployer_dump'); await match(db, coin, 7, 'wash_to_trend'); await match(db, coin, 20, 'deployer_dump');
    await verdict(db, 'sample-verdict-b1', other, 3); await verdict(db, 'sample-verdict-b2', other, 9); await match(db, other, 8, 'deployer_dump', 'monitor');
    // A coin with no recorded first verdict keeps every verdict row.
    await db.sql.query('DELETE FROM read_first_verdict WHERE coin=$1', [binary(other)]);
    await db.sql.query("INSERT INTO read_feed VALUES($1,$2,1,'new_pair','{}',NULL),($3,$2,2,'graduation','{}',NULL)", [`token:${coin.slice(2)}`, binary(coin), `graduation:${coin.slice(2)}:2`]);
    return db;
  }

  it('deletes old verdict, playbook and wash rows, keeping recent rows, first verdicts, pair rows and every source', async () => {
    const db = await feedFixture(), sources = async () => (await db.sql.query<{ n: string }>('SELECT (SELECT count(*) FROM verdicts) || \':\' || (SELECT count(*) FROM verdict_events) || \':\' || (SELECT count(*) FROM playbook_matches) AS n')).rows[0]!.n;
    const before = await ids(db), counted = await sources();
    expect(before).toHaveLength(11);
    expect(await firstVerdict(db, coin)).toBe('2');
    const result = await runRetention(db, { dryRun: false, pauseMs: 0, quoteTokens: [], feedDays: 3, batchRows: 1, now: () => epoch + 20.5 * DAY });
    expect(result).toMatchObject({ feedRows: 4, finished: true });
    const deleted = ['sample-verdict-a2:created', matchId(coin, 6, 'deployer_dump'), matchId(coin, 7, 'wash_to_trend'), matchId(other, 8, 'deployer_dump')];
    expect(await ids(db)).toEqual(before.filter(id => !deleted.includes(id)));
    expect(await ids(db)).toEqual(expect.arrayContaining(['sample-verdict-a1:created', 'sample-verdict-a3:created', 'sample-verdict-b1:created', 'sample-verdict-b2:created',
      matchId(coin, 20, 'deployer_dump'), `token:${coin.slice(2)}`, `graduation:${coin.slice(2)}:2`]));
    expect(await sources()).toBe(counted);
    // A later verdict recomputes the first verdict from the remaining rows and still finds the original one.
    await verdict(db, 'sample-verdict-a4', coin, 21);
    expect(await firstVerdict(db, coin)).toBe('2');
    expect(await runRetention(db, { dryRun: false, pauseMs: 0, quoteTokens: [], feedDays: 3, now: () => epoch + 20.5 * DAY })).toMatchObject({ feedRows: 0, finished: true });
  });

  it('is off unless configured, caps its batches below the transfer batch size and stops at its time budget', async () => {
    const db = await feedFixture(), before = await ids(db);
    expect(await runRetention(db, { dryRun: false, pauseMs: 0, quoteTokens: [], now: () => epoch + 20.5 * DAY })).toMatchObject({ feedRows: 0, finished: true });
    expect(await ids(db)).toEqual(before);
    let clock = epoch + 20.5 * DAY;
    expect(await runRetention(db, { dryRun: false, pauseMs: 0, quoteTokens: [], feedDays: 3, budgetMs: 1, now: () => (clock += 1) })).toMatchObject({ feedRows: 0, finished: false });
    expect(await ids(db)).toEqual(before);
    // Each Feed delete statement removes at most FEED_BATCH_ROWS rows, however large batchRows is.
    expect(FEED_BATCH_ROWS).toBeLessThan(20_000);
    const statements: unknown[][] = [], transact=db.tx.bind(db);
    db.tx=fn=>transact(async tx=>{
      const query=tx.sql.query.bind(tx.sql);
      tx.sql.query=(async (sql:string,params?:unknown[])=>{if(sql.includes('DELETE FROM read_feed')){expect(sql).toContain('FOR UPDATE OF f SKIP LOCKED');statements.push(params ?? []);}return query(sql,params);}) as typeof tx.sql.query;
      return fn(tx);
    });
    expect(await runRetention(db, { dryRun: false, pauseMs: 0, quoteTokens: [], feedDays: 3, batchRows: 50_000, now: () => epoch + 20.5 * DAY })).toMatchObject({ feedRows: 4, finished: true });
    expect(statements).toHaveLength(1);
    expect((statements[0]![0] as unknown[]).length).toBeLessThanOrEqual(FEED_BATCH_ROWS);
  });
});
