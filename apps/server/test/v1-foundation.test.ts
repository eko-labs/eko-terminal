import { createHmac } from 'node:crypto';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { eq } from 'drizzle-orm';
import { ApiErrorSchema, ErrorCodeSchema, FLAG_STAGES, FlagsSchema, PublicConfigSchema, type ErrorCode, type FlagName } from '@eko/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildApp } from '../src/app.js';
import { loadRegistry } from '@eko/chain';
import { loadConfig } from '../src/config.js';
import { featureFlags } from '../src/db/schema.js';
import { FlagService, parseFlagOverride } from '../src/flags/service.js';
import { phaseAt } from '../src/http/v1/config.js';
import { createDemoToken, DEMO_COOKIE, DEMO_TTL_MS, installDemoGuard, verifyDemoToken } from '../src/http/v1/demo.js';
import { ERROR_STATUS, InputError, list, notFound, parseInput, routeHelpers, sendError } from '../src/http/v1/helpers.js';

const secret = 'test-demo-placeholder'.repeat(2);
const base = { NODE_ENV: 'test', PGLITE_DIR: ':memory:', SESSION_SECRET: 'test-session-placeholder'.repeat(2), DEMO_SECRET: secret };

describe('v1 environment and phase', () => {
  it('defaults legacy compatibility and validates new env inputs before boot', () => {
    const cfg = loadConfig(base);
    expect(cfg.LEGACY_API).toBe(true);
    expect(cfg.LEGACY_SIGNALS).toBe(false);
    expect(cfg.LIVE_TRADING_ENABLED).toBe(false);
    expect(cfg.AI_DAILY_BUDGET_USD).toBe(0);
    expect(cfg.FEE_BPS_DEFAULT).toBe(50);
    expect(cfg.TRADE_MAX_USD).toBeUndefined();
    expect(loadConfig({ ...base, FLAGS: 'd0', LEGACY_API: 'false', LEGACY_SIGNALS: 'true', TRADE_MAX_USD: '25' })).toMatchObject({ LEGACY_API: false, LEGACY_SIGNALS: true, TRADE_MAX_USD: 25 });
    for (const FLAGS of ['typo', 'trading_live', 'swarm_ranking']) expect(() => loadConfig({ ...base, FLAGS })).toThrow('Unknown FLAGS');
    for (const extra of [{ BURN_WALLET_ADDRESS: 'bad' }, { RECEIPTS_REGISTRY_ADDRESS: 'bad' }, { DEV_FEE_WALLET: 'bad' }, { FEE_ACTIVE_FROM: 'tomorrow' }, { TIERS_ACTIVE_FROM: 'soon' }, { FEE_BPS_DEFAULT: '-1' }, { FEE_BPS_DEFAULT: '10001' }, { TRADE_MAX_USD: '0' }]) {
      expect(() => loadConfig({ ...base, ...extra })).toThrow('Invalid environment configuration');
    }
    const production = { DATABASE_URL: 'postgresql://example.invalid/fixture', RUN_WORKER: 'false', NODE_ENV: 'production', MARKET_DATA_SOURCE: 'demo' };
    expect(() => loadConfig({ ...base, ...production, DEMO_SECRET: undefined })).toThrow('DEMO_SECRET');
    // Money rule: the burn wallet is never the dev wallet, and production needs a real one.
    const wallet = `0x${'a'.repeat(40)}`;
    expect(() => loadConfig({ ...base, BURN_WALLET_ADDRESS: wallet, DEV_FEE_WALLET: wallet.toUpperCase().replace('0X', '0x') })).toThrow('must not be the dev wallet');
    expect(() => loadConfig({ ...base, ...production })).toThrow('BURN_WALLET_ADDRESS is required in production');
    expect(loadConfig({ ...base, ...production, BURN_WALLET_ADDRESS: wallet }).BURN_WALLET_ADDRESS).toBe(wallet);
  });

  it('changes phase exactly at each deployment clock boundary', () => {
    const fee = '2026-10-05T20:00:00Z';
    const tiers = '2026-10-12T20:00:00Z';
    const cfg = loadConfig({ ...base, FEE_ACTIVE_FROM: fee, TIERS_ACTIVE_FROM: tiers });
    expect(phaseAt(cfg, Date.parse(fee) - 1)).toBe('launch_week');
    expect(phaseAt(cfg, Date.parse(fee))).toBe('token_live');
    expect(phaseAt(cfg, Date.parse(tiers) - 1)).toBe('token_live');
    expect(phaseAt(cfg, Date.parse(tiers))).toBe('tiers');
    expect(phaseAt(loadConfig(base), Date.parse(tiers))).toBe('launch_week');
  });
});

