import { z } from 'zod';
import { TIMEFRAMES } from './time.js';

export const TimeframeSchema = z.enum(TIMEFRAMES);
export const TradingModeSchema = z.enum(['paper', 'testnet', 'live']);
export type TradingMode = z.infer<typeof TradingModeSchema>;

// ───────────────────────────── Quotes & orders ─────────────────────────────

export const OrderSideSchema = z.enum(['buy', 'sell']);
export type OrderSide = z.infer<typeof OrderSideSchema>;

export const QuoteRequestSchema = z.object({
  market: z.string(),
  side: OrderSideSchema,
  mode: TradingModeSchema,
  /** Amount of the input asset: quote asset for buys, base asset for sells. Decimal string. */
  amountIn: z.string().regex(/^\d+(\.\d+)?$/),
  slippageBps: z.number().int().min(1).max(500),
  signalId: z.never().optional(),
  /** Wallet that will execute (testnet/live). */
  account: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
});
export type QuoteRequest = z.infer<typeof QuoteRequestSchema>;

export interface QuoteFee {
  label: string;
  amount: number;
  asset: string;
  /** true when the value is modelled rather than read from the venue. */
  estimated: boolean;
}

export interface Quote {
  id: string;
  mode: TradingMode;
  market: string;
  side: OrderSide;
  network: string;
  venue: string;
  venueName: string;
  assetIn: string;
  assetOut: string;
  amountIn: number;
  /** Expected output before slippage. */
  expectedOut: number;
  /** Minimum output enforced on execution. */
  minOut: number;
  /** Executable price in quote-asset per base-asset. */
  price: number;
  /** Mid/last chart price at quote time, for comparison. */
  referenceMid: number;
  priceImpactBps: number;
  slippageBps: number;
  fees: QuoteFee[];
  quotedAt: number;
  expiresAt: number;
  latencyMs: number;
  /** Where the price came from, e.g. "Simulated last trade (paper model)" or "QuoterV2 on-chain". */
  priceSource: string;
  simulated: boolean;
  /** On-chain modes: the wallet the calldata pays out to (null when quoted without a wallet). */
  account?: string | null;
  /** Present for on-chain modes: the transactions the wallet needs to sign, in order. */
  tx?: {
    chainId: number;
    approval?: { token: string; spender: string; amount: string } | null;
    swap: { to: string; data: string; value: string };
    amountInRaw: string;
    minOutRaw: string;
    tokenIn: { address: string; decimals: number; symbol: string };
    tokenOut: { address: string; decimals: number; symbol: string };
  };
  warnings: string[];
}

export const OrderStatusSchema = z.enum([
  'awaiting_signature',
  'submitted',
  'confirmed',
  'filled',
  'failed',
  'rejected',
  'expired',
  'cancelled',
]);
export type OrderStatus = z.infer<typeof OrderStatusSchema>;

export const PlaceOrderSchema = z.object({
  quoteId: z.string(),
  idempotencyKey: z.string().min(8).max(80),
  signalId: z.never().optional(),
  /** Client-measured ms from the click that opened the card to this submission. */
  clientLatency: z.object({ clickToSubmitMs: z.number().nonnegative().optional() }).optional(),
});

/**
 * One-tap paper trade: quoted and filled in one call (`POST /api/orders/instant`). Buys spend
 * `amountUsd`; sells convert it to the base asset at the live bid, capped at the holding.
 */
export const InstantOrderSchema = z
  .object({
    mode: TradingModeSchema,
    market: z.string(),
    side: OrderSideSchema,
    /** USD value to trade (required unless selling `all`). */
    amountUsd: z.number().positive().max(10_000_000).optional(),
    /** Sell the whole holding (a position's Close). */
    all: z.literal(true).optional(),
    signalId: z.never().optional(),
    idempotencyKey: z.string().min(8).max(80),
    /** Defaults to the account's preferred slippage. */
    slippageBps: z.number().int().min(1).max(500).optional(),
  })
  .refine((v) => (v.all ? v.side === 'sell' : v.amountUsd !== undefined), { message: 'Give amountUsd, or all: true for a sell', path: ['amountUsd'] });
export type InstantOrder = z.infer<typeof InstantOrderSchema>;

