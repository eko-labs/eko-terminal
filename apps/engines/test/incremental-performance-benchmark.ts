// Offline, fixed synthetic workload. The original measured 200k pilot is a separate gate.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { replayPonsCampaign } from '@eko/chain';
import { fixture as campaignFixture } from '../../../packages/chain/test/campaign-fixtures.js';
import { performance } from 'node:perf_hooks';
import { canonicalize, GuardScoreInputSchema } from '@eko/shared';
import { evaluateGuardV2 } from '@eko/playbooks';
import { IncrementalGuardCache, GuardChainTimeQueue } from '../src/incremental-guard.js';
import { reportGuardPerformance, type GuardPerformanceSample } from '../src/guard-performance.js';
import { input, observation, address } from '../../../packages/playbooks/test/scoring-fixtures.js';
const [output, candidate] = process.argv.slice(2);
if (!output || !candidate || !/^[a-f0-9]{64}$/.test(candidate)) throw new Error('Output directory and candidate SHA-256 required');
const n = 200000;
const shapes = [input(), input([observation('execution_cost', 10)]), input([observation('operator_hold', 20)]),
  input([observation('current_sell_pressure', 15, '30')]), input([observation('campaign_pressure', 15, '30')]),
  input([observation('thin_depth', 1500)]), input([observation('cycling', 80, '10000')]), input()];
