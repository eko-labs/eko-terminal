import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RpcMeter } from '@eko/chain';
import { GUARD_CHECK_IDS, GUARD_CHECK_TIERS } from '@eko/shared';
import { PilotManifestSchema, initialPilotCheckpoint, pilotHash, pilotJobKey, pilotReport, runCoveragePilot, splitPilotLogs, PilotStop, validatePilotCheckpoint } from '../src/coverage-pilot.js';
import type { PilotIO, PilotManifest } from '../src/coverage-pilot.js';
import { PilotUsageStore, atomicPilotJson, readPilotJson, pilotCostReport, pilotFileHash, verifyPilotSnapshot } from '../src/coverage-pilot-store.js';
import type { PilotLedger } from '../src/coverage-pilot-store.js';
import { coveragePilotMain } from '../src/coverage-pilot-cli.js';
import { replayFixture } from './replay-fixture.js';
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const cursor = (n: number) => ({ chainId: 4663, blockNumber: String(n), blockHash: hash(n), timestampSec: String(1790812800 + n),
  transactionIndex: null, executionOrdinal: null, boundary: 'block_end' as const });
function manifest(): PilotManifest {
  const from = cursor(1), through = cursor(200000), cut = { cursor: through, acquisitionSequence: '10' };
  return PilotManifestSchema.parse({ version: 'coverage-pilot-045.1', validation: 'fixture', sourceRevision: hash(900), from, through,
    availability: { id: hash(901), sourceId: 'sample-window', sourceRevision: hash(900), replayMode: 'retrospective', cut, watermark: through, acquiredAt: '2026-10-02T00:00:00Z' },
    snapshotFiles: [{ path: 'sample.json', sha256: 'a'.repeat(64) }],
    selected: [{ coin: addr(100), cursor: through, knownAt: cut, floatRaw: '1000', candidates: [
      { address: addr(1), liquidRaw: '500', selected: true, reason: 'held-mass' },
      { address: addr(2), liquidRaw: '100', selected: false, reason: 'cap' },
    ], checks: [] }], jobs: [], budget: { approvalRef: 'sample-approval', pricingEvidence: hash(902), rpcUnitNanoUsd: '6000', capNanoUsd: '1000000000', checkpointUnits: 250000,
      weights: { eth_chainId: 1, eth_getLogs: 2, eth_getBlockByNumber: 1, eth_getBlockReceipts: 1, debug_traceBlockByNumber: 5 },
      paidStartsPerSecond: 5, publicStartsPerSecond: 3, computeStorageNanoUsd: '0', indexedSubscriptionNanoUsd: '0', humanReviewNanoUsd: '0' } });
}
function harness(m: PilotManifest) {
  let time = 0; const artifacts = new Map<string, { hash: string; status: string }>();
  const c = initialPilotCheckpoint(m, 'a'.repeat(64));
  const io: PilotIO = { now: () => time++, rss: () => 123456, stopped: () => false,
    save: vi.fn(async () => {}), artifact: vi.fn(async key => artifacts.get(key) ?? null),
    putArtifact: vi.fn(async (key, value, status) => { const hash = pilotHash(value); artifacts.set(key, { hash, status }); return hash; }),
    replay: vi.fn(async () => ({ complete: true, evaluations: 20, elapsedMs: 100 })),
    logs: vi.fn(async () => []), trace: vi.fn(async () => ({ status: 'complete', value: {} })), rangeLimit: e => (e as Error).message === 'range' };
  return { c, io, artifacts };
}
function logJob() { return { kind: 'logs' as const, id: 'sample-logs', priority: 'critical' as const, from: '1', through: '4', addresses: [addr(1), addr(2)], topics: [[hash(1), hash(2)]] }; }
function ledger(m: PilotManifest): PilotLedger { return { version: 1, manifestHash: pilotHash(m), calls: 0, units: 0, paidNanoUsd: '0', rows: [] }; }

