// Offline scripted clients and fake upstream only; no platform or live-trade evidence.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { AgentDetailSchema, ApiKeyCreatedSchema, JournalEntrySchema, PackSchema, PreflightResultSchema, type Pack,
  type PreflightRequest, type PreflightResult } from '@eko/shared';
import { orderHash } from '../../../packages/policy/src/index.js';
import { NOW } from '../../../packages/policy/test/fixtures.js';
import { preflightFixture } from '../../server/test/preflight-fixture.js';
import { loadConfig } from '../../server/src/config.js';
import { AuthService } from '../../server/src/http/auth.js';
import { registerV1 } from '../../server/src/http/v1/index.js';
import { packRoutes } from '../../server/src/http/v1/packs.js';
import { FlagService } from '../../server/src/flags/service.js';
import { accounts } from '../../server/src/db/schema.js';
import { EntitlementsService } from '../../server/src/harness/entitlements.js';
import { buildMcpApp } from '../../mcp/src/app.js';
import { registerHarnessTools } from '../../mcp/src/harness.js';
import { ToolRegistry } from '../../mcp/src/tools.js';

let f: Awaited<ReturnType<typeof preflightFixture>>;
let api: ReturnType<typeof Fastify>, mcp: ReturnType<typeof buildMcpApp>, auth: AuthService;
const origin = 'https://app.eko.example', url = 'https://mcp.eko.example/mcp';
beforeAll(async () => {
  f = await preflightFixture();
  const cfg = loadConfig({ NODE_ENV: 'test', PGLITE_DIR: ':memory:', PUBLIC_ORIGIN: origin,
    SESSION_SECRET: 'fixture-session-placeholder'.repeat(2), LAUNCH_WEEK_AGENT_LIMIT: '10', LEGACY_API: 'false' });
  auth = new AuthService(f.handle.db, cfg);
  api = Fastify();
  await api.register(cookie, { secret: cfg.sessionSecret });
  await registerV1(api, cfg, new FlagService(async () => []), () => ({}) as never,
    undefined, undefined, undefined, { auth, harness: f.harness }, { auth, journal: f.journal });
  mcp = buildMcpApp({ publicUrl: url, tools: registerHarnessTools(new ToolRegistry(), f.service(), f.journal),
    authenticate: key => f.harness.authenticate(key), entitlements: () => new EntitlementsService(cfg).get(),
    limits: { consume: async () => ({ allowed: true, retryAfterSec: 60 }) } });
});
afterAll(async () => { await mcp?.close(); await api?.close(); await f?.close(); });