shapes[7].checks = [];
const source = { validation: 'fixture', version: 'incremental-053.1', evaluations: n, schedule: 'round-robin-eight-captured-inputs', inputs: shapes };
const bytes = canonicalize(source), sourceRevision = createHash('sha256').update(bytes).digest('hex');
const sourcePath = `${output}/source.json`;
try { assert.equal(await readFile(sourcePath, 'utf8'), bytes, 'Frozen fixture changed'); }
catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; await writeFile(sourcePath, bytes, { flag: 'wx' }); }
const captured = JSON.parse(await readFile(sourcePath, 'utf8')) as typeof source;
const inputs = captured.inputs.map(i => GuardScoreInputSchema.parse(i));
let pureMs = 0, peakRss = process.memoryUsage().rss, digest = '0'.repeat(64), firstMs = 0, lastMs = 0;
const samples: number[] = [], cache = new IncrementalGuardCache({ entries: 8, bytes: 1000000, dependenciesPerEntry: 16 });
const context = { sourceRevision, route: 'fixture-native', sizeRaw: '100', account: address(20) };
for (const i of inputs) cache.evaluate(i, context, [address(20)]);
const cacheCheckpoint = cache.checkpoint(candidate);
const resumed = IncrementalGuardCache.restore(JSON.parse(JSON.stringify(cacheCheckpoint)), candidate, sourceRevision);
for (const i of inputs) assert.deepEqual(resumed.evaluate(i, context, [address(20)]), evaluateGuardV2(i));
let nextIndex = 0;
try {
  const checkpoint = JSON.parse(await readFile(`${output}/checkpoint.json`, 'utf8'));
  assert.equal(checkpoint.candidate, candidate); assert.equal(checkpoint.sourceRevision, sourceRevision);
  assert.ok(Number.isSafeInteger(checkpoint.nextIndex) && checkpoint.nextIndex >= 0 && checkpoint.nextIndex <= n);
  if (checkpoint.status === 'complete') {
    const prior = JSON.parse(await readFile(`${output}/report.json`, 'utf8'));
    assert.equal(prior.candidateRevision, candidate); assert.equal(prior.sourceRevision, sourceRevision);
    console.log(JSON.stringify({ event: 'reuse_completed_fixture', report: prior })); process.exit(prior.targetMet ? 0 : 2);
  }
  nextIndex = checkpoint.nextIndex; pureMs = checkpoint.pureMs; digest = checkpoint.digest;
  firstMs = checkpoint.firstMs; lastMs = checkpoint.lastMs; peakRss = checkpoint.peakRss;
  for (const value of checkpoint.samples) samples.push(value);
  assert.equal(samples.length, nextIndex);
  IncrementalGuardCache.restore(checkpoint.cache, candidate, sourceRevision);
} catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
const start = performance.now();
for (let index = nextIndex; index < n; index++) {
  const i = inputs[index % inputs.length], begin = performance.now(), result = evaluateGuardV2(i), duration = performance.now() - begin;
  pureMs += duration; samples.push(duration); if (index < n / 10) firstMs += duration; if (index >= n * .9) lastMs += duration;
  digest = createHash('sha256').update(digest).update(result.assessment.decisionHash).digest('hex');
  if ((index + 1) % 25000 === 0) {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    await writeFile(`${output}/checkpoint.tmp.json`, JSON.stringify({ candidate, sourceRevision, nextIndex: index + 1, digest, pureMs, firstMs, lastMs, peakRss, samples,
      status: 'running', processId: process.pid, cache: cache.checkpoint(candidate) }));
    await rename(`${output}/checkpoint.tmp.json`, `${output}/checkpoint.json`);
    console.log(JSON.stringify({ event: 'fixture_progress', evaluations: index + 1, evaluationsPerSec: (index + 1) * 1000 / pureMs }));
  }
}
const wallMs = performance.now() - start;
const hitTimes: number[] = [];
for (let index = 0; index < 1000; index++) { const t = performance.now(); cache.evaluate(inputs[index % 8], context, [address(20)]); hitTimes.push(performance.now() - t); }
// Stress a hot token with changing contexts/dependencies, retaining only the configured working set.
for (let index = 0; index < 1000; index++) cache.evaluate(inputs[0], { ...context, sizeRaw: String(index) }, [address(100 + index)]);
assert.ok(cache.stats().entries <= 8 && cache.stats().bytes <= 1000000 && cache.stats().reverseWallets <= 8);
const queues: Record<string, unknown>[] = [], stageSamples: GuardPerformanceSample[] = [];
for (const kind of ['acquisition', 'probe', 'pressure', 'critical', 'lower', 'expiry', 'maturity'] as const) {
  const q = new GuardChainTimeQueue(4663, sourceRevision, 1000), began = performance.now();
  for (let j = 0; j < 1000; j++) q.enqueue({ id: `${kind}-${String(j).padStart(4, '0')}`, chainId: 4663, coin: address(1), kind,
    dueSec: String(j), sourceRevision, inputRef: sourceRevision, dependencyIds: [] });
  const enqueueMs = performance.now() - began;
  q.advance('1000'); const cp = q.checkpoint(candidate), restoreBegin = performance.now();
  const r = GuardChainTimeQueue.restore(cp, candidate, sourceRevision, 4663), restoreMs = performance.now() - restoreBegin;
  const drainBegin = performance.now(); let drained = 0;
  while (r.peekDue()) { r.acknowledge(r.peekDue()!.id); drained++; }
  const drainMs = performance.now() - drainBegin;
  queues.push({ kind, jobs: drained, enqueueMs, restoreMs, schedulingDrainMs: drainMs, workerCompletionP95Ms: null });
}
const pressureTimes: number[] = [], campaign = campaignFixture();
for (let j = 0; j < 100; j++) {
  const began = performance.now(), result = replayPonsCampaign(campaign); pressureTimes.push(performance.now() - began);
  assert.equal(result.rawComplete, true); assert.equal(result.attributionAvailable, false);
}
for (const [j, i] of inputs.entries()) {
  const begin = performance.now(), a = evaluateGuardV2(i).assessment, workMs = performance.now() - begin;
  for (const [stage, complete] of [['critical', a.completeness.buyCriticalComplete], ['lower', a.completeness.lowerTierComplete]] as const)
    stageSamples.push({ stage, venue: 'pons_curve', ageSec: [0, 300, 3600, 86400][j % 4], workMs, queueMs: 0, status: complete ? 'complete' : 'missing' });
}
const p95 = (v: number[]) => [...v].sort((a,b)=>a-b)[Math.ceil(v.length * .95)-1];
const report = { ...reportGuardPerformance({ sourceRevision, candidateRevision: candidate, validation: 'fixture', evaluations: n,
  elapsedMs: pureMs, evaluatorRpc: 0, priorEvaluationsPerSec: null, pilotTargetRef: null }, stageSamples),
  node: process.version, pid: process.pid, sourcePath: 'source.json', checkpoint: 'checkpoint.json', wallMs, pureArithmeticP95Ms: p95(samples),
  first10PctPerSec: n / 10 * 1000 / firstMs, last10PctPerSec: n / 10 * 1000 / lastMs, decisionDigest: digest,
  pressureWorker: { origin: 'fixture', jobs: 100, workP95Ms: p95(pressureTimes), attributionAvailable: false, includes: 'local campaign pressure, real-buyer valuation and interventions; excludes fork/acquisition/DB queue' },
  cacheHitP95Ms: p95(hitTimes), cache: cache.stats(), peakRssBytes: peakRss, deterministicCacheResume: true, queues,
  requests: 0, requestUnits: 0, chargedUsd: 0, providerPricing: null, anvilExecutions: 0, anvilCostMs: null,
  gaps: ['original_measured_200k_source_unavailable', 'pilot_frozen_target_unavailable', 'head_scan_preflight_not_measured_here',
    'acquisition_probe_workers_not_measured', 'queue_scheduler_is_not_worker_completion', 'fixture_coverage_is_not_live_coverage'], released: false };
assert.equal(createHash('sha256').update(await readFile(sourcePath)).digest('hex'), sourceRevision);
await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
const finalCheckpoint = JSON.parse(await readFile(`${output}/checkpoint.json`, 'utf8'));
finalCheckpoint.status = 'complete';
await writeFile(`${output}/checkpoint.tmp.json`, JSON.stringify(finalCheckpoint));
await rename(`${output}/checkpoint.tmp.json`, `${output}/checkpoint.json`);
console.log(JSON.stringify(report));
if (!report.targetMet) process.exitCode = 2;
