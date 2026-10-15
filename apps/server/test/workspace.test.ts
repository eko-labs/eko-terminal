import { seedSanctions } from './sanctions-fixture.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import type { FastifyInstance } from 'fastify';
import type { BookResponse, Order, Quote, ServerMessage, SparklinesResponse, Ticker } from '@eko/shared';
import { MARKETS } from '@eko/shared';
import { buildApp, type Ctx } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { orders, preferences } from '../src/db/schema.js';

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
    SESSION_SECRET: 'y'.repeat(40),
    PUBLIC_ORIGIN: 'http://localhost:5180,https://app.example.com',
    RH_MAINNET_RPC_URL: 'http://127.0.0.1:9',
    RH_TESTNET_RPC_URL: 'http://127.0.0.1:9',
    AI_DAILY_BUDGET_USD: '5',
  } as NodeJS.ProcessEnv);
  ({ app, ctx, close } = await buildApp(cfg));
  await seedSanctions(ctx.dbh.chain);
  await new Promise((r) => setTimeout(r, 400)); // first simulated ticks
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

async function call<T = Record<string, unknown>>(cookie: string, method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await app.inject({ method: method as 'GET', url, headers: { cookie, ...headers }, payload: body as object });
  return { status: r.statusCode, body: r.json() as T };
}

describe('workspace market data', () => {
  it('serves 24 hourly closes per market, oldest first, ending at the live price', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/sparklines' });
    const b = r.json() as SparklinesResponse;
    expect(Object.keys(b.sparklines).sort()).toEqual(MARKETS.map((m) => m.id).sort());
    for (const m of MARKETS) {
      const s = b.sparklines[m.id]!;
      expect(s).toHaveLength(24);
      expect(s.every((v) => Number.isFinite(v) && v > 0)).toBe(true);
      const closed = ctx.market.store.closed(m.id, '1h', 23).map((c) => c.close);
      expect(s.slice(0, 23)).toEqual(closed);
    }
  });

  it('tickers carry 24h high/low that bracket the price', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/tickers' });
    const tickers = (r.json() as { tickers: Ticker[] }).tickers;
    const eth = tickers.find((t) => t.market === 'ETH-USD')!;
    expect(eth.high24h).toBeGreaterThanOrEqual(eth.price);
    expect(eth.low24h).toBeLessThanOrEqual(eth.price);
    expect(eth.open24h).toBeGreaterThan(0);
  });

  it('returns a simulated 20-level book around the live price', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/book?market=ETH-USD' });
    const { book } = r.json() as BookResponse;
    expect(book).not.toBeNull();
    expect(book!.simulated).toBe(true);
    expect(book!.bids).toHaveLength(20);
    expect(book!.asks).toHaveLength(20);
    for (let i = 1; i < 20; i++) {
      expect(book!.bids[i]!.price).toBeLessThan(book!.bids[i - 1]!.price);
      expect(book!.asks[i]!.price).toBeGreaterThan(book!.asks[i - 1]!.price);
    }
    expect(book!.bids[0]!.price).toBeLessThan(book!.asks[0]!.price);
    const px = ctx.market.lastPrice('ETH-USD')!.price;
    expect(Math.abs(book!.bids[0]!.price - px) / px).toBeLessThan(0.001);
    expect((await app.inject({ method: 'GET', url: '/api/book?market=NOPE-USD' })).statusCode).toBe(404);
  });

  it('streams books only to clients watching the market', async () => {
    const cookie = await newSession();
    const seen: ServerMessage[] = [];
    let helloed: () => void = () => undefined;
    const hello = new Promise<void>((res) => (helloed = res));
    const ws = await app.injectWS(
      '/ws',
      { headers: { cookie } },
      {
        onInit: (sock) =>
          sock.on('message', (raw) => {
            const m = JSON.parse(String(raw)) as ServerMessage;
            seen.push(m);
            if (m.type === 'hello') helloed();
          }),
      },
    );
    await hello;
    ws.send(JSON.stringify({ type: 'subscribe', markets: ['PEPE-USD'], timeframes: ['5m'] }));
    await new Promise((r) => setTimeout(r, 1200));
    ws.terminate();
    const books = seen.filter((m): m is Extract<ServerMessage, { type: 'book' }> => m.type === 'book');
    expect(books.length).toBeGreaterThan(0);
    expect(books.every((m) => m.book.market === 'PEPE-USD')).toBe(true);
    // ~4 Hz at most.
    expect(books.length).toBeLessThanOrEqual(7);
    expect(books[0]!.book.bids[0]!.price).toBeLessThan(0.001);
  });
});

// ─────────────── Close position ───────────────

