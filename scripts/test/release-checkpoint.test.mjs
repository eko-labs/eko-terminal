import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { checkpoint, smokeIds, dailyMetrics, readArtifact } from '../release-checkpoint.mjs';

const candidate = { revision: 'a'.repeat(40), sourceHash: 'b'.repeat(64) };
const now = '2026-10-16T17:00:00Z';
function fixture() {
  const form = { schemaVersion: 1, candidate, records: {} }, store = {};
  const context = { candidate, now, manifest: { suites: ['B', 'T'].map(gate => ({ id: `suite-${gate}`, gates: [gate], kind: 'acceptance', dependencies: [] })), dependencies: { merged: [] } }, read: ref => store[ref.path] };
  const set = (key, data, source = 'live') => {
    form.records[key] = { path: `evals/reports/${key}.json`, sha256: 'c'.repeat(64) };
    store[form.records[key].path] = { schemaVersion: 1, kind: key, source, candidate,
      window: { from: '2026-10-13T16:00:00Z', to: '2026-10-16T16:00:00Z' }, data };
    return store[form.records[key].path];
  };
  for (const gate of ['B', 'T']) {
    const row = set(`eval${gate}`, {});
    Object.assign(row, { gate, configHash: 'd'.repeat(64), fixtureHash: 'e'.repeat(64), datasetHash: 'f'.repeat(64),
      results: [{ id: `suite-${gate}`, kind: 'acceptance', status: 'passed' }], passed: true, exitCode: 0, completedAt: now });
  }
  for (const [key, role] of [['decisionB', 'Dev A'], ['decisionT', 'Owner'], ['guardVetoClear', 'Dev A'], ['decisionProduct', 'Owner'], ['decisionCapIncrease', 'Owner']])
    set(key, { role, decision: 'go', signedAt: '2026-10-16T16:00:00Z' }, 'approval');
  for (const key of smokeIds) set(key, { status: 'passed', disposition: 'cut-to-d0' });
  set('rollback', { seconds: 599, previousImageRetained: true, schemaCompatible: true, ledgersPreserved: true,
    readinessPassed: true, tradingLive: false, liveTradingEnabled: false });
  set('incidents', { openSev1: 0, openSev2: 0, sev1SinceLaunch: 0 });
  const order = { orderId: '10000000-0000-4000-8000-000000000001', txHash: `0x${'1'.repeat(64)}`, blockHash: `0x${'2'.repeat(64)}`,
    actualAmount: '10', sellCheck: 'passed', evidence: { path: 'evals/reports/sell.json', sha256: '3'.repeat(64) } };
  store[order.evidence.path] = { orderId: order.orderId, txHash: order.txHash, blockHash: order.blockHash, amount: '10', status: 'passed', origin: 'measured' };
  const metrics = Object.fromEntries(dailyMetrics.map(k => [k, 0]));
  Object.assign(metrics, { refusalReasons: {}, requests: 1, preflights: 1, eligibleOrders: 1 });
  set('betaDaily', { coverageComplete: true, confirmedOrders: 1, orders: [order], metrics,
    scanMs: [5000], scanEligible: 1, verdictMs: [5000], verdictEligible: 1, preflightMs: [149], preflightEligible: 1 });
  set('stopVerification', { tradingLive: false, liveEnabled: false, ordersRefused: true });
  set('publicLaunch', { startedAt: '2026-10-13T16:00:00Z' });
  set('onCall', { shifts: ['Dev A', 'Dev B'].map(role => ({ role, reachable: true, from: '2026-10-13T16:00:00Z', to: '2026-10-16T16:00:00Z' })) }, 'approval');
  return { form, context, store, set, run: () => checkpoint(form, context) };
}

