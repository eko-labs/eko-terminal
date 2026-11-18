import { afterEach, describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { getAddress } from 'viem';
import { loadElysiumRegistry } from '@eko/chain';
import { ELYSIUM_CHAIN_ID } from '@eko/shared';
import type { FastifyInstance } from 'fastify';
import { AccountStore, SESSIONS_KEPT } from '../src/accounts.js';
import { AgentStore, AGENTS_KEPT, APPROVALS_KEPT, JOURNAL_KEEP, KEY_ROWS_KEPT, MAX_KEYS_PER_AGENT, PRESETS } from '../src/agents.js';
import { ANON_QUOTES_PER_MIN, MAX_IN_FLIGHT, ORDERS_KEPT, ORDERS_PER_MIN, QUOTES_PER_MIN, Trading, tradeRpc } from '../src/trade.js';
import { NEW_ACCOUNTS_PER_ADDRESS_DAY } from '../src/accounts.js';
import { AGENT_ROWS_PER_ACCOUNT_DAY } from '../src/agents.js';
import { freeSpaceCheck, setStorageGuard } from '../src/storage-guard.js';
import { HistoryStore } from '../src/history.js';
import { FunderTracer } from '../src/funders.js';
import { Tracker, type Rpc } from '../src/tracker.js';
import { Edge } from '../src/service.js';
import { HypeUsd } from '../src/hype.js';
import { buildServer } from '../src/server.js';
import { relayFromRpc } from '../src/relay.js';
import { registerRealtime } from '../src/ws.js';
import { loadBuild } from '../src/build.js';
import type { Explorer } from '../src/explorer.js';

const registry = loadElysiumRegistry();
const host = 'eko.test', json = { host, 'content-type': 'application/json' };
const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(a => a.close())); });

function server(extra: Parameters<typeof buildServer>[1] = {}) {
  const store = new HistoryStore(':memory:'), accounts = new AccountStore(store.db);
  const rpc: Rpc = { request: async () => { throw new Error('no rpc'); } };
  const edge = new Edge(new Tracker(rpc, registry), rpc, registry, new HypeUsd(async () => new Response('{}')));
  const app = buildServer(edge, { store, accounts, ...extra }); apps.push(app);
  return { app, store, accounts, edge };
}
async function signIn(app: FastifyInstance, headers: Record<string, string> = {}) {
  const wallet = privateKeyToAccount(generatePrivateKey());
  const n = (await app.inject({ method: 'POST', url: '/v1/auth/siwe/nonce', headers: { host, ...headers } })).json();
  const message = createSiweMessage({ domain: n.domain, address: wallet.address, uri: n.uri, version: '1', chainId: ELYSIUM_CHAIN_ID, nonce: n.nonce, issuedAt: new Date(n.issuedAt) });
  const res = await app.inject({ method: 'POST', url: '/v1/auth/siwe/verify', headers: { ...json, ...headers }, payload: { message, signature: await wallet.signMessage({ message }) } });
  return { ...json, cookie: String(res.headers['set-cookie']).split(';')[0]! };
}

describe('request size (audit: zod memory exhaustion)', () => {
  it('refuses a 1 MB policy body with 413 and a policy with oversized lists with 400', async () => {
    const { app } = server(), authed = await signIn(app);
    const agent = (await app.inject({ method: 'POST', url: '/v1/agents', headers: authed, payload: { name: 'Bot', preset: 'Safe' } })).json();
    const huge = { ...PRESETS[0]!.policy, allowAssets: Array.from({ length: 80_000 }, () => '0xabababababab') };
    expect((await app.inject({ method: 'PUT', url: `/v1/agents/${agent.id}/policy`, headers: authed, payload: huge })).statusCode).toBe(413);
    const long = { ...PRESETS[0]!.policy, allowAssets: Array.from({ length: 201 }, (_, i) => `0x${i}`) };
    expect((await app.inject({ method: 'PUT', url: `/v1/agents/${agent.id}/policy`, headers: authed, payload: long })).statusCode).toBe(400);
  });
});

describe('client address (audit: limits trust a client-written header)', () => {
  it('ignores a spoofed X-Forwarded-For behind one proxy hop', async () => {
    const { app } = server();
    // Railway appends the real client address; anything before it is whatever the client sent.
    const from = (spoof: string) => ({ host, 'x-forwarded-for': `${spoof}, 203.0.113.9` });
    const codes: number[] = [];
    for (let i = 0; i < 31; i++) codes.push((await app.inject({ method: 'POST', url: '/v1/auth/siwe/nonce', headers: from(`198.51.100.${i}`) })).statusCode);
    expect(codes.slice(0, 30).every(c => c === 200)).toBe(true);
    expect(codes[30]).toBe(429); // 30 a minute per real address, however the spoofed part rotates
  });
});

