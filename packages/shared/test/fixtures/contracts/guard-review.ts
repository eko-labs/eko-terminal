// Synthetic schema examples only, not human review or measured validation.
import { GUARD_REVIEW_VERSION } from '../../../src/contracts/guard-review.js';
import { address, hash, cursor, availability } from './guard-v2.js';
const text = { text: 'Synthetic unresolved review', truncated: false, flags: [] };
const questions = { factsAndRoles: 'unresolved', coverage: 'incomplete', buyerHarm: 'unresolved', currentMechanism: 'unresolved',
  retrospectiveResponsibility: 'unresolved', sellerControl: 'unresolved', sellerOrigin: 'unresolved', withdrawalMigration: 'unresolved', outcomeMaturity: 'unresolved', reasonSupport: 'unresolved' };
const panel = { kind: 'holding', status: 'unknown', evidenceIds: [hash], facts: [{ field: 'held_raw', value: null }], text };
const identity = { version: '2.0.0', roles: [{ role: 'launch_principal', address: null, status: 'unknown', evidenceIds: [] }] };
const outcome = { version: '2.0.0', recordIds: [], benchmarkArtifactHashes: [], status: 'indeterminate', buyerHarm: null, exitStatus: 'unsupported' };
const input = { version: GUARD_REVIEW_VERSION, caseId: hash, supersedes: null, origin: 'fixture', coin: address, cursor, availability,
  sourceRevision: hash, candidateRevision: 'a'.repeat(40), ruleAuthorId: hash, context: { routeId: 'fixture-route', sizeUsd: '100', accountClass: 'eoa' }, datasetHash: hash,
  method: { version: '2.0.0', configHash: hash, replayMode: 'retrospective', benchmarkMethod: 'unsupported' }, identity, machineOutcome: outcome, evidenceIds: [hash], panels: [panel],
  reveal: { points: null, level: null, legacyPoints: null, legacyLevel: null, allegedIncidentLabels: [text] } };
const pins = { cursorHash: hash, availabilityHash: hash, identityHash: hash, outcomeHash: hash, methodHash: hash, datasetHash: hash, evidenceHash: hash };
const snapshot = { ...input, id: hash, revision: 1, pins };
const labelInput = { supersedes: null, labelVersion: '2.0.0', answers: questions, evidenceIds: [hash], rationale: text };
const label = { ...labelInput, id: hash, caseRevisionId: hash, reviewerId: hash, slot: 'reviewer_1', revision: 1, submittedAt: '2026-10-03T00:00:00.000Z' };
const adjudicationInput = { ...labelInput, labelIds: [hash, hash] };
const adjudication = { ...adjudicationInput, id: hash, caseRevisionId: hash, adjudicatorId: hash, revision: 1, submittedAt: label.submittedAt };
const { reveal: _, ...blindedCase } = snapshot;
const view = { version: GUARD_REVIEW_VERSION, blinded: true, case: blindedCase, reveal: null, labels: [], adjudications: [], status: null };
export const reviewSamples = { ReviewPseudonym: hash, ReviewText: text, ReviewRole: 'reviewer_1', ReviewQuestions: questions, ReviewPanel: panel,
  ReviewIdentity: identity, ReviewMachineOutcome: outcome, ReviewCaseInput: input, ReviewPins: pins, ReviewCase: snapshot,
  ReviewLabelInput: labelInput, ReviewLabel: label, ReviewAdjudicationInput: adjudicationInput, ReviewAdjudication: adjudication,
  ReviewStatus: 'unresolved', ReviewView: view, ReviewExport: { version: GUARD_REVIEW_VERSION, caseId: hash, revisions: [view], exportHash: hash } };
