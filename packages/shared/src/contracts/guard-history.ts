import { z } from 'zod';
import { AddressSchema } from './common.js';
import { Bytes32Schema } from './receipt-encoding.js';
import { AvailabilityCutSchema, GuardCursorSchema, GuardCoverageSchema, GuardFactorSchema, HistoryCoverageSchema,
  OutcomeV2Schema, GuardAssessmentCheckSchema, GuardReasonV2Schema } from './guard-v2.js';

const version = z.string().regex(/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/);
const bps = z.number().int().min(0).max(10000).nullable();
const evidenceIds = z.array(Bytes32Schema).min(1);
// TODO(spec): §§4.1/5.2 specify semantics, not normalized history wire names. These candidate
// envelopes carry captured authority/loop proof and complete launch assessments; no legacy-label adapter.
export const GuardHistoryAttributionSchema = z.strictObject({
  operatorGroupId: Bytes32Schema, principal: AddressSchema, actor: AddressSchema,
  kind: z.enum(['authenticated_principal', 'authenticated_control', 'reviewed_closed_loop', 'origin', 'coordination', 'service', 'outsider', 'unresolved']),
  effectiveFrom: GuardCursorSchema, effectiveThrough: GuardCursorSchema.nullable(), knownAt: AvailabilityCutSchema,
  evidenceIds, loop: z.strictObject({
    funder: AddressSchema, collector: AddressSchema,
    fundedAt: GuardCursorSchema, boughtAt: GuardCursorSchema, soldAt: GuardCursorSchema, collectedAt: GuardCursorSchema,
    fundingBps: bps, collectionBps: bps, nonServiceHops: z.number().int().min(0).max(3),
    reviewed: z.boolean(), serviceFree: z.boolean(), fundingCoverage: GuardCoverageSchema, collectionCoverage: GuardCoverageSchema,
  }).nullable(),
});
export type GuardHistoryAttribution = z.infer<typeof GuardHistoryAttributionSchema>;
export const GuardHistorySourceSchema = z.strictObject({
  operator: z.strictObject({
    group: HistoryCoverageSchema.shape.operatorGroup.unwrap(), principal: AddressSchema,
    effectiveFrom: GuardCursorSchema, effectiveThrough: GuardCursorSchema.nullable(), knownAt: AvailabilityCutSchema,
    serviceStatus: z.enum(['not_service', 'candidate', 'confirmed', 'unresolved']), serviceAddresses: z.array(AddressSchema), evidenceIds,
  }),
  enumeration: z.strictObject({ coverage: GuardCoverageSchema, knownAt: AvailabilityCutSchema }),
  launches: z.array(z.strictObject({ coin: AddressSchema, launchedAt: GuardCursorSchema, knownAt: AvailabilityCutSchema,
    attribution: GuardHistoryAttributionSchema.nullable() })),
  assessments: z.array(z.strictObject({ id: Bytes32Schema, coin: AddressSchema, entryCursor: GuardCursorSchema,
    maturityCursor: GuardCursorSchema, firstBoundaryAfterHorizon: z.boolean(), confirmationThrough: GuardCursorSchema, canonicalRechecked: z.boolean(),
    knownAt: AvailabilityCutSchema, coverage: GuardCoverageSchema, outcomeVersion: version, identityVersion: version,
    calibrated: z.boolean(), outcomeIds: z.array(Bytes32Schema).min(1) })),
  outcomes: z.array(z.strictObject({ outcome: OutcomeV2Schema, eventCursor: GuardCursorSchema,
    outcomeVersion: version, identityVersion: version, calibrated: z.boolean(), attribution: GuardHistoryAttributionSchema.nullable() })),
});
export type GuardHistorySource = z.infer<typeof GuardHistorySourceSchema>;
export const GuardHistoryInputSchema = z.strictObject({
  coin: AddressSchema, cursor: GuardCursorSchema, availabilityCut: AvailabilityCutSchema,
  baseScore: z.number().int().min(0).max(100), factors: z.array(GuardFactorSchema), mode: z.enum(['shadow', 'active']),
  booster: z.enum(['disabled', 'shadow']).default('disabled'), source: GuardHistorySourceSchema.nullable().default(null),
});
export type GuardHistoryInput = z.input<typeof GuardHistoryInputSchema>;
export const GuardHistoryResultSchema = z.strictObject({
  history: HistoryCoverageSchema, check: GuardAssessmentCheckSchema,
  candidatePoints: z.union([z.literal(0), z.literal(10), z.literal(15)]),
  historyPoints: z.union([z.literal(0), z.literal(10), z.literal(15)]), score: z.number().int().min(0).max(100),
  reason: GuardReasonV2Schema.nullable(),
  gaps: z.array(z.enum(['operator_unresolved', 'service_scope', 'enumeration_missing', 'launch_attribution_missing', 'assessment_missing'])),
});
export type GuardHistoryResult = z.infer<typeof GuardHistoryResultSchema>;
