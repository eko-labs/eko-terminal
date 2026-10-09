import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Quote } from '@eko/shared';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { accounts, journalEntries, orders, siweNonces } from '../src/db/schema.js';
import { ExecutionService } from '../src/exec/service.js';
import { QuoteStore } from '../src/exec/quotes.js';
import type { ExecutionAdapter } from '../src/exec/types.js';

let built: Awaited<ReturnType<typeof buildApp>>;
beforeAll(async () => {
  built = await buildApp(loadConfig({ NODE_ENV: 'test', PGLITE_DIR: ':memory:',
    MARKET_DATA_SOURCE: 'demo', SESSION_SECRET: 'fixture-session-placeholder'.repeat(2) }), { startBackground: false });
});
afterAll(async () => { await built.close(); });
async function session() {
  const [row] = await built.ctx.dbh.db.insert(accounts).values({ kind: 'guest' }).returning();
  const token = await built.ctx.auth.createSession(row!.id);
  return { id: row!.id, token, cookie: `eko_sid=${encodeURIComponent(built.app.signCookie(token))}` };
}
const call = (cookie: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
  built.app.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload }) });
const txHash = `0x${'12'.repeat(32)}`;

describe('core legacy mutation boundaries (offline database and HTTP injection)', () => {
  it('refuses nonce issuance without a valid session and persists no challenge', async () => {
    const before = await built.ctx.dbh.db.select().from(siweNonces);
    for (const cookie of ['', 'eko_sid=invalid']) {
      expect((await call(cookie, 'GET', '/api/auth/nonce')).statusCode).toBe(401);
    }
    expect(await built.ctx.dbh.db.select().from(siweNonces)).toEqual(before);
  });
  it('invalid logout cookies cannot revoke another session; logout remains idempotent', async () => {
    const owner = await session();
    for (const cookie of ['', 'eko_sid=invalid', 'eko_sid=unsigned-fixture-token']) {
      expect((await call(cookie, 'POST', '/api/auth/logout')).json()).toEqual({ ok: true });
      expect(await built.ctx.auth.fromToken(owner.token)).toMatchObject({ id: owner.id });
    }
  });
  it('implicit session GETs reject forged session identity by creating distinct guests', async () => {
    const owner = await session();
    for (const url of ['/api/session', '/v1/me']) {
      const response = await call('eko_sid=invalid', 'GET', url);
      expect(response.statusCode).toBe(200);
      expect(response.json().account.id).not.toBe(owner.id);
      expect(response.cookies.some(cookie => cookie.name === 'eko_sid')).toBe(true);
    }
    expect(await built.ctx.auth.fromToken(owner.token)).toMatchObject({ id: owner.id });
  });
  it('refuses every legacy order and journal mutation without a session', async () => {
    const id = randomUUID();
    const requests = [
      ['GET', '/api/portfolio', undefined],
      ['POST', '/api/portfolio/paper/reset', undefined],
      ['POST', '/api/quotes', { mode: 'paper', market: 'ETH-USD', side: 'buy', amountIn: '10', slippageBps: 50 }],
      ['POST', '/api/orders', { quoteId: 'fixture-quote', idempotencyKey: 'fixture-order' }],
      ['POST', '/api/orders/instant', { mode: 'paper', market: 'ETH-USD', side: 'buy', amountUsd: 10, idempotencyKey: 'fixture-instant' }],
      ['POST', `/api/orders/${id}/submitted`, { txHash }],
      ['POST', `/api/orders/${id}/rejected`, { code: 'user_rejected', message: 'Declined' }],
      ['POST', '/api/journal', { mode: 'paper', body: 'Fixture note' }],
      ['PATCH', `/api/journal/${id}`, { body: 'Changed note' }],
      ['DELETE', `/api/journal/${id}`, undefined],
    ] as const;
    for (const [method, url, payload] of requests) {
      expect((await call('', method, url, payload)).statusCode, `${method} ${url}`).toBe(401);
    }
  });
  it('foreign journal edits/deletes and invalid writes preserve the owner entry', async () => {
    const owner = await session(), foreign = await session();
    const created = await call(owner.cookie, 'POST', '/api/journal', { mode: 'paper', body: 'Owner note' });
    expect(created.statusCode).toBe(200);
    const entry = created.json().entry;
    expect((await call(foreign.cookie, 'PATCH', `/api/journal/${entry.id}`, { body: 'Foreign note' })).statusCode).toBe(404);
    // Delete is intentionally idempotent, with account ownership in its SQL predicate.
    expect((await call(foreign.cookie, 'DELETE', `/api/journal/${entry.id}`)).statusCode).toBe(200);
    for (const [method, url] of [['POST', '/api/journal'], ['PATCH', `/api/journal/${entry.id}`]] as const) {
      expect((await call(owner.cookie, method, url, { mode: 'paper', body: '' })).statusCode).toBe(400);
    }
    const rows = await built.ctx.dbh.db.select().from(journalEntries).where(and(eq(journalEntries.id, entry.id), eq(journalEntries.accountId, owner.id)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.body).toBe('Owner note');
  });
  it('foreign quote use, submission and rejection cannot consume or change owner orders', async () => {
    const owner = await session(), foreign = await session();
    const quote: Quote = {
      id: 'fixture-bound-quote', mode: 'testnet', market: 'ETH-USD', side: 'buy', network: 'robinhood-testnet',
      venue: 'fixture', venueName: 'Fixture', assetIn: 'USDG', assetOut: 'ETH', amountIn: 10, expectedOut: 1,
      minOut: 0.9, price: 10, referenceMid: 10, priceImpactBps: 0, slippageBps: 50,
      fees: [], quotedAt: Date.now(), expiresAt: Date.now() + 60_000, latencyMs: 0,
      priceSource: 'fixture', simulated: false, account: `0x${'ab'.repeat(20)}`, warnings: [],
      tx: { chainId: 46630, approval: null, swap: { to: `0x${'cd'.repeat(20)}`, data: '0x1234', value: '0' },
        amountInRaw: '10', minOutRaw: '1', tokenIn: { address: `0x${'ef'.repeat(20)}`, decimals: 6, symbol: 'USDG' },
        tokenOut: { address: `0x${'01'.repeat(20)}`, decimals: 18, symbol: 'ETH' } },
    };
    const store = new QuoteStore(); store.put(quote, owner.id);
    const adapter = {} as ExecutionAdapter;
    const exec = new ExecutionService(built.ctx.dbh.db, built.ctx.market, built.ctx.portfolio, store,
      { testnet: adapter, live: adapter }, { liveEnabled: false, paperFeeBps: 10 }, { onOrder: vi.fn(), onPortfolio: vi.fn() });
    const prior = built.ctx.exec; built.ctx.exec = exec;
    try {
      const input = { quoteId: quote.id, idempotencyKey: 'fixture-bound-order' };
      expect((await call(foreign.cookie, 'POST', '/api/orders', input)).json().error).toBe('quote_not_found');
      expect(store.get(quote.id)!.consumed).toBe(false);
      const placed = await exec.place(owner.id, quote.account!, input);
      for (const [path, payload] of [['submitted', { txHash }], ['rejected', { code: 'user_rejected', message: 'Declined' }]] as const) {
        const response = await call(foreign.cookie, 'POST', `/api/orders/${placed.order.id}/${path}`, payload);
        expect(response.statusCode).toBe(404); expect(response.json().error).toBe('order_not_found');
      }
      const invalid = await call(owner.cookie, 'POST', `/api/orders/${placed.order.id}/submitted`, { txHash: '0x1234' });
      expect(invalid.statusCode).toBe(400); expect(invalid.json().error).toBe('bad_hash');
      const [row] = await built.ctx.dbh.db.select().from(orders).where(eq(orders.id, placed.order.id));
      expect(row).toMatchObject({ accountId: owner.id, status: 'awaiting_signature', txHash: null, errorCode: null });
      expect((await call(owner.cookie, 'POST', `/api/orders/${placed.order.id}/rejected`, { code: 'user_rejected', message: 'Declined' })).json().order.status).toBe('rejected');
      expect((await call(owner.cookie, 'POST', `/api/orders/${placed.order.id}/submitted`, { txHash })).json().error).toBe('bad_state');
    } finally { built.ctx.exec = prior; }
  });
});
