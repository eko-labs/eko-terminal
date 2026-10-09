import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_ONBOARDING, DEFAULT_PREFERENCES, PreferencesSchema, type OnboardingPrefs, type Preferences } from '@eko/shared';
import { buildApp, type Ctx } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { preferences } from '../src/db/schema.js';

let app: FastifyInstance;
let ctx: Ctx;
let close: () => Promise<void>;

beforeAll(async () => {
  const cfg = loadConfig({
    NODE_ENV: 'test',
    LEGACY_SIGNALS: 'true',
    PGLITE_DIR: ':memory:',
    MARKET_DATA_SOURCE: 'demo',
    SESSION_SECRET: 'o'.repeat(40),
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

type Session = { account: { id: string }; preferences: Preferences };

describe('onboarding preferences', () => {
  it('a new account starts with onboarding defaults (nothing done, welcome not seen)', async () => {
    const cookie = await newSession();
    const s = await call<Session>(cookie, 'GET', '/api/session');
    expect(s.body.preferences.onboarding).toEqual(DEFAULT_ONBOARDING);
    expect(s.body.preferences.onboarding).toMatchObject({ version: 0, welcomeDone: false, tourDone: false, checklistDismissed: false, liveIntroSeen: false });
    expect(Object.values(s.body.preferences.onboarding.checklist).every((v) => v === false)).toBe(true);
  });

  it('round-trips progress through PUT /api/preferences and GET /api/session', async () => {
    const cookie = await newSession();
    const s = await call<Session>(cookie, 'GET', '/api/session');
    const onboarding: OnboardingPrefs = {
      version: 1,
      welcomeDone: true,
      tourDone: true,
      checklist: { ...DEFAULT_ONBOARDING.checklist, paper_trade: true, scan_coin: true, open_evidence: true, scan_bags: true, guarded_trade: true, connect_agent: true },
      checklistDismissed: false,
      liveIntroSeen: true,
    };
    const put = await call<{ preferences: Preferences }>(cookie, 'PUT', '/api/preferences', { ...s.body.preferences, favorites: ['ETH-USD'], onboarding });
    expect(put.status).toBe(200);
    expect(put.body.preferences.onboarding).toEqual(onboarding);
    const again = await call<Session>(cookie, 'GET', '/api/session');
    expect(again.body.preferences.onboarding).toEqual(onboarding);
    // Saving onboarding progress leaves the rest of the preferences intact.
    expect(again.body.preferences.favorites).toEqual(['ETH-USD']);
    expect(again.body.preferences.quickAmounts).toEqual(DEFAULT_PREFERENCES.quickAmounts);
  });

  it('legacy stored preferences (no onboarding key) still parse, with onboarding defaults', async () => {
    const cookie = await newSession();
    const s = await call<Session>(cookie, 'GET', '/api/session');
    await ctx.dbh.db.insert(preferences).values({ accountId: s.body.account.id, data: { quickAmounts: [10, 20], defaultSlippageBps: 25, favorites: ['SOL-USD'] } });
    const again = await call<Session>(cookie, 'GET', '/api/session');
    expect(again.status).toBe(200);
    expect(again.body.preferences.quickAmounts).toEqual([10, 20]);
    expect(again.body.preferences.favorites).toEqual(['SOL-USD']);
    expect(again.body.preferences.onboarding).toEqual(DEFAULT_ONBOARDING);
  });

  it('a partial onboarding object fills in the missing fields', async () => {
    const cookie = await newSession();
    const s = await call<Session>(cookie, 'GET', '/api/session');
    await ctx.dbh.db.insert(preferences).values({ accountId: s.body.account.id, data: { onboarding: { welcomeDone: true, checklist: { paper_trade: true } } } });
    const again = await call<Session>(cookie, 'GET', '/api/session');
    expect(again.body.preferences.onboarding).toEqual({ ...DEFAULT_ONBOARDING, welcomeDone: true, checklist: { ...DEFAULT_ONBOARDING.checklist, paper_trade: true } });
  });

  it('a client that predates onboarding can still save its preferences', async () => {
    const cookie = await newSession();
    const legacyBody: Record<string, unknown> = { ...DEFAULT_PREFERENCES, quickAmounts: [5, 15] };
    delete legacyBody.onboarding;
    const put = await call<{ preferences: Preferences }>(cookie, 'PUT', '/api/preferences', legacyBody);
    expect(put.status).toBe(200);
    expect(put.body.preferences.onboarding).toEqual(DEFAULT_ONBOARDING);
  });

  it('rejects malformed onboarding progress', async () => {
    const cookie = await newSession();
    const bad = await call(cookie, 'PUT', '/api/preferences', { onboarding: { checklist: { paper_trade: 'yes' } } });
    expect(bad.status).toBe(400);
    const neg = await call(cookie, 'PUT', '/api/preferences', { onboarding: { version: -1 } });
    expect(neg.status).toBe(400);
  });

  it('the shared schema accepts every legacy shape the server may have stored', () => {
    for (const legacy of [{}, { quickAmounts: [1] }, { onboarding: {} }, { onboarding: { checklist: {} } }]) {
      const p = PreferencesSchema.parse({ ...DEFAULT_PREFERENCES, ...legacy });
      expect(p.onboarding.checklist).toBeDefined();
      expect(typeof p.onboarding.welcomeDone).toBe('boolean');
    }
  });
});
