import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openDb, runMigrations } from '../../server/src/db/client.js';
import { OAuthConsentService } from '../../server/src/harness/oauth-consent.js';
import { OAuthTokenService } from '../../server/src/harness/oauth-tokens.js';
import { HarnessService } from '../../server/src/harness/service.js';
import { EntitlementsService } from '../../server/src/harness/entitlements.js';
import { privateDataCleaner } from '../../server/src/harness/journal.js';
import { OAuthDiscovery } from '../src/oauth.js';
import { buildMcpApp } from '../src/app.js';
import { ToolRegistry, type ToolContext } from '../src/tools.js';

const resource = 'https://mcp.eko.example/mcp', redirect = 'https://connector.example/callback';
const pepper = randomBytes(32).toString('hex'), verifier = 'v'.repeat(43);
const scopes = ['senses:read', 'preflight', 'journal'] as const;
let db: Awaited<ReturnType<typeof openDb>>, harness: HarnessService, consent: OAuthConsentService,
  discovery: OAuthDiscovery, tokens: OAuthTokenService;
beforeAll(async () => { db = await openDb({ pgliteDir: ':memory:' }); await runMigrations(db); });
afterAll(async () => db.close());
beforeEach(async () => {
  await db.chain.sql.query('TRUNCATE oauth_grants,oauth_codes,oauth_clients,oauth_requests,oauth_registration_limits CASCADE');
  harness = new HarnessService(db.db, pepper);
  consent = new OAuthConsentService(db.db, harness, pepper, { resource, redirectAllowlist: [redirect], codeTtlSec: 60 });
  discovery = new OAuthDiscovery(db.chain, pepper, { publicUrl: resource, issuer: 'https://mcp.eko.example',
    webOrigin: 'https://eko.example', redirectAllowlist: [redirect] });
  tokens = new OAuthTokenService(db.db, pepper, { resource, accessTtlSec: 3600, refreshTtlSec: 2592000 });
});
async function approved() {
  const session = randomBytes(32).toString('base64url');
  const account = (await db.chain.sql.query<{ id: string }>("INSERT INTO accounts(kind,wallet_address) VALUES('wallet',$1) RETURNING id",
    [`0x${randomBytes(20).toString('hex')}`])).rows[0]!;
  await db.chain.sql.query("INSERT INTO sessions(account_id,token_hash,authenticated_at,expires_at) VALUES($1,$2,now(),now()+interval '1 day')",
    [account.id, createHash('sha256').update(session).digest('hex')]);
  const { client_id } = await discovery.register({ redirect_uris: [redirect], client_name: 'Sample connector' });
  const location = await discovery.authorize({ response_type: 'code', client_id, redirect_uri: redirect,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    state: 'sample-state', scope: scopes.join(' '), resource });
  const requestId = new URL(location).searchParams.get('request')!;
  await consent.inspect(session, requestId);
  const result = await consent.consent(session, { requestId, decision: 'approve', scopes: [...scopes], newAgentName: 'Sample connector agent' }, 2);
  const code = new URL(result.redirect).searchParams.get('code')!;
  return { accountId: account.id, client_id, code, input: { grant_type: 'authorization_code', code, client_id,
    redirect_uri: redirect, code_verifier: verifier, resource } };
}
const app = (tools = new ToolRegistry()) => buildMcpApp({ publicUrl: resource, oauth: discovery, oauthTokens: tokens,
  authenticate: bearer => harness.authenticate(bearer), tools,
  entitlements: () => new EntitlementsService({ LAUNCH_WEEK_AGENT_LIMIT: 2 }).get(),
  limits: { consume: async () => ({ allowed: true, retryAfterSec: 60 }) } });
const refresh = (client_id: string, refresh_token: string) => ({ grant_type: 'refresh_token', client_id, refresh_token, resource });

