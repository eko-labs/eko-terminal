import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { toHex } from 'viem';
import { pilotHash } from '../src/coverage-pilot.js';
import { atomicPilotJson, readPilotJson } from '../src/coverage-pilot-store.js';
import { AcquisitionDefinitionSchema, prepareAcquisition } from '../src/acquisition-run.js';
import { LaunchEnumerationManifestSchema, PONS_LAUNCH_TOPIC, launchPopulationInput, populationFromEnumeration } from '../src/launch-enumeration.js';
import { enumerationBudget, formatEnumerationPlan, launchEnumerationMain, launchEnumerationPlan, measuredEnumerationManifest,
  parseEnumerationOptions, pinEnumerationWatermark, type PinLedger } from '../src/launch-enumeration-cli.js';
import { measuredBackfillRpc } from '../src/selective-backfill-source.js';
import type { BackfillCheckpoint } from '../src/selective-backfill.js';
import { acquisitionFixture } from './acquisition-run-fixtures.js';
import { D, DAY, FACTORY, addr, cursorAt, dispatched, enumerate, enumerationManifest, hash, hourlyTimestamps,
  measuredBudget, measuredRun, registry, syntheticChain } from './backfill-chain-fixtures.js';

const definitionPath = new URL('../../../docs/tasks/058-acquisition-definition.json', import.meta.url);
const definition058 = async () => AcquisitionDefinitionSchema.parse(JSON.parse(await readFile(definitionPath, 'utf8')));
const headerCalls = (chain: ReturnType<typeof syntheticChain>) => chain.calls.filter(c => c.method === 'eth_getBlockByNumber').length;
const logCalls = (chain: ReturnType<typeof syntheticChain>) => chain.calls.filter(c => c.method === 'eth_getLogs');
/** Launches every two hours across the first enumerated day of an hourly chain (block 24 is D). */
const dayLaunches = () => Array.from({ length: 12 }, (_, i) => ({ block: 24 + 2 * i, token: addr(0x300 + i) }));

describe('day boundaries by timestamp search', () => {
  it('finds the exact first and last block of the UTC day under irregular block rates, without extrapolation', async () => {
    const ts: number[] = [];
    for (let n = 0; n < 100; n++) ts.push(D - 50000 + n * 400); // one block per 400 s
    for (let n = 0; n < 5; n++) ts.push(D - 1); // repeated timestamps just before midnight
    for (let n = 0; n < 3; n++) ts.push(D); // repeated timestamps exactly at midnight
    while (ts.at(-1)! < D + DAY - 7) ts.push(ts.at(-1)! + 7); // one block per 7 s
    ts.push(D + DAY + 5000); // a gap across the day end: no block exactly at it
    for (let n = 0; n < 50; n++) ts.push(ts.at(-1)! + 2);
    const first = ts.findIndex(t => t >= D), next = ts.findIndex(t => t >= D + DAY);
    const chain = syntheticChain(ts, [first - 1, first, first + 5000, next - 1, next].map((block, i) => ({ block, token: addr(0x100 + i) })));
    const { result, checkpoint } = await enumerate(chain, enumerationManifest(chain, D, D + DAY));
    expect(result).toMatchObject({ status: 'complete', enumerationComplete: true });
    expect(result.range).toEqual({ before: cursorAt(chain, first - 1), first: cursorAt(chain, first),
      last: cursorAt(chain, next - 1), after: cursorAt(chain, next) });
    expect([first - 1, first, next - 1, next].map(n => ts[n] >= D && ts[n] < D + DAY)).toEqual([false, true, true, false]);
    expect(result.launches.map(l => l.coin)).toEqual([addr(0x101), addr(0x102), addr(0x103)]);
    expect(result.launches[0]).toMatchObject({ launchSec: String(D), deployer: addr(0xd001), curve: addr(0xc001), launchpad: 'pons' });
    // Sparse bisection only: the watermark check plus at most two log2(height) searches; one log page for the day.
    expect(headerCalls(chain)).toBeLessThanOrEqual(1 + 2 * Math.ceil(Math.log2(chain.head + 1)));
    expect(logCalls(chain).map(c => c.params)).toEqual([[{ fromBlock: toHex(first), toBlock: toHex(next - 1), address: [FACTORY], topics: [PONS_LAUNCH_TOPIC] }]]);
    expect(checkpoint.calls).toBe(chain.calls.length);
  });
  it('reports an empty day exactly, puts a block at midnight in the next day, and refuses a window past the cut', async () => {
    const chain = syntheticChain([D - 100, D - 50, D + DAY, D + DAY, D + DAY + 1, D + DAY + 9], [{ block: 2, token: addr(0x1) }]);
    const { result } = await enumerate(chain, enumerationManifest(chain, D, D + DAY));
    expect(result).toMatchObject({ status: 'complete', enumerationComplete: true, launches: [], ranges: [] });
    expect(result.range).toEqual({ before: cursorAt(chain, 1), first: null, last: null, after: cursorAt(chain, 2) });
    expect(logCalls(chain)).toHaveLength(0);
    expect(() => enumerationManifest(chain, D + DAY, D + 2 * DAY)).toThrow('Future');
    expect(() => enumerationManifest(chain, D + 1, D + DAY)).toThrow('Whole UTC days');
  });
});

