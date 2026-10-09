import { seedSanctions } from './sanctions-fixture.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import type { FastifyInstance } from 'fastify';
import type { Order, Quote } from '@eko/shared';
import { buildApp, type Ctx } from '../src/app.js';
import { loadConfig } from '../src/config.js';

// Test-only wallet keys generated at runtime (never real funds).
const adminKey = generatePrivateKey();
const admin = privateKeyToAccount(adminKey);
const userKey = generatePrivateKey();
const user = privateKeyToAccount(userKey);

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
    SESSION_SECRET: 'x'.repeat(40),
    // Unroutable RPC: these tests must never touch a real chain.
    RH_MAINNET_RPC_URL: 'http://127.0.0.1:9',
    RH_TESTNET_RPC_URL: 'http://127.0.0.1:9',
    ADMIN_WALLETS: admin.address,
    AI_DAILY_BUDGET_USD: '5',
  } as NodeJS.ProcessEnv);
  ({ app, ctx, close } = await buildApp(cfg));
  await seedSanctions(ctx.dbh.chain);
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

describe('sessions & persistence', () => {
  it('serves EKO identity and sets only the renamed session cookie', async () => {
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    await vi.waitFor(async () => {
      const ready = await app.inject('/api/health');
      expect(ready.statusCode).toBe(200);
      expect(ready.json().loops.refresher).toMatchObject({ ok: true, lastCycleAt: expect.any(Number) });
    }, { timeout: 10_000, interval: 50 });
    expect(health.json()).toMatchObject({ service: 'eko', marketData: { source: 'EKO simulator', simulated: true } });
    expect(health.headers).not.toHaveProperty('x-powered-by');
    const session = await app.inject({ method: 'GET', url: '/api/session' });
    expect(session.cookies.map((c) => c.name)).toEqual(['eko_sid']);
  });

  it('creates a guest session with defaults, and persists layout + preferences', async () => {
    const cookie = await newSession();
    const s = await call<{ account: { kind: string }; layout: { market: string } }>(cookie, 'GET', '/api/session');
    expect(s.body.account.kind).toBe('guest');
    expect(s.body).not.toHaveProperty('installs');
    const put = await call(cookie, 'PUT', '/api/layout', { market: 'BTC-USD', timeframe: '1h' });
    expect(put.status).toBe(200);
    const prefs = await call(cookie, 'PUT', '/api/preferences', { quickAmounts: [25, 75], defaultSlippageBps: 30 });
    expect(prefs.status).toBe(200);
    const again = await call<{ layout: { market: string; timeframe: string }; preferences: { quickAmounts: number[] } }>(cookie, 'GET', '/api/session');
    expect(again.body.layout).toMatchObject({ market: 'BTC-USD', timeframe: '1h' });
    expect(again.body.preferences.quickAmounts).toEqual([25, 75]);
  });

  it('rejects invalid preferences', async () => {
    const cookie = await newSession();
    const r = await call(cookie, 'PUT', '/api/preferences', { defaultSlippageBps: 99_999 });
    expect(r.status).toBe(400);
  });

  it('refuses private endpoints without a session', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/orders' });
    expect(r.statusCode).toBe(401);
  });
});

describe('market data', () => {
  it('serves simulated candles with the simulated flag set', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/candles?market=ETH-USD&timeframe=5m&limit=100' });
    const b = r.json() as { candles: { time: number }[]; simulated: boolean };
    expect(b.simulated).toBe(true);
    expect(b.candles.length).toBeGreaterThan(50);
    for (let i = 1; i < b.candles.length; i++) expect(b.candles[i]!.time).toBeGreaterThan(b.candles[i - 1]!.time);
  });
});

