import { zeroAddress } from 'viem';
import { buildRobinhoodSwap, robinhoodApprovals, robinhoodFill, robinhoodQuote, type RobinhoodTradeAddresses } from './robinhood/trade.js';
import type { TradeVenue } from './types.js';

const fail = (message: string, code: string, status: number) => Object.assign(new Error(message), { code, status });

/**
 * Trading on Robinhood Chain through the Robinhood trade module (chains/robinhood/trade.ts): a coin's Pons bonding curve
 * before it graduates, its Pons-hooked Uniswap v4 pool after. A v4 trade calls the Universal Router and a sell approves
 * Permit2 (the public config's routers and spenders). Every Pons coin has its own curve, so no curve is listed there:
 * the quote names the coin's curve (route venue pons_curve, poolId = the curve), and the web accepts it as the call's
 * target and as the spender of that coin's approval, for that quote only (apps/web/src/lib/tradeFlow.ts).
 */
export function robinhoodVenue(a: RobinhoodTradeAddresses): TradeVenue {
  return {
    routers: [a.universalRouter], spenders: [a.permit2], permit2: a.permit2,
    route(coin, check) {
      if (coin.curve && !coin.graduated) return { kind: 'curve', curve: coin.curve.address, token: coin.token };
      const key = coin.key ?? check?.key;
      if (!key || key.currency0 !== zeroAddress) throw fail('This coin\'s pool could not be read; try again shortly.', 'route_unavailable', 503);
      return { kind: 'v4', key, token: coin.token };
    },
    quote: (rpc, route, side, amountIn) => robinhoodQuote(rpc, route, side, amountIn, a),
    // The curve pays the wallet directly, and the router's v4 output goes to it too: never anyone named in a request.
    build: (route, side, amountIn, minOut, deadline, wallet) => buildRobinhoodSwap(route, side, amountIn, minOut, wallet, deadline, a),
    approvals: (route, side, amountIn, expiration) => robinhoodApprovals(route, side, amountIn, a, expiration - 1500)
      // The quote's own Permit2 window (the web caps it at 30 minutes).
      .map(n => n.kind === 'permit2' ? { ...n, expiration } : n),
    fill: (receipt, route, side, wallet) => robinhoodFill(receipt, route, side, wallet, a),
  };
}
