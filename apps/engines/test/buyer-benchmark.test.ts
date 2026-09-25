import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { applyPonsCampaignTransaction, campaignStateHash, ponsBuy } from '@eko/chain';
import { address, hash } from '../../../packages/chain/test/reference-fixtures.js';
import { BuyerBenchmarkManifestSchema, BenchmarkExitSchema } from '../src/buyer-benchmark-input.js';
import { benchmarkPaths, benchmarkRational as r, benchmarkReturns, benchmarkFidelityGate, initialBenchmarkCheckpoint,
  runBuyerBenchmark, type BenchmarkAdapter, type BenchmarkFidelityMatch } from '../src/buyer-benchmark.js';
import { ponsBenchmarkFixtureAdapter, verifyPonsBenchmarkFixture } from '../src/buyer-benchmark-pons.js';
import { buyerBenchmarkMain } from '../src/buyer-benchmark-cli.js';
import { buyerFixture, candidate, changeSnapshot, memoryIO, runFixture, seal, snapshot } from './buyer-benchmark-fixtures.js';

const primary = (result: Awaited<ReturnType<typeof runBuyerBenchmark>>, size = 100, method = 'paper', accountClass = 'eoa') =>
  result.rows.find(x => x.primary && x.path.sizeUsd === size && x.path.method === method && x.path.accountClass === accountClass)!;
const fixed = (row: ReturnType<typeof primary>, kind = 'fixed_3600') => row.checkpoints[row.strategies.find(s => s.kind === kind)!.checkpoint];

it('pins 5/30/60/300 entries, independent sizes/methods/classes, entry verdict and primary fixed exit', async () => {
  const m = buyerFixture(); m.accounts.push({ account: address(31), accountClass: 'contract' }); m.nextBlockStress = true;
  const { result } = await runFixture(m);
  expect(benchmarkPaths(m)).toHaveLength(64);
  expect(result.rows).toHaveLength(64); expect(result.status).toBe('complete');
  expect(result).toMatchObject({ mode: 'shadow', released: false, actualRequestUnits: 0, actualPaidNanoUsd: '0', realMatchedCases: 0, operatorHistoryEligible: false });
  expect(result.rows.filter(x => x.primary)).toHaveLength(8);
  for (const size of [100, 1000]) for (const method of ['paper', 'persistent']) {
    const row = primary(result, size, method);
    expect(row.entryCursor!.timestampSec).toBe('1060'); expect(row.actualDelaySec).toBe('60');
    expect(row.predictor!.verdictId).toBe(m.frames[2].predictors.find(p => p.sizeUsd === size && p.accountClass === 'eoa')!.verdictId);
    expect(row).toMatchObject({ routeId: m.routeId, configHash: m.configHash });
    expect(row.strategies.find(s => s.kind === 'stop_target')!.trigger).toBe('mandatory_exit');
    expect(fixed(row).deadlineSec).toBe('4660'); expect(fixed(row).cursor!.timestampSec).toBe('4660');
    expect(row.entry.status).toBe('purchased');
  }
  expect(result.rows.find(x => x.path.delaySec === 300)!.actualDelaySec).toBe('300');
  expect(result.rows.find(x => x.path.delaySec === 60 && x.path.stress)!.actualDelaySec).toBe('120');
  const small = primary(result), large = primary(result, 1000);
  expect(small.entry.status === 'purchased' && small.entry.spentQuote).toBe('100');
  expect(large.entry.status === 'purchased' && large.entry.spentQuote).toBe('1000');
  expect(fixed(large).returns!.netQuote).not.toEqual(fixed(primary(result, 1000, 'persistent')).returns!.netQuote);
});

