import { referenceDigest } from '@eko/chain';
import { evaluateLockedFixtures } from '../src/locked-test.js';
import { type LiveShadowInput } from '../src/live-shadow.js';
import { lockedTestFixture } from './locked-test-fixtures.js';
import { address, hash, input, observation, NOW } from '../../../packages/playbooks/test/scoring-fixtures.js';

const locked = evaluateLockedFixtures(lockedTestFixture(), hash(61));
export function liveShadowFixture(frozen = false): LiveShadowInput {
  return { definition: { version: 'live-shadow-062.1', origin: 'fixture', startSec: NOW - 60,
    sourceRevision: hash(62), datasetHash: locked.pins.datasetHash, labelSetHash: locked.pins.labelSetHash,
    configHashes: [hash(63)], freeze: frozen ? lockedTestFixture(true).freeze : null,
    lockedEvaluation: { origin: 'fixture', reportHash: locked.reportHash, acceptedCandidate: null,
      gateTable: locked.gateTable.map(g => ({ gate: g.gate, acceptancePass: false, numericalPass: g.numericalPass })) },
    entryDelaySec: 60, requiredHorizonsSec: [300, 3600, 86400], confirmationSec: 10,
    budget: { capNanoUsd: '0', pricingEvidence: null } }, ticks: [] };
}
export function shadowTick(from: number, through: number): LiveShadowInput['ticks'][number] {
  return { throughSec: through, coverage: [{ fromSec: from, throughSec: through, sourceHash: hash(64) }],
    launches: [], snapshots: [], followup: [], gateChecks: [], requests: 0, requestUnits: 0, paidNanoUsd: '0' };
}
export function fixtureSnapshot(f: LiveShadowInput): LiveShadowInput['ticks'][number]['snapshots'][number] {
  const s = input([observation('execution_cost', 60)]);
  s.codeHash = f.definition.freeze!.candidateRevision; s.calibrationManifestHash = f.definition.freeze!.calibrationHash;
  return { coin: s.coin, input: s, legacyVerdict: { coin: s.coin, level: 'clear', reasons: [], playbooks: [],
    receipt: { id: 'fixture-legacy', hash: hash(65), status: 'pending' },
    schemaVersion: 'verdict-1', asOfBlock: NOW }, legacySignal: { readings: { momentum: 50, liquidity: 50, holders: 50, narrative: 50, risk: 100 },
    weights: { momentum: .3, liquidity: .25, holders: .2, narrative: .15, risk: .1 }, composite: 55, beta: true, asOfBlock: NOW },
    legacyPolicyDenials: { safe: false, balanced: false, degen: false }, venue: 'pons', ageSec: 60,
    latency: { scanMs: 10, enrichmentMs: null, probeMs: 20, attributionMs: null, alertMs: 5,
      criticalCompletionMs: null, lowerCompletionMs: null, preflightMs: 2 },
    source: { sourceId: 'fixture_capture', complete: false, gaps: ['funding_missing'] }, serviceBotErrors: ['service_unresolved'] };
}
export function workloadFixture(count = 5000, duration = 604800) {
  const f = liveShadowFixture(true), start = f.definition.startSec, end = start + duration;
  const t = shadowTick(start, end);
  t.launches = Array.from({ length: count }, (_, i) => ({ coin: address(i + 1), launchSec: end - 1 }));
  f.ticks.push(t); return f;
}
export function followupTick(f: LiveShadowInput, extraSec = 0) {
  const last = f.ticks.at(-1)!.throughSec, due = last - 1 + 60 + 86400 + 10 + extraSec;
  const t = shadowTick(last, due);
  t.followup = f.ticks.flatMap(t => t.launches).flatMap(l => f.definition.requiredHorizonsSec.map(horizonSec => ({
    coin: l.coin, horizonSec, coveredThroughSec: due, confirmedThroughSec: due, outcome: 'known' as const, evidenceHash: hash(68) })));
  return t;
}
export function resealFreeze(f: LiveShadowInput) {
  const { freezeHash: _, ...body } = f.definition.freeze!;
  f.definition.freeze!.freezeHash = referenceDigest(body);
}
