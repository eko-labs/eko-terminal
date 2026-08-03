import type { Candle } from './indicators.js';
import type { Params, RuleStrategy, StrategyDecision } from './strategies.js';
import { resolveParams } from './strategies.js';

/**
 * Long-only spot backtester.
 *
 * Execution model (documented and shown in the UI):
 *  - A signal is formed at the CLOSE of bar i using candles[0..i] only.
 *  - It executes at the OPEN of bar i+1, adjusted by slippage against the trader.
 *  - A fee (bps of notional) is charged on every entry and exit.
 *  - SELL signals close an open position; they never open a short.
 *  - Optional stop: if the bar trades through the signal's invalidation price the position
 *    exits at the worse of the bar open and the stop level (gap-aware).
 *  - Equity is marked to market at each bar close.
 */
export interface BacktestAssumptions {
  feeBps: number;
  slippageBps: number;
  /** Fraction of equity allocated per entry, 0..1. */
  allocation: number;
  useInvalidationStop: boolean;
  /** Force exit after this many bars (0 = disabled). */
  maxHoldBars: number;
  /** Fraction of the sample (by bars) treated as in-sample, 0..1. The remainder is out-of-sample. */
  inSampleFraction: number;
  startingEquity: number;
}

export const DEFAULT_ASSUMPTIONS: BacktestAssumptions = {
  feeBps: 30,
  slippageBps: 10,
  allocation: 1,
  useInvalidationStop: true,
  maxHoldBars: 0,
  inSampleFraction: 0.7,
  startingEquity: 10_000,
};

export interface BacktestTrade {
  entryTime: number;
  entryPrice: number;
  exitTime: number;
  exitPrice: number;
  exitReason: 'signal' | 'stop' | 'max_hold' | 'end_of_data';
  qty: number;
  fees: number;
  pnl: number;
  returnPct: number;
  bars: number;
  segment: 'in_sample' | 'out_of_sample';
}

export interface SegmentMetrics {
  bars: number;
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  avgWinPct: number | null;
  avgLossPct: number | null;
  /** Mean return per trade after fees, in %. */
  expectancyPct: number | null;
  profitFactor: number | null;
  totalReturnPct: number;
  maxDrawdownPct: number;
  exposurePct: number;
  feesPaid: number;
  buyHoldReturnPct: number;
}

export interface BacktestResult {
  strategyId: string;
  strategyVersion: string;
  params: Params;
  assumptions: BacktestAssumptions;
  period: { start: number; end: number; splitTime: number };
  candles: number;
  warmupBars: number;
  signals: { time: number; action: 'buy' | 'sell' | 'hold'; price: number }[];
  trades: BacktestTrade[];
  equity: { time: number; equity: number; drawdownPct: number }[];
  metrics: { overall: SegmentMetrics; inSample: SegmentMetrics; outOfSample: SegmentMetrics };
  limitations: string[];
}