it('keeps first scheduled failed exit and all retry attempts even after recovery', async () => {
  const m = changeSnapshot(buyerFixture(), (s, time) => { if (time === 4660) s.blockedClasses = ['eoa']; });
  m.frames.find(f => f.cursor.timestampSec === '4660')!.cursor.timestampSec = '4661'; seal(m);
  const { result } = await runFixture(m), row = primary(result), first = fixed(row);
  expect(first.cursor!.timestampSec).toBe('4661'); expect(first.deadlineSec).toBe('4660');
  expect(first.exit.status).toBe('token_failure'); expect(first.returns!.severelyHurt).toBe(true);
  expect(first.returns!.netQuote).toEqual(r(0n)); expect(first.returns!.returnPct).toEqual(r(-100n));
  expect(row.retries).toHaveLength(5);
  expect(row.retries.map(k => row.checkpoints[k].deadlineSec)).toEqual(['4720', '4780', '4840', '4900', '4960']);
  expect(row.checkpoints[row.retries[0]].exit.status).toBe('executed');
  expect(fixed(row)).toBe(first);
});

it('records cap as entry_unavailable with no invested-loss return, independently by size', async () => {
  const { result } = await runFixture(changeSnapshot(buyerFixture(), s => { s.capQuote = '500'; }));
  expect(primary(result, 1000).entry).toMatchObject({ status: 'entry_unavailable', reason: 'entry_cap' });
  expect(primary(result, 1000).checkpoints).toEqual([]); expect(primary(result).entry.status).toBe('purchased');
});

it('retains delayed purchase state in paper and leaves unsupported contract paths explicit', async () => {
  const m = changeSnapshot(buyerFixture(), s => { s.cooldownSec = '3700'; s.supportedClasses = ['eoa']; });
  m.accounts.push({ account: address(31), accountClass: 'contract' });
  const { result } = await runFixture(m), row = primary(result);
  expect(fixed(row).exit.status).toBe('token_failure');
  expect(row.checkpoints[row.retries[0]].exit.status).toBe('token_failure');
  expect(row.checkpoints[row.retries[1]].exit.status).toBe('executed');
  expect(primary(result, 100, 'paper', 'contract').entry).toMatchObject({ status: 'unsupported' });
});

it('censors data/provider gaps at the scheduled state instead of moving to a later success', async () => {
  for (const status of ['data_gap', 'provider_gap'] as const) {
    const m = buyerFixture(); m.frames.find(f => f.cursor.timestampSec === '4660')!.status = status; seal(m);
    const { result } = await runFixture(m), row = primary(result);
    expect(fixed(row)).toMatchObject({ cursor: { timestampSec: '4660' }, exit: { status: 'censored', reason: status } });
    expect(fixed(row).returns!.returnPct).toBeNull(); expect(fixed(row).returns!.severelyHurt).toBeNull(); expect(row.retries).toEqual([]);
  }
});

it('records quote-unit returns separately from USD movement, and signed execution plus L1 gas', async () => {
  const m = buyerFixture(), frame = m.frames[2];
  const entry = ponsBenchmarkFixtureAdapter.enter(m, benchmarkPaths(m).find(p => p.delaySec === 60)!, frame, '100');
  if (entry.status !== 'purchased') throw new Error('Fixture entry failed');
  entry.gas = { executionQuote: r(1n), l1Quote: r(1n), usd: r(2n) };
  const exit = { status: 'executed' as const, grossQuote: '80', gas: { executionQuote: r(90n), l1Quote: r(10n), usd: r(50n) }, evidenceIds: [hash('exit')] };
  const returns = benchmarkReturns(m, entry, frame, exit, { ...frame, quoteUsd: r(1n, 2n) });
  expect(returns.netQuote).toEqual(r(-20n)); expect(returns.netExitQuoteUsd).toEqual(r(-10n));
  expect(returns.quoteReturnPct).toEqual(r(-6100n, 51n)); expect(returns.returnPct).toEqual(r(-5600n, 51n));
  expect(returns.severelyHurt).toBe(true);
  const movement = benchmarkReturns(m, { ...entry, gas: { executionQuote: r(0n), l1Quote: r(0n), usd: r(0n) } }, frame,
    { ...exit, grossQuote: '100', gas: { executionQuote: r(0n), l1Quote: r(0n), usd: r(0n) } }, { ...frame, quoteUsd: r(1n, 2n) });
  expect(movement.quoteReturnPct).toEqual(r(0n)); expect(movement.returnPct).toEqual(r(-50n));
  expect(benchmarkReturns(m, entry, frame, exit, { ...frame, quoteUsd: null }).returnPct).toBeNull();
});

