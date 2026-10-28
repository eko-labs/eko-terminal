import { z } from 'zod';
import { TradeOrderSchema, TradeQuoteSchema, UnsignedTxSchema } from '@eko/shared';
import { fetchParsed } from './api';
import type { TradeClient } from './tradeFlow';
/**
 * 075/076 v1 boundary, matching the server routes in apps/server/src/http/v1/trade.ts: order creation returns
 * `{order, tx}`; the submitted/rejected callbacks and `GET /trade/orders/:id` (BACKEND §23 CA-7) return the TradeOrder
 * itself; history is a CA-8 page `{rows, cursor}`. Any other shape fails closed through the runtime schemas.
 */
export function createGuardedTradeClient(parse: typeof fetchParsed = fetchParsed): TradeClient { return {
  quote: body => parse('/trade/quote', TradeQuoteSchema, { body }),
  order: body => parse('/trade/order', z.object({ order: TradeOrderSchema, tx: UnsignedTxSchema }), { body }),
  submitted: (id, txHash) => parse(`/trade/order/${encodeURIComponent(id)}/submitted`, TradeOrderSchema, { body: { txHash } }),
  // The server records finite wallet outcomes only: a user rejection, or a signing failure.
  rejected: (id, code) => parse(`/trade/order/${encodeURIComponent(id)}/rejected`, TradeOrderSchema, { body: { code: code === 'user_rejected' ? code : 'signing_failed' } }),
  detail: id => parse(`/trade/orders/${encodeURIComponent(id)}`, TradeOrderSchema),
}; }
export const guardedTradeClient = createGuardedTradeClient();
export const guardedOrderHistory = () => fetchParsed('/trade/orders', z.object({ rows: z.array(TradeOrderSchema) }));
