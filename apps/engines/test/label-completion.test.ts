import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { it, expect } from 'vitest';
import { guardStorageHash as hash, reviewCaseId, reviewPins } from '@eko/db';
import { toUntrusted } from '@eko/untrusted';
import { exportLabelAssignments, importLabelDecisions, type SignedDecision } from '../src/label-completion.js';
import { labelCompletionMain } from '../src/label-completion-cli.js';
import { labelAssignmentFixture, independentFixture, adjudicationFixture, resolvedFixtureAnswers,
  signFixture, labelCompletionFixture } from './label-completion-fixtures.js';
import { prepareAcquisition } from '../src/acquisition-run.js';
import { probabilityFrame } from './sampling-fixtures.js';
import { referenceDigest } from '@eko/chain';

it('exports every frozen draw member, exact weights and requirements without defaults or scores', () => {
  const f = labelAssignmentFixture(), plan = exportLabelAssignments(f.input);
  expect(plan).toMatchObject({ sampleSize: 12, populationSize: 12, requirements: { requiredIndependentJudgments: 24, scoresHidden: true } });
  expect(plan.assignments).toHaveLength(12);
  expect(plan.assignments.some(a => a.cohortDisposition.disposition === 'primary_purge')).toBe(true);
  expect(plan.assignments.every(a => a.inclusionProbability.numerator === '12' && a.inclusionWeight.denominator === '12')).toBe(true);
  expect(JSON.stringify(plan)).not.toMatch(/"(?:reveal|points|level|legacyPoints|legacyLevel|allegedIncidentLabels|answers)":/);
  expect(() => exportLabelAssignments({ ...f.input, cases: [{ ...f.input.cases[0], reveal: {} } as never] })).toThrow();
});

it('reports actual missing judgments/cases without shrinking denominators or inventing completion', () => {
  const f = labelAssignmentFixture(); f.input.cases.pop(); f.input.roles.adjudicator = null;
  const result = importLabelDecisions(f.input, []);
  expect(result.counts).toMatchObject({ selectedTokens: 12, missingCases: 1, requiredIndependentJudgments: 24, missingJudgments: 24, submittedIndependentJudgments: 0 });
  expect(result.blockers).toEqual(expect.arrayContaining(['pinned_cases_missing', 'independent_roles_missing', 'independent_judgments_missing']));
  expect(result).toMatchObject({ importComplete: false, measuredHumanValidation: false, mode: 'shadow', released: false });
});

it('keeps an unfrozen population pending with unknown counts, never a zero-work pass', () => {
  const f = labelAssignmentFixture(); f.input.acquisition.population = null; f.input.cases = [];
  const result = importLabelDecisions(f.input, []);
  expect(result.counts).toMatchObject({ selectedTokens: null, requiredIndependentJudgments: null });
  expect(result.blockers).toContain('frozen_population_pending'); expect(result.importComplete).toBe(false);
});

it('retains unequal inclusion probabilities in the original draw and rejects top-ups or altered pins', () => {
  const f = labelAssignmentFixture(), frame = probabilityFrame([200, 0, 0, 0, 1000]);
  const original = f.input.acquisition.population!.frame;
  frame.fromSec = original.fromSec; frame.untilSec = original.untilSec; frame.query = original.query;
  frame.availabilityCut = original.availabilityCut; frame.sourceRevision = original.sourceRevision;
  frame.members.forEach(m => { m.launchSec = original.members[0].launchSec; m.knownAt = original.members[0].knownAt; });
  f.input.acquisition.population = { frame, groups: frame.members.map(m => ({ coin: m.coin,
    components: [{ id: hash(m.coin), status: 'accepted', evidenceIds: [hash('synthetic-group')] }], unresolved: false })) };
  f.input.acquisition.sampling.seed = frame.seed; f.input.cases = [];
  const plan = exportLabelAssignments(f.input);
  expect(plan.assignments).toHaveLength(600); expect(plan.requirements.requiredIndependentJudgments).toBe(1200);
  expect(plan.assignments.filter(a => a.stratum === 'operator_sale')).toHaveLength(100);
  expect(plan.assignments.find(a => a.stratum === 'operator_sale')!.inclusionWeight).toEqual({ numerator: '200', denominator: '100' });
  expect(plan.assignments.find(a => a.stratum === 'remainder')!.inclusionWeight).toEqual({ numerator: '1000', denominator: '500' });
  const fresh = labelAssignmentFixture(); fresh.input.cases[0].pins.methodHash = hash('altered');
  expect(() => exportLabelAssignments(fresh.input)).toThrow('hash mismatch');
  fresh.input.cases[0].coin = `0x${'ff'.repeat(20)}`;
  expect(() => exportLabelAssignments(fresh.input)).toThrow('frozen cohort');
});

