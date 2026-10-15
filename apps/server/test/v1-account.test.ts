import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { eq } from 'drizzle-orm';
import { ApiErrorSchema, EntitlementsSchema, MeSchema, PreferencesSchema, ReferralsSchema, SIWE_STATEMENT, SiweNonceSchema } from '@eko/shared';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { sessions, siweNonces } from '../src/db/schema.js';
import { EntitlementsService } from '../src/http/v1/account.js';
import { createDemoToken } from '../src/http/v1/demo.js';

const origin = 'https://app.eko.example';
const secret = 'fixture-session-placeholder'.repeat(2);
const cfg = loadConfig({ NODE_ENV: 'test', PGLITE_DIR: ':memory:', LEGACY_API: 'false',
  PUBLIC_ORIGIN: `${origin},https://eko.example`, SESSION_SECRET: secret, DEMO_SECRET: secret,
  LAUNCH_WEEK_AGENT_LIMIT: '3', FEE_ACTIVE_FROM: '2026-10-20T13:00:00Z', TIERS_ACTIVE_FROM: '2026-10-21T13:00:00Z' });
const walletA = privateKeyToAccount(generatePrivateKey());
const walletB = privateKeyToAccount(generatePrivateKey());
let built: Awaited<ReturnType<typeof buildApp>>;
let fallback: ReturnType<typeof vi.spyOn>;
beforeAll(async () => {
  built = await buildApp(cfg, { startBackground: false });
  // Offline fixture: a failed EOA recovery never makes an RPC request in this suite.
  fallback = vi.spyOn(built.ctx.chains.get('robinhood-mainnet'), 'verifySiweMessage').mockResolvedValue(false);
});
afterAll(async () => { fallback.mockRestore(); await built.close(); });

const cookieOf = (response: { cookies: { name: string; value: string }[] }) => `eko_sid=${response.cookies.find(c => c.name === 'eko_sid')!.value}`;
async function guest() { const response = await built.app.inject('/v1/me'); return { cookie: cookieOf(response), me: MeSchema.parse(response.json()), response }; }
const call = (cookie: string, method: 'GET' | 'POST' | 'PUT', path: string, payload?: object, from = origin) => built.app.inject({ method, url: `/v1${path}`, headers: { cookie, origin: from }, ...(payload ? { payload } : {}) });
async function signed(cookie: string, wallet = walletA, overrides: Partial<Parameters<typeof createSiweMessage>[0]> = {}) {
  const response = await call(cookie, 'POST', '/auth/siwe/nonce');
  expect(response.statusCode).toBe(200);
  const challenge = SiweNonceSchema.parse(response.json());
  const message = createSiweMessage({ domain: challenge.domain, uri: challenge.uri, address: wallet.address,
    chainId: 4663, nonce: challenge.nonce, version: '1', statement: SIWE_STATEMENT,
    issuedAt: new Date(challenge.issuedAt), expirationTime: new Date(challenge.expirationTime), ...overrides });
  return { message, signature: await wallet.signMessage({ message }), challenge };
}
async function signIn(cookie: string, wallet = walletA, ref?: string) {
  const { message, signature } = await signed(cookie, wallet);
  const response = await call(cookie, 'POST', '/auth/siwe/verify', { message, signature, ...(ref ? { ref } : {}) });
  expect(response.statusCode).toBe(200);
  return { cookie: cookieOf(response), me: MeSchema.parse(response.json()), response };
}

