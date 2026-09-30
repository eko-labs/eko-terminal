import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pilotHash } from '../src/coverage-pilot.js';
import { atomicPilotJson, readPilotJson } from '../src/coverage-pilot-store.js';
import { selectiveBackfillMain } from '../src/selective-backfill-cli.js';
import { SelectiveBackfillManifestSchema, backfillFrame, backfillRequestKey, initialBackfillCheckpoint,
  runSelectiveBackfill, type BackfillIO, type BackfillRequest, type BackfillResponse,
  type SelectiveBackfillManifest, type BackfillCheckpoint } from '../src/selective-backfill.js';

const DAY = 86400;
const D = 1790812800;
const hash = (n: number): `0x${string}` => `0x${n.toString(16).padStart(64, '0')}`;
const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const candidate = 'a'.repeat(64), owner = 'sample-runner';
// Sparse fixture: one block per day, plus repeated timestamps in a separate test.
const cursor = (n: number) => ({ chainId: 4663, blockNumber: String(n), blockHash: hash(n + 1),
  timestampSec: String(D + (n - 40) * DAY), boundary: 'block_end' as const, transactionIndex: null, executionOrdinal: null });
const knownAt = (n = 61, acquisitionSequence = '5') => ({ cursor: cursor(n), acquisitionSequence });
const launch = (coin = addr(100), n = 40) => ({ coin, creation: cursor(n), knownAt: knownAt() });
const logFilter = (coin = addr(100)) => ({ addresses: [coin], topics: [hash(800)] });
function manifest(mode: 'pilot7' | 'cohort14plus7' = 'pilot7'): SelectiveBackfillManifest {
  return SelectiveBackfillManifestSchema.parse({ version: 'selective-backfill-048.1', validation: 'fixture', sourceRevision: hash(900),
    availability: { id: hash(901), sourceId: 'sample-launch-source', sourceRevision: hash(900), replayMode: 'retrospective',
      cut: knownAt(), watermark: cursor(61), acquiredAt: '2026-10-23T00:00:00Z' },
    startSec: String(D), mode, historyMetadata: false, metadataFilters: [logFilter(addr(200))],
    selected: [{ launch: launch(), untilSec: String(D + 7 * DAY), filters: [logFilter(), logFilter(addr(300))], reason: 'sample' }],
    budget: { approvalRef: null, pricingEvidence: null, unitNanoUsd: '6000', capNanoUsd: '1000000000',
      fixedNanoUsd: '0', checkpointUnits: 250000, weights: { header: 1, logs: 2, boundary: 3 } } });
}
function event(n: number, address = addr(100), logIndex = 0) {
  return { address, cursor: cursor(n), knownAt: knownAt(), transactionHash: hash(n + 500),
    transactionIndex: 0, logIndex, topics: [hash(800)], data: '0x' };
}
function harness(m = manifest()) {
  let time = 0, revision = m.sourceRevision;
  const c = initialBackfillCheckpoint(m, candidate, owner), artifacts = new Map<string, BackfillResponse>();
  const snapshots: BackfillCheckpoint[] = [];
  const respond = (r: BackfillRequest): BackfillResponse => {
    if (r.kind === 'header') return { kind: 'header', cursor: cursor(Number(r.block)) };
    if (r.kind === 'boundary') return { kind: 'boundary', coin: r.coin, cursor: r.cursor, knownAt: knownAt(),
      state: { supplyRaw: '0', quoteReserveRaw: '0' }, methodVersion: '2.0.0' };
    const metadata = r.addresses.includes(addr(200)), first = Number(r.from);
    // Only a creation event in the metadata frame; all enumerated tokens are retained.
    const events = metadata ? [event(first, addr(200))] : [event(first, r.addresses[0])];
    return { kind: 'logs', events, launches: metadata ? [launch(addr(100), first), launch(addr(101), first)] : [] };
  };
  const io: BackfillIO = { sourceRevision: async () => revision, stopped: () => false, now: () => time++, rss: () => 1024,
    save: vi.fn(async checkpoint => { snapshots.push(structuredClone(checkpoint)); }),
    artifact: vi.fn(async key => artifacts.get(key) ?? null),
    putArtifact: vi.fn(async (key, value) => { artifacts.set(key, structuredClone(value)); }),
    request: vi.fn(async (r: BackfillRequest): Promise<BackfillResponse> => respond(r)) };
  const run = () => runSelectiveBackfill(m, c, io, candidate, owner);
  return { m, c, io, run, artifacts, snapshots, respond, reorg: () => { revision = hash(999); } };
}

