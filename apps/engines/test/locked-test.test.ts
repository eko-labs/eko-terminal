import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { referenceDigest } from '@eko/chain';
import { evaluateLockedFixtures, preregisterLockedTest } from '../src/locked-test.js';
import { lockedTestMain } from '../src/locked-test-cli.js';
import { weightedComponentRate, independentWilsonAudit, lockedPrimaryMetrics } from '../src/locked-test-statistics.js';
import { freezeDevelopmentTruths } from '../src/development-fit.js';
import { lockedTestFixture } from './locked-test-fixtures.js';
import { developmentFitFixture } from './development-fit-fixtures.js';
import { hash } from '../../../packages/playbooks/test/scoring-fixtures.js';
import type { DevelopmentMetricRow } from '../src/development-fit-statistics.js';

const row = (coin: string, extra: Partial<DevelopmentMetricRow> = {}): DevelopmentMetricRow => ({ coin, groupId: coin, weight: 1,
  truth: false, level: 'lower', complete: true, gapFloor: false, factualHigh: false, criticalRestriction: false, ...extra });
describe('061 locked fixture evaluation', () => {
  it('explicitly reports no frozen candidate/no labels with all tokens and unknowns', () => {
    const report = evaluateLockedFixtures(lockedTestFixture(), hash(61));
    expect(report.status).toContain('not accepted: no frozen candidate, no labels');
    expect(report).toMatchObject({ acceptedCandidate: null, active: false, mode: 'shadow', released: false });
    expect(report.coverage).toMatchObject({ allEnumeratedTokens: 12, allTestPopulation: 3, evaluatedTestTokens: 3,
      expectedPrimaryEntries: 12, suppliedPrimaryEntries: 12, knownReviewedPrimaryEntries: 0, missingLabelTokens: 3, developmentCountCredit: 0, measuredTokens: 0 });
    expect(report.primary).toHaveLength(4);
    for (const c of report.primary) {
      expect(c.requiredHeldOut).toEqual({ knownHigh: 100, hurt: 100, knownLower: 100, developmentCredit: 0 });
      expect(c.denominators.unknownOutcomes).toBe(3);
      expect(c.highPrecision.point).toBeNull();
      expect(c.modes.every(m => m.denials === 3 && m.unknownRefusals === 3 && m.falseRefusals === 0)).toBe(true);
    }
    expect(report.gateTable.every(g => !g.acceptancePass && g.status === 'not_accepted')).toBe(true);
    expect(report.spend).toMatchObject({ actualRequests: 0, actualRequestUnits: 0, actualPaidNanoUsd: '0', pricingEvidence: null });
  });
  it('exercises synthetic frozen parameters and signed labels without promoting fixtures', () => {
    const f = lockedTestFixture(true, true), r = evaluateLockedFixtures(f, hash(61));
    expect(r.pins.parametersHash).toBe(f.freeze!.parametersHash);
    expect(r.coverage.knownReviewedPrimaryEntries).toBe(12);
    expect(r.blockers).toEqual(['fixtures are not acceptance']);
    expect(r.acceptedCandidate).toBeNull(); expect(r.gateTable.every(g => !g.acceptancePass)).toBe(true);
    expect(r.primary.every(c => c.denominators.hurt === 1)).toBe(true);
    expect(r.primary[0].diagnostics[0].assignedFactors.length).toBeGreaterThan(0);
  });
  it('rejects development, purged cases/truths/features and duplicate primary paths', () => {
    const f = lockedTestFixture(), dev = developmentFitFixture();
    f.labels.assignment.cases.push(dev.labels.assignment.cases[0]);
    expect(() => evaluateLockedFixtures(f, hash(61))).toThrow('untouched included test');
    const g = lockedTestFixture(); g.truths.push(dev.truths[0]); g.truthHash = freezeDevelopmentTruths(g.truths);
    g.registration = preregisterLockedTest(g);
    expect(() => evaluateLockedFixtures(g, hash(61))).toThrow('pinned untouched test');
    const h = lockedTestFixture(); h.features.push(dev.features[0]);
    expect(() => evaluateLockedFixtures(h, hash(61))).toThrow('matching frozen entry');
    const j = lockedTestFixture(); j.truths.push(j.truths[0]); j.truthHash = freezeDevelopmentTruths(j.truths);
    j.registration = preregisterLockedTest(j);
    expect(() => evaluateLockedFixtures(j, hash(61))).toThrow('Duplicate');
  });
  it('rejects leaked decision revisions before importing answers', () => {
    const f = lockedTestFixture(), dev = developmentFitFixture(true);
    f.labels.previous = dev.labels.decisions;
    expect(() => evaluateLockedFixtures(f, hash(61))).toThrow('Development/purged labels');
  });
  it('pins candidate, truth, profile, cursor and availability instead of accepting a later verdict', () => {
    const f = lockedTestFixture(true); f.freeze!.parameters!.high = 65;
    expect(() => evaluateLockedFixtures(f, hash(61))).toThrow('hash mismatch');
    const g = lockedTestFixture(); g.truths[0].returnPct!.numerator = '-90';
    expect(() => evaluateLockedFixtures(g, hash(61))).toThrow('truth hash mismatch');
    for (const alter of [(h: ReturnType<typeof lockedTestFixture>) => { h.features[0].input.profileHash = hash(70); },
      (h: ReturnType<typeof lockedTestFixture>) => { h.features[0].input.cursor = { ...h.features[0].input.cursor, timestampSec: '9999999999' }; }]) {
      const h = lockedTestFixture(); alter(h); expect(() => evaluateLockedFixtures(h, hash(61))).toThrow('matching frozen entry');
    }
  });
  it('keeps entry failure/provider censoring in denominators without fabricating invested harm', () => {
    const f = lockedTestFixture();
    Object.assign(f.truths[0], { entry: { status: 'entry_unavailable', reason: 'entry_failed', evidenceIds: [] }, exit: null,
      returnPct: null, exitDeadlineSec: null, exitCursor: null });
    Object.assign(f.truths[1], { exit: { status: 'censored', reason: 'provider_gap', failedTransaction: null, evidenceIds: [] }, returnPct: null });
    f.truthHash = freezeDevelopmentTruths(f.truths);
    f.registration = preregisterLockedTest(f);
    const r = evaluateLockedFixtures(f, hash(61));
    expect(r.coverage.suppliedPrimaryEntries).toBe(12);
    expect(r.primary[0].entryUnavailable).toBe(1); expect(r.primary[1].providerCensored).toBe(1);
    expect(r.primary[0].diagnostics[0].machineTruthDiagnostic).toBeNull();
  });
  it('keeps absent primary units and sensitivity coverage explicit', () => {
    const f = lockedTestFixture(); f.truths.pop(); f.features.pop(); f.truthHash = freezeDevelopmentTruths(f.truths);
    f.registration = preregisterLockedTest(f);
    const r = evaluateLockedFixtures(f, hash(61));
    expect(r.coverage.missingPrimaryEntries).toBe(1);
    expect(r.sensitivity).toMatchObject({ supplied: 0, primaryCredit: 0, requiredDelaysSec: [5, 30, 60, 300] });
    f.sensitivities.push(structuredClone(f.truths[0]));
    f.registration = preregisterLockedTest(f);
    expect(() => evaluateLockedFixtures(f, hash(61))).toThrow('replaced by sensitivity');
  });
  it('reports missing completion separately from latency on completed observations', () => {
    const f = lockedTestFixture();
    f.operations.rows = [null, 100].map(v => ({ venue: 'pons_curve', ageSec: 60, scanMs: 1, enrichmentMs: null, probeMs: null,
      attributionMs: null, alertMs: null, criticalCompletionMs: v, lowerCompletionMs: null, preflightMs: 5 }));
    const r = evaluateLockedFixtures(f, hash(61));
    expect(r.operations.latency[0].metrics.criticalCompletionMs).toEqual({ observations: 2, completed: 1, missing: 1, p95Ms: 100 });
    expect(r.operations.targetsAccepted).toBe(false);
  });
  it('derives factual precision from signed answers and keeps declared Wilson audits separate', () => {
    const f = lockedTestFixture(true, true);
    f.audits = f.labels.assignment.cases.map((c, i) => ({ id: hash(9100 + i), coin: c.coin, kind: 'factual',
      assertedAnswer: 'supported', supported: true, evidenceIds: [c.evidenceIds[0]] }));
    f.independentAuditKinds = ['factual'];
    f.registration = preregisterLockedTest(f);
    const r = evaluateLockedFixtures(f, hash(61));
    expect(r.audits[0].weighted.point).toBe(1); expect(r.audits[0].independentWilson!.n).toBe(3);
    expect(r.audits[0].independentWilson!.lower).toBeLessThan(.9);
    expect(r.restrictionRecall.point).toBeNull();
    expect(r.gateTable.find(g => g.gate === 'general_factual_review')).toMatchObject({ numericalPass: true, acceptancePass: false });
    expect(r.currentFactPrecision.currentCost).toBeNull();
  });
  it('rejects a changed preregistered scope before evaluating labels', () => {
    const f = lockedTestFixture(); f.operations.pilotTargetHash = hash(9);
    expect(() => evaluateLockedFixtures(f, hash(61))).toThrow('Locked preregistration mismatch');
  });
});
describe('061 weighted clustered statistics and independent audits', () => {
  it('respects inclusion weights and correlated paths and invalidates undefined intervals', () => {
    const rows = [{ groupId: 'shared', weight: 9, numerator: true, denominator: true },
      { groupId: 'shared', weight: 1, numerator: false, denominator: true }];
    const r = weightedComponentRate(rows, 'seed');
    expect(r).toMatchObject({ point: .9, lower: .9, upper: .9, components: 1, undefinedResamples: 0 });
    expect(r.bootstrap.resamples).toBe(2000); expect(weightedComponentRate(rows, 'seed')).toEqual(r);
    const g = weightedComponentRate([...rows, { groupId: 'unknown', weight: 1, numerator: false, denominator: false }], 'seed');
    expect(g.lower).toBeNull(); expect(g.undefinedResamples).toBeGreaterThan(0);
  });
  it('uses Wilson only for declared independent unweighted binary audits', () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ coin: `sample-${i}`, groupId: `component-${i}`, weight: 1, numerator: true, denominator: true }));
    expect(independentWilsonAudit(rows, false)).toBeNull();
    expect(independentWilsonAudit(rows, true)!.lower).toBeCloseTo(.963, 3);
    expect(() => independentWilsonAudit([...rows, rows[0]], true)).toThrow('independent');
    expect(() => independentWilsonAudit([{ ...rows[0], weight: 2 }], true)).toThrow('unweighted');
    expect(independentWilsonAudit([], true)!.lower).toBeNull();
  });
  it('requires held-out minima and separates current facts, floors and Incomplete from future detection', () => {
    const r = lockedPrimaryMetrics([row('a', { truth: true, level: 'high', factualHigh: true }),
      row('b', { truth: true, level: 'elevated', complete: false, gapFloor: true }),
      row('c', { truth: true, level: 'incomplete', complete: false })], 'seed');
    expect(r.elevatedHighRecall.point).toBe(0); expect(r.highPrecision.point).toBeNull();
    expect(r.factualHighHarmRate.point).toBe(1); expect(r.numericalGates.recall).toBe(false);
    const small = lockedPrimaryMetrics([row('h', { truth: true, level: 'high' })], 'seed');
    expect(small.highPrecision.point).toBe(1); expect(small.numericalGates.high).toBe(false);
    expect(small.requiredHeldOut.developmentCredit).toBe(0);
  });
  it('passes numerical gates only with distinct held-out denominators and complete separated bands', () => {
    const rows = Array.from({ length: 100 }, (_, i) => row(`high-${i}`, { groupId: 'component', truth: true, level: 'high' }))
      .concat(Array.from({ length: 100 }, (_, i) => row(`elevated-${i}`, { groupId: 'component', truth: i < 20, level: 'elevated' })))
      .concat(Array.from({ length: 100 }, (_, i) => row(`lower-${i}`, { groupId: 'component' })));
    const r = lockedPrimaryMetrics(rows, 'seed');
    expect(r.numericalGates).toEqual({ high: true, recall: true, lower: true });
    expect(r.denominators).toMatchObject({ knownHigh: 100, hurt: 120, knownLower: 100, independentComponents: 1 });
    rows[200].criticalRestriction = true;
    expect(lockedPrimaryMetrics(rows, 'seed').numericalGates.lower).toBe(false);
    const duplicates = Array.from({ length: 100 }, () => row('same-token', { groupId: 'component', truth: true, level: 'high' }));
    expect(lockedPrimaryMetrics(duplicates, 'seed').numericalGates.high).toBe(false);
  });
});
describe('061 immutable fixture driver', () => {
  it('verifies identical resume; rejects reuse, concurrent ownership, changed input and tampered artifacts/checkpoint', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eko-061-'));
    try {
      const source = join(dir, 'input.json'), output = join(dir, 'output'), ledger = join(dir, 'ledger');
      await writeFile(source, JSON.stringify(lockedTestFixture()));
      expect((await lockedTestMain(['--fixture', source, output, ledger])).exitCode).toBe(0);
      const report = await readFile(join(output, 'report.json'), 'utf8');
      expect(await lockedTestMain(['--fixture', source, output, ledger])).toMatchObject({ exitCode: 0, reEvaluated: false });
      expect(await readFile(join(output, 'report.json'), 'utf8')).toBe(report);
      await expect(lockedTestMain(['--fixture', source, join(dir, 'another'), ledger])).rejects.toThrow();
      await mkdir(join(output, 'runner.lock'));
      await expect(lockedTestMain(['--fixture', source, output, ledger])).rejects.toThrow();
      await rm(join(output, 'runner.lock'), { recursive: true });
      await writeFile(join(output, 'report.json'), '{}');
      await expect(lockedTestMain(['--fixture', source, output, ledger])).rejects.toThrow('missing or changed');
      await writeFile(join(output, 'report.json'), report);
      const changed = JSON.parse(await readFile(source, 'utf8')); changed.truthHash = hash(90);
      await writeFile(source, JSON.stringify(changed));
      await expect(lockedTestMain(['--fixture', source, output, ledger])).rejects.toThrow('Checkpoint/source');
      await writeFile(source, JSON.stringify(lockedTestFixture()));
      // Fresh random fixture signing public keys are also a changed input.
      await expect(lockedTestMain(['--fixture', source, output, ledger])).rejects.toThrow('Checkpoint/source');
      await expect(lockedTestMain(['--measured', source, output, ledger])).rejects.toThrow('Usage');
      const checkpoint = JSON.parse(await readFile(join(output, 'checkpoint.json'), 'utf8'));
      checkpoint.inputHash = referenceDigest(JSON.parse(await readFile(source, 'utf8')));
      await writeFile(join(output, 'checkpoint.json'), JSON.stringify(checkpoint));
      await expect(lockedTestMain(['--fixture', source, output, ledger])).rejects.toThrow('Checkpoint/source');
    } finally { await rm(dir, { recursive: true }); }
  });
});