describe('v1 account (offline SIWE and migrated storage)', () => {
  it('serves shared guest/launch contracts and scoped, signed, HttpOnly cookies', async () => {
    const { response, me } = await guest();
    expect(me.account.wallet).toBeUndefined();
    expect(me.referralCode).toBe('');
    expect(me.trial).toEqual({ status: 'not_open' });
    expect(me.holdings.minBalance24h).toBeNull();
    expect(response.headers['cache-control']).toBe('private, no-store');
    const header = response.headers['set-cookie'];
    expect(header).toContain('Domain=.eko.example');
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) expect(header).toContain(flag);
    expect((await built.app.inject('/api/session')).statusCode).toBe(404);
  });
  it('issues a session with the first nonce, includes server times and a ten-minute expiry', async () => {
    const response = await built.app.inject({ method: 'POST', url: '/v1/auth/siwe/nonce', headers: { origin } });
    expect(response.statusCode).toBe(200);
    const n = SiweNonceSchema.parse(response.json());
    expect(n.domain).toBe('app.eko.example');
    expect(n.uri).toBe(origin);
    expect(Date.parse(n.expirationTime) - Date.parse(n.issuedAt)).toBe(600_000);
    expect(cookieOf(response)).toContain('eko_sid=');
  });
  it('round-trips shared preferences and rejects invalid values and missing sessions', async () => {
    const { cookie } = await guest();
    const saved = await call(cookie, 'PUT', '/me/preferences', { defaultSlippageBps: 30, favorites: ['sample-coin'] });
    expect(saved.statusCode).toBe(200);
    expect(PreferencesSchema.parse((await call(cookie, 'GET', '/me/preferences')).json())).toEqual(saved.json());
    expect((await call(cookie, 'PUT', '/me/preferences', { defaultSlippageBps: 9000 })).statusCode).toBe(422);
    for (const method of ['GET', 'PUT'] as const) {
      const response = await call('', method, '/me/preferences', method === 'PUT' ? {} : undefined);
      expect(response.statusCode).toBe(401); expect(ApiErrorSchema.parse(response.json()).error).toBe('wallet_auth_required');
    }
  });
  it('rotates on sign-in, invalidates the old session, and rejects nonce reuse', async () => {
    const { cookie } = await guest();
    const { message, signature } = await signed(cookie);
    const response = await call(cookie, 'POST', '/auth/siwe/verify', { message, signature });
    expect(response.statusCode).toBe(200);
    const rotated = cookieOf(response);
    const raw = built.app.unsignCookie(response.cookies.find(c => c.name === 'eko_sid')!.value).value!;
    const [session] = await built.ctx.dbh.db.select().from(sessions).where(eq(sessions.tokenHash, createHash('sha256').update(raw).digest('hex')));
    expect(session!.authenticatedAt).toBeInstanceOf(Date);
    expect(Date.now() - session!.authenticatedAt!.getTime()).toBeLessThan(60_000);
    expect(rotated).not.toBe(cookie);
    expect(MeSchema.parse(response.json()).account.wallet).toBe(walletA.address.toLowerCase());
    expect((await call(cookie, 'GET', '/me/preferences')).statusCode).toBe(401);
    expect((await call(rotated, 'POST', '/auth/siwe/verify', { message, signature })).statusCode).toBe(401);
  });
  it('allows exactly one concurrent verification of a nonce', async () => {
    const { cookie } = await guest();
    const { message, signature } = await signed(cookie, privateKeyToAccount(generatePrivateKey()));
    const results = await Promise.all([call(cookie, 'POST', '/auth/siwe/verify', { message, signature }), call(cookie, 'POST', '/auth/siwe/verify', { message, signature })]);
    expect(results.map(r => r.statusCode).sort()).toEqual([200, 401]);
  });
  it.each([
    { chainId: 46630 }, { domain: 'evil.example' }, { uri: 'https://eko.example' },
    { statement: 'Another statement' }, { issuedAt: new Date('2099-01-01T00:00:00Z') },
    { expirationTime: undefined }, { expirationTime: new Date('2099-01-01T00:00:00Z') },
  ])('rejects altered SIWE fields %j', async overrides => {
    const { cookie } = await guest();
    const { message, signature } = await signed(cookie, walletA, overrides);
    const response = await call(cookie, 'POST', '/auth/siwe/verify', { message, signature });
    expect(response.statusCode).toBe(401); expect(ApiErrorSchema.parse(response.json()).error).toBe('unauthorized');
  });
  it('rejects unknown, expired, cross-account and cross-session challenges', async () => {
    const one = await guest(), two = await guest();
    const { message, signature, challenge } = await signed(one.cookie);
    expect((await call(two.cookie, 'POST', '/auth/siwe/verify', { message, signature })).statusCode).toBe(401);
    const token = await built.ctx.auth.createSession(one.me.account.id);
    expect((await call(`eko_sid=${built.app.signCookie(token)}`, 'POST', '/auth/siwe/verify', { message, signature })).statusCode).toBe(401);
    await built.ctx.dbh.db.update(siweNonces).set({ expiresAt: new Date(0) }).where(eq(siweNonces.nonce, challenge.nonce));
    expect((await call(one.cookie, 'POST', '/auth/siwe/verify', { message, signature })).statusCode).toBe(401);
    const unknown = await signed(one.cookie, walletA, { nonce: 'unknownNonce123' });
    expect((await call(one.cookie, 'POST', '/auth/siwe/verify', { message: unknown.message, signature: unknown.signature })).statusCode).toBe(401);
  });
  it('rejects forged signatures via the supplied verification client without live reads', async () => {
    const { cookie } = await guest();
    const { message } = await signed(cookie);
    const signature = await walletB.signMessage({ message });
    const response = await call(cookie, 'POST', '/auth/siwe/verify', { message, signature });
    expect(response.statusCode).toBe(401); expect(fallback).toHaveBeenCalled();
    expect((await built.ctx.chains.meter.usage()).sessionUnits).toBe(0);
  });
  it('rejects missing/malformed/foreign Origin and a challenge from another allowed origin', async () => {
    const { cookie } = await guest();
    for (const path of ['/auth/siwe/nonce', '/auth/siwe/verify', '/auth/logout', '/me/preferences']) {
      const method = path === '/me/preferences' ? 'PUT' : 'POST';
      for (const from of ['https://evil.example', `${origin}/path`, 'null']) expect((await call(cookie, method, path, {}, from)).statusCode).toBe(403);
      expect((await built.app.inject({ method, url: `/v1${path}`, headers: { cookie }, payload: {} })).statusCode).toBe(403);
    }
    const { message, signature } = await signed(cookie);
    expect((await call(cookie, 'POST', '/auth/siwe/verify', { message, signature }, 'https://eko.example')).statusCode).toBe(401);
  });
  it('switches accounts without copying preferences and restores the original wallet account', async () => {
    const a = await signIn((await guest()).cookie);
    await call(a.cookie, 'PUT', '/me/preferences', { favorites: ['wallet-a-coin'] });
    const b = await signIn(a.cookie, walletB);
    expect(b.me.account.id).not.toBe(a.me.account.id);
    expect((await call(b.cookie, 'GET', '/me/preferences')).json().favorites).toEqual([]);
    expect((await call(a.cookie, 'GET', '/me/preferences')).statusCode).toBe(401);
    const again = await signIn(b.cookie);
    expect(again.me.account.id).toBe(a.me.account.id);
    expect((await call(again.cookie, 'GET', '/me/preferences')).json().favorites).toEqual(['wallet-a-coin']);
  });
  it('captures known referral codes once, ignores self/unknown codes, and grants no launch bonus', async () => {
    const inviterWallet = privateKeyToAccount(generatePrivateKey());
    const inviter = await signIn((await guest()).cookie, inviterWallet);
    const another = await signIn((await guest()).cookie, privateKeyToAccount(generatePrivateKey()));
    const inviteeWallet = privateKeyToAccount(generatePrivateKey());
    const invitee = await signIn((await guest()).cookie, inviteeWallet, inviter.me.referralCode);
    await signIn(invitee.cookie, inviteeWallet, another.me.referralCode);
    const stats = ReferralsSchema.parse((await call(inviter.cookie, 'GET', '/referrals')).json());
    expect(stats).toMatchObject({ referred: 1, qualified: 0, bonusMinutes: 0 });
    expect(stats.link).toBe(`${origin}/?ref=${inviter.me.referralCode}`);
    expect((await call(another.cookie, 'GET', '/referrals')).json().referred).toBe(0);
    const self = await signIn(inviter.cookie, inviterWallet, inviter.me.referralCode);
    expect((await call(self.cookie, 'GET', '/referrals')).json().referred).toBe(1);
    await signIn(self.cookie, inviterWallet, 'unknown-code');
    expect(self.me.trial.status).toBe('not_open');
    expect((await call((await guest()).cookie, 'GET', '/referrals')).statusCode).toBe(401);
  });
  it('allows demo sign-in/logout but forbids preference writes, regardless of wallet verification', async () => {
    const demo = `eko_demo=${createDemoToken([], secret)}`;
    const { cookie } = await guest();
    const demoCookie = `${cookie}; ${demo}`;
    const signedDemo = await signed(demoCookie);
    const response = await call(demoCookie, 'POST', '/auth/siwe/verify', { message: signedDemo.message, signature: signedDemo.signature });
    expect(response.statusCode).toBe(200);
    const verifiedDemo = `${cookieOf(response)}; ${demo}`;
    expect((await call(verifiedDemo, 'GET', '/me/preferences')).statusCode).toBe(200);
    const refused = await call(verifiedDemo, 'PUT', '/me/preferences', {});
    expect(refused.statusCode).toBe(403); expect(ApiErrorSchema.parse(refused.json()).error).toBe('forbidden');
    expect((await call(verifiedDemo, 'POST', '/auth/logout')).statusCode).toBe(200);
  });
  it('logout revokes the session and clears the identical cookie domain/path', async () => {
    const a = await signIn((await guest()).cookie);
    const response = await call(a.cookie, 'POST', '/auth/logout');
    expect(response.statusCode).toBe(200);
    expect(response.headers['set-cookie']).toContain('Domain=.eko.example');
    expect(response.headers['set-cookie']).toContain('Max-Age=0');
    expect((await call(a.cookie, 'GET', '/me/preferences')).statusCode).toBe(401);
  });
});