describe('funder tracing (audit: anyone can starve funder tracing)', () => {
  it('traces live deployers before any number of page lookups, and never queues unknown wallets', async () => {
    const store = new HistoryStore(':memory:'), traced: string[] = [];
    const explorer = { firstTxs: async (w: string) => { traced.push(w); return { normal: [], internal: [] }; } } as unknown as Explorer;
    const funders = new FunderTracer(explorer, store, { concurrency: 1, maxLookups: 50 });
    const deployer = '0x00000000000000000000000000000000000d3910';
    funders.want(['0x0000000000000000000000000000000000000001']); // busy: the one slot is taken
    funders.want([deployer]);
    for (let i = 0; i < 500; i++) funders.want([`0x${(0x1000 + i).toString(16).padStart(40, '0')}`], 'lookup');
    expect(funders.pending).toBe(51); // the deployer plus the newest 50 lookups
    await new Promise(r => setTimeout(r, 0)); await new Promise(r => setTimeout(r, 0));
    expect(traced.slice(0, 2)).toEqual(['0x0000000000000000000000000000000000000001', deployer]);

    const { app } = server({ store, funders });
    const before = funders.pending;
    expect((await app.inject({ url: `/v1/deployers/0x${'9'.repeat(40)}`, headers: { host } })).statusCode).toBe(200);
    expect(funders.pending).toBe(before); // a wallet with no known launch is not queued
  });
});

describe('RPC relay (audit: unauthenticated relay starves the paid lane)', () => {
  it('runs on its own client with a per-client limit, never on the tracker\'s RPC', async () => {
    let trackerCalls = 0, relayCalls = 0;
    const relay = relayFromRpc({ request: async () => { relayCalls++; return '0x1'; } }, { perClientPerMin: 5, inFlight: 4 });
    const { app } = server({ rpc: { request: async () => { trackerCalls++; return '0x1'; } }, relay });
    const call = () => app.inject({ method: 'POST', url: '/v1/rpc', headers: json, payload: { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] } });
    const codes = []; for (let i = 0; i < 7; i++) codes.push((await call()).statusCode);
    expect(codes).toEqual([200, 200, 200, 200, 200, 429, 429]);
    expect(relayCalls).toBe(5); expect(trackerCalls).toBe(0);
  });
});

describe('storage (audit: free accounts can fill the shared database)', () => {
  it('keeps each agent\'s newest rows, caps notes per account per day, and counts every batch entry', async () => {
    const store = new HistoryStore(':memory:'), agents = new AgentStore(new AccountStore(store.db).db);
    const a = agents.create('acct_q', 'Bot', 'onchain', PRESETS[1]!.policy);
    for (let i = 0; i <= JOURNAL_KEEP; i++) agents.journal(a.id, 'note', { i });
    const n = (store.db.prepare('SELECT count(*) AS n, min(json_extract(payload, \'$.i\')) AS oldest FROM journal WHERE agent_id = ?').get(a.id)) as { n: number; oldest: number };
    expect(n).toEqual({ n: JOURNAL_KEEP, oldest: 1 }); // the 1,001st row pushed out the first
    expect(agents.agentNotesToday('acct_q')).toBe(JOURNAL_KEEP);

    const { app } = server(), authed = await signIn(app);
    const agent = (await app.inject({ method: 'POST', url: '/v1/agents', headers: authed, payload: { name: 'Bot' } })).json();
    const key = (await app.inject({ method: 'POST', url: `/v1/agents/${agent.id}/keys`, headers: authed, payload: {} })).json().secret;
    const note = (id: number) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'journal', arguments: { kind: 'note', payload: { id } } } });
    const batch = (from: number) => app.inject({ method: 'POST', url: '/mcp', headers: { ...json, authorization: `Bearer ${key}` }, payload: Array.from({ length: 20 }, (_, i) => note(from + i)) as never });
    const codes = []; for (let b = 0; b < 7; b++) codes.push((await batch(b * 20)).statusCode);
    expect(codes).toEqual([200, 200, 200, 200, 200, 200, 429]); // 120 calls a minute, counted per entry
  });
});

