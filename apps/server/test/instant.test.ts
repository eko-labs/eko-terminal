import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Order } from '@eko/shared';
import { buildApp, type Ctx } from '../src/app.js';
import { loadConfig } from '../src/config.js';

let app: FastifyInstance;
let ctx: Ctx;
let close: () => Promise<void>;

beforeAll(async () => {
  const cfg = loadConfig({
    NODE_ENV: 'test',
    LEGACY_SIGNALS: 'true',
    PGLITE_DIR: ':memory:',
    MARKET_DATA_SOURCE: 'demo',
    ENABLE_DEV_ROUTES: 'true',
    SESSION_SECRET: 'i'.repeat(40),
    // Unroutable RPC: these tests must never touch a real chain.
    RH_MAINNET_RPC_URL: 'http://127.0.0.1:9',
    RH_TESTNET_RPC_URL: 'http://127.0.0.1:9',
  } as NodeJS.ProcessEnv);
  ({ app, ctx, close } = await buildApp(cfg));
}, 60_000);

afterAll(async () => {
  await close();
});

async function newSession(): Promise<string> {
  const r = await app.inject({ method: 'GET', url: '/api/session' });
  const c = r.cookies.find((x) => x.name === 'eko_sid');
  if (!c) throw new Error('no session cookie');
  return `eko_sid=${c.value}`;
}

async function call<T = Record<string, unknown>>(cookie: string, method: string, url: string, body?: unknown) {
  const r = await app.inject({ method: method as 'GET', url, headers: { cookie }, payload: body as object });
  return { status: r.statusCode, body: r.json() as T };
}

type Instant = { order: Order; duplicate: boolean; all: boolean; error?: string; message?: string };
let keyN = 0;
const instant = (cookie: string, body: Record<string, unknown>) =>
  call<Instant>(cookie, 'POST', '/api/orders/instant', { mode: 'paper', market: 'ETH-USD', idempotencyKey: `instant-${++keyN}-${Date.now()}`, ...body });

const balance = async (cookie: string, asset: string) => {
  const pf = await call<{ balances: { asset: string; amount: number }[] }>(cookie, 'GET', '/api/portfolio?mode=paper');
  return pf.body.balances.find((b) => b.asset === asset)?.amount ?? 0;
};

describe('one-tap paper trading (POST /api/orders/instant)', () => {
  it('a buy spends the amount and fills in one call, at the preferred slippage', async () => {
    const cookie = await newSession();
    await call(cookie, 'PUT', '/api/preferences', { defaultSlippageBps: 30 });
    const r = await instant(cookie, { side: 'buy', amountUsd: 100 });
    expect(r.status).toBe(201);
    expect(r.body.duplicate).toBe(false);
    expect(r.body.order).toMatchObject({ mode: 'paper', market: 'ETH-USD', side: 'buy', status: 'filled', amountIn: 100, assetIn: 'USD', assetOut: 'ETH', slippageBps: 30 });
    expect(r.body.order.filledOut).toBeGreaterThan(0);
    expect(await balance(cookie, 'USD')).toBeCloseTo(10_000 - 100, 6);
    expect(await balance(cookie, 'ETH')).toBeCloseTo(r.body.order.filledOut!, 9);
  });

  it('a sell converts the amount at the bid, and sells everything when the holding is worth less', async () => {
    const cookie = await newSession();
    const buy = await instant(cookie, { side: 'buy', amountUsd: 250 });
    const held = buy.body.order.filledOut!;

    const part = await instant(cookie, { side: 'sell', amountUsd: 100 });
    expect(part.status).toBe(201);
    expect(part.body.all).toBe(false);
    expect(part.body.order.status).toBe('filled');
    // ≈ $100 of ETH at the bid (the bid may tick between sizing and fill), floored to the market's 6 dp.
    expect(part.body.order.amountIn * part.body.order.fillPrice!).toBeCloseTo(100, 0);
    expect(Number(part.body.order.amountIn.toFixed(6))).toBe(part.body.order.amountIn);

    const rest = await instant(cookie, { side: 'sell', amountUsd: 500 });
    expect(rest.status).toBe(201);
    expect(rest.body.all).toBe(true);
    expect(rest.body.order.amountIn).toBeCloseTo(held - part.body.order.amountIn, 9);
    expect(await balance(cookie, 'ETH')).toBeCloseTo(0, 9);
    const pf = await call<{ positions: { market: string; quantity: number }[] }>(cookie, 'GET', '/api/portfolio?mode=paper');
    expect(pf.body.positions.find((p) => p.market === 'ETH-USD')?.quantity ?? 0).toBe(0);
  });

  it('"all" closes the whole holding', async () => {
    const cookie = await newSession();
    const buy = await instant(cookie, { side: 'buy', amountUsd: 50 });
    const r = await instant(cookie, { side: 'sell', all: true });
    expect(r.status).toBe(201);
    expect(r.body.all).toBe(true);
    expect(r.body.order.amountIn).toBeCloseTo(buy.body.order.filledOut!, 12);
    expect(await balance(cookie, 'ETH')).toBeCloseTo(0, 12);
  });

  it('selling with nothing held is refused with a friendly message, and nothing is recorded', async () => {
    const cookie = await newSession();
    const r = await instant(cookie, { market: 'SOL-USD', side: 'sell', amountUsd: 50 });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('nothing_to_sell');
    expect(r.body.message).toBe('You don’t hold any SOL to sell.');
    const orders = await call<{ orders: Order[] }>(cookie, 'GET', '/api/orders?mode=paper');
    expect(orders.body.orders).toHaveLength(0);
  });

  it('a double submit with one idempotency key makes exactly one order', async () => {
    const cookie = await newSession();
    const body = { mode: 'paper', market: 'ETH-USD', side: 'buy', amountUsd: 100, idempotencyKey: 'instant-double-0001' };
    const rs = await Promise.all([1, 2, 3].map(() => call<Instant>(cookie, 'POST', '/api/orders/instant', body)));
    expect(new Set(rs.map((r) => r.body.order.id)).size).toBe(1);
    expect(rs.filter((r) => r.body.duplicate === false)).toHaveLength(1);
    const orders = await call<{ orders: Order[] }>(cookie, 'GET', '/api/orders?mode=paper');
    expect(orders.body.orders).toHaveLength(1);
    expect(await balance(cookie, 'USD')).toBeCloseTo(10_000 - 100, 6);
  });

  it('refuses to fill on stale market data', async () => {
    const cookie = await newSession();
    ctx.demoFeed!.setPaused(true);
    try {
      const r = await instant(cookie, { side: 'buy', amountUsd: 100 });
      expect(r.status).toBe(503);
      expect(r.body.error).toBe('stale_price');
    } finally {
      ctx.demoFeed!.setPaused(false);
    }
    await new Promise((r) => setTimeout(r, 600));
    expect((await instant(cookie, { side: 'buy', amountUsd: 100 })).status).toBe(201);
  });

  it('refuses more than the paper cash, and non-paper modes', async () => {
    const cookie = await newSession();
    const cash = await instant(cookie, { side: 'buy', amountUsd: 50_000 });
    expect(cash.status).toBe(422);
    expect(cash.body.error).toBe('insufficient_balance');
    const live = await instant(cookie, { mode: 'live', side: 'buy', amountUsd: 100 });
    expect(live.status).toBe(409);
    expect(live.body.error).toBe('paper_only');
    const bad = await instant(cookie, { side: 'buy', all: true });
    expect(bad.status).toBe(400);
  });
});