describe('paper trading journey', () => {
  it('quote → fill, duplicate clicks are idempotent, position is recorded', async () => {
    const cookie = await newSession();
    const q = await call<{ quote: Quote }>(cookie, 'POST', '/api/quotes', { market: 'ETH-USD', side: 'buy', mode: 'paper', amountIn: '250', slippageBps: 50 });
    expect(q.status).toBe(200);
    expect(q.body.quote.simulated).toBe(true);
    expect(q.body.quote.minOut).toBeLessThan(q.body.quote.expectedOut);
    const body = { quoteId: q.body.quote.id, idempotencyKey: 'test-idem-0001' };
    const [a, b, c] = await Promise.all([call<{ order: Order; duplicate: boolean }>(cookie, 'POST', '/api/orders', body), call<{ order: Order; duplicate: boolean }>(cookie, 'POST', '/api/orders', body), call<{ order: Order; duplicate: boolean }>(cookie, 'POST', '/api/orders', body)]);
    const ids = new Set([a.body.order.id, b.body.order.id, c.body.order.id]);
    expect(ids.size).toBe(1);
    expect([a, b, c].filter((x) => x.body.duplicate === false)).toHaveLength(1);
    expect(a.body.order.status).toBe('filled');
    expect(a.body.order).toMatchObject({ referencePrice: null, botId: null, signalId: null });
    const orders = await call<{ orders: Order[] }>(cookie, 'GET', '/api/orders?mode=paper');
    expect(orders.body.orders).toHaveLength(1);
    const pf = await call<{ positions: { market: string; quantity: number }[]; balances: { asset: string; amount: number }[] }>(cookie, 'GET', '/api/portfolio?mode=paper');
    expect(pf.body.positions.find((p) => p.market === 'ETH-USD')!.quantity).toBeCloseTo(a.body.order.filledOut!, 9);
    expect(pf.body.balances.find((x) => x.asset === 'USD')!.amount).toBeCloseTo(10_000 - 250, 6);
    // Paper activity never leaks into live/testnet views.
    const live = await call<{ positions: unknown[]; fills: unknown[] }>(cookie, 'GET', '/api/portfolio?mode=live');
    expect(live.body.positions).toHaveLength(0);
    expect(live.body.fills).toHaveLength(0);
  });

  it('a spot SELL of an asset you do not own is refused (no silent shorting)', async () => {
    const cookie = await newSession();
    const q = await call<{ quote: Quote }>(cookie, 'POST', '/api/quotes', { market: 'SOL-USD', side: 'sell', mode: 'paper', amountIn: '3', slippageBps: 50 });
    expect(q.body.quote.warnings.some((w) => w.startsWith('insufficient_balance'))).toBe(true);
    const o = await call<{ error: string; order: Order }>(cookie, 'POST', '/api/orders', { quoteId: q.body.quote.id, idempotencyKey: 'test-sell-0001' });
    expect(o.status).toBe(422);
    expect(o.body.error).toBe('insufficient_balance');
    expect(o.body.order.status).toBe('rejected');
  });

  it('insufficient paper cash is refused', async () => {
    const cookie = await newSession();
    const q = await call<{ quote: Quote }>(cookie, 'POST', '/api/quotes', { market: 'BTC-USD', side: 'buy', mode: 'paper', amountIn: '50000', slippageBps: 50 });
    const o = await call<{ error: string }>(cookie, 'POST', '/api/orders', { quoteId: q.body.quote.id, idempotencyKey: 'test-cash-0001' });
    expect(o.status).toBe(422);
    expect(o.body.error).toBe('insufficient_balance');
  });

  it('expired quotes are refused', async () => {
    const cookie = await newSession();
    const q = await call<{ quote: Quote }>(cookie, 'POST', '/api/quotes', { market: 'ETH-USD', side: 'buy', mode: 'paper', amountIn: '100', slippageBps: 50 });
    const stored = (ctx.exec as unknown as { quotes: { get(id: string): { quote: Quote } } }).quotes.get(q.body.quote.id);
    stored.quote.expiresAt = Date.now() - 1;
    const o = await call<{ error: string; order: Order }>(cookie, 'POST', '/api/orders', { quoteId: q.body.quote.id, idempotencyKey: 'test-qexp-0001' });
    expect(o.status).toBe(409);
    expect(o.body.error).toBe('quote_expired');
    expect(o.body.order.status).toBe('expired');
  });

  it('pauses fills when market data is stale, and resumes after reconnect', async () => {
    const cookie = await newSession();
    ctx.demoFeed!.setPaused(true);
    const h = await app.inject({ method: 'GET', url: '/api/health' });
    expect((h.json() as { marketData: { status: string } }).marketData.status).toBe('down');
    const q = await call<{ error: string }>(cookie, 'POST', '/api/quotes', { market: 'ETH-USD', side: 'buy', mode: 'paper', amountIn: '100', slippageBps: 50 });
    expect(q.status).toBe(503);
    expect(q.body.error).toBe('stale_price');
    ctx.demoFeed!.setPaused(false);
    await new Promise((r) => setTimeout(r, 600));
    const q2 = await call(cookie, 'POST', '/api/quotes', { market: 'ETH-USD', side: 'buy', mode: 'paper', amountIn: '100', slippageBps: 50 });
    expect(q2.status).toBe(200);
  });

  it('validates quote input', async () => {
    const cookie = await newSession();
    expect((await call(cookie, 'POST', '/api/quotes', { market: 'ETH-USD', side: 'buy', mode: 'paper', amountIn: '-5', slippageBps: 50 })).status).toBe(400);
    expect((await call(cookie, 'POST', '/api/quotes', { market: 'NOPE-USD', side: 'buy', mode: 'paper', amountIn: '5', slippageBps: 50 })).status).toBe(404);
    expect((await call(cookie, 'POST', '/api/quotes', { market: 'ETH-USD', side: 'buy', mode: 'paper', amountIn: '5', slippageBps: 5000 })).status).toBe(400);
  });
});