describe('v1 helpers', () => {
  const expected: Record<ErrorCode, number> = {
    bad_request: 422, unauthorized: 401, wallet_auth_required: 401, tier_required: 422,
    quota_exceeded: 429, rate_limited: 429, not_found: 404, guard_refused: 422,
    stale_data: 422, trade_cap_exceeded: 422, trading_paused: 422, sanctioned: 422,
    quote_changed: 422, quote_expired: 422, anti_snipe_active: 422, no_route: 422,
    sim_unavailable: 503, approval_required: 422, wallet_mismatch: 422, payment_required: 402,
    internal_error: 500, conflict: 409, forbidden: 403, not_allowlisted: 403,
  };
  it('covers every shared error code with the specified HTTP status and error body', async () => {
    const app = Fastify();
    app.get('/:code', async (req, reply) => sendError(reply, (req.params as { code: ErrorCode }).code, 'Example', { requiredTier: 'listener', retryAfterSec: 10 }));
    try {
      expect(Object.keys(ERROR_STATUS).sort()).toEqual([...ErrorCodeSchema.options].sort());
      for (const code of ErrorCodeSchema.options) {
        const result = await app.inject({ url: `/${code}` });
        expect(result.statusCode, code).toBe(expected[code]);
        expect(ApiErrorSchema.parse(result.json())).toEqual({ error: code, message: 'Example', requiredTier: 'listener', retryAfterSec: 10 });
      }
    } finally { await app.close(); }
  });

  it('parses all three input surfaces and answers bad_request for zod failures', async () => {
    const app = Fastify();
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof InputError) return sendError(reply, 'bad_request', err.message);
      throw err;
    });
    app.post('/:id', async (req) => parseInput(req, {
      params: z.object({ id: z.coerce.number().int().positive() }),
      query: z.object({ limit: z.coerce.number().int().positive() }),
      body: z.object({ enabled: z.boolean() }),
    }));
    try {
      const valid = await app.inject({ method: 'POST', url: '/1?limit=2', payload: { enabled: true } });
      expect(valid.json()).toEqual({ params: { id: 1 }, query: { limit: 2 }, body: { enabled: true } });
      for (const [url, payload] of [['/x?limit=2', { enabled: true }], ['/1?limit=x', { enabled: true }], ['/1?limit=2', { enabled: 'true' }]] as const) {
        const invalid = await app.inject({ method: 'POST', url, payload });
        expect(invalid.statusCode).toBe(422);
        expect(invalid.json().error).toBe('bad_request');
      }
      expect(list([1])).toEqual({ rows: [1], cursor: null });
      expect(list([1], 'next', 60)).toEqual({ rows: [1], cursor: 'next', delayedSec: 60 });
    } finally { await app.close(); }
  });
});