describe('Close = sell all (POST /api/orders/instant with all: true)', () => {
  it('sells the whole paper holding once per idempotency key', async () => {
    const cookie = await newSession();
    const q = await call<{ quote: Quote }>(cookie, 'POST', '/api/quotes', { market: 'PEPE-USD', side: 'buy', mode: 'paper', amountIn: '100', slippageBps: 50 });
    const buy = await call<{ order: Order }>(cookie, 'POST', '/api/orders', { quoteId: q.body.quote.id, idempotencyKey: 'close-buy-0001' });
    expect(buy.body.order.status).toBe('filled');
    const held = buy.body.order.filledOut!;
    expect(held).toBeGreaterThan(1_000_000);

    const close = { mode: 'paper', market: 'PEPE-USD', side: 'sell', all: true, idempotencyKey: 'close-pepe-0001' };
    const c1 = await call<{ order: Order; duplicate: boolean; all: boolean }>(cookie, 'POST', '/api/orders/instant', close);
    expect(c1.status).toBe(201);
    expect(c1.body.all).toBe(true);
    expect(c1.body.order).toMatchObject({ side: 'sell', market: 'PEPE-USD', status: 'filled', mode: 'paper' });
    // The whole (fractional) holding goes, even though PEPE sizes to whole units.
    expect(c1.body.order.amountIn).toBeCloseTo(held, 6);
    const c2 = await call<{ order: Order; duplicate: boolean }>(cookie, 'POST', '/api/orders/instant', close);
    expect(c2.status).toBe(200);
    expect(c2.body.duplicate).toBe(true);
    expect(c2.body.order.id).toBe(c1.body.order.id);

    const pf = await call<{ positions: { market: string; quantity: number; realizedPnl: number }[]; balances: { asset: string; amount: number }[] }>(cookie, 'GET', '/api/portfolio?mode=paper');
    expect(pf.body.balances.find((b) => b.asset === 'PEPE')?.amount ?? 0).toBeCloseTo(0, 9);
    expect(pf.body.positions.find((p) => p.market === 'PEPE-USD')!.quantity).toBe(0);

    const none = await call<{ error: string }>(cookie, 'POST', '/api/orders/instant', { ...close, idempotencyKey: 'close-pepe-0002' });
    expect(none.status).toBe(409);
    expect(none.body.error).toBe('nothing_to_sell');
  });

  it('is paper-only: on-chain positions close with a sell signed in the wallet', async () => {
    const cookie = await newSession();
    const r = await call<{ error: string; message: string }>(cookie, 'POST', '/api/orders/instant', { mode: 'live', market: 'ETH-USD', side: 'sell', all: true, idempotencyKey: 'close-live-0001' });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('paper_only');
    expect(r.body.message).toMatch(/wallet/);
  });
});

// ─────────────── Preferences ───────────────

describe('favorites', () => {
  it('round-trips through PUT /api/preferences and GET /api/session', async () => {
    const cookie = await newSession();
    const s = await call<{ preferences: { favorites: string[] } }>(cookie, 'GET', '/api/session');
    expect(s.body.preferences.favorites).toEqual([]);
    const put = await call(cookie, 'PUT', '/api/preferences', { ...s.body.preferences, favorites: ['PEPE-USD', 'ETH-USD'] });
    expect(put.status).toBe(200);
    const again = await call<{ preferences: { favorites: string[] } }>(cookie, 'GET', '/api/session');
    expect(again.body.preferences.favorites).toEqual(['PEPE-USD', 'ETH-USD']);
  });

  it('old stored preferences without favorites still parse', async () => {
    const cookie = await newSession();
    const s = await call<{ account: { id: string } }>(cookie, 'GET', '/api/session');
    await ctx.dbh.db.insert(preferences).values({ accountId: s.body.account.id, data: { quickAmounts: [10, 20], defaultSlippageBps: 25 } });
    const again = await call<{ preferences: { favorites: string[]; quickAmounts: number[] } }>(cookie, 'GET', '/api/session');
    expect(again.status).toBe(200);
    expect(again.body.preferences.favorites).toEqual([]);
    expect(again.body.preferences.quickAmounts).toEqual([10, 20]);
  });
});

// ─────────────── Live-path guards ───────────────

