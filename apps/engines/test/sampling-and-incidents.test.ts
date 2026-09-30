import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { referenceDigest } from '@eko/chain';
import { address, hash } from '../../../packages/chain/test/reference-fixtures.js';
import { drawProbabilitySample, ProbabilityFrameSchema, weightedSampleRate } from '../src/probability-sample.js';
import { importMatchedSources, MatchedSourceRecordSchema, prepareIncidentChallenge, IncidentChallengeInputSchema } from '../src/matched-source.js';
import { samplingAndIncidentsMain } from '../src/sampling-and-incidents-cli.js';
import { probabilityFrame, matchedRecords, samplingFixture, unavailableIncident, syntheticIncidentMember } from './sampling-fixtures.js';

it('freezes a disjoint priority frame, all five quotas, seeds, query and exact probabilities', () => {
  const frame = probabilityFrame();
  frame.members[0].eligibility.restriction = true; frame.members[0].eligibility.non_operator = true; frame.members[0].eligibility.legacy = true;
  const sample = drawProbabilitySample(frame);
  expect(sample.strata.map(s => s.N_h)).toEqual([200, 150, 150, 200, 1000]);
  expect(sample.strata.map(s => s.n_h)).toEqual([100, 75, 75, 100, 250]);
  expect(sample.populationSize).toBe(1700); expect(sample.sampleSize).toBe(600);
  expect(sample.strata.map(s => s.inclusionProbability)).toEqual([
    { numerator: '100', denominator: '200' }, { numerator: '75', denominator: '150' },
    { numerator: '75', denominator: '150' }, { numerator: '100', denominator: '200' }, { numerator: '250', denominator: '1000' }]);
  const selected = sample.strata.flatMap(s => s.selected);
  expect(new Set(selected).size).toBe(600); expect(new Set(sample.strata.map(s => s.seed)).size).toBe(5);
  frame.members.reverse(); expect(drawProbabilitySample(frame)).toEqual(sample);
  expect(sample.frame.query.artifactHash).toBe(referenceDigest(sample.frame.query.artifact));
  frame.seed = hash('other-synthetic-seed'); expect(drawProbabilitySample(frame).strata[4].selected).not.toEqual(sample.strata[4].selected);
});

it('redistributes capacity before draws to remainder then priority, and takes a smaller census', () => {
  expect(drawProbabilitySample(probabilityFrame([20, 30, 30, 40, 1000])).strata.map(s => s.n_h)).toEqual([20, 30, 30, 40, 480]);
  expect(drawProbabilitySample(probabilityFrame([400, 300, 200, 100, 0])).strata.map(s => s.n_h)).toEqual([350, 75, 75, 100, 0]);
  expect(drawProbabilitySample(probabilityFrame([150, 400, 100, 100, 0])).strata.map(s => s.n_h)).toEqual([150, 275, 75, 100, 0]);
  const census = drawProbabilitySample(probabilityFrame([3, 4, 5, 6, 7]));
  expect(census.sampleSize).toBe(25); expect(census.strata.every(s => s.n_h === s.N_h)).toBe(true);
  expect(drawProbabilitySample(probabilityFrame([0, 0, 0, 0, 0])).sampleSize).toBe(0);
});

it('rejects duplicates, incomplete enumeration, future/out-of-window members, unpinned queries and verdict-based extensions', () => {
  const frame = probabilityFrame([1, 1, 1, 1, 1]);
  for (const edit of [
    (f: typeof frame) => { f.members.push(f.members[0]); },
    (f: typeof frame) => { f.members[0].launchSec = f.untilSec; },
    (f: typeof frame) => { f.members[0].knownAt.acquisitionSequence = '101'; f.members[0].knownAt.cursor = f.availabilityCut.cursor; },
    (f: typeof frame) => { f.query.artifactHash = hash('wrong'); },
    (f: typeof frame) => { f.members[0].eligibility.evidenceIds = []; },
  ]) { const f = structuredClone(frame); edit(f); expect(() => drawProbabilitySample(f)).toThrow(); }
  expect(ProbabilityFrameSchema.safeParse({ ...frame, enumerationComplete: false }).success).toBe(false);
  expect(ProbabilityFrameSchema.safeParse({ ...frame, currentVerdict: 'high' }).success).toBe(false);
});

it('uses inclusion weights to recover a synthetic population rate and excludes challenges/missing outcomes/top-ups', () => {
  const sample = drawProbabilitySample(probabilityFrame());
  const rows = sample.strata.flatMap(s => s.selected.map(coin => ({ coin, value: s.id !== 'remainder', origin: 'probability' as const })));
  expect(rows.filter(x => x.value).length / rows.length).toBeCloseTo(350 / 600);
  expect(weightedSampleRate(sample, rows)).toEqual({ numerator: '7', denominator: '17' });
  expect(() => weightedSampleRate(sample, [...rows, { coin: address(9000), value: true, origin: 'challenge' }])).toThrow();
  expect(() => weightedSampleRate(sample, rows.map((r, i) => i === 0 ? { ...r, value: null } : r))).toThrow();
  expect(() => weightedSampleRate(sample, [...rows.slice(1), rows[1]])).toThrow();
  const changed = structuredClone(sample); changed.strata[0].n_h++;
  expect(() => weightedSampleRate(changed, rows)).toThrow('Altered');
});

