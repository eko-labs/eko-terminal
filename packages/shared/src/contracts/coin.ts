import { RatingPriceMoveSchema } from '../rating-price.js';
import { BlueChipSchema, BlueChipCriteriaSchema } from './blue-chip.js';
import { z } from 'zod';
import { PlaybookIdSchema, LevelSchema, EvidenceRefSchema, AddressSchema, UntrustedSchema, PoolRefSchema, WalletLabelSchema } from './common.js';
import { ReceiptRefSchema } from './receipts.js';
import { GuardAssessmentV2Schema } from './guard-v2.js';
// FACTS §7 and BACKEND §23 (v1.2).
export const PlaybookMatchSchema = z.object({
  id: PlaybookIdSchema,
  level: LevelSchema,
  confidence: z.number(),
  evidence: z.array(EvidenceRefSchema),
  history: z.object({
    deployerRuns: z.number(),
    crewId: z.string().optional(),
    crewRuns: z.number().optional(),
  }).optional(),
});
export type PlaybookMatch = z.infer<typeof PlaybookMatchSchema>;
/**
 * The matches a reader should look at first: Danger before Monitor, in the rules' order within a level. Info matches
 * (a fixed tax under the line, exempt wallets that bought little) are observations, not findings, and never lead: a
 * verdict's first match in rule order is usually one of them, which put "Tax trap" beside almost every coin.
 */
export function findingsFirst<T extends { level: 'info' | 'monitor' | 'danger' | 'clear' | string }>(matches: readonly T[]): T[] {
  return [...matches.filter(m => m.level === 'danger'), ...matches.filter(m => m.level === 'monitor')];
}
export const VerdictSchema = z.object({
  // TODO(spec): additive live check metadata and factual price movement, independent of the risk level.
  lastChecked: z.object({ block: z.number().int().nonnegative(), at: z.iso.datetime() }).optional(),
  priceMove: RatingPriceMoveSchema.optional(),
  coin: AddressSchema,
  // CA-34 (lead): pending means required checks have not run; it is never Clear.
  level: z.enum(['clear', 'monitor', 'danger', 'pending']),
  evaluatedPlaybooks: z.array(PlaybookIdSchema).optional(),
  reasons: z.array(z.string()),
  playbooks: z.array(PlaybookMatchSchema),
  beta: z.object({
    apeScore: z.number().optional(),
    setupGrade: z.enum(['A', 'B', 'C']).optional(),
  }).optional(),
  receipt: ReceiptRefSchema,
  schemaVersion: z.string(),
  asOfBlock: z.number(),
  guardV2: GuardAssessmentV2Schema.optional(),
});
export type Verdict = z.infer<typeof VerdictSchema>;
export const CoinCardFlowExtraSchema = z.object({
  beta: z.boolean().optional(),
  confidence: z.number().optional(),
  // CA-31 (proposed): the agent share split by label tier; agentPct = declaredAgentPct + likelyAgentPct when present.
  declaredAgentPct: z.number().optional(),
  likelyAgentPct: z.number().optional(),
});
/**
 * CA-31 (proposed, owner decision pending): the five-agent signal shown on Radar and the coin view — five independent
 * readings (0–100) and their weighted composite. Beta and descriptive only: it describes activity, it is never a
 * recommendation, and it never ranks the Radar. Omitted until an engine computes it; clients hide it when absent.
 */
