import { z } from 'zod';
import { AddressSchema } from './common.js';
import { Bytes32Schema } from './receipt-encoding.js';
import { AvailabilityCutSchema, GuardCursorSchema, GuardCoverageSchema, EvidenceRefV2Schema, GuardAssessmentV2Schema } from './guard-v2.js';
import type { AvailabilityCut, GuardCursor } from './guard-v2.js';

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,191}$/);
const time = z.iso.datetime();
export const GUARD_STORAGE_VERSION = 'guard-storage-2.0.0' as const;
export const GUARD_STORAGE_WRITERS = Object.freeze({
  guard_availability: 'indexer', guard_chain_evidence: 'indexer', guard_roles: 'indexer', guard_source_coverage: 'indexer', guard_source_events: 'indexer',
  guard_measurement_evidence: 'normalizer', guard_check_coverage: 'normalizer', guard_measurement_events: 'normalizer',
  guard_receipt_payloads: 'receipts', guard_receipt_anchors: 'receipts', guard_receipt_anchor_events: 'receipts',
  guard_verdict_revisions: 'playbooks', guard_verdict_runs: 'playbooks', guard_verdict_events: 'playbooks',
} as const);
// TODO(spec): §7.2 names event namespaces/owners, but not exact event IDs or
// persistence envelopes. These additive IDs and closed records freeze the 027 candidate.
export const GUARD_BUS_TOPICS = ['guard.evidence.created', 'guard.coverage.created', 'guard.role.created', 'guard.verdict.created', 'guard.revision.invalidated'] as const;
export const GuardBusTopicSchema = z.enum(GUARD_BUS_TOPICS);
export const GuardBusEventSchema = z.strictObject({ topic: GuardBusTopicSchema, ids: z.strictObject({ id: Bytes32Schema }) });
export const GuardAvailabilityManifestSchema = z.strictObject({
  id: Bytes32Schema, sourceId: id, sourceRevision: Bytes32Schema, replayMode: z.enum(['production', 'retrospective']),
  cut: AvailabilityCutSchema, watermark: GuardCursorSchema, acquiredAt: time,
});
const source = {
  chainId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), coin: AddressSchema,
  manifestId: Bytes32Schema, sourceItemId: id, sourceRevision: Bytes32Schema,
  cursor: GuardCursorSchema, knownAt: AvailabilityCutSchema, acquiredAt: time,
  methodVersion: z.string().regex(/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/), dependencyIds: z.array(Bytes32Schema),
};
export const GuardStoredEvidenceSchema = z.strictObject({ ...source, evidence: EvidenceRefV2Schema });
export const GuardStoredCoverageSchema = z.strictObject({ ...source, coverage: GuardCoverageSchema });
export const GuardStoredRoleSchema = z.strictObject({ ...source, role: z.enum(['factory_deployer', 'outer_signer', 'launch_principal', 'creation_payer', 'buy_payer', 'buy_recipient', 'sell_source', 'proceeds_recipient', 'fee_recipient', 'treasury', 'custodian', 'locker', 'exempt']), address: AddressSchema.nullable(), status: z.enum(['verified', 'missing', 'unsupported', 'not_applicable']), evidenceIds: z.array(Bytes32Schema), payloadHash: Bytes32Schema, objectRef: Bytes32Schema });
export const GuardVerdictRevisionInputSchema = z.strictObject({
  assessment: GuardAssessmentV2Schema, deterministicInput: z.json(), manifestId: Bytes32Schema, sourceRevision: Bytes32Schema,
  context: z.strictObject({ routeId: id.nullable(), sizeUsd: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/).nullable(), accountClass: z.enum(['eoa', 'smart_account']).nullable() }),
  dependencyIds: z.array(Bytes32Schema), recordedAt: time, runId: id,
});
export const GuardRevisionEventSchema = z.strictObject({
  kind: z.enum(['superseded', 'orphaned', 'dependency_invalidated']), targetId: Bytes32Schema, replacementId: Bytes32Schema.nullable(),
  causeId: Bytes32Schema, knownAt: AvailabilityCutSchema, recordedAt: time,
});
export const GuardReorgSchema = z.strictObject({ chainId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), fromBlock: z.string().regex(/^(0|[1-9]\d*)$/), causeId: Bytes32Schema, knownAt: AvailabilityCutSchema, recordedAt: time });
export type GuardAvailabilityManifest = z.infer<typeof GuardAvailabilityManifestSchema>;
export type GuardStoredEvidence = z.infer<typeof GuardStoredEvidenceSchema>;
export type GuardStoredCoverage = z.infer<typeof GuardStoredCoverageSchema>;
export type GuardStoredRole = z.infer<typeof GuardStoredRoleSchema>;
export type GuardVerdictRevisionInput = z.infer<typeof GuardVerdictRevisionInputSchema>;
export type GuardRevisionEvent = z.infer<typeof GuardRevisionEventSchema>;
export type GuardReorg = z.infer<typeof GuardReorgSchema>;
export type GuardBusEvent = z.infer<typeof GuardBusEventSchema>;

/** Compare executable boundaries, never timestamps or lexical trace paths. */
export function guardCursorPosition(input: GuardCursor): readonly string[] {
  const c = GuardCursorSchema.parse(input);
  return [c.blockNumber, c.transactionIndex === null ? '9007199254740992' : String(c.transactionIndex), c.executionOrdinal === null ? '9007199254740992' : String(c.executionOrdinal), c.boundary === 'before_tx' ? '0' : c.boundary === 'after_tx' ? '1' : '2'];
}
export function compareGuardCursors(a: GuardCursor, b: GuardCursor): number {
  if (a.chainId !== b.chainId) throw new Error('Guard cursor chain mismatch');
  if (a.blockNumber === b.blockNumber && a.blockHash.toLowerCase() !== b.blockHash.toLowerCase()) throw new Error('Guard cursor fork mismatch');
  const left = guardCursorPosition(a), right = guardCursorPosition(b);
  for (let i = 0; i < left.length; i++) { const x = BigInt(left[i]), y = BigInt(right[i]); if (x !== y) return x < y ? -1 : 1; }
  return 0;
}
export function guardKnownBy(knownAt: AvailabilityCut, cut: AvailabilityCut): boolean {
  return compareGuardCursors(knownAt.cursor, cut.cursor) <= 0 && BigInt(knownAt.acquisitionSequence) <= BigInt(cut.acquisitionSequence);
}