describe('storage bounds per account (rescore: storage growth not fully bounded)', () => {
  const count = (store: HistoryStore, sql: string, ...args: unknown[]) => (store.db.prepare(sql).get(...(args as never[])) as { n: number }).n;

  it('caps live keys per agent and keeps a bounded number of revoked key rows', async () => {
    const { app, store } = server(), authed = await signIn(app);
    const agent = (await app.inject({ method: 'POST', url: '/v1/agents', headers: authed, payload: { name: 'Bot' } })).json();
    const mint = () => app.inject({ method: 'POST', url: `/v1/agents/${agent.id}/keys`, headers: authed, payload: {} });
    for (let i = 0; i < MAX_KEYS_PER_AGENT; i++) expect((await mint()).statusCode).toBe(200);
    expect((await mint()).statusCode).toBe(400);
    // Revoking makes room, but churning keys never grows the table past KEY_ROWS_KEPT for the agent.
    for (let i = 0; i < 40; i++) {
      const key = (await app.inject({ url: `/v1/agents/${agent.id}/keys`, headers: authed })).json().keys.find((k: { revokedAt?: string }) => !k.revokedAt);
      await app.inject({ method: 'DELETE', url: `/v1/agents/${agent.id}/keys/${key.keyId}`, headers: { host, cookie: authed.cookie } });
      expect((await mint()).statusCode).toBe(200);
    }
    expect(count(store, 'SELECT count(*) AS n FROM agent_keys WHERE agent_id = ?', agent.id)).toBeLessThanOrEqual(KEY_ROWS_KEPT);
  });

  it('keeps at most AGENTS_KEPT agents per account however often agents are hard-killed and replaced, and deletes the oldest one\'s rows', async () => {
    const { app, store } = server(), authed = await signIn(app);
    const ids: string[] = [];
    for (let i = 0; i < AGENTS_KEPT + 6; i++) {
      const agent = (await app.inject({ method: 'POST', url: '/v1/agents', headers: authed, payload: { name: `Bot ${i}` } })).json();
      expect(agent.id).toBeTruthy(); ids.push(agent.id);
      store.db.prepare(`INSERT INTO journal(id, agent_id, ts, kind, payload, share, commitment) VALUES(?, ?, 0, 'note', '{}', 0, 'x')`).run(`j_${i}`, agent.id);
      await app.inject({ method: 'POST', url: `/v1/agents/${agent.id}/kill`, headers: authed, payload: { mode: 'hard' } });
    }
    const acct = (store.db.prepare('SELECT account_id AS a FROM agents WHERE id = ?').get(ids.at(-1)!) as { a: string }).a;
    expect(count(store, 'SELECT count(*) AS n FROM agents WHERE account_id = ?', acct)).toBeLessThanOrEqual(AGENTS_KEPT);
    expect(count(store, 'SELECT count(*) AS n FROM journal WHERE agent_id = ?', ids[0])).toBe(0); // the oldest agent's rows went with it
    expect(count(store, 'SELECT count(*) AS n FROM journal WHERE agent_id = ?', ids.at(-1)!)).toBe(1);
  });

  it('keeps APPROVALS_KEPT settled approvals per agent and every pending one', () => {
    const store = new HistoryStore(':memory:'), agents = new AgentStore(new AccountStore(store.db).db);
    const a = agents.create('acct_q', 'Bot', 'onchain', PRESETS[0]!.policy);
    for (let i = 0; i < APPROVALS_KEPT + 50; i++) agents.decide('acct_q', agents.requestApproval(a, `pf_${i}`, `ref-${i}`, 'Buy', undefined).id, 'denied');
    const pending = agents.requestApproval(a, 'pf_last', 'ref-last', 'Buy', undefined);
    expect(count(store, `SELECT count(*) AS n FROM approvals WHERE agent_id = ? AND status != 'pending'`, a.id)).toBe(APPROVALS_KEPT);
    expect(agents.approval('acct_q', pending.id)?.status).toBe('pending');
  });

  it('keeps SESSIONS_KEPT sessions per wallet, newest first', () => {
    const store = new HistoryStore(':memory:'), accounts = new AccountStore(store.db);
    const acct = accounts.accountFor(getAddress('0x00000000000000000000000000000000000a11ce'));
    const tokens = Array.from({ length: SESSIONS_KEPT + 5 }, () => accounts.openSession(acct.id));
    expect(count(store, 'SELECT count(*) AS n FROM sessions WHERE account_id = ?', acct.id)).toBe(SESSIONS_KEPT);
    expect(accounts.bySession(tokens.at(-1))?.id).toBe(acct.id);
    expect(accounts.bySession(tokens[0])).toBeNull();
  });

  it('keeps ORDERS_KEPT settled orders per account and never deletes one in flight', async () => {
    const store = new HistoryStore(':memory:'), wallet = getAddress('0x00000000000000000000000000000000000a11ce');
    const trading = new Trading({ db: store.db, rpc: { request: async () => '0x' }, chain: registry, coin: () => undefined, assess: async () => undefined, hypeUsd: () => 30, maxTradeUsd: 250 });
    const insert = (id: string, status: string, t: number) => store.db.prepare(`INSERT INTO orders(id, account_id, wallet, quote_id, idem, coin, side, amount_in, min_out, status, created_at, updated_at)
      VALUES(?, 'acct_o', ?, 'q', ?, '0x0', 'buy', '1', '1', ?, ?, ?)`).run(id, wallet.toLowerCase(), id, status, t, t);
    for (let i = 0; i < ORDERS_KEPT + 100; i++) insert(`old_${i}`, 'confirmed', i);
    insert('in_flight', 'submitted', 0);
    const key = { currency0: '0x0000000000000000000000000000000000000000', currency1: getAddress('0x4da0ff60be75fdff37bfb2252adf23ea27a9acce'), fee: 0, tickSpacing: 60,
      hooks: getAddress('0x3ab88ddc3cf2a012af88b60828edb4553697e5dc') };
    (trading as unknown as { quotes: Map<string, unknown> }).quotes.set('q_new', { quote: { id: 'q_new', account: wallet, coin: key.currency1, side: 'buy',
      expiresAt: new Date(Date.now() + 60_000).toISOString(), guard: { decision: 'allow', checks: [] } }, route: { kind: 'v4', key, token: key.currency1 }, amountIn: 1n, minOut: 1n, at: Date.now() });
    await trading.order('acct_o', wallet, { quoteId: 'q_new', idempotencyKey: 'new-1', acknowledged: [] });
    expect(count(store, `SELECT count(*) AS n FROM orders WHERE account_id = 'acct_o' AND status = 'confirmed'`)).toBeLessThanOrEqual(ORDERS_KEPT);
    expect(count(store, `SELECT count(*) AS n FROM orders WHERE id IN ('in_flight')`)).toBe(1);
  });

  it('limits public quotes per client address (each spends paid-lane RPC reads)', async () => {
    const store = new HistoryStore(':memory:'), accounts = new AccountStore(store.db);
    const trading = new Trading({ db: store.db, rpc: { request: async () => '0x' }, chain: registry, coin: () => undefined, assess: async () => undefined, hypeUsd: () => 30, maxTradeUsd: 250 });
    const { app } = server({ store, accounts, trading });
    const codes: number[] = [];
    for (let i = 0; i <= QUOTES_PER_MIN; i++) codes.push((await app.inject({ method: 'POST', url: '/v1/trade/quote', headers: json, payload: {} })).statusCode);
    expect(codes.slice(0, QUOTES_PER_MIN).every(c => c === 400)).toBe(true);
    expect(codes.at(-1)).toBe(429);
  });
});

