import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acceptanceResult, digest, evaluate, labelInventory, passBar, runFixture } from '../runner.mjs';

const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
const candidate = { revision: 'a'.repeat(40), sourceHash: 'b'.repeat(64) };
const hashes = { configHash: 'c'.repeat(64), fixtureHash: 'd'.repeat(64), datasetHash: 'e'.repeat(64) };
const inventory = { passed: false, total: 0 };
const fixture = { id: 'fixture', kind: 'fixture', gates: ['B', 'T'], command: ['node', '-e', 'process.exit(7)', '--'] };
const acceptance = { id: 'receipt', kind: 'acceptance', gates: ['B', 'T'], dependencies: [], source: 'staging', bar: 'perfect' };
const config = manifest;
const green = { status: 'passed', exitCode: 0 };

function evidenceFixture(fn) {
  const base = mkdtempSync(join(tmpdir(), 'eko-eval-test-'));
  writeFileSync(join(base, 'observations.json'), '{"source":"test-only"}\n');
  const evidence = { candidate: candidate.revision, sourceHash: candidate.sourceHash, ...hashes, source: 'staging',
    window: { from: '2026-10-01T00:00:00Z', to: '2026-10-02T00:00:00Z' }, commands: [{ argv: ['pnpm', 'test'], exitCode: 0 }],
    artifacts: [{ path: 'observations.json', sha256: digest(readFileSync(join(base, 'observations.json'))) }],
    metrics: { total: 1, passed: 1, failed: 0, skipped: 0, missing: 0 } };
  try { fn(evidence, { candidate, ...hashes, inventory, base }); } finally { rmSync(base, { recursive: true, force: true }); }
}

test('runner propagates exit failure and rejects exit-zero missing test output', async () => {
  assert.equal((await runFixture(fixture)).exitCode, 7);
  assert.equal((await runFixture({ ...fixture, command: ['node', '-e', 'process.exit(0)', '--'] })).status, 'failed');
  const r = await evaluate({ manifest: config, gate: 'B', candidate, inventory, ...hashes, execute: async () => { throw Error('fixture'); } });
  assert.equal(r.exitCode, 1); assert.equal(r.results[0].status, 'failed'); assert.equal(r.results.find(s => s.id === 'receipts').status, 'pending');
});

test('independent stages do not run each other prerequisites; missing evidence remains red', async () => {
  const b = await evaluate({ manifest, gate: 'B', candidate, inventory, ...hashes, execute: async () => green });
  const t = await evaluate({ manifest, gate: 'T', candidate, inventory, ...hashes, execute: async () => green });
  assert.equal(b.results.find(r => r.id === 'product').status, 'skipped');
  assert.equal(t.results.find(r => r.id === 'restore').status, 'skipped');
  assert.equal(t.results.find(r => r.id === 'product').status, 'pending');
  assert.equal(b.exitCode, 1); assert.equal(t.exitCode, 1);
  assert.equal(b.results.find(r => r.id === 'execution').dependencies.includes('075'), true);
});

test('v4 quote-only is explicit and cannot become executable acceptance', async () => {
  for (const v4 of ['quote-only', 'executable']) {
    const r = await evaluate({ manifest: { ...manifest, v4 }, gate: 'B', candidate, inventory, ...hashes, execute: async () => green });
    assert.equal(r.results.find(s => s.id === 'execution-v4').status, v4 === 'quote-only' ? 'skipped' : 'pending');
    assert.equal(r.passed, false);
  }
});

test('measured provenance binds candidate/worktree/config/fixtures/dataset and artifacts', () => evidenceFixture((e, c) => {
  assert.equal(acceptanceResult(acceptance, manifest, e, c).status, 'passed');
  for (const key of ['candidate', 'sourceHash', 'configHash', 'fixtureHash', 'datasetHash', 'source']) {
    assert.equal(acceptanceResult(acceptance, manifest, { ...e, [key]: 'wrong' }, c).status, 'failed');
  }
  for (const patch of [{ artifacts: [] }, { artifacts: [{ path: '../missing', sha256: hashes.datasetHash }] },
    { commands: [{ argv: ['pnpm', 'test'], exitCode: 2 }] }, { window: e.window.from },
    { metrics: { ...e.metrics, skipped: 1 } }, { metrics: { ...e.metrics, total: 0, passed: 0 } }]) {
    assert.equal(acceptanceResult(acceptance, manifest, { ...e, ...patch }, c).status, 'failed');
  }
  assert.equal(acceptanceResult({ ...acceptance, dependencies: ['075'] }, manifest, e, c).status, 'pending');
  writeFileSync(join(c.base, 'observations.json'), 'changed');
  assert.equal(acceptanceResult(acceptance, manifest, e, c).status, 'failed');
}));