describe('selective calendar and immutable source scope', () => {
  it('predeclares UTC 14+7, funding/recycle context and optional 51-day metadata without enabling history', () => {
    const frame = backfillFrame(String(D), 'cohort14plus7', true);
    expect(Number(frame.metadata.untilSec) - Number(frame.metadata.fromSec)).toBe(51 * DAY);
    expect(frame.launches).toEqual({ fromSec: String(D), untilSec: String(D + 14 * DAY) });
    expect(frame.lockedTest).toEqual({ fromSec: String(D + 7 * DAY), untilSec: String(D + 14 * DAY) });
    expect(frame.fitting.untilSec).toBe(String(D + 4 * DAY));
    expect(frame.funding.fromSec).toBe(String(D - DAY)); expect(frame.recycling.fromSec).toBe(String(D - 7 * DAY));
    expect(frame).toMatchObject({ primaryPurgeSeconds: 3900, sevenDaySensitivityOnly: true, historyEnabled: false });
  });
  it('rejects future source cuts, same-block late discoveries, duplicate choices and unbounded first pilots', () => {
    const m = manifest();
    expect(() => SelectiveBackfillManifestSchema.parse({ ...m, startSec: String(D + 30 * DAY) })).toThrow('Future');
    expect(() => SelectiveBackfillManifestSchema.parse({ ...m, sourceRevision: hash(999) })).toThrow();
    expect(() => SelectiveBackfillManifestSchema.parse({ ...m, selected: [m.selected[0], m.selected[0]] })).toThrow('Duplicate');
    expect(() => SelectiveBackfillManifestSchema.parse({ ...m, selected: [{ ...m.selected[0], launch: { ...launch(), knownAt: knownAt(61, '6') } }] })).toThrow();
    expect(() => SelectiveBackfillManifestSchema.parse({ ...m, selected: [{ ...m.selected[0], launch: launch(addr(100), 39) }] })).toThrow('seven days');
    expect(() => SelectiveBackfillManifestSchema.parse({ ...m, selected: [{ ...m.selected[0], filters: [logFilter(addr(300))] }] })).toThrow('token events');
  });
  it('enumerates the complete metadata denominator and reads parent state once before selected creation', async () => {
    const h = harness(), result = await h.run();
    expect(result.status).toBe('complete'); expect(result.enumerationComplete).toBe(true);
    expect(result.launches.map(l => l.coin)).toEqual([addr(100), addr(101)]);
    expect(result.selected[0]).toMatchObject({ from: '40', through: '46', complete: true });
    expect(vi.mocked(h.io.request).mock.calls.filter(([r]) => r.kind === 'boundary')).toEqual([
      [{ kind: 'boundary', coin: addr(100), cursor: cursor(39) }],
    ]);
    const requests = vi.mocked(h.io.request).mock.calls.map(([r]) => r);
    expect(requests.filter(r => r.kind === 'logs')).toHaveLength(3);
    expect(requests.some(r => r.kind === 'logs' && r.addresses.includes(addr(300)))).toBe(true);
    expect(result).toMatchObject({ nativeFundingComplete: false, historyComplete: false, released: false, invoiceNanoUsd: null });
    // Sparse searches plus parent pins, rather than per-block replay.
    expect(requests.filter(r => r.kind === 'header').length).toBeLessThan(20);
    expect(result.requestUnits).toBe(h.c.requests.reduce((n, r) => n + h.m.budget.weights[r.request.kind], 0));
  });
  it('does not clip an older selected token to cohort start, and extends observation through seven-day test follow-up', async () => {
    const m = manifest('cohort14plus7'); m.historyMetadata = true;
    m.selected = [{ ...m.selected[0], launch: launch(addr(100), 35), untilSec: String(D + 7 * DAY) },
      { launch: launch(addr(102), 53), untilSec: String(D + 20 * DAY), filters: [logFilter(addr(102))], reason: 'negative_control' }];
    const h = harness(m), result = await h.run();
    expect(result.status).toBe('complete'); expect(result.selected.map(s => [s.from, s.through])).toEqual([['35', '46'], ['53', '59']]);
    expect(result.metadataRanges[0]).toMatchObject({ from: '10', through: '60' });
    expect(vi.mocked(h.io.request).mock.calls.some(([r]) => r.kind === 'boundary' && r.cursor.blockNumber === '34')).toBe(true);
  });
  it('finds the first block at repeated timestamps without assuming a block rate', async () => {
    const mapped = (n: number) => ({ ...cursor(n), timestampSec: String(D + Math.floor((n - 40) / 2) * DAY) });
    const m = manifest(); m.availability.watermark = mapped(61); m.availability.cut.cursor = mapped(61);
    m.selected[0].launch.knownAt = m.availability.cut;
    const h = harness(m);
    h.io.request = vi.fn(async (r: BackfillRequest): Promise<BackfillResponse> => {
      if (r.kind === 'header') return { kind: 'header', cursor: mapped(Number(r.block)) };
      if (r.kind === 'boundary') return { kind: 'boundary', coin: r.coin, cursor: r.cursor, knownAt: m.availability.cut,
        state: { supplyRaw: '0' }, methodVersion: '2.0.0' };
      return { kind: 'logs', events: [], launches: [] };
    });
    const result = await h.run(); expect(result.status).toBe('complete');
    expect(result.selected[0]).toMatchObject({ from: '40', through: '53' });
    expect(result.metadataRanges[0]).toMatchObject({ from: '40', through: '53' });
  });
});

