// Synthetic locked paths only; no measured candidate or human sign-off.
import { reviewCaseId, reviewPins } from '@eko/db';
import { referenceDigest } from '@eko/chain';
import { prepareAcquisition } from '../src/acquisition-run.js';
import { DEVELOPMENT_FIT_VERSION, developmentGrid, freezeDevelopmentTruths, preregisterDevelopmentFit } from '../src/development-fit.js';
import { LOCKED_TEST_VERSION, DevelopmentFreezeSchema, preregisterLockedTest, type LockedTestInput } from '../src/locked-test.js';
import { GUARD_FACTOR_IDS } from '@eko/shared';
import { developmentFitFixture } from './development-fit-fixtures.js';
import { labelAssignmentFixture, independentFixture, resolvedFixtureAnswers } from './label-completion-fixtures.js';
import { hash } from '../../../packages/playbooks/test/scoring-fixtures.js';

export function lockedTestFixture(frozen = false, resolved = false): LockedTestInput {
  const dev = developmentFitFixture(), f = labelAssignmentFixture(), acquisition = f.input.acquisition;
  const cohort = prepareAcquisition(acquisition), registration = preregisterDevelopmentFit(acquisition);
  const members = cohort.assignments!.filter(a => a.calendarSplit === 'locked_test' && a.disposition === 'included');
  const truths: LockedTestInput['truths'] = [], features: LockedTestInput['features'] = [];
  members.forEach((a, i) => {
    for (const sizeUsd of [100, 1000] as const) for (const accountClass of ['eoa', 'contract'] as const) {
      const t = structuredClone(dev.truths.find(t => t.sizeUsd === sizeUsd && t.accountClass === accountClass)!);
      const s = structuredClone(dev.features.find(t => t.sizeUsd === sizeUsd && t.accountClass === accountClass)!.input);
      t.coin = s.coin = a.coin;
      const now = String(BigInt(a.launchSec) + 60n);
      s.cursor.timestampSec = now; s.cursor.blockNumber = String(150 + i); s.availabilityCut.cursor = s.cursor;
      for (const check of s.checks) check.coverage.from = check.coverage.through = s.cursor;
      for (const o of s.observations) for (const m of [o.primary, o.secondary, o.qualification]) if (m) {
        m.cursor = s.cursor; m.knownAt = s.availabilityCut; m.throughSec = now; m.coverage.from = m.coverage.through = s.cursor;
      }
      t.entryCursor = s.cursor; t.entryCut = s.availabilityCut; t.exitDeadlineSec = String(BigInt(now) + 3600n);
      t.exitCursor = { ...s.cursor, timestampSec: t.exitDeadlineSec, blockNumber: String(250 + i), blockHash: hash(11000 + i) };
      t.benchmarkHash = referenceDigest({ coin: a.coin, sizeUsd, accountClass, syntheticLockedPath: true });
      t.returnPct = { numerator: i === 0 ? '-50' : '0', denominator: '1' };
      truths.push(t); features.push({ coin: a.coin, sizeUsd, accountClass, input: s });
    }
  });
  f.input.cases = f.input.cases.filter(c => members.some(a => a.coin === c.coin)).map(c => {
    const paths = truths.filter(t => t.coin === c.coin);
    c.machineOutcome.benchmarkArtifactHashes = paths.map(t => t.benchmarkHash as `0x${string}`);
    c.evidenceIds = [...new Set([...c.evidenceIds, ...paths.flatMap(t => t.evidenceIds)])] as `0x${string}`[];
    const { id: _, revision: __, pins: ___, ...base } = c;
    const snapshot = { ...base, reveal: { points: null, level: null, legacyPoints: null, legacyLevel: null, allegedIncidentLabels: [] } };
    return { ...c, id: reviewCaseId(snapshot), pins: reviewPins(snapshot) };
  });
  const decisions = resolved ? f.input.cases.flatMap((c, i) => {
    const answers = { ...resolvedFixtureAnswers(), buyerHarm: (i === 0 ? 'observed' : 'not_observed') as 'observed' | 'not_observed' };
    return [independentFixture(f, 'reviewer_1', i, undefined, answers), independentFixture(f, 'reviewer_2', i, undefined, answers)];
  }) : [];
  const p = developmentGrid().find(p => p.lower === 30 && p.high === 60 && p.enabled.length === GUARD_FACTOR_IDS.length && p.enabled.every(id => p.weights[id] === 100))!;
  const body = { version: DEVELOPMENT_FIT_VERSION, candidateRevision: hash(8001), cohortHash: cohort.manifestHash,
    methodHash: registration.methodHash, gridHash: registration.gridHash, truthHash: dev.truthHash, labelSetHash: hash(8002), calibrationHash: hash(8003),
    parametersHash: p?.parametersHash, parameters: p, status: 'development_frozen_awaiting_untouched_test' as const,
    acceptedCandidate: null, heldOutTestRequired: true as const, mode: 'shadow' as const, active: false as const, released: false as const,
    historyEnabled: false as const, bucketsEnabled: false as const };
  const prepared: Omit<LockedTestInput, 'registration'> = { version: LOCKED_TEST_VERSION, origin: 'fixture', acquisition, freeze: frozen ? DevelopmentFreezeSchema.parse({ ...body, freezeHash: referenceDigest(body) }) : null,
    labels: { assignment: f.input, decisions, previous: [] }, truths, truthHash: freezeDevelopmentTruths(truths), features,
    fidelity: [], audits: [], independentAuditKinds: [], factualFixtureEvidence: null, sensitivities: [],
    operations: { pilotTargetHash: null, parity: null, rows: [], frozenPerformanceHash: null, frozenEvaluations: 0,
      evaluationsPerSec: null, evaluatorRpcCalls: null, boundedMemoryResume: null } };
  return { ...prepared, registration: preregisterLockedTest(prepared) };
}
