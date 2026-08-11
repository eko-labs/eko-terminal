import { AddressSchema, PlaybookIdSchema, UntrustedSchema } from './common.js';
import { GuardCheckSchema } from './trading.js';
import { GuardFactorIdSchema, GuardReasonCodeSchema } from './guard-consumers.js';
import { z } from 'zod';
import { BacktestResultSchema } from './backtest-result.js';
// FACTS §7 and BACKEND §23 (v1.2).
export const LoopBacktestSchema = z.object({
  id: z.string(),
  status: z.enum(['done', 'queued', 'running', 'failed']),
  specHash: z.string(),
  source: z.enum(['onchain', 'byo']),
  result: BacktestResultSchema.optional(),
});
export type LoopBacktest = z.infer<typeof LoopBacktestSchema>;
export const OperandSchema = z.union([
  z.object({ ind: z.enum(['close', 'ema', 'sma', 'rsi', 'macd_hist', 'bb_pctb', 'atr_pct', 'adx', 'rel_volume', 'return_pct']), period: z.number().int().min(1).max(400).optional() }),
  z.object({ feature: z.enum(['verdict_level', 'agent_pct', 'crew_pct', 'wash_pct', 'exit_cost_pct', 'curve_pct']) }), // on-chain sources only
  z.object({ const: z.number() }),
]);
export const ConditionSchema = z.object({ left: OperandSchema, op: z.enum(['>', '>=', '<', '<=', 'crosses_above', 'crosses_below']), right: OperandSchema });
export const LoopSpecSchema = z.object({
  version: z.literal(1),
  name: z.string().max(80),
  source: z.enum(['onchain', 'byo']),
  universe: z.object({ coins: z.array(z.string()).max(50).optional(), tickers: z.array(z.string()).max(50).optional() }),
  timeframe: z.enum(['1m', '5m', '15m', '1h', '4h', '1d']),
  entry: z.object({ all: z.array(ConditionSchema).min(1).max(8) }),
  exit: z.object({ any: z.array(ConditionSchema).max(8), takeProfitPct: z.number().max(1000).optional(), stopLossPct: z.number().max(100).optional(), maxHoldBars: z.number().int().max(5000).optional() }),
  sizing: z.object({ allocation: z.number().min(0.01).max(1) }),
  costs: z.object({ feeBps: z.number().min(0).max(500), slippageBps: z.number().min(0).max(1000) }),
}).strict();
export type Operand = z.infer<typeof OperandSchema>;
export type Condition = z.infer<typeof ConditionSchema>;
export type LoopSpec = z.infer<typeof LoopSpecSchema>;

// CA-33 is a user rule/connected-agent record, never an EKO-origin entry signal.
export const RuleSignalSchema = z.object({
  id: z.string(), coin: AddressSchema,
  source: z.object({ kind: z.enum(['rule', 'agent']), id: z.string(), name: UntrustedSchema }),
  side: z.enum(['buy', 'sell']), ts: z.number(), block: z.number().int().nonnegative(),
  // TODO(spec): CA-33 has no finite reason-field contract yet; keep supplied prose inert.
  reason: UntrustedSchema, usdSize: z.number().nonnegative(),
  status: z.enum(['pending', 'passed', 'taken', 'skipped', 'placed', 'blocked', 'nothing']),
  // TODO(spec): CA-33 does not enumerate legacy GuardCheckId; preserve GuardCheck.code.
  blockedBy: z.union([PlaybookIdSchema, GuardCheckSchema.shape.code]).optional(),
  orderId: z.string().optional(),
  guardFactorId: GuardFactorIdSchema.optional(), guardReasonCode: GuardReasonCodeSchema.optional(),
}).superRefine((signal, ctx) => {
  if (signal.status !== 'blocked' && (signal.guardFactorId || signal.guardReasonCode))
    ctx.addIssue({ code: 'custom', message: 'Guard fields describe a blocked user-origin signal only' });
});
export type RuleSignal = z.infer<typeof RuleSignalSchema>;
