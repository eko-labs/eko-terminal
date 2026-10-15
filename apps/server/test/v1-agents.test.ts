import { EventEmitter } from 'node:events';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import type { WebSocket } from 'ws';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentDetailSchema, AgentSchema, ApiKeyCreatedSchema, ApiKeyInfoSchema, PolicySchema, WsServerSchema } from '@eko/shared';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { accounts, agentKeys, policies } from '../src/db/schema.js';
import { HarnessService } from '../src/harness/service.js';
import { registerV1 } from '../src/http/v1/index.js';
import { createDemoToken, installDemoGuard } from '../src/http/v1/demo.js';
import { Hub } from '../src/ws/hub.js';

const origin = 'https://app.eko.example';
const placeholder = 'fixture-harness-placeholder'.repeat(2);
const cfg = loadConfig({ NODE_ENV: 'test', PGLITE_DIR: ':memory:', LEGACY_API: 'false', PUBLIC_ORIGIN: origin,
  SESSION_SECRET: placeholder, DEMO_SECRET: placeholder, HARNESS_KEY_PEPPER: placeholder,
  LAUNCH_WEEK_AGENT_LIMIT: '2', FLAGS: 'policy_editor,mission_kill' });
let built: Awaited<ReturnType<typeof buildApp>>;
let launch: ReturnType<typeof Fastify>;
beforeAll(async () => {
  built = await buildApp(cfg, { startBackground: false });
  launch = Fastify();
  await launch.register(cookie, { secret: cfg.sessionSecret });
  installDemoGuard(launch, cfg);
  await registerV1(launch, { ...cfg, FLAGS: '' }, new (await import('../src/flags/service.js')).FlagService(async () => []),
    () => built.ctx.chains.meter.usage(), undefined, undefined, undefined, { auth: built.ctx.auth, harness: built.ctx.harness });
});
afterAll(async () => { await launch.close(); await built.close(); });
async function owner() {
  const [account] = await built.ctx.dbh.db.insert(accounts).values({ kind: 'wallet' }).returning();
  const token = await built.ctx.auth.createSession(account!.id);
  return { id: account!.id, cookie: `eko_sid=${encodeURIComponent(built.app.signCookie(token))}` };
}
const call = (session: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, payload?: object, app = built.app) =>
  app.inject({ method, url: `/v1${path}`, headers: { cookie: session, origin }, ...(payload === undefined ? {} : { payload }) });
async function create(session: string, policy?: Record<string, unknown>) {
  const response = await call(session, 'POST', '/agents', { name: 'Sample agent', kind: 'onchain', preset: 'safe', ...(policy ? { policy } : {}) });
  expect(response.statusCode).toBe(201);
  return AgentDetailSchema.parse(response.json());
}