describe('coverage pilot source, batching and resume', () => {
  it('rejects expanded windows, changed availability, post-cut state and overlapping balances', () => {
    const m = manifest();
    expect(() => PilotManifestSchema.parse({ ...m, through: cursor(200001) })).toThrow();
    expect(() => PilotManifestSchema.parse({ ...m, sourceRevision: hash(903) })).toThrow();
    expect(() => PilotManifestSchema.parse({ ...m, selected: [{ ...m.selected[0], knownAt: { ...m.availability.cut, acquisitionSequence: '11' } }] })).toThrow();
    expect(() => PilotManifestSchema.parse({ ...m, selected: [{ ...m.selected[0], floatRaw: '1' }] })).toThrow();
    expect(() => PilotManifestSchema.parse({ ...m, snapshotFiles: [{ path: '../sample', sha256: 'a'.repeat(64) }] })).toThrow();
  });
  it('keeps local replay independent of missing API/approval and does not acquire', async () => {
    const m = manifest(); m.budget.approvalRef = null; m.jobs = [logJob()]; const h = harness(m);
    await runCoveragePilot(m, h.c, h.io, false);
    expect(h.c.status).toBe('prepared'); expect(h.c.pending).toHaveLength(1); expect(h.io.logs).not.toHaveBeenCalled();
    expect(pilotReport(m, h.c).operationalTarget.status).toBe('unmeasured');
    expect(pilotReport(m, h.c).independentProgress.replayComplete).toBe(true);
    await runCoveragePilot(m, h.c, h.io, true);
    expect(h.c.reason).toBe('approval_or_pricing_missing'); expect(h.io.replay).toHaveBeenCalledTimes(1);
  });
  it('splits ranges, addresses and topic ORs exactly once; restart preserves the cursor and artifacts', async () => {
    const m = manifest(); m.jobs = [logJob()]; const h = harness(m);
    h.io.logs = vi.fn(async j => { if (j.from !== j.through || j.addresses.length > 1 || (j.topics[0] as string[]).length > 1) throw new Error('range'); return [j]; });
    await runCoveragePilot(m, h.c, h.io, true);
    expect(h.c.status).toBe('complete'); expect(h.c.completed).toHaveLength(16);
    expect(new Set(h.c.completed.map(j => j.key)).size).toBe(16);
    const checkpoint = JSON.parse(JSON.stringify(h.c));
    await runCoveragePilot(m, checkpoint, h.io, true);
    expect(h.io.replay).toHaveBeenCalledTimes(1); expect(h.c.pending).toHaveLength(0);
    const calls = vi.mocked(h.io.logs).mock.calls.length;
    expect(calls).toBe(31);
    const topicSplit = splitPilotLogs({ ...logJob(), from: '1', through: '1', addresses: [addr(1)] });
    expect(topicSplit.map(j => j.kind === 'logs' && j.topics)).toEqual([[[hash(1)]], [[hash(2)]]]);
  });
  it('prioritizes critical then candidates, deduplicates trace blocks, and bounds initial filters', async () => {
    const m = manifest(); m.jobs = [{ ...logJob(), id: 'history', priority: 'history' },
      { kind: 'trace', id: 'trace-a', cursor: cursor(5) }, { kind: 'trace', id: 'trace-b', cursor: cursor(5) },
      { ...logJob(), id: 'candidates', priority: 'candidates' }, { ...logJob(), addresses: Array.from({ length: 51 }, (_, i) => addr(i + 1)), through: '200000' }];
    const h = harness(m);
    expect(h.c.pending.map(j => j.id)).toEqual(['sample-logs', 'candidates', 'trace-a', 'history']);
    await runCoveragePilot(m, h.c, h.io, true);
    for (const [j] of vi.mocked(h.io.logs).mock.calls) {
      expect(j.addresses.length).toBeLessThanOrEqual(50);
      expect(Number(j.through) - Number(j.from) + 1).toBeLessThanOrEqual(Math.min(100000, Math.floor(200000 / j.addresses.length)));
    }
    expect(h.io.trace).toHaveBeenCalledTimes(1);
  });
  it('recovers artifact commit before cursor commit without another paid request', async () => {
    const m = manifest(); m.jobs = [logJob()]; const h = harness(m);
    h.artifacts.set(pilotJobKey(m.jobs[0]), { hash: 'b'.repeat(64), status: 'acquired' });
    await runCoveragePilot(m, h.c, h.io, true);
    expect(h.io.logs).not.toHaveBeenCalled(); expect(h.c.completed[0].artifactHash).toBe('b'.repeat(64));
    const corrupt = structuredClone(h.c); corrupt.pending = [{ ...logJob(), addresses: [addr(999)] }];
    expect(() => validatePilotCheckpoint(m, corrupt)).toThrow('expanded scope');
    const changed = manifest(); changed.snapshotFiles[0].sha256 = 'b'.repeat(64);
    await expect(runCoveragePilot(changed, h.c, h.io, true)).rejects.toThrow('source mismatch');
  });
  it('retains cap/provider/unsupported failures and resumes without false completion', async () => {
    const m = manifest(); m.jobs = [logJob(), { kind: 'trace', id: 'trace', cursor: cursor(5) }]; const h = harness(m);
    h.io.logs = vi.fn(async () => { throw new PilotStop('cap'); });
    await runCoveragePilot(m, h.c, h.io, true);
    expect(h.c.status).toBe('stopped'); expect(h.c.pending).toHaveLength(2);
    h.io.logs = vi.fn(async () => []); h.io.trace = vi.fn(async () => ({ status: 'unsupported', value: {} }));
    await runCoveragePilot(m, h.c, h.io, true);
    const report = pilotReport(m, h.c);
    expect(report.internalFunding).toMatchObject({ liveComplete: false, diagnosticBlocks: 0 });
    expect(report.coverage[0]).toMatchObject({ candidateRaw: '500', excludedRaw: '100', unenumeratedRaw: '400', criticalComplete: false, lowerComplete: false });
    expect(report.coverage[0].critical.every(c => c.status === 'missing')).toBe(true);
  });
  it('records captured complete checks and freezes only a measured complete operational observation', async () => {
    const m = manifest(); m.validation = 'measured';
    m.selected[0].checks = GUARD_CHECK_IDS.map(id => ({ id, tier: GUARD_CHECK_TIERS[id], status: 'complete', evidenceIds: [hash(3)], failureCode: null,
      coverage: { scopeId: 'sample', from: m.from, through: m.through, complete: true, gaps: [], methodVersion: '2.0.0', coveredUnits: null,
        excludedUnits: null, topLevelNative: true, internalNative: true, firstEverEstablished: false, sourceHashes: [hash(3)] } }));
    const h = harness(m); await runCoveragePilot(m, h.c, h.io, true);
    const report = pilotReport(m, h.c);
    expect(report.operationalTarget).toMatchObject({ status: 'frozen', criticalComplete: 1, lowerComplete: 1, proposed170PerSecondMet: true });
    expect(report.capability.usable).toBe(false); expect(report.released).toBe(false);
    expect(report.gaps).toContain('seven_day_accuracy_unmeasured');
  });
});

