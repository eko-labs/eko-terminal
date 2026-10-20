import { RULE_STRATEGIES, TIMEFRAME_SECONDS, getMarket, runBacktest, type BacktestAssumptions, type BacktestResult, type Params, type Timeframe } from '@eko/shared';
import type { MarketDataService } from '../market/service.js';

export const BACKTEST_METHODOLOGY =
  'Long-only spot simulation. Signals form at the close of bar i from bars 0..i only and execute at the open of bar i+1, adjusted by slippage against the trader; fees are charged on entry and exit. SELL closes an open position and never opens a short. Optional stops exit at the worse of the bar open and the invalidation level. The first part of the sample (by bar count) is reported as in-sample and the remainder as out-of-sample; parameters were not re-optimised on the out-of-sample segment.';

export class QuantService {
  constructor(private market: MarketDataService) {}

  async backtest(input: {
    strategyId: string;
    params?: Params;
    market: string;
    timeframe: Timeframe;
    bars: number;
    assumptions?: Partial<BacktestAssumptions>;
  }): Promise<BacktestResult & { dataSource: string; simulatedData: boolean }> {
    const strat = RULE_STRATEGIES[input.strategyId];
    if (!strat) throw Object.assign(new Error('Unknown rules strategy.'), { statusCode: 422 });
    const def = getMarket(input.market);
    if (!def) throw Object.assign(new Error('Unknown market'), { statusCode: 404 });
    const step = TIMEFRAME_SECONDS[input.timeframe];
    const bars = Math.min(Math.max(input.bars, 100), 5000);
    const to = Math.floor(Date.now() / 1000);
    const from = to - step * (bars + 1);
    const candles = await this.market.loadRange(def, input.timeframe, from, to);
    if (candles.length < strat.warmup(input.params ?? {}) + 30) throw Object.assign(new Error(`Not enough history (${candles.length} bars) for this backtest.`), { statusCode: 422 });
    const res = runBacktest(strat, candles, input.params, input.assumptions);
    return { ...res, dataSource: this.market.source, simulatedData: this.market.simulated };
  }

}
