import { z } from 'zod';
import { AddressSchema, Bytes32Schema, GuardCursorSchema, AvailabilityCutSchema, RationalSchema } from '@eko/shared';
const uint = z.string().regex(/^(0|[1-9]\d*)$/);
const positive = uint.refine(x => x !== '0');
const address = AddressSchema.transform(x => x.toLowerCase() as `0x${string}`);
const charge = z.strictObject({ kind: z.enum(['ordinary', 'creator', 'temporary', 'hook']), base: z.enum(['gross', 'remaining']),
  bps: uint.refine(x => BigInt(x) <= 10000n), fixedWei: uint, recipient: address });
const fees = z.strictObject({ buy: z.array(charge), sell: z.array(charge),
  overrides: z.array(z.strictObject({ account: address, buy: z.array(charge), sell: z.array(charge) })) });
const curve = z.strictObject({ tokens: positive, realQuote: uint, virtualQuote: positive, reservedTokens: uint });
const lot = z.strictObject({ id: Bytes32Schema, owner: address, origin: address.nullable(), units: positive,
  // Cost is recipient-paid acquisition including attributable gas, in the declared quote asset.
  cost: RationalSchema.nullable(), payer: address.nullable() });
const state = z.strictObject({ curve: curve.nullable(), fees, wallets: z.array(z.strictObject({ account: address, quote: uint,
  token: uint, allowance: uint })), lots: z.array(lot) });
const base = { id: Bytes32Schema, economicId: Bytes32Schema.nullable() };
const swap = { ...base, account: address, recipient: address, input: positive, minimumOutput: uint, deadlineSec: uint,
  // Unknown token checks, hooks, class restrictions and feedback are never overridden.
  executable: z.enum(['supported', 'unsupported']) };
const leg = z.discriminatedUnion('kind', [
  z.strictObject({ ...swap, kind: z.literal('buy') }),
  z.strictObject({ ...swap, kind: z.literal('sell'), pressureFraction: RationalSchema.nullable() }),
  z.strictObject({ ...base, kind: z.literal('transfer'), from: address, to: address, units: positive }),
  z.strictObject({ ...base, kind: z.literal('quote_transfer'), from: address, to: address, units: positive }),
  z.strictObject({ ...base, kind: z.literal('approve'), account: address, units: uint }),
  z.strictObject({ ...base, kind: z.literal('fees'), fees }),
  z.strictObject({ ...base, kind: z.literal('launch'), curve, fees }),
  z.strictObject({ ...base, kind: z.literal('unsupported'), reason: z.enum(['migration', 'hook', 'feedback', 'route']) }),
]);
// TODO(spec): the normalized campaign/checkpoint wire and deployed prefix decoder are unspecified.
// This envelope requires complete, ordered, reviewed transactions and original constraints, not log-only state.
export const CampaignReplayInputSchema = z.strictObject({ methodVersion: z.literal('campaign-replay-1'), origin: z.enum(['fixture', 'measured']),
  coin: address, quoteAsset: address, quoteDecimals: z.number().int().min(0).max(255), knownAt: AvailabilityCutSchema,
  checkpoint: z.strictObject({ cursor: GuardCursorSchema, state, stateHash: Bytes32Schema, evidenceIds: z.array(Bytes32Schema).min(1) }),
  blocks: z.array(z.strictObject({ cursor: GuardCursorSchema, parentHash: Bytes32Schema, transactions: z.array(z.strictObject({
    id: Bytes32Schema, index: z.number().int().nonnegative(), gasPayer: address, gasQuote: uint, gasRecipient: address,
    // Expected post-state digest covers reserves, balances, allowances, fees and lots.
    expectedStateHash: Bytes32Schema, legs: z.array(leg) })) })).min(1),
  campaign: z.strictObject({ from: GuardCursorSchema, through: GuardCursorSchema, saleIds: z.array(Bytes32Schema).min(1),
    sellingSide: z.array(address).min(1), openingFloat: positive.nullable(), quoteUsd: RationalSchema.nullable(),
    // Coverage denominators come from the complete acquisition ledger, never the valued subset.
    totalCost: z.strictObject({ before: RationalSchema.nullable(), during: RationalSchema.nullable() }),
    closeLiquidationGasQuote: uint.nullable(), liquidationAccounts: z.array(address), coverageComplete: z.boolean(),
    routeReviewed: z.boolean(), fidelityAccepted: z.boolean(), profileHash: Bytes32Schema, evidenceIds: z.array(Bytes32Schema).min(1) }),
});
export type CampaignReplayInput = z.infer<typeof CampaignReplayInputSchema>;
export type CampaignState = z.infer<typeof state>;
export type CampaignLeg = z.infer<typeof leg>;
export type CampaignTransaction = CampaignReplayInput['blocks'][number]['transactions'][number];
