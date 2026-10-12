// Synthetic acquisition envelopes and local PGlite only; no live monitoring evidence.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { binary, publishReceipt, runRetention } from '@eko/db';
import { enqueueOutcomeLabels, runOutcomeMaturityQueue, outcomeStreamKey, invalidateOutcomeDependency } from '@eko/engines';
import { ScoreboardResponseSchema, type Address, type PublicReceiptPayload, type TradeQuote, type AvailabilityCut } from '@eko/shared';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { provisionHistory } from '../../../packages/db/test/helpers/historical-db.js';
import { ScoreboardService } from '../src/read/scoreboard.js';
import { outcomeFixture, confirmation } from '../../engines/test/outcome-fixtures.js';
import { hash } from '../../../packages/chain/test/reference-fixtures.js';
import { accounts, tradeOrders, tradeQuotes, tradeGuardMisses, auditLog } from '../src/db/schema.js';
const quoteFixture: TradeQuote = { id:'fixture', coin:'0x000000000000000000000000000000000000000a', side:'buy', amountUsd:100, binding:true, amountIn:'100', valueWei:'0', networkFeeUsd:0, route:{venue:'uniswap_v3',executable:true}, expectedOut:'1000',minOut:'900',priceImpactBps:0,buyTaxPct:0,sellTaxPct:0,exitCostPct:0,fee:{bps:0,usd:0,destination:null},approvals:[],guard:{decision:'allow',checks:[]},expiresAt:'2026-10-05T00:00:20.000Z',asOfBlock:98 };

const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;
const week = Date.parse('2026-10-05T00:00:00.000Z'), now = week + 7 * 86400000 + 60000;
let built: Awaited<ReturnType<typeof buildApp>>;
const db = () => built.ctx.dbh.chain;
const service = () => built.ctx.reads.scoreboard;
const stamp = (time: number) => new Date(time).toISOString();
const coverage = (id: string, from = week, through = now) => ({ id: hash(id), from: stamp(from), through: stamp(through), refused: true, missed: true, origin: 'measured', evidenceIds: [hash('coverage-proof')] });
const block = (n: number, time: number) => ({ chainId: 4663 as const, blockNumber: String(n), blockHash: hash(`scoreboard-block-${n}`), timestampSec: String(Math.floor(time / 1000)), boundary: 'block_end' as const, transactionIndex: null, executionOrdinal: null });
const coin = address(10), wallet = address(20);
const input = outcomeFixture(undefined, 86400);
// Translate every cursor, preserving 051's complete block/checkpoint boundaries.
const retime = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(retime);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, value]) => [k, k === 'timestampSec' ? String(Number(value) + week / 1000 - 940) : retime(value)]));
  return v;
};
const measured = retime(input) as typeof input;
measured.origin = 'measured'; measured.calibrated = true;
measured.entries.forEach(e => e.fidelityAccepted = true); measured.checkpoints.forEach(e => e.fidelityAccepted = true);
const matureCut = confirmation(measured), cohortCut: AvailabilityCut = { cursor: block(4000, now), acquisitionSequence: '10' };

async function publication(id: string, target: Address, level: 'clear' | 'danger' | 'monitor', at: number, stateBlock = 100) {
  const data: PublicReceiptPayload = { schemaVersion: 'public-receipt-1', canonicalization: 'jcs-rfc8785/v1', receiptId: id, revisionId: id,
    kind: 'verdict', chainId: 4663, coin: target, recordedAt: stamp(at), modelIds: [], personaSetVersion: null,
    cardSchemaVersion: 'fixture-card-1', rulesVersion: '1.0.0', outputSchemaVersion: '1.0.0', snapshotHash: hash('{}'), deterministicInput: {},
    decision: { coin: target, level, reasons: [], playbooks: [], schemaVersion: '1.0.0', asOfBlock: stateBlock },
    window: { kind: 'snapshot', blockNumber: stateBlock, blockHash: await db().blockHash(BigInt(stateBlock)) }, supersedes: null, reorgOf: null };
  await publishReceipt(db(), 'engines', data);
  return data;
}
async function cutBlock(c: AvailabilityCut['cursor']) {
  await db().insert('chain_blocks', { number: c.blockNumber, block: c.blockNumber, hash: binary(c.blockHash), parent_hash: binary(hash('parent')), ts: new Date(Number(c.timestampSec) * 1000) });
}
beforeAll(async () => {
  built = await buildApp(loadConfig({ NODE_ENV: 'test', PGLITE_DIR: ':memory:', SESSION_SECRET: 'fixture-placeholder'.repeat(3), LEGACY_API: 'false', RUN_WORKER: 'false', MARKET_DATA_SOURCE: 'onchain' }), { startBackground: false });
  built.ctx.reads.store.now = () => now;
  await db().insertMany('chain_blocks', [...measured.boundaries.map(b => b.cursor), matureCut.cursor, cohortCut.cursor].map(c => ({ number: c.blockNumber, block: c.blockNumber, hash: binary(c.blockHash), parent_hash: binary(hash('parent')), ts: new Date(Number(c.timestampSec) * 1000) })));
}, 30000);
afterAll(async () => { await built?.close(); });