it('draws without replacement across seed fixtures and represents each within-stratum member', () => {
  const frame = probabilityFrame([110, 0, 0, 0, 600]), counts = new Map<string, number>();
  for (let i = 0; i < 40; i++) {
    frame.seed = hash(`synthetic-draw-${i}`);
    for (const coin of drawProbabilitySample(frame).strata[0].selected) counts.set(coin, (counts.get(coin) ?? 0) + 1);
  }
  expect(counts.size).toBe(110); expect([...counts.values()].every(n => n >= 25 && n <= 40)).toBe(true);
});

it('imports 100 exact matched fixture captures with finite questions, raw receipts, denominators and timing', () => {
  const result = importMatchedSources(matchedRecords());
  expect(result.records).toHaveLength(100); expect(result.measuredRecords).toBe(0);
  expect(result.coverage.every(c => c.available === 100 && c.criticalOmissions === 0 && c.totalQuestions === 900)).toBe(true);
  expect(result.supportedParity).toEqual([{ origin: 'fixture', source: 'codex', supportedFields: 900, comparatorUnanswerable: 0, ekoUnanswerable: 0, criticalOmissions: 0 }]);
  expect(result).toMatchObject({ parityGatePassed: false, humanReviewComplete: false, released: false });
  expect(importMatchedSources(matchedRecords().reverse())).toEqual(result);
  expect(() => importMatchedSources(matchedRecords(99))).toThrow();
  expect(() => importMatchedSources([...matchedRecords(), matchedRecords()[0]])).toThrow('Duplicate');
});

it('rejects approximate time, wrong route/size/stage, generic chain support and unsupported history masquerading as captures', () => {
  const row = matchedRecords(1)[0];
  for (const edit of [
    (r: typeof row) => { r.snapshots[2].observedCursor!.timestampSec = '1001'; },
    (r: typeof row) => { r.snapshots[2].capability.historical = false; },
    (r: typeof row) => { r.snapshots[2].capability.chainId = 1; },
    (r: typeof row) => { r.snapshots[2].capability.untilSec = '1000'; },
    (r: typeof row) => { r.context.routeId = 'other-route'; },
    (r: typeof row) => { r.context.sizeUsd = 1000; },
    (r: typeof row) => { r.context.stage = 'graduated'; },
    (r: typeof row) => { r.snapshots[2].capability.evidenceIds = []; },
  ]) { const r = structuredClone(row); edit(r); expect(MatchedSourceRecordSchema.safeParse(r).success).toBe(false); }
});

it('preserves unknown USD/API status without zero-valued facts or invented historic capability', () => {
  const rows = matchedRecords(), comparator = rows[0].snapshots[2];
  comparator.observedCursor = null; comparator.status = 'unsupported'; comparator.quoteUsd = null; comparator.priceEvidenceIds = [];
  comparator.responseTimeMs = null; comparator.capability = { ...comparator.capability, status: 'unsupported', historical: false,
    reason: 'historic_endpoint_unsupported', fromSec: null, untilSec: null, evidenceIds: [] };
  for (const a of comparator.answers) { a.status = 'unsupported'; a.reason = 'historic_endpoint_unsupported'; a.value = null; }
  rows[1].snapshots[0].quoteUsd = null; rows[1].snapshots[0].priceEvidenceIds = [];
  const result = importMatchedSources(rows), c = result.coverage.find(c => c.source === 'codex')!;
  expect(c.unsupported).toBe(1); expect(c.unanswerable).toBe(9); expect(c.unknownPrice).toBe(1);
  expect(result.supportedParity[0].supportedFields).toBe(891);
  comparator.answers[0].value = '0'; expect(() => importMatchedSources(rows)).toThrow();
  const badPrice = matchedRecords(1)[0]; badPrice.snapshots[0].quoteUsd = { numerator: '0', denominator: '1' };
  expect(MatchedSourceRecordSchema.safeParse(badPrice).success).toBe(false);
});

it('retains vendor gross/held and supply conventions and reports critical role/denominator omissions', () => {
  const rows = matchedRecords(), a = rows[0].snapshots[2].answers[0];
  a.basis = 'initial_gross'; a.roles = 'unknown'; a.denominator = { convention: 'unknown', raw: null };
  const result = importMatchedSources(rows);
  expect(result.records.find(r => r.context.coin === rows[0].context.coin)!.snapshots[2].answers[0].basis).toBe('initial_gross');
  expect(result.coverage.find(c => c.source === 'codex')!.criticalOmissions).toBe(1);
  expect(result.supportedParity[0].criticalOmissions).toBe(1);
  a.status = 'unknown'; a.reason = 'denominator_unknown'; a.value = null;
  expect(importMatchedSources(rows).supportedParity[0].comparatorUnanswerable).toBe(1);
});