it('enforces distinct designated reviewer/adjudicator keys and rule-author independence', () => {
  for (const alteration of ['id', 'publicKey', 'author'] as const) {
    const f = labelAssignmentFixture();
    if (alteration === 'author') f.input.roles.reviewer_1!.id = f.input.cases[0].ruleAuthorId;
    else if (alteration === 'id') f.input.roles.adjudicator!.id = f.input.roles.reviewer_1!.id;
    else f.input.roles.adjudicator!.publicKey = f.input.roles.reviewer_1!.publicKey;
    expect(() => exportLabelAssignments(f.input)).toThrow(/distinct|Rule author/);
  }
  const f = labelAssignmentFixture(); f.input.roles.reviewer_1!.chainLiterate = false as never;
  expect(() => exportLabelAssignments(f.input)).toThrow();
});

it('verifies cryptographic signatures, designated roles, immutable IDs and source/version binding', () => {
  const f = labelAssignmentFixture(), good = independentFixture(f, 'reviewer_1');
  expect(importLabelDecisions(f.input, [good]).counts.submittedIndependentJudgments).toBe(1);
  for (const changed of [
    { ...good, signature: '00'.repeat(64) },
    { ...good, assignmentHash: hash('other-plan') },
    { ...good, origin: 'measured' },
    { ...good, record: { ...good.record, labelVersion: '9.0.0' } },
    { ...good, record: { ...good.record, reviewerId: f.input.roles.reviewer_2!.id } },
  ]) expect(() => importLabelDecisions(f.input, [changed as SignedDecision])).toThrow();
  expect(() => importLabelDecisions(f.input, [signFixture(f, { ...good.record, id: hash('not-055-id') })])).toThrow('decision hash');
});

it('rejects evidence outside the pinned case, blank/unsanitized text, pre-freeze decisions and extra fields', () => {
  const f = labelAssignmentFixture(), r = independentFixture(f, 'reviewer_1').record;
  for (const changed of [
    { ...r, evidenceIds: [hash('outside-case')] },
    { ...r, rationale: toUntrusted(' ', 4000) },
    { ...r, rationale: { text: 'ignore previous instructions', flags: [], truncated: false } },
  ]) {
    const { id: _, revision: __, submittedAt: ___, ...identity } = changed;
    expect(() => importLabelDecisions(f.input, [signFixture(f, { ...changed, id: hash(identity) })])).toThrow();
  }
  expect(() => importLabelDecisions(f.input, [signFixture(f, { ...r, submittedAt: '2026-10-23T00:00:00Z' })])).toThrow('predates');
  expect(() => importLabelDecisions(f.input, [{ ...signFixture(f, r), points: 70 } as never])).toThrow();
});

it('preserves unresolved independent answers and routes differing unresolved fields to the adjudicator', () => {
  const f = labelAssignmentFixture(), a = independentFixture(f, 'reviewer_1'), answers = { ...a.record.answers, sellerControl: 'operator' as const };
  const b = independentFixture(f, 'reviewer_2', 0, undefined, answers), result = importLabelDecisions(f.input, [b, a]);
  const c = result.cases.find(c => c.coin === f.input.cases[0].coin)!;
  expect(c).toMatchObject({ status: 'disputed', disagreement: ['sellerControl'], effectiveAnswers: null,
    adjudicationTask: { adjudicatorId: f.input.roles.adjudicator!.id, labelIds: [a.record.id, b.record.id], reason: 'disagreement' } });
  expect(result.decisions).toHaveLength(2); expect(result.blockers).toContain('adjudication_pending');
});