it('publishes a typed unavailable record, validates queries, and keeps D0 milestones and forecasts unavailable', async () => {
  const res = await built.app.inject('/v1/scoreboard');
  expect(res.statusCode).toBe(200);
  const page = ScoreboardResponseSchema.parse(res.json());
  expect(page.rows).toEqual([]); expect(page.counters).toEqual({ refused: null, missed: null, since: null });
  expect(page.availability.missed).toEqual({ status: 'unavailable', reason: 'monitoring_missing' });
  expect(page.availability.forecasts).toEqual({ status: 'unavailable', reason: 'forecast_dependency' });
  expect((await built.app.inject('/v1/scoreboard?kind=milestones')).json().availability.milestones.reason).toBe('d0_gated');
  for (const q of ['kind=unknown', 'limit=101', 'cursor=invalid', 'extra=1']) expect((await built.app.inject(`/v1/scoreboard?${q}`)).statusCode).toBe(422);
});
it('shows real observation start and measured empty zeros only under complete monitoring', async () => {
  await service().recordCoverage(coverage('first'));
  await service().recordCoverage(coverage('first'));
  const page = await service().list('honeypots_missed');
  expect(page.counters).toEqual({ refused: 0, missed: 0, since: stamp(week) });
  expect(page.availability.missed.status).toBe('observed');
  await expect(service().recordCoverage({ ...coverage('fixture'), origin: 'fixture' })).rejects.toThrow();
  await expect(db().sql.query('UPDATE scoreboard_records SET data=data')).rejects.toThrow('append-only');
  await expect(db().sql.query('DELETE FROM scoreboard_records')).rejects.toThrow('append-only');
});
it('consumes a measured missed fill once, preserves private evidence, and appends its post-mortem', async () => {
  const [owner] = await built.ctx.dbh.db.insert(accounts).values({ kind: 'wallet', walletAddress: wallet }).returning();
  const q = { ...quoteFixture, id: '00000000-0000-4000-8000-000000000001', coin, side: 'buy' as const, account: wallet, amountUsd: 100 };
  await built.ctx.dbh.db.insert(tradeQuotes).values({ id: q.id, accountId: owner!.id, wallet,
    input: { coin, side: 'buy', amountUsd: 100, slippageBps: 100, account: wallet }, quote: q, quotedAt: new Date(week), expiresAt: new Date(week + 1000) });
  const evidence = { status: 'failed' as const, origin: 'measured' as const, chainId: 4663 as const, account: wallet,
    txHash: hash('miss-tx'), blockHash: measured.launchCursor.blockHash, blockNumber: measured.launchCursor.blockNumber,
    amount: '1000', checkedAt: stamp(week), evidenceIds: [hash('sell-proof')], code: 'sell_failed' as const };
  const [order] = await built.ctx.dbh.db.insert(tradeOrders).values({ accountId: owner!.id, quoteId: q.id,
    idempotencyKey: 'fixture-miss', requestBody: '{}', orderHash: hash('order'), coin, side: 'buy', feeBps: 0,
    status: 'confirmed', txHash: evidence.txHash, filledIn: '100', filledOut: '1000', postFillEvidence: evidence }).returning();
  const [incident] = await built.ctx.dbh.db.insert(auditLog).values({ action: 'ops.incident', data: { kind: 'guard_miss' } }).returning();
  await built.ctx.dbh.db.insert(tradeGuardMisses).values({ orderId: order!.id, incidentId: incident!.id,
    createdAt: new Date(week + 1000), payload: { guardReceiptId: 'fixture-receipt', account: wallet, calldata: 'private fixture bytes' } });
  const before = (await db().sql.query('SELECT * FROM trade_guard_misses')).rows;
  for (let n = 0; n < 2; n++) expect((await service().list('honeypots_missed')).counters.missed).toBe(1);
  const page = await service().list('honeypots_missed');
  expect(page.rows).toHaveLength(1); expect(JSON.stringify(page)).not.toContain(wallet); expect(JSON.stringify(page)).not.toContain('private fixture bytes');
  expect(page.rows[0]!.detail.postMortemStatus).toBe('pending');
  await service().attachPostMortem(order!.id, '/post-mortems/fixture-miss', [hash('review')]);
  const next = await service().list('honeypots_missed');
  expect(next.rows).toHaveLength(2); expect(next.counters.missed).toBe(1);
  expect(next.rows[0]!.detail).toMatchObject({ postMortemStatus: 'published', postMortemUrl: '/post-mortems/fixture-miss', correctionOf: page.rows[0]!.id });
  expect((await db().sql.query('SELECT * FROM trade_guard_misses')).rows).toEqual(before);
});
it('does not count unavailable sell monitoring, informational refusals, scans or incident drafts as confirmed fills', async () => {
  await publication('call-fixture', coin, 'clear', week + 60000);
  const page = await service().list('calls');
  expect(page.rows).toHaveLength(1); expect(page.rows[0]!.grade).toBeUndefined();
  expect(page.counters.refused).toBe(0);
  await expect(service().recordRefusal('00000000-0000-4000-8000-000000000001', { id: hash('refusal'), coin, account: wallet,
    cut: measured.availabilityCut, origin: 'measured', failure: 'token_enforced', independentlyReproduced: true, temporaryResolved: true, evidenceIds: [hash('refusal-proof')] })).rejects.toThrow('bind');
});
it('counts an independently confirmed account-bound token refusal once and rejects provider or unresolved proof', async () => {
  const original = (await built.ctx.dbh.db.select().from(tradeQuotes))[0]!;
  const id = '00000000-0000-4000-8000-000000000002';
  await built.ctx.dbh.db.insert(tradeQuotes).values({ ...original, id,
    quote: { ...original.quote, id, binding:false, guard:{decision:'refuse',checks:[{code:'honeypot',status:'refuse',label:'Token restriction observed'}]} },
    checked: { order:{ execution:{guardReceiptId:'fixture-guard-receipt'} } } as never });
  const proof = { id:hash('measured-refusal'),coin,account:wallet,cut:{cursor:measured.launchCursor,acquisitionSequence:'1'},
    origin:'measured',failure:'token_enforced',independentlyReproduced:true,temporaryResolved:true,evidenceIds:[hash('restriction-proof')] };
  await expect(service().recordRefusal(id,{...proof,failure:'provider'})).rejects.toThrow();
  await expect(service().recordRefusal(id,{...proof,temporaryResolved:false})).rejects.toThrow();
  await service().recordRefusal(id,proof);await service().recordRefusal(id,proof);
  const page=await service().list('honeypots_refused');
  expect(page.rows).toHaveLength(1);expect(page.counters.refused).toBe(1);
  const [failed]=await built.ctx.dbh.db.insert(tradeOrders).values({accountId:original.accountId,quoteId:id,idempotencyKey:'unavailable-fixture',
    requestBody:'{}',orderHash:hash('unavailable-order'),coin,side:'buy',feeBps:0,status:'confirmed',filledOut:'1000',txHash:hash('unavailable-tx'),
    postFillEvidence:{status:'unavailable',origin:'unavailable',chainId:4663,account:wallet,txHash:hash('unavailable-tx'),
      blockHash:measured.launchCursor.blockHash,blockNumber:'98',amount:'1000',checkedAt:stamp(week),evidenceIds:[],code:'sim_unavailable'}}).returning();
  const [incident]=await built.ctx.dbh.db.insert(auditLog).values({action:'ops.incident',data:{kind:'guard_miss'}}).returning();
  await built.ctx.dbh.db.insert(tradeGuardMisses).values({orderId:failed!.id,incidentId:incident!.id,payload:{},createdAt:new Date(week)});
  expect((await service().list('honeypots_missed')).counters.missed).toBe(1);
});
it('grades accepted mature 051 outcomes, retains original publications, and rejects immature and fixture revisions', async () => {
  await enqueueOutcomeLabels(db(), measured, 'a'.repeat(40));
  const stream = outcomeStreamKey(measured);
  await expect(service().acceptOutcome(stream, measured.availabilityCut, [hash('accepted')])).rejects.toThrow('mature');
  await runOutcomeMaturityQueue(db(), matureCut);
  const originals = (await db().sql.query('SELECT * FROM receipt_publications')).rows;
  expect((await service().list('calls')).rows.some(r => r.grade)).toBe(false);
  const labelId = await service().acceptOutcome(stream, matureCut, [hash('accepted')]);
  await service().acceptOutcome(stream, matureCut, [hash('accepted')]);
  const grades = (await service().list('calls')).rows.filter(r => r.detail.event === 'grade');
  expect(grades).toHaveLength(1); expect(grades[0]).toMatchObject({ grade: 'hit', detail: { outcomeRevision: labelId, horizonSec: 86400 } });
  expect((await db().sql.query('SELECT * FROM receipt_publications')).rows).toEqual(originals);
  const fixture = { ...measured, origin: 'fixture' as const, coin: address(40) };
  await enqueueOutcomeLabels(db(), fixture, 'a'.repeat(40)); await runOutcomeMaturityQueue(db(), matureCut);
  await expect(service().acceptOutcome(outcomeStreamKey(fixture), matureCut, [hash('fixture-review')])).rejects.toThrow('measured');
});
it('publishes all-launch and Clear cohorts at the known-at cut, with censoring, immature members and metric denominators', async () => {
  const censored = { ...structuredClone(measured), coin: address(30) }; censored.coverage.archive = false;
  await enqueueOutcomeLabels(db(), censored, 'a'.repeat(40)); await runOutcomeMaturityQueue(db(), matureCut);
  await service().acceptOutcome(outcomeStreamKey(censored), matureCut, [hash('censored-review')]);
  await cutBlock(block(3500, week + 7 * 86400000 - 60000));
  for (const [target, first] of [[coin, '98'], [address(30), '98'], [address(50), '3500'], [address(60), '98']] as const)
    await db().insert('tokens', { address: binary(target), first_block: first, block: first, launchpad: 'other' });
  await publication('late-clear', address(30), 'clear', week + 120000);
  await publication('future-clear', address(60), 'clear', now + 1000);
  const args = { week: stamp(week), cut: cohortCut, origin: 'measured', launchCoverageComplete: true, evidenceIds: [hash('universe')], outcomeVersion: '2.0.0', identityVersion: '1.0.0' };
  await service().publishCohort(args); await service().publishCohort(args);
  const rows = (await service().list('cohort')).rows; expect(rows).toHaveLength(2);
  expect(rows.find(r => r.detail.group === 'all')!.detail).toMatchObject({ eligible: 4, evaluated: 1, censored: 1, immature: 1, ungraded: 1, rugDenominator: 1, medianDenominator: 1, medianOutcomePct: -20 });
  expect(rows.find(r => r.detail.group === 'clear')!.detail).toMatchObject({ eligible: 1, evaluated: 1, censored: 0, immature: 0, ungraded: 0 });
  // Weekly cohorts and accepted outcomes must survive the one-day raw and payload windows.
  await provisionHistory(db(),new Date(week));
  await db().insert('swaps',{ts:new Date(week),block:98,tx_hash:binary(hash('old-scoreboard-trade')),log_index:0,
    venue:'uniswap_v3',pool_id:binary(address(90)),coin:binary(coin),quote_asset:binary(address(0)),trader:binary(wallet),side:1,amount_coin:'1',amount_quote:'1',price_quote:1,usd:1});
  await runRetention(db(),{quoteTokens:[],swapDays:1,transferDays:1,ratingDays:1,receiptHours:24,dryRun:false,pauseMs:0,now:()=>now});
  expect((await db().sql.query('SELECT 1 FROM swaps WHERE ts<$1',[new Date(now-86400000)])).rows).toEqual([]);
  expect((await db().sql.query("SELECT data FROM receipt_publications WHERE id='call-fixture'")).rows).toEqual([{data:null}]);
  const fresh=new ScoreboardService(db(),()=>now),query=db().sql.query.bind(db().sql);
  db().sql.query=async(sql,params)=>{
    if (/\b(?:swaps|coin_cards)\b/.test(sql)) throw new Error('Scoreboard must use retained summaries');
    return query(sql,params);
  };
  try {
    await fresh.publishCohort(args);
    expect((await fresh.list('cohort')).rows).toEqual(rows);
    expect((await fresh.list('calls')).rows.some(r=>r.detail.event==='grade' && r.grade==='hit')).toBe(true);
  } finally {db().sql.query=query;}

});
it('retains original calls and grades and appends corrections after withdrawal and source invalidation', async () => {
  const original = (await db().sql.query('SELECT * FROM receipt_publications WHERE id=$1', ['call-fixture'])).rows;
  await db().sql.query(`INSERT INTO verdicts(id,coin,valid_from_block,rules_version,signature,data) VALUES($1,$2,100,'1.0.0','fixture',$3)`, ['call-fixture', binary(coin), JSON.stringify({ coin, level: 'clear', reasons: [], playbooks: [], schemaVersion: '1.0.0', asOfBlock: 100, receipt: { id: 'call-fixture', hash: hash('call-fixture'), status:'pending' } })]);
  await db().sql.query(`INSERT INTO verdict_events(id,verdict_id,kind,block,data) VALUES('fixture-correction','call-fixture','corrected',100,'{}')`);
  const rows = (await service().list('calls')).rows;
  expect(rows.some(r => r.grade === 'hit')).toBe(true);
  expect(rows.some(r => r.grade === 'n/a' && r.detail.event === 'corrected')).toBe(true);
  await invalidateOutcomeDependency(db(), measured.dependencyIds[0]!, cohortCut);
  const corrected = (await service().list('calls')).rows;
  expect(corrected.some(r => r.grade === 'n/a' && r.detail.gradeStatus === 'source_invalidated')).toBe(true);
  expect((await db().sql.query('SELECT * FROM receipt_publications WHERE id=$1', ['call-fixture'])).rows).toEqual(original);
});
it('uses kind-bound snapshot pagination without duplicates when later rows arrive', async () => {
  const first = await service().list('calls', undefined, 2); expect(first.cursor).not.toBeNull();
  await publication('arrived-after-page', coin, 'danger', now);
  const visited = first.rows.map(r => r.id);
  let cursor = first.cursor;
  while (cursor) { const next = await service().list('calls', cursor, 2); expect(next.snapshot).toBe(first.snapshot); expect(next.counters).toEqual(first.counters); visited.push(...next.rows.map(r => r.id)); cursor = next.cursor; }
  expect(new Set(visited).size).toBe(visited.length); expect(visited).not.toContain('call:arrived-after-page');
  await expect(service().list('cohort', first.cursor!)).rejects.toThrow('cursor');
});

