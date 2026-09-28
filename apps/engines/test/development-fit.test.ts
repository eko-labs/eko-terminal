import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { referenceDigest } from '@eko/chain';
import { CONFIG_GUARD_V2, GUARD_PARAMETERS_HASH } from '@eko/playbooks';
import { developmentFitFixture } from './development-fit-fixtures.js';
import { labelAssignmentFixture, independentFixture, resolvedFixtureAnswers } from './label-completion-fixtures.js';
import { developmentGrid, fitDevelopment, preregisterDevelopmentFit, freezeDevelopmentTruths, projectDevelopmentScore } from '../src/development-fit.js';
import { developmentMetrics, selectDevelopmentCandidate, type DevelopmentMetricRow } from '../src/development-fit-statistics.js';
import { developmentFitMain } from '../src/development-fit-cli.js';
import { input, observation, gap, hash } from '../../../packages/playbooks/test/scoring-fixtures.js';

const baseline = () => developmentGrid().find(p => p.lower === 30 && p.high === 60 && p.enabled.length === 22 && Object.values(p.weights).every(w => w === 100))!;
const metricRow = (coin: string, overrides: Partial<DevelopmentMetricRow> = {}): DevelopmentMetricRow => ({ coin,
  groupId: coin, weight: 1, truth: false, level: 'lower', complete: true, gapFloor: false, factualHigh: false, criticalRestriction: false, ...overrides });