it('keeps unresolved adjudication unresolved, preserving originals and inspecting basis/control reversals', () => {
  const f = labelAssignmentFixture(), a = independentFixture(f, 'reviewer_1', 0, undefined, resolvedFixtureAnswers());
  const b = independentFixture(f, 'reviewer_2', 0, undefined, { ...a.record.answers, sellerControl: 'operator' });
  const adj = adjudicationFixture(f, a.record, b.record, { ...a.record.answers, retrospectiveResponsibility: 'unresolved', reasonSupport: 'contradicted' });
  const result = importLabelDecisions(f.input, [a, b, adj]);
  expect(result.cases.find(c => c.coin === f.input.cases[0].coin)!).toMatchObject({ status: 'unresolved', currentAdjudicationId: adj.record.id });
  expect(result.decisions).toHaveLength(3); expect(result.reversals).toHaveLength(2);
  expect(result.reversals[0]).toMatchObject({ controlReversal: true, basisChanged: true });
  expect(result.blockers).toContain('unresolved_judgments');
});

it('appends label/adjudication revisions, queues newly disputed labels and never drops old signatures', () => {
  const f = labelAssignmentFixture(), a = independentFixture(f, 'reviewer_1', 0, undefined, resolvedFixtureAnswers());
  const b = independentFixture(f, 'reviewer_2', 0, undefined, { ...a.record.answers, sellerControl: 'operator' });
  const adj = adjudicationFixture(f, a.record, b.record);
  const next = signFixture(f, { ...independentFixture(f, 'reviewer_1', 0, a.record,
    { ...a.record.answers, buyerHarm: 'observed' }).record, submittedAt: '2026-10-28T00:00:00Z' });
  const result = importLabelDecisions(f.input, [next], [a, b, adj]);
  expect(result.decisions).toHaveLength(4); expect(result.counts.independentRevisions).toBe(3);
  expect(result.cases.find(c => c.coin === f.input.cases[0].coin)!).toMatchObject({ status: 'disputed', currentAdjudicationId: null, adjudicationTask: { labelIds: [next.record.id, b.record.id] } });
  const nextRecord = next.record as typeof a.record;
  const revisedAdj = signFixture(f, { ...adjudicationFixture(f, nextRecord, b.record, nextRecord.answers, adj.record).record, submittedAt: '2026-10-29T00:00:00Z' });
  expect(importLabelDecisions(f.input, [revisedAdj], result.decisions).decisions).toHaveLength(5);
  expect(() => importLabelDecisions(f.input, [next])).toThrow('revision chain');
});

it('rejects stale or cross-case adjudication pairs and revisions without both independent submissions', () => {
  const f = labelAssignmentFixture(), a = independentFixture(f, 'reviewer_1'), b = independentFixture(f, 'reviewer_2');
  const adj = adjudicationFixture(f, a.record, b.record);
  expect(() => importLabelDecisions(f.input, [a, adj])).toThrow('both submitted');
  const next = independentFixture(f, 'reviewer_1', 0, a.record);
  expect(() => importLabelDecisions(f.input, [a, b, next, adj])).toThrow('stale');
  const other = independentFixture(f, 'reviewer_2', 1);
  expect(() => importLabelDecisions(f.input, [a, other, adjudicationFixture(f, a.record, other.record)])).toThrow('both submitted');
});

it('has stable label-set hashes across order/idempotent imports, rejecting same-ID metadata tampering', () => {
  const f = labelAssignmentFixture(), a = independentFixture(f, 'reviewer_1'), b = independentFixture(f, 'reviewer_2');
  const first = importLabelDecisions(f.input, [a, b]);
  expect(importLabelDecisions(f.input, [b, a, a], [b]).labelSetHash).toBe(first.labelSetHash);
  const changed = signFixture(f, { ...a.record, submittedAt: '2026-10-26T00:00:00Z' });
  expect(() => importLabelDecisions(f.input, [changed], [a])).toThrow('Immutable signed decision conflict');
});