describe('orders, data deletion, daily journal quota and the storage guard (second independent check)', () => {
  const count = (store: HistoryStore, sql: string, ...args: unknown[]) => (store.db.prepare(sql).get(...(args as never[])) as { n: number }).n;
  const key = { currency0: '0x0000000000000000000000000000000000000000', currency1: getAddress('0x4da0ff60be75fdff37bfb2252adf23ea27a9acce'), fee: 0, tickSpacing: 60,
    hooks: getAddress('0x3ab88ddc3cf2a012af88b60828edb4553697e5dc') } as const;
  const tradingWith = (store: HistoryStore, calls: { n: number }) => new Trading({ db: store.db, rpc: { request: async () => { calls.n++; return '0x'; } }, chain: registry,
    coin: () => undefined, assess: async () => undefined, hypeUsd: () => 30, maxTradeUsd: 250 });
  const putQuote = (t: Trading, id: string, wallet: string) => (t as unknown as { quotes: Map<string, unknown> }).quotes.set(id, { quote: { id, account: wallet, coin: key.currency1,
    side: 'buy', expiresAt: new Date(Date.now() + 60_000).toISOString(), guard: { decision: 'allow', checks: [] } }, route: { kind: 'v4', key, token: key.currency1 }, amountIn: 1n, minOut: 1n, at: Date.now() });

  it('limits orders per account a minute, before any simulation', async () => {
    const store = new HistoryStore(':memory:'), accounts = new AccountStore(store.db), calls = { n: 0 };
    const { app } = server({ store, accounts, trading: tradingWith(store, calls) }), authed = await signIn(app);
    const codes: number[] = [];
    for (let i = 0; i <= ORDERS_PER_MIN; i++) codes.push((await app.inject({ method: 'POST', url: '/v1/trade/order', headers: authed, payload: { quoteId: 1 } })).statusCode);
    expect(codes.slice(0, ORDERS_PER_MIN).every(c => c === 400)).toBe(true);
    expect(codes.at(-1)).toBe(429);
    expect(calls.n).toBe(0);
  });

  it('caps orders in flight per account and does not simulate a repeated order again', async () => {
    const store = new HistoryStore(':memory:'), calls = { n: 0 }, t = tradingWith(store, calls), wallet = getAddress('0x00000000000000000000000000000000000a11ce');
    for (let i = 0; i < MAX_IN_FLIGHT; i++) { putQuote(t, `q_${i}`, wallet); await t.order('acct_f', wallet, { quoteId: `q_${i}`, idempotencyKey: `k-${i}`, acknowledged: [] }); }
    expect(calls.n).toBe(MAX_IN_FLIGHT);
    // The same order again returns it, without another paid-lane simulation.
    await t.order('acct_f', wallet, { quoteId: 'q_0', idempotencyKey: 'k-0', acknowledged: [] });
    expect(calls.n).toBe(MAX_IN_FLIGHT);
    putQuote(t, 'q_more', wallet);
    await expect(t.order('acct_f', wallet, { quoteId: 'q_more', idempotencyKey: 'k-more', acknowledged: [] })).rejects.toMatchObject({ status: 429 });
    expect(calls.n).toBe(MAX_IN_FLIGHT);
  });

  it('"delete my data" deletes the account\'s orders too', async () => {
    const store = new HistoryStore(':memory:'), accounts = new AccountStore(store.db), calls = { n: 0 }, trading = tradingWith(store, calls);
    const { app } = server({ store, accounts, trading }), authed = await signIn(app);
    const acct = accounts.bySession(authed.cookie.split('=')[1])!;
    store.db.prepare(`INSERT INTO orders(id, account_id, wallet, quote_id, idem, coin, side, amount_in, min_out, status, created_at, updated_at)
      VALUES('ord_x', ?, ?, 'q', 'i', '0x0', 'buy', '1', '1', 'confirmed', 0, 0)`).run(acct.id, acct.wallet.toLowerCase());
    expect((await app.inject({ method: 'DELETE', url: '/v1/me/data', headers: { host, cookie: authed.cookie } })).statusCode).toBe(200);
    expect(count(store, 'SELECT count(*) AS n FROM orders WHERE account_id = ?', acct.id)).toBe(0);
  });

  it('stops an account\'s agents at AGENT_ROWS_PER_ACCOUNT_DAY journal rows a day, decisions included', async () => {
    const { app, store } = server(), authed = await signIn(app);
    const agent = (await app.inject({ method: 'POST', url: '/v1/agents', headers: authed, payload: { name: 'Bot' } })).json();
    const secret = (await app.inject({ method: 'POST', url: `/v1/agents/${agent.id}/keys`, headers: authed, payload: {} })).json().secret;
    const insert = store.db.prepare(`INSERT INTO journal(id, agent_id, ts, kind, payload, preflight_id, share, commitment) VALUES(?, ?, ?, 'decision', '{}', 'pf', 0, 'x')`);
    for (let i = 0; i < AGENT_ROWS_PER_ACCOUNT_DAY; i++) insert.run(`d_${i}`, agent.id, Math.floor(Date.now() / 1000));
    const res = await app.inject({ method: 'POST', url: '/mcp', headers: { ...json, authorization: `Bearer ${secret}` },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'preflight', arguments: { clientOrderRef: 'order-q-0001', coin: getAddress('0xabababababababababababababababababababab'), side: 'sell', notionalUsd: 10 } } } });
    expect(res.json().result).toMatchObject({ isError: true });
    expect(JSON.stringify(res.json().result.content)).toMatch(/journal rows in the last day/);
    expect(count(store, 'SELECT count(*) AS n FROM journal WHERE agent_id = ?', agent.id)).toBe(AGENT_ROWS_PER_ACCOUNT_DAY);
  });

  it('pauses user-content writes (new accounts, agents) when the volume is low, while existing wallets still sign in', async () => {
    const { app } = server(), authed = await signIn(app);
    try {
      expect((await app.inject({ url: '/health' })).json().storage).toBe('ok');
      setStorageGuard(() => false);
      expect((await app.inject({ url: '/health' })).json().storage).toBe('low'); // what monitoring alerts on
      expect((await app.inject({ method: 'POST', url: '/v1/agents', headers: authed, payload: { name: 'Bot' } })).statusCode).toBe(507);
      const fresh = privateKeyToAccount(generatePrivateKey());
      const n = (await app.inject({ method: 'POST', url: '/v1/auth/siwe/nonce', headers: { host } })).json();
      const message = createSiweMessage({ domain: n.domain, address: fresh.address, uri: n.uri, version: '1', chainId: ELYSIUM_CHAIN_ID, nonce: n.nonce, issuedAt: new Date(n.issuedAt) });
      expect((await app.inject({ method: 'POST', url: '/v1/auth/siwe/verify', headers: json, payload: { message, signature: await fresh.signMessage({ message }) } })).statusCode).toBe(507);
      expect((await app.inject({ url: '/v1/me', headers: { host, cookie: authed.cookie } })).statusCode).toBe(200);
    } finally { setStorageGuard(() => true); }
    // The real check reads free space on the database's volume, cached between reads.
    let free = 600 * 1024 * 1024, t = 0;
    const check = freeSpaceCheck('.', 512, () => ({ bavail: free / 4096, bsize: 4096 }), 30_000, () => t);
    expect(check()).toBe(true);
    free = 100 * 1024 * 1024; expect(check()).toBe(true); // cached
    t = 31_000; expect(check()).toBe(false);
  });
});

