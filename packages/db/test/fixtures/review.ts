// Synthetic review workflow only; these are not independent human judgments.
import { GUARD_REVIEW_VERSION, type ReviewCaseInput, type ReviewLabelInput } from '@eko/shared';
import { toUntrusted } from '@eko/untrusted';
import { guardStorageHash as hash } from '../../src/guard-store.js';
export { hash };
export const reviewerAccounts = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000004'];
export function reviewFixture(key = 'synthetic-review'): ReviewCaseInput {
  const cursor = { chainId: 4663, blockNumber: '100', blockHash: hash('synthetic-block'), timestampSec: '1000', transactionIndex: null, executionOrdinal: null, boundary: 'block_end' as const };
  const evidenceId = hash('synthetic-evidence');
  return { version: GUARD_REVIEW_VERSION, caseId: hash(key), supersedes: null, origin: 'fixture', coin: `0x${'ab'.repeat(20)}`, cursor,
    availability: { cursor, acquisitionSequence: '1' }, sourceRevision: hash('synthetic-source'), candidateRevision: 'a'.repeat(40), ruleAuthorId: hash('synthetic-rule-author'),
    context: { routeId: 'synthetic-pons', sizeUsd: '100', accountClass: 'eoa' }, datasetHash: hash('synthetic-dataset'),
    method: { version: '2.0.0', configHash: hash('synthetic-config'), replayMode: 'retrospective', benchmarkMethod: 'paper' },
    identity: { version: '2.0.0', roles: [{ role: 'launch_principal', address: null, status: 'unknown', evidenceIds: [] }] },
    machineOutcome: { version: '2.0.0', recordIds: [hash('synthetic-outcome')], benchmarkArtifactHashes: [hash('synthetic-benchmark')], status: 'indeterminate', buyerHarm: null, exitStatus: 'unsupported' },
    evidenceIds: [evidenceId], panels: [{ kind: 'exit', status: 'unknown', evidenceIds: [evidenceId], facts: [{ field: 'size_usd', value: '100' }], text: toUntrusted('Unmeasured exit fixture', 4000) }],
    reveal: { points: 70, level: 'high', legacyPoints: 90, legacyLevel: 'danger', allegedIncidentLabels: [toUntrusted('Synthetic allegation fixture', 4000)] },
  };
}
export function labelFixture(c: ReviewCaseInput): ReviewLabelInput {
  return { supersedes: null, labelVersion: '2.0.0', evidenceIds: c.evidenceIds, rationale: toUntrusted('Synthetic unresolved judgment', 4000), answers: {
    retrospectiveResponsibility: 'unresolved', factsAndRoles: 'unresolved', coverage: 'incomplete', buyerHarm: 'unresolved', currentMechanism: 'unresolved', sellerControl: 'unresolved', sellerOrigin: 'unresolved',
    withdrawalMigration: 'unresolved', outcomeMaturity: 'unresolved', reasonSupport: 'unresolved',
  } };
}
