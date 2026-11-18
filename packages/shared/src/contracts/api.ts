import { BlueChipCriteriaSchema } from './blue-chip.js';
import { GuardAssessmentV2Schema } from './guard-v2.js';
import { z } from 'zod';
import { EntitlementsSchema } from './entitlements.js';
import { FlagsSchema } from '../flags.js';
import { PublicDropSchema } from '../drops.js';
import { AddressSchema, LevelSchema, UntrustedSchema } from './common.js';
import { FeedItemSchema, RadarRowSchema } from './feed.js';
import { VerdictSchema } from './coin.js';
import { ReceiptSchema } from './receipts.js';
// FACTS §7 and BACKEND §23 (v1.2).
export const ErrorCodeSchema = z.enum(['bad_request', 'unauthorized', 'wallet_auth_required', 'tier_required', 'quota_exceeded', 'rate_limited', 'not_found', 'guard_refused', 'stale_data', 'trade_cap_exceeded', 'trading_paused', 'sanctioned', 'quote_changed', 'quote_expired', 'anti_snipe_active', 'no_route', 'sim_unavailable', 'approval_required', 'wallet_mismatch', 'payment_required', 'internal_error', 'conflict', 'forbidden', 'not_allowlisted',
  // Trade errors the edge sends that the client read as a bare HTTP status before (additive; TODO(spec): FACTS §7).
  // not_traded is final (a pool EKO checks but does not trade); route_unavailable is a pool read that may work later.
  'not_traded', 'route_unavailable', 'amount_out_of_range', 'price_unavailable', 'quote_failed']);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;
