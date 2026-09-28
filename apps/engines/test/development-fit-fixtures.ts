// Synthetic fitting inputs only. Never measured outcomes or human sign-off.
import { reviewCaseId, reviewPins } from '@eko/db';
import { referenceDigest } from '@eko/chain';
import { labelAssignmentFixture, independentFixture, resolvedFixtureAnswers } from './label-completion-fixtures.js';
import { prepareAcquisition } from '../src/acquisition-run.js';
import { DEVELOPMENT_FIT_VERSION, preregisterDevelopmentFit, freezeDevelopmentTruths,
  type DevelopmentFitInput, type DevelopmentTruth } from '../src/development-fit.js';
import { input as scoreInput, observation, hash } from '../../../packages/playbooks/test/scoring-fixtures.js';

export function developmentFitFixture(resolved = false): DevelopmentFitInput {
  const f = labelAssignmentFixture(), acquisition = f.input.acquisition, cohort = prepareAcquisition(acquisition);
  const dev = cohort.assignments!.filter(a => a.disposition === 'included' && a.calendarSplit !== 'locked_test');
  const registration = preregisterDevelopmentFit(acquisition);
  const truths: DevelopmentTruth[] = [], features: DevelopmentFitInput['features'] = [];
  dev.forEach((a, i) => {
    for (const sizeUsd of [100, 1000] as const) for (const accountClass of ['eoa', 'contract'] as const) {
      const s = scoreInput([observation('top10_float', i % 3 === 0 ? 80 : 20)]);
      s.coin = a.coin; s.mode = 'shadow'; s.historySource = null;
      const now = String(BigInt(a.launchSec) + 60n);
      s.cursor.timestampSec = now; s.cursor.blockNumber = String(100 + i);
      s.availabilityCut.cursor = s.cursor; s.profileHash = hash(901); s.calibrationManifestHash = cohort.manifestHash;
      for (const c of s.checks) {
        c.coverage.from = c.coverage.through = s.cursor;
      }
      for (const o of s.observations) for (const m of [o.primary, o.secondary, o.qualification]) if (m) {
        m.cursor = s.cursor; m.knownAt = s.availabilityCut; m.throughSec = now;
        m.coverage.from = m.coverage.through = s.cursor;
      }
      const deadline = String(BigInt(now) + 3600n);
      const gas = { executionQuote: { numerator: '0', denominator: '1' }, l1Quote: { numerator: '0', denominator: '1' }, usd: { numerator: '0', denominator: '1' } };
      truths.push({ coin: a.coin, sizeUsd, accountClass, venue: 'pons_curve', routeId: 'synthetic_curve', configHash: s.profileHash,
        benchmarkHash: referenceDigest({ coin: a.coin, sizeUsd, accountClass, fixture: true }), entryDelaySec: 60, exitHoldSec: 3600,
        actualDelaySec: '60', entryCursor: s.cursor, entryCut: s.availabilityCut, exitDeadlineSec: deadline,
        exitCursor: { ...s.cursor, timestampSec: deadline, blockNumber: String(200 + i), blockHash: hash(10000 + i) }, measurement: 'paper',
        entry: { status: 'purchased', quantity: '10', spentQuote: String(sizeUsd), gas, purchaseState: {}, persistentState: {}, evidenceIds: [hash(101)] },
        exit: { status: 'executed', grossQuote: String(sizeUsd), gas, evidenceIds: [hash(102)] },
        returnPct: { numerator: i % 3 === 0 ? '-50' : '0', denominator: '1' }, criticalRestriction: false, evidenceIds: [hash(103)] });
      features.push({ coin: a.coin, sizeUsd, accountClass, input: s });
    }
  });
  // No held-out case payload/labels enter the fitter. Pin synthetic truth artifacts
  // into development review cases before generating any signed fixture judgment.
  f.input.cases = f.input.cases.filter(c => dev.some(a => a.coin === c.coin)).map(c => {
    const cases = truths.filter(t => t.coin === c.coin);
    c.machineOutcome.benchmarkArtifactHashes = cases.map(t => t.benchmarkHash as `0x${string}`);
    c.evidenceIds = [...new Set([...c.evidenceIds, ...cases.flatMap(t => t.evidenceIds)])] as `0x${string}`[];
    const { id: _, revision: __, pins: ___, ...base } = c;
    const snapshot = { ...base, reveal: { points: null, level: null, legacyPoints: null, legacyLevel: null, allegedIncidentLabels: [] } };
    return { ...c, id: reviewCaseId(snapshot), pins: reviewPins(snapshot) };
  });
  const decisions = resolved ? dev.flatMap(a => {
    const i = f.input.cases.findIndex(c => c.coin === a.coin);
    return [independentFixture(f, 'reviewer_1', i, undefined, resolvedFixtureAnswers()),
      independentFixture(f, 'reviewer_2', i, undefined, resolvedFixtureAnswers())];
  }) : [];
  return { version: DEVELOPMENT_FIT_VERSION, acquisition, preregistration: registration,
    labels: { assignment: f.input, decisions, previous: [] }, truths, truthHash: freezeDevelopmentTruths(truths), features,
    fidelity: [], audits: [], factualFixtureEvidence: null };
}