it('requires proved no-exit for zero proceeds and leaves unresolved token failures indeterminate', async () => {
  expect(BenchmarkExitSchema.safeParse({ status: 'token_failure', verifiedNoExit: false, validScheduledState: true, grossQuote: '0',
    gas: snapshot(buyerFixture(), 1060).gas, evidenceIds: [hash('failure')] }).success).toBe(false);
  const m = changeSnapshot(buyerFixture(), (s, time) => { if (time === 4660) { s.blockedClasses = ['eoa']; s.verifiedFailure = false; } });
  const { result } = await runFixture(m), row = primary(result);
  expect(fixed(row).returns!.netQuote).toBeNull(); expect(fixed(row).returns!.severelyHurt).toBeNull();
  expect(row.strategies.find(s => s.kind === 'fixed_3600')!.status).toBe('indeterminate');
});

it('never skips an original transaction invalidated by retained entry impact', async () => {
  const m = changeSnapshot(buyerFixture(), s => {
    s.campaign.curve!.realQuote = '1000'; s.campaign.curve!.virtualQuote = '100';
    s.campaign.wallets = [{ account: address(40), quote: '10000', token: '0', allowance: '0' }];
  });
  const before = snapshot(m, 1060).campaign, state = structuredClone(before);
  const amount = ponsBuy({ tokens: BigInt(state.curve!.tokens), realQuote: 1000n, virtualQuote: 100n, reservedTokens: 100n }, 100n, []).tokens;
  const tx = { id: hash('remaining-original-buy'), index: 0, gasPayer: address(40), gasQuote: '0', gasRecipient: address(41), expectedStateHash: hash('pending'),
    legs: [{ id: hash('remaining-original-buy-leg'), economicId: null, kind: 'buy' as const, account: address(40), recipient: address(40),
      input: '100', minimumOutput: amount.toString(), deadlineSec: '1120', executable: 'supported' as const }] };
  const after = applyPonsCampaignTransaction(state, tx, '1120'); tx.expectedStateHash = campaignStateHash(after);
  changeSnapshot(m, (s, time) => { if (time >= 1120) s.campaign = structuredClone(after); if (time === 1120) s.transactions = [tx]; });
  verifyPonsBenchmarkFixture(m.frames);
  const { result } = await runFixture(m), persistent = fixed(primary(result, 100, 'persistent'));
  expect(persistent.exit).toMatchObject({ status: 'indeterminate', reason: 'persistent_transaction_invalid', failedTransaction: tx.id });
  expect(persistent.returns!.returnPct).toBeNull(); expect(fixed(primary(result)).exit.status).toBe('executed');
  expect(primary(result, 100, 'persistent').strategies.find(s => s.kind === 'stop_target')!.status).toBe('indeterminate');
  const tampered = structuredClone(m); const s = snapshot(tampered, 1120); s.transactions[0].expectedStateHash = hash('wrong');
  tampered.frames.find(f => f.cursor.timestampSec === '1120')!.state = s;
  expect(() => verifyPonsBenchmarkFixture(tampered.frames)).toThrow('Observed transaction state');
});

it('evaluates stop/target at relevant boundaries and fixed holds remain independent', async () => {
  const m = buyerFixture(); const boundary = m.frames.find(f => f.cursor.timestampSec === '1120')!; boundary.relevant = ['control']; boundary.cursor.timestampSec = '1100'; seal(m);
  const adapter: BenchmarkAdapter = { ...ponsBenchmarkFixtureAdapter,
    exit: (m, path, entry, ei, xi) => ({ status: 'executed', grossQuote: m.frames[xi].cursor.timestampSec === '1100' ? '151' : entry.spentQuote,
      gas: snapshot(m, Number(m.frames[xi].cursor.timestampSec)).gas, evidenceIds: m.frames[xi].evidenceIds }) };
  const { result } = await runFixture(m, adapter), row = primary(result);
  const strategy = row.strategies.find(s => s.kind === 'stop_target')!;
  expect(strategy.trigger).toBe('target'); expect(row.checkpoints[strategy.checkpoint].cursor!.timestampSec).toBe('1100');
  expect(fixed(row).cursor!.timestampSec).toBe('4660'); expect(fixed(row, 'fixed_300').deadlineSec).toBe('1360');
  expect(fixed(row, 'fixed_86400').deadlineSec).toBe('87460');
});

