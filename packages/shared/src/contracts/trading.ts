import { z } from 'zod';
import { AddressSchema, PoolRefSchema, HexSchema } from './common.js';
import { PolicySchema } from './harness.js';
// FACTS §7 and BACKEND §23 (v1.2).
export const GuardCheckSchema = z.object({
  code: z.string(),
  status: z.enum(['pass', 'warn', 'refuse']),
  label: z.string(),
  value: z.number().optional(),
});
export type GuardCheck = z.infer<typeof GuardCheckSchema>;
export const GuardResultSchema = z.object({
  decision: z.enum(['allow', 'warn', 'refuse']),
  checks: z.array(GuardCheckSchema),
});
export type GuardResult = z.infer<typeof GuardResultSchema>;
export const TradeQuoteRequestSchema = z.object({
  coin: AddressSchema,
  side: z.enum(['buy', 'sell']),
  amountUsd: z.number(),
  slippageBps: z.number(),
  riskMode: PolicySchema.shape.mode.optional(),
  account: AddressSchema.optional(),
});
export type TradeQuoteRequest = z.infer<typeof TradeQuoteRequestSchema>;
export const TradeQuoteSchema = z.object({
  id: z.string(),
  coin: AddressSchema,
  side: z.enum(['buy', 'sell']),
  amountUsd: z.number(),
  binding: z.boolean(),
  account: AddressSchema.optional(),
  amountIn: z.string(),
  valueWei: z.string(),
  networkFeeUsd: z.number(),
  route: z.object({
    venue: PoolRefSchema.shape.venue,
    poolId: z.string().optional(),
    executable: z.boolean(),
    linkOut: z.string().optional(),
  }),
  expectedOut: z.string(),
  minOut: z.string(),
  priceImpactBps: z.number(),
  buyTaxPct: z.number(),
  sellTaxPct: z.number(),
  exitCostPct: z.number(),
  fee: z.object({
    bps: z.union([z.literal(0), z.literal(50), z.literal(40), z.literal(30), z.literal(25)]),
    usd: z.number(),
    destination: z.union([z.literal('burn_wallet'), z.literal('burn_engine'), z.null()]),
  }),
  approvals: z.array(z.object({
    token: AddressSchema,
    spender: AddressSchema,
    amount: z.string(),
    kind: z.enum(['erc20', 'permit2']),
    expiration: z.number().optional(),
  })),
  guard: GuardResultSchema,
  expiresAt: z.string(),
  asOfBlock: z.number(),
});
export type TradeQuote = z.infer<typeof TradeQuoteSchema>;
export const TradeOrderSchema = z.object({
  id: z.string(),
  quoteId: z.string(),
  status: z.enum(['awaiting_signature', 'submitted', 'confirmed', 'failed', 'rejected', 'expired']),
  coin: AddressSchema,
  side: z.enum(['buy', 'sell']),
  feeBps: z.number(),
  txHash: z.string().optional(),
  filledIn: z.string().optional(),
  filledOut: z.string().optional(),
  errorCode: z.string().optional(),
  createdAt: z.string(),
});
export type TradeOrder = z.infer<typeof TradeOrderSchema>;
