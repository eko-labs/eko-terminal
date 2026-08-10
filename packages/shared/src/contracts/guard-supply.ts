import { z } from 'zod';
import { AddressSchema } from './common.js';
import { AvailabilityCutSchema, CoinCardV2Schema, GuardAssessmentCheckSchema, GuardCursorSchema, PositionSharesSchema } from './guard-v2.js';

/** Guard §2.5: cap semantics are C=S-D-K-U and FDV uses S, never cumulative mints. */
export const SupplySnapshotV2Schema = z.strictObject({
  schemaVersion: z.literal('supply-2'), methodVersion: z.literal('2.0.0'), capSemanticsVersion: z.literal('2.0.0'),
  coin: AddressSchema, cursor: GuardCursorSchema, knownAt: AvailabilityCutSchema,
  supply: CoinCardV2Schema.shape.supply.pick({ minted: true, total: true, sinks: true, locked: true,
    curveInventory: true, poolInventory: true, circulating: true, holderFloat: true, burnedPct: true,
    holders: true, top10RawPct: true, rawTop10: true }),
  holdings: z.array(PositionSharesSchema.extend({ address: AddressSchema,
    bucket: z.enum(['sink', 'curve', 'pool', 'external']) })),
  floatState: z.enum(['stable', 'zero', 'small', 'unknown', 'unreconciled']),
  check: GuardAssessmentCheckSchema.refine(check => check.id === 'supply_float', 'Supply snapshot requires supply_float check'),
  issues: z.array(z.enum(['negative_balance', 'supply_mismatch', 'invalid_lock', 'negative_float', 'incomplete_transfers',
    'unsupported_semantics', 'unproved_inventory', 'unsupported_graduation', 'incomplete_classification'])),
});
export type SupplySnapshotV2 = z.infer<typeof SupplySnapshotV2Schema>;
