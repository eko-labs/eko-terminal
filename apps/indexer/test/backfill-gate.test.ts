import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { binary, migrate, type ChainDb } from '@eko/db';
import { openDb } from '../../../packages/db/test/helpers/historical-db.js';
import { captureBackfillSnapshot } from '../src/backfill-gate-snapshot.js';
import { GateSnapshotSchema, rangeGaps, verifyBackfill, type GateSnapshot } from '../src/backfill-gate.js';
const load = () => GateSnapshotSchema.parse(JSON.parse(readFileSync(new URL('./fixtures/backfill-gate/snapshot.json', import.meta.url), 'utf8')));
const handles: ChainDb[] = [];
afterEach(async () => { await Promise.all(handles.splice(0).map(db => db.close())); });
const finding = (snapshot: GateSnapshot, check: string) => verifyBackfill(snapshot).findings.find(f => f.check === check)!;

describe('launch backfill evidence', () => {
  it('merges only inclusive completed intervals, preserving holes and failed work', () => {
    expect(rangeGaps(0n, 9n, [{ from: '0', to: '2', status: 'done' }, { from: '2', to: '4', status: 'done' }, { from: '6', to: '9', status: 'failed' }])).toEqual([{ from: '5', to: '9' }]);
    expect(rangeGaps(0n, 9n, [{ from: '0', to: '4', status: 'done' }, { from: '5', to: '9', status: 'done' }])).toEqual([]);
  });
  it('verifies fixture arithmetic but leaves missing manifests and human review unresolved', () => {
    const s = load(), r = verifyBackfill(s);
    expect(finding(s, 'supply-' + s.plan.tokens[0]).status).toBe('verified');
    expect(finding(s, 'calendar-recent').status).toBe('verified');
    expect(r.status).toBe('unresolved'); expect(r.origin).toBe('fixture'); expect(r.liveApproved).toBe(false);
    expect(r.findings.filter(f => ['incident-53-launches', 'clone-fixtures', '50-deployer-histories'].includes(f.check)).every(f => f.status === 'unresolved')).toBe(true);
  });
  it('cannot promote a 200k replay, a shortened calendar, or a different target-set hash', () => {
    const s = load(); s.plan.head.block = '75000000'; s.ranges.forEach(r => { r.from = '74800001'; r.to = '75000000'; });
    expect(finding(s, 'coverage-ponsFactory').status).toBe('unresolved');
    expect(finding(s, 'coverage-swaps').status).toBe('unresolved');
    const short = load(); short.plan.recent = short.plan.sevenDay;
    expect(finding(short, 'calendar-recent').status).toBe('failed');
    const wrong = load(); wrong.ranges.find(r => r.stream === wrong.plan.streams.holders)!.stream = 'logs:holders:old-set';
    expect(finding(wrong, 'coverage-holders').status).toBe('unresolved');
  });
  it('reports stale leases, duplicate identities and orphaned checkpoints', () => {
    const s = load(); const r = s.ranges[0]; r.status = 'leased'; r.leaseOwner = 'sample-worker'; r.leaseUntil = '2026-09-01T00:00:00.000Z';
    expect(finding(s, 'coverage-ponsFactory').status).toBe('unresolved');
    s.inventories.find(i => i.table === 'swaps')!.duplicates = '1';
    expect(finding(s, 'duplicates-swaps').status).toBe('failed');
    s.checkpoints[0].canonicalHash = `0x${'f'.repeat(64)}`;
    expect(finding(s, 'reorg-checkpoints').status).toBe('unresolved');
  });
  it('uses exact integer reconciliation, retains sink inventory, and rejects stale supply and missing creation coverage', () => {
    const s = load(), token = s.plan.tokens[0]; s.supplies[0].held = (BigInt(s.supplies[0].held) - 1n).toString();
    expect(finding(s, `supply-${token}`).status).toBe('failed');
    const stale = load(); stale.supplies[0].supplyBlock = '89';
    expect(finding(stale, `supply-${token}`).status).toBe('unresolved');
    const partial = load(); partial.ranges.find(r => r.stream === partial.plan.streams.holders)!.from = '60';
    expect(finding(partial, `supply-${token}`).status).toBe('unresolved');
    const mismatch = load(); mismatch.supplies[0].mismatchedHolders = '1';
    expect(finding(mismatch, `supply-${token}`).status).toBe('failed');
  });
  it('requires fallback candidate funding, pricing and minute reconciliation', () => {
    const s = load(); s.ranges = s.ranges.filter(r => r.stream !== s.plan.streams.candidateFunding);
    expect(finding(s, 'coverage-candidateFunding').status).toBe('unresolved');
    s.candles.mismatches = '1'; expect(finding(s, 'candles').status).toBe('failed');
    s.candles.mismatches = '0'; s.candles.unpricedSwaps = '1'; expect(finding(s, 'candles').status).toBe('unresolved');
  });
  it('keeps invalidated or future Guard availability manifests unresolved', () => {
    const s = load(); s.guardSources = [{ id: `0x${'a'.repeat(64)}`, sourceRevision: `0x${'b'.repeat(64)}`, replayMode: 'retrospective', cutBlock: '90', watermarkBlock: '90', invalidations: '0', contentHash: `0x${'c'.repeat(64)}` }];
    expect(finding(s, 'guard-availability').status).toBe('verified');
    s.guardSources[0].invalidations = '1'; expect(finding(s, 'guard-availability').status).toBe('unresolved');
    s.guardSources[0].invalidations = '0'; s.guardSources[0].cutBlock = '91';
    expect(finding(s, 'guard-availability').status).toBe('unresolved');
  });
  it('preserves existing opaque Guard manifests by hash without fabricating acceptance', () => {
    const m = { frame: 'sample-frame', launches: [] }, r = verifyBackfill(load(), [{ owner: '057', content: m }]);
    expect(r.findings.find(f => f.check === 'guard-057')).toMatchObject({ status: 'unresolved', detail: { manifests: [{ hash: expect.stringMatching(/^0x[0-9a-f]{64}$/) }] } });
  });
  it('reports measured catch-up and p95 tied to the candidate, with no inferred live approval', () => {
    const s = load(); s.follower = { sourceRevision: s.plan.candidateRevision, startedAt: '2026-10-01T00:00:00.000Z', endedAt: '2026-10-01T00:04:00.000Z', startHead: '3000', startCursor: '1000', endHead: '5400', endCursor: '5400', headLagMs: [200, 900], paidUnits: 1, costUsd: .000006, logHash: `0x${'a'.repeat(64)}` };
    expect(finding(s, 'follower').status).toBe('verified');
    s.follower.sourceRevision = 'other'; expect(finding(s, 'follower').status).toBe('unresolved');
  });
  it('refuses event-by-event backfill evidence after transfer history has been compacted',async()=>{
    const db=await openDb({pgliteDir:':memory:'});handles.push(db);await migrate(db);
    await db.sql.query("UPDATE raw_history_watermarks SET through_block=1 WHERE name='token_transfers'");
    await expect(captureBackfillSnapshot(db,load().plan,{origin:'fixture',checkpoint:'compacted'})).rejects.toThrow('use an archive');
  });
  it('exports bounded read-only database evidence and diagnoses a missing transfer baseline', async () => {
    const db = await openDb({ pgliteDir: ':memory:' }); handles.push(db); await migrate(db);
    const seed = load(), plan = seed.plan, token = plan.tokens[0], owner = `0x${'2'.repeat(40)}`, zero = `0x${'0'.repeat(40)}`;
    await db.insert('tokens', { address: binary(token), decimals: 0, first_block: '0', block: '0', total_supply: '9', supply_block: plan.head.block });
    await db.insert('token_transfers', { token: binary(token), from_address: binary(zero), to_address: binary(owner), amount: '9', ts: new Date(plan.head.timestamp), block: plan.head.block, tx_hash: binary(`0x${'3'.repeat(64)}`), log_index: 0 });
    await db.sql.query('INSERT INTO balances VALUES($1,$2,$3,$4),($1,$5,$6,$4)', [binary(token), binary(owner), '9', plan.head.block, binary(zero), '-9']);
    for (const h of seed.headers) await db.insert('chain_blocks', { number: h.block, block: h.block, hash: binary(h.hash), parent_hash: binary(h.hash), ts: new Date(h.timestamp) });
    await db.setCursor('head', BigInt(plan.head.block), plan.head.hash as `0x${string}`);
    const snapshot = await captureBackfillSnapshot(db, plan, { origin: 'fixture', checkpoint: 'sample-checkpoint', capturedAt: seed.capturedAt });
    expect(snapshot.supplies[0]).toMatchObject({ minted: '9', burned: '0', held: '9', negativeHolders: '0', mismatchedHolders: '0' });
    expect(finding(snapshot, `supply-${token}`).status).toBe('unresolved');
    expect(snapshot.candles).toEqual({ expected: '0', actual: '0', mismatches: '0', unpricedSwaps: '0' });
    expect((await db.sql.query('SELECT count(*)::text AS n FROM tokens')).rows).toEqual([{ n: '1' }]);
    plan.maxRows = 1;
    await expect(captureBackfillSnapshot(db, plan, { origin: 'fixture', checkpoint: 'bounded' })).rejects.toThrow('Evidence row bound exceeded');
  });
  it('reconciles true burns, dead-sink inventory and self-transfers without double counting WETH movements', async () => {
    const db = await openDb({ pgliteDir: ':memory:' }); handles.push(db); await migrate(db);
    const seed = load(), token = seed.plan.tokens[0], owner = `0x${'2'.repeat(40)}`, zero = `0x${'0'.repeat(40)}`, sink = `0x${'0'.repeat(36)}dead`;
    await db.insert('tokens', { address: binary(token), decimals: 0, first_block: '0', block: '0', total_supply: '80', supply_block: '90' });
    for (const [index, [from, to, amount, kind]] of ([
      [zero, owner, '100', 'Transfer'], [owner, zero, '20', 'Transfer'], [owner, sink, '10', 'Transfer'],
      [owner, owner, '30', 'Transfer'], [zero, owner, '100', 'Deposit'],
    ] as const).entries()) await db.insert('token_transfers', { token: binary(token), from_address: binary(from), to_address: binary(to), amount, kind, ts: new Date(seed.plan.head.timestamp), block: '90', tx_hash: binary(`0x${'3'.repeat(64)}`), log_index: index });
    for (const [holder, amount] of [[zero, '-80'], [owner, '70'], [sink, '10']]) await db.sql.query('INSERT INTO balances VALUES($1,$2,$3,$4)', [binary(token), binary(holder), amount, '90']);
    const snapshot = await captureBackfillSnapshot(db, seed.plan, { origin: 'fixture', checkpoint: 'burn-reconciliation' });
    expect(snapshot.supplies[0]).toMatchObject({ minted: '100', burned: '20', held: '80', mismatchedHolders: '0', transferRows: '4' });
    await db.sql.query('UPDATE balances SET amount=69 WHERE holder=$1', [binary(owner)]);
    const broken = await captureBackfillSnapshot(db, seed.plan, { origin: 'fixture', checkpoint: 'mismatch' });
    expect(broken.supplies[0].mismatchedHolders).toBe('1');
    expect(finding(broken, `supply-${token}`).status).toBe('failed');
  });
  it('detects cross-timestamp duplicate event identities and missing or changed candle aggregates', async () => {
    const db = await openDb({ pgliteDir: ':memory:' }); handles.push(db); await migrate(db);
    const seed = load(), token = seed.plan.tokens[0];
    await db.insert('tokens', { address: binary(token), decimals: 0, first_block: '0', block: '0' });
    const a = `0x${'2'.repeat(40)}`, tx = `0x${'4'.repeat(64)}`, pool = `0x${'5'.repeat(64)}`;
    for (const seconds of [0, 1]) await db.insert('swaps', { ts: new Date(Date.parse(seed.plan.head.timestamp) + seconds * 1000), block: '90', tx_hash: binary(tx), log_index: 0,
      venue: 'uniswap_v3', pool_id: binary(pool), coin: binary(token), quote_asset: binary(a), trader: binary(a), tx_from: binary(a), tx_to: binary(a), side: 1,
      amount_coin: '2', amount_quote: '4', price_quote: 2, usd: 4 });
    const snapshot = await captureBackfillSnapshot(db, seed.plan, { origin: 'fixture', checkpoint: 'candle-check' });
    expect(snapshot.inventories.find(i => i.table === 'swaps')).toMatchObject({ rows: '2', duplicates: '1' });
    expect(snapshot.candles).toEqual({ expected: '1', actual: '0', mismatches: '1', unpricedSwaps: '0' });
    await db.sql.query('INSERT INTO bars_1m VALUES($1,$2,2,2,2,2,8,2,90,90)', [binary(token), new Date(seed.plan.head.timestamp)]);
    const present = await captureBackfillSnapshot(db, seed.plan, { origin: 'fixture', checkpoint: 'candle-present' });
    expect(present.candles.mismatches).toBe('0');
    await db.sql.query('UPDATE bars_1m SET close=3');
    const changed = await captureBackfillSnapshot(db, seed.plan, { origin: 'fixture', checkpoint: 'candle-changed' });
    expect(changed.candles.mismatches).toBe('1');
  });

});