describe('durable shared pilot budget', () => {
  it('meters weighted failed attempts/batch items, survives day rollover and restart, and clips concurrent work', async () => {
    const m = manifest(); m.budget.checkpointUnits = 12; m.budget.capNanoUsd = '50000';
    const saved = ledger(m); let persisted = structuredClone(saved), clock = Date.UTC(2026, 9, 1);
    const store = new PilotUsageStore(m, saved, async value => { persisted = structuredClone(value); });
    const meter = new RpcMeter({ RPC_HTTP_URL: 'http://fixture.invalid', RPC_WEIGHTS: JSON.stringify(m.budget.weights) }, { store, now: () => clock,
      sleep: async ms => { clock += ms; }, log: () => {}, alert: () => {}, onSessionBudget: () => {} });
    let calls = 0;
    const send = async () => { calls++; throw new Error('fixture provider failed'); };
    await expect(meter.attempt('paid', { method: 'debug_traceBlockByNumber' }, send)).rejects.toThrow('fixture');
    const okay = { paid: async () => { calls++; return []; }, public: async () => { calls++; return []; } };
    await meter.request([{ method: 'eth_getLogs' }, { method: 'eth_getBlockReceipts' }], okay);
    expect(saved.units).toBe(8); expect(saved.calls).toBe(3); expect(saved.paidNanoUsd).toBe('48000');
    const resumed = new PilotUsageStore(m, persisted, async () => {});
    expect((await resumed.reserve('2026-10-02', 'paid', 'eth_getBlockReceipts', 1, Infinity)).allowed).toBe(false);
    const results = await Promise.all(Array.from({ length: 4 }, () => resumed.reserve('2026-10-02', 'public', 'eth_getLogs', 2, Infinity)));
    expect(results.filter(r => r.allowed)).toHaveLength(2); expect(persisted.units).toBe(12); expect(calls).toBe(3);
    expect(pilotCostReport(m, persisted)).toMatchObject({ admittedRequestUnits: 12, invoiceChargedNanoUsd: null,
      categories: { blockTraces: { calls: 1, units: 5 }, indexedPages: { calls: 0, units: 0 }, anvilUpstream: { calls: 0, units: 0 } } });
    await meter.close();
  });
  it('fails closed on missing approval, unverified weights, changed ledger and persistence failure', async () => {
    const m = manifest(); const saved = ledger(m), persist = vi.fn(async () => { throw new Error('disk'); });
    const store = new PilotUsageStore(m, saved, persist);
    await expect(store.reserve('2026-10-01', 'paid', 'eth_getLogs', 2, Infinity)).rejects.toThrow('disk'); expect(saved.units).toBe(0);
    await expect(store.reserve('2026-10-01', 'paid', 'unknown', 1, Infinity)).rejects.toThrow('weight');
    m.budget.approvalRef = null;
    await expect(store.reserve('2026-10-01', 'paid', 'eth_getLogs', 2, Infinity)).rejects.toThrow('approval');
    expect(() => new PilotUsageStore(manifest(), { ...saved, units: 1 }, async () => {})).toThrow();
  });
});