export const ApiErrorSchema = z.object({
  error: ErrorCodeSchema,
  message: z.string(),
  requiredTier: EntitlementsSchema.shape.tier.optional(),
  retryAfterSec: z.number().optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;
/** The chain this deployment serves (one per deployment; see chain.ts). */
export const PublicChainSchema = z.object({
  key: z.enum(['elysium', 'robinhood']),
  id: z.union([z.literal(4663), z.literal(99901)]),
  name: z.string(),
  native: z.enum(['HYPE', 'ETH']),
  explorerUrl: z.string(),
  publicRpcUrl: z.string(),
});
export type PublicChain = z.infer<typeof PublicChainSchema>;
export const PublicConfigSchema = z.object({
  /** Absent only from older servers; the web then assumes Elysium. */
  chain: PublicChainSchema.optional(),
  blueChip: BlueChipCriteriaSchema.optional(),
  phase: z.enum(['launch_week', 'token_live', 'tiers']),
  flags: FlagsSchema,
  tiers: z.array(z.object({
    tier: EntitlementsSchema.shape.tier,
    minBalance: z.union([z.string(), z.null()]),
    feeBps: z.number(),
    limits: EntitlementsSchema.shape.limits,
    perks: z.array(z.object({
      label: z.string(),
      from: z.string(),
    })),
  })),
  trading: z.object({
    liveEnabled: z.boolean(),
    maxTradeUsd: z.number(),
    routers: z.array(AddressSchema),
    spenders: z.array(AddressSchema),
    /** Permit2, when a listed router settles through it (Uniswap v4 sells): the target of the Permit2 approval step. */
    permit2: AddressSchema.optional(),
  }),
  contracts: z.object({
    receiptsRegistry: AddressSchema,
    burnEngine: AddressSchema.optional(),
    milestoneLockFactory: AddressSchema.optional(),
  }),
  wallets: z.object({
    burn: AddressSchema,
    dev: AddressSchema,
  }),
  burnBoard: z.object({
    heroPctSupply: z.number(),
    heroUsd24h: z.number(),
  }),
  drops: z.array(PublicDropSchema),
  vapidPublicKey: z.string().optional(),
  loops: z.object({
    maxBars: z.number(),
    syncMaxBars: z.number(),
  }),
  exampleScans: z.array(AddressSchema),
});
export type PublicConfig = z.infer<typeof PublicConfigSchema>;
export const MeSchema = z.object({
  account: z.object({
    id: z.string(),
    wallet: AddressSchema.optional(),
    linked: z.array(z.enum(['x', 'telegram', 'farcaster'])),
  }),
  entitlements: EntitlementsSchema,
  trial: z.object({
    status: z.enum(['eligible', 'active', 'used', 'ineligible', 'not_open']),
    reason: z.string().optional(),
    endsAt: z.string().optional(),
  }),
  holdings: z.object({
    minBalance24h: z.union([z.string(), z.null()]),
  }),
  referralCode: z.string(),
});
export type Me = z.infer<typeof MeSchema>;
export const ReferralsSchema = z.object({
  code: z.string(),
  link: z.string(),
  referred: z.number(),
  qualified: z.number(),
  bonusMinutes: z.number(),
});
export type Referrals = z.infer<typeof ReferralsSchema>;
export const TrialRecapSchema = z.object({
  rugsFlagged: z.number(),
  ordersStopped: z.number(),
  alertsFired: z.number(),
  items: z.array(FeedItemSchema),
});
export type TrialRecap = z.infer<typeof TrialRecapSchema>;
export const CensusSchema = z.object({
  gated: z.boolean(),
  reason: z.string().optional(),
  methodologyUrl: z.string(),
  gate: z.object({
    metric: z.literal('likely_agent_precision'),
    wilsonLower: z.number().nullable().optional(),
    recall: z.number().nullable().optional(),
    value: z.union([z.number(), z.null()]),
    threshold: z.number(),
    modelVersion: z.string(),
    evaluatedAt: z.union([z.string(), z.null()]),
    expiresAt: z.string().nullable().optional(),
    modelHash: z.string().nullable().optional(),
    datasetHash: z.string().nullable().optional(),
    evidence: z.object({
      declared: z.number().int().nonnegative(), agents: z.number().int().nonnegative(), humans: z.number().int().nonnegative(),
      disagreements: z.number().int().nonnegative(), predictedAgents: z.number().int().nonnegative(),
    }).nullable().optional(),
  }),
  chain: z.array(z.object({
    window: z.enum(['24h', '7d']),
    agentPct: z.number(),
    crewPct: z.number(),
    humanPct: z.number(),
    asOfBlock: z.number(),
  })),
  coins: z.array(RadarRowSchema),
  asOf: z.string(),
});
export type Census = z.infer<typeof CensusSchema>;
export const ScoreboardKindSchema = z.enum(['calls', 'honeypots_refused', 'honeypots_missed', 'cohort', 'milestones']);
export type ScoreboardKind = z.infer<typeof ScoreboardKindSchema>;
export const ScoreboardRowSchema = z.object({
  kind: ScoreboardKindSchema,
  id: z.string(),
  ts: z.string(),
  coin: AddressSchema.optional(),
  level: VerdictSchema.shape.level.optional(),
  grade: ReceiptSchema.shape.grade.optional(),
  receiptId: z.string().optional(),
  txHash: z.string().optional(),
  detail: z.record(z.string(), z.union([z.number(), z.string()])),
});
export type ScoreboardRow = z.infer<typeof ScoreboardRowSchema>;
export const PerpContextSchema = z.object({
  asset: z.string(),
  venues: z.array(z.object({
    id: z.string(),
    name: z.string(),
    url: z.string(),
    availability: z.string(),
    fundingRate: z.number().optional(),
    openInterestUsd: z.number().optional(),
    asOf: z.string(),
  })),
  disclaimer: z.string(),
});
export type PerpContext = z.infer<typeof PerpContextSchema>;
export const WatchBodySchema = z.object({
  kind: z.enum(['coin', 'wallet', 'crew']),
  target: z.string().min(1).max(128),
});
export type WatchBody = z.infer<typeof WatchBodySchema>;
export const AlertSettingsSchema = z.object({
  telegram: z.boolean(),
  push: z.boolean(),
  minLevel: LevelSchema,
  kinds: z.array(z.enum(['verdict_change', 'playbook', 'crew_active', 'agent_flow_spike', 'approval', 'order'])).max(12),
  quietHoursUtc: z.tuple([z.number().int().min(0).max(23), z.number().int().min(0).max(23)]).optional(),
  agentTradeAboveUsd: z.number().finite().nonnegative().optional(),
});
export type AlertSettings = z.infer<typeof AlertSettingsSchema>;
export const AlertSchema = z.object({
  guardV2: GuardAssessmentV2Schema.nullable().optional(),
  id: z.string(),
  ts: z.string(),
  // TODO(spec): 'wallet_trade' (a wallet the account follows traded) is a post-launch addition, not in FACTS §7.
  kind: z.union([AlertSettingsSchema.shape.kinds.element, z.literal('agent_trade'), z.literal('wallet_trade')]),
  level: LevelSchema.optional(),
  coin: AddressSchema.optional(),
  symbol: UntrustedSchema.optional(),
  agentId: z.string().optional(),
  wallet: AddressSchema.optional(),
  crewId: z.string().optional(),
  sizeUsd: z.number().optional(),
  title: z.string(),
  body: z.string(),
  url: z.string().optional(),
  read: z.boolean(),
});
export type Alert = z.infer<typeof AlertSchema>;