export interface Order {
  id: string;
  mode: TradingMode;
  market: string;
  side: OrderSide;
  signalId: string | null;
  botId: string | null;
  network: string;
  venue: string;
  assetIn: string;
  assetOut: string;
  amountIn: number;
  expectedOut: number;
  minOut: number;
  quotePrice: number;
  referencePrice: number | null;
  slippageBps: number;
  status: OrderStatus;
  txHash: string | null;
  approvalTxHash: string | null;
  fillPrice: number | null;
  filledIn: number | null;
  filledOut: number | null;
  feePaid: number | null;
  feeAsset: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: number;
  submittedAt: number | null;
  settledAt: number | null;
}

export interface Position {
  mode: TradingMode;
  market: string;
  asset: string;
  quantity: number;
  avgCost: number;
  costBasis: number;
  realizedPnl: number;
  markPrice: number | null;
  unrealizedPnl: number | null;
  updatedAt: number;
}

export interface Balance {
  asset: string;
  amount: number;
}

export interface Fill {
  id: string;
  orderId: string;
  mode: TradingMode;
  market: string;
  side: OrderSide;
  price: number;
  baseQty: number;
  quoteQty: number;
  fee: number;
  feeAsset: string;
  txHash: string | null;
  at: number;
}

// ───────────────────────────── Preferences ─────────────────────────────

/** First-run guidance progress. Every field defaults, so partial or missing (legacy) values still parse. */
export const OnboardingChecklistSchema = z.object({
  scan_coin: z.boolean().default(false),
  open_evidence: z.boolean().default(false),
  scan_bags: z.boolean().default(false),
  guarded_trade: z.boolean().default(false),
  connect_agent: z.boolean().default(false),
  // Retained for backward-compatible preference parsing; not launch checklist actions.
  paper_trade: z.boolean().default(false),
  close_position: z.boolean().default(false),
  go_live: z.boolean().default(false),
});
export const OnboardingPrefsSchema = z.object({
  /** Tour/guide version the user last completed or skipped; a newer client version can re-offer the tour. */
  version: z.number().int().min(0).max(1000).default(0),
  welcomeDone: z.boolean().default(false),
  tourDone: z.boolean().default(false),
  checklist: OnboardingChecklistSchema.prefault({}),
  checklistDismissed: z.boolean().default(false),
  liveIntroSeen: z.boolean().default(false),
});
export type OnboardingPrefs = z.infer<typeof OnboardingPrefsSchema>;
export const DEFAULT_ONBOARDING: OnboardingPrefs = OnboardingPrefsSchema.parse({});

export const PreferencesSchema = z.object({
  quickAmounts: z.array(z.number().positive()).min(1).max(6).default([50, 100, 250, 500]),
  quickSellPercents: z.array(z.number().positive().max(100)).min(1).max(6).default([25, 50, 100]),
  slippagePresetsBps: z.array(z.number().int().min(1).max(500)).min(1).max(5).default([10, 30, 50, 100]),
  defaultSlippageBps: z.number().int().min(1).max(500).default(50),
  defaultMode: TradingModeSchema.default('paper'),
  confirmLargeTradeUsd: z.number().positive().default(1000),
  reducedMotion: z.enum(['system', 'on', 'off']).default('system'),
  favorites: z.array(z.string()).max(50).default([]),
  onboarding: OnboardingPrefsSchema.prefault({}),
});
export type Preferences = z.infer<typeof PreferencesSchema>;
export const DEFAULT_PREFERENCES: Preferences = PreferencesSchema.parse({});

export const WorkspaceLayoutSchema = z.object({
  market: z.string().default('ETH-USD'),
  timeframe: TimeframeSchema.default('5m'),
  compareMode: z.boolean().default(false),
  watchlist: z.array(z.string()).max(30).default([]),
  leftWidth: z.number().min(180).max(420).default(248),
  rightWidth: z.number().min(280).max(520).default(340),
  bottomHeight: z.number().min(120).max(600).default(232),
  leftCollapsed: z.boolean().default(false),
  rightCollapsed: z.boolean().default(false),
  bottomCollapsed: z.boolean().default(false),
  bottomTab: z.enum(['positions', 'orders', 'fills', 'journal']).default('positions'),
  indicators: z
    .object({
      ema: z.boolean().default(false),
      bollinger: z.boolean().default(false),
      volume: z.boolean().default(true),
      rsi: z.boolean().default(false),
      macd: z.boolean().default(false),
    })
    .default({ ema: false, bollinger: false, volume: true, rsi: false, macd: false }),
});
export type WorkspaceLayout = z.infer<typeof WorkspaceLayoutSchema>;
export const DEFAULT_LAYOUT: WorkspaceLayout = WorkspaceLayoutSchema.parse({});
