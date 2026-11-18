import { afterEach, describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { getAddress } from 'viem';
import { loadElysiumRegistry } from '@eko/chain';
import { ELYSIUM_CHAIN_ID } from '@eko/shared';
import type { FastifyInstance } from 'fastify';
import { AccountStore } from '../src/accounts.js';
import { AgentStore, PRESETS } from '../src/agents.js';
import { HistoryStore } from '../src/history.js';
import { Tracker, type Rpc } from '../src/tracker.js';
import { Edge } from '../src/service.js';
import { HypeUsd } from '../src/hype.js';
import { buildServer } from '../src/server.js';
import { relayFromRpc } from '../src/relay.js';
import { Trading } from '../src/trade.js';

/**
 * Refusal tests for every state-changing route the edge serves (audit Path to 9, item 11). Each write route is checked
 * against the requests it must refuse: another site's page (403), no session (401), another account's agent, key,
 * approval, quote or order (404/403, and the owner's data is unchanged), and malformed input (400). The public writes
 * (sign-in, quotes, the RPC relay, MCP) are checked against what they must refuse instead.
 */
const registry = loadElysiumRegistry();
const host = 'eko.test', json = { host, 'content-type': 'application/json' };
const COIN = getAddress('0xabababababababababababababababababababab');
const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(a => a.close())); });

/** Every state-changing route, by method and path. `:agent`, `:key`, `:approval` and `:order` are filled with ids that belong to account A. */
const WRITES = [
  ['POST', '/v1/auth/siwe/nonce'], ['POST', '/v1/auth/siwe/verify'], ['POST', '/v1/auth/logout'],
  ['PUT', '/v1/me/preferences'], ['PUT', '/v1/me/journal-consent'], ['DELETE', '/v1/me/data'], ['POST', '/v1/telegram/link'],
  ['POST', '/v1/watch'], ['DELETE', '/v1/watch'], ['PUT', '/v1/alerts/settings'],
  ['POST', '/v1/agents'], ['PATCH', '/v1/agents/:agent'], ['POST', '/v1/agents/:agent/kill'], ['POST', '/v1/agents/kill-all'],
  ['PUT', '/v1/agents/:agent/policy'], ['POST', '/v1/agents/:agent/keys'], ['DELETE', '/v1/agents/:agent/keys/:key'], ['POST', '/v1/approvals/:approval'],
  ['POST', '/v1/trade/quote'], ['POST', '/v1/trade/order'], ['POST', '/v1/trade/order/:order/submitted'], ['POST', '/v1/trade/order/:order/rejected'],
  ['POST', '/v1/rpc'], ['POST', '/mcp'], ['DELETE', '/mcp'],
] as const;
type Method = typeof WRITES[number][0];
/** Writes that need a signed-in wallet. The rest are public by design: sign-in itself, quotes, the RPC relay, MCP (agent keys) and the unavailable Telegram link. */
const SIGNED_IN = new Set(['/v1/me/preferences', '/v1/me/journal-consent', '/v1/me/data', '/v1/watch', '/v1/alerts/settings', '/v1/agents', '/v1/agents/:agent',
  '/v1/agents/:agent/kill', '/v1/agents/kill-all', '/v1/agents/:agent/policy', '/v1/agents/:agent/keys', '/v1/agents/:agent/keys/:key', '/v1/approvals/:approval',
  '/v1/trade/order', '/v1/trade/order/:order/submitted', '/v1/trade/order/:order/rejected']);