test('empty form and unavailable 087 remain pending, no invented approvals or zero fills', () => {
  const r = checkpoint({ schemaVersion: 1, records: {} }, { now });
  assert.deepEqual(r.gates, { B: 'pending', T: 'pending', product: 'pending', capIncrease: 'pending', D0: 'pending' });
  assert.equal(r.summary, null); assert.equal(r.exitCode, 1); assert.equal(r.goNoGo, 'no-go');
});
test('complete synthetic records exercise the consumer only, never authorize D0 or deployment', () => {
  const r = fixture().run();
  assert.equal(r.gates.product, 'passed'); assert.equal(r.gates.capIncrease, 'passed'); assert.equal(r.gates.D0, 'pending');
  assert.equal(r.summary.scanP95Ms, 5000); assert.equal(r.summary.labelPrecision, null);
  assert.equal(r.providerRequests, 0); assert.equal(r.actualCostUsd, 0);
});
test('candidate mismatch, stale reports, omitted suites and interrupted reports cannot pass', () => {
  for (const mutation of [f => { f.form.candidate = { ...candidate, sourceHash: '9'.repeat(64) }; },
    f => { f.store['evals/reports/evalT.json'].candidate = { ...candidate, revision: '9'.repeat(40) }; },
    f => { f.store['evals/reports/evalT.json'].results = []; },
    f => { delete f.store['evals/reports/evalT.json'].completedAt; }]) {
    const f = fixture(); mutation(f); assert.notEqual(f.run().gates.T, 'passed');
  }
});
test('upstream pending dependencies and fixture smoke never become measured acceptance', () => {
  const f = fixture(); f.context.manifest.suites[1].dependencies = ['129'];
  assert.equal(f.run().gates.T, 'pending');
  f.context.manifest.suites[1].dependencies = [];
  f.store['evals/reports/telegram.json'].source = 'fixture';
  assert.equal(f.run().gates.product, 'pending');
});
test('miss fails the gate and requires stop even with incomplete metrics or failed paging evidence', () => {
  const f = fixture(), beta = f.store['evals/reports/betaDaily.json'].data;
  beta.orders[0].sellCheck = 'failed'; f.store['evals/reports/sell.json'].status = 'failed';
  delete beta.metrics.errors; delete f.form.records.stopVerification;
  const r = f.run(); assert.equal(r.gates.T, 'failed'); assert.equal(r.gates.capIncrease, 'failed');
  assert.equal(r.tradingMustBeOff, true); assert.equal(r.stop.verified, false);
  assert.deepEqual(r.stop.command, ['pnpm', 'ops', 'guard_miss']);
});
test('missing/zero fills, unavailable replay and incomplete latency retain missing denominators', () => {
  for (const mutation of [b => { b.coverageComplete = false; }, b => { b.confirmedOrders = 0; b.orders = []; },
    b => { b.orders[0].sellCheck = 'unavailable'; }, b => { b.preflightMs = []; },
    b => { b.confirmedOrders = 2; }, b => { b.orders.push(b.orders[0]); b.confirmedOrders = 2; }]) {
    const f = fixture(); mutation(f.store['evals/reports/betaDaily.json'].data);
    assert.notEqual(f.run().gates.T, 'passed');
  }
});
test('measured replay must match the actual fill and retained artifact', () => {
  const f = fixture(); f.store['evals/reports/sell.json'].amount = '11';
  assert.equal(f.run().checks.betaDaily.status, 'failed');
});
test('smoke omission, rollback at 600 seconds, Sev 2 and rota gaps block product release', () => {
  for (const mutation of [f => { delete f.form.records['delete-harness-data']; },
    f => { f.store['evals/reports/rollback.json'].data.seconds = 600; },
    f => { f.store['evals/reports/incidents.json'].data.openSev2 = 1; },
    f => { f.store['evals/reports/onCall.json'].data.shifts[1].to = '2026-10-16T15:59:59Z'; }]) {
    const f = fixture(); mutation(f); assert.notEqual(f.run().gates.product, 'passed');
  }
});
test('spend and latency pass bars are enforced without raising limits', () => {
  for (const mutation of [b => { b.metrics.spendUsd = 1; }, b => { b.preflightMs = [150]; }, b => { b.scanMs = [5001]; }]) {
    const f = fixture(); mutation(f.store['evals/reports/betaDaily.json'].data);
    assert.equal(f.run().checks.betaDaily.status, 'failed');
  }
});
test('72 hours, full incident window, no Sev 1 and later Owner sign-off are independent', () => {
  for (const mutation of [f => { f.store['evals/reports/betaDaily.json'].window.to = '2026-10-16T15:59:59Z'; },
    f => { f.store['evals/reports/incidents.json'].window.from = '2026-10-14T00:00:00Z'; },
    f => { f.store['evals/reports/incidents.json'].data.sev1SinceLaunch = 1; },
    f => { delete f.form.records.decisionCapIncrease; },
    f => { f.store['evals/reports/decisionCapIncrease.json'].data.signedAt = '2026-10-16T15:59:59Z'; }]) {
    const f = fixture(); mutation(f); assert.notEqual(f.run().gates.capIncrease, 'passed');
  }
});
test('artifact loader checks hashes, traversal, symlinks, size and missing evidence', () => {
  const base = mkdtempSync(join(tmpdir(), 'eko-088-artifact-'));
  try {
    mkdirSync(join(base, 'evals/reports'), { recursive: true });
    const bytes = JSON.stringify({ schemaVersion: 1 });
    writeFileSync(join(base, 'evals/reports/record.json'), bytes);
    const ref = { path: 'evals/reports/record.json', sha256: createHash('sha256').update(bytes).digest('hex') };
    assert.deepEqual(readArtifact(base, ref), { schemaVersion: 1 });
    assert.throws(() => readArtifact(base, { ...ref, sha256: '0'.repeat(64) }));
    assert.throws(() => readArtifact(base, ref, { remaining: 0 }));
    assert.throws(() => readArtifact(base, { ...ref, path: 'evals/reports/../record.json' }));
    symlinkSync('record.json', join(base, 'evals/reports/link.json'));
    assert.throws(() => readArtifact(base, { ...ref, path: 'evals/reports/link.json' }));
    assert.throws(() => readArtifact(base, { ...ref, path: 'evals/reports/missing.json' }));
    writeFileSync(join(base, 'evals/reports/large.json'), ' '.repeat(1048577));
    assert.throws(() => readArtifact(base, { ...ref, path: 'evals/reports/large.json' }));
  } finally { rmSync(base, { recursive: true, force: true }); }
});
