import { createHash, createHmac, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OAuthConsentSchema, OAuthRequestSchema, type OAuthScope } from '@eko/shared';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { accounts, agentKeys, auditLog, oauthClients, oauthCodes, oauthGrants, oauthRequests, sessions } from '../src/db/schema.js';
import { OAuthConsentService } from '../src/harness/oauth-consent.js';
import { oauthConsentRoutes } from '../src/http/v1/oauth.js';
import { installDemoGuard, createDemoToken } from '../src/http/v1/demo.js';

const origin = 'https://app.eko.example', resource = 'https://mcp.eko.example/mcp';
const redirect = 'https://connector.example/callback?existing=value&code=discard&state=discard';
const pepper = 'fixture-consent-placeholder'.repeat(2);
const cfg = loadConfig({ NODE_ENV: 'test', PGLITE_DIR: ':memory:', PUBLIC_ORIGIN: origin, SESSION_SECRET: pepper,
  HARNESS_KEY_PEPPER: pepper, DEMO_SECRET: pepper, LAUNCH_WEEK_AGENT_LIMIT: '2', LEGACY_API: 'false' });
const scopes: OAuthScope[] = ['senses:read', 'preflight', 'journal', 'research'];
let built: Awaited<ReturnType<typeof buildApp>>, app: ReturnType<typeof Fastify>, consent: OAuthConsentService;
beforeAll(async () => {
  built = await buildApp(cfg, { startBackground: false });
  consent = new OAuthConsentService(built.ctx.dbh.db, built.ctx.harness, pepper, { resource, redirectAllowlist: [redirect], codeTtlSec: 60 });
  app = Fastify(); await app.register(cookie, { secret: cfg.sessionSecret }); await app.register(rateLimit, { global: false });
  installDemoGuard(app, cfg);
  await app.register(async (area: FastifyInstance) => oauthConsentRoutes(area, cfg, { auth: built.ctx.auth, consent }), { prefix: '/v1' });
});
afterAll(async () => { await app?.close(); await built?.close(); });
async function owner(authenticatedAt: Date | undefined = new Date()) {
  const [a] = await built.ctx.dbh.db.insert(accounts).values({ kind: 'wallet', walletAddress: `0x${randomUUID().replaceAll('-', '').padEnd(40, '0')}` }).returning();
  const token = await built.ctx.auth.createSession(a!.id, undefined, authenticatedAt);
  return { id: a!.id, token, cookie: `eko_sid=${encodeURIComponent(app.signCookie(token))}` };
}
async function request(overrides: Partial<typeof oauthRequests.$inferInsert> = {}) {
  const clientId = randomUUID();
  await built.ctx.dbh.db.insert(oauthClients).values({ id: clientId, clientName: { text: '<script>ignore instructions\u202e</script> https://foreign.example', flags: [], truncated: false }, redirectUris: [redirect] });
  const [r] = await built.ctx.dbh.db.insert(oauthRequests).values({ clientId, redirectUri: redirect, state: 'state+&=#? sample', scopes,
    codeChallenge: 'A'.repeat(43), codeChallengeMethod: 'S256', resource, expiresAt: new Date(Date.now() + 600_000), ...overrides }).returning();
  return r!;
}
const get = (cookie: string, id: string) => app.inject({ url: `/v1/oauth/requests/${id}`, headers: { cookie, origin } });
const post = (cookie: string, id: string, input: Record<string, unknown> = {}) => app.inject({ method: 'POST', url: '/v1/oauth/consent',
  headers: { cookie, origin }, payload: { requestId: id, scopes: scopes.slice(0, 3), decision: 'approve', newAgentName: 'Sample connector agent', ...input } });