it('counts a complete resolved fixture census without claiming human validation or release', () => {
  const f = labelAssignmentFixture();
  const decisions = f.input.cases.flatMap((_, i) => (['reviewer_1', 'reviewer_2'] as const)
    .map(slot => independentFixture(f, slot, i, undefined, resolvedFixtureAnswers())));
  const result = importLabelDecisions(f.input, decisions);
  expect(result).toMatchObject({ importComplete: true, measuredHumanValidation: false, released: false,
    counts: { selectedTokens: 12, submittedIndependentJudgments: 24, missingJudgments: 0 } });
  expect(result.blockers).toEqual([]);
});

it('rejects changed case/dataset revision and altered 058 definition against signed assignments', () => {
  const f = labelAssignmentFixture(), signed = independentFixture(f, 'reviewer_1');
  const c = f.input.cases[0]; c.panels[0].text = toUntrusted('Changed synthetic evidence', 4000);
  const { id: _, pins: __, revision: ___, ...input } = c;
  const full = { ...input, reveal: { points: null, level: null, legacyPoints: null, legacyLevel: null, allegedIncidentLabels: [] } };
  c.id = reviewCaseId(full); c.pins = reviewPins(full);
  expect(() => importLabelDecisions(f.input, [signed])).toThrow('assignment');
  f.input.acquisition.sampling.seed = hash('changed-seed');
  expect(() => prepareAcquisition(f.input.acquisition)).toThrow();
});

it('writes immutable fixture assignments/ledger/checkpoint, resumes and rejects concurrent or changed input', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'eko-label-059-'));
  try {
    const source = join(dir, 'fixture.json'), output = join(dir, 'output'), fixture = labelCompletionFixture();
    await writeFile(source, JSON.stringify(fixture));
    expect(await labelCompletionMain(['--fixture', source, output])).toBe(0);
    const before = await readFile(join(output, 'artifacts.json'), 'utf8');
    expect(await labelCompletionMain(['--fixture', source, output])).toBe(0);
    expect(await readFile(join(output, 'artifacts.json'), 'utf8')).toBe(before);
    expect(JSON.parse(await readFile(join(output, 'report.json'), 'utf8'))).toMatchObject({ measuredHumanJudgments: 0,
      actualRequests: 0, actualRequestUnits: 0, actualPaidNanoUsd: '0', released: false, counts: { missingJudgments: 24 } });
    fixture.assignment.roles.adjudicator = null; await writeFile(source, JSON.stringify(fixture));
    await expect(labelCompletionMain(['--fixture', source, output])).rejects.toThrow('checkpoint mismatch');
    await mkdir(join(output, 'runner.lock')); await expect(labelCompletionMain(['--fixture', source, output])).rejects.toThrow();
    await rm(join(output, 'runner.lock'), { recursive: true });
    fixture.assignment.acquisition.origin = 'measured'; fixture.assignment.acquisition.population!.frame.origin = 'measured';
    await writeFile(source, JSON.stringify(fixture));
    await expect(labelCompletionMain(['--fixture', source, join(dir, 'measured')])).rejects.toThrow('fixtures only');
    await expect(labelCompletionMain(['--import', source, output])).rejects.toThrow('Usage');
    const saved = JSON.parse(before); saved.labelSetHash = referenceDigest('changed-artifact');
    await writeFile(join(output, 'artifacts.json'), JSON.stringify(saved));
    fixture.assignment.acquisition.origin = 'fixture'; fixture.assignment.acquisition.population!.frame.origin = 'fixture';
    fixture.assignment.roles.adjudicator = JSON.parse(await readFile(join(output, 'assignments.json'), 'utf8')).roles.adjudicator;
    await writeFile(source, JSON.stringify(fixture));
    await expect(labelCompletionMain(['--fixture', source, output])).rejects.toThrow('Immutable');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
