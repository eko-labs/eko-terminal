// Synthetic release inventory and later data only; no measured acceptance.
import { referenceDigest } from '@eko/chain';
import { GUARD_CHECK_IDS } from '@eko/shared';
import { GUARD_GATE_IDS } from '@eko/playbooks';
import { guardFixture } from '../../../packages/policy/test/guard-fixtures.js';
import { hash, address } from '../../../packages/chain/test/reference-fixtures.js';
import { GuardReleaseManifestSchema, GUARD_CUTOVER_VERSION, GUARD_RELEASE_CONSUMERS, GUARD_RELEASE_VENUES } from '../src/guard-cutover.js';
import { MONTHLY_EVALUATION_VERSION, MONTHLY_META_CASES, calendarMonth, type MonthlyInput } from '../src/monthly-evaluation.js';
import { lockedTestFixture } from './locked-test-fixtures.js';

export function monthlyFixture(withGate = false): MonthlyInput {
  const e = lockedTestFixture(true), a = guardFixture(), window = calendarMonth('2026-10');
  const freeze = e.freeze!;
  const manifest = GuardReleaseManifestSchema.parse({ version: GUARD_CUTOVER_VERSION, kind: 'guard', origin: 'measured', status: 'accepted', chainId: 4663,
    pins: { sourceRevision: freeze.candidateRevision, codeHash: freeze.candidateRevision, parametersHash: freeze.parametersHash,
      serviceRegistryHash: e.features[0].input.serviceRegistryHash, profileHash: e.features[0].input.profileHash, calibrationManifestHash: freeze.calibrationHash,
      datasetHash: hash('previous-month-data'), labelSetHash: hash('previous-month-labels'),
      rulesVersion: a.rulesVersion, identityVersion: a.identityVersion, measurementVersion: a.measurementVersion, outcomeVersion: a.outcomeVersion },
    acceptanceHash: hash('synthetic-acceptance'), lockedTestHash: hash('synthetic-test'), liveShadowHash: hash('synthetic-shadow'),
    compatibility: { legacyReadProofHash: hash('synthetic-proof'), policyReplayHash: hash('synthetic-replay'),
      consumers: GUARD_RELEASE_CONSUMERS.map(consumer => ({ consumer, artifactHash: hash('synthetic-consumer') })) },
    attributionMethod: 'qualified_control_v2', lowerEnabled: true, historyEnabled: false, bucketsEnabled: false,
    factors: freeze.parameters!.enabled, decisive: ['sell_block'], checks: [...GUARD_CHECK_IDS],
    gates: GUARD_GATE_IDS.map(id => ({ id, passed: true, artifactHash: hash(`synthetic-gate-${id}`) })),
    coverage: GUARD_RELEASE_VENUES.flatMap(venue => ([100, 1000] as const).flatMap(sizeUsd =>
      (['eoa', 'smart_account'] as const).map(accountClass => ({ venue, sizeUsd, accountClass,
        status: 'supported', checks: [...GUARD_CHECK_IDS], gaps: [], profileHash: a.profileHash, evidenceHash: hash('synthetic-coverage') })))),
    live: { coveredDurationSec: 604800, launches: 5000, pendingEntrants: 0, requiredFollowupComplete: true,
      pilotTargetsAccepted: true, budgetAccepted: true } });
  const throughSec = window.untilSec + 60 + 604800 + 30;
  const frame = structuredClone(e.acquisition.population!.frame);
  frame.fromSec = String(window.fromSec); frame.untilSec = String(window.untilSec);
  frame.availabilityCut.cursor.timestampSec = String(throughSec);
  e.features.forEach(f => { f.input.codeHash = freeze.candidateRevision; });
  const input: MonthlyInput = { definition: { version: MONTHLY_EVALUATION_VERSION, origin: 'fixture', month: window.month,
    sourceRevision: hash('monthly-source'), manifest, inventory: { revoked: [], authorizations: [],
      accepted: [{ manifestHash: referenceDigest(manifest), acceptanceHash: manifest.acceptanceHash,
        candidateRevision: manifest.pins.sourceRevision, released: true }] },
    requiredHorizonsSec: [3600, 86400, 604800], entryDelaySec: 60, confirmationSec: 30, frame,
    challenges: [{ coin: address(9999), kind: 'negative_control', metaCases: [...MONTHLY_META_CASES], receiptHashes: [hash('synthetic-negative-control')] }],
    sources: [{ id: 'launches', sourceRevision: frame.sourceRevision, artifactHash: referenceDigest(frame), status: 'captured', gaps: [] }], changes: [] }, ticks: [] };
  if (withGate) input.ticks.push({ throughSec, followup: [...frame.members.map(m => m.coin), address(9999)].flatMap(coin =>
    input.definition.requiredHorizonsSec.map(horizonSec => ({ coin, horizonSec, coveredThroughSec: throughSec,
      confirmedThroughSec: throughSec, receiptHash: hash(`synthetic-followup-${coin}-${horizonSec}`) }))),
    coverageFailures: [{ check: 'operator_history', slice: 'pons_curve:100:eoa', reason: 'history_source_missing', receiptHashes: [hash('synthetic-history-gap')] }],
    challengeReviews: [], evaluation: e });
  return input;
}