export const SignalReadingsSchema = z.object({
  momentum: z.number().min(0).max(100),
  liquidity: z.number().min(0).max(100),
  holders: z.number().min(0).max(100),
  narrative: z.number().min(0).max(100),
  risk: z.number().min(0).max(100),
});
export const CoinSignalSchema = z.object({
  composite: z.number().min(0).max(100),
  readings: SignalReadingsSchema,
  weights: z.object({ momentum: z.number(), liquidity: z.number(), holders: z.number(), narrative: z.number(), risk: z.number() }),
  beta: z.literal(true),
  asOfBlock: z.number(),
  /** Readings computed without their data (shown neutral at 50 and marked "low data"). CA-31, lead. */
  lowData: z.array(z.enum(['momentum', 'liquidity', 'holders', 'narrative', 'risk'])).optional(),
});
export type CoinSignal = z.infer<typeof CoinSignalSchema>;
export type CoinCardFlowExtra = z.infer<typeof CoinCardFlowExtraSchema>;
export const AttributionCoverageGapSchema = z.object({
  reason:z.string(), window:z.string(), status:z.enum(['complete','incomplete']), threshold:z.number(),
  totalCount:z.number(), unattributedCount:z.number(), countShare:z.number(),
  totalVolumeUsd:z.number().nullable(), unattributedVolumeUsd:z.number().nullable(), volumeShare:z.number().nullable(), unknownVolumeCount:z.number(),
});
export type AttributionCoverageGap = z.infer<typeof AttributionCoverageGapSchema>;
export const CoinCardMetaSchema = z.partialRecord(z.enum(['identity', 'tradeability', 'liquidity', 'supply', 'control', 'flow', 'playbooks']), z.object({
  confidence: z.number(),
  asOfBlock: z.number(),
  // CA-34 (lead): section availability and field gaps accompany structural placeholders.
  unavailable: z.boolean().optional(),
  missing: z.array(z.string()).optional(),
  flags: z.array(z.string()).optional(),
  coverageGaps: z.record(z.string(),AttributionCoverageGapSchema).optional(),
}));
export type CoinCardMeta = z.infer<typeof CoinCardMetaSchema>;
export const CoinCardSchema = z.object({
  blueChip: BlueChipSchema.optional(),
  blueChipCriteria: BlueChipCriteriaSchema.optional(),
  identity: z.object({
    address: AddressSchema,
    name: UntrustedSchema,
    symbol: UntrustedSchema,
    /**
     * The coin's launch wallet: a Pons launch's deployer, or for a coin that launched in a Uniswap pool the sender of
     * its first mint. Equal to `address` when that sender was a relayer, a bundler or a bot: no wallet is identified as
     * the coin's deployer, and no check reads one.
     */
    deployer: AddressSchema,
    createdAt: z.string(),
    launchpad: z.enum(['pons', 'occupy', 'flap', 'klik', 'montra', 'flaunch', 'hyperforge', 'taxlaunch', 'unbranded', 'other']),
    stage: z.enum(['curve', 'graduated']),
    curvePct: z.number().optional(),
    quoteAsset: z.enum(['ETH', 'USDG', 'stock_token', 'HYPE', 'USDC', 'other']),
    pools: z.array(PoolRefSchema),
  }),
  clone: z.object({
    isClone: z.boolean(),
    originalAddress: AddressSchema.optional(),
  }).optional(),
  tradeability: z.object({
    exitCostPct: z.object({
      usd100: z.number(),
      usd1k: z.number(),
      usd10k: z.number(),
    }),
    buyTaxPct: z.number(),
    sellTaxPct: z.number(),
    honeypot: z.boolean(),
    limits: z.object({
      maxTxUsd: z.number().optional(),
      maxWalletPct: z.number().optional(),
    }).optional(),
    hookFeePct: z.number().optional(),
    antiSnipe: z.object({
      taxPct: z.number(),
      endsInSec: z.number(),
    }).optional(),
  }),
  liquidity: z.object({
    depthUsd: z.object({
      pct2: z.number(),
      pct5: z.number(),
      pct10: z.number(),
    }),
    lpStatus: z.enum(['burned', 'locked', 'removable', 'pons_locked']),
    feeTiers: z.array(z.number()),
  }),
  supply: z.object({
    top10Pct: z.number(),
    devPct: z.number(),
    bundlesHeldPct: z.number(),
    exemptWalletsHeldPct: z.number(),
    freshWalletsPct: z.number(),
    burnedPct: z.number(),
    circulating: z.string(),
  }),
  control: z.object({
    owner: AddressSchema.optional(),
    canChangeTax: z.boolean(),
    canBlacklist: z.boolean(),
    canPause: z.boolean(),
    canMint: z.boolean(),
    upgradeable: z.boolean(),
  }),
  flow: z.object({
    window: z.enum(['5m', '1h', '24h']),
    agentPct: z.number(),
    crewPct: z.number(),
    humanPct: z.number(),
    washEstPct: z.number(),
    beta: z.boolean().optional(),
    confidence: z.number().optional(),
    declaredAgentPct: z.number().optional(),
    likelyAgentPct: z.number().optional(),
    modelVersion: z.string().optional(),
  }),
  playbooks: z.array(PlaybookMatchSchema),
  verdict: VerdictSchema,
  signal: CoinSignalSchema.optional(), // CA-31 (proposed)
  meta: CoinCardMetaSchema.optional(),
  freshness: z.object({
    block: z.number(),
    ageSec: z.number(),
  }),
});
export type CoinCard = z.infer<typeof CoinCardSchema>;
export const ChartMarkerSchema = z.object({
  ts: z.number(),
  side: z.enum(['buy', 'sell']),
  sizeUsd: z.number(),
  label: WalletLabelSchema,
  confidence: z.number(),
  wallet: AddressSchema,
  crewId: z.string().optional(),
  beta: z.boolean().optional(),
  modelVersion: z.string().optional(),
});
export type ChartMarker = z.infer<typeof ChartMarkerSchema>;
