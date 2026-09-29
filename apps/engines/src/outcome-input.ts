import { z } from 'zod';
import { AddressSchema, Bytes32Schema, GuardCursorSchema, AvailabilityCutSchema, RationalSchema } from '@eko/shared';
import { CampaignReplayInputSchema } from '@eko/chain';

const uint = z.string().regex(/^(0|[1-9]\d*)$/);
const version = z.string().regex(/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/);
const evidenceIds = z.array(Bytes32Schema).min(1);
const proof = { cursor: GuardCursorSchema, knownAt: AvailabilityCutSchema, evidenceIds };
export const OutcomeResponsibilitySchema = z.strictObject({
  kind: z.enum(['authenticated_control', 'reviewed_closed_loop', 'authenticated_remover', 'exercised_configuration', 'non_operator', 'origin', 'coordination', 'unknown']),
  actor: AddressSchema, saleActors: z.array(AddressSchema), operatorGroupId: Bytes32Schema.nullable(),
  effectiveFrom: GuardCursorSchema, effectiveThrough: GuardCursorSchema.nullable(), knownAt: AvailabilityCutSchema,
  reviewed: z.boolean(), precisionAccepted: z.boolean(), evidenceIds,
});
const exit = z.strictObject({ ...proof, sizeUsd: z.union([z.literal(100), z.literal(1000)]),
  routeId: z.string().min(1).max(192).nullable(), quantity: uint, quoteAsset: AddressSchema, quoteDecimals: z.number().int().min(0).max(255),
  status: z.enum(['executed', 'token_restricted', 'capacity_absent', 'entry_failed', 'provider_unavailable', 'unsupported']),
  netQuote: RationalSchema.nullable(), independentlyVerified: z.boolean(), fidelityAccepted: z.boolean(),
});
// TODO(spec): §4 defines outcome semantics but no acquisition/queue wire. These strict,
// engines-only shadow envelopes require supplied observations; they do not acquire missing evidence.
export const OutcomeLabelInputSchema = z.strictObject({
  schemaVersion: z.literal('outcome-input-1'), origin: z.enum(['fixture', 'measured']), coin: AddressSchema, eventId: Bytes32Schema,
  outcomeVersion: z.literal('2.0.0'), identityVersion: version, horizonSec: z.union([z.literal(3600), z.literal(86400), z.literal(604800)]),
  replayMode: z.enum(['production', 'retrospective']), availabilityCut: AvailabilityCutSchema, launchCursor: GuardCursorSchema,
  accountClass: z.enum(['eoa', 'smart_account']), quoteAsset: AddressSchema, quoteDecimals: z.number().int().min(0).max(255),
  // Complete completed-block prefix, including empty blocks; used to select the first boundary, never a timestamp guess.
  boundaries: z.array(z.strictObject({ cursor: GuardCursorSchema, parentHash: Bytes32Schema.nullable() })).min(1),
  relevantBoundaries: z.array(GuardCursorSchema),
  entries: z.array(z.strictObject({ ...proof, sizeUsd: z.union([z.literal(100), z.literal(1000)]),
    quantity: uint, inputQuote: RationalSchema, spentQuote: RationalSchema, gasQuote: RationalSchema, independentlyVerified: z.boolean(), fidelityAccepted: z.boolean(), status: z.enum(['purchased', 'entry_failed', 'unknown']) })),
  checkpoints: z.array(exit),
  coverage: z.strictObject({ events: z.boolean(), controls: z.boolean(), routes: z.boolean(), checkpoints: z.boolean(), archive: z.boolean() }),
  campaigns: z.array(z.strictObject({ eventId: Bytes32Schema, input: CampaignReplayInputSchema, responsibility: OutcomeResponsibilitySchema.nullable(), calibrated: z.boolean() })),
  withdrawals: z.array(z.strictObject({ ...proof, eventId: Bytes32Schema, removable: z.enum(['verified', 'nonwithdrawable', 'unknown']),
    authorizedRemover: AddressSchema.nullable(), authorityVerified: z.boolean(), responsibility: OutcomeResponsibilitySchema.nullable(),
    preInventoryUsd: RationalSchema.nullable(), remainingInventoryUsd: RationalSchema.nullable(),
    preTokenWideSell2: RationalSchema.nullable(), postTokenWideSell2: RationalSchema.nullable(),
    routeDiscoveryComplete: z.boolean(), successor: z.enum(['equivalent_reachable', 'absent', 'unknown']),
    successorObservedThrough: GuardCursorSchema.nullable() })),
  restrictions: z.array(z.strictObject({ ...proof, eventId: Bytes32Schema, wallet: AddressSchema, sizeUsd: z.union([z.literal(100), z.literal(1000)]),
    accountClass: z.enum(['eoa', 'smart_account']), routeId: z.string().min(1).max(192),
    failure: z.enum(['token_enforced', 'confiscation', 'provider', 'capacity', 'entry_limit']),
    independentlyReproduced: z.boolean(), temporaryResolved: z.boolean(), responsibility: OutcomeResponsibilitySchema.nullable() })),
  selling: z.strictObject({ swapsComplete: z.boolean(), transfersComplete: z.boolean(), actorsComplete: z.boolean(),
    sales: z.array(z.strictObject({ ...proof, units: uint, operatorOrLaunchLinked: z.boolean().nullable() })) }),
  calibrated: z.boolean(), dependencyIds: z.array(Bytes32Schema), evidenceIds,
});
export type OutcomeLabelInput = z.infer<typeof OutcomeLabelInputSchema>;
export type OutcomeResponsibility = z.infer<typeof OutcomeResponsibilitySchema>;