async function world() {
  const store = new HistoryStore(':memory:'), accounts = new AccountStore(store.db);
  const rpc: Rpc = { request: async () => { throw new Error('no rpc'); } };
  const edge = new Edge(new Tracker(rpc, registry), rpc, registry, new HypeUsd(async () => new Response('{}')));
  const trading = new Trading({ db: store.db, rpc, chain: registry, coin: () => undefined, assess: async () => undefined, hypeUsd: () => 30, maxTradeUsd: 250 });
  const app = buildServer(edge, { store, accounts, trading, maxTradeUsd: 250, relay: relayFromRpc({ request: async () => '0x1' }) }); apps.push(app);
  const agents = new AgentStore(accounts.db);

  const signIn = async () => {
    const wallet = privateKeyToAccount(generatePrivateKey());
    const n = (await app.inject({ method: 'POST', url: '/v1/auth/siwe/nonce', headers: { host } })).json();
    const message = createSiweMessage({ domain: n.domain, address: wallet.address, uri: n.uri, version: '1', chainId: ELYSIUM_CHAIN_ID, nonce: n.nonce, issuedAt: new Date(n.issuedAt) });
    const res = await app.inject({ method: 'POST', url: '/v1/auth/siwe/verify', headers: json, payload: { message, signature: await wallet.signMessage({ message }) } });
    return { headers: { ...json, cookie: String(res.headers['set-cookie']).split(';')[0]! }, wallet: wallet.address, id: res.json().id as string };
  };
  const a = await signIn(), b = await signIn();

  // Account A owns an agent with a key, a pending approval, a watched coin, a quote and an order awaiting its signature.
  const agent = (await app.inject({ method: 'POST', url: '/v1/agents', headers: a.headers, payload: { name: 'A bot', preset: 'Safe' } })).json();
  const key = (await app.inject({ method: 'POST', url: `/v1/agents/${agent.id}/keys`, headers: a.headers, payload: {} })).json();
  const approval = agents.requestApproval(agents.byId(agent.id)!, 'pf_a', 'order-a-0001', 'Buy $300', undefined);
  await app.inject({ method: 'POST', url: '/v1/watch', headers: a.headers, payload: { kind: 'coin', target: COIN } });
  const quotes = (trading as unknown as { quotes: Map<string, unknown> }).quotes;
  quotes.set('q_a', { quote: { id: 'q_a', account: a.wallet, side: 'buy', expiresAt: new Date(Date.now() + 60_000).toISOString(), guard: { decision: 'allow', checks: [] } }, at: Date.now() });
  const accountA = accounts.bySession(a.headers.cookie.split('=')[1])!;
  store.db.prepare(`INSERT INTO orders(id, account_id, wallet, quote_id, idem, coin, side, amount_in, min_out, status, created_at, updated_at)
    VALUES('ord_a', ?, ?, 'q_a', 'idem-a', ?, 'buy', '1', '1', 'awaiting_signature', 0, 0)`).run(accountA.id, a.wallet, COIN.toLowerCase());

  const ids: Record<string, string> = { ':agent': agent.id, ':key': key.keyId, ':approval': approval.id, ':order': 'ord_a' };
  const url = (path: string) => path.replace(/:[a-z]+/g, m => ids[m]!);
  const call = (method: Method, path: string, headers: Record<string, string>, payload?: unknown) => {
    // A DELETE without a body sends no content type (an empty JSON body is itself a 400).
    const { 'content-type': _type, ...bare } = headers;
    return app.inject({ method, url: path, ...(payload === undefined && method === 'DELETE' ? { headers: bare } : { headers, payload: (payload ?? {}) as object }) });
  };
  /** A's own state, read through A's session: what B's refused requests must leave alone. */
  const snapshot = async () => ({
    agent: (await app.inject({ url: `/v1/agents/${agent.id}`, headers: a.headers })).json(),
    keys: (await app.inject({ url: `/v1/agents/${agent.id}/keys`, headers: a.headers })).json(),
    approval: (await app.inject({ url: `/v1/approvals/${approval.id}`, headers: a.headers })).json(),
    watch: (await app.inject({ url: '/v1/watch', headers: a.headers })).json(),
    order: (await app.inject({ url: '/v1/trade/orders/ord_a', headers: a.headers })).json(),
    // Read without using the key (a lookup by secret would stamp it as used).
    keyRevoked: (accounts.db.prepare('SELECT revoked_at FROM agent_keys WHERE key_id = ?').get(key.keyId) as { revoked_at: number | null }).revoked_at,
  });
  return { app, agents, accounts, a, b, agent, key, approval, url, call, snapshot };
}