describe('060 purged development fitting', () => {
  it('runs all preregistered fixture trials but freezes no eligible or accepted candidate', () => {
    const f = developmentFitFixture(), before = referenceDigest(f);
    const r = fitDevelopment(f, hash(60));
    expect(referenceDigest(f)).toBe(before);
    expect(r.freeze).toMatchObject({ acceptedCandidate: null, parametersHash: null, status: 'no_eligible_development_candidate', active: false,
      released: false, historyEnabled: false, bucketsEnabled: false });
    expect(r.evidence.trials).toHaveLength(developmentGrid().length);
    expect(r.evidence.trials.every(t => !t.eligible)).toBe(true);
    expect(r.blockers).toContain('development_labels_pending');
    expect(r.blockers).toContain('measurement_fidelity_unpassed');
    expect(r.evidence.actualValidation).toMatchObject({ measuredTokens: 0, fixtureTokens: 6, expectedUnits: 24, suppliedUnits: 24 });
    expect(r.evidence.coverage).toMatchObject({ heldOutLabelsInspected: 0, heldOutFeaturesInspected: 0, enumerated: 12 });
    expect(r.evidence.fidelity.every(f => f.realMatchedCases === 0 && !f.passed)).toBe(true);
    expect(r.evidence.ablations.map(a => a.name)).toEqual(['no_compatibility', 'sum_factors', 'history']);
    const { freezeHash, ...body } = r.freeze;
    expect(freezeHash).toBe(referenceDigest(body)); expect(r.freeze.calibrationHash).toBe(referenceDigest(r.evidence));
    expect(CONFIG_GUARD_V2).toMatchObject({ mode: 'shadow', lowerEnabled: false, boosterEnabled: false });
    expect(r.evidence.method.baselineParametersHash).toBe(GUARD_PARAMETERS_HASH);
  });
  it('synthetic signed development labels do not establish measured acceptance', () => {
    const r = fitDevelopment(developmentFitFixture(true), hash(60));
    expect(r.blockers).not.toContain('development_labels_pending');
    expect(r.blockers).toContain('fixture_only_no_measured_validation');
    expect(r.acceptedCandidate).toBeNull(); expect(r.freeze.parameters).toBeNull();
    expect(r.evidence.actualValidation.developmentJudgments).toBe(12);
  });
  it('derives audit errors from signed answers and reports missing evidence without filling the denominator', () => {
    const f = developmentFitFixture(true), c = f.labels.assignment.cases[0];
    f.audits = [{ id: hash(441), coin: c.coin, kind: 'attribution', assertedAnswer: 'operator', supported: true, evidenceIds: [c.evidenceIds[0]] }];
    f.features = f.features.slice(1);
    const r = fitDevelopment(f, hash(60));
    expect(r.evidence.audits.attribution).toMatchObject({ assertions: 1, supported: 1, precision: 0, errors: 1 });
    expect(r.evidence.trials.every(t => !t.eligible)).toBe(true);
    expect(r.acceptedCandidate).toBeNull();
    expect(r.evidence.fitting.some(c => c.incomplete > 0)).toBe(true);
  });
  it('rejects altered preregistration/truths before any fit or threshold selection', () => {
    const f = developmentFitFixture(); f.preregistration.gridHash = hash(99);
    expect(() => fitDevelopment(f, hash(60))).toThrow('preregistration');
    const t = developmentFitFixture(); t.truths[0].returnPct!.numerator = '-90';
    expect(() => fitDevelopment(t, hash(60))).toThrow('truth hash');
  });
  it('rejects locked/purged case payloads and all held-out decision revisions', () => {
    const f = developmentFitFixture(); const other = labelAssignmentFixture();
    const test = other.input.cases.find(c => !f.labels.assignment.cases.some(d => d.coin === c.coin))!;
    f.labels.assignment.cases.push(test);
    expect(() => fitDevelopment(f, hash(60))).toThrow('case payloads');
    const g = developmentFitFixture();
    const i = other.input.cases.findIndex(c => c.coin === test.coin);
    const decision = independentFixture(other, 'reviewer_1', i, undefined, resolvedFixtureAnswers());
    g.labels.previous.push(decision);
    expect(() => fitDevelopment(g, hash(60))).toThrow('development judgments');
  });
  it('rejects held-out truth/features, detached benchmark evidence and later feature cursors', () => {
    const f = developmentFitFixture(); f.truths[0].coin = f.acquisition.population!.frame.members[9].coin;
    f.truthHash = freezeDevelopmentTruths(f.truths);
    expect(() => fitDevelopment(f, hash(60))).toThrow('outside included');
    const g = developmentFitFixture(); g.features[0].input.cursor = { ...g.features[0].input.cursor, timestampSec: String(BigInt(g.features[0].input.cursor.timestampSec) + 1n) };
    expect(() => fitDevelopment(g, hash(60))).toThrow('frozen entry');
    const h = developmentFitFixture(); h.truths[0].benchmarkHash = hash(987); h.truthHash = freezeDevelopmentTruths(h.truths);
    expect(() => fitDevelopment(h, hash(60))).toThrow('pinned benchmark');
  });
  it('keeps seven-day/strategy truth out and never turns entry failure into invested loss', () => {
    const f = developmentFitFixture(); f.truths[0].exitDeadlineSec = String(BigInt(f.truths[0].exitDeadlineSec!) + 1n);
    f.truthHash = freezeDevelopmentTruths(f.truths);
    expect(() => fitDevelopment(f, hash(60))).toThrow('scheduled exit');
    const g = developmentFitFixture(); g.truths[0].entry = { status: 'entry_unavailable', reason: 'entry_cap', evidenceIds: [] };
    g.truthHash = freezeDevelopmentTruths(g.truths);
    expect(() => fitDevelopment(g, hash(60))).toThrow('invested loss');
  });
  it('recomputes 058 group holdouts, retaining crossing/purged tokens in the manifest', () => {
    const f = developmentFitFixture(); const groups = f.acquisition.population!.groups;
    groups[0].components = groups[9].components;
    f.preregistration = preregisterDevelopmentFit(f.acquisition);
    expect(() => fitDevelopment(f, hash(60))).toThrow('case payloads');
  });
});

