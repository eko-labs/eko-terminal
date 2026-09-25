import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AcquisitionDefinitionSchema, prepareAcquisition } from '../src/acquisition-run.js';
import { acquisitionRunMain } from '../src/acquisition-run-cli.js';
import { atomicPilotJson, readPilotJson } from '../src/coverage-pilot-store.js';
import { initialBackfillCheckpoint, runSelectiveBackfill, type BackfillIO } from '../src/selective-backfill.js';
import { acquisitionFixture, acquisitionPilotFixture, ACQUISITION_D as D, ACQUISITION_DAY as DAY } from './acquisition-run-fixtures.js';

describe('frozen calendar, grouping and primary truth definition', () => {
  it('freezes exact 4/3/7 dates, both 3900-second purges, context and sensitivity-only history', () => {
    const p = prepareAcquisition(acquisitionFixture());
    expect(p.frame.launches).toEqual({ fromSec: String(D), untilSec: String(D + 14 * DAY) });
    expect(p.frame.observations.untilSec).toBe(String(D + 21 * DAY));
    expect(p.fitting.untilSec).toBe(String(D + 4 * DAY - 3900));
    expect(p.validation.untilSec).toBe(String(D + 7 * DAY - 3900));
    expect(p.frame.metadata.fromSec).toBe(String(D - 30 * DAY));
    expect(p.frame.funding.fromSec).toBe(String(D - DAY));
    expect(p.frame.recycling.fromSec).toBe(String(D - 7 * DAY));
    expect(p.remainingPrimaryPopulation).toEqual({ fitting: 3, validation: 3, locked_test: 3 });
    expect(p.remainingPrimarySample).toEqual(p.remainingPrimaryPopulation);
    expect(p.assignments!.filter(r => r.disposition === 'primary_purge').map(r => r.launchSec)).toEqual([
      String(D + 4 * DAY - 3900), String(D + 4 * DAY - 1), String(D + 7 * DAY - 3900)]);
    expect(p.primaryTruth).toMatchObject({ entryDelaySec: 60, exitHoldSec: 3600,
      sevenDaySensitivityOnly: true, boosterEnabled: false });
    expect(p).toMatchObject({ status: 'cohort_frozen', mode: 'shadow', released: false });
    expect(prepareAcquisition(acquisitionFixture())).toEqual(p);
  });
  it('holds out transitive accepted/suspected crossings and conservatively combines unresolved tokens', () => {
    const m = acquisitionFixture(), rows = m.population!.groups;
    rows[5].components = [...rows[0].components, ...rows[9].components.map(c => ({ ...c, status: 'suspected' as const }))];
    rows[1].unresolved = true; rows[10].unresolved = true;
    const p = prepareAcquisition(m), byCoin = new Map(p.assignments!.map(r => [r.coin, r]));
    for (const i of [0, 5, 9]) expect(byCoin.get(rows[i].coin)?.groupSplit).toBe('locked_test');
    expect(byCoin.get(rows[0].coin)?.groupId).toBe(byCoin.get(rows[9].coin)?.groupId);
    for (const i of [0, 1, 5]) expect(byCoin.get(rows[i].coin)?.disposition).toBe('group_held_out');
    expect(p.remainingPrimaryPopulation).toEqual({ fitting: 1, validation: 2, locked_test: 3 });
  });
  it('keeps purged members in group isolation and can honestly report an empty fitting set', () => {
    const m = acquisitionFixture();
    const c = m.population!.groups[0].components;
    m.population!.groups.forEach(g => { g.components = c; });
    const p = prepareAcquisition(m);
    expect(p.remainingPrimaryPopulation).toEqual({ fitting: 0, validation: 0, locked_test: 3 });
    expect(p.assignments![3].disposition).toBe('primary_purge');
  });
  it('prepares a prospective definition without fabricating a complete population or group/draw', () => {
    const m = acquisitionFixture(); m.population = null;
    m.sources.forEach(s => { s.status = 'awaiting_observation'; s.availability = null; });
    expect(prepareAcquisition(m)).toMatchObject({ status: 'definition_frozen_population_pending',
      sample: null, assignments: null, remainingPrimaryPopulation: null });
  });
  it('rejects labels, non-midnight D, wrong chain, altered query/source/seed/frame and absent group rows', () => {
    const m = acquisitionFixture();
    expect(() => AcquisitionDefinitionSchema.parse({ ...m, labelsInspected: true })).toThrow();
    expect(() => AcquisitionDefinitionSchema.parse({ ...m, labels: [] })).toThrow();
    expect(() => AcquisitionDefinitionSchema.parse({ ...m, startSec: String(D + 1) })).toThrow();
    expect(() => AcquisitionDefinitionSchema.parse({ ...m, chainId: 1 })).toThrow();
    for (const change of [
      (v: typeof m) => { v.population!.groups.pop(); },
      (v: typeof m) => { v.population!.groups[0] = v.population!.groups[1]; },
      (v: typeof m) => { v.population!.frame.fromSec = String(D + 1); },
      (v: typeof m) => { v.sampling.seed = v.population!.frame.sourceRevision; },
      (v: typeof m) => { v.sampling.query.artifact = {}; },
      (v: typeof m) => { v.sources[0].availability!.cut.acquisitionSequence = '999'; },
      (v: typeof m) => { v.sources[0].availability!.watermark.timestampSec = String(D + DAY); },
      (v: typeof m) => { v.sources[0].availability!.watermark.timestampSec = String(D + 22 * DAY); },
      (v: typeof m) => { v.population!.groups[0].components = []; },
    ]) { const changed = structuredClone(m); change(changed); expect(() => prepareAcquisition(changed)).toThrow(); }
  });
});