describe('measured enumeration acquisition', () => {
  it('splits ranges the provider calls too large and oversized results, caching dense answers for resume', async () => {
    const chain = syntheticChain(hourlyTimestamps(), dayLaunches());
    chain.setFault(r => {
      const f = (r.params as [{ fromBlock: string; toBlock: string }])[0];
      if (r.method === 'eth_getLogs' && Number(BigInt(f.toBlock) - BigInt(f.fromBlock)) + 1 > 12) throw new Error('query returned more than 10000 results');
      return undefined;
    });
    const m = enumerationManifest(chain, D, D + DAY), run = measuredRun(chain, m.budget, { maxLogsPerResponse: 2 });
    const { result, checkpoint } = await enumerate(chain, m, run);
    expect(result).toMatchObject({ status: 'complete', enumerationComplete: true, gaps: [] });
    expect(result.launches.map(l => l.coin)).toEqual(dayLaunches().map(l => l.token));
    // 24 blocks: provider limit 24 -> 12 + 12, oversized 6-block pages (3 launches) -> 3 + 3.
    expect(result.ranges.map(r => [r.from, r.through])).toEqual([[24, 26], [27, 29], [30, 32], [33, 35], [36, 38], [39, 41], [42, 44], [45, 47]]
      .map(([a, b]) => [String(a), String(b)]));
    expect(result.ranges.every(r => r.eventCount <= 2)).toBe(true);
    expect([...run.artifacts.values()].filter(a => a.kind === 'dense')).toHaveLength(7); // 1 + 2 + 4 halvings
    expect(checkpoint.calls).toBe(chain.calls.length); expect(new Set(dispatched(chain)).size).toBe(chain.calls.length);
    const before = chain.calls.length, again = await enumerate(chain, m, run);
    expect(again.result.launches).toEqual(result.launches); expect(chain.calls).toHaveLength(before);
  });
  it('maps provider failures to named missing ranges, never to a dense split or a silent gap', async () => {
    const chain = syntheticChain(hourlyTimestamps(), dayLaunches());
    chain.setFault(r => {
      const f = (r.params as [{ fromBlock: string; toBlock: string }])[0];
      if (r.method !== 'eth_getLogs') return undefined;
      if (BigInt(f.toBlock) - BigInt(f.fromBlock) + 1n > 12n) throw new Error('response size exceeded');
      if (BigInt(f.fromBlock) >= 36n) throw Object.assign(new Error('429 Too Many Requests'), { status: 429 });
      return undefined;
    });
    const m = enumerationManifest(chain, D, D + DAY), { result } = await enumerate(chain, m);
    expect(result).toMatchObject({ status: 'stopped', reason: 'coverage_gaps', enumerationComplete: false });
    expect(result.gaps).toEqual([{ scope: 'launches:pons', reason: 'range_unavailable', from: '36', through: '47' }]);
    expect(launchPopulationInput(m, result).enumerationComplete).toBe(false);
    expect(logCalls(chain)).toHaveLength(3); // the rate-limited half was not split further
    const headers = syntheticChain(hourlyTimestamps(), dayLaunches());
    headers.setFault((r, n) => { if (r.method === 'eth_getBlockByNumber' && n === 3) throw new Error('internal error'); return undefined; });
    expect((await enumerate(headers, enumerationManifest(headers, D, D + DAY))).result).toMatchObject({ status: 'stopped', reason: 'header_unavailable' });
  });
  it('stops at the cap before dispatch, meters a transient retry, and never dispatches a retry past the cap', async () => {
    const capped = syntheticChain(hourlyTimestamps(), dayLaunches());
    const stop = await enumerate(capped, enumerationManifest(capped, D, D + DAY, { budget: measuredBudget(5) }));
    expect(stop.result).toMatchObject({ status: 'stopped', reason: 'cap_reached', requestCalls: 5, rpcNanoUsd: '30000' });
    expect(capped.calls).toHaveLength(5);
    const transient = (chain: ReturnType<typeof syntheticChain>) => chain.setFault((r, n) => {
      if (r.method === 'eth_getLogs' && n === 1) throw Object.assign(new Error('HTTP request failed. Status: 503'), { status: 503 });
      return undefined;
    });
    const retried = syntheticChain(hourlyTimestamps(), dayLaunches()); transient(retried);
    const m = enumerationManifest(retried, D, D + DAY), run = measuredRun(retried, m.budget, { transientRetrySec: 30 });
    const ok = await enumerate(retried, m, run);
    expect(ok.result.status).toBe('complete');
    expect(ok.checkpoint.requests.find(r => r.request.kind === 'logs')?.extra).toEqual(['logs']);
    expect(logCalls(retried)).toHaveLength(2); expect(ok.checkpoint.calls).toBe(retried.calls.length);
    // A cap that covers the first logs attempt but not its retry: the retry is refused before dispatch.
    const limit = retried.calls.findIndex(c => c.method === 'eth_getLogs') + 1;
    const tight = syntheticChain(hourlyTimestamps(), dayLaunches()); transient(tight);
    const tm = enumerationManifest(tight, D, D + DAY, { budget: measuredBudget(limit) });
    const refused = await enumerate(tight, tm, measuredRun(tight, tm.budget, { transientRetrySec: 30 }));
    expect(refused.result).toMatchObject({ status: 'stopped', reason: 'cap_reached', requestCalls: limit });
    expect(tight.calls).toHaveLength(limit); expect(refused.checkpoint.requests.at(-1)?.artifactHash).toBeNull();
  });
  it('resumes after a shutdown without dispatching any request twice, releasing an unsent reservation', async () => {
    const chain = syntheticChain(hourlyTimestamps(), dayLaunches());
    const m = enumerationManifest(chain, D, D + DAY), run = measuredRun(chain, m.budget, { maxLogsPerResponse: 2 });
    // The stop arrives while the eighth reservation is saved: reserved, but nothing admitted or sent.
    const stopAtEighth = (c: BackfillCheckpoint) => c.requests.length === 8 && c.requests[7].artifactHash === null;
    const first = await enumerate(chain, m, run, stopAtEighth);
    expect(first.result).toMatchObject({ status: 'stopped', reason: 'shutdown_requested' });
    expect(first.checkpoint.requests).toHaveLength(7); expect(first.checkpoint.calls).toBe(7); expect(chain.calls).toHaveLength(7);
    const second = await enumerate(chain, m, run);
    expect(second.result).toMatchObject({ status: 'complete', enumerationComplete: true });
    expect(second.result.launches).toHaveLength(12);
    expect(new Set(dispatched(chain)).size).toBe(chain.calls.length); expect(second.checkpoint.calls).toBe(chain.calls.length);
  });
  it('resolves zero log timestamps from metered headers and stops on a removed log', async () => {
    const chain = syntheticChain(hourlyTimestamps(), dayLaunches(), { zeroTimestamps: true });
    const { result, checkpoint } = await enumerate(chain, enumerationManifest(chain, D, D + DAY));
    expect(result.status).toBe('complete');
    expect(result.launches.map(l => l.launchSec)).toEqual(dayLaunches().map(l => String(chain.timestamps[l.block])));
    const lookups = checkpoint.requests.find(r => r.request.kind === 'logs')?.extra ?? [];
    expect(lookups.length).toBeGreaterThan(0); expect(lookups.every(k => k === 'header')).toBe(true);
    expect(checkpoint.calls).toBe(chain.calls.length);
    const reorg = syntheticChain(hourlyTimestamps(), dayLaunches());
    reorg.setFault(r => r.method === 'eth_getLogs' ? reorg.logs.map(l => ({ ...l, removed: true })) : undefined);
    expect((await enumerate(reorg, enumerationManifest(reorg, D, D + DAY))).result).toMatchObject({ status: 'stopped', reason: 'source_reorg' });
  });
  it('names an undecodable factory launch log as a missing range instead of shrinking the denominator', async () => {
    const chain = syntheticChain(hourlyTimestamps(), dayLaunches(), { extraLogs: [{ block: 30, address: FACTORY,
      topics: [PONS_LAUNCH_TOPIC, hash(1), hash(2), hash(3)] }] });
    const { result } = await enumerate(chain, enumerationManifest(chain, D, D + DAY));
    expect(result).toMatchObject({ status: 'stopped', enumerationComplete: false });
    expect(result.gaps[0]).toMatchObject({ reason: 'range_unavailable', from: '24', through: '47' });
  });
});