describe('feature flags and runtime route hiding', () => {
  it('merges only shared flags, caches ten seconds, separates ops, and coalesces concurrent reads', async () => {
    let now = 0;
    let calls = 0;
    const rows = [
      { key: 'approvals', enabled: true, audience: 'public' },
      { key: 'mission_kill', enabled: false, audience: 'public' },
      { key: 'trading_live', enabled: true, audience: 'public' },
      { key: 'swarm_ranking', enabled: true, audience: 'public' },
      { key: 'arena', enabled: true, audience: 'private' },
      { key: 'future_unknown', enabled: true, audience: 'public' },
    ];
    const flags = new FlagService(async () => { calls++; return rows; }, 'mission_kill', () => now);
    const [all] = await Promise.all([flags.all(), flags.all()]);
    expect(calls).toBe(1);
    expect(FlagsSchema.parse(all)).toMatchObject({ approvals: true, mission_kill: true, arena: false });
    expect(all).not.toHaveProperty('trading_live');
    expect(all).not.toHaveProperty('swarm_ranking');
    expect(all).not.toHaveProperty('future_unknown');
    expect(await flags.isOpsOn('trading_live')).toBe(true);
    // A raw ops row cannot bypass the Swarm calibration acceptance gate.
    expect(await flags.isOpsOn('swarm_ranking')).toBe(false);
    rows[0]!.enabled = false;
    all.approvals = false; // Callers can't alter the cached snapshot.
    now = 9999;
    expect(await flags.isOn('approvals')).toBe(true);
    now = 10000;
    expect(await flags.isOn('approvals')).toBe(false);
    expect(calls).toBe(3); // Product refresh plus an independent durable trading-switch read.
    const d0 = new FlagService(async () => [], 'd0');
    for (const flag of Object.values(FLAG_STAGES).flat()) expect(await d0.isOn(flag)).toBe((FLAG_STAGES.D0 as readonly FlagName[]).includes(flag));
    for (const override of ['trading_live', 'swarm_ranking', 'unknown']) expect(() => parseFlagOverride(override)).toThrow('Unknown FLAGS');
  });

  it('keeps serving the last known flags when a refresh fails, and surfaces the error when it has none', async () => {
    let now = 0, fail = false;
    const service = new FlagService(async () => { if (fail) throw new Error('db down'); return [{ key: 'approvals', enabled: true, audience: 'public' }]; }, '', () => now);
    expect(await service.isOn('approvals')).toBe(true);
    fail = true; now += 10_001;
    expect(await service.isOn('approvals')).toBe(true);
    await expect(new FlagService(async () => { throw new Error('db down'); }).all()).rejects.toThrow('db down');
  });

  it('makes an off route identical to unknown and reacts at the cache boundary, including demo overrides', async () => {
    let now = 0;
    let enabled = false;
    const flags = new FlagService(async () => [{ key: 'approvals', enabled, audience: 'public' }], '', () => now);
    const app = Fastify();
    await app.register(cookie);
    installDemoGuard(app, loadConfig(base));
    app.setNotFoundHandler((_req, reply) => notFound(reply));
    const { flagged } = routeHelpers(flags);
    app.get('/flagged', flagged('approvals', async () => ({ ok: true })));
    try {
      const unknown = await app.inject('/unknown');
      const off = await app.inject('/flagged');
      expect(off.statusCode).toBe(404);
      expect(off.body).toBe(unknown.body);
      enabled = true;
      now = 9999;
      expect((await app.inject('/flagged')).statusCode).toBe(404);
      now = 10000;
      expect((await app.inject('/flagged')).statusCode).toBe(200);
      enabled = false;
      now = 20000;
      expect((await app.inject('/flagged')).statusCode).toBe(404);
      const token = createDemoToken(['approvals'], secret);
      expect((await app.inject({ url: '/flagged', headers: { cookie: `${DEMO_COOKIE}=${token}` } })).statusCode).toBe(200);
      expect((await app.inject('/flagged')).statusCode).toBe(404);
    } finally { await app.close(); }
  });
});

describe('HMAC demo tokens', () => {
  it('accepts only intact flag-only tokens within 24 hours', () => {
    const now = Date.now();
    const token = createDemoToken(['approvals', 'mission_kill'], secret, now);
    expect(verifyDemoToken(token, secret, now)).toEqual({ flags: ['approvals', 'mission_kill'], expiry: now + DEMO_TTL_MS });
    expect(verifyDemoToken(token, secret, now + DEMO_TTL_MS)).toBeNull();
    expect(verifyDemoToken(token, 'wrong-secret', now)).toBeNull();
    expect(verifyDemoToken(token, undefined, now)).toBeNull();
    for (const bad of ['bad', `${token}x`, `${token}.extra`, `x${token}`, token.replace('.', '=.')]) expect(verifyDemoToken(bad, secret, now)).toBeNull();
    const signed = (payload: unknown) => {
      const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
      return `${encoded}.${createHmac('sha256', secret).update(encoded).digest('base64url')}`;
    };
    for (const payload of [
      { flags: ['trading_live'], expiry: now + 1000 },
      { flags: ['swarm_ranking'], expiry: now + 1000 },
      { flags: ['unknown'], expiry: now + 1000 },
      { flags: ['approvals'], expiry: now + 1000, liveEnabled: true },
      { flags: ['approvals'], expiry: now + DEMO_TTL_MS + 1 },
    ]) expect(verifyDemoToken(signed(payload), secret, now)).toBeNull();
    expect(() => createDemoToken(['trading_live' as FlagName], secret)).toThrow();
    expect(() => createDemoToken([], '')).toThrow('DEMO_SECRET');
  });
});

