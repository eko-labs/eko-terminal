import { SanctionsWorker } from '../src/sanctions/service.js';
import { listedWallet, sdnFixture, seedSanctions } from './sanctions-fixture.js';
import { loadRegistry } from '@eko/chain';
import type { Quote, TradeQuote } from '@eko/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig, parseTradeCaps } from '../src/config.js';
import { accounts, auditLog, featureFlags, orders, tradingAllowlist } from '../src/db/schema.js';
import { ExecutionService } from '../src/exec/service.js';
import { QuoteStore } from '../src/exec/quotes.js';
import { TradeAccessService, type AllowlistRow } from '../src/exec/trade-access.js';
import type { ExecutionAdapter } from '../src/exec/types.js';
import { FlagService } from '../src/flags/service.js';
import { createDemoToken } from '../src/http/v1/demo.js';

const wallet = `0x${'a'.repeat(40)}`;
const betaWallet = `0x${'b'.repeat(40)}`;
const outsider = `0x${'c'.repeat(40)}`;
const origin = 'https://app.eko.example';
const secret = 'trade-fixture-placeholder'.repeat(2);
const base = { NODE_ENV: 'test', PGLITE_DIR: ':memory:', SESSION_SECRET: secret, DEMO_SECRET: secret,
  LIVE_TRADING_ENABLED: 'true', PUBLIC_ORIGIN: origin, ADMIN_WALLETS: wallet };
const launch = Date.parse('2026-10-13T20:00:00Z');
const released = `beta:\n  defaultCapUsd: { team: 25, beta_user: 100 }\npublic:\n  - { afterHours: 0, perTradeUsd: 250 }\n  - { afterHours: 72, perTradeUsd: 1000 }\ndailyPerWalletUsd: null`;

describe('config schedule and release boundaries (offline fixtures)', () => {
  it('parses the spec YAML and refuses malformed, unordered, early increases and unsupported daily caps', () => {
    expect(parseTradeCaps(released).public).toHaveLength(2);
    for (const text of [released.replace('72', '0'), released.replace('72', '71.999'), released.replace('team: 25', 'team: 26'), released.replace('null', '100'), released.replace('afterHours: 0', 'afterHours: 1'), `${released}\nunknown: true`, 'bad: ['])
      expect(() => parseTradeCaps(text)).toThrow();
    expect(() => loadConfig({ ...base, TRADE_CAPS_FROM: 'tomorrow' })).toThrow();
    expect(() => loadConfig({ ...base, TRADING_ALLOWLIST_ONLY: 'maybe' })).toThrow();
    expect(() => loadConfig({ ...base, TRADE_CAPS_FILE: '/tmp/nonexistent-trade-caps-fixture.yaml' })).toThrow();
    expect(loadConfig(base).tradeCaps.public).toEqual([{ afterHours: 0, perTradeUsd: 250 }]);
  });

  it('holds $250 indefinitely until a config release; evaluates approved steps exactly at 72h with absolute ceilings', async () => {
    let now = launch - 1;
    const cfg = loadConfig({ ...base, TRADING_ALLOWLIST_ONLY: 'false', TRADE_CAPS_FROM: new Date(launch).toISOString() });
    const flags = new FlagService(async () => [{ key: 'trading_live', enabled: true, audience: 'public' }]);
    const access = new TradeAccessService(cfg, flags, async () => undefined, () => now);
    expect(await access.cap()).toBe(0);
    expect((await access.refusal(outsider, 1))?.code).toBe('trade_cap_exceeded');
    now = launch; expect(await access.cap()).toBe(250);
    expect(await access.refusal(outsider, 250)).toBeNull();
    expect((await access.refusal(outsider, 250.01))?.code).toBe('trade_cap_exceeded');
    now = launch + 72 * 3_600_000; expect(await access.cap()).toBe(250);
    cfg.tradeCaps = parseTradeCaps(released); // Explicit config release fixture, not approval evidence.
    now--; expect(await access.cap()).toBe(250);
    now++; expect(await access.cap()).toBe(1000);
    expect(await access.refusal(outsider, 1000)).toBeNull();
    expect((await access.refusal(outsider, 1000.01))?.code).toBe('trade_cap_exceeded');
    cfg.TRADE_MAX_USD = 250; expect(await access.cap()).toBe(250);
    cfg.TRADE_CAPS_FROM = undefined; expect(await access.cap()).toBe(0);
  });

  it('keeps demo quotes informational and never treats them as executable approval', async () => {
    const cfg = loadConfig(base);
    const flags = new FlagService(async () => [{ key: 'trading_live', enabled: true, audience: 'public' }]);
    const row = { role: 'team', capUsd: 20 } as AllowlistRow;
    const access = new TradeAccessService(cfg, flags, async () => row);
    const quote = { account: wallet, amountUsd: 20, binding: true, guard: { decision: 'allow', checks: [] }, fee: { bps: 0, usd: 0, destination: null } } as unknown as TradeQuote;
    expect(await access.informationalQuote(quote, true)).toMatchObject({ binding: false, guard: { decision: 'refuse', checks: [{ code: 'forbidden' }] }, fee: quote.fee });
    await expect(access.assertOrder(wallet, 20, true)).rejects.toMatchObject({ code: 'forbidden' });
    const registry = loadRegistry(), v4 = registry.data.uniswapV4;
    // Verified manifests: the v3 router, plus the v4 UniversalRouter and Permit2 (whose approval step needs its address).
    expect(new TradeAccessService(cfg, flags, async () => row, Date.now, registry).verifiedTargets()).toEqual({
      routers: [registry.requireAddress('uniswapV3.swapRouter02'), v4.universalRouter.address],
      spenders: [registry.requireAddress('uniswapV3.swapRouter02'), v4.permit2.address], permit2: v4.permit2.address });
    registry.data.uniswapV3.swapRouter02.check = 'VERIFY_ABI';
    expect(new TradeAccessService(cfg, flags, async () => row, Date.now, registry).verifiedTargets()).toEqual({
      routers: [v4.universalRouter.address], spenders: [v4.permit2.address], permit2: v4.permit2.address });
    v4.permit2.check = 'VERIFY';
    expect(new TradeAccessService(cfg, flags, async () => row, Date.now, registry).verifiedTargets()).toEqual({ routers: [], spenders: [] });
    row.capUsd = NaN;
    expect((await access.refusal(wallet, 1))?.code).toBe('trade_cap_exceeded');
  });
});