describe('API-owned agents and harness keys (offline database fixtures)', () => {
  it('persists presets, honors null/zero/empty choices, and always reports advisory', async () => {
    const a = await owner(), agent = await create(a.cookie, { blockPlaybookLevel: null, maxRoundTripCostPct: 0, allowAssets: [] });
    expect(agent.guardrails).toBe('advisory');
    const saved = PolicySchema.parse((await call(a.cookie, 'GET', `/agents/${agent.id}/policy`)).json());
    expect(saved).toMatchObject({ mode: 'safe', blockPlaybookLevel: null, maxRoundTripCostPct: 0, allowAssets: [], minLiquidityUsd: 50_000, killed: false, version: 1 });
    expect(saved.guardPolicyVersion).toBeUndefined();
    const reload = new HarnessService(built.ctx.dbh.db, placeholder);
    expect(await reload.detail(a.id, agent.id)).toEqual(agent);
    expect((await call(a.cookie, 'GET', '/agents')).json().agents).toEqual([AgentSchema.parse(agent)]);
    expect((await call(a.cookie, 'PATCH', `/agents/${agent.id}`, { name: 'Renamed agent' })).json().name).toBe('Renamed agent');
  });
  it('rejects missing/guest/expired sessions, bearer management and every demo mutation', async () => {
    const guest = await built.ctx.auth.createGuest(), guestCookie = `eko_sid=${encodeURIComponent(built.app.signCookie(guest.token))}`;
    for (const session of ['', guestCookie, 'eko_sid=invalid']) expect((await call(session, 'POST', '/agents', { name: 'Sample agent', kind: 'other', preset: 'safe' })).statusCode).toBe(401);
    const a = await owner(), agent = await create(a.cookie), demo = `${a.cookie}; eko_demo=${createDemoToken(['policy_editor'], placeholder)}`;
    for (const [method, path, body] of [
      ['POST', '/agents', { name: 'Demo agent', kind: 'other', preset: 'safe' }],
      ['PATCH', `/agents/${agent.id}`, { name: 'Demo agent' }], ['DELETE', `/agents/${agent.id}`, undefined],
      ['POST', `/agents/${agent.id}/keys`, {}], ['DELETE', `/agents/${agent.id}/keys/${agent.id}`, undefined],
      ['PUT', `/agents/${agent.id}/policy`, await built.ctx.harness.policy(a.id, agent.id)],
    ] as const) expect((await call(demo, method, path, body)).statusCode).toBe(403);
    const response = await built.app.inject({ method: 'POST', url: '/v1/agents', headers: { authorization: 'Bearer eko_live_fixture', origin }, payload: { name: 'Sample agent', kind: 'other', preset: 'safe' } });
    expect(response.statusCode).toBe(401);
    for (const from of [undefined, 'https://foreign.example', `${origin}/path`]) {
      const refused = await built.app.inject({ method: 'POST', url: `/v1/agents/${agent.id}/keys`, headers: { cookie: a.cookie, ...(from ? { origin: from } : {}) }, payload: {} });
      expect(refused.statusCode).toBe(403);
    }
  });
  it('hides nonowned details, policies and keys and denies all nonowner mutations', async () => {
    const a = await owner(), b = await owner(), agent = await create(a.cookie);
    const key = ApiKeyCreatedSchema.parse((await call(a.cookie, 'POST', `/agents/${agent.id}/keys`, {})).json());
    expect((await call(b.cookie, 'GET', '/agents')).json()).toEqual({ agents: [] });
    for (const [method, path, body] of [
      ['GET', `/agents/${agent.id}`, undefined], ['GET', `/agents/${agent.id}/policy`, undefined], ['GET', `/agents/${agent.id}/keys`, undefined],
      ['PATCH', `/agents/${agent.id}`, { name: 'Foreign agent' }], ['DELETE', `/agents/${agent.id}`, undefined],
      ['POST', `/agents/${agent.id}/keys`, {}], ['DELETE', `/agents/${agent.id}/keys/${key.keyId}`, undefined],
      ['PUT', `/agents/${agent.id}/policy`, await built.ctx.harness.policy(a.id, agent.id)],
    ] as const) expect((await call(b.cookie, method, path, body)).statusCode, `${method} ${path}`).toBe(404);
    expect(await built.ctx.harness.authenticate(key.secret)).toMatchObject({ accountId: a.id });
  });
  it('returns a bearer once, persists only HMAC, records use and revokes idempotently', async () => {
    const a = await owner(), agent = await create(a.cookie), otherAgent = await create(a.cookie);
    const response = await call(a.cookie, 'POST', `/agents/${agent.id}/keys`, {});
    expect(response.headers['cache-control']).toBe('private, no-store');
    const key = ApiKeyCreatedSchema.parse(response.json());
    expect(key.secret).toMatch(new RegExp(`^eko_live_${key.prefix}_[A-Za-z0-9_-]{43}$`));
    const stored = await built.ctx.dbh.db.select().from(agentKeys).where(eq(agentKeys.id, key.keyId));
    expect(stored[0]!.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(key.secret); expect(JSON.stringify(stored)).not.toContain(key.secret.split('_').slice(3).join('_'));
    const auth = await built.ctx.harness.authenticate(key.secret);
    expect(auth).toMatchObject({ accountId: a.id, agent: { id: agent.id }, keyId: key.keyId });
    expect(await built.ctx.harness.authenticate(key.secret.slice(0, -1) + (key.secret.endsWith('A') ? 'B' : 'A'))).toBeNull();
    expect(await new HarnessService(built.ctx.dbh.db, 'other-fixture-pepper').authenticate(key.secret)).toBeNull();
    const listing = (await call(a.cookie, 'GET', `/agents/${agent.id}/keys`)).json();
    expect(ApiKeyInfoSchema.parse(listing.keys[0]).lastUsedAt).toBeDefined(); expect(JSON.stringify(listing)).not.toContain('secret'); expect(JSON.stringify(listing)).not.toContain(stored[0]!.hash);
    expect((await call(a.cookie, 'DELETE', `/agents/${otherAgent.id}/keys/${key.keyId}`)).statusCode).toBe(404);
    for (let i = 0; i < 2; i++) expect((await call(a.cookie, 'DELETE', `/agents/${agent.id}/keys/${key.keyId}`)).statusCode).toBe(200);
    expect(await built.ctx.harness.authenticate(key.secret)).toBeNull();
    expect((await call(a.cookie, 'GET', `/agents/${agent.id}/keys`)).json().keys[0].revokedAt).toBeDefined();
  });
  it('disconnects atomically with credential revocation and refuses subsequent issuance', async () => {
    const a = await owner(), agent = await create(a.cookie), key = ApiKeyCreatedSchema.parse((await call(a.cookie, 'POST', `/agents/${agent.id}/keys`, {})).json());
    expect((await call(a.cookie, 'DELETE', `/agents/${agent.id}`, undefined, launch)).json().status).toBe('disconnected');
    expect(await built.ctx.harness.authenticate(key.secret)).toBeNull();
    expect((await call(a.cookie, 'POST', `/agents/${agent.id}/keys`, {})).statusCode).toBe(409);
    expect((await call(a.cookie, 'GET', `/agents/${agent.id}/policy`)).json().killed).toBe(true);
    const absentPepper = new HarnessService(built.ctx.dbh.db);
    expect(await absentPepper.authenticate(key.secret)).toBeNull();
    await expect(absentPepper.createKey(a.id, agent.id)).rejects.toMatchObject({ code: 'internal_error' });
  });
  it('enforces concurrent admission and reconnect limits across independent service instances', async () => {
    const a = await owner();
    const results = await Promise.all(Array.from({ length: 6 }, () => call(a.cookie, 'POST', '/agents', { name: 'Concurrent agent', kind: 'other', preset: 'balanced' })));
    expect(results.map(r => r.statusCode).sort()).toEqual([201, 201, 429, 429, 429, 429]);
    const list = (await call(a.cookie, 'GET', '/agents')).json().agents;
    await call(a.cookie, 'DELETE', `/agents/${list[0].id}`);
    const independent = new HarnessService(built.ctx.dbh.db, placeholder);
    const admissions = await Promise.allSettled([
      independent.create(a.id, { name: 'Another agent', kind: 'other', preset: 'degen' }, 2),
      built.ctx.harness.update(a.id, list[0].id, { status: 'active' }, 2),
    ]);
    expect(admissions.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(admissions.filter(r => r.status === 'rejected')).toHaveLength(1);
    expect((await independent.list(a.id)).filter(agent => agent.status !== 'disconnected')).toHaveLength(2);
  });
  it('serves presets/GET policy at T, registers PUT only with its flag and appends versioned policies', async () => {
    const a = await owner(), agent = await create(a.cookie);
    expect((await launch.inject('/v1/policy-presets')).json().map((p: {name: string}) => p.name)).toEqual(['Safe', 'Balanced', 'Degen']);
    const policy = PolicySchema.parse((await call(a.cookie, 'GET', `/agents/${agent.id}/policy`, undefined, launch)).json());
    expect((await call(a.cookie, 'PUT', `/agents/${agent.id}/policy`, policy, launch)).statusCode).toBe(404);
    expect((await call(a.cookie, 'PATCH', `/agents/${agent.id}`, { status: 'soft_killed' }, launch)).statusCode).toBe(404);
    expect((await call(a.cookie, 'PUT', `/agents/${agent.id}/policy`, { ...policy, maxPositionPct: 101 })).statusCode).toBe(422);
    expect((await call(a.cookie, 'PUT', `/agents/${agent.id}/policy`, { ...policy, minLiquidityUsd: -1 })).statusCode).toBe(422);
    const saves = await Promise.all([call(a.cookie, 'PUT', `/agents/${agent.id}/policy`, { ...policy, maxPositionUsd: 12 }), call(a.cookie, 'PUT', `/agents/${agent.id}/policy`, { ...policy, maxPositionUsd: 13 })]);
    expect(saves.map(r => r.statusCode).sort()).toEqual([200, 409]);
    const history = await built.ctx.dbh.db.select().from(policies).where(eq(policies.agentId, agent.id));
    expect(history).toHaveLength(2); expect(history.find(p => p.version === 1)!.policy).toEqual(policy);
    expect((await built.ctx.chains.meter.usage()).sessionUnits).toBe(0);
  });
});

class Socket extends EventEmitter {
  readyState = 1; bufferedAmount = 0; sent: string[] = [];
  send(value: string) { this.sent.push(value); }
}
it('publishes agent events and sequences only to the subscribed owner, never public fan-out', () => {
  const hub = new Hub(), a = new Socket(), b = new Socket(), anonymous = new Socket();
  hub.addV1(a as unknown as WebSocket, 'sample-account-a'); hub.addV1(b as unknown as WebSocket, 'sample-account-b'); hub.addV1(anonymous as unknown as WebSocket);
  for (const socket of [a, b, anonymous]) socket.emit('message', JSON.stringify({ op: 'sub', ch: ['agents'] }));
  expect(anonymous.sent.some(raw => JSON.parse(raw).t === 'err')).toBe(true);
  const agent = AgentSchema.parse({ id: 'sample-agent', name: 'Sample agent', kind: 'other', status: 'active', guardrails: 'advisory', uncheckedOrders24h: 0 });
  hub.publishAgent('sample-account-a', agent); hub.publish('agents', 'agent', agent);
  const events = (socket: Socket) => socket.sent.map(raw => WsServerSchema.parse(JSON.parse(raw))).filter(message => message.t === 'ev');
  expect(events(a)).toHaveLength(1); expect(events(b)).toHaveLength(0); expect(events(anonymous)).toHaveLength(0);
  const later = new Socket(); hub.addV1(later as unknown as WebSocket, 'sample-account-b'); later.emit('message', JSON.stringify({ op: 'sub', ch: ['agents'] }));
  expect(JSON.parse(later.sent.at(-1)!).seq).toBe(0);
});