it('fires the stop at the exact -30% boundary without changing the fixed exit', async () => {
  const m = buyerFixture();
  const adapter: BenchmarkAdapter = { ...ponsBenchmarkFixtureAdapter,
    exit: (m, path, entry, ei, xi) => ({ status: 'executed', grossQuote: m.frames[xi].cursor.timestampSec === '1120' ? '70' : entry.spentQuote,
      gas: snapshot(m, Number(m.frames[xi].cursor.timestampSec)).gas, evidenceIds: m.frames[xi].evidenceIds }) };
  const { result } = await runFixture(m, adapter), row = primary(result), strategy = row.strategies.find(s => s.kind === 'stop_target')!;
  expect(strategy.trigger).toBe('stop'); expect(row.checkpoints[strategy.checkpoint].returns!.returnPct).toEqual(r(-30n));
  expect(fixed(row).cursor!.timestampSec).toBe('4660');
});

it('censors missing horizons and missing USD, rejects clock gaps and later predictor evidence', async () => {
  const m = buyerFixture(); m.frames = m.frames.slice(0, 10); seal(m);
  const { result } = await runFixture(m); expect(fixed(primary(result)).exit.status).toBe('censored');
  const bad = buyerFixture(); bad.frames.splice(3, 1); seal(bad);
  expect(() => BuyerBenchmarkManifestSchema.parse(bad)).toThrow('clock');
  const future = buyerFixture(); future.frames[2].predictors[0].evidenceKnownAt = future.frames[3].knownAt; seal(future);
  expect(() => BuyerBenchmarkManifestSchema.parse(future)).toThrow('entry cut');
  const missing = buyerFixture(); missing.frames[2].quoteUsd = null; seal(missing);
  const { result: missingResult } = await runFixture(missing); expect(primary(missingResult).entry).toMatchObject({ status: 'censored', reason: 'usd_missing' });
});

it('resumes without duplicated computations and rejects candidate/source/artifact changes', async () => {
  const m = buyerFixture(), mem = memoryIO(m), c = initialBenchmarkCheckpoint(m, candidate);
  let exits = 0;
  const adapter = { ...ponsBenchmarkFixtureAdapter, exit: (...args: Parameters<BenchmarkAdapter['exit']>) => {
    exits++; if (exits === 4) mem.stop(); return ponsBenchmarkFixtureAdapter.exit(...args);
  } };
  const stopped = await runBuyerBenchmark(m, c, mem.io, adapter, candidate); expect(stopped.status).toBe('stopped');
  mem.stop(false);
  const resumed = await runBuyerBenchmark(m, c, mem.io, ponsBenchmarkFixtureAdapter, candidate), writes = mem.writes();
  const again = await runBuyerBenchmark(m, c, mem.io, ponsBenchmarkFixtureAdapter, candidate);
  expect(again).toEqual(resumed); expect(mem.writes()).toBe(writes);
  expect(resumed).toEqual((await runFixture(m)).result);
  await expect(runBuyerBenchmark(m, c, mem.io, adapter, hash('other-candidate'))).rejects.toThrow('mismatch');
  const bad = structuredClone(m); bad.retrySensitivity = false;
  await expect(runBuyerBenchmark(bad, c, mem.io, adapter, candidate)).rejects.toThrow('mismatch');
  mem.artifacts.set(c.artifacts[0].key, { invalid: true });
  await expect(runBuyerBenchmark(m, c, mem.io, adapter, candidate)).rejects.toThrow('changed');
  const reorg = memoryIO(m); reorg.reorg();
  expect((await runBuyerBenchmark(m, initialBenchmarkCheckpoint(m, candidate), reorg.io, adapter, candidate)).reason).toBe('source_reorg');
});

