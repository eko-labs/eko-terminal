import { afterEach, describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { getAddress } from 'viem';
import { loadElysiumRegistry } from '@eko/chain';
import { ELYSIUM_CHAIN_ID } from '@eko/shared';
import type { FastifyInstance } from 'fastify';
import { AccountStore } from '../src/accounts.js';
import { AgentStore, JOURNAL_KEEP, PRESETS } from '../src/agents.js';
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
});

describe('build identity (audit: no post-deploy check)', () => {
  it('reports the deployed commit in /health', async () => {
    const commit = 'a'.repeat(40);
    expect(loadBuild(new URL('file:///nonexistent/build.json'), { BUILD_COMMIT: commit })).toEqual({ commit, builtAt: null });
    expect(loadBuild(new URL('file:///nonexistent/build.json'), { BUILD_COMMIT: 'not-a-sha' }).commit).toBeNull();
    const { app } = server({ build: { commit, builtAt: '2026-11-14T00:00:00.000Z' } });
    expect((await app.inject({ url: '/health' })).json().build).toEqual({ commit, builtAt: '2026-11-14T00:00:00.000Z' });
  });
});

void getAddress;