describe('adaptive acquisition, coverage and exact resume', () => {
  it('caches dense responses, splits time/address/topic ORs, sorts events and makes no duplicated calls on resume', async () => {
    const m = manifest(); m.metadataFilters = [{ addresses: [addr(200), addr(201)], topics: [[hash(800), hash(801)]] }];
    const h = harness(m);
    h.io.request = vi.fn(async (r: BackfillRequest): Promise<BackfillResponse> => {
      if (r.kind !== 'logs') return h.respond(r);
      if (r.addresses.some(a => [addr(200), addr(201)].includes(a))) {
        if (r.from !== r.through || r.addresses.length > 1 || (r.topics[0] as string[]).length > 1) return { kind: 'dense' as const };
        return { kind: 'logs' as const, events: [], launches: [] };
      }
      return { kind: 'logs' as const, events: [event(42, r.addresses[0], 2), event(40, r.addresses[0], 1)], launches: [] };
    });
    const first = await h.run(); expect(first.status).toBe('complete'); expect(first.metadataRanges).toHaveLength(28);
    const calls = vi.mocked(h.io.request).mock.calls.map(([r]) => backfillRequestKey(r));
    expect(new Set(calls).size).toBe(calls.length);
    const second = await h.run(); expect(second.requestCalls).toBe(first.requestCalls);
    expect(h.io.request).toHaveBeenCalledTimes(calls.length);
    const tape = h.artifacts.get(first.selected[0].ranges[0].artifactKey);
    expect(tape?.kind === 'logs' && tape.events.map(e => e.cursor.blockNumber)).toEqual(['40', '42']);
    expect(first.rpcNanoUsd).toBe(String(first.requestUnits * 6000));
  });
  it('preserves metadata and selected missing ranges as gaps and never narrows the history denominator', async () => {
    const m = manifest('cohort14plus7'); m.historyMetadata = true; const h = harness(m);
    h.io.request = vi.fn(async (r: BackfillRequest): Promise<BackfillResponse> => r.kind === 'logs' ? { kind: 'missing', reason: 'range_unavailable' } : h.respond(r));
    const result = await h.run(); expect(result.status).toBe('stopped'); expect(result.reason).toBe('coverage_gaps');
    expect(result.enumerationComplete).toBe(false); expect(result.selected[0].complete).toBe(false);
    expect(result.gaps.map(g => g.scope)).toEqual(['metadata', addr(100), addr(100)]);
    expect(result.frame.metadata.fromSec).toBe(String(D - 30 * DAY)); expect(result.historyComplete).toBe(false);
    const count = vi.mocked(h.io.request).mock.calls.length; await h.run(); expect(h.io.request).toHaveBeenCalledTimes(count);
  });
  it('retains the pending shard on cap stop, including all header, split and boundary units', async () => {
    const m = manifest(); m.budget.checkpointUnits = 3; const h = harness(m);
    const result = await h.run(); expect(result).toMatchObject({ status: 'stopped', reason: 'cap_reached', requestUnits: 3 });
    expect(h.io.request).toHaveBeenCalledTimes(3); expect(h.c.requests.every(r => r.artifactHash !== null)).toBe(true);
    await h.run(); expect(h.io.request).toHaveBeenCalledTimes(3);
    const corrupt = structuredClone(h.c); corrupt.units++;
    await expect(runSelectiveBackfill(m, corrupt, h.io, candidate, owner)).rejects.toThrow('ledger');
  });
  it('bounds address×block requests before dispatch and charges dense attempts against the monetary cap', async () => {
    const m = manifest(); m.metadataFilters[0].addresses = Array.from({ length: 51 }, (_, n) => addr(n + 200));
    const h = harness(m); await h.run();
    for (const [r] of vi.mocked(h.io.request).mock.calls) if (r.kind === 'logs') {
      expect(r.addresses.length).toBeLessThanOrEqual(50);
      expect((BigInt(r.through) - BigInt(r.from) + 1n) * BigInt(r.addresses.length)).toBeLessThanOrEqual(200000n);
    }
    const capped = manifest(); capped.budget.fixedNanoUsd = '1000'; capped.budget.capNanoUsd = '19000';
    const cap = harness(capped), result = await cap.run();
    expect(result).toMatchObject({ status: 'stopped', reason: 'cap_reached', requestUnits: 3, rpcNanoUsd: '18000', fixedNanoUsd: '1000' });
    expect(cap.io.request).toHaveBeenCalledTimes(3);
  });
  it('recovers response-before-checkpoint crash and refuses uncertain dispatches without duplicated requests', async () => {
    const h = harness();
    h.io.save = vi.fn(async (c: BackfillCheckpoint) => { if (c.requests.some(r => r.artifactHash)) throw new Error('checkpoint disk fixture'); });
    await expect(h.run()).rejects.toThrow('disk');
    // Recover the durable reservation saved before request/response commit.
    const persisted = initialBackfillCheckpoint(h.m, candidate, owner);
    Object.assign(persisted, structuredClone(h.c)); persisted.requests[0].artifactHash = null;
    h.io.save = vi.fn(async () => {});
    const result = await runSelectiveBackfill(h.m, persisted, h.io, candidate, owner);
    expect(result.status).toBe('complete');
    expect(vi.mocked(h.io.request).mock.calls.filter(([r]) => r.kind === 'header' && r.block === '61')).toHaveLength(1);
    const lost = harness(); lost.io.request = vi.fn(async () => { throw new Error('fixture dispatch lost'); });
    expect((await lost.run()).status).toBe('failed');
    expect((await lost.run()).reason).toBe('request_outcome_unconfirmed'); expect(lost.io.request).toHaveBeenCalledTimes(1);
  });
  it('halts reorgs without reusing orphaned artifacts or rewriting the source checkpoint', async () => {
    const h = harness(); const first = await h.run(); expect(first.status).toBe('complete');
    const count = vi.mocked(h.io.request).mock.calls.length, tape = pilotHash([...h.artifacts]); h.reorg();
    expect((await h.run()).reason).toBe('source_reorg'); expect(h.io.request).toHaveBeenCalledTimes(count);
    expect(pilotHash([...h.artifacts])).toBe(tape);
    const replacement = { ...h.m, sourceRevision: hash(999), availability: { ...h.m.availability, sourceRevision: hash(999) } };
    await expect(runSelectiveBackfill(replacement, h.c, h.io, candidate, owner)).rejects.toThrow('source/candidate');
    const mismatch = harness(); mismatch.io.request = vi.fn(async (r: BackfillRequest): Promise<BackfillResponse> => r.kind === 'header' && r.block === '61' ?
      { kind: 'header', cursor: { ...cursor(61), blockHash: hash(999) } } : mismatch.respond(r));
    expect((await mismatch.run()).reason).toBe('source_reorg');
  });
  it('rejects post-cut, out-of-filter and conflicting log pins; never certifies missing boundary state', async () => {
    for (const change of [
      (e: ReturnType<typeof event>) => ({ ...e, knownAt: knownAt(61, '6') }),
      (e: ReturnType<typeof event>) => ({ ...e, address: addr(999) }),
    ]) {
      const h = harness(); h.io.request = vi.fn(async (r: BackfillRequest): Promise<BackfillResponse> => r.kind === 'logs' ?
        { kind: 'logs', events: [change(event(Number(r.from), r.addresses[0]))], launches: [] } : h.respond(r));
      expect((await h.run()).status).not.toBe('complete');
    }
    const h = harness(); h.io.request = vi.fn(async (r: BackfillRequest): Promise<BackfillResponse> => r.kind === 'boundary' ?
      { kind: 'missing', reason: 'boundary_unavailable' } : h.respond(r));
    const result = await h.run(); expect(result.gaps).toContainEqual({ scope: addr(100), reason: 'boundary_unavailable', from: '39', through: '39' });
    expect(result.selected[0].complete).toBe(false);
  });
  it('requires recorded approval/pricing for a measured adapter, while fixtures need no paid authorization', async () => {
    const m = manifest(); m.validation = 'measured'; const h = harness(m);
    expect((await h.run()).reason).toBe('approval_or_pricing_missing'); expect(h.io.request).not.toHaveBeenCalled();
    await expect(runSelectiveBackfill(h.m, h.c, h.io, 'b'.repeat(64), owner)).rejects.toThrow('candidate');
    await expect(runSelectiveBackfill(h.m, h.c, h.io, candidate, 'another-runner')).rejects.toThrow('owner');
  });
});

