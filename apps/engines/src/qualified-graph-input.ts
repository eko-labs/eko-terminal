import { z } from 'zod';
import { AddressSchema, AvailabilityCutSchema, Bytes32Schema, GuardCoverageSchema, GuardCursorSchema, RawAmountSchema, GuardLotSchema } from '@eko/shared';
import { FundingFlowSchema, PermissionObservationSchema, ServiceResolutionSchema } from '@eko/chain';

const address = AddressSchema.transform(a => a.toLowerCase() as `0x${string}`);
const uint = z.string().regex(/^(0|[1-9]\d*)$/);
const fact = { id: Bytes32Schema, cursor: GuardCursorSchema, knownAt: AvailabilityCutSchema, evidenceIds: z.array(Bytes32Schema).min(1) };
// TODO(spec): §2.3 does not name a graph wire envelope. These pure candidate inputs are
// conserved ledger allocations, not a second ledger or an acquisition/production API.
// Values must be exact event-time conversions to the single declared valuation unit;
// missing conversions stay null. The source ledger owns conversion and FIFO attribution.
export const QualifiedGraphInputSchema = z.strictObject({
  at: AvailabilityCutSchema, coin: address, principal: address.nullable(), launchedAtSec: uint,
  valuationUnit: z.strictObject({ asset: address, decimals: z.number().int().min(0).max(255) }),
  firstBuysComplete: z.boolean(),
  acquisitions: z.array(z.strictObject({ ...fact, coin: address, payer: address, recipient: address,
    cost: RawAmountSchema.nullable(), gas: RawAmountSchema.nullable(),
    subtree: Bytes32Schema.nullable(), authenticatedPrivatePayment: z.boolean() })),
  sales: z.array(z.strictObject({ ...fact, coin: address, seller: address, proceedsRecipient: address,
    net: RawAmountSchema.nullable() })),
  flows: z.array(z.strictObject({ flow: FundingFlowSchema, knownAt: AvailabilityCutSchema,
    value: RawAmountSchema.nullable(), evidenceIds: z.array(Bytes32Schema).min(1) })),
  paths: z.array(z.strictObject({ id: Bytes32Schema, kind: z.enum(['funding', 'collection', 'recycling']),
    // Allocation of one conserved value through each ordered ledger leg, in valuation units.
    legs: z.array(z.strictObject({ flowId: z.string().min(1), value: uint.refine(v => v !== '0') })).min(1).max(3),
    acquisitionId: Bytes32Schema.nullable(), saleId: Bytes32Schema.nullable(),
    nextFunder: address.nullable(), coverage: GuardCoverageSchema,
    // Null keeps factual coordination while review/method-gated loop control stays disabled.
    loopReview: z.strictObject({ knownAt: AvailabilityCutSchema, evidenceIds: z.array(Bytes32Schema).min(1) }).nullable(),
    repeatedPattern: z.strictObject({ knownAt: AvailabilityCutSchema, independentEvidenceIds: z.array(Bytes32Schema).min(2) }).nullable(),
    validUntil: GuardCursorSchema.nullable(),
  })),
  permissions: z.array(PermissionObservationSchema), authorities: z.array(address), services: z.array(ServiceResolutionSchema),
  loopMethodAccepted: z.boolean(),
  // Canonical block hashes are supplied by the caller after reorg invalidation; absence is unknown.
  canonicalBlocks: z.array(z.strictObject({ blockNumber: uint, blockHash: Bytes32Schema })),
  originLots: z.array(z.strictObject({ cursor: GuardCursorSchema, knownAt: AvailabilityCutSchema, lot: GuardLotSchema })).default([]),
  origin: z.array(z.strictObject({ ...fact, purchaser: address.nullable(), from: address, seller: address,
    units: uint.refine(v => v !== '0'), soldUnits: uint, soldAt: GuardCursorSchema, soldKnownAt: AvailabilityCutSchema,
    // Ledger allocation excludes units received and then transferred away; sales cannot reuse lots.
    saleId: Bytes32Schema, transactionId: Bytes32Schema, saleTransactionId: Bytes32Schema })),
  soft: z.array(z.strictObject({ ...fact, members: z.array(address).min(2) })),
});
export type QualifiedGraphInput = z.infer<typeof QualifiedGraphInputSchema>;
