import { z } from 'zod';
import { canonicalize } from '../canonical.js';
import { GuardAssessmentV2Schema } from './guard-v2.js';
import type { GuardAssessmentV2 } from './guard-v2.js';
import { Bytes32Schema, createReceiptEncoder } from './receipt-encoding.js';
import type { ReceiptHashing, ReceiptItem } from './receipt-encoding.js';
import { GuardVerdictRevisionInputSchema } from './guard-storage.js';
import type { GuardVerdictRevisionInput } from './guard-storage.js';

export const RECEIPT_BATCH_INTERVAL_SEC = 300;
export const TRACE_RETENTION_SEC = 2_592_000;
const { receipt: _receipt, ...decisionFields } = GuardAssessmentV2Schema.shape;
const a = GuardAssessmentV2Schema.shape;
export const GuardReceiptRevisionKeySchema = z.strictObject({
  schemaVersion: a.schemaVersion, canonicalization: z.literal('jcs-rfc8785/v1'), receiptVersion: z.literal('guard-receipt-2'),
  chainId: a.chainId, coin: a.coin, cursor: a.cursor, availability: a.availabilityCut, mode: a.mode,
  rulesVersion: a.rulesVersion, identityVersion: a.identityVersion, measurementVersion: a.measurementVersion, outcomeVersion: a.outcomeVersion,
  codeHash: a.codeHash, parametersHash: a.parametersHash, serviceRegistryHash: a.serviceRegistryHash,
  profileHash: a.profileHash, calibrationManifestHash: a.calibrationManifestHash, snapshotHash: a.snapshotHash,
  manifestId: Bytes32Schema, sourceRevision: Bytes32Schema, context: GuardVerdictRevisionInputSchema.shape.context,
});
/**
 * Schema-validate a revision identity binding assessment versions/cursor/availability/hashes to
 * manifest, source revision and context. Pure public operation without auth; invalid fields throw;
 * supplied evidence is not independently acquired here.
 * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../../docs/security/INVARIANTS.md | Receipt payload, proof and canonical anchor invariants}
 */
export function guardReceiptRevisionKey(a: Omit<GuardAssessmentV2, 'receipt'>, manifestId: string, sourceRevision: string, context: GuardVerdictRevisionInput['context']) {
  return GuardReceiptRevisionKeySchema.parse({ schemaVersion: a.schemaVersion, canonicalization: 'jcs-rfc8785/v1', receiptVersion: 'guard-receipt-2',
    chainId: a.chainId, coin: a.coin, cursor: a.cursor, availability: a.availabilityCut, mode: a.mode,
    rulesVersion: a.rulesVersion, identityVersion: a.identityVersion, measurementVersion: a.measurementVersion, outcomeVersion: a.outcomeVersion,
    codeHash: a.codeHash, parametersHash: a.parametersHash, serviceRegistryHash: a.serviceRegistryHash, profileHash: a.profileHash,
    calibrationManifestHash: a.calibrationManifestHash, manifestId, sourceRevision, context, snapshotHash: a.snapshotHash });
}
// Receipt identity is allocated before JCS. Proof/anchor metadata lives outside
// this immutable object; a new presentation or orphan event cannot rewrite it.
export const GuardReceiptPayloadSchema = z.strictObject({
  schemaVersion: z.literal('guard-receipt-2'), canonicalization: z.literal('jcs-rfc8785/v1'),
  receiptId: z.string().min(1), revisionId: Bytes32Schema, revisionKey: GuardReceiptRevisionKeySchema,
  kind: z.literal('verdict'), recordedAt: z.iso.datetime(), deterministicInput: z.json(),
  decision: z.strictObject(decisionFields),
});
export type GuardReceiptPayload = z.infer<typeof GuardReceiptPayloadSchema>;

/** Decision identity includes the raw snapshot and every assignment/reason, but
 * excludes storage time, supersession and recursive hash/proof metadata.
 * @remarks
 * Project the decision identity by removing recursive receipt/hash/root/supersession metadata
 * while retaining snapshot/assignment/reason data. Pure typed-input operation without auth or I/O;
 * it does not validate the assessment.
 * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../../docs/security/INVARIANTS.md | Receipt payload, proof and canonical anchor invariants}
 */
export function guardDecisionBody(a: Omit<GuardAssessmentV2, 'receipt'> | GuardAssessmentV2) {
  const { decisionHash: _, evidenceRoot: _root, supersedes: _supersedes, ...rest } = a;
  const { receipt: _ref, ...body } = rest as typeof rest & { receipt?: unknown };
  return body;
}
/**
 * Create pure canonical payload hashing, Guard envelope binding checks and Merkle proof
 * verification using trusted supplied primitives. Public operation without auth; no RPC or signing
 * authority. Legacy payloads receive hash checks without a full legacy schema; returned functions
 * have their own failure contracts.
 * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../../docs/security/INVARIANTS.md | Receipt payload, proof and canonical anchor invariants}
 */
export function createGuardReceiptCodec(hashing: ReceiptHashing) {
  const encoder = createReceiptEncoder(hashing);
  /**
   * Hash canonicalized data with the supplied keccak/string conversion primitives. Pure public
   * operation without auth; noncanonicalizable input or primitive failure throws.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Receipt payload, proof and canonical anchor invariants}
   */
  const hash = (value: unknown) => hashing.keccak256(hashing.stringToHex(canonicalize(value)));
  /**
   * Require the payload hash and, for Guard v2, schema, revision key, decision and deterministic
   * snapshot bindings to agree with the receipt item. Pure public verification without auth; caught
   * schema/hash failures return false. Legacy payloads check only hash equality here, with
   * additional validation owned by consumers.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Receipt payload, proof and canonical anchor invariants}
   */
  function verifyPayload(payload: unknown, item: ReceiptItem): boolean {
    try {
      if (hash(payload) !== item.hash) return false;
      if (typeof payload === 'object' && payload !== null && 'schemaVersion' in payload
        && payload.schemaVersion === 'guard-receipt-2') {
        const p = GuardReceiptPayloadSchema.parse(payload);
        GuardAssessmentV2Schema.parse({ ...p.decision, receipt: { status: 'recorded', id: p.receiptId, payloadHash: item.hash } });
        return p.receiptId === item.id && p.kind === item.kind && p.revisionId === hash(p.revisionKey)
          && canonicalize(p.revisionKey) === canonicalize(guardReceiptRevisionKey(p.decision, p.revisionKey.manifestId, p.revisionKey.sourceRevision, p.revisionKey.context))
          && p.decision.snapshotHash === hash(p.deterministicInput)
          && p.decision.decisionHash === hash(guardDecisionBody(p.decision));
      }
      // V1 payloads retain their original canonical bytes and schema/levels.
      return true;
    } catch { return false; }
  }
  return { ...encoder, hash, verifyPayload,
    /**
     * Require payload binding plus receipt Merkle proof agreement. Pure public verification without
     * auth; malformed proof schemas return false through the encoder, and uncaught hashing/type
     * failures may throw. No registry transaction/canonical block is checked here.
     * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
     * @see {@link ../../../../docs/security/INVARIANTS.md | Receipt payload, proof and canonical anchor invariants}
     */
    verifyPublicProof(payload: unknown, item: ReceiptItem, proof: readonly `0x${string}`[], root: `0x${string}`) {
      return verifyPayload(payload, item) && encoder.verifyReceiptProof(item, proof, root);
    } };
}