describe('v1 config and demo sessions against migrated storage', () => {
  let built: Awaited<ReturnType<typeof buildApp>>;
  const burn = `0x${'1'.repeat(40)}`;
  const dev = `0x${'2'.repeat(40)}`;
  const registry = `0x${'3'.repeat(40)}`;
  beforeAll(async () => {
    built = await buildApp(loadConfig({ ...base, BURN_WALLET_ADDRESS: burn, DEV_FEE_WALLET: dev, RECEIPTS_REGISTRY_ADDRESS: registry, TRADE_MAX_USD: '25', LEGACY_SIGNALS: 'true' }), { startBackground: false });
    await built.ctx.dbh.db.insert(featureFlags).values([
      { key: 'trading_live', enabled: true },
      { key: 'swarm_ranking', enabled: true },
    ]);
  });
  afterAll(async () => { await built.close(); });

  it('returns a schema-valid config, health, cache headers, and no dev-wallet destination', async () => {
    const health = await built.app.inject('/v1/health');
    expect(health.statusCode).toBe(200); // Disabled loops do not block deployment liveness.
    expect(health.json()).toEqual({ ok: true, loops: {
      refresher: { name: 'refresher', stale: true, periodSec: 0.25, lastCycleAt: null },
      ranks: { name: 'ranks', stale: true, periodSec: 5, lastCycleAt: null },
      summaries: { name: 'summaries', stale: true, periodSec: 5, lastCycleAt: null },
    }, rpc: { day: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), today: [], refusedToday: 0, paidCalls: 0, paidDegraded: false, nonIndexerCalls: 0, paidOpen: true, budgetLeft: 800000, sessionUnits: 0 } });
    const result = await built.app.inject('/v1/config');
    expect(result.statusCode).toBe(200);
    expect(result.headers['cache-control']).toBe('public, max-age=10');
    expect(result.headers.vary).toContain('Cookie');
    expect(result.headers.vary).toContain('Origin');
    const config = PublicConfigSchema.parse(result.json());
    const router = loadRegistry().requireAddress('uniswapV3.swapRouter02').toLowerCase();
    // The verified v4 UniversalRouter settles sells through Permit2, so both are listed (with Permit2's address for its approval step).
    const universalRouter = loadRegistry().requireAddress('uniswapV4.universalRouter').toLowerCase(), permit2 = loadRegistry().requireAddress('uniswapV4.permit2').toLowerCase();
    expect(config).toMatchObject({ phase: 'launch_week', wallets: { burn, dev }, contracts: { receiptsRegistry: registry },
      trading: { liveEnabled: false, maxTradeUsd: 25, routers: [router, universalRouter], spenders: [router, permit2], permit2 } });
    const { wallets: { dev: disclosed, ...wallets }, ...rest } = config;
    expect(disclosed).toBe(dev);
    expect(JSON.stringify({ wallets, ...rest })).not.toContain(dev);
    expect(config).not.toHaveProperty('team');
    expect(config.contracts).not.toHaveProperty('burnEngine');
    expect(config.flags).not.toHaveProperty('trading_live');
  });

  it('uses both the deployment ceiling and runtime ops switch for liveEnabled', async () => {
    // Invalidate via a controlled service clock, without waiting ten real seconds.
    let now = 0;
    const db = built.ctx.dbh.db;
    const service = new FlagService(() => db.select().from(featureFlags), '', () => now);
    const app = Fastify();
    await app.register(cookie);
    installDemoGuard(app, built.ctx.cfg);
    const { registerV1 } = await import('../src/http/v1/index.js');
    const cfg = { ...built.ctx.cfg, LIVE_TRADING_ENABLED: true };
    await registerV1(app, cfg, service, () => built.ctx.chains.meter.usage());
    try {
      expect((await app.inject('/v1/config')).json().trading.liveEnabled).toBe(true);
      await db.update(featureFlags).set({ enabled: false }).where(eq(featureFlags.key, 'trading_live'));
      now = 9999;
      expect((await app.inject('/v1/config')).json().trading.liveEnabled).toBe(false);
      now = 10000;
      expect((await app.inject('/v1/config')).json().trading.liveEnabled).toBe(false);
      cfg.LIVE_TRADING_ENABLED = false;
      await db.update(featureFlags).set({ enabled: true }).where(eq(featureFlags.key, 'trading_live'));
      now = 20000;
      expect((await app.inject('/v1/config')).json().trading.liveEnabled).toBe(false);
    } finally { await app.close(); }
  });

  it('keeps overrides in one session, leaves ops/wallets untouched, and forbids all HTTP writes', async () => {
    const token = createDemoToken(['approvals', 'mission_kill'], secret);
    const before = (await built.app.inject('/v1/config')).json();
    const demo = await built.app.inject(`/v1/demo/${token}`);
    expect(demo.statusCode).toBe(200);
    const marker = demo.cookies.find((c) => c.name === DEMO_COOKIE)!;
    expect(marker.httpOnly).toBe(true);
    expect(marker.sameSite).toBe('Lax');
    expect(marker.maxAge).toBeLessThanOrEqual(86400);
    const cookieHeader = `${marker.name}=${marker.value}`;
    const response = await built.app.inject({ url: '/v1/config', headers: { cookie: cookieHeader } });
    expect(response.headers['cache-control']).toBe('private, no-store');
    const after = PublicConfigSchema.parse(response.json());
    expect(after.flags).toMatchObject({ approvals: true, mission_kill: true });
    expect(after.trading).toEqual(before.trading);
    expect(after.wallets).toEqual(before.wallets);
    expect(after.contracts).toEqual(before.contracts);
    expect((await built.app.inject('/v1/config')).json()).toEqual(before);
    for (const [method, url] of [['POST', '/api/orders'], ['POST', '/api/quotes'], ['POST', '/api/journal'], ['PUT', '/api/preferences'], ['PATCH', '/api/journal/1'], ['DELETE', '/api/journal/1'], ['POST', '/v1/future-write']] as const) {
      const denied = await built.app.inject({ method, url, headers: { cookie: cookieHeader }, payload: {} });
      expect(denied.statusCode, url).toBe(403);
      expect(denied.json()).toEqual({ error: 'forbidden', message: 'Demo sessions cannot write' });
    }
    // Signing in or out and telemetry stay open, so a demo link never locks a visitor out of their wallet.
    for (const url of ['/api/auth/verify', '/api/auth/logout', '/api/telemetry']) {
      const allowed = await built.app.inject({ method: 'POST', url, headers: { cookie: cookieHeader }, payload: {} });
      expect(allowed.statusCode === 403 && allowed.json().message === 'Demo sessions cannot write', url).toBe(false);
    }
    const unknown = await built.app.inject('/v1/unknown');
    for (const bad of ['bad', `${token}x`, createDemoToken(['approvals'], secret, Date.now() - DEMO_TTL_MS - 1)]) {
      const result = await built.app.inject(`/v1/demo/${bad}`);
      expect(result.statusCode).toBe(404);
      expect(result.body).toBe(unknown.body);
      expect(result.cookies).toEqual([]);
    }
  });
});