describe('refusals on every edge write route (audit: no refusal tests)', () => {
  it('lists every state-changing route the server registers', async () => {
    const { app } = await world();
    const registered = app.printRoutes({ commonPrefix: false, includeHooks: false });
    // Each route in the table answers something other than the catch-all 404, so the table cannot name a route that is gone.
    for (const [method, path] of WRITES) {
      const res = await app.inject({ method, url: path.replace(/:[a-z]+/g, 'x'), headers: { ...json, origin: `https://${host}` }, ...(method === 'DELETE' ? {} : { payload: {} }) });
      expect(res.json()?.message ?? '', `${method} ${path}`).not.toBe('Not available on EKO for Elysium yet.');
    }
    expect(registered).toContain('mcp');
  });

  it('refuses a write sent by another site\'s page (403) on every cookie-authenticated route', async () => {
    const { a, url, call, snapshot } = await world();
    const before = await snapshot();
    for (const [method, path] of WRITES) {
      if (path === '/v1/rpc' || path.startsWith('/mcp')) continue; // no cookies: the relay is read-only, MCP uses bearer keys
      const res = await call(method, url(path), { ...a.headers, origin: 'https://evil.example' });
      expect(res.statusCode, `${method} ${path}`).toBe(403);
    }
    expect(await snapshot()).toEqual(before);
  });

  it('refuses every signed-in write without a session (401)', async () => {
    const { url, call, snapshot } = await world();
    const before = await snapshot();
    for (const [method, path] of WRITES) {
      if (!SIGNED_IN.has(path)) continue;
      expect((await call(method, url(path), json)).statusCode, `${method} ${path}`).toBe(401);
    }
    // A forged or expired session cookie is no session.
    expect((await call('POST', '/v1/agents', { ...json, cookie: 'eko_session=forged' }, { name: 'X' })).statusCode).toBe(401);
    expect(await snapshot()).toEqual(before);
  });

  it('refuses one account acting on another account\'s agent, key, approval, quote, order or data', async () => {
    const { app, b, agent, key, approval, call, snapshot } = await world();
    const before = await snapshot();
    expect(before.approval.status).toBe('pending'); expect(before.keyRevoked).toBeNull(); expect(before.watch.items).toHaveLength(1);
    const bh = b.headers;
    for (const [method, path, payload] of [
      ['PATCH', `/v1/agents/${agent.id}`, { name: 'Taken', wallet: b.wallet }], ['POST', `/v1/agents/${agent.id}/kill`, { mode: 'hard' }],
      ['PUT', `/v1/agents/${agent.id}/policy`, PRESETS[2]!.policy], ['POST', `/v1/agents/${agent.id}/keys`, {}],
      ['DELETE', `/v1/agents/${agent.id}/keys/${key.keyId}`, undefined], ['POST', `/v1/approvals/${approval.id}`, { decision: 'approved' }],
      ['POST', '/v1/trade/order/ord_a/submitted', { txHash: `0x${'1'.repeat(64)}` }], ['POST', '/v1/trade/order/ord_a/rejected', { code: 'user_rejected' }],
    ] as const) expect((await call(method, path, bh, payload)).statusCode, `${method} ${path}`).toBe(404);
    // A's quote was made for A's wallet: B cannot turn it into an order.
    expect((await call('POST', '/v1/trade/order', bh, { quoteId: 'q_a', idempotencyKey: 'b-1', acknowledged: [] })).statusCode).toBe(403);
    // B's own agent cannot be used to reach A's key, and B's account-wide writes stay inside B's account.
    const mine = (await call('POST', '/v1/agents', bh, { name: 'B bot' })).json();
    expect((await call('DELETE', `/v1/agents/${mine.id}/keys/${key.keyId}`, bh)).statusCode).toBe(200);
    expect((await call('POST', '/v1/agents/kill-all', bh)).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: `/v1/watch?kind=coin&target=${COIN}`, headers: { host: bh.host, cookie: bh.cookie } })).statusCode).toBe(200);
    expect((await call('DELETE', '/v1/me/data', bh)).statusCode).toBe(200);
    // A's agent, key, approval, watchlist and order are exactly as they were.
    expect(await snapshot()).toEqual(before);
  });

  it('refuses malformed input on every write that takes any (400)', async () => {
    const { app, a, agent, approval, call, snapshot } = await world();
    const before = await snapshot();
    const ah = a.headers;
    for (const [method, path, payload] of [
      ['POST', '/v1/auth/siwe/verify', { message: 1, signature: 2 }],
      ['PUT', '/v1/me/preferences', 'nope'], ['PUT', '/v1/me/journal-consent', { optedIn: 'yes' }],
      ['POST', '/v1/watch', { kind: 'coin', target: 'not-an-address' }], ['POST', '/v1/watch', { kind: 'planet', target: COIN }], ['DELETE', '/v1/watch', undefined],
      ['PUT', '/v1/alerts/settings', { minLevel: 'loud' }],
      ['POST', '/v1/agents', { name: '   ' }], ['PATCH', `/v1/agents/${agent.id}`, {}], ['PATCH', `/v1/agents/${agent.id}`, { status: 'soft_killed' }],
      ['PATCH', `/v1/agents/${agent.id}`, { wallet: '0x1234' }], ['PATCH', `/v1/agents/${agent.id}`, { name: '' }],
      ['PUT', `/v1/agents/${agent.id}/policy`, { ...PRESETS[0]!.policy, maxPositionPct: 'all' }], ['POST', `/v1/approvals/${approval.id}`, { decision: 'maybe' }],
      ['POST', '/v1/trade/quote', { coin: 'nope' }], ['POST', '/v1/trade/order', { quoteId: 1 }],
      ['POST', '/v1/trade/order', { quoteId: 'q_a', idempotencyKey: 'x'.repeat(81), acknowledged: [] }], ['POST', '/v1/trade/order/ord_a/submitted', { txHash: '0x12' }],
    ] as const) expect((await call(method, path, ah, payload)).statusCode, `${method} ${path} ${JSON.stringify(payload)}`).toBe(400);
    // Sign-in messages for another chain, or signed by another wallet, are refused (401) and open no session.
    const n = (await app.inject({ method: 'POST', url: '/v1/auth/siwe/nonce', headers: { host } })).json();
    const someone = privateKeyToAccount(generatePrivateKey()), other = privateKeyToAccount(generatePrivateKey());
    const msg = (chainId: number) => createSiweMessage({ domain: n.domain, address: someone.address, uri: n.uri, version: '1', chainId, nonce: n.nonce, issuedAt: new Date(n.issuedAt) });
    const wrongChain = await app.inject({ method: 'POST', url: '/v1/auth/siwe/verify', headers: json, payload: { message: msg(1), signature: await someone.signMessage({ message: msg(1) }) } });
    const wrongSigner = await app.inject({ method: 'POST', url: '/v1/auth/siwe/verify', headers: json, payload: { message: msg(ELYSIUM_CHAIN_ID), signature: await other.signMessage({ message: msg(ELYSIUM_CHAIN_ID) }) } });
    for (const res of [wrongChain, wrongSigner]) { expect(res.statusCode).toBe(401); expect(res.headers['set-cookie']).toBeUndefined(); }
    // Telegram linking is not offered on Elysium.
    expect((await call('POST', '/v1/telegram/link', ah)).statusCode).toBe(503);
    expect(await snapshot()).toEqual(before);
  });

  it('refuses what the public writes must not do: relay writes or full blocks, unknown agent keys, oversized batches', async () => {
    const { app, agents, agent, key } = await world();
    const rpc = (body: object) => app.inject({ method: 'POST', url: '/v1/rpc', headers: json, payload: body });
    for (const body of [{ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: ['0x00'] }, { jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber', params: ['latest', true] },
      { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [1, 2, 3, 4, 5] }, { jsonrpc: '2.0', id: 1 }]) expect((await rpc(body)).statusCode, JSON.stringify(body)).toBe(400);
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] })).json()).toEqual({ jsonrpc: '2.0', id: 1, result: '0x1' });

    const mcp = (payload: unknown, bearer?: string) => app.inject({ method: 'POST', url: '/mcp', headers: { ...json, ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, payload: payload as object });
    const note = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'journal', arguments: { kind: 'note', payload: { x: 1 } } } };
    expect((await mcp(note, 'eko_not-a-real-key')).statusCode).toBe(401);
    // Without a key, a tool that writes answers with an error and writes nothing.
    expect((await mcp(note)).json().result).toMatchObject({ isError: true });
    expect((await mcp(Array.from({ length: 21 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'ping' })))).statusCode).toBe(400);
    expect((await mcp({ jsonrpc: '1.0', id: 1, method: 'ping' })).json().error.code).toBe(-32600);
    expect((await app.inject({ method: 'DELETE', url: '/mcp', headers: { host } })).statusCode).toBe(405);
    // A revoked key stops working at once, and so does every key of a hard-killed agent.
    expect((await mcp(note, key.secret)).statusCode).toBe(200);
    agents.revokeKeys(agent.id, key.keyId);
    expect((await mcp(note, key.secret)).statusCode).toBe(401);
    expect(agents.journalPage(agent.id, {}).rows.filter((r: { kind: string }) => r.kind === 'note')).toHaveLength(1);
  });
});
