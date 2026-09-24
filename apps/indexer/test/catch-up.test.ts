import { afterEach, describe, expect, it, vi } from 'vitest';
import { binary, chainTables, hex, migrate, ChainDb } from '@eko/db';
import { openDb } from '../../../packages/db/test/helpers/historical-db.js';
import { BlockDecoder } from '../src/decode.js';
import { LogHeadFollower } from '../src/log-head.js';
import { Metrics } from '../src/types.js';
import { blockOf, catchUpChain, coin, curve, memoryClient, registry, seedCatchUp, type Chain } from './catch-up-fixture.js';
const quiet = () => {};
const handles: ChainDb[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(handles.splice(0).map(db => db.close())); });
async function database() { const db = await openDb({ pgliteDir: ':memory:' }); handles.push(db); await migrate(db); await seedCatchUp(db); return db; }
type Config = ConstructorParameters<typeof LogHeadFollower>[3];
/** The follower as it ran before these optimizations: 20-block windows and commits, every parent read, public logs plus a paid timestamp scan, serial writes. */
const legacy = { maxRange: 20, catchUpRange: 20, commitRange: 20, deepParents: 'fetch', paidLogs: false, overlapWrites: false } as const;
const REORG = 32;
async function run(chain: Chain, head: bigint, config: Partial<Config>, db?: ChainDb, startBlock = 1n) {
  db ??= await database();
  const client = memoryClient(chain, () => head), ticks: Record<string, unknown>[] = [];
  const live = new LogHeadFollower(client, db, new BlockDecoder(client, registry, new Metrics(quiet), quiet), { startBlock, reorgDepth: REORG, pipeline: true, ...legacy, ...config,
    logger: (event, fields) => { if (event === 'head_tick') ticks.push(fields!); } });
  for (let i = 0; i < 500 && (await db.cursor('head_logs') ?? 0n) < head; i++) await live.tick();
  expect(await db.cursor('head_logs')).toBe(head);
  return { db, client, ticks, live };
}
/**
 * Every chain table and derived row (wallet-protocol rows without their wall-clock recorded_at), with
 * chain_blocks.parent_hash reported separately. Wallet-protocol rows record when the decoder's code cache last read a
 * target, which a rollback (it clears that cache) moves; `protocol: false` leaves them out, as log-head.test.ts does.
 */
async function snapshot(db: ChainDb, { protocol = true } = {}) {
  const tables: Record<string, unknown[]> = {};
  for (const table of [...chainTables.filter(t => protocol || !['userops', 'delegations_7702', 'wallet_protocol_coverage'].includes(t)), 'bars_1m', 'balances'] as const) {
    const rows = (await db.sql.query<Record<string, unknown>>(`SELECT * FROM ${table}`)).rows.map(r => ({ ...r, recorded_at: undefined, ...(table === 'chain_blocks' ? { parent_hash: undefined } : {}) }));
    tables[table] = rows.map(r => JSON.stringify(r)).sort();
  }
  const parents = new Map((await db.sql.query<{ number: string; parent_hash: Uint8Array | null }>('SELECT number,parent_hash FROM chain_blocks')).rows.map(r => [BigInt(r.number), r.parent_hash ? hex(r.parent_hash) : null]));
  return { tables, parents };
}

