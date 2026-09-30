import { z } from 'zod';
import { AddressSchema, AvailabilityCutSchema, Bytes32Schema, GuardCursorSchema } from '@eko/shared';
import { GraduationInventoryInputSchema } from './graduation-inventory.js';

const uint = z.string().regex(/^(0|[1-9]\d*)$/);
const positive = uint.refine(v => v !== '0');
const address = AddressSchema.transform(v => v.toLowerCase() as `0x${string}`);
const proof = { cursor: GuardCursorSchema, knownAt: AvailabilityCutSchema, evidenceIds: z.array(Bytes32Schema).min(1) };
const route = z.strictObject({ id: Bytes32Schema, venue: z.enum(['pons_curve', 'per_pool']), address,
  poolId: Bytes32Schema.nullable() }).refine(v => (v.venue === 'per_pool') === (v.poolId !== null), 'Route pool binding required');
const reserve = z.strictObject({ realQuote: uint, virtualQuote: uint.nullable(), reviewed: z.boolean(),
  source: z.enum(['curve_real_getter', 'per_pool_settlement', 'manager_balance']) });
const fees = z.array(z.strictObject({ id: Bytes32Schema, recipient: address, units: uint }));
const payouts = z.array(z.strictObject({ recipient: address, units: uint, kind: z.enum(['lp_principal', 'other']) }));
const base = { ...proof, id: Bytes32Schema, sourceIds: z.array(Bytes32Schema).min(1), routeId: Bytes32Schema,
  before: reserve, after: reserve, fees: fees.nullable() };
const contribution = { payer: address, quoteDebit: uint.nullable() };
export const ReserveOriginStepSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...base, ...contribution, kind: z.literal('buy') }),
  z.strictObject({ ...base, ...contribution, kind: z.literal('lp_addition'), provider: address }),
  z.strictObject({ ...base, kind: z.literal('sale'), recipient: address, grossOutflow: uint, netReceipt: uint.nullable(),
    soldUnits: positive, lotsReviewed: z.boolean(), soldLotMethod: z.enum(['fifo', 'proportional']),
    soldLots: z.array(z.strictObject({ id: Bytes32Schema, origin: address.nullable(), units: positive })).min(1) }),
  z.strictObject({ ...base, kind: z.literal('outflow'), grossOutflow: uint,
    payouts }),
  z.strictObject({ ...base, kind: z.literal('migration'), successor: route, payouts, settlement: GraduationInventoryInputSchema }),
]);
export type ReserveOriginStep = z.infer<typeof ReserveOriginStepSchema>;

// TODO(spec): the reserve-origin wire and interval endpoints are unspecified. This fixture-only normalized
// envelope uses (from, through] executable cursors and rational quote-raw buckets; it is not an acquisition API.
export const ReserveOriginInputSchema = z.strictObject({ schemaVersion: z.literal('reserve-origin-input-1'),
  origin: z.literal('fixture'), sourceRevision: z.string().regex(/^[0-9a-f]{40}$/), coin: address, quoteAsset: address,
  quoteDecimals: z.number().int().min(0).max(255), cursor: GuardCursorSchema, knownAt: AvailabilityCutSchema,
  interval: z.strictObject({ from: GuardCursorSchema, through: GuardCursorSchema }), coverageComplete: z.boolean(),
  identity: z.strictObject({ schemaVersion: z.literal('reserve-origin-identity-1'), graphVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    cut: AvailabilityCutSchema, evidenceIds: z.array(Bytes32Schema).min(1),
    classifications: z.array(z.strictObject({ address, bucket: z.enum(['operator', 'outside_buyer', 'other', 'unknown']),
      knownAt: AvailabilityCutSchema, evidenceIds: z.array(Bytes32Schema).min(1) })) }),
  opening: z.strictObject({ ...proof, route, reserve,
    buckets: z.strictObject({ operator: uint, outsideBuyer: uint, other: uint,
      providers: z.array(z.strictObject({ provider: address, units: uint })) }) }),
  closing: z.strictObject({ ...proof, routeId: Bytes32Schema, reserve }), steps: z.array(ReserveOriginStepSchema),
});
export type ReserveOriginInput = z.infer<typeof ReserveOriginInputSchema>;