describe('trading\'s paid-lane budget, service-level limits, new accounts and erasure (third independent check)', () => {
  const count = (store: HistoryStore, sql: string, ...args: unknown[]) => (store.db.prepare(sql).get(...(args as never[])) as { n: number }).n;

  it('caps trading\'s RPC use for every route together, a minute and in flight', async () => {
    let held: (() => void) | null = null, calls = 0;
    const slow: Rpc = { request: async () => { calls++; await new Promise<void>(r => { held = r; }); return '0x'; } };
    const capped = tradeRpc(slow, { perMin: 5, inFlight: 1 });
    const first = capped.request({ method: 'eth_call', params: [] });
    await expect(capped.request({ method: 'eth_call', params: [] })).rejects.toMatchObject({ status: 429 }); // one already in flight
    held!(); await first;
    const fast = tradeRpc({ request: async () => { calls++; return '0x'; } }, { perMin: 3, inFlight: 8 });
    for (let i = 0; i < 3; i++) await fast.request({ method: 'eth_call', params: [] });
    await expect(fast.request({ method: 'eth_call', params: [] })).rejects.toMatchObject({ status: 429 });
    expect(calls).toBe(4);
  });

  it('limits quotes per wallet and orders per account inside trading, so MCP\'s trade_prepare gets the same limits', async () => {
    const store = new HistoryStore(':memory:'), wallet = getAddress('0x00000000000000000000000000000000000a11ce');
    let calls = 0;
    const t = new Trading({ db: store.db, rpc: { request: async () => { calls++; throw new Error('insufficient funds'); } }, chain: registry,
      coin: () => undefined, assess: async () => undefined, hypeUsd: () => 30, maxTradeUsd: 250 });
    const q = { coin: getAddress('0xabababababababababababababababababababab'), side: 'buy' as const, amountUsd: 1, slippageBps: 100 };
    for (let i = 0; i < QUOTES_PER_MIN; i++) await expect(t.quote(q, wallet)).rejects.toMatchObject({ status: 404 }); // not followed: no RPC
    await expect(t.quote(q, wallet)).rejects.toMatchObject({ status: 429 });
    // Failed simulations (an empty agent wallet) store nothing, so they used to repeat freely; now each counts.
    const key = { currency0: '0x0000000000000000000000000000000000000000', currency1: getAddress('0x4da0ff60be75fdff37bfb2252adf23ea27a9acce'), fee: 0, tickSpacing: 60,
      hooks: getAddress('0x3ab88ddc3cf2a012af88b60828edb4553697e5dc') };
    const quotes = (t as unknown as { quotes: Map<string, unknown> }).quotes;
    for (let i = 0; i <= ORDERS_PER_MIN; i++) {
      quotes.set(`q${i}`, { quote: { id: `q${i}`, account: wallet, coin: key.currency1, side: 'buy', expiresAt: new Date(Date.now() + 60_000).toISOString(), guard: { decision: 'allow', checks: [] } },
        route: { kind: 'v4', key, token: key.currency1 }, amountIn: 1n, minOut: 1n, at: Date.now() });
      await expect(t.order('agent:agt_x', wallet, { quoteId: `q${i}`, idempotencyKey: `same-ref-${i}`, acknowledged: [] })).rejects.toMatchObject({ status: i < ORDERS_PER_MIN ? 409 : 429 });
    }
    expect(calls).toBe(ORDERS_PER_MIN);
  });

  it('limits new accounts per address a day, while known wallets keep signing in', async () => {
    const { app } = server();
    const known = privateKeyToAccount(generatePrivateKey());
    const signInAs = async (w: ReturnType<typeof privateKeyToAccount>) => {
      const n = (await app.inject({ method: 'POST', url: '/v1/auth/siwe/nonce', headers: { host } })).json();
      const message = createSiweMessage({ domain: n.domain, address: w.address, uri: n.uri, version: '1', chainId: ELYSIUM_CHAIN_ID, nonce: n.nonce, issuedAt: new Date(n.issuedAt) });
      return (await app.inject({ method: 'POST', url: '/v1/auth/siwe/verify', headers: json, payload: { message, signature: await w.signMessage({ message }) } })).statusCode;
    };
    expect(await signInAs(known)).toBe(200);
    for (let i = 1; i < NEW_ACCOUNTS_PER_ADDRESS_DAY; i++) expect(await signInAs(privateKeyToAccount(generatePrivateKey()))).toBe(200);
    expect(await signInAs(privateKeyToAccount(generatePrivateKey()))).toBe(429);
    expect(await signInAs(known)).toBe(200);
  });

  it('refuses watchlist and preference writes while storage is low, and erases an agent\'s orders with it', async () => {
    const { app, store } = server(), authed = await signIn(app);
    try {
      setStorageGuard(() => false);
      expect((await app.inject({ method: 'POST', url: '/v1/watch', headers: authed, payload: { kind: 'coin', target: getAddress('0xabababababababababababababababababababab') } })).statusCode).toBe(507);
      expect((await app.inject({ method: 'PUT', url: '/v1/me/journal-consent', headers: authed, payload: { optedIn: true } })).statusCode).toBe(507);
    } finally { setStorageGuard(() => true); }
    new Trading({ db: store.db, rpc: { request: async () => '0x' }, chain: registry, coin: () => undefined, assess: async () => undefined, hypeUsd: () => 30, maxTradeUsd: 250 });
    const agent = (await app.inject({ method: 'POST', url: '/v1/agents', headers: authed, payload: { name: 'Bot' } })).json();
    store.db.prepare(`INSERT INTO orders(id, account_id, wallet, quote_id, idem, coin, side, amount_in, min_out, status, created_at, updated_at)
      VALUES('ord_agent', ?, '0x0', 'q', 'i', '0x0', 'buy', '1', '1', 'confirmed', 0, 0)`).run(`agent:${agent.id}`);
    expect((await app.inject({ method: 'DELETE', url: '/v1/me/data', headers: { host, cookie: authed.cookie } })).statusCode).toBe(200);
    expect(count(store, `SELECT count(*) AS n FROM orders WHERE account_id = ?`, `agent:${agent.id}`)).toBe(0);
  });
});

