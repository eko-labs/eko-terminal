import { z } from 'zod';
import { AddressSchema, UntrustedSchema } from './common.js';
import { Bytes32Schema } from './receipt-encoding.js';
import { AvailabilityCutSchema, GuardCursorSchema, GuardLevelV2Schema } from './guard-v2.js';
import { RationalSchema } from './guard-v2.js';

export const GUARD_REVIEW_VERSION = 'guard-review-055.1' as const;
export const GUARD_REVIEW_WRITER = 'evals' as const;
const uint = z.string().regex(/^(0|[1-9]\d*)$/);
// Opaque pseudonyms, never natural-person names, account handles or session IDs.
export const ReviewPseudonymSchema = Bytes32Schema;
export const ReviewTextSchema = UntrustedSchema.strict().extend({ text: z.string().max(4000), flags: UntrustedSchema.shape.flags.max(3) });
export const ReviewRoleSchema = z.enum(['reviewer_1', 'reviewer_2', 'adjudicator', 'evaluator']);
export const ReviewQuestionsSchema = z.strictObject({
  factsAndRoles: z.enum(['supported', 'contradicted', 'unresolved']),
  coverage: z.enum(['complete', 'incomplete', 'unresolved']),
  buyerHarm: z.enum(['observed', 'not_observed', 'unresolved']),
  currentMechanism: z.enum(['restriction', 'cost', 'selling', 'withdrawal', 'collapse', 'none_observed', 'unresolved']),
  retrospectiveResponsibility: z.enum(['operator', 'non_operator', 'not_established', 'unresolved']),
  sellerControl: z.enum(['operator', 'non_operator', 'unresolved']),
  sellerOrigin: z.enum(['original', 'descendant', 'mixed', 'unresolved']),
  withdrawalMigration: z.enum(['harmful_withdrawal', 'benign_migration', 'none_observed', 'unresolved']),
  outcomeMaturity: z.enum(['mature', 'immature', 'censored', 'unresolved']),
  reasonSupport: z.enum(['supported', 'contradicted', 'unresolved']),
});
// TODO(spec): §9.3 specifies questions/blinding, but no review wire contract or
// assignment provisioning. Closed fact panels and session-bound evals assignments
// freeze this candidate; reviewer/adjudicator allocation remains an external duty.
export const ReviewPanelSchema = z.strictObject({
  kind: z.enum(['role', 'holding', 'funding', 'transfer', 'sale', 'exit', 'control', 'coverage', 'intervention', 'real_buyer', 'recovery', 'identity_provenance']),
  status: z.enum(['supported', 'unknown', 'replay_invalid']), evidenceIds: z.array(Bytes32Schema).max(256),
  facts: z.array(z.strictObject({
    field: z.enum(['account', 'payer', 'recipient', 'principal', 'seller', 'collector', 'held_raw', 'original_raw', 'descendant_raw', 'sold_raw', 'quote_raw', 'size_usd', 'exit_quote_raw', 'net_return_pct', 'covered_units', 'excluded_units', 'effective_control', 'independent_audience', 'recycled_quote_raw', 'recovered', 'timestamp_sec']),
    value: z.union([uint, AddressSchema, RationalSchema, z.boolean()]).nullable(),
  })).max(256), text: ReviewTextSchema.nullable(),
});
export const ReviewIdentitySchema = z.strictObject({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  roles: z.array(z.strictObject({ role: z.enum(['factory_deployer', 'outer_signer', 'launch_principal', 'creation_payer', 'seller', 'remover']),
    address: AddressSchema.nullable(), status: z.enum(['verified', 'unknown']), evidenceIds: z.array(Bytes32Schema).max(256),
  })).max(64),
});
export const ReviewMachineOutcomeSchema = z.strictObject({
  version: z.string().regex(/^\d+\.\d+\.\d+$/), recordIds: z.array(Bytes32Schema).max(256), benchmarkArtifactHashes: z.array(Bytes32Schema).max(256),
  status: z.enum(['provisional', 'confirmed_under_policy', 'indeterminate', 'censored']),
  buyerHarm: z.boolean().nullable(), exitStatus: z.enum(['executed', 'token_failure', 'censored', 'unsupported', 'indeterminate']),
});
export const ReviewCaseInputSchema = z.strictObject({
  version: z.literal(GUARD_REVIEW_VERSION), caseId: Bytes32Schema, supersedes: Bytes32Schema.nullable(),
  origin: z.enum(['fixture', 'measured']), coin: AddressSchema, cursor: GuardCursorSchema, availability: AvailabilityCutSchema,
  sourceRevision: Bytes32Schema, candidateRevision: z.string().regex(/^[0-9a-f]{40}$/), ruleAuthorId: ReviewPseudonymSchema,
  context: z.strictObject({ routeId: z.string().regex(/^[a-z0-9_.:-]{1,192}$/), sizeUsd: uint, accountClass: z.enum(['eoa', 'contract']) }),
  datasetHash: Bytes32Schema,
  method: z.strictObject({ version: z.string().regex(/^\d+\.\d+\.\d+$/), configHash: Bytes32Schema, replayMode: z.enum(['production', 'retrospective']), benchmarkMethod: z.enum(['paper', 'persistent', 'unsupported']) }),
  identity: ReviewIdentitySchema, machineOutcome: ReviewMachineOutcomeSchema,
  evidenceIds: z.array(Bytes32Schema).min(1).max(256), panels: z.array(ReviewPanelSchema).max(32),
  reveal: z.strictObject({ points: z.number().int().min(0).max(100).nullable(), level: GuardLevelV2Schema.nullable(),
    legacyPoints: z.number().int().nonnegative().nullable(), legacyLevel: z.enum(['clear', 'monitor', 'danger', 'pending']).nullable(),
    allegedIncidentLabels: z.array(ReviewTextSchema).max(32) }),
});
export const ReviewPinsSchema = z.strictObject({ cursorHash: Bytes32Schema, availabilityHash: Bytes32Schema, identityHash: Bytes32Schema,
  outcomeHash: Bytes32Schema, methodHash: Bytes32Schema, datasetHash: Bytes32Schema, evidenceHash: Bytes32Schema });