it('consumes new publications in batches from the background timer, not inline in a request', async () => {
  const before = (await service().list('calls', undefined, 100)).rows.length;
  for (let i = 0; i < 520; i++) await publication(`batch-${i}`, coin, i % 2 ? 'danger' : 'monitor', now - 1000 + i);
  service().start(3_600_000);
  try {
    // With the timer running, a request reads what has been consumed so far and does not pay for the batch itself.
    const page = await service().list('calls', undefined, 100);
    expect(page.rows.map(r => r.id)).not.toContain('call:batch-519');
    await service().sync();
    const after = await service().list('calls', undefined, 100);
    expect(after.rows[0]!.id).toBe('call:batch-519');
    expect(Number((await db().sql.query<{ n: string }>("SELECT count(*) AS n FROM scoreboard_records WHERE source_key LIKE 'call:batch-%'")).rows[0]!.n)).toBe(520);
    expect((await service().list('calls', undefined, 100)).rows.length).toBe(Math.min(100, before + 520));
  } finally { await service().close(); }
});
it('reads every publication once, then only those above the sequence it reached less an overlap for late commits', async () => {
  // 2026-10-13: checking every publication for a row every 15 s was 0.44 of a database backend, all day.
  const { ScoreboardService, PUBLICATION_OVERLAP } = await import('../src/read/scoreboard.js');
  const fresh = new ScoreboardService(db(), () => now), reads: string[] = [], chain = db(), tx = chain.tx.bind(chain);
  (chain as { tx: unknown }).tx = (work: (inner: typeof chain) => Promise<unknown>) => tx(inner => {
    const query = inner.sql.query.bind(inner.sql);
    (inner.sql as { query: unknown }).query = (text: string, params?: unknown[]) => {
      if (text.includes('FROM receipt_publications p')) reads.push(text.includes('p.publication_sequence>$1') ? `above ${String(params?.[0])}` : 'all');
      return query(text, params);
    };
    return work(inner);
  });
  try {
    await fresh.sync(); await fresh.sync();
    const head = BigInt((await chain.sql.query<{ n: string }>('SELECT max(publication_sequence)::text AS n FROM receipt_publications')).rows[0]!.n);
    expect(reads).toEqual(['all', `above ${head - PUBLICATION_OVERLAP}`]);
    await publication('after-mark', coin, 'danger', now - 500);
    await fresh.sync();
    expect((await chain.sql.query("SELECT 1 FROM scoreboard_records WHERE source_key='call:after-mark'")).rows).toHaveLength(1);
  } finally { (chain as { tx: unknown }).tx = tx; }
});
it('keeps an empty measured cohort explicit, withdraws orphaned fill counters, and exposes monitoring gaps', async () => {
  await service().publishCohort({ week:'2026-09-28T00:00:00.000Z',cut:cohortCut,origin:'measured',launchCoverageComplete:true,
    evidenceIds:[hash('empty-universe')],outcomeVersion:'2.0.0',identityVersion:'1.0.0' });
  const empty=(await service().list('cohort')).rows.filter(r=>r.detail.week==='2026-09-28T00:00:00.000Z');
  expect(empty).toHaveLength(2);
  for(const r of empty)expect(r.detail).toMatchObject({eligible:0,evaluated:0,medianStatus:'unavailable',rugRateStatus:'unavailable',medianDenominator:0,rugDenominator:0});
  await db().sql.query('UPDATE chain_blocks SET hash=$1 WHERE number=98',[binary(hash('orphaned-launch'))]);
  const missed=await service().list('honeypots_missed');
  expect(missed.rows.some(r=>r.detail.counterEffect==='retracted')).toBe(true);
  expect(missed.counters.missed).toBe(0);expect(missed.counters.refused).toBe(0);
  await service().recordCoverage(coverage('disjoint-monitoring',week-86400000,week-3600000));
  const gap=await service().list();
  expect(gap.counters).toMatchObject({refused:null,missed:null});expect(gap.availability.missed).toEqual({status:'unavailable',reason:'coverage_gap'});
});

it('check freshness updates do not append or alter scoreboard calls',async()=>{
  const before=await service().list('calls');
  await db().sql.query(`INSERT INTO coin_rating_checks(coin,checked_block,checked_at,full_block,full_price) VALUES($1,100,$2,100,1)
    ON CONFLICT(coin) DO UPDATE SET checked_at=excluded.checked_at`,[binary(coin),new Date(now)]);
  const after=await service().list('calls');
  expect(after.rows).toEqual(before.rows);expect(after.snapshot).toBe(before.snapshot);
});

it('keeps a price-move fact on a published call without changing its level or grade',async()=>{
  const published=await publication('price-move-call',coin,'clear',now);
  published.decision={...published.decision as Record<string,unknown>,priceMove:{downFromPeakPct:85}};
  // The test's first call above is already immutable, so publish the new fact under its own revision identity.
  published.receiptId='price-move-fact-call';published.revisionId=published.receiptId;
  await publishReceipt(db(),'engines',published);
  const row=(await service().list('calls')).rows.find(r=>r.receiptId===published.receiptId)!;
  expect(row).toMatchObject({level:'clear',detail:{downFromPeakPct:85}});expect(row.grade).toBeUndefined();
});
