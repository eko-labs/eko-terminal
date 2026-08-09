import { BlueChipSchema } from './blue-chip.js';
import { GuardTotalsSchema } from './guard-card-api.js';
import { GuardAssessmentV2Schema, GuardReasonV2Schema, CoinCardV2Schema } from './guard-v2.js';
import { GuardFactorIdSchema, GuardReasonCodeSchema } from './guard-consumers.js';
import { z } from 'zod';
import { AddressSchema, UntrustedSchema, PlaybookIdSchema, LevelSchema, WalletLabelSchema } from './common.js';
import { CoinCardSchema, VerdictSchema, CoinCardFlowExtraSchema, CoinSignalSchema } from './coin.js';
// FACTS §7 and BACKEND §23 (v1.2).
export const CoinSummarySchema = z.object({
  blueChip: BlueChipSchema.optional(),
  guardV2: GuardAssessmentV2Schema.nullable().optional(),
  guardRefreshFailed: z.boolean().optional(),
  address: AddressSchema,
  name: UntrustedSchema,
  symbol: UntrustedSchema,
  launchpad: CoinCardSchema.shape.identity.shape.launchpad,
  stage: z.enum(['curve', 'graduated']),
  curvePct: z.number().optional(),
  /** Elysium: percent of the way to the graduation line (Montra's, or the same line in market cap elsewhere). */
  graduationPct: z.number().min(0).max(100).optional(),
  priceUsd: z.number(),
  priceUnavailable: z.boolean().optional(),
  change1hPct: z.number(),
  liquidityUsd: z.number(),
  verdict: VerdictSchema.shape.level,
  lastChecked: VerdictSchema.shape.lastChecked,
  ratingAgeSec: z.number().nonnegative().optional(),
  priceMove: VerdictSchema.shape.priceMove,
  topPlaybook: PlaybookIdSchema.optional(),
  ageSec: z.number(),
  // CA-35: numeric placeholders are never measurements.
  unavailable: z.array(z.enum(['exitCost', 'flow', 'liquidity', 'signal', 'change', 'marketCap', 'buyers', 'volume', 'spark'])).optional(),
  verdictPending: z.boolean().optional(),
  // TODO(spec): Additive row tooltip context avoids waiting for a separate card fetch.
  evaluatedPlaybooks: VerdictSchema.shape.evaluatedPlaybooks,
  missingChecks: z.array(z.string()).optional(),
  // CA-31 (accepted): market cap in USD for the Radar inspector and coin view.
  marketCapUsd: z.number().optional(),
  // TODO(spec): additive. The live sell check (BACKEND §6.2 contract probe) at one block: `refused` means a buy went
  // through and the sell reverted or returned under 5% in simulation, so the guard refuses buy quotes. Absent means
  // not checked yet; it is never inferred.
  sellCheck: z.object({ status: z.enum(['sellable', 'refused']), asOfBlock: z.number().int().nonnegative(), checkedAt: z.iso.datetime() }).optional(),
  // Additive (2026-10-12): a Danger finding on this coin is one no risk mode accepts (HARD_DANGER_PLAYBOOKS), so the
  // buy is refused even in Degen mode. Absent or false on a Danger coin means Degen mode may accept it with a warning.
  hardDanger: z.boolean().optional(),
});
export type CoinSummary = z.infer<typeof CoinSummarySchema>;
export const RadarRowSchema = CoinSummarySchema.extend({
  rank: z.number(),
  flow: z.intersection(CoinCardSchema.shape.flow, CoinCardFlowExtraSchema),
  exitCost1kPct: z.number(),
  beta: VerdictSchema.shape.beta.optional(),
  // CA-31 (proposed): the five-agent signal and the last 8 hours of prices (oldest first, at most 48 points).
  signal: CoinSignalSchema.optional(),
  // Up to about 97 closes at the finest whole-minute width covering the coin's last eight hours (48 ten-minute closes before 2026-10-12).
  spark8h: z.array(z.number()).max(128).optional(),
  change24hPct: z.number().optional(),
  // Last-hour trading against the coin's usual hour (Hot): USD volume and trades in the last 60 minutes, and the
  // average USD volume per hour over up to 23 earlier hours; the baseline is omitted when there is under an hour of it.
  volume1hUsd: z.number().nonnegative().optional(),
  trades1h: z.number().int().nonnegative().optional(),
  volumeBaselineUsd: z.number().nonnegative().optional(),
});
export type RadarRow = z.infer<typeof RadarRowSchema>;
// CA-36: totals cover every live coin, independent of the loaded page.
export const RadarTotalsSchema=z.object({coins:z.number().int().nonnegative(),clear:z.number().int().nonnegative(),monitor:z.number().int().nonnegative(),pending:z.number().int().nonnegative(),danger:z.number().int().nonnegative(),evaluatedToday:z.number().int().nonnegative(),
  // Last 24 hours, oldest first: distinct live coins evaluated, and coins given a new Danger verdict, per hour.
  evaluatedByHour:z.array(z.number().int().nonnegative()).length(24).optional(),dangerByHour:z.array(z.number().int().nonnegative()).length(24).optional(),
  // TODO(spec): additive. GO-PLAN §10 "Honeypots refused" = guard refusals on trade/quote: distinct coins whose buy quote
  // the guard refused because the sell check failed, since UTC midnight and per hour over the last 24 hours. Omitted
  // while quotes do not run the sell check, so the head shows "not checked yet" rather than a zero.
  honeypotsRefused:z.number().int().nonnegative().optional(),refusedByHour:z.array(z.number().int().nonnegative()).length(24).optional()});