describe('on-chain modes are gated', () => {
  it('testnet has no verified venue and says so', async () => {
    const cookie = await newSession();
    const q = await call<{ error: string; message: string }>(cookie, 'POST', '/api/quotes', { market: 'ETH-USD', side: 'sell', mode: 'testnet', amountIn: '0.1', slippageBps: 50 });
    expect(q.status).toBe(422);
    expect(q.body.error).toBe('no_route');
    expect(q.body.message).toMatch(/Testnet/);
  });

  it('markets without a verified route cannot execute live', async () => {
    const cookie = await newSession();
    const q = await call<{ error: string }>(cookie, 'POST', '/api/quotes', { market: 'BTC-USD', side: 'buy', mode: 'live', amountIn: '100', slippageBps: 50 });
    expect(q.status).toBe(422);
    expect(q.body.error).toBe('no_route');
  });

  it('live orders are refused while LIVE_TRADING_ENABLED is false', async () => {
    const cookie = await newSession();
    const s = await call<{ account: { id: string } }>(cookie, 'GET', '/api/session');
    const store = (ctx.exec as unknown as { quotes: { put(q: Quote, a: string, s: string | null): void } }).quotes;
    const fake: Quote = {
      id: 'q_test_live',
      mode: 'live',
      market: 'ETH-USD',
      side: 'sell',
      network: 'robinhood-mainnet',
      venue: 'uniswap-v3',
      venueName: 'Uniswap v3',
      assetIn: 'ETH',
      assetOut: 'USDG',
      amountIn: 0.1,
      expectedOut: 260,
      minOut: 258,
      price: 2600,
      referenceMid: 2600,
      priceImpactBps: 0,
      slippageBps: 50,
      fees: [],
      quotedAt: Date.now(),
      expiresAt: Date.now() + 20_000,
      latencyMs: 1,
      priceSource: 'test',
      simulated: false,
      tx: { chainId: 4663, approval: null, swap: { to: '0x0', data: '0x', value: '0' }, amountInRaw: '1', minOutRaw: '1', tokenIn: { address: '0x0', decimals: 18, symbol: 'ETH' }, tokenOut: { address: '0x0', decimals: 6, symbol: 'USDG' } },
      warnings: [],
    };
    store.put(fake, s.body.account.id, null);
    const o = await call<{ error: string }>(cookie, 'POST', '/api/orders', { quoteId: 'q_test_live', idempotencyKey: 'test-live-0001' });
    expect(o.status).toBe(422);
    expect(o.body.error).toBe('trading_paused');
  });
});

describe('SIWE wallet authentication', () => {
  async function siwe(cookie: string, key: `0x${string}`, overrides: Partial<Parameters<typeof createSiweMessage>[0]> = {}) {
    const acct = privateKeyToAccount(key);
    const n = await call<{ nonce: string; domain: string; uri: string }>(cookie, 'GET', '/api/auth/nonce');
    const message = createSiweMessage({ domain: n.body.domain, address: acct.address, uri: n.body.uri, version: '1', chainId: 4663, nonce: n.body.nonce, issuedAt: new Date(), ...overrides });
    const signature = await acct.signMessage({ message });
    return { message, signature, nonce: n.body.nonce };
  }

  it('verifies a signed message, upgrades the account and rotates the session', async () => {
    const cookie = await newSession();
    const { message, signature } = await siwe(cookie, userKey);
    const r = await app.inject({ method: 'POST', url: '/api/auth/verify', headers: { cookie }, payload: { message, signature } });
    expect(r.statusCode).toBe(200);
    expect((r.json() as { account: { kind: string; walletAddress: string } }).account).toMatchObject({ kind: 'wallet', walletAddress: user.address.toLowerCase() });
    expect(r.cookies.find((c) => c.name === 'eko_sid')?.value).toBeTruthy();
    // Replaying the same nonce fails.
    const again = await app.inject({ method: 'POST', url: '/api/auth/verify', headers: { cookie: `eko_sid=${r.cookies.find((c) => c.name === 'eko_sid')!.value}` }, payload: { message, signature } });
    expect(again.statusCode).toBe(401);
  });

  it('rejects a message for another domain and a forged signature', async () => {
    const cookie = await newSession();
    const bad = await siwe(cookie, userKey, { domain: 'evil.example' });
    expect((await app.inject({ method: 'POST', url: '/api/auth/verify', headers: { cookie }, payload: bad })).statusCode).toBe(400);
    const good = await siwe(cookie, userKey);
    const forged = await privateKeyToAccount(generatePrivateKey()).signMessage({ message: good.message });
    expect((await app.inject({ method: 'POST', url: '/api/auth/verify', headers: { cookie }, payload: { message: good.message, signature: forged } })).statusCode).toBe(401);
  });

  it('on-chain orders require a verified wallet', async () => {
    const cookie = await newSession();
    const s = await call<{ account: { id: string } }>(cookie, 'GET', '/api/session');
    (ctx.exec as unknown as { cfg: { liveEnabled: boolean } }).cfg.liveEnabled = true;
    // Isolate wallet authentication from the separately tested launch-access gates.
    const access = vi.spyOn(ctx.tradeAccess, 'refusal').mockResolvedValue(null);
    try {
      const store = (ctx.exec as unknown as { quotes: { put(q: Quote, a: string, s: string | null): void } }).quotes;
      store.put({ id: 'q_test_live2', mode: 'live', market: 'ETH-USD', side: 'sell', tx: { chainId: 4663 } as Quote['tx'], warnings: [], quotedAt: Date.now(), expiresAt: Date.now() + 20_000 } as unknown as Quote, s.body.account.id, null);
      const o = await call<{ error: string }>(cookie, 'POST', '/api/orders', { quoteId: 'q_test_live2', idempotencyKey: 'test-live-0002' });
      expect(o.status).toBe(401);
      expect(o.body.error).toBe('wallet_auth_required');
    } finally {
      access.mockRestore();
      (ctx.exec as unknown as { cfg: { liveEnabled: boolean } }).cfg.liveEnabled = false;
    }
  });
});

