import { z } from 'zod';
import { AddressSchema } from './common.js';
// FACTS §7 and BACKEND §23 (v1.2).
const BurnStatsCoreSchema = z.object({
  totalBurned: z.string(),
  pctSupplyBurned: z.number(),
  burns24h: z.object({
    count: z.number(),
    tokens: z.string(),
    usd: z.number(),
  }),
  nextBurnEtaSec: z.number(),
  engineBalanceUsd: z.number(),
  recent: z.array(z.object({
    txHash: z.string(),
    tokens: z.string(),
    usd: z.number(),
    ts: z.string(),
  })),
});
export const BurnWalletInfoSchema = z.object({
  address: AddressSchema,
  balanceUsd: z.number(),
  nextScheduledBurnAt: z.string(),
});
export type BurnWalletInfo = z.infer<typeof BurnWalletInfoSchema>;
export const PonsBuybackStatsSchema = z.object({
  tokens: z.string(),
  usd: z.number(),
  count24h: z.number(),
});
export type PonsBuybackStats = z.infer<typeof PonsBuybackStatsSchema>;
export const BurnEngineInfoSchema = z.object({
  address: AddressSchema,
  active: z.boolean(),
  renounced: z.boolean(),
  tuningEndsAt: z.string(),
  phase: z.enum(['curve', 'switching', 'pool']),
  taxPaid: z.object({
    eth: z.string(),
    usd: z.number(),
  }).optional(),
});
export type BurnEngineInfo = z.infer<typeof BurnEngineInfoSchema>;
export const BurnStatsExtraSchema = z.object({
  mode: z.enum(['manual', 'engine']),
  burnWallet: BurnWalletInfoSchema,
  ponsBuybacks: PonsBuybackStatsSchema,
  engine: BurnEngineInfoSchema.optional(),
});
export type BurnStatsExtra = z.infer<typeof BurnStatsExtraSchema>;
export const BurnEventSchema = z.object({
  txHash: z.string(),
  tokens: z.string(),
  usd: z.number(),
  ts: z.string(),
  kind: z.enum(['daily', 'launch', 'engine']),
  signer: z.enum(['burn_wallet', 'dev_wallet', 'engine']),
  buyTxHash: z.string().optional(),
  ethIn: z.string().optional(),
  method: z.enum(['token_burn', 'dead_address']),
  pctSupply: z.number(),
  block: z.number(),
});
export type BurnEvent = z.infer<typeof BurnEventSchema>;
// Keep every FACTS §7 field and retain the additive v1.2 fields when present.
// CA-17 requires those additions on the endpoint/WS payload below.
export const BurnStatsSchema = BurnStatsCoreSchema.extend(BurnStatsExtraSchema.partial().shape);
export type BurnStats = z.infer<typeof BurnStatsSchema>;
// Preserve FACTS §7 BurnStats; CA-17 requires the v1.2 additions on the endpoint/WS payload.
export const BurnStatsWithExtrasSchema = BurnStatsSchema.extend(BurnStatsExtraSchema.shape);
export type BurnStatsWithExtras = z.infer<typeof BurnStatsWithExtrasSchema>;