describe('prepared OAuth token lifecycle (database and injected HTTP fixtures; no live acceptance)', () => {
  it('redeems consent over form encoding and binds opaque HMAC-only tokens to exactly its agent and audience', async () => {
    const a = await approved(), server = app();
    try {
      const response = await server.inject({ method: 'POST', url: '/oauth/token', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams(a.input).toString() });
      expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers.pragma).toBe('no-cache');
      const pair = response.json();
      expect(pair).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: scopes.join(' ') });
      expect(pair.access_token).toMatch(/^eko_oat_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/);
      const identity = await tokens.authenticate(pair.access_token);
      expect(identity).toMatchObject({ accountId: a.accountId, scopes: [...scopes] });
      expect(await tokens.authenticate(pair.refresh_token)).toBeNull();
      expect(await tokens.authenticate(pair.access_token, 'https://foreign.example/mcp')).toBeNull();
      expect(await tokens.authenticate(pair.access_token.slice(0, -1) + '!')).toBeNull();
      expect(await tokens.authenticate(pair.access_token.slice(0, -1) + (pair.access_token.endsWith('A') ? 'B' : 'A'))).toBeNull();
      const stored = (await db.chain.sql.query('SELECT * FROM oauth_tokens')).rows;
      const audit = (await db.chain.sql.query('SELECT * FROM audit_log')).rows;
      // Each token is eko_o?t_<prefix>_<base64url secret>; the secret itself may contain '_'.
      for (const secret of [a.code, pair.access_token, pair.refresh_token, pair.access_token.split('_').slice(3).join('_'), pair.refresh_token.split('_').slice(3).join('_')])
        expect(JSON.stringify([stored, audit])).not.toContain(secret);
      expect(stored[0]).toMatchObject({ access_hash: expect.stringMatching(/^[0-9a-f]{64}$/), refresh_hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
      expect((await harness.keys(a.accountId, identity!.agent.id))[0]).toMatchObject({ kind: 'oauth', lastUsedAt: expect.any(String) });
      const ping = await server.inject({ method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${pair.access_token}`,
        accept: 'application/json, text/event-stream' }, payload: { jsonrpc: '2.0', id: 1, method: 'ping' } });
      expect(ping.statusCode).toBe(200);
      await expect(db.chain.sql.query('INSERT INTO oauth_tokens SELECT gen_random_uuid(),grant_id,code_id,$1,access_hash,$2,refresh_hash,access_expires_at,refresh_expires_at,refresh_consumed_at,revoked_at,created_at FROM oauth_tokens',
        ['different-access', 'different-refresh'])).rejects.toThrow(/code_id/);
    } finally { await server.close(); }
  });
  it('refuses PKCE, client, redirect, resource, expiry and malformed requests without consuming the code', async () => {
    const a = await approved(), server = app();
    try {
      for (const change of [{ code_verifier: 'x'.repeat(43) }, { client_id: 'foreign-client' }, { redirect_uri: redirect + '/' },
        { resource: 'https://foreign.example/mcp' }, { code_verifier: 'short' }, { grant_type: 'client_credentials' }]) {
        expect((await server.inject({ method: 'POST', url: '/oauth/token', payload: { ...a.input, ...change } })).statusCode).toBe(400);
      }
      expect((await db.chain.sql.query('SELECT consumed_at FROM oauth_codes')).rows[0]!.consumed_at).toBeNull();
      expect((await server.inject({ method: 'POST', url: '/oauth/token', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams(a.input).toString() + '&client_id=foreign' })).statusCode).toBe(400);
      await db.chain.sql.query("UPDATE oauth_codes SET expires_at=now()-interval '1 second'");
      await expect(tokens.exchange(a.input)).rejects.toMatchObject({ code: 'invalid_grant' });
      expect((await db.chain.sql.query('SELECT * FROM oauth_tokens')).rows).toHaveLength(0);
    } finally { await server.close(); }
  });
  it('serializes code redemption, and replay commits whole-grant revocation', async () => {
    const a = await approved();
    const race = await Promise.allSettled([tokens.exchange(a.input), tokens.exchange(a.input)]);
    const winner = race.find(r => r.status === 'fulfilled');
    expect(race.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(race.filter(r => r.status === 'rejected')).toHaveLength(1);
    expect((await db.chain.sql.query('SELECT * FROM oauth_tokens')).rows).toHaveLength(1);
    if (winner?.status !== 'fulfilled') throw new Error('Missing fixture winner');
    expect(await tokens.authenticate(winner.value.access_token)).toBeNull();
    expect((await db.chain.sql.query('SELECT revoked_at FROM oauth_grants')).rows[0]!.revoked_at).not.toBeNull();
  });
  it('rotates refresh tokens, refuses mismatches and expiry, and detects spent refresh reuse', async () => {
    const a = await approved(), pair = await tokens.exchange(a.input);
    for (const change of [{ client_id: 'foreign-client' }, { resource: 'https://foreign.example/mcp' }, { refresh_token: pair.access_token },
      { refresh_token: pair.refresh_token.slice(0, -1) + '!' }, { scope: 'senses:read preflight journal kill' }])
      await expect(tokens.exchange({ ...refresh(a.client_id, pair.refresh_token), ...change })).rejects.toBeDefined();
    const rotated = await tokens.exchange(refresh(a.client_id, pair.refresh_token));
    expect(rotated.refresh_token).not.toBe(pair.refresh_token);
    expect(await tokens.authenticate(rotated.access_token)).not.toBeNull();
    await db.chain.sql.query("UPDATE oauth_tokens SET access_expires_at=now()-interval '1 second' WHERE access_prefix=$1", [rotated.access_token.split('_')[2]]);
    expect(await tokens.authenticate(rotated.access_token)).toBeNull();
    const next = await tokens.exchange(refresh(a.client_id, rotated.refresh_token));
    await expect(tokens.exchange(refresh(a.client_id, pair.refresh_token))).rejects.toMatchObject({ code: 'invalid_grant' });
    expect(await tokens.authenticate(next.access_token)).toBeNull();
    expect((await db.chain.sql.query('SELECT revoked_at FROM agent_keys')).rows.every(r => r.revoked_at !== null)).toBe(true);
    const b = await approved(), expired = await tokens.exchange(b.input);
    await db.chain.sql.query("UPDATE oauth_tokens SET refresh_expires_at=now()-interval '1 second' WHERE refresh_prefix=$1", [expired.refresh_token.split('_')[2]]);
    await expect(tokens.exchange(refresh(b.client_id, expired.refresh_token))).rejects.toMatchObject({ code: 'invalid_grant' });
  });
  it('serializes refresh races and revokes the winning descendant on replay', async () => {
    const a = await approved(), pair = await tokens.exchange(a.input);
    const race = await Promise.allSettled([tokens.exchange(refresh(a.client_id, pair.refresh_token)), tokens.exchange(refresh(a.client_id, pair.refresh_token))]);
    expect(race.filter(r => r.status === 'fulfilled')).toHaveLength(1); expect(race.filter(r => r.status === 'rejected')).toHaveLength(1);
    const winner = race.find(r => r.status === 'fulfilled');
    if (winner?.status !== 'fulfilled') throw new Error('Missing fixture winner');
    expect(await tokens.authenticate(winner.value.access_token)).toBeNull();
    await expect(tokens.exchange(refresh(a.client_id, winner.value.refresh_token))).rejects.toMatchObject({ code: 'invalid_grant' });
  });
  it('revokes both grant and key through RFC 7009, Mission Control, hard kill and deletion, preserving other accounts', async () => {
    const a = await approved(), b = await approved(), pa = await tokens.exchange(a.input), pb = await tokens.exchange(b.input);
    const ia = (await tokens.authenticate(pa.access_token))!, ib = (await tokens.authenticate(pb.access_token))!;
    await expect(harness.keys(b.accountId, ia.agent.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(harness.revokeKey(b.accountId, ia.agent.id, ia.keyId)).rejects.toMatchObject({ code: 'not_found' });
    const server = app();
    try {
      for (const body of [{ client_id: b.client_id, token: pa.refresh_token }, { client_id: a.client_id, token: 'unknown-fixture' }])
        expect((await server.inject({ method: 'POST', url: '/oauth/revoke', payload: body })).statusCode).toBe(200);
      expect(await tokens.authenticate(pa.access_token)).not.toBeNull();
      expect((await server.inject({ method: 'POST', url: '/oauth/revoke', payload: { client_id: a.client_id, token: pa.refresh_token } })).statusCode).toBe(200);
      expect(await tokens.authenticate(pa.access_token)).toBeNull();
      expect((await server.inject({ method: 'POST', url: '/oauth/revoke', payload: { client_id: a.client_id, token: pa.refresh_token } })).statusCode).toBe(200);
      expect((await server.inject({ method: 'POST', url: '/oauth/revoke', payload: {} })).statusCode).toBe(400);
      expect((await harness.keys(a.accountId, ia.agent.id))[0]!.revokedAt).toBeDefined();
      expect(await tokens.authenticate(pb.access_token)).toMatchObject({ accountId: b.accountId });
      await harness.revokeKey(b.accountId, ib.agent.id, ib.keyId);
      expect(await tokens.authenticate(pb.access_token)).toBeNull();
      const c = await approved(), pc = await tokens.exchange(c.input), ic = (await tokens.authenticate(pc.access_token))!;
      await harness.update(c.accountId, ic.agent.id, { status: 'disconnected' }, 2);
      expect(await tokens.authenticate(pc.access_token)).toBeNull();
      await harness.update(c.accountId, ic.agent.id, { status: 'active' }, 2);
      await expect(tokens.exchange(refresh(c.client_id, pc.refresh_token))).rejects.toMatchObject({ code: 'invalid_grant' });
      const d = await approved(), pd = await tokens.exchange(d.input);
      await db.chain.tx(tx => privateDataCleaner.cleanup(tx, d.accountId, new Date().toISOString()));
      expect(await tokens.authenticate(pd.access_token)).toBeNull();
      await expect(tokens.exchange(refresh(d.client_id, pd.refresh_token))).rejects.toMatchObject({ code: 'invalid_grant' });
      expect((await db.chain.sql.query('SELECT data FROM audit_log WHERE action=\'oauth.revoke\'')).rows.length).toBeGreaterThanOrEqual(3);
    } finally { await server.close(); }
  });
  it('filters tool lists and calls by granted scopes while retaining handler availability and agent attribution', async () => {
    const a = await approved(), pair = await tokens.exchange(a.input), identity = (await tokens.authenticate(pair.access_token))!;
    const tools = new ToolRegistry().register('census_summary', async () => { throw new Error('fixture'); })
      .register('preflight', async () => { throw new Error('fixture'); }).register('journal', async () => { throw new Error('fixture'); });
    const context: ToolContext = { ...identity, scopes: ['senses:read'], entitlements: new EntitlementsService({}).get(), delayedSec: 0, signal: new AbortController().signal };
    expect((await tools.visible(context)).map(t => t.name)).toEqual(['census_summary']);
    expect((await tools.visible({ ...context, scopes: undefined })).map(t => t.name)).toEqual(['census_summary', 'preflight', 'journal']);
    // Fixture-only reduced grant demonstrates transport filtering independently of mandatory consent scopes.
    await db.chain.sql.query('UPDATE oauth_grants SET scopes=$1 WHERE account_id=$2', [JSON.stringify(['senses:read']), a.accountId]);
    const server = app(tools);
    try {
      const rpc = (method: string, params?: object) => server.inject({ method: 'POST', url: '/mcp', headers: {
        authorization: `Bearer ${pair.access_token}`, accept: 'application/json, text/event-stream' }, payload: { jsonrpc: '2.0', id: 1, method, params } });
      expect((await rpc('tools/list')).json().result.tools.map((t: { name: string }) => t.name)).toEqual(['census_summary']);
      expect((await rpc('tools/call', { name: 'journal', arguments: { kind: 'note', payload: {} } })).json().error.code).toBe(-32602);
    } finally { await server.close(); }
  });
  it('fails closed for deleted accounts and pepper rotation, and rejects inconsistent configuration', async () => {
    const a = await approved(), pair = await tokens.exchange(a.input);
    const cfg = { resource, accessTtlSec: 3600, refreshTtlSec: 2592000 };
    expect(await new OAuthTokenService(db.db, pepper, cfg, () => true).authenticate(pair.access_token)).toBeNull();
    expect(await new OAuthTokenService(db.db, pepper, cfg, () => { throw new Error('fixture'); }).authenticate(pair.access_token)).toBeNull();
    expect(await new OAuthTokenService(db.db, randomBytes(32).toString('hex'), cfg).authenticate(pair.access_token)).toBeNull();
    for (const override of [{ resource: 'http://mcp.eko.example/mcp' }, { accessTtlSec: 3601 }, { refreshTtlSec: 0 }])
      expect(() => new OAuthTokenService(db.db, pepper, { ...cfg, ...override })).toThrow();
  });
});