it('separates fixture and measured parity denominators without promoting imported evidence', () => {
  const rows = matchedRecords(); rows[0].origin = 'measured';
  const result = importMatchedSources(rows);
  expect(result.measuredRecords).toBe(1);
  expect(result.supportedParity.find(c => c.origin === 'measured')!.supportedFields).toBe(9);
  expect(result.supportedParity.find(c => c.origin === 'fixture')!.supportedFields).toBe(891);
  expect(result.coverage.find(c => c.origin === 'measured' && c.source === 'codex')!.measuredAvailable).toBe(1);
  expect(result.parityGatePassed).toBe(false);
});

it('cannot inject levels, incident allegations or human judgments into finite snapshot answers', () => {
  const row = matchedRecords(1)[0];
  expect(MatchedSourceRecordSchema.safeParse({ ...row, humanLabel: true }).success).toBe(false);
  row.snapshots[0].answers[0] = { ...row.snapshots[0].answers[0], question: 'score' } as never;
  expect(MatchedSourceRecordSchema.safeParse(row).success).toBe(false);
});

it('keeps unavailable 53-launch allegations unreproduced with no invented identities', () => {
  const result = prepareIncidentChallenge(unavailableIncident(), drawProbabilitySample(probabilityFrame()));
  expect(result).toMatchObject({ members: [], manifestComplete: false, reconstructionReady: false, reproduced: false,
    populationRateEligible: false, heldOutChallenge: true, allegation: { reportedExtractedUsd: '18430000', categoryCounts: [45, 4, 4], status: 'unreconciled_allegation' } });
  const input = unavailableIncident(); input.members.push(syntheticIncidentMember(10));
  expect(() => prepareIncidentChallenge(input, drawProbabilitySample(probabilityFrame()))).toThrow();
});

it('deduplicates verified full incident launches/categories and sample overlaps without changing the draw', () => {
  const sample = drawProbabilitySample(probabilityFrame()), input = unavailableIncident();
  input.availability = 'provided'; input.members = Array.from({ length: 53 }, (_, n) => syntheticIncidentMember(10 + n));
  const overlap = input.members.find(m => sample.strata[0].selected.includes(m.coin))!;
  input.members.push({ ...overlap, categories: ['shared_batch', 'shared_collector'] });
  const result = prepareIncidentChallenge(input, sample);
  expect(result.members).toHaveLength(53); expect(result.manifestComplete).toBe(true); expect(result.reconstructionReady).toBe(true);
  expect(result.members.find(m => m.coin === overlap.coin)).toMatchObject({ categories: ['collector_next_funder', 'shared_batch', 'shared_collector'],
    probabilitySampleOverlap: true, populationProbability: null, label: 'unreproduced' });
  expect(drawProbabilitySample(sample.frame)).toEqual(sample);
  input.members[0].archiveComplete = false;
  expect(prepareIncidentChallenge(input, sample).reconstructionReady).toBe(false);
});

it('rejects abbreviated IDs, mismatched launch transactions and conflicting incident evidence', () => {
  const input = unavailableIncident(); input.availability = 'provided'; input.members = [syntheticIncidentMember(10)];
  const sample = drawProbabilitySample(probabilityFrame());
  expect(IncidentChallengeInputSchema.safeParse({ ...input, members: [{ ...input.members[0], coin: '0x0a5…6a6c' }] }).success).toBe(false);
  input.members[0].verification.transaction = hash('wrong-launch'); expect(() => prepareIncidentChallenge(input, sample)).toThrow();
  input.members = [syntheticIncidentMember(10), { ...syntheticIncidentMember(10), archiveComplete: false }];
  expect(() => prepareIncidentChallenge(input, sample)).toThrow('Conflicting');
});

it('writes durable reproducible artifacts/checkpoint, resumes identically and refuses altered sources or concurrent ownership', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'eko-sampling-057-'));
  try {
    const input = join(dir, 'fixture.json'), output = join(dir, 'output');
    const fixture = samplingFixture(); await writeFile(input, JSON.stringify(fixture));
    expect(await samplingAndIncidentsMain(['--fixture', input, output])).toBe(0);
    const before = await readFile(join(output, 'artifacts.json'), 'utf8');
    expect(await samplingAndIncidentsMain(['--fixture', input, output])).toBe(0);
    expect(await readFile(join(output, 'artifacts.json'), 'utf8')).toBe(before);
    const report = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'));
    expect(report).toMatchObject({ actualRequests: 0, actualRequestUnits: 0, actualPaidNanoUsd: '0', measuredMatchedRecords: 0,
      sampleSize: 600, matches: 100, incidentMembers: 0, released: false, mode: 'shadow' });
    fixture.frame.seed = hash('changed-source'); await writeFile(input, JSON.stringify(fixture));
    await expect(samplingAndIncidentsMain(['--fixture', input, output])).rejects.toThrow('checkpoint mismatch');
    await mkdir(join(output, 'runner.lock'));
    await expect(samplingAndIncidentsMain(['--fixture', input, output])).rejects.toThrow();
    await rm(join(output, 'runner.lock'), { recursive: true });
    fixture.frame.origin = 'measured'; await writeFile(input, JSON.stringify(fixture));
    await expect(samplingAndIncidentsMain(['--fixture', input, join(dir, 'measured')])).rejects.toThrow('fixtures only');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