it('verifies a closed immutable snapshot and runs local replay with no network or ports', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'eko-045-test-'));
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const snapshot = join(dir, 'snapshot'), output = join(dir, 'output');
    const db = await replayFixture(1, 3, snapshot); await db.close();
    const files: string[] = [];
    async function walk(path: string, prefix = '') {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const p = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(join(path, entry.name), p); else files.push(p);
      }
    }
    await walk(snapshot);
    const m = manifest(); m.jobs = [logJob()]; m.budget.approvalRef = null;
    m.snapshotFiles = await Promise.all(files.map(async path => ({ path, sha256: await pilotFileHash(join(snapshot, path)) })));
    const manifestPath = join(dir, 'manifest.json'); await atomicPilotJson(manifestPath, m);
    const before = m.snapshotFiles.map(f => f.sha256);
    expect(await coveragePilotMain(['--local', manifestPath, snapshot, output])).toBe(0);
    const report = await readPilotJson<Record<string, any>>(join(output, 'report.json'));
    expect(report?.cost.admittedRequestUnits).toBe(0); expect(report?.performance.replay.evaluations).toBeGreaterThan(0);
    expect(report?.status).toBe('prepared'); expect(report?.independentProgress.remainingJobs).toBe(1);
    expect(await coveragePilotMain(['--local', manifestPath, snapshot, output])).toBe(0);
    expect((await readPilotJson<Record<string, any>>(join(output, 'report.json')))?.performance.replay.evaluations).toBe(report?.performance.replay.evaluations);
    expect(await Promise.all(files.map(path => pilotFileHash(join(snapshot, path))))).toEqual(before);
    await expect(coveragePilotMain(['--acquire', manifestPath, snapshot, output])).rejects.toThrow('approval');
    await symlink(join(snapshot, files[0]), join(snapshot, 'extra-link'));
    await expect(verifyPilotSnapshot(snapshot, m)).rejects.toThrow('symlink');
    await rm(join(snapshot, 'extra-link')); await writeFile(join(snapshot, 'extra'), 'neutral');
    await expect(verifyPilotSnapshot(snapshot, m)).rejects.toThrow('inventory');
  } finally { log.mockRestore(); await rm(dir, { recursive: true, force: true }); }
});