const group = { venue: 'pons_curve', sizeUsd: 100 as const, accountClass: 'eoa' as const };
const matches = (origin: 'fixture' | 'measured' = 'fixture'): BenchmarkFidelityMatch[] => Array.from({ length: 30 }, (_, i) => ({
  ...group, id: hash(`synthetic-fidelity-${i}`), caseId: `synthetic-case-${i}`, origin, comparison: 'persistent', supported: true, persistentValid: true,
  exactAccounting: true, diversityReviewed: true, paperNetUsd: r(100n), comparatorNetUsd: r(100n), paperHurt: false, comparatorHurt: false, evidenceIds: [hash(`synthetic-proof-${i}`)] }));
it('keeps synthetic coverage outside the real 30-case gate, checks 1% and zero harm reversals by group', () => {
  expect(benchmarkFidelityGate(matches(), group)).toMatchObject({ passed: false, realMatchedCases: 0, syntheticChecks: 30 });
  // Schema/logic exercise only: these remain synthetic inputs, not measured validation evidence.
  const m = matches('measured'); expect(benchmarkFidelityGate(m, group).passed).toBe(true);
  m[0].paperNetUsd = r(101n); expect(benchmarkFidelityGate(m, group).passed).toBe(true);
  m[0].paperNetUsd = r(10101n, 100n); expect(benchmarkFidelityGate(m, group)).toMatchObject({ passed: false, relativeErrorFailures: 1 });
  m[0].paperNetUsd = r(100n); m[0].paperHurt = true;
  expect(benchmarkFidelityGate(m, group)).toMatchObject({ passed: false, harmReversals: 1 });
  m[0].paperHurt = false; m[0].exactAccounting = false;
  expect(benchmarkFidelityGate(m, group)).toMatchObject({ passed: false, accountingFailures: 1 });
  m[0].exactAccounting = true; m[0].diversityReviewed = false;
  expect(benchmarkFidelityGate(m, group)).toMatchObject({ passed: false, diversityUnreviewed: 1 });
  m[0].diversityReviewed = true; m[0].persistentValid = false;
  expect(benchmarkFidelityGate(m, group)).toMatchObject({ passed: false, missingReleaseTruth: true, unsupportedOrInvalid: 1 });
  const fallback = { ...m[0], id: hash('synthetic-real-fallback'), comparison: 'real_fifo' as const };
  expect(benchmarkFidelityGate([...m, fallback], group).passed).toBe(true);
  m[0].comparison = 'real_fifo'; expect(benchmarkFidelityGate(m, group).passed).toBe(true);
  m[0].caseId = m[1].caseId; expect(benchmarkFidelityGate(m, group).realMatchedCases).toBe(29);
  expect(benchmarkFidelityGate(matches('measured'), { ...group, sizeUsd: 1000 }).passed).toBe(false);
});

it('writes fixture artifacts/checkpoint/report through the CLI and resumes the same candidate', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'buyer-benchmark-fixture-')), source = join(dir, 'manifest.json'), output = join(dir, 'output');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const m = buyerFixture(); m.frames = m.frames.slice(0, 4); seal(m);
    await writeFile(source, JSON.stringify(m));
    expect(await buyerBenchmarkMain(['--fixture', source, output])).toBe(0);
    const before = await readFile(join(output, 'checkpoint.json'), 'utf8');
    expect(await buyerBenchmarkMain(['--fixture', source, output])).toBe(0);
    expect(await readFile(join(output, 'checkpoint.json'), 'utf8')).toBe(before);
    const report = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'));
    expect(report).toMatchObject({ origin: 'fixture', released: false, actualRequestUnits: 0, realMatchedCases: 0, pricing: 'local_fixture_zero_remote_cost' });
    await mkdir(join(output, 'runner.lock'));
    await expect(buyerBenchmarkMain(['--fixture', source, output])).rejects.toThrow();
    await rm(join(output, 'runner.lock'), { recursive: true });
    m.origin = 'measured'; await writeFile(source, JSON.stringify(m));
    await expect(buyerBenchmarkMain(['--fixture', source, output])).rejects.toThrow('fixtures');
  } finally { log.mockRestore(); await rm(dir, { recursive: true, force: true }); }
});