describe('legacy registration switches', () => {
  it.each([
    ['true', 'true'], ['true', 'false'], ['false', 'true'], ['false', 'false'],
  ])('LEGACY_API=%s / LEGACY_SIGNALS=%s keeps observability and v1 available', async (LEGACY_API, LEGACY_SIGNALS) => {
    const built = await buildApp(loadConfig({ ...base, LEGACY_API, LEGACY_SIGNALS, ENABLE_DEV_ROUTES: 'true' }), { startBackground: false });
    try {
      for (const url of ['/api/health/live', '/api/metrics', '/v1/config', '/v1/health']) expect((await built.app.inject(url)).statusCode, url).toBe(200);
      for (const url of ['/api/health']) {
        const response = await built.app.inject(url);
        expect(response.statusCode, url).toBe(503);
        expect(response.json().ok).toBe(false);
        expect(response.json().loops.refresher).toEqual({ ok: false, periodMs: 250, lastCycleAt: null });
      }
      const loops = await built.app.inject('/v1/health/loops');
      expect(loops.statusCode).toBe(503);
      expect(loops.json().ok).toBe(true);
      expect(loops.json().loops.refresher).toEqual({ name: 'refresher', stale: true, periodSec: 0.25, lastCycleAt: null });
      expect((await built.app.inject('/api/health/ready')).statusCode).toBe(503); // Registered but not backfilled.
      expect((await built.app.inject({ method: 'POST', url: '/api/telemetry', payload: {} })).statusCode).toBe(200);
      for (const url of ['/api/config', '/api/session', '/api/tickers']) expect((await built.app.inject(url)).statusCode, url).toBe(LEGACY_API === 'true' ? 200 : 404);
      for (const url of ['/api/bots', '/api/signals', '/api/replay?market=ETH-USD&from=0&to=1']) expect((await built.app.inject(url)).statusCode, url).toBe(404);
      for (const [method, url] of [['POST', '/api/orders'], ['POST', '/api/quotes'], ['GET', '/api/chain/balances?mode=live']] as const) {
        const status = (await built.app.inject({ method, url, payload: method === 'POST' ? {} : undefined })).statusCode;
        if (LEGACY_API === 'false') expect(status, url).toBe(404);
        else expect(status, url).not.toBe(404);
      }
      // Retired detail, mutation, moderation and fixture routes never register.
      for (const url of ['/api/signals/:id', '/api/bots/:id', '/api/admin/reviews']) expect(built.app.hasRoute({ method: 'GET', url }), url).toBe(false);
      for (const url of ['/api/bots', '/api/bots/:id/analyze', '/api/admin/reviews/:botId/:version', '/api/dev/signals/inject']) expect(built.app.hasRoute({ method: 'POST', url }), url).toBe(false);
    } finally { await built.close(); }
  });
});