export type RadarTotals=z.infer<typeof RadarTotalsSchema>;
export const RadarResponseSchema=z.object({rows:z.array(RadarRowSchema),cursor:z.string().nullable(),delayedSec:z.number(),totals:RadarTotalsSchema.optional(),guardTotals:GuardTotalsSchema.optional()});
export const PairRowSchema = CoinSummarySchema.extend({
  column: z.enum(['new', 'near_grad', 'migrated']),
  buyers: z.number(),
  exitCost100Pct: z.number(),
  flow: z.intersection(CoinCardSchema.shape.flow, CoinCardFlowExtraSchema),
  antiSnipe: CoinCardSchema.shape.tradeability.shape.antiSnipe.optional(),
  verdictPending: z.boolean(),
  // Additive (2026-10-12), all as on a Radar row: the price series, and last-hour trading with the usual hour (a pair
  // without them could never be marked Hot, since Hot is read from them).
  spark8h: z.array(z.number()).max(128).optional(),
  change24hPct: z.number().optional(),
  volume1hUsd: z.number().nonnegative().optional(),
  trades1h: z.number().int().nonnegative().optional(),
  volumeBaselineUsd: z.number().nonnegative().optional(),
  // Additive (2026-10-12): percent of supply held by the ten largest holders, by the deployer, and still held by the
  // wallets that bought in the first minute, from the coin's card. Each is absent until the card has measured it.
  top10Pct: z.number().min(0).max(100).optional(),
  devPct: z.number().min(0).max(100).optional(),
  earlyHeldPct: z.number().min(0).max(100).optional(),
});
export type PairRow = z.infer<typeof PairRowSchema>;
export const FeedItemSchema = z.object({
  priceMove: VerdictSchema.shape.priceMove,
  guardV2: GuardAssessmentV2Schema.nullable().optional(),
  guardFactorId: GuardFactorIdSchema.optional(),
  guardReasonCode: GuardReasonCodeSchema.optional(),
  guardReason: GuardReasonV2Schema.optional(),
  id: z.string(),
  ts: z.number(),
  block: z.number(),
  // `trade` (2026-10-12): a large buy or sell on a Radar coin by any wallet, with its size, side and wallet. The
  // labelled kinds (`agent_trade`, `crew_trade`) need a wallet label and are rare on this chain.
  kind: z.enum(['new_pair', 'trade', 'agent_trade', 'crew_trade', 'verdict', 'playbook', 'swarm', 'clone', 'wash', 'graduation', 'burn']),
  coin: AddressSchema,
  symbol: UntrustedSchema,
  level: LevelSchema.optional(),
  playbookId: PlaybookIdSchema.optional(),
  label: WalletLabelSchema.optional(),
  sizeUsd: z.number().optional(),
  wallet: AddressSchema.optional(),
  crewId: z.string().optional(),
  // CA-32 (lead, additive, all optional): the structured fields the Feed's one-line descriptions are built from
  // (FRONTEND §3.3), so the web never parses free text. Absent field → that part of the line is left out.
  side: z.enum(['buy', 'sell']).optional(),
  beta: z.boolean().optional(),
  confidence: z.number().optional(),
  modelVersion: z.string().optional(),
  /** A declared agent's self-registered name (ERC-8004): untrusted text. */
  agentName: UntrustedSchema.optional(),
  /** EKO's own name for a crew. */
  crewName: z.string().optional(),
  crewWallets: z.number().int().nonnegative().optional(),
  /** Playbook match confidence, 0–100. */
  matchPct: z.number().min(0).max(100).optional(),
  /** For clone items: the symbol being copied (untrusted), and how many clones the same crew launched in 7 days. */
  cloneOf: UntrustedSchema.optional(),
  clones7d: z.number().int().nonnegative().optional(),
  /** For verdict items: time from the pair's first block to its first verdict. */
  firstVerdictMs: z.number().nonnegative().optional(),
  /** For swarm items (beta): personas that pass, out of how many. */
  swarm: z.object({ pass: z.number().int().nonnegative(), of: z.number().int().positive() }).optional(),
});
export type FeedItem = z.infer<typeof FeedItemSchema>;
export const BarSchema = z.object({
  ts: z.number(),
  o: z.number(),
  h: z.number(),
  l: z.number(),
  c: z.number(),
  vUsd: z.number(),
});
export type Bar = z.infer<typeof BarSchema>;
export const TickSchema = z.object({
  ts: z.number(),
  price: z.number(),
  volumeUsd: z.number(),
  block: z.number(),
});
export type Tick = z.infer<typeof TickSchema>;
export const ScanResultSchema = z.object({
  id: z.string(),
  status: z.enum(['ready', 'pending', 'not_found', 'ambiguous']),
  card: CoinCardSchema.optional(),
  guardCard: CoinCardV2Schema.nullable().optional(),
  shareUrl: z.string(),
  message: z.string().optional(),
  candidates: z.array(CoinSummarySchema).optional(),
});
export type ScanResult = z.infer<typeof ScanResultSchema>;
export const BagReportSchema = z.object({
  wallet: AddressSchema.optional(),
  asOfBlock: z.number(),
  holdings: z.array(z.object({
    coin: CoinSummarySchema,
    // TODO(spec): CA-6 has no row availability contract; null is unknown, never zero.
    balance: z.string().nullable(),
    balanceStatus: z.enum(['observed', 'unavailable', 'error']).optional(),
    status: z.enum(['ready', 'pending', 'unavailable', 'error']).optional(),
    unavailable: z.array(z.enum(['balance', 'value', 'card', 'exitCost'])).optional(),
    error: z.enum(['balance_unavailable', 'card_unavailable', 'scan_failed', 'scan_queue_full']).optional(),
    valueUsd: z.number().optional(),
    playbooks: z.array(PlaybookIdSchema),
    exitCost1kPct: z.number().nullable(),
  })),
  summary: z.object({
    coins: z.number(),
    flagged: z.number(),
    danger: z.number(),
    valueUsd: z.number().optional(),
  }),
  shareUrl: z.string().optional(),
  // Indexed discovery is not an exhaustive chain balance inventory. Summary is per page.
  coverage: z.literal('indexed_candidates').optional(),
  cursor: AddressSchema.nullable().optional(),
});
export const BagShareRequestSchema = z.object({
  includeValues: z.boolean().default(false), includeWallet: z.boolean().default(false),
}).strict();
export const BagShareResponseSchema = z.object({ id: z.uuid(), shareUrl: z.string() });
// Public coin dollar fields are optional so omission does not masquerade as measured zero.
export const PublicBagReportSchema = BagReportSchema.extend({
  holdings: z.array(BagReportSchema.shape.holdings.element.extend({
    coin: CoinSummarySchema.omit({ guardV2: true }).partial({ priceUsd: true, liquidityUsd: true }),
  })),
});
export type PublicBagReport = z.infer<typeof PublicBagReportSchema>;
export type BagReport = z.infer<typeof BagReportSchema>;
