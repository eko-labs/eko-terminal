import { canonicalize } from '@eko/shared';
import { ChainQuoteError } from './v3-routes.js';
import type { GuardResult, PreflightRequest, TradeQuoteRequest } from '@eko/shared';
import type { UniswapV3Adapter } from './chain.js';
import type { V3TradeRoute, V3TradeSources } from './v3-routes.js';
import type { TradeReconciliationBackend } from './trade-reconcile.js';
import type { TradeBackend, TradeOwner } from './trades.js';

/** Accepted Guard/account acquisition retains ownership of observations and policy evaluation.
 * Route construction alone supplies neither accepted execution nor measured taxes/cost. */
export interface V3TradeAcquisition extends Pick<TradeBackend, 'capture' | 'probe'> {
  reconciliation?: TradeReconciliationBackend;
  quote(owner: TradeOwner, input: TradeQuoteRequest, route: V3TradeRoute, id: string): Promise<{
    checked: PreflightRequest | null; accepted: boolean; guard: GuardResult;
    buyTaxPct: number; sellTaxPct: number; exitCostPct: number;
  }>;
}

/** Concrete handoff to the existing indexed v3 adapter; fresh 052 validation still runs
 * in TradeService at both quote and order time. Pons curves and v4 pools have their own backends (pons-trade.ts, v4-trade.ts). */
export function v3TradeBackend(adapter: Pick<UniswapV3Adapter, 'quoteTrade'>, sources: V3TradeSources,
  acquisition: V3TradeAcquisition): TradeBackend {
  return {
    reconciliation: acquisition.reconciliation,
    capture: retained => acquisition.capture(retained), probe: acquisition.probe,
    /**
     * Quote an indexed v3 route and obtain trusted acquisition checks; reject checked calldata
     * that differs from the route. Return a public quote without unsigned bytes; executable
     * reflects acquisition acceptance, and TradeService still revalidates.
     */
    async quote(owner, input, id) {
      const route = await adapter.quoteTrade(input, sources);
      const checked = await acquisition.quote(owner, input, route, id);
      if (checked.checked && canonicalize(checked.checked.order.execution?.tx) !== canonicalize(route.tx))
        throw new ChainQuoteError('quote_changed', 'Checked calldata differs from the adapter route');
      const { tx: _unsigned, ...publicRoute } = route;
      return { checked: checked.checked, quote: {
        ...publicRoute, id, coin: input.coin, side: input.side, amountUsd: input.amountUsd,
        ...(input.account ? { account: input.account } : {}), binding: false,
        route: { ...route.route, executable: checked.accepted }, guard: checked.guard,
        buyTaxPct: checked.buyTaxPct, sellTaxPct: checked.sellTaxPct, exitCostPct: checked.exitCostPct,
      } };
    },
  };
}