describe('retained deterministic backtesting', () => {
  it('runs a rules strategy without a bot, preserving costs, sample and period', async () => {
    const cookie = await newSession();
    const result = await call<{ result: { strategyId: string; candles: number; simulatedData: boolean; assumptions: { feeBps: number }; period: { start: number; end: number } }; methodology: string }>(cookie, 'POST', '/api/backtests', {
      strategyId: 'trend_ema_cross', market: 'ETH-USD', timeframe: '1h', bars: 300, assumptions: { feeBps: 15 },
    });
    expect(result.status).toBe(200);
    expect(result.body.result).toMatchObject({ strategyId: 'trend_ema_cross', simulatedData: true, assumptions: { feeBps: 15 } });
    expect(result.body.result.candles).toBeGreaterThan(100);
    expect(result.body.result.period.end).toBeGreaterThan(result.body.result.period.start);
    expect(result.body.methodology).toContain('bar i+1');
    expect(result.body).not.toHaveProperty('savedId');
  });
  it('rejects obsolete signal attachments before accepting a trade', async () => {
    const cookie = await newSession();
    for (const [url, body] of [
      ['/api/quotes', { market: 'ETH-USD', side: 'buy', mode: 'paper', amountIn: '100', slippageBps: 50 }],
      ['/api/orders/instant', { mode: 'paper', market: 'ETH-USD', side: 'buy', amountUsd: 100, idempotencyKey: 'retired-signal-attachment' }],
      ['/api/orders', { quoteId: 'retired', idempotencyKey: 'retired-signal-attachment' }],
    ] as const) {
      expect((await call(cookie, 'POST', url, { ...body, signalId: 'retired' })).status).toBe(400);
    }
    expect((await call<{ orders: Order[] }>(cookie, 'GET', '/api/orders')).body.orders).toEqual([]);
  });
});

describe('retained inference budget', () => {
  it('enforces the daily spend ceiling and hourly call cap independently of the removed pipeline', async () => {
    const { InferenceBudget } = await import('../src/ai/budget.js');
    const { inferenceRuns } = await import('../src/db/schema.js');
    const now = 1_800_000_000_000;
    const budget = new InferenceBudget(ctx.dbh.db, 5, 1);
    expect(await budget.check('budget-fixture', now)).toEqual({ ok: true });
    await ctx.dbh.db.insert(inferenceRuns).values({ botId: 'budget-fixture', botVersion: 'test', provider: 'test', market: 'ETH-USD', timeframe: '1h', startedAt: now, outcome: 'ok', estCostUsd: 1 });
    expect(await budget.check('budget-fixture', now)).toMatchObject({ ok: false, reason: expect.stringContaining('hourly call cap') });
    expect(await budget.check('other-fixture', now)).toEqual({ ok: true });
    const daily = new InferenceBudget(ctx.dbh.db, 0.5, 100);
    expect(await daily.check('other-fixture', now)).toMatchObject({ ok: false, reason: expect.stringContaining('Daily AI budget reached') });
    expect(await new InferenceBudget(ctx.dbh.db, 0, 100).check('other-fixture', now)).toMatchObject({ ok: false });
  });
});