describe('population input for the 058 preparation', () => {
  it('turns a complete 14-day enumeration into the frozen population once eligibility and groups are pinned', async () => {
    const launches = [{ block: 23, token: addr(0x200) }, ...Array.from({ length: 6 }, (_, i) => ({ block: 24 + 50 * i, token: addr(0x201 + i) })),
      { block: 24 + 14 * 24, token: addr(0x2ff) }];
    const chain = syntheticChain(hourlyTimestamps(), launches);
    const m = enumerationManifest(chain, D, D + 14 * DAY, { validation: 'fixture' }), { result } = await enumerate(chain, m);
    const input = launchPopulationInput(m, result);
    expect(input).toMatchObject({ enumerationComplete: true, eligibility: 'pending_pinned_evidence', groups: 'pending_pinned_components', labelsInspected: false });
    expect(input.members.map(x => x.coin)).toEqual(launches.slice(1, 7).map(l => l.token));
    const evidence = input.members.map((x, i) => ({ coin: x.coin, unresolved: false,
      eligibility: { operator_sale: false, restriction: false, non_operator: false, legacy: false, evidenceIds: [] },
      components: [{ id: hash(0x7000 + i), status: 'accepted' as const, evidenceIds: [hash(0x7100 + i)] }] }));
    const pending = acquisitionFixture();
    const definition = AcquisitionDefinitionSchema.parse({ ...pending, startSec: String(D), population: null,
      sources: pending.sources.map(s => s.role === 'launches' ? { ...s, status: 'awaiting_observation', availability: null } : s) });
    const { launchSource, population } = populationFromEnumeration(definition, input, evidence);
    const frozen = AcquisitionDefinitionSchema.parse({ ...definition, population,
      sources: definition.sources.map(s => s.role === 'launches' ? launchSource : s) });
    expect(prepareAcquisition(frozen)).toMatchObject({ status: 'cohort_frozen', sample: { populationSize: 6, sampleSize: 6 } });
    expect(() => populationFromEnumeration(definition, input, evidence.slice(1))).toThrow('every enumerated launch');
    const day = enumerationManifest(chain, D, D + DAY, { validation: 'fixture' });
    expect(() => populationFromEnumeration(definition, launchPopulationInput(day, { ...result, window: { fromSec: day.fromSec, untilSec: day.untilSec } }),
      evidence)).toThrow('launch frame');
  });
});

