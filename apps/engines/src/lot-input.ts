import { z } from 'zod';
import { AddressSchema, Bytes32Schema, GuardCursorSchema, AvailabilityCutSchema, GuardCoverageSchema,
  GuardLotSchema, SupplySnapshotV2Schema } from '@eko/shared';
import { LaunchRoleSnapshotSchema } from '@eko/chain';

const uint = z.string().regex(/^(0|[1-9]\d*)$/);
const positive = uint.refine(value => value !== '0', 'Economic swap must move positive token units');
const base = { id: Bytes32Schema, cursor: GuardCursorSchema, knownAt: AvailabilityCutSchema,
  transactionId: Bytes32Schema, evidenceIds: z.array(Bytes32Schema).min(1),
  // IDs of source swap/transfer legs consumed by this normalized economic action. Never count them twice.
  sourceIds: z.array(z.string().min(1)).min(1).refine(ids => new Set(ids).size === ids.length, 'Source legs must be unique') };
const quote = { quoteAsset: AddressSchema, quoteDecimals: z.number().int().min(0).max(255) };
export const LotActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...base, ...quote, kind: z.literal('buy'), payer: AddressSchema, recipient: AddressSchema,
    delivered: positive, quoteDebit: uint.nullable(), creationSubtree: z.boolean().nullable() }),
  z.strictObject({ ...base, ...quote, kind: z.literal('sell'), seller: AddressSchema, recipient: AddressSchema,
    swapDebit: positive, tokenFee: uint, grossQuote: uint.nullable(), netQuote: uint.nullable(), quoteFee: uint.nullable() }),
  z.strictObject({ ...base, kind: z.literal('transfer'), from: AddressSchema, to: AddressSchema,
    delivered: uint, tokenFee: uint, distributionId: z.string().nullable(), cexDeposit: z.boolean() }),
  z.strictObject({ ...base, kind: z.literal('mint'), recipient: AddressSchema, units: uint }),
  z.strictObject({ ...base, kind: z.literal('burn'), owner: AddressSchema, units: uint }),
  z.strictObject({ ...base, kind: z.literal('lock'), owner: AddressSchema, units: uint }),
  z.strictObject({ ...base, kind: z.literal('unlock'), owner: AddressSchema, units: uint }),
]);
export type LotAction = z.infer<typeof LotActionSchema>;
// TODO(spec): normalized action/checkpoint wire names are unspecified. Require measured economic source/destination,
// quote deltas including charges, and disjoint consumed source IDs; actor aliases and bare swap events are insufficient.
// Opening lots lack lifetime cash totals; charged token fee destinations are not specified by this envelope.
// Those gaps keep lifetime cash and complete origin overhang unavailable, respectively.
export const LotMetricsInputSchema = z.strictObject({
  coin: AddressSchema, decimals: z.number().int().min(0).max(255), cursor: GuardCursorSchema, knownAt: AvailabilityCutSchema,
  launch: LaunchRoleSnapshotSchema, coverage: GuardCoverageSchema, opening: z.array(GuardLotSchema), actions: z.array(LotActionSchema),
  quoteAsset: AddressSchema, quoteDecimals: z.number().int().min(0).max(255), currentSupply: SupplySnapshotV2Schema,
  supplyBoundaries: z.array(SupplySnapshotV2Schema), exemptComplete: z.boolean(), creationSubtreeComplete: z.boolean(),
  exclusions: z.array(z.strictObject({ address: AddressSchema, role: z.enum(['pool', 'router', 'locker', 'sink', 'exchange']),
    cursor: GuardCursorSchema, knownAt: AvailabilityCutSchema, evidenceIds: z.array(Bytes32Schema).min(1) })),
  completeDistributions: z.array(z.string().min(1)),
});
export type LotMetricsInput = z.infer<typeof LotMetricsInputSchema>;