describe('live catch-up optimizations', () => {
  const chain = catchUpChain(400), head = 400n;
  it.each([
    ['larger catch-up windows', { catchUpRange: 160 }],
    ['larger commits', { commitRange: 60 }],
    ['overlapped writes over four commits per window', { overlapWrites: true, commitRange: 5 }],
    ['paid candidate logs', { paidLogs: true }],
    ['all of them', { catchUpRange: 160, commitRange: 60, overlapWrites: true, paidLogs: true }],
  ] as const)('stores identical rows with %s', async (_name, config) => {
    const before = await snapshot((await run(chain, head, {})).db), after = await run(chain, head, config);
    const rows = await snapshot(after.db);
    expect(rows.tables).toEqual(before.tables);
    expect(rows.parents).toEqual(before.parents);
    expect(before.tables.swaps.length).toBeGreaterThan(300);expect(before.tables.bars_1m.length).toBeGreaterThan(20);
  }, 60000);

  it('skips only parent links below the reorg window and stores every other row identically', async () => {
    const before = await snapshot((await run(chain, head, {})).db);
    const after = await run(chain, head, { deepParents: 'skip', catchUpRange: 160, commitRange: 60, overlapWrites: true, paidLogs: true });
    const rows = await snapshot(after.db);
    expect(rows.tables).toEqual(before.tables);
    const skipped = [...rows.parents].filter(([, parent]) => parent == null).map(([n]) => n);
    expect(skipped.length).toBeGreaterThan(30);
    for (const [n, parent] of rows.parents) {
      // Unrecorded only below the window, and only where the parent block had no candidate log; otherwise exact.
      if (parent == null) { expect(n).toBeLessThan(head - BigInt(REORG)); expect(chain.get(n - 1n)!.receipts).toHaveLength(0); }
      else expect(parent).toBe(before.parents.get(n));
    }
    // Inside the reorg window every missing parent is still read and checked.
    const window = [...rows.parents].filter(([n]) => n >= head - BigInt(REORG) && chain.get(n - 1n)!.receipts.length === 0);
    expect(window.length).toBeGreaterThan(2); expect(window.every(([, parent]) => parent != null)).toBe(true);
    expect(after.client.calls.parentHeader).toBe(window.length);
    expect(after.ticks.reduce((n, t) => n + Number(t.deep_links_skipped), 0)).toBe(skipped.length);
  }, 60000);

  it('rolls back and replays a reorg inside the reorg window with every optimization on', async () => {
    const optimized = { deepParents: 'skip', catchUpRange: 160, commitRange: 60, overlapWrites: true, paidLogs: true } as const;
    const live = new Map(chain), first = await run(live, head, optimized);
    // The last 12 blocks change hashes; the chain then grows by 10.
    for (let n = 389; n <= 410; n++) live.set(BigInt(n), blockOf(n, 1, n === 389 ? 0 : 1));
    const replay = await run(live, 410n, optimized, first.db);
    expect(await replay.db.blockHash(399n)).toBe(live.get(399n)!.block.hash);
    const truth = await snapshot((await run(live, 410n, {})).db, { protocol: false }), rows = await snapshot(replay.db, { protocol: false });
    expect(rows.tables).toEqual(truth.tables);
    for (const [n, parent] of rows.parents) if (parent != null) expect(parent).toBe(truth.parents.get(n));
    for (const [n, parent] of rows.parents) if (n >= 410n - BigInt(REORG)) expect(parent).not.toBeNull();
  }, 60000);

  it('reads candidate logs in spans the provider accepts, without dropping or repeating a refusal', async () => {
    const client = memoryClient(chain, () => head), logs = client.logs, spans: number[] = [];
    client.logs = async filter => { const span = Number(filter.to - filter.from + 1n); spans.push(span); if (!filter.addresses && span > 48) throw new Error('logs matched by query exceeds limit of 10000'); return logs(filter); };
    const db = await database(), ticks: Record<string, unknown>[] = [];
    const follower = new LogHeadFollower(client, db, new BlockDecoder(client, registry, new Metrics(quiet), quiet), { startBlock: 1n, reorgDepth: REORG, pipeline: true, ...legacy, catchUpRange: 160, logger: (event, fields) => { if (event === 'head_tick') ticks.push(fields!); } });
    for (let i = 0; i < 100 && (await db.cursor('head_logs') ?? 0n) < head; i++) await follower.tick();
    expect(await db.cursor('head_logs')).toBe(head);
    expect((await snapshot(db)).tables).toEqual((await snapshot((await run(chain, head, {})).db)).tables);
    // After the first refusal (160 → 80 → 40) later windows ask for at most the accepted span.
    const refused = spans.filter(s => s > 48);
    expect(refused).toEqual([160, 80]);
    expect(ticks.slice(1).every(t => Number(t.log_span) <= 80)).toBe(true);
  }, 60000);

  it('grows the window far behind and returns to the head window near it', async () => {
    const { ticks } = await run(chain, head, { catchUpRange: 160 });
    // 400 blocks behind: 160, 160, then the remaining 80 (still more than two head windows behind).
    expect(ticks.map(t => t.blocks_covered)).toEqual([160, 160, 80]);
    const near = await run(chain, head, { catchUpRange: 160 }, undefined, 365n);
    expect(near.ticks.map(t => t.blocks_covered)).toEqual([20, 16]);
  }, 60000);
  it('records a Pons curve trade in its launch pair token and prices a USDG pair at par', async () => {
    // 2026-10-11: about one Pons launch in ten pairs its curve with USDG, a stock token or another Pons coin, and every
    // curve trade was recorded as an ETH quote.
    const usdg = registry.requireAddress('tokens.USDG'), db = await database();
    await db.insert('pons_events', { block: '0', tx_hash: binary(`0x${'ab'.repeat(32)}`), log_index: 0, token: binary(coin(1)), emitter: binary(curve(1)), kind: 'launch',
      data: JSON.stringify({ kind: 'launch', token: coin(1), curve: curve(1), pairToken: usdg }) });
    await run(catchUpChain(100), 100n, {}, db);
    const trades = (await db.sql.query<{ coin: Uint8Array; quote: Uint8Array; amount_quote: string; usd: number | null }>(
      "SELECT coin,quote_asset AS quote,amount_quote,usd FROM swaps WHERE venue='pons_curve' AND coin=ANY($1::bytea[]) ORDER BY block", [[coin(1), coin(3)].map(binary)])).rows;
    const paired = trades.filter(t => hex(t.coin) === coin(1).toLowerCase()), native = trades.filter(t => hex(t.coin) === coin(3).toLowerCase());
    expect(paired.length).toBeGreaterThan(0); expect(native.length).toBeGreaterThan(0);
    for (const t of paired) { expect(hex(t.quote)).toBe(usdg.toLowerCase()); expect(t.usd).toBeCloseTo(Number(t.amount_quote) / 1e6, 6); }
    for (const t of native) expect(hex(t.quote)).toBe('0x0000000000000000000000000000000000000000');
  }, 60000);
  it('reads a curve pair token\'s missing decimals when its curve trades, once, and records them', async () => {
    // 2026-10-11: 41 of 65 pair tokens had no decimals, because no indexed pool named them, so their curves' swaps
    // could not be priced. The fixture client answers metadata with 18 decimals.
    const pair = '0x00000000000000000000000000000000000000a1' as const, db = await database();
    await db.insert('tokens', { address: binary(pair), first_block: '0', block: '0' });
    await db.insert('pons_events', { block: '0', tx_hash: binary(`0x${'ac'.repeat(32)}`), log_index: 0, token: binary(coin(1)), emitter: binary(curve(1)), kind: 'launch',
      data: JSON.stringify({ kind: 'launch', token: coin(1), curve: curve(1), pairToken: pair }) });
    const chain = catchUpChain(100), client = memoryClient(chain, () => 100n), read = client.tokenMetadata, asked: string[] = [];
    client.tokenMetadata = async (address, n) => { asked.push(address.toLowerCase()); return read(address, n); };
    const follower = new LogHeadFollower(client, db, new BlockDecoder(client, registry, new Metrics(quiet), quiet), { startBlock: 1n, reorgDepth: REORG, pipeline: true, ...legacy, catchUpRange: 160 });
    for (let i = 0; i < 100 && (await db.cursor('head_logs') ?? 0n) < 100n; i++) await follower.tick();
    expect((await db.sql.query<{ decimals: number | null }>('SELECT decimals FROM tokens WHERE address=$1', [binary(pair)])).rows[0]!.decimals).toBe(18);
    expect(asked.filter(a => a === pair).length).toBe(1);
    const trades = (await db.sql.query<{ quote: Uint8Array }>("SELECT quote_asset AS quote FROM swaps WHERE venue='pons_curve' AND coin=$1", [binary(coin(1))])).rows;
    expect(trades.length).toBeGreaterThan(0); for (const t of trades) expect(hex(t.quote)).toBe(pair);
  }, 60000);
});