describe('migrated storage, admin routes and execution revalidation (no chain calls)', () => {
  let built: Awaited<ReturnType<typeof buildApp>>;
  let adminCookie: string, userCookie: string, accountId: string;
  let now = Date.now(), enabled = true, readFails = false;
  let access: TradeAccessService, exec: ExecutionService;
  const router = loadRegistry().requireAddress('uniswapV3.swapRouter02');
  const universalRouter = loadRegistry().requireAddress('uniswapV4.universalRouter'), permit2 = loadRegistry().requireAddress('uniswapV4.permit2');
  const quote = (id: string, side: 'buy' | 'sell', amountIn: number, account = wallet): Quote => ({
    id, mode: 'live', market: 'ETH-USD', side, network: 'robinhood-mainnet', venue: 'uniswap-v3', venueName: 'Uniswap v3',
    assetIn: side === 'buy' ? 'USDG' : 'ETH', assetOut: side === 'buy' ? 'ETH' : 'USDG', amountIn,
    expectedOut: side === 'buy' ? amountIn / 2000 : amountIn * 2000, minOut: 0.001,
    price: 2000, referenceMid: 2000, priceImpactBps: 0, slippageBps: 50, fees: [{ label: 'Fixture fee', amount: 0, asset: 'USD', estimated: false }],
    quotedAt: now, expiresAt: now + 20000, latencyMs: 1, priceSource: 'offline fixture', simulated: false, account,
    tx: { chainId: 4663, approval: null, swap: { to: router, data: '0x1234', value: '0' }, amountInRaw: '1', minOutRaw: '1',
      tokenIn: { address: router, decimals: 18, symbol: 'ETH' }, tokenOut: { address: router, decimals: 6, symbol: 'USDG' } }, warnings: [],
  });
  const adapter = { quote: vi.fn(async input => quote(input.id, input.side, input.amountIn, input.account)) } as unknown as ExecutionAdapter;
  let quoteStore: QuoteStore;
  const call = (cookie: string, method: 'GET' | 'PUT' | 'DELETE' | 'POST', url: string, payload?: object, from = origin) =>
    built.app.inject({ method, url, headers: { cookie, origin: from }, ...(payload ? { payload } : {}) });
  beforeAll(async () => {
    built = await buildApp(loadConfig(base), { startBackground: false });
    await seedSanctions(built.ctx.dbh.chain);
    const db = built.ctx.dbh.db;
    const [admin, user] = await db.insert(accounts).values([{ kind: 'wallet', walletAddress: wallet }, { kind: 'wallet', walletAddress: betaWallet }]).returning();
    accountId = admin!.id;
    const cookieFor = async (id: string) => `eko_sid=${encodeURIComponent(built.app.signCookie(await built.ctx.auth.createSession(id)))}`;
    adminCookie = await cookieFor(accountId); userCookie = await cookieFor(user!.id);
    const flags = new FlagService(async () => { if (readFails) throw new Error('fixture db unavailable'); return [{ key: 'trading_live', enabled, audience: 'public' }]; }, '', () => now);
    access = new TradeAccessService(built.ctx.cfg, flags, async wallet => (await db.select().from(tradingAllowlist).where(eq(tradingAllowlist.wallet, wallet)))[0], () => now);
    quoteStore = new QuoteStore(() => now);
    exec = new ExecutionService(db, built.ctx.market, built.ctx.portfolio, quoteStore, { testnet: adapter, live: adapter },
      { liveEnabled: true, paperFeeBps: 10, tradeAccess: access, sanctions: built.ctx.sanctions }, { onOrder: () => {}, onPortfolio: () => {} }, () => now);
    built.ctx.exec = exec;
  });
  afterAll(async () => { await built.close(); });

  it('requires wallet admin and allowed origin; enforces lower-only overrides and audits successful changes', async () => {
    const path = `/v1/admin/trading/allowlist/${wallet}`;
    const payload = { role: 'team' };
    for (const [cookie, status] of [['', 401], [userCookie, 403]] as const) {
      expect((await call(cookie, 'PUT', path, payload)).statusCode).toBe(status);
      expect((await call(cookie, 'PUT', '/v1/admin/trading/live', { enabled: true })).statusCode).toBe(status);
      expect((await call(cookie, 'DELETE', path)).statusCode).toBe(status);
    }
    expect((await call(adminCookie, 'PUT', path, payload, 'https://evil.example')).statusCode).toBe(403);
    expect((await call(adminCookie, 'PUT', path, { ...payload, capUsd: 26 })).statusCode).toBe(422);
    expect((await call(adminCookie, 'PUT', path, payload)).json()).toMatchObject({ wallet, role: 'team', capUsd: 25, addedBy: accountId });
    expect((await call(adminCookie, 'PUT', `/v1/admin/trading/allowlist/${betaWallet}`, { role: 'beta_user' })).json().capUsd).toBe(100);
    expect((await call(adminCookie, 'PUT', path, { ...payload, capUsd: 20 })).statusCode).toBe(200);
    expect((await call(adminCookie, 'GET', '/v1/admin/trading/allowlist')).json().rows).toHaveLength(2);
    const config = await call(adminCookie, 'GET', '/v1/config');
    expect(config.headers['cache-control']).toBe('private, no-store'); expect(config.json().trading).toMatchObject({ maxTradeUsd: 20,
      routers: [router.toLowerCase(), universalRouter.toLowerCase()], spenders: [router.toLowerCase(), permit2.toLowerCase()], permit2: permit2.toLowerCase() });
    expect((await built.ctx.dbh.db.select().from(auditLog).where(eq(auditLog.action, 'trading.allowlist_upsert')))).toHaveLength(3);
    expect((await built.ctx.dbh.db.select().from(auditLog).where(eq(auditLog.action, 'trading.config_loaded')))[0]!.data).toMatchObject({ hash: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });

  it('keeps quotes and fee lines visible but strips tx bytes on refusals; values sells in USD too', async () => {
    expect(await access.refusal(wallet.toUpperCase(), 20)).toBeNull();
    expect((await access.refusal(wallet, 20.01))?.code).toBe('trade_cap_exceeded');
    expect(await access.refusal(betaWallet, 100)).toBeNull();
    expect((await access.refusal(betaWallet, 100.01))?.code).toBe('trade_cap_exceeded');
    for (const [account, side, amountIn, code] of [[outsider, 'buy', 10, 'not_allowlisted'], [wallet, 'buy', 21, 'trade_cap_exceeded'], [wallet, 'sell', 0.02, 'trade_cap_exceeded']] as const) {
      const result = await exec.quote(accountId, { mode: 'live', market: 'ETH-USD', side, amountIn: String(amountIn), slippageBps: 50, account });
      expect(result.tx).toBeUndefined(); expect(result.fees).toHaveLength(1); expect(result.warnings[0]).toContain(code);
      await expect(exec.place(accountId, account, { quoteId: result.id, idempotencyKey: result.id })).rejects.toMatchObject({ code });
    }
    expect(await built.ctx.dbh.db.select().from(orders)).toHaveLength(0);
  });

  it('revalidates current caps/membership and immediate runtime switch on orders and idempotent retries', async () => {
    const fresh = async (id: string) => { quoteStore.put(quote(id, 'buy', 20), accountId); return { quoteId: id, idempotencyKey: id }; };
    const first = await fresh('access-first');
    await expect(exec.place(accountId, wallet, first)).rejects.toMatchObject({ code: 'guard_refused' });
    // Persist an older awaiting-signature intent to exercise retained live retry admission too.
    const retained = quote('access-first', 'buy', 20);
    await built.ctx.dbh.db.insert(orders).values({ accountId, mode: 'live', market: retained.market, side: retained.side,
      network: retained.network, venue: retained.venue, assetIn: retained.assetIn, assetOut: retained.assetOut,
      amountIn: retained.amountIn, expectedOut: retained.expectedOut, minOut: retained.minOut, quotePrice: retained.price,
      slippageBps: retained.slippageBps, quote: retained, status: 'awaiting_signature', idempotencyKey: first.idempotencyKey });
    enabled = false;
    // Incident stops must apply immediately, even inside the product flag cache window.
    await expect(exec.place(accountId, wallet, first)).rejects.toMatchObject({ code: 'trading_paused' });
    now += 9999; await expect(exec.place(accountId, wallet, first)).rejects.toMatchObject({ code: 'trading_paused' });
    now++; await expect(exec.place(accountId, wallet, first)).rejects.toMatchObject({ code: 'trading_paused' });
    const paused = await exec.quote(accountId, { mode: 'live', market: 'ETH-USD', side: 'buy', amountIn: '10', slippageBps: 50, account: wallet });
    expect(paused.tx).toBeUndefined(); expect(paused.warnings[0]).toContain('Live trading paused');
    enabled = true; now += 10000;
    built.ctx.cfg.LIVE_TRADING_ENABLED = false;
    await expect(exec.place(accountId, wallet, await fresh('ceiling-off'))).rejects.toMatchObject({ code: 'trading_paused' });
    built.ctx.cfg.LIVE_TRADING_ENABLED = true;
    expect(await access.liveEnabled()).toBe(true);
    readFails = true; now += 10000; expect(await access.liveEnabled()).toBe(false);
    readFails = false; now += 10000; expect(await access.liveEnabled()).toBe(true);
    const lower = await fresh('changed-cap');
    await call(adminCookie, 'PUT', `/v1/admin/trading/allowlist/${wallet}`, { role: 'team', capUsd: 10 });
    await expect(exec.place(accountId, wallet, lower)).rejects.toMatchObject({ code: 'trade_cap_exceeded' });
    await call(adminCookie, 'DELETE', `/v1/admin/trading/allowlist/${wallet}`);
    await expect(exec.place(accountId, wallet, await fresh('removed-wallet'))).rejects.toMatchObject({ code: 'not_allowlisted' });
    expect((await built.ctx.dbh.db.select().from(auditLog).where(eq(auditLog.action, 'trading.allowlist_delete')))).toHaveLength(1);
  });

  it('demo sessions cannot write or return an unsigned order; admin switch is audited and cannot exceed the ceiling', async () => {
    const demo = `${adminCookie}; eko_demo=${createDemoToken(['approvals'], secret)}`;
    for (const [method, url, payload] of [['PUT', '/v1/admin/trading/live', { enabled: true }], ['PUT', `/v1/admin/trading/allowlist/${wallet}`, { role: 'team' }], ['POST', '/api/orders', { quoteId: 'access-first', idempotencyKey: 'access-first' }]] as const) {
      const result = await call(demo, method, url, payload);
      expect(result.statusCode).toBe(403); expect(result.json()).not.toHaveProperty('tx');
    }
    expect((await call(adminCookie, 'PUT', '/v1/admin/trading/live', { enabled: false })).statusCode).toBe(200);
    built.ctx.cfg.LIVE_TRADING_ENABLED = false;
    expect((await call(adminCookie, 'PUT', '/v1/admin/trading/live', { enabled: true })).json().error).toBe('trading_paused');
    const rows = await built.ctx.dbh.db.select().from(featureFlags).where(eq(featureFlags.key, 'trading_live'));
    expect(rows[0]!.enabled).toBe(false);
    expect((await built.ctx.dbh.db.select().from(auditLog).where(eq(auditLog.action, 'trading.live_changed')))).toHaveLength(1);
  });

  it('screens before quoting and rechecks new orders and idempotent retries after a refresh', async () => {
    built.ctx.cfg.LIVE_TRADING_ENABLED = true;
    const gate = vi.spyOn(access, 'refusal').mockResolvedValue(null);
    const input = { mode: 'live' as const, market: 'ETH-USD', side: 'buy' as const, amountIn: '10', slippageBps: 50, account: wallet };
    try {
      const q = await exec.quote(accountId, input);
      const first = { quoteId: q.id, idempotencyKey: 'sanctions-first' };
      await expect(exec.place(accountId, wallet, first)).rejects.toMatchObject({ code: 'guard_refused' });
      // Persist an older intent to exercise sanctions on retained live retries.
      const retained = quote(q.id, 'buy', 20);
      expect(q.tx).toBeUndefined();
      await built.ctx.dbh.db.insert(orders).values({ accountId, mode: 'live', market: retained.market, side: retained.side,
        network: retained.network, venue: retained.venue, assetIn: retained.assetIn, assetOut: retained.assetOut,
        amountIn: retained.amountIn, expectedOut: retained.expectedOut, minOut: retained.minOut, quotePrice: retained.price,
        slippageBps: retained.slippageBps, quote: retained, status: 'awaiting_signature', idempotencyKey: first.idempotencyKey });
      const pending = await exec.quote(accountId, input);
      await new SanctionsWorker(built.ctx.dbh.chain, 'https://ofac.treasury.gov/fixture.xml', async () => sdnFixture(wallet), () => Date.now() + 86400000).tick();
      adapter.quote = vi.fn(adapter.quote);
      const calls = vi.mocked(adapter.quote).mock.calls.length;
      const response = await call(adminCookie, 'POST', '/api/quotes', input);
      expect(response.statusCode).toBe(422);
      expect(response.json()).toEqual({ error: 'sanctioned', message: 'Trading is unavailable for this wallet.' });
      expect(vi.mocked(adapter.quote).mock.calls).toHaveLength(calls);
      for (const request of [first, { quoteId: pending.id, idempotencyKey: 'sanctions-pending' }]) {
        const response = await call(adminCookie, 'POST', '/api/orders', request);
        expect(response.statusCode).toBe(422);
        expect(response.json()).toEqual({ error: 'sanctioned', message: 'Trading is unavailable for this wallet.' });
      }
      await built.ctx.dbh.chain.sql.query('DELETE FROM ofac_sdn');
      const missing = await call(adminCookie, 'POST', '/api/quotes', { ...input, account: listedWallet });
      expect(missing.json()).toEqual({ error: 'stale_data', message: 'Trading checks are unavailable. Try again later.' });
    } finally { gate.mockRestore(); }
  });
});