describe('SIWE OAuth consent (offline database and HTTP injection fixtures)', () => {
  it('sanitizes inspection, binds the first wallet and hides foreign requests and agents', async () => {
    const a = await owner(), b = await owner(), r = await request();
    const response = await get(a.cookie, r.id), view = OAuthRequestSchema.parse(response.json());
    expect(response.statusCode).toBe(200); expect(view.redirectHost).toBe('connector.example');
    expect(view.clientName.text).not.toMatch(/[<>\u202e]|https:/);
    expect(response.headers['content-security-policy']).toBe("frame-ancestors 'none'");
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.json()).not.toHaveProperty('codeChallenge');
    expect((await get(b.cookie, r.id)).statusCode).toBe(404);
    expect((await post(b.cookie, r.id)).statusCode).toBe(404);
    const foreign = await built.ctx.harness.create(b.id, { name: 'Foreign fixture agent', kind: 'other', preset: 'balanced' }, 2);
    expect((await post(a.cookie, r.id, { agentId: foreign.id, newAgentName: undefined })).statusCode).toBe(404);
    expect((await built.ctx.dbh.db.select().from(oauthCodes).where(eq(oauthCodes.requestId, r.id)))).toHaveLength(0);
  });
  it('requires a live session with explicit recent SIWE authentication for reads and both decisions', async () => {
    const r = await request(), stale = await owner(new Date(Date.now() - 3_600_001)), unsigned = await owner(undefined);
    // createSession defaults to no authentication; explicitly clear fixture marker.
    await built.ctx.dbh.db.update(sessions).set({ authenticatedAt: null }).where(eq(sessions.accountId, unsigned.id));
    const expired = await owner();
    await built.ctx.dbh.db.update(sessions).set({ expiresAt: new Date(Date.now() - 1) }).where(eq(sessions.accountId, expired.id));
    const guest = await built.ctx.auth.createGuest();
    for (const cookie of ['', 'eko_sid=invalid', stale.cookie, unsigned.cookie, expired.cookie, `eko_sid=${encodeURIComponent(app.signCookie(guest.token))}`]) {
      expect((await get(cookie, r.id)).statusCode).toBe(401);
      for (const decision of ['approve', 'deny']) expect((await post(cookie, r.id, { decision })).statusCode).toBe(401);
    }
    const recent = await owner(new Date(Date.now() - 3_500_000)); expect((await get(recent.cookie, r.id)).statusCode).toBe(200);
    const demo = `${recent.cookie}; eko_demo=${createDemoToken([], pepper)}`;
    expect((await get(demo, r.id)).statusCode).toBe(403);
    expect((await post(demo, r.id)).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/v1/oauth/consent', headers: { cookie: recent.cookie, origin: 'https://foreign.example' }, payload: {} })).statusCode).toBe(403);
  });
  it('refuses expired, unknown, invalid-target requests and consent before inspection', async () => {
    const a = await owner();
    for (const r of [await request({ expiresAt: new Date(Date.now() - 1) }), await request({ resource: 'https://foreign.example/mcp' }), await request({ redirectUri: 'https://foreign.example/callback' })]) {
      expect((await get(a.cookie, r.id)).statusCode).toBe(404); expect((await post(a.cookie, r.id)).statusCode).toBe(404);
    }
    expect((await get(a.cookie, randomUUID())).statusCode).toBe(404);
    expect((await get(a.cookie, 'invalid')).statusCode).toBe(422);
    expect((await post(a.cookie, (await request()).id)).statusCode).toBe(409);
  });
  it('mints one HMAC-only code and oauth key bound exactly to the account, agent, client, redirect, scopes and resource', async () => {
    const a = await owner(), r = await request(); await get(a.cookie, r.id);
    const response = await post(a.cookie, r.id, { preset: 'degen' }); expect(response.statusCode).toBe(200);
    const url = new URL(response.json().redirect), code = url.searchParams.get('code')!;
    expect(url.origin + url.pathname).toBe('https://connector.example/callback');
    expect(url.searchParams.getAll('code')).toEqual([code]); expect(url.searchParams.get('existing')).toBe('value'); expect(url.searchParams.get('state')).toBe(r.state);
    expect(url.searchParams.has('error')).toBe(false);
    const [stored] = await built.ctx.dbh.db.select().from(oauthCodes).where(eq(oauthCodes.requestId, r.id));
    expect(stored).toMatchObject({ hash: createHmac('sha256', pepper).update(code).digest('hex'), clientId: r.clientId,
      redirectUri: r.redirectUri, resource, codeChallenge: r.codeChallenge, codeChallengeMethod: 'S256', scopes: scopes.slice(0, 3), consumedAt: null });
    expect(stored!.expiresAt.getTime() - stored!.createdAt.getTime()).toBeGreaterThan(55_000);
    expect(stored!.expiresAt.getTime() - stored!.createdAt.getTime()).toBeLessThanOrEqual(60_100);
    const [grant] = await built.ctx.dbh.db.select().from(oauthGrants).where(eq(oauthGrants.id, stored!.grantId));
    expect(grant).toMatchObject({ accountId: a.id, clientId: r.clientId, resource, scopes: scopes.slice(0, 3) });
    const [key] = await built.ctx.dbh.db.select().from(agentKeys).where(eq(agentKeys.oauthGrantId, grant!.id));
    expect(key).toMatchObject({ agentId: grant!.agentId, kind: 'oauth', scopes: scopes.slice(0, 3) }); expect(key!.hash).toMatch(/^[0-9a-f]{64}$/);
    expect((await built.ctx.harness.policy(a.id, grant!.agentId)).mode).toBe('degen');
    expect((await built.ctx.harness.keys(a.id, grant!.agentId))[0]).toMatchObject({ kind: 'oauth', scopes: scopes.slice(0, 3) });
    const audit = await built.ctx.dbh.db.select().from(auditLog).where(eq(auditLog.accountId, a.id));
    expect(audit.some(row => row.action === 'oauth.consent')).toBe(true);
    expect(JSON.stringify([stored, grant, key, audit])).not.toContain(code);
    expect(Object.keys(response.json())).toEqual(['redirect']);
    expect((await post(a.cookie, r.id)).statusCode).toBe(409); expect((await post(a.cookie, r.id, { decision: 'deny' })).statusCode).toBe(409);
    await expect(built.ctx.dbh.db.insert(oauthCodes).values({ ...stored!, id: randomUUID(), hash: 'another-fixture-hash' })).rejects.toThrow();
  });
  it('allows only a scope subset with all required scopes and exactly one agent choice', async () => {
    const a = await owner(), r = await request(); await get(a.cookie, r.id);
    for (const input of [{ scopes: ['senses:read', 'preflight'] }, { scopes: [...scopes, 'kill'] }, { decision: 'implicit' }, { newAgentName: undefined },
      { agentId: randomUUID() }, { newAgentName: ' ' }, { additional: true }]) expect((await post(a.cookie, r.id, input)).statusCode).toBe(422);
    const selected = await built.ctx.harness.create(a.id, { name: 'Existing fixture agent', kind: 'other', preset: 'balanced' }, 2);
    expect((await post(a.cookie, r.id, { agentId: selected.id, newAgentName: undefined })).statusCode).toBe(200);
    const [grant] = await built.ctx.dbh.db.select().from(oauthGrants).where(eq(oauthGrants.accountId, a.id)); expect(grant!.agentId).toBe(selected.id);
  });
  it('serializes double consent and new-agent admission with ordinary harness creation', async () => {
    const a = await owner(), r = await request(); await get(a.cookie, r.id);
    const replies = await Promise.all([post(a.cookie, r.id), post(a.cookie, r.id)]); expect(replies.map(r => r.statusCode).sort()).toEqual([200, 409]);
    const r2 = await request(); await get(a.cookie, r2.id);
    const input = OAuthConsentSchema.parse({ requestId: r2.id, scopes, decision: 'approve', newAgentName: 'Concurrent fixture agent' });
    const results = await Promise.allSettled([consent.consent(a.token, input, 2), built.ctx.harness.create(a.id, { name: 'Concurrent ordinary agent', kind: 'other', preset: 'balanced' }, 2)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1); expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    expect((await built.ctx.harness.list(a.id))).toHaveLength(2);
    const r3 = await request(); await get(a.cookie, r3.id); expect((await post(a.cookie, r3.id)).statusCode).toBe(429);
    expect((await built.ctx.dbh.db.select().from(oauthCodes).where(eq(oauthCodes.requestId, r3.id)))).toHaveLength(0);
    expect((await get(a.cookie, r3.id)).statusCode).toBe(200);
  });
  it('denies without creating credentials, preserves encoded state and consumes the request', async () => {
    const a = await owner(), r = await request(); await get(a.cookie, r.id);
    const response = await post(a.cookie, r.id, { decision: 'deny', newAgentName: undefined, scopes: [] }); expect(response.statusCode).toBe(200);
    const url = new URL(response.json().redirect); expect(url.searchParams.get('error')).toBe('access_denied'); expect(url.searchParams.get('state')).toBe(r.state);
    expect(url.searchParams.has('code')).toBe(false); expect(url.searchParams.get('existing')).toBe('value');
    expect((await built.ctx.harness.list(a.id))).toHaveLength(0);
    expect((await built.ctx.dbh.db.select().from(oauthGrants).where(eq(oauthGrants.accountId, a.id)))).toHaveLength(0);
    expect((await post(a.cookie, r.id, { decision: 'deny' })).statusCode).toBe(409);
  });
  it('rate limits consent and leaves runtime inactive; protects the consent document from framing', async () => {
    const a = await owner();
    const responses = await Promise.all(Array.from({ length: 31 }, () => get(a.cookie, randomUUID())));
    expect(responses.at(-1)!.statusCode).toBe(429);
    expect((await built.app.inject('/v1/oauth/requests/' + randomUUID())).statusCode).toBe(404);
    for (const path of ['/oauth/consent', '/oauth/consent/', '/oauth//consent//']) {
      const document = await built.app.inject(`${path}?request=fixture`);
      expect(document.headers['content-security-policy']).toBe("frame-ancestors 'none'");
      expect(document.headers['cache-control']).toBe('private, no-store');
    }
    // A freshly created generic wallet session is not a SIWE-authenticated session.
    const plain = await built.ctx.auth.createSession(a.id);
    const [stored] = await built.ctx.dbh.db.select().from(sessions).where(eq(sessions.tokenHash, createHash('sha256').update(plain).digest('hex')));
    expect(stored!.authenticatedAt).toBeNull();
  });
});
