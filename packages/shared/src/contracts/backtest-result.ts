import { z } from 'zod';
import type { BacktestAssumptions, BacktestTrade, SegmentMetrics, BacktestResult } from '../backtest.js';
// CA-20 reuses the existing backtest result unchanged.
export const BacktestAssumptionsSchema = z.object({
  feeBps: z.number(),
  slippageBps: z.number(),
  allocation: z.number(),
  useInvalidationStop: z.boolean(),
  maxHoldBars: z.number(),
  inSampleFraction: z.number(),
  startingEquity: z.number(),
}) satisfies z.ZodType<BacktestAssumptions>;
export const BacktestTradeSchema = z.object({
  entryTime: z.number(),
  entryPrice: z.number(),
  exitTime: z.number(),
  exitPrice: z.number(),
  exitReason: z.union([z.literal('signal'), z.literal('stop'), z.literal('max_hold'), z.literal('end_of_data')]),
  qty: z.number(),
  fees: z.number(),
  pnl: z.number(),
  returnPct: z.number(),
  bars: z.number(),
  segment: z.union([z.literal('in_sample'), z.literal('out_of_sample')]),
}) satisfies z.ZodType<BacktestTrade>;
export const SegmentMetricsSchema = z.object({
  bars: z.number(),
  trades: z.number(),
  wins: z.number(),
  losses: z.number(),
  winRate: z.union([z.number(), z.null()]),
  avgWinPct: z.union([z.number(), z.null()]),
  avgLossPct: z.union([z.number(), z.null()]),
  expectancyPct: z.union([z.number(), z.null()]),
  profitFactor: z.union([z.number(), z.null()]),
  totalReturnPct: z.number(),
  maxDrawdownPct: z.number(),
  exposurePct: z.number(),
  feesPaid: z.number(),
  buyHoldReturnPct: z.number(),
}) satisfies z.ZodType<SegmentMetrics>;
export const BacktestResultSchema = z.object({
  strategyId: z.string(),
  strategyVersion: z.string(),
  params: z.record(z.string(), z.union([z.number(), z.boolean(), z.string()])),
  assumptions: BacktestAssumptionsSchema,
  period: z.object({
    start: z.number(),
    end: z.number(),
    splitTime: z.number(),
  }),
  candles: z.number(),
  warmupBars: z.number(),
  signals: z.array(z.object({
    time: z.number(),
    action: z.union([z.literal('buy'), z.literal('sell'), z.literal('hold')]),
    price: z.number(),
  })),
  trades: z.array(BacktestTradeSchema),
  equity: z.array(z.object({
    time: z.number(),
    equity: z.number(),
    drawdownPct: z.number(),
  })),
  metrics: z.object({
    overall: SegmentMetricsSchema,
    inSample: SegmentMetricsSchema,
    outOfSample: SegmentMetricsSchema,
  }),
  limitations: z.array(z.string()),
}) satisfies z.ZodType<BacktestResult>;