it('runs a content-pinned offline fixture driver, durable resume and explicit incomplete-fixture reporting', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'eko-048-test-')), log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const h = harness(); await h.run();
    const fixture = { version: 'selective-backfill-fixture-048.1', responses: Object.fromEntries(h.artifacts) };
    const m = { ...h.m, sourceRevision: `0x${pilotHash(fixture)}`,
      availability: { ...h.m.availability, sourceRevision: `0x${pilotHash(fixture)}` } };
    const manifestPath = join(dir, 'manifest.json'), fixturePath = join(dir, 'fixture.json'), output = join(dir, 'output');
    await atomicPilotJson(manifestPath, m); await atomicPilotJson(fixturePath, fixture);
    const args = ['--fixture', manifestPath, fixturePath, output];
    expect(await selectiveBackfillMain(args)).toBe(0);
    const before = await readPilotJson<BackfillCheckpoint>(join(output, 'checkpoint.json'));
    expect(await selectiveBackfillMain(args)).toBe(0);
    const after = await readPilotJson<BackfillCheckpoint>(join(output, 'checkpoint.json'));
    expect(after?.calls).toBe(before?.calls); expect(after?.units).toBe(before?.units);
    const report = await readPilotJson<Record<string, unknown>>(join(output, 'report.json'));
    expect(report).toMatchObject({ validation: 'fixture', released: false, actualLiveRequestCalls: 0, actualPaidNanoUsd: '0',
      pricing: { kind: 'fixture_arithmetic_only' } });
    await expect(selectiveBackfillMain(['--acquire', manifestPath, fixturePath, output])).rejects.toThrow('Usage');
    await mkdir(join(output, 'runner.lock'));
    await expect(selectiveBackfillMain(args)).rejects.toThrow();
    await rm(join(output, 'runner.lock'), { recursive: true });
    await atomicPilotJson(fixturePath, { ...fixture, responses: {} });
    await expect(selectiveBackfillMain(args)).rejects.toThrow('source mismatch');
  } finally { log.mockRestore(); await rm(dir, { recursive: true, force: true }); }
});