export const ReviewCaseSchema = ReviewCaseInputSchema.extend({ id: Bytes32Schema, revision: z.number().int().positive(), pins: ReviewPinsSchema });
export const ReviewLabelInputSchema = z.strictObject({ supersedes: Bytes32Schema.nullable(), labelVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  answers: ReviewQuestionsSchema, evidenceIds: z.array(Bytes32Schema).min(1).max(256), rationale: ReviewTextSchema });
export const ReviewLabelSchema = ReviewLabelInputSchema.extend({ id: Bytes32Schema, caseRevisionId: Bytes32Schema,
  reviewerId: ReviewPseudonymSchema, slot: z.enum(['reviewer_1', 'reviewer_2']), revision: z.number().int().positive(), submittedAt: z.iso.datetime() });
export const ReviewAdjudicationInputSchema = ReviewLabelInputSchema.extend({ labelIds: z.tuple([Bytes32Schema, Bytes32Schema]) });
export const ReviewAdjudicationSchema = ReviewAdjudicationInputSchema.extend({ id: Bytes32Schema, caseRevisionId: Bytes32Schema,
  adjudicatorId: ReviewPseudonymSchema, revision: z.number().int().positive(), submittedAt: z.iso.datetime() });
export const ReviewStatusSchema = z.enum(['pending', 'unresolved', 'disputed', 'agreed', 'adjudicated']);
// Export uses the identical per-role projection as GET, including blinded history.
export const ReviewViewSchema = z.strictObject({ version: z.literal(GUARD_REVIEW_VERSION), blinded: z.boolean(),
  case: ReviewCaseSchema.omit({ reveal: true }), reveal: ReviewCaseInputSchema.shape.reveal.nullable(),
  labels: z.array(ReviewLabelSchema), adjudications: z.array(ReviewAdjudicationSchema), status: ReviewStatusSchema.nullable(),
}).superRefine((v, ctx) => {
  if (v.blinded ? v.reveal !== null || v.labels.length !== 0 || v.adjudications.length !== 0 || v.status !== null : v.reveal === null || v.status === null)
    ctx.addIssue({ code: 'custom', message: 'Review visibility contract mismatch' });
});
export const ReviewExportSchema = z.strictObject({ version: z.literal(GUARD_REVIEW_VERSION), caseId: Bytes32Schema,
  revisions: z.array(ReviewViewSchema), exportHash: Bytes32Schema });
export type ReviewCaseInput = z.infer<typeof ReviewCaseInputSchema>;
export type ReviewCase = z.infer<typeof ReviewCaseSchema>;
export type ReviewLabelInput = z.infer<typeof ReviewLabelInputSchema>;
export type ReviewLabel = z.infer<typeof ReviewLabelSchema>;
export type ReviewAdjudicationInput = z.infer<typeof ReviewAdjudicationInputSchema>;
export type ReviewAdjudication = z.infer<typeof ReviewAdjudicationSchema>;
export type ReviewRole = z.infer<typeof ReviewRoleSchema>;
export type ReviewView = z.infer<typeof ReviewViewSchema>;
