import { keccak256, stringToHex } from 'viem';
import { canonicalize } from '@eko/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { binary, migrate, migrateEngines, publishReceipt, ReceiptOutbox, ReceiptCommitJournal, type ChainDb } from '@eko/db';
import { openDb } from '../../../packages/db/test/helpers/historical-db.js';
import type { PonsResult } from '@eko/chain';
import { PERSONA_SET_V1 } from '@eko/engines';
import type { PersonaVote } from '@eko/shared';
import { initialPaperPosition, paperDelayMs, referencePaperLeg, stepPaper, type PaperLeg } from '../src/swarm/paper.js';
import { SwarmPaperRunner } from '../src/swarm/runner.js';
import { SwarmPaperBatchSchema, type SwarmPaperTick } from '../src/swarm/source.js';
import { accountSpotFill } from '../src/exec/position-accounting.js';

const base = Date.parse('2026-10-03T12:00:00Z'), coin = `0x${'ab'.repeat(20)}` as const;
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as const;
const vote: PersonaVote = { persona_id: 'sniper', action: 'ape', size_bucket: 's', confidence: 0.8, exit: { tp_pct: 25, sl_pct: 15, max_hold_min: 1 } };
const leg: PaperLeg = { status: 'ok', referenceId: hash(10), tokens: '100000000000000000000', quoteUsd: 100, networkUsd: 1, decimals: 18, buyTaxPct: 2, sellTaxPct: 3 };
let db: ChainDb, runner: SwarmPaperRunner;
beforeAll(async () => { db = await openDb({ pgliteDir: ':memory:' }); await migrate(db); await migrateEngines(db); runner = new SwarmPaperRunner(db); });
afterAll(async () => { await db?.close(); });
async function header(block: number, atMs: number) {
  await db.sql.query('INSERT INTO chain_blocks VALUES($1,$1,$2,$3,$4) ON CONFLICT DO NOTHING', [block, binary(hash(block)), binary(hash(block - 1)), new Date(atMs)]);
}
async function forecast(id: string, recordedMs = base) {
  await header(100, base);
  await db.sql.query("INSERT INTO swarm_jobs(id,cache_key,coin,input,state) VALUES($1,$1,$2,'{}','done')", [id, coin]);
  const deterministicInput = { evidence: 'fixture', samples: [{ vote }, { vote: { ...vote, action: 'wait', size_bucket: 'none' } }] };
  await publishReceipt(db, 'swarm', { schemaVersion: 'public-receipt-1', canonicalization: 'jcs-rfc8785/v1', receiptId: id, revisionId: id, kind: 'forecast', chainId: 4663,
    coin, recordedAt: new Date(recordedMs).toISOString(), modelIds: ['fixture/luna'], personaSetVersion: 'v1', cardSchemaVersion: 'swarm-naive-1', rulesVersion: 'swarm-funnel-1', outputSchemaVersion: 'swarm-forecast-1', snapshotHash: keccak256(stringToHex(canonicalize(deterministicInput))),
    deterministicInput: { evidence: 'fixture', samples: [{ vote }, { vote: { ...vote, action: 'wait', size_bucket: 'none' } }] }, decision: { apeShare: 0.5, beta: true, swarmRanking: false }, window: { kind: 'forecast', startsAt: 'commit_block', durationSec: 900 }, supersedes: null, reorgOf: null });
  await db.sql.query('INSERT INTO forecasts VALUES($1,$1,$2,100,$3,$4,$1)', [id, coin, new Date(recordedMs), JSON.stringify({ apeShare: 0.5 })]);
  return { forecastId: id, evidence: 'fixture' as const, availableMs: recordedMs, block: 100, blockHash: hash(100), growth5m: 1, change5mPct: 2, evidenceIds: [hash(101)] };
}
function tick(block: number, atMs: number): SwarmPaperTick {
  return { id: hash(1000 + block), block, blockHash: hash(block), atMs, cutoffMs: atMs, prices: [{ coin, markUsd: 1, ethUsd: 1000, decimals: 18, availableMs: atMs, evidenceIds: [hash(102)] }], simulations: [] };
}