export function runBacktest(
  strategy: RuleStrategy,
  candles: readonly Candle[],
  paramsIn: Params | undefined,
  assumptionsIn: Partial<BacktestAssumptions> = {},
): BacktestResult {
  const a: BacktestAssumptions = { ...DEFAULT_ASSUMPTIONS, ...assumptionsIn };
  const params = resolveParams(strategy.params, paramsIn);
  const n = candles.length;
  const warmup = strategy.warmup(params);
  const evalAt = strategy.prepare(candles, params);
  const splitIdx = Math.max(1, Math.min(n - 1, Math.floor(n * a.inSampleFraction)));
  const fee = a.feeBps / 10_000;
  const slip = a.slippageBps / 10_000;

  let cash = a.startingEquity;
  let qty = 0;
  let entryPrice = 0;
  let entryTime = 0;
  let entryIdx = -1;
  let entryFee = 0;
  let stop: number | null = null;
  let pending: StrategyDecision | null = null;

  const trades: BacktestTrade[] = [];
  const signals: BacktestResult['signals'] = [];
  const equity: BacktestResult['equity'] = [];
  const exposure: boolean[] = [];
  let peak = a.startingEquity;

  const closeTrade = (i: number, rawPrice: number, reason: BacktestTrade['exitReason']) => {
    const px = rawPrice * (1 - slip);
    const gross = qty * px;
    const exitFee = gross * fee;
    cash += gross - exitFee;
    const cost = qty * entryPrice + entryFee;
    const pnl = gross - exitFee - cost;
    trades.push({
      entryTime,
      entryPrice,
      exitTime: candles[i]!.time,
      exitPrice: px,
      exitReason: reason,
      qty,
      fees: entryFee + exitFee,
      pnl,
      returnPct: (pnl / cost) * 100,
      bars: i - entryIdx,
      segment: entryIdx < splitIdx ? 'in_sample' : 'out_of_sample',
    });
    qty = 0;
    stop = null;
    entryIdx = -1;
  };

  for (let i = 0; i < n; i++) {
    const bar = candles[i]!;
    // 1) Execute the decision formed at the previous close, at this bar's open.
    if (pending) {
      if (pending.action === 'buy' && qty === 0) {
        const px = bar.open * (1 + slip);
        const budget = cash * a.allocation;
        const q = budget / (px * (1 + fee));
        if (q > 0) {
          entryFee = q * px * fee;
          cash -= q * px + entryFee;
          qty = q;
          entryPrice = px;
          entryTime = bar.time;
          entryIdx = i;
          stop = a.useInvalidationStop ? pending.invalidation.price : null;
          if (stop !== null && stop >= px) stop = null; // a long stop above entry is contradictory
        }
      } else if (pending.action === 'sell' && qty > 0) {
        closeTrade(i, bar.open, 'signal');
      }
      pending = null;
    }
    // 2) Intrabar stop / max hold.
    if (qty > 0 && stop !== null && bar.low <= stop) {
      closeTrade(i, Math.min(bar.open, stop), 'stop');
    } else if (qty > 0 && a.maxHoldBars > 0 && i - entryIdx >= a.maxHoldBars) {
      closeTrade(i, bar.close, 'max_hold');
    }
    // 3) Evaluate the strategy at this bar's close (point-in-time).
    if (i >= warmup - 1 && i < n - 1) {
      const d = evalAt(i);
      if (d) {
        signals.push({ time: bar.time, action: d.action, price: d.referencePrice });
        if (d.action !== 'hold') pending = d;
      }
    }
    // 4) Mark to market.
    const eq = cash + qty * bar.close;
    peak = Math.max(peak, eq);
    equity.push({ time: bar.time, equity: eq, drawdownPct: peak > 0 ? ((eq - peak) / peak) * 100 : 0 });
    exposure.push(qty > 0);
  }
  if (qty > 0 && n > 0) {
    closeTrade(n - 1, candles[n - 1]!.close, 'end_of_data');
    const eq = cash;
    const lastE = equity[equity.length - 1];
    if (lastE) {
      lastE.equity = eq;
    }
  }

  const seg = (from: number, to: number, which: BacktestTrade['segment'] | 'all'): SegmentMetrics => {
    const ts = trades.filter((t) => which === 'all' || t.segment === which);
    const eqSlice = equity.slice(from, to);
    const startEq = from === 0 ? a.startingEquity : equity[from - 1]?.equity ?? a.startingEquity;
    const endEq = eqSlice[eqSlice.length - 1]?.equity ?? startEq;
    let pk = startEq;
    let mdd = 0;
    for (const e of eqSlice) {
      pk = Math.max(pk, e.equity);
      mdd = Math.min(mdd, pk > 0 ? ((e.equity - pk) / pk) * 100 : 0);
    }
    const wins = ts.filter((t) => t.pnl > 0);
    const losses = ts.filter((t) => t.pnl <= 0);
    const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
    const grossLoss = -losses.reduce((s, t) => s + t.pnl, 0);
    const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
    const firstC = candles[from];
    const lastC = candles[Math.max(from, to - 1)];
    return {
      bars: to - from,
      trades: ts.length,
      wins: wins.length,
      losses: losses.length,
      winRate: ts.length ? wins.length / ts.length : null,
      avgWinPct: mean(wins.map((t) => t.returnPct)),
      avgLossPct: mean(losses.map((t) => t.returnPct)),
      expectancyPct: mean(ts.map((t) => t.returnPct)),
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : wins.length ? Infinity : null,
      totalReturnPct: startEq > 0 ? ((endEq - startEq) / startEq) * 100 : 0,
      maxDrawdownPct: mdd,
      exposurePct: to > from ? (exposure.slice(from, to).filter(Boolean).length / (to - from)) * 100 : 0,
      feesPaid: ts.reduce((s, t) => s + t.fees, 0),
      buyHoldReturnPct: firstC && lastC ? ((lastC.close - firstC.open) / firstC.open) * 100 : 0,
    };
  };

  const limitations = [
    'Fills are modelled at the next bar open ± slippage; real AMM execution depends on pool depth and gas.',
    'Price impact is not modelled beyond the fixed slippage assumption.',
    'Candles come from the configured market-data source, not from on-chain venue prices.',
    'Past results on this sample do not predict future performance.',
  ];
  if (n < 500) limitations.push(`Small sample (${n} bars) — metrics are highly uncertain.`);
  if (trades.length < 30) limitations.push(`Only ${trades.length} trades — too few for statistically meaningful results.`);

  return {
    strategyId: strategy.id,
    strategyVersion: strategy.version,
    params,
    assumptions: a,
    period: { start: candles[0]?.time ?? 0, end: candles[n - 1]?.time ?? 0, splitTime: candles[splitIdx]?.time ?? 0 },
    candles: n,
    warmupBars: warmup,
    signals,
    trades,
    equity,
    metrics: {
      overall: seg(0, n, 'all'),
      inSample: seg(0, splitIdx, 'in_sample'),
      outOfSample: seg(splitIdx, n, 'out_of_sample'),
    },
    limitations,
  };
}

/** Evenly downsample a series to at most `max` points, always keeping the last point. */
export function downsample<T>(xs: readonly T[], max: number): T[] {
  if (xs.length <= max) return xs.slice();
  const step = xs.length / max;
  const out: T[] = [];
  for (let i = 0; i < max - 1; i++) out.push(xs[Math.floor(i * step)]!);
  out.push(xs[xs.length - 1]!);
  return out;
}