describe('signed-out quotes and settlement keep their own share (fourth independent check)', () => {
  it('gives signed-out quotes, all together, a slice of trading\'s budget, never all of it', async () => {
    const store = new HistoryStore(':memory:');
    const t = new Trading({ db: store.db, rpc: { request: async () => '0x' }, chain: registry, coin: () => undefined, assess: async () => undefined, hypeUsd: () => 30, maxTradeUsd: 250 });
    const q = { coin: getAddress('0xabababababababababababababababababababab'), side: 'buy' as const, amountUsd: 1, slippageBps: 100 };
    for (let i = 0; i < ANON_QUOTES_PER_MIN; i++) await expect(t.quote(q, null)).rejects.toMatchObject({ status: 404 });
    await expect(t.quote(q, null)).rejects.toMatchObject({ status: 429 });
    // A signed-in wallet still gets its quote.
    await expect(t.quote(q, getAddress('0x00000000000000000000000000000000000a11ce'))).rejects.toMatchObject({ status: 404 });
  });

  it('skips a receipt check that could not run instead of failing a mined order, on its own reserved slice', async () => {
    const store = new HistoryStore(':memory:');
    let receiptCalls = 0;
    const t = new Trading({ db: store.db, rpc: { request: async () => { throw new Error('shared slice must not be used'); } },
      receiptRpc: { request: async () => { receiptCalls++; throw Object.assign(new Error('busy'), { status: 429 }); } },
      chain: registry, coin: () => undefined, assess: async () => undefined, hypeUsd: () => 30, maxTradeUsd: 250 });
    store.db.prepare(`INSERT INTO orders(id, account_id, wallet, quote_id, idem, coin, side, amount_in, min_out, status, tx_hash, created_at, updated_at)
      VALUES('ord_s', 'acct_s', '0x0', 'q', 'i', '0x0', 'buy', '1', '1', 'submitted', ?, 0, 0)`).run(`0x${'1'.repeat(64)}`);
    await t.reconcile();
    expect(receiptCalls).toBe(1);
    expect((store.db.prepare(`SELECT status FROM orders WHERE id = 'ord_s'`).get() as { status: string }).status).toBe('submitted');
  });
});

