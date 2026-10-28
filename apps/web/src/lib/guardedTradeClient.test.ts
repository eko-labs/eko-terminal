import { describe, expect, it } from 'vitest';
import type { TradeOrder } from '@eko/shared';
import { createTradeOrder } from '../mocks/fixtures';
import { createApi } from './api';
import { createGuardedTradeClient } from './guardedTradeClient';

// Offline transport with the v1 server's own response shapes (apps/server/src/http/v1/trade.ts).
const hash = `0x${'cd'.repeat(32)}`;
function server(responses: (order: TradeOrder) => Record<string, unknown>) {
  const order = { ...createTradeOrder(), id: 'order-7' };
  const calls: string[] = [];
  const client = createGuardedTradeClient(createApi('/v1', async (url, init) => {
    const key = `${init.method} ${url.replace('/v1', '')}`;
    calls.push(`${key} ${init.body ?? ''}`.trim());
    const routes = responses(order);
    return key in routes ? new Response(JSON.stringify(routes[key])) : new Response(JSON.stringify({ error: 'not_found', message: 'Not found' }), { status: 404 });
  }).parse);
  return { order, calls, client };
}

describe('guarded v1 trade client', () => {
  it('reports, rejects and reads orders on the server routes, which return the TradeOrder itself', async () => {
    const { order, calls, client } = server(o => ({
      'POST /trade/order/order-7/submitted': { ...o, status: 'submitted', txHash: hash },
      'POST /trade/order/order-7/rejected': { ...o, status: 'rejected', errorCode: 'signing_failed' },
      'GET /trade/orders/order-7': { ...o, status: 'confirmed', txHash: hash, filledIn: '91', filledOut: '82' },
    }));
    expect(await client.submitted(order.id, hash)).toMatchObject({ id: order.id, status: 'submitted', txHash: hash });
    expect(await client.rejected(order.id, 'wallet_error')).toMatchObject({ status: 'rejected', errorCode: 'signing_failed' });
    expect(await client.detail(order.id)).toMatchObject({ status: 'confirmed', filledOut: '82' });
    expect(calls).toEqual([
      `POST /trade/order/order-7/submitted {"txHash":"${hash}"}`,
      // The server accepts only its finite wallet outcomes.
      'POST /trade/order/order-7/rejected {"code":"signing_failed"}',
      'GET /trade/orders/order-7',
    ]);
  });

  it('fails closed on any other response shape, including the earlier {order} wrapper', async () => {
    const { order, client } = server(o => ({ 'POST /trade/order/order-7/submitted': { order: { ...o, status: 'submitted' } } }));
    await expect(client.submitted(order.id, hash)).rejects.toThrow();
    // There is no GET /trade/order/:id route; detail must use /trade/orders/:id.
    await expect(server(o => ({ 'GET /trade/order/order-7': o })).client.detail(order.id)).rejects.toThrow();
  });
});