describe('launch boundaries and configuration (pure fixtures)', () => {
  it('keeps trial/tier checks dormant, changes fees at D0 and delay at D0+1', () => {
    const service = new EntitlementsService(cfg);
    expect(EntitlementsSchema.parse(service.get(Date.parse('2026-10-13T13:00:00Z')))).toMatchObject({ tier: 'listener', feeBps: 0, limits: { realtime: true, agents: 3 } });
    expect(service.get(Date.parse(cfg.FEE_ACTIVE_FROM!))).toMatchObject({ feeBps: 50, limits: { realtime: true } });
    expect(service.get(Date.parse(cfg.TIERS_ACTIVE_FROM!))).toMatchObject({ tier: 'listener', feeBps: 50, limits: { realtime: false, agents: 1 } });
    expect(service.get().trial).toBeUndefined();
    expect(new EntitlementsService({ ...cfg, LAUNCH_WEEK_AGENT_LIMIT: undefined }).get(0).limits.agents).toBe(0);
  });
  it('validates cookie scope and origins without configuration or secret discovery', () => {
    expect(() => loadConfig({ PUBLIC_ORIGIN: `${origin}/path` })).toThrow(/PUBLIC_ORIGIN/);
    expect(() => loadConfig({ PUBLIC_ORIGIN: origin, SESSION_COOKIE_DOMAIN: '.evil.example' })).toThrow(/cookie domain/);
    expect(() => loadConfig({ LAUNCH_WEEK_AGENT_LIMIT: '-1' })).toThrow(/LAUNCH_WEEK_AGENT_LIMIT/);
  });
});
