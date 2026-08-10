import { z } from 'zod';
import { AddressSchema } from './common.js';
import { Bytes32Schema } from './receipt-encoding.js';
import { AvailabilityCutSchema, GuardCursorSchema, RawAmountSchema, RationalSchema, PositionMetricsSchema,
  PositionSharesSchema, SaleEpisodeSchema, CampaignMeasurementSchema } from './guard-v2.js';

export const GuardLotSchema = z.strictObject({
  id: Bytes32Schema, owner: AddressSchema, origin: AddressSchema.nullable(), acquiredAt: GuardCursorSchema,
  // FIFO origin remains inspectable; alternatives survive a partial disposition of a mixed bag.
  originAlternatives: z.array(AddressSchema.nullable()).min(1),
  units: RawAmountSchema, state: z.enum(['liquid', 'locked', 'sink']),
  basis: z.strictObject({ asset: AddressSchema, decimals: z.number().int().min(0).max(255),
    cost: RationalSchema.refine(cost => BigInt(cost.numerator) >= 0n, 'Lot cost cannot be negative') }).nullable(),
  basisPayer: AddressSchema.nullable(), evidenceIds: z.array(Bytes32Schema),
}).refine(lot => lot.originAlternatives.includes(lot.origin) && new Set(lot.originAlternatives).size === lot.originAlternatives.length,
  'Origin alternatives must uniquely include the FIFO origin');
export type GuardLot = z.infer<typeof GuardLotSchema>;
export const LotMetricsSnapshotSchema = z.strictObject({
  schemaVersion: z.literal('lot-metrics-2'), methodVersion: z.literal('2.0.0'), coin: AddressSchema,
  cursor: GuardCursorSchema, knownAt: AvailabilityCutSchema, lots: z.array(GuardLotSchema),
  cohorts: z.array(z.strictObject({
    id: z.enum(['principal', 'launch_linked', 'exempt', 'early', 'launch_5s', 'launch_60s', 'launch_300s']),
    members: z.array(AddressSchema), membershipHash: Bytes32Schema, membershipComplete: z.boolean(),
    metrics: PositionMetricsSchema, soldOfAcquired: PositionSharesSchema.shape.floatPct,
    boughtSupplyPct: PositionSharesSchema.shape.supplyPct, boughtFloatPct: PositionSharesSchema.shape.floatPct,
  })),
  sales: z.array(z.strictObject({ id: Bytes32Schema, cursor: GuardCursorSchema, seller: AddressSchema, proceedsRecipient: AddressSchema,
    transactionId: Bytes32Schema, units: RawAmountSchema, feeUnits: RawAmountSchema,
    netQuote: SaleEpisodeSchema.shape.netSaleReceipts, grossQuote: SaleEpisodeSchema.shape.grossSaleReceipts,
    directPrincipal: z.boolean(), responsibility: z.literal('not_assessed'),
    originUnits: z.array(z.strictObject({ origin: AddressSchema.nullable(), fifo: RawAmountSchema, proportional: RationalSchema })),
    principalOriginLower: RawAmountSchema.nullable(), principalOriginUpper: RawAmountSchema.nullable(),
    inheritedOriginUncertainty: z.boolean(), basisKnown: z.boolean(),
  })),
  principalOriginOverhang: PositionSharesSchema,
  episodes: z.array(SaleEpisodeSchema), campaigns: z.array(CampaignMeasurementSchema),
  issues: z.array(z.enum(['incomplete_source', 'unknown_principal', 'unknown_creation_subtree', 'unknown_window',
    'unknown_basis', 'unknown_lifetime_cash', 'unresolved_fee_origin', 'mixed_quote', 'allocation_sensitive', 'unreconciled', 'opening_lock'])),
});
export type LotMetricsSnapshot = z.infer<typeof LotMetricsSnapshotSchema>;