describe('dry-run plan, finality pin and drivers', () => {
  it('plans the Oct 4 enumeration offline with the exact command and a sub-cent estimate', async () => {
    const definition = await definition058();
    const o = parseEnumerationOptions(['--from', '2026-10-04', '--definition', '../../docs/tasks/058-acquisition-definition.json']);
    const plan = await launchEnumerationPlan(o, definition, registry, D + DAY + 7200);
    expect(plan).toMatchObject({ dryRun: true, networkCalls: 0, window: { fromSec: String(D), untilSec: String(D + DAY), days: 1 } });
    expect(plan.command).toBe('pnpm --filter @eko/engines exec node --import tsx src/launch-enumeration-cli.ts --measured --from 2026-10-04 ' +
      '--days 1 --definition ../../docs/tasks/058-acquisition-definition.json --output ../../.data/eko-058/launches-2026-10-04 ' +
      '--max-units 1000 --finality finalized --max-minutes 20');
    expect(plan.requests.expectedTotal).toBe(plan.requests.finalityPin + plan.requests.watermarkCheck +
      plan.requests.timestampSearchHeaders + plan.requests.factoryLogPages);
    expect(plan.requests.timestampSearchHeaders).toBeLessThanOrEqual(plan.requests.searchHeaderBound);
    expect(plan.requests.expectedTotal).toBeLessThan(100);
    expect(BigInt(plan.cost.expectedNanoUsd)).toBe(BigInt(plan.requests.expectedTotal) * 6000n);
    expect(BigInt(plan.cost.capNanoUsd)).toBeLessThan(10_000_000n); // the hard cap itself is under one cent
    expect(plan.outputs).toContain('../../.data/eko-058/launches-2026-10-04/population-input.json');
    expect(formatEnumerationPlan(plan)).toContain('no network calls made');
    expect(() => parseEnumerationOptions(['--from', '2026-02-30', '--definition', 'x.json'])).toThrow('Invalid');
    await expect(launchEnumerationPlan(parseEnumerationOptions(['--from', '2026-08-01', '--definition', 'x.json']), definition, registry, D))
      .rejects.toThrow('outside');
    expect(() => enumerationBudget(definition, 250000, { units: 0, costNanoUsd: '0' })).not.toThrow();
    expect(() => enumerationBudget({ ...definition, budget: { ...definition.budget, capNanoUsd: '6000' } }, 1000, { units: 0, costNanoUsd: '0' })).toThrow('approved');
  });
  it('charges and persists the finality pin before dispatch and builds a manifest only for a final window', async () => {
    const chain = syntheticChain(hourlyTimestamps(), []), definition = await definition058();
    const { store, rpc } = measuredBackfillRpc({ RPC_HTTP_URL: 'http://fixture.invalid' }, measuredBudget(),
      { onSessionBudget: () => {}, log: () => {}, send: chain.send, sleep: async () => {} });
    const pin: PinLedger = { version: 'launch-enumeration-pin-058.1', calls: 0, units: 0, costNanoUsd: '0', pins: [] };
    const sentAtSave: number[] = [], save = async () => { sentAtSave.push(chain.calls.length); };
    const limits = { finality: 'finalized' as const, maxUnits: 1, unitNanoUsd: '6000', headerWeight: 1 };
    const watermark = await pinEnumerationWatermark(rpc, store, pin, limits, save, () => '2026-10-19T00:00:00.000Z');
    expect(watermark).toEqual(cursorAt(chain, chain.head)); expect(sentAtSave[0]).toBe(0);
    expect(chain.calls[0].params).toEqual(['finalized', false]); expect(pin).toMatchObject({ calls: 1, units: 1, costNanoUsd: '6000' });
    await expect(pinEnumerationWatermark(rpc, store, pin, limits, save, () => '2026-10-19T00:00:00.000Z')).rejects.toThrow('cap_reached');
    expect(chain.calls).toHaveLength(1);
    const m = measuredEnumerationManifest({ fromSec: String(D), untilSec: String(D + DAY), watermark: watermark!, finality: 'finalized',
      sourceId: 'planned-launches-source', acquiredAt: '2026-10-19T00:00:00.000Z', factory: FACTORY, budget: enumerationBudget(definition, 1000, pin) });
    expect(m.budget).toMatchObject({ checkpointUnits: 999, fixedNanoUsd: '6000', capNanoUsd: '6000000', approvalRef: 'owner-approval-2026-10-04' });
    expect(m.availability.sourceId).toBe('planned-launches-source');
    expect(() => measuredEnumerationManifest({ fromSec: String(D + 15 * DAY), untilSec: String(D + 16 * DAY), watermark: watermark!,
      finality: 'finalized', sourceId: 'planned-launches-source', acquiredAt: '2026-10-19T00:00:00.000Z', factory: FACTORY,
      budget: enumerationBudget(definition, 1000, pin) })).toThrow('Future');
    expect(() => LaunchEnumerationManifestSchema.parse({ ...m, launchpads: [{ ...m.launchpads[0], topic: hash(5) }] })).toThrow('topic');
  });
  it('runs the offline enumeration driver with durable resume, launch list, population input and report', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eko-058-enum-test-')), log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const chain = syntheticChain(hourlyTimestamps(), dayLaunches()), measured = enumerationManifest(chain, D, D + DAY);
      const { run } = await enumerate(chain, measured);
      const fixture = { version: 'selective-backfill-fixture-048.1', responses: Object.fromEntries(run.artifacts) }, revision = `0x${pilotHash(fixture)}`;
      const m = { ...measured, validation: 'fixture', sourceRevision: revision, availability: { ...measured.availability, sourceRevision: revision } };
      const manifestPath = join(dir, 'manifest.json'), fixturePath = join(dir, 'fixture.json'), output = join(dir, 'output');
      await atomicPilotJson(manifestPath, m); await atomicPilotJson(fixturePath, fixture);
      const args = ['--fixture', manifestPath, fixturePath, output];
      expect(await launchEnumerationMain(args)).toBe(0);
      const list = await readPilotJson<{ count: number; launches: { coin: string }[] }>(join(output, 'launches.json'));
      expect(list?.count).toBe(12); expect(list?.launches.map(l => l.coin)).toEqual(dayLaunches().map(l => l.token));
      const input = await readPilotJson<{ members: unknown[]; enumerationComplete: boolean }>(join(output, 'population-input.json'));
      expect(input).toMatchObject({ enumerationComplete: true }); expect(input?.members).toHaveLength(12);
      expect(await readPilotJson(join(output, 'report.json'))).toMatchObject({ status: 'complete', launchCount: 12,
        actualLiveRequestCalls: 0, actualPaidNanoUsd: '0', pricing: { kind: 'fixture_arithmetic_only' } });
      const before = await readPilotJson<BackfillCheckpoint>(join(output, 'checkpoint.json'));
      expect(await launchEnumerationMain(args)).toBe(0);
      expect((await readPilotJson<BackfillCheckpoint>(join(output, 'checkpoint.json')))?.calls).toBe(before?.calls);
      await expect(launchEnumerationMain(['--acquire', manifestPath, fixturePath, output])).rejects.toThrow('Usage');
      vi.stubEnv('RPC_HTTP_URL', '');
      await expect(launchEnumerationMain(['--measured', '--from', '2026-10-04', '--definition', fileURLToPath(definitionPath),
        '--output', join(dir, 'measured')])).rejects.toThrow('RPC_HTTP_URL');
    } finally { vi.unstubAllEnvs(); log.mockRestore(); await rm(dir, { recursive: true, force: true }); }
  });
});