test('normalizer never counts synthetic or unlabeled coins and retains class gaps', () => evidenceFixture((e, c) => {
  const row = { coin: `0x${'1'.repeat(40)}`, blockNumber: '100', blockHash: `0x${'2'.repeat(64)}`, chainId: 4663,
    class: 'honeypot', source: 'observed', labelVersion: 'test-version', evidence: e.artifacts };
  const one = labelInventory({ schemaVersion: 1, coins: [row] }, c.base);
  assert.equal(one.total, 1); assert.equal(one.passed, false); assert.equal(one.byClass.honeypot, 1);
  assert.equal(one.missingClasses.length, 8);
  const rejected = labelInventory({ schemaVersion: 1, coins: [row, row, { ...row, source: 'synthetic' }, { ...row, blockHash: null }] }, c.base);
  assert.equal(rejected.total, 1); assert.deepEqual(rejected.rejected, [1, 2, 3]);
  assert.equal(passBar({ bar: 'truth' }, e, one, candidate), false);
  assert.equal(passBar({ bar: 'perfect' }, e, one, candidate), true);
}));

test('zero honeypot fills requires a nonzero fully observed classified denominator', () => {
  const observations = Array.from({ length: 10 }, (_, i) => ({ orderId: `test-order-${i}`, label: 'honeypot', outcome: 'refused' }));
  const bar = (m, rows = observations) => passBar({ bar: 'fills' }, { metrics: m, observations: rows }, inventory, candidate);
  const m = { observedOrders: 10, classifiedOrders: 10, honeypotFills: 0, missing: 0 };
  assert.equal(bar(m), true);
  assert.equal(bar(m, []), false);
  assert.equal(bar(m, observations.map(r => ({ ...r, outcome: 'filled' }))), false);
  assert.equal(bar(m, observations.map(r => ({ ...r, label: 'unknown' }))), false);
  assert.equal(bar(m, observations.map(r => ({ ...r, orderId: 'same' }))), false);
  for (const patch of [{ observedOrders: 0, classifiedOrders: 0 }, { observedOrders: 11 }, { honeypotFills: 1 }, { missing: 1 }, { observedOrders: NaN }]) assert.equal(bar({ ...m, ...patch }), false);
});

test('latency uses completed Fast Scan cohort and strict preflight p95; labels use measured precision', () => {
  const scanCohort = { candidate: candidate.revision, source: 'staging', eligibleCount: 1,
    samples: [{ coin: `0x${'1'.repeat(40)}`, venue: 'pons', discoveredAt: 1000, engineStartedAt: 1100,
      firstVerdictAt: 1200, criticalCompleteAt: 6000, verdictId: 'test-verdict' }] };
  const e = { scanCohort, metrics: { preflightEligible: 1, preflightMs: [149] } };
  assert.equal(passBar({ bar: 'latency' }, e, inventory, candidate), true);
  assert.equal(passBar({ bar: 'latency' }, { ...e, metrics: { preflightEligible: 1, preflightMs: [150] } }, inventory, candidate), false);
  assert.equal(passBar({ bar: 'precision' }, { metrics: { truePositive: 9, falsePositive: 1, regressions: 0, missing: 0 } }, inventory, candidate), true);
  assert.equal(passBar({ bar: 'precision' }, { metrics: { truePositive: 0, falsePositive: 0, regressions: 0, missing: 0 } }, inventory, candidate), false);
});

test('Guard acceptance consumes owned report table without executing datasets', () => evidenceFixture((e, c) => {
  const suite = { ...acceptance, id: 'guard-locked', source: 'guard-report', bar: 'guard', dependencies: ['061'] };
  const supplied = { ...e, source: 'guard-report', packet: '061', upstream: { datasetHash: '1'.repeat(64), labelHash: '2'.repeat(64), configHash: '3'.repeat(64) }, complete: true, accepted: true, denominatorsVerified: true, gates: [{ status: 'passed' }] };
  assert.equal(acceptanceResult(suite, manifest, supplied, c).status, 'pending');
  const ready = { ...manifest, dependencies: { merged: [...manifest.dependencies.merged, '061'], pending: [] } };
  assert.equal(acceptanceResult(suite, ready, supplied, c).status, 'passed');
  assert.equal(acceptanceResult(suite, ready, { ...supplied, gates: [{ status: 'failed' }] }, c).status, 'failed');
  assert.equal(acceptanceResult(suite, ready, { ...supplied, denominatorsVerified: false }, c).status, 'failed');
}));

test('nightly has no implicit provider authorization', async () => {
  await assert.rejects(evaluate({ manifest: { ...manifest, generation: { enabled: true, approvedBudgetUsd: 1 } }, gate: 'T', candidate, inventory, ...hashes }), /authorized/);
});

test('omitting a mandatory acceptance suite cannot produce a green stage', async () => {
  for (const suites of [[], manifest.suites.filter(s => s.id !== 'honeypot-fills')]) {
    await assert.rejects(evaluate({ manifest: { ...manifest, suites }, gate: 'T', candidate, inventory, ...hashes }), /omitted/);
  }
});