describe('websockets (audit: websocket slots can all be taken)', () => {
  it('refuses the 21st socket from one address and sockets opened by another site', async () => {
    const { app, edge } = server();
    await registerRealtime(app, edge, { maxPerAddress: 20 });
    await app.ready();
    // Listen before the socket opens: a refused socket is closed as soon as it is accepted, without the server's hello.
    // (The in-process transport reports every close as 1006 and can drop the hello, so each socket pings and the test checks for the pong.)
    const open = async (headers: Record<string, string> = { host }) => {
      let closed!: Promise<void>; const got: string[] = [];
      const ws = await app.injectWS('/v1/ws', { headers }, { onInit: (s) => {
        closed = new Promise<void>(r => s.on('close', () => r()));
        s.on('message', (m: Buffer) => got.push(JSON.parse(m.toString()).t));
      } });
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ op: 'ping' }));
      await new Promise(r => setTimeout(r, 20));
      return { ws, closed, got };
    };
    const held = []; for (let i = 0; i < 20; i++) held.push(await open());
    expect(held.every(h => h.got.includes('pong'))).toBe(true);
    const extra = await open();
    await extra.closed; expect(extra.got).toEqual([]);
    const foreign = await open({ host, origin: 'https://evil.example' });
    await foreign.closed; expect(foreign.got).toEqual([]);
    // A slot frees up when a socket closes.
    held.pop()!.ws.terminate(); await new Promise(r => setTimeout(r, 20));
    expect((await open()).got).toContain('pong');
    for (const h of held) h.ws.terminate();
  });

  it('holds at most 64 channels per socket across messages', async () => {
    const { app, edge } = server();
    await registerRealtime(app, edge);
    await app.ready();
    const acks: string[] = [];
    const ws = await app.injectWS('/v1/ws', { headers: { host } }, { onInit: (s) => {
      s.on('message', (m: Buffer) => { const msg = JSON.parse(m.toString()); if (msg.t === 'ack') acks.push(msg.ch); });
    } });
    ws.send(JSON.stringify({ op: 'sub', ch: Array.from({ length: 60 }, (_, i) => `c${i}`) }));
    ws.send(JSON.stringify({ op: 'sub', ch: Array.from({ length: 10 }, (_, i) => `d${i}`) }));
    ws.send(JSON.stringify({ op: 'sub', ch: ['c0'] })); // already held: acknowledged, not counted again
    await new Promise(r => setTimeout(r, 50));
    expect(acks.filter(c => c.startsWith('d'))).toEqual(['d0', 'd1', 'd2', 'd3']);
    expect(new Set(acks).size).toBe(64);
    ws.terminate();
  });
});

describe('build identity (audit: no post-deploy check)', () => {
  it('reports the deployed commit in /health', async () => {
    const commit = 'a'.repeat(40);
    expect(loadBuild(new URL('file:///nonexistent/build.json'), { BUILD_COMMIT: commit })).toEqual({ commit, builtAt: null });
    expect(loadBuild(new URL('file:///nonexistent/build.json'), { BUILD_COMMIT: 'not-a-sha' }).commit).toBeNull();
    expect(loadBuild(new URL('file:///nonexistent/build.json'), { RAILWAY_GIT_COMMIT_SHA: 'b'.repeat(40), BUILD_COMMIT: commit }).commit).toBe('b'.repeat(40));
    const { app } = server({ build: { commit, builtAt: '2026-11-14T00:00:00.000Z' } });
    expect((await app.inject({ url: '/health' })).json().build).toEqual({ commit, builtAt: '2026-11-14T00:00:00.000Z' });
  });
});

void getAddress;