/** The endpoint and Authorization value a client sends after pasting this pack with its key. */
function connection(pack: Pack, key: string) {
  const template = pack.configTemplate.replaceAll('{{API_KEY}}', key);
  if (pack.platform === 'claude_code') {
    const [, url, authorization] = /^claude mcp add --transport http eko (\S+) --header "Authorization: ([^"]+)"$/.exec(template) ?? [];
    return { url, authorization };
  }
  const server = JSON.parse(template).mcpServers.eko;
  // Claude Desktop starts the mcp-remote bridge, which sends the env value as the header.
  if (pack.platform === 'claude_desktop') return { url: server.args[2], authorization: server.env.EKO_AUTH_HEADER };
  return { url: server.url, authorization: server.headers.Authorization };
}
function assertOrders(trace: { order: PreflightRequest; result: PreflightResult }[], orders: PreflightRequest[]) {
  for (const order of orders) expect(trace.some(check => check.result.decision === 'allow' &&
    check.order.clientOrderRef === order.clientOrderRef && orderHash(check.order.order) === orderHash(order.order)),
  'Every upstream order requires an earlier matching allow').toBe(true);
}
describe('096 generated API-key packs, scripted local connection sessions', () => {
  it('serves the CA-19 array at launch without authentication and leaves connectors pending 099', async () => {
    const response = await api.inject('/v1/packs');
    expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
    const packs = response.json().map((p: unknown) => PackSchema.parse(p));
    expect(packs.map((p: { platform: string; stage: string }) => [p.platform, p.stage])).toEqual([
      ['claude_code', 'T'], ['claude_desktop', 'T'], ['generic_mcp', 'T'], ['claude_connector', 'D0']]);
    expect(packs[3].configTemplate).toBe('{{MCP_URL}}'); expect(packs[3].setup).toContain('Pending task 099');
    expect((await mcp.inject('/oauth/authorize')).statusCode).toBe(404);
  });
  it('fills the deployment MCP endpoint into every template and leaves the key to the browser', async () => {
    const endpoint = 'https://mcp.staging.example.invalid/mcp', filled = Fastify();
    await filled.register(async area => packRoutes(area, loadConfig({ NODE_ENV: 'test', MCP_PUBLIC_URL: endpoint }).MCP_PUBLIC_URL));
    try {
      const packs = (await filled.inject('/packs')).json().map((p: unknown) => PackSchema.parse(p));
      expect(packs).toHaveLength(4);
      for (const pack of packs) {
        expect(pack.configTemplate).toContain(endpoint); expect(pack.configTemplate).not.toContain('{{MCP_URL}}');
        if (pack.platform !== 'claude_connector') expect(connection(pack, 'sample-key')).toEqual({ url: endpoint, authorization: 'Bearer sample-key' });
      }
      expect(packs.find((p: Pack) => p.platform === 'claude_connector')!.stage).toBe('D0');
    } finally { await filled.close(); }
    for (const invalid of ['http://mcp.staging.example.invalid/mcp', 'https://mcp.staging.example.invalid/', 'https://mcp.staging.example.invalid/mcp?key=1'])
      expect(() => loadConfig({ NODE_ENV: 'test', MCP_PUBLIC_URL: invalid })).toThrow();
  });
  it.each(['claude_code', 'claude_desktop', 'generic_mcp'])('%s: creates a key, journals first call, allows exact orders and stops on denial without retry', async platform => {
    const pack = (await api.inject('/v1/packs')).json().map((p: unknown) => PackSchema.parse(p)).find((p: {platform:string}) => p.platform === platform)!;
    const [account] = await f.handle.db.insert(accounts).values({ kind: 'wallet' }).returning();
    const token = await auth.createSession(account!.id), session = `eko_sid=${encodeURIComponent(api.signCookie(token))}`;
    const request = (method: 'POST' | 'GET', path: string, payload?: object) => api.inject({ method, url: `/v1${path}`,
      headers: { cookie: session, origin }, ...(payload ? { payload } : {}) });
    const created = await request('POST', '/agents', { name: 'Sample connection agent', kind: 'robinhood_mcp', preset: 'balanced', policy: { maxPositionUsd: 1000, approvalAboveUsd: 500 } });
    expect(created.statusCode).toBe(201); const agent = AgentDetailSchema.parse(created.json());
    const issued = await request('POST', `/agents/${agent.id}/keys`, {});
    expect(issued.statusCode).toBe(201); const key = ApiKeyCreatedSchema.parse(issued.json());
    const config = connection({ ...pack, configTemplate: pack.configTemplate.replaceAll('{{MCP_URL}}', url) }, key.secret);
    expect(config.url).toBe(url);
    const call = async (name: string, args: object) => {
      const response = await mcp.inject({ method: 'POST', url: '/mcp',
        headers: { authorization: config.authorization, accept: 'application/json, text/event-stream' },
        payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } });
      expect(response.statusCode).toBe(200); return response.json().result;
    };
    const before = await request('GET', `/agents/${agent.id}/journal?limit=1`);
    expect(before.json().rows).toEqual([]);
    expect((await call('journal', { kind: 'session_start', payload: { orders: [] } })).isError).toBe(true);
    expect((await request('GET', `/agents/${agent.id}/journal?limit=1`)).json().rows).toEqual([]);
    // Task 098 owns the consent UI. Explicit opt-in fixture, never inferred from a call.
    await f.journal.setConsent(account!.id, true);
    const start = JournalEntrySchema.parse((await call('journal', { kind: 'session_start', payload: { orders: [] } })).structuredContent);
    expect(start.agentId).toBe(agent.id);
    expect((await request('GET', `/agents/${agent.id}/journal?limit=1`)).json().rows[0].id).toBe(start.id);
    const trace: { order: PreflightRequest; result: PreflightResult }[] = [], emitted: PreflightRequest[] = [];
    const place_order = vi.fn(async (order: PreflightRequest) => {
      assertOrders(trace, [order]); emitted.push(structuredClone(order)); return { externalId: `fixture-fill-${emitted.length}` };
    });
    for (const [ref, size, decision, reason] of [
      ['fixture-allow', 100, 'allow', undefined], ['fixture-forced-deny', 1500, 'deny', 'position_cap'],
      ['fixture-approval-unavailable', 600, 'deny', 'approval_unavailable'],
    ] as const) {
      const req: PreflightRequest = { agentId: agent.id, clientOrderRef: ref,
        order: { venue: 'robinhood', instrument: 'DEMO', side: 'buy', orderType: 'market', notionalUsd: size },
        context: { reportedAt: new Date(NOW).toISOString(), positions: [], cashUsd: 10000, dailyPnlUsd: 0 } };
      const result = PreflightResultSchema.parse((await call('preflight', req)).structuredContent);
      trace.push({ order: structuredClone(req), result }); expect(result.decision).toBe(decision);
      if (reason) expect(result.reasons.some(r => r.startsWith(reason)), result.reasons.join(',')).toBe(true);
      await call('journal', { kind: 'decision', preflightId: result.preflightId, payload: { decision: result.decision, clientOrderRef: ref } });
      if (result.decision === 'allow') {
        const fill = await place_order(req);
        await call('journal', { kind: 'outcome', preflightId: result.preflightId, payload: fill });
      }
    }
    expect(place_order).toHaveBeenCalledTimes(1); expect(trace).toHaveLength(3);
    assertOrders(trace, emitted);
    // Negative control: the evaluator must reject missing, denied and changed-order allows.
    expect(() => assertOrders([], emitted)).toThrow();
    expect(() => assertOrders(trace, [trace[1]!.order])).toThrow();
    expect(() => assertOrders(trace, [{ ...emitted[0]!, order: { ...emitted[0]!.order, notionalUsd: 101 } }])).toThrow();
    const page = await f.journal.page(account!.id, agent.id);
    expect(page.rows).toHaveLength(8); expect(page.rows.filter(e => e.kind === 'outcome')).toHaveLength(1);
    expect(page.rows.filter(e => e.kind === 'decision')).toHaveLength(6);
    const stored = await f.handle.chain.sql.query<{ciphertext:Uint8Array}>('SELECT ciphertext FROM harness_journal WHERE agent_id=$1', [agent.id]);
    expect(stored.rows.every(row => !Buffer.from(row.ciphertext).toString().includes('fixture-allow'))).toBe(true);
    const persisted = await f.handle.chain.sql.query('SELECT client_order_ref,decision FROM preflights WHERE agent_id=$1', [agent.id]);
    expect(persisted.rows).toHaveLength(3);
    expect(JSON.stringify((await request('GET', `/agents/${agent.id}/keys`)).json())).not.toContain(key.secret);
    console.log(JSON.stringify({ platform, origin: 'offline_fixture', emitted_orders: emitted.length, preflight_calls: trace.length,
      upstream_requests: 0, cost_usd: 0, oauth: 'pending_099' }));
  });
});
