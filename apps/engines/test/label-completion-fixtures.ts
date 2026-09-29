// Synthetic signatures and answers only; never independent human judgments.
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { guardStorageHash as hash, reviewCaseId, reviewPins } from '@eko/db';
import { toUntrusted } from '@eko/untrusted';
import type { ReviewLabel, ReviewAdjudication } from '@eko/shared';
import { reviewFixture, labelFixture } from '../../../packages/db/test/fixtures/review.js';
import { acquisitionFixture } from './acquisition-run-fixtures.js';
import { prepareAcquisition } from '../src/acquisition-run.js';
import { LABEL_COMPLETION_VERSION, exportLabelAssignments, labelDecisionSigningBytes,
  type LabelAssignmentInput, type SignedDecision } from '../src/label-completion.js';

export function labelAssignmentFixture() {
  const acquisition = acquisitionFixture(), cohort = prepareAcquisition(acquisition);
  const keys = new Map<string, KeyObject>();
  const roles = Object.fromEntries((['reviewer_1', 'reviewer_2', 'adjudicator'] as const).map(role => {
    // Ephemeral fixture signing material exists in memory only, never in artifacts.
    const key = generateKeyPairSync('ed25519'), id = hash(`synthetic-${role}`);
    keys.set(id, key.privateKey);
    return [role, { id, publicKey: key.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'),
      chainLiterate: true, independentOfRuleAuthor: true, evidenceIds: [hash(`synthetic-role-attestation-${role}`)] }];
  })) as LabelAssignmentInput['roles'];
  const input: LabelAssignmentInput = { version: LABEL_COMPLETION_VERSION, acquisition, roles,
    frozenAt: '2026-10-24T00:00:00Z', labelVersion: '2.0.0', cases: acquisition.population!.frame.members.map(m => {
      const c = reviewFixture(`synthetic-label-case-${m.coin}`);
      c.coin = m.coin; c.cursor = m.knownAt.cursor; c.availability = acquisition.population!.frame.availabilityCut;
      c.sourceRevision = acquisition.population!.frame.sourceRevision; c.datasetHash = cohort.manifestHash;
      const { reveal: _, ...blinded } = c;
      return { ...blinded, id: reviewCaseId(c), revision: 1, pins: reviewPins(c) };
    }) };
  return { input, keys };
}
export type LabelFixture = ReturnType<typeof labelAssignmentFixture>;
export function signFixture(f: LabelFixture, record: ReviewLabel | ReviewAdjudication): SignedDecision {
  const payload = 'slot' in record
    ? { version: LABEL_COMPLETION_VERSION, origin: 'fixture' as const, assignmentHash: exportLabelAssignments(f.input).assignmentHash,
      kind: 'independent' as const, independent: true as const, record }
    : { version: LABEL_COMPLETION_VERSION, origin: 'fixture' as const, assignmentHash: exportLabelAssignments(f.input).assignmentHash,
      kind: 'adjudication' as const, record };
  const actor = 'slot' in record ? record.reviewerId : record.adjudicatorId;
  return { ...payload, signature: sign(null, labelDecisionSigningBytes(payload), f.keys.get(actor)!).toString('hex') };
}
export function independentFixture(f: LabelFixture, slot: 'reviewer_1' | 'reviewer_2', coinIndex = 0,
  previous?: ReviewLabel, answers?: ReviewLabel['answers']): SignedDecision & { kind: 'independent' } {
  const c = f.input.cases[coinIndex], base = labelFixture({ ...c, reveal: { points: null, level: null, legacyPoints: null, legacyLevel: null, allegedIncidentLabels: [] } });
  const identity = { ...base, answers: answers ?? base.answers, supersedes: previous?.id ?? null,
    caseRevisionId: c.id, reviewerId: f.input.roles[slot]!.id, slot };
  return signFixture(f, { ...identity, id: hash(identity), revision: (previous?.revision ?? 0) + 1,
    submittedAt: previous ? '2026-10-26T00:00:00Z' : '2026-10-25T00:00:00Z' }) as SignedDecision & { kind: 'independent' };
}
export function adjudicationFixture(f: LabelFixture, first: ReviewLabel, second: ReviewLabel,
  answers = first.answers, previous?: ReviewAdjudication): SignedDecision & { kind: 'adjudication' } {
  const identity = { supersedes: previous?.id ?? null, labelVersion: f.input.labelVersion, answers,
    evidenceIds: first.evidenceIds, rationale: toUntrusted('Synthetic adjudication evidence basis', 4000),
    caseRevisionId: first.caseRevisionId, adjudicatorId: f.input.roles.adjudicator!.id,
    labelIds: [first.id, second.id] as [`0x${string}`, `0x${string}`] };
  return signFixture(f, { ...identity, id: hash(identity), revision: (previous?.revision ?? 0) + 1,
    submittedAt: previous ? '2026-10-28T00:00:00Z' : '2026-10-27T00:00:00Z' }) as SignedDecision & { kind: 'adjudication' };
}
export const resolvedFixtureAnswers = (): ReviewLabel['answers'] => ({
  factsAndRoles: 'supported', coverage: 'complete', buyerHarm: 'not_observed', currentMechanism: 'none_observed',
  retrospectiveResponsibility: 'not_established', sellerControl: 'non_operator', sellerOrigin: 'original',
  withdrawalMigration: 'none_observed', outcomeMaturity: 'mature', reasonSupport: 'supported',
});
export function labelCompletionFixture() {
  const f = labelAssignmentFixture();
  // Intentionally empty: preparation must report all human judgments as missing.
  return { version: 'label-completion-fixture-059.1', assignment: f.input, decisions: [], previous: [] };
}