describe('live path guards', () => {
  const key = generatePrivateKey();
  const wallet = privateKeyToAccount(key);

  async function walletSession(origin?: string) {
    const cookie = await newSession();
    const n = await call<{ nonce: string; domain: string; uri: string }>(cookie, 'GET', '/api/auth/nonce', undefined, origin ? { origin } : {});
    const message = createSiweMessage({ domain: n.body.domain, address: wallet.address, uri: n.body.uri, version: '1', chainId: 4663, nonce: n.body.nonce, issuedAt: new Date() });
    const r = await app.inject({ method: 'POST', url: '/api/auth/verify', headers: { cookie }, payload: { message, signature: await wallet.signMessage({ message }) } });
    expect(r.statusCode).toBe(200);
    return { cookie: `eko_sid=${r.cookies.find((c) => c.name === 'eko_sid')!.value}`, nonce: n.body };
  }

  it('SIWE names the configured origin the request came from', async () => {
    const { nonce } = await walletSession('https://app.example.com');
    expect(nonce).toMatchObject({ domain: 'app.example.com', uri: 'https://app.example.com' });
    const cookie = await newSession();
    const other = await call<{ domain: string }>(cookie, 'GET', '/api/auth/nonce', undefined, { origin: 'https://evil.example' });
    expect(other.body.domain).toBe('localhost:5180');
  });

  it('refuses a live order whose quote pays out to a different wallet', async () => {
    const { cookie } = await walletSession();
    const s = await call<{ account: { id: string } }>(cookie, 'GET', '/api/session');
    const exec = ctx.exec as unknown as { cfg: { liveEnabled: boolean }; quotes: { put(q: Quote, a: string, s: string | null): void } };
    exec.cfg.liveEnabled = true;
    // Isolate exact-account binding from the separately tested launch-access gates.
    const access = vi.spyOn(ctx.tradeAccess, 'refusal').mockResolvedValue(null);
    try {
      const base = { mode: 'live', market: 'ETH-USD', side: 'sell', warnings: [], quotedAt: Date.now(), expiresAt: Date.now() + 20_000, tx: { chainId: 4663, approval: null, swap: { to: '0x1', data: '0x', value: '0' } } };
      exec.quotes.put({ ...base, id: 'q_mismatch', account: privateKeyToAccount(generatePrivateKey()).address.toLowerCase() } as unknown as Quote, s.body.account.id, null);
      exec.quotes.put({ ...base, id: 'q_noacct', account: null } as unknown as Quote, s.body.account.id, null);
      for (const [quoteId, idem] of [['q_mismatch', 'live-mm-0001'], ['q_noacct', 'live-mm-0002']]) {
        const o = await call<{ error: string }>(cookie, 'POST', '/api/orders', { quoteId, idempotencyKey: idem });
        expect(o.status).toBe(409);
        expect(o.body.error).toBe('wallet_mismatch');
      }
    } finally {
      access.mockRestore();
      exec.cfg.liveEnabled = false;
    }
  });

  it('reconciliation rejects a reported transaction whose calldata differs from the quote', async () => {
    const { cookie } = await walletSession();
    const s = await call<{ account: { id: string } }>(cookie, 'GET', '/api/session');
    const router = '0xCaf681a66D020601342297493863E78C959E5cb2';
    const quote = { tx: { chainId: 4663, swap: { to: router, data: '0xabcdef', value: '1000' } } } as unknown as Quote;
    const hash = `0x${'ab'.repeat(32)}` as const;
    const [row] = await ctx.dbh.db
      .insert(orders)
      .values({ accountId: s.body.account.id, mode: 'live', market: 'ETH-USD', side: 'sell', network: 'robinhood-mainnet', venue: 'uniswap-v3', walletAddress: wallet.address.toLowerCase(), assetIn: 'ETH', assetOut: 'USDG', amountIn: 0.1, expectedOut: 260, minOut: 259, quotePrice: 2600, slippageBps: 50, quote, status: 'submitted', idempotencyKey: 'recon-0001', txHash: hash, submittedAt: new Date() })
      .returning();
    const exec = ctx.exec as unknown as { chain: { live: unknown }; reconcile(): Promise<void> };
    const real = exec.chain.live;
    exec.chain.live = {
      receipt: async () => ({ status: 'success', logs: [], gasUsed: 1n, effectiveGasPrice: 1n }),
      transaction: async () => ({ from: wallet.address, to: router, input: '0xdeadbeef', value: 1000n }),
      parseSwap: () => null,
    };
    try {
      // The background reconciler may be mid-pass; poll until the order settles.
      let o: Order | undefined;
      for (let i = 0; i < 20 && o?.status !== 'failed'; i++) {
        await exec.reconcile();
        o = (await call<{ orders: Order[] }>(cookie, 'GET', '/api/orders?mode=live')).body.orders.find((x) => x.id === row!.id);
        if (o?.status !== 'failed') await new Promise((r) => setTimeout(r, 200));
      }
      expect(o!.status).toBe('failed');
      expect(o!.errorCode).toBe('tx_mismatch');
    } finally {
      exec.chain.live = real;
    }
  });
});