function ponsResult(id: number, block: number, atMs: number, sellOnly = false): PonsResult {
  const account = `0x${'ef'.repeat(20)}` as const;
  return { id: hash(id), methodVersion: 'pons-reference-1', coin,
    cursor: { chainId: 4663, blockNumber: String(block), blockHash: hash(block), timestampSec: String(atMs / 1000), boundary: 'block_end', transactionIndex: null, executionOrdinal: null },
    sizeUsd: 100, trajectoryKind: 'isolated_persistent_local', benchmarkQualified: false, routeId: 'fixture-route', profileHash: hash(800), routeFingerprint: hash(801), routeSnapshot: {}, ekoFeeWei: '0', origin: 'fixture',
    status: sellOnly ? 'ok' : 'exit_restricted', complete: false, honeypotConfirmed: false, referenceEntryUnavailable: false, entryLimitedClasses: [], fidelityEvidenceIds: [hash(802)], traceDigest: hash(803), trace: [], unsupportedSuccessors: ['pons_v4'],
    observations: [{ account, accountClass: 'eoa', mode: sellOnly ? 'sell_only' : 'round_trip', blockHash: hash(block), allowanceBefore: '0', delaySec: 0, validSellState: sellOnly,
      tokens: leg.tokens, spent: sellOnly ? '0' : '100000000000000000', returned: sellOnly ? '130000000000000000' : '0', quotedBuy: leg.tokens, quotedSell: '130000000000000000', buyOk: true, sellOk: sellOnly, revert: '0x',
      status: sellOnly ? 'ok' : 'exit_restricted', exitTimestampSec: String(atMs / 1000), purchasedStorageRetained: !sellOnly, overrides: [], balanceBefore: sellOnly ? leg.tokens : '0', allowanceAfterApproval: leg.tokens,
      refundsWei: '0', entryNetworkWei: sellOnly ? null : '1000000000000000', exitNetworkWei: '2000000000000000', entryL1Wei: '0', exitL1Wei: '0', buyChargeWei: null, sellChargeWei: null,
      buyReserveDeltaWei: null, sellReserveDeltaWei: null, buyPayouts: [], sellPayouts: [], buyAccruals: [], sellAccruals: [], buyTaxPct: 2, sellTaxPct: 3, venueRoundTripCostPct: null, allInRoundTripCostPct: null,
      netExitWei: sellOnly ? '128000000000000000' : null, existingPositionDiscountPct: null, localPrediction: null, fidelity: sellOnly }],
  };
}
async function persistSimulation(result: PonsResult, atMs: number) {
  await db.sql.query('INSERT INTO sim_runs(id,coin,block,block_hash,size_usd,route_id,method_version,data,trace_digest,acquired_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [result.id, binary(coin), result.cursor.blockNumber, binary(result.cursor.blockHash), result.sizeUsd, result.routeId, result.methodVersion, JSON.stringify(result), result.traceDigest, new Date(atMs)]);
}

describe('106 paper accounting and no-lookahead transitions', () => {
  it('delays entries by 2–10 seconds, accounts for actual deltas once, and seals persona exit grades', () => {
    expect(Array.from({ length: 50 }, (_, i) => paperDelayMs(i)).every(ms => ms >= 2000 && ms <= 10000)).toBe(true);
    const pending = initialPaperPosition(vote, 0, base);
    expect(stepPaper(pending, base + 1000, 1, leg).code).toBe('delayed');
    const buy = stepPaper(pending, base + 2000, 1, leg);
    expect(buy.position).toMatchObject({ quantity: 100, costBasis: 101, status: 'open' });
    const sell = { ...leg, quoteUsd: 130, networkUsd: 2, sellTaxPct: 3 };
    const exit = stepPaper(buy.position, base + 4000, 1.3, sell);
    expect(exit.grade).toMatchObject({ realizedPnl: 27, reason: 'take_profit' });
    expect(exit.position).toMatchObject({ status: 'closed', quantity: 0, costBasis: 0 });
    expect(stepPaper(exit.position, base + 8000, 3, sell).grade).toBeNull();
  });
  it('keeps failed entries, missing prices, censored providers, mismatched quantities and failed exits visible', () => {
    const p = initialPaperPosition(vote, 0, base);
    expect(stepPaper(p, base + 11000, 1, leg).grade?.reason).toBe('entry_window_missed');
    expect(stepPaper(p, base + 2000, null, null).grade?.reason).toBe('missing_simulation');
    const open = stepPaper(p, base + 2000, 1, leg).position;
    expect(stepPaper(open, base + 3000, null, null).code).toBe('missing_price');
    for (const status of ['provider_failure', 'exit_failed', 'state_unavailable'] as const) {
      const result = stepPaper(open, base + 62000, null, { ...leg, status });
      expect(result.position.status).toBe('open'); expect(result.grade).toBeNull(); expect(result.code).toBe(status);
    }
    expect(stepPaper(open, base + 62000, null, { ...leg, tokens: '1' }).code).toBe('quantity_mismatch');
    expect(stepPaper(open, base + 62000, null, { ...leg, quoteUsd: 90 }).grade?.reason).toBe('max_hold');
    expect(stepPaper(open, base + 3000, 0.8, { ...leg, quoteUsd: 80 }).grade?.reason).toBe('stop_loss');
  });
  it('preserves heritage accounting for unrecorded external assets', () => {
    expect(accountSpotFill({ quantity: 2, costBasis: 20, realizedPnl: 0 }, 'sell', 4, 60, 4)).toEqual({ quantity: 0, costBasis: 0, realizedPnl: 8 });
  });
});
describe('106 durable paper runner and receipt-gated denominators, fixtures only', () => {
  it('registers immutable receipt samples once, rejects future/mismatched features and forged measured origin', async () => {
    const input = await forecast('paper-fixture');
    await expect(runner.register({ ...input, availableMs: base + 1 })).rejects.toThrow('cutoff');
    await expect(runner.register({ ...input, blockHash: hash(99) })).rejects.toThrow('cutoff');
    await expect(runner.register({ ...input, evidence: 'measured' })).rejects.toThrow('provenance');
    await runner.register(input); await new SwarmPaperRunner(db).register(input);
    expect((await db.sql.query("SELECT * FROM swarm_paper_positions WHERE forecast_id='paper-fixture'")).rows).toHaveLength(1);
    await expect(runner.register({ ...input, growth5m: 2 })).rejects.toThrow('Immutable');
    expect((await runner.report(base + 1000000)).denominator).toMatchObject({ forecasts: 1, committedMature: 0, scored: 0 });
  });
  it('resumes transactions, retains missing simulations, refuses future acquisitions and immutable grade/tick edits', async () => {
    await header(101, base + 1000); const delayed = tick(101, base + 1000);
    await runner.tick(delayed);
    expect((await db.sql.query<{ data: { code: string } }>('SELECT data FROM swarm_paper_events')).rows[0].data.code).toBe('delayed');
    await header(102, base + 2000); const due = tick(102, base + 2000);
    const result = await runner.tick(due); expect(result.positions).toBe(1);
    expect((await db.sql.query<{ data: { reason: string } }>('SELECT data FROM swarm_paper_grades')).rows[0].data.reason).toBe('missing_simulation');
    expect(await new SwarmPaperRunner(db).tick(due)).toMatchObject({ code: 'replayed' });
    expect(await runner.tick(delayed)).toMatchObject({ code: 'replayed' });
    await expect(runner.tick({ ...due, prices: [] })).rejects.toThrow('Immutable tick');
    await expect(db.sql.query("UPDATE swarm_paper_grades SET data='{}'")).rejects.toThrow('append-only');
    await expect(db.sql.query('DELETE FROM swarm_paper_events')).rejects.toThrow('append-only');
    const input = await forecast('late-source-fixture', base + 10000); await runner.register(input);
    await header(103, base + 12000);
    // The row is deliberately incomplete; acquisition cutoff must reject it before its body can be interpreted.
    await db.sql.query('INSERT INTO sim_runs(id,coin,block,block_hash,size_usd,route_id,method_version,data,trace_digest,acquired_at) VALUES($1,$2,103,$3,100,$4,$5,$6,$1,$7)',
      [hash(201), binary(coin), binary(hash(103)), 'fixture-route', 'pons-reference-1', JSON.stringify({ coin }), new Date(base + 12001)]);
    const late = tick(103, base + 12000); late.simulations.push({ positionId: 'late-source-fixture:0', referenceId: hash(201), heldEntryReference: null });
    await runner.tick(late);
    expect((await db.sql.query<{ data: { reason: string } }>("SELECT data FROM swarm_paper_grades WHERE position_id='late-source-fixture:0'")).rows[0].data.reason).toBe('missing_simulation');
  });
  it('starts outcomes at current canonical commitment, excludes censored coverage, and invalidates orphaned anchors', async () => {
    const outbox = new ReceiptOutbox(db); await outbox.recover();
    const journal = new ReceiptCommitJournal(db); expect(await journal.acquire()).toBe(true);
    const batch = (await journal.batch(base + 300001))!;
    await header(200, base + 300000); await header(300, base + 1200000);
    await journal.saveAttempt({ tx_hash: hash(400), batch_id: batch.id, registry: coin, committer: `0x${'cd'.repeat(20)}`, nonce: '0', raw_transaction: '0x00' });
    await journal.anchor(batch, { batchId: 1, txHash: hash(400), registry: coin, committer: `0x${'cd'.repeat(20)}`, root: batch.root, leafCount: batch.items.length, blockNumber: '200', blockHash: hash(200), logIndex: 0 });
    const observation = { forecastId: 'paper-fixture', anchorHash: hash(200), endBlock: 300, endBlockHash: hash(300), availableMs: base + 1200000, netAgentUsd: 600, coverage: { complete: true, prices: true, labels: true, provider: false }, evidenceIds: [hash(500)] };
    expect(await runner.observe({ ...observation, anchorHash: hash(199) })).toBe('pending_anchor');
    await expect(runner.observe({ ...observation, endBlock: 200 })).rejects.toThrow('cutoff');
    expect(await runner.observe(observation)).toBe('censored');
    const report = await runner.report(base + 1200001);
    expect(report.denominator).toMatchObject({ forecasts: 2, committedMature: 2, scored: 0, censored: 2, elapsedMs: 0 });
    expect(report.acceptanceCandidate).toBe(false); expect(report.swarmRanking).toBe(false);
    await journal.anchorEvent((await journal.unfinalized())[0].id, 'orphaned');
    expect((await runner.report(base + 1200001)).denominator.committedMature).toBe(0);
    await journal.release();
  });
  it('fills from pinned Pons entry deltas despite a failed reference exit and later closes the exact held quantity', async () => {
    const input = await forecast('filled-fixture', base + 40000); await runner.register(input);
    await header(401, base + 42000); const entry = ponsResult(901, 401, base + 42000); await persistSimulation(entry, base + 42000);
    const buy = tick(401, base + 42000); buy.simulations.push({ positionId: 'filled-fixture:0', referenceId: entry.id, heldEntryReference: null });
    await runner.tick(buy);
    expect((await db.sql.query<{ data: { status: string; costBasis: number } }>("SELECT data FROM swarm_paper_positions WHERE id='filled-fixture:0'")).rows[0].data).toMatchObject({ status: 'open', costBasis: 101 });
    await header(402, base + 44000); const exit = ponsResult(902, 402, base + 44000, true); await persistSimulation(exit, base + 44000);
    const sell = tick(402, base + 44000); sell.prices[0].markUsd = 1.3;
    sell.simulations.push({ positionId: 'filled-fixture:0', referenceId: exit.id, heldEntryReference: entry.id });
    await runner.tick(sell);
    expect((await db.sql.query<{ data: { realizedPnl: number; status: string; reason: string } }>("SELECT data FROM swarm_paper_grades WHERE position_id='filled-fixture:0'")).rows[0].data).toMatchObject({ status: 'closed', realizedPnl: 27, reason: 'take_profit' });
    await expect(db.sql.query("DELETE FROM swarm_calibration_baselines WHERE forecast_id='filled-fixture'")).rejects.toThrow('append-only');
    const p = initialPaperPosition(vote, 0, base);
    expect(referencePaperLeg(entry, { side: 'buy', position: p, ethUsd: null, decimals: 18, referenceId: entry.id }).status).toBe('missing_price');
    expect(referencePaperLeg({ ...entry, status: 'provider_failure' }, { side: 'buy', position: p, ethUsd: 1000, decimals: 18, referenceId: entry.id }).status).toBe('provider_failure');
  });
  it('predeclares evaluation cohorts so warm-up cannot permanently block a gate or be selected after outcomes', async () => {
    const r = new SwarmPaperRunner(db, () => base);
    const plan = { id: hash(990), startMs: base + 86400000, endMs: base + 16 * 86400000, evidence: 'fixture' };
    await expect(r.prepareCohort({ ...plan, startMs: base - 1 })).rejects.toThrow('before evaluation');
    await r.prepareCohort(plan); await r.prepareCohort(plan);
    await expect(r.prepareCohort({ ...plan, endMs: plan.endMs + 1 })).rejects.toThrow('Immutable cohort');
    const report = await r.report(base, plan.id);
    expect(report.denominator.forecasts).toBe(0);
    expect(report.reasons).toContain('cohort_in_progress');
    expect(report.acceptanceCandidate).toBe(false);
    expect((await r.report(base)).reasons).toContain('cohort_not_predeclared');
  });
  it('enrols every committed receipt vote even when calibration features are missing', async () => {
    await forecast('no-features-fixture', base + 50000);
    await runner.report(base + 50000);
    expect((await db.sql.query<{ data: { status: string } }>("SELECT data FROM swarm_paper_positions WHERE id='no-features-fixture:0'")).rows[0].data.status).toBe('pending');
    expect((await db.sql.query("SELECT * FROM swarm_calibration_inputs WHERE forecast_id='no-features-fixture'")).rows).toHaveLength(0);
  });
  it('validates bounded offline input without accepting future price availability', () => {
    expect(SwarmPaperBatchSchema.parse({ schemaVersion: 'swarm-paper-input-1', inputs: [], outcomes: [], ticks: [] }).ticks).toEqual([]);
    const t = tick(101, base + 1000); t.prices[0].availableMs++;
    expect(SwarmPaperBatchSchema.safeParse({ schemaVersion: 'swarm-paper-input-1', inputs: [], outcomes: [], ticks: [t] }).success).toBe(false);
    expect(PERSONA_SET_V1.personas).toHaveLength(10);
  });
});