describe('060 projections and clustered weighted metrics', () => {
  it('uses family maxima, compatibility ablations, fixed current facts and exact integer rounding', () => {
    const s = input([observation('execution_cost', 25), observation('exercised_control', 25)]);
    s.observations.forEach(o => { o.mechanism = { id: hash(8), key: 'implementation_capability_effective_config', proven: true }; });
    expect(projectDevelopmentScore(s, baseline()).score).toBe(40);
    expect(projectDevelopmentScore(s, baseline(), 'no_compatibility').score).toBe(80);
    expect(projectDevelopmentScore(s, baseline(), 'sum_factors').score).toBe(80);
    const scaled = developmentGrid().find(p => p.lower === 30 && p.high === 60 && p.weights.operator_hold === 80 && p.enabled.length === 22 && p.weights.execution_cost === 100)!;
    expect(projectDevelopmentScore(input([observation('operator_hold', 10)]), scaled).score).toBe(28);
    const factsOnly = developmentGrid().find(p => p.enabled.length === 0)!;
    expect(projectDevelopmentScore(input([observation('execution_cost', 50)]), factsOnly)).toMatchObject({ level: 'high', factualHigh: true, score: 0 });
  });
  it('does not count funding-floor Elevated, Incomplete or current capability as future prediction successes', () => {
    const s = input(); gap(s, 'recent_funding');
    expect(projectDevelopmentScore(s, baseline())).toMatchObject({ level: 'elevated', gapFloor: true });
    const m = developmentMetrics([
      metricRow('a', { truth: true, level: 'elevated', gapFloor: true, complete: false }),
      metricRow('b', { truth: true, level: 'incomplete', complete: false }),
      metricRow('c', { truth: true, level: 'high', factualHigh: true }),
    ], hash(60));
    expect(m.point.elevatedHighRecall).toBeCloseTo(1 / 3);
    expect(m.point.highOnlyRecall).toBe(0); expect(m.knownHigh).toBe(0);
    expect(m.gates.recall).toBe(false); expect(m.factualHigh).toBe(1);
  });
  it('retains weights, correlated paths, unknown denominators and missing outcomes', () => {
    const rows = [metricRow('a', { truth: true, weight: 9, level: 'high', groupId: 'shared' }),
      metricRow('b', { truth: false, weight: 1, level: 'high', groupId: 'shared' }), metricRow('c', { truth: null })];
    const r = developmentMetrics(rows, hash(60));
    expect(r.point.highPrecision).toBe(.9); expect(r.independentGroups).toBe(2); expect(r.missingOutcomes).toBe(1);
    expect(r.intervals.highPrecision.undefinedResamples).toBeGreaterThan(0); expect(r.intervals.highPrecision.lower).toBeNull();
    expect(developmentMetrics(rows, hash(60))).toEqual(r); expect(r.gates.high).toBe(false);
  });
  it('applies distinct-token count and clustered interval gates per cohort', () => {
    const rows = Array.from({ length: 120 }, (_, i) => metricRow(`synthetic-high-${i}`, { truth: true, level: 'high' }));
    rows.push(...Array.from({ length: 120 }, (_, i) => metricRow(`synthetic-lower-${i}`)));
    const r = developmentMetrics(rows, hash(60));
    expect(r.gates.high).toBe(true); expect(r.gates.recall).toBe(true);
    expect(r.gates.lower).toBe(false); // Missing intermediate band has no demonstrated separation.
    expect(r.knownHigh).toBe(120); expect(r.knownLower).toBe(120);
    expect(r.bootstrap.resamples).toBe(2000);
  });
  it('orders eligible candidates by simplicity, precision, recall, deviation then hash', () => {
    const base = { eligible: true, parametersHash: 'b', enabledHeuristicFactors: 2, highPrecision: .9, highOnlyRecall: .5, deviation: 0 };
    expect(selectDevelopmentCandidate([base, { ...base, eligible: false, enabledHeuristicFactors: 0 }])).toEqual(base);
    for (const better of [{ enabledHeuristicFactors: 1 }, { highPrecision: .95 }, { highOnlyRecall: .6 }, { deviation: -1 }, { parametersHash: 'a' }]) {
      expect(selectDevelopmentCandidate([base, { ...base, ...better }])).toEqual({ ...base, ...better });
    }
    expect(selectDevelopmentCandidate([{ ...base, eligible: false }])).toBeNull();
  });
});

describe('060 immutable fixture driver', () => {
  it('writes checkpoint under exclusive ownership, verifies resume and refuses changed source/artifacts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eko-060-'));
    try {
      const source = join(dir, 'input.json'), output = join(dir, 'output');
      await writeFile(source, JSON.stringify(developmentFitFixture()));
      expect(await developmentFitMain(['--fixture', source, output])).toBe(0);
      const before = await readFile(join(output, 'freeze.json'), 'utf8');
      expect(await developmentFitMain(['--fixture', source, output])).toBe(0);
      expect(await readFile(join(output, 'freeze.json'), 'utf8')).toBe(before);
      expect(JSON.parse(before).acceptedCandidate).toBeNull();
      await mkdir(join(output, 'runner.lock'));
      await expect(developmentFitMain(['--fixture', source, output])).rejects.toThrow();
      await rm(join(output, 'runner.lock'), { recursive: true });
      await writeFile(join(output, 'freeze.json'), '{}');
      await expect(developmentFitMain(['--fixture', source, output])).rejects.toThrow('missing or changed');
      const f = JSON.parse(await readFile(source, 'utf8')); f.truthHash = hash(4); await writeFile(source, JSON.stringify(f));
      await expect(developmentFitMain(['--fixture', source, output])).rejects.toThrow('Source/candidate mismatch');
      await expect(developmentFitMain(['--measured', source, output])).rejects.toThrow('Usage');
    } finally { await rm(dir, { recursive: true }); }
  });
});
