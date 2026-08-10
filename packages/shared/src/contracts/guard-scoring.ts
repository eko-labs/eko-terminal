import { z } from 'zod';
import { AddressSchema } from './common.js';
import { Bytes32Schema } from './receipt-encoding.js';
import { GUARD_FACTOR_IDS, GUARD_DECISIVE_IDS } from './guard-ids.js';
import { createGuardMetric, DecimalSchema, GuardCursorSchema, AvailabilityCutSchema,
  GuardAssessmentCheckSchema, GuardReasonV2Schema, GuardAssessmentV2Schema } from './guard-v2.js';
import { GuardHistorySourceSchema } from './guard-history.js';

const numeric = createGuardMetric(DecimalSchema);
const predicate = createGuardMetric(z.boolean());
// TODO(spec): scoring observation wire names are unspecified. Primary/secondary metrics follow
// the ordered inputs in the factor registry; qualification is captured adapter proof, never a legacy label.
export const GuardScoreObservationSchema = z.strictObject({
  id: z.enum(GUARD_FACTOR_IDS), primary: numeric.nullable(), secondary: numeric.nullable(), qualification: predicate.nullable(),
  participants: z.number().int().nonnegative().nullable(), windowSec: z.union([z.literal(300), z.literal(3600), z.literal(86400)]).nullable(),
  controlKind: z.enum(['tax', 'mint']).nullable(), reason: GuardReasonV2Schema,
  mechanism: z.strictObject({ id: Bytes32Schema, key: z.enum(['implementation_capability_effective_config', 'episode_action']),
    proven: z.boolean() }).nullable(),
});
export type GuardScoreObservation = z.infer<typeof GuardScoreObservationSchema>;
export const GuardScoreInputSchema = z.strictObject({
  coin: AddressSchema, cursor: GuardCursorSchema, availabilityCut: AvailabilityCutSchema,
  mode: z.enum(['shadow', 'candidate', 'active']), observations: z.array(GuardScoreObservationSchema),
  checks: z.array(GuardAssessmentCheckSchema),
  decisive: z.array(z.strictObject({ id: z.enum(GUARD_DECISIVE_IDS), proof: predicate, reason: GuardReasonV2Schema })),
  informational: z.array(z.strictObject({ reason: GuardReasonV2Schema, cursor: GuardCursorSchema, knownAt: AvailabilityCutSchema })), historySource: GuardHistorySourceSchema.nullable(),
  shadowBooster: z.boolean(), codeHash: Bytes32Schema, serviceRegistryHash: Bytes32Schema,
  profileHash: Bytes32Schema, calibrationManifestHash: Bytes32Schema,
});
export type GuardScoreInput = z.infer<typeof GuardScoreInputSchema>;
export const GuardCompatibilitySchema = z.strictObject({
  version: z.string(), default: z.literal('compatible'), proofRequired: z.literal(true),
  prohibitedSameMechanism: z.array(z.strictObject({ key: z.enum(['implementation_capability_effective_config', 'episode_action']), factors: z.array(z.enum(GUARD_FACTOR_IDS)).min(2) })),
  allocation: z.literal('maximize sum of family maxima; tie ascending E,Ff,O,C,I,factorId'),
});
export const GuardScoreResultSchema = z.strictObject({ assessment: GuardAssessmentV2Schema, deterministicInput: z.json(),
  allocation: z.strictObject({ compatibility: GuardCompatibilitySchema, compatibilityHash: Bytes32Schema, selectedIds: z.array(z.enum(GUARD_FACTOR_IDS)) }) });
export type GuardScoreResult = z.infer<typeof GuardScoreResultSchema>;
export const GuardShadowRunSchema = z.strictObject({
  id: Bytes32Schema, legacyVerdictId: z.string().min(1), manifestId: Bytes32Schema.nullable(),
  sourceRevision: Bytes32Schema, deterministicInput: z.json(), input: GuardScoreInputSchema, assessment: GuardAssessmentV2Schema,
  allocation: GuardScoreResultSchema.shape.allocation,
  recordedAt: z.iso.datetime(),
});
export type GuardShadowRun = z.infer<typeof GuardShadowRunSchema>;