describe('bounded runner preparation', () => {
  it('binds pilot to the draw, creation, source, fixed-cost cap and predeclared budget', () => {
    const m = acquisitionPilotFixture(); expect(prepareAcquisition(m).definition.backfill?.mode).toBe('pilot7');
    const variants = [
      { ...m, budget: { ...m.budget, fixedNanoUsd: '10000000001' } },
      { ...m, budget: { ...m.budget, capNanoUsd: '1' } },
      { ...m, population: null },
      { ...m, backfill: { ...m.backfill!, mode: 'cohort14plus7' } },
      { ...m, backfill: { ...m.backfill!, selected: [{ ...m.backfill!.selected[0], reason: 'incident' }] } },
    ];
    for (const v of variants) expect(() => AcquisitionDefinitionSchema.parse(v)).toThrow();
    const shifted = structuredClone(m); shifted.backfill!.selected[0].launch.creation.timestampSec = String(D + DAY);
    expect(() => prepareAcquisition(shifted)).toThrow();
  });
  it('does not treat a short pilot as full draw/follow-up even with an expansion evidence reference', () => {
    const m = acquisitionPilotFixture(); m.backfill!.mode = 'cohort14plus7';
    m.pilotAcceptanceEvidence = m.population!.frame.sourceRevision;
    expect(() => prepareAcquisition(m)).toThrow('Full draw');
  });
  it('prepares expansion only with the complete sample and each token followed for seven days', () => {
    const m = acquisitionPilotFixture(), b = m.backfill!;
    b.mode = 'cohort14plus7'; m.pilotAcceptanceEvidence = m.population!.frame.sourceRevision;
    b.selected = m.population!.frame.members.map((member, i) => ({ ...b.selected[0],
      launch: { coin: member.coin, creation: { ...member.knownAt.cursor, blockNumber: String(40 + i) },
        knownAt: m.population!.frame.availabilityCut },
      filters: [{ ...b.selected[0].filters[0], addresses: [member.coin] }],
      untilSec: String(BigInt(member.launchSec) + 7n * BigInt(DAY)) }));
    expect(prepareAcquisition(m).sample?.sampleSize).toBe(12);
    b.selected[11].untilSec = String(BigInt(b.selected[11].untilSec) - 1n);
    expect(() => prepareAcquisition(m)).toThrow('seven-day follow-up');
  });
  it('passes the explicit zero cap to the existing runner: no fixture transport dispatch even on resume', async () => {
    const m = acquisitionPilotFixture(); m.budget.capNanoUsd = '0'; m.backfill!.budget.capNanoUsd = '0';
    const prepared = prepareAcquisition(m), b = prepared.definition.backfill!;
    const candidate = 'a'.repeat(64), checkpoint = initialBackfillCheckpoint(b, candidate, 'fixture-runner');
    const request = vi.fn<BackfillIO['request']>();
    const io: BackfillIO = { request, artifact: async () => null, putArtifact: async () => {},
      save: async () => {}, sourceRevision: async () => b.sourceRevision, stopped: () => false, now: () => 0, rss: () => 0 };
    for (let i = 0; i < 2; i++) expect(await runSelectiveBackfill(b, checkpoint, io, candidate, 'fixture-runner'))
      .toMatchObject({ status: 'stopped', reason: 'cap_reached', requestUnits: 0 });
    expect(request).not.toHaveBeenCalled();
  });
  it('requires explicit caps and bounded checkpoint units', () => {
    const m = acquisitionFixture();
    for (const budget of [{ ...m.budget, capNanoUsd: undefined }, { ...m.budget, checkpointUnits: 250001 }])
      expect(() => prepareAcquisition({ ...m, budget } as typeof m)).toThrow();
  });
});

describe('durable dry-run CLI', () => {
  it('writes zero-cost starter artifacts, resumes identically, rejects changed definitions and duplicate owners', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eko-058-'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const input = join(dir, 'input.json'), output = join(dir, 'prepared'), m = acquisitionPilotFixture();
      await atomicPilotJson(input, m);
      const args = ['--dry-run', input, output];
      expect(await acquisitionRunMain(args)).toBe(0);
      const original = await readFile(join(output, 'preparation.json'), 'utf8');
      expect(await acquisitionRunMain(args)).toBe(0);
      expect(await readFile(join(output, 'preparation.json'), 'utf8')).toBe(original);
      expect(await readPilotJson(join(output, 'backfill-checkpoint.json'))).toMatchObject({
        status: 'prepared', calls: 0, units: 0, requests: [] });
      expect(await readPilotJson(join(output, 'report.json'))).toMatchObject({ dryRun: true, actualRequestCalls: 0,
        actualRequestUnits: 0, actualPaidNanoUsd: '0', mode: 'shadow', released: false,
        process: { status: 'prepared_no_acquisition_started', pid: null }, coverage: { reconstructedTokens: 0 } });
      await mkdir(join(output, 'runner.lock'));
      await expect(acquisitionRunMain(args)).rejects.toThrow();
      await rm(join(output, 'runner.lock'), { recursive: true });
      const changed = structuredClone(m); changed.budget.capNanoUsd = '10000000001';
      changed.backfill!.budget.capNanoUsd = changed.budget.capNanoUsd;
      await atomicPilotJson(input, changed);
      await expect(acquisitionRunMain(args)).rejects.toThrow('Frozen preparation');
      expect(await readFile(join(output, 'preparation.json'), 'utf8')).toBe(original);
      await expect(acquisitionRunMain(['--acquire', input, output])).rejects.toThrow('Usage');
      await expect(acquisitionRunMain(['--dry-run', input, dir])).rejects.toThrow('Separate');
    } finally { log.mockRestore(); await rm(dir, { recursive: true, force: true }); }
  });
});
