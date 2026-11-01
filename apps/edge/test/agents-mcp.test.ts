import { describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { getAddress } from 'viem';
import { loadElysiumRegistry } from '@eko/chain';
import { AgentDetailSchema, ApprovalSchema, ApiKeyCreatedSchema, ELYSIUM_CHAIN_ID, JournalEntrySchema, PackSchema, PreflightResultSchema, PublicConfigSchema } from '@eko/shared';
import { AccountStore } from '../src/accounts.js';
import { AgentStore, preflight, PRESETS } from '../src/agents.js';
import { HistoryStore } from '../src/history.js';
import { Tracker, type CoinState, type Rpc } from '../src/tracker.js';
import { Edge } from '../src/service.js';
import { HypeUsd } from '../src/hype.js';
import { buildServer } from '../src/server.js';
import type { Assessment } from '../src/assess.js';

const registry = loadElysiumRegistry();
const COIN = getAddress('0xabababababababababababababababababababab');

describe('preflight', () => {
  const setup = (level: string, playbooks: { id: string; level: string }[] = [], exitCostPct = 3) => {
    const store = new HistoryStore(':memory:'), agents = new AgentStore(new AccountStore(store.db).db);
    const agent = agents.create('acct_x', 'Bot', 'onchain', PRESETS[1]!.policy); // Balanced: blocks Danger, $500 cap, approval above $250
    const verdict = { coin: COIN.toLowerCase(), level, reasons: ['A reason.'], schemaVersion: 'verdict-1', asOfBlock: 1,
      playbooks: playbooks.map(p => ({ ...p, confidence: 1, evidence: [{ kind: 'stat', ref: `${COIN}:${p.id}:x`, block: 1, label: 'x', value: 1 }] })),
      receipt: { id: 'pending:x:1', hash: `0x${'0'.repeat(64)}`, status: 'pending' } };
    const a = { verdict, probe: { exitCostPct } } as unknown as Assessment;
    return { agents, agent, deps: { agents, coin: () => ({}) as CoinState, assess: async () => a } };
  };
  it('allows a small buy of a clear coin, denies Danger, honeypots, oversize and paused agents, and journals each decision', async () => {
    const { agents, agent, deps } = setup('clear');
    expect((await preflight(deps, agent, 'order-0001', { coin: COIN, side: 'buy', notionalUsd: 100 })).decision).toBe('allow');
    expect((await preflight(deps, agent, 'order-0002', { coin: COIN, side: 'buy', notionalUsd: 600 })).decision).toBe('deny');
    const danger = setup('danger', [{ id: 'honeypot', level: 'danger' }]);
    const r = PreflightResultSchema.parse(await preflight(danger.deps, danger.agent, 'order-0003', { coin: COIN, side: 'buy', notionalUsd: 50 }));
    expect(r.decision).toBe('deny'); expect(r.reasons.join(' ')).toMatch(/could not sell/);
    // Selling out of a honeypot is never blocked by EKO's advice.
    expect((await preflight(danger.deps, danger.agent, 'order-0004', { coin: COIN, side: 'sell', notionalUsd: 50 })).decision).toBe('allow');
    agents.setPolicy(agent.id, { ...agent.policy, killed: true });
    expect((await preflight(deps, agents.byId(agent.id)!, 'order-0005', { coin: COIN, side: 'buy', notionalUsd: 10 })).decision).toBe('deny');
    expect(agents.journalPage(agent.id, {}).rows.map(e => JournalEntrySchema.parse(e).kind)).toEqual(['decision', 'decision', 'decision']);
  });
  it('asks the owner above the approval line and allows the same order once approved', async () => {
    const { agents, agent, deps } = setup('clear');
    const first = await preflight(deps, agent, 'order-0100', { coin: COIN, side: 'buy', notionalUsd: 300 });
    expect(first.decision).toBe('needs_approval');
    const pending = agents.approvals('acct_x', 'pending');
    expect(pending.map(a => ApprovalSchema.parse(a).id)).toEqual([first.approvalId]);
    expect((await preflight(deps, agent, 'order-0100', { coin: COIN, side: 'buy', notionalUsd: 300 })).decision).toBe('needs_approval');
    agents.decide('acct_x', first.approvalId!, 'approved');
    expect((await preflight(deps, agent, 'order-0100', { coin: COIN, side: 'buy', notionalUsd: 300 })).decision).toBe('allow');
    const second = await preflight(deps, agent, 'order-0101', { coin: COIN, side: 'buy', notionalUsd: 300 });
    agents.decide('acct_x', second.approvalId!, 'denied');
    expect((await preflight(deps, agent, 'order-0101', { coin: COIN, side: 'buy', notionalUsd: 300 })).decision).toBe('deny');
  });
});

describe('Mission Control and MCP', () => {
  it('registers an agent with a key, serves MCP tools, and cuts the key on a hard kill', async () => {
    const store = new HistoryStore(':memory:'), accounts = new AccountStore(store.db);
    const rpc: Rpc = { request: async () => { throw new Error('no rpc'); } };
    const edge = new Edge(new Tracker(rpc, registry), rpc, registry, new HypeUsd(async () => new Response('{}')));
    const app = buildServer(edge, { store, accounts });
    const host = 'eko.test', json = { host, 'content-type': 'application/json' };
    expect(PublicConfigSchema.parse((await app.inject({ url: '/v1/config' })).json()).flags.approvals).toBe(true);
    const wallet = privateKeyToAccount(generatePrivateKey());
    const n = (await app.inject({ method: 'POST', url: '/v1/auth/siwe/nonce', headers: { host } })).json();
    const message = createSiweMessage({ domain: n.domain, address: wallet.address, uri: n.uri, version: '1', chainId: ELYSIUM_CHAIN_ID, nonce: n.nonce, issuedAt: new Date(n.issuedAt) });
    const signedIn = await app.inject({ method: 'POST', url: '/v1/auth/siwe/verify', headers: json, payload: { message, signature: await wallet.signMessage({ message }) } });
    const cookie = String(signedIn.headers['set-cookie']).split(';')[0]!, authed = { ...json, cookie };

    const agent = AgentDetailSchema.parse((await app.inject({ method: 'POST', url: '/v1/agents', headers: authed, payload: { name: 'Scout', kind: 'onchain', preset: 'Safe' } })).json());
    expect(agent.policy).toMatchObject({ mode: 'safe', blockPlaybookLevel: 'monitor', approvalAboveUsd: 50 });
    const key = ApiKeyCreatedSchema.parse((await app.inject({ method: 'POST', url: `/v1/agents/${agent.id}/keys`, headers: authed, payload: {} })).json());
    expect(key.secret).toMatch(/^eko_/);
    expect((await app.inject({ url: `/v1/agents/${agent.id}/keys`, headers: authed })).json().keys).toHaveLength(1);
    const packs = (await app.inject({ url: '/v1/packs', headers: { host } })).json();
    expect(packs.map((p: unknown) => PackSchema.parse(p).platform)).toEqual(['claude_code', 'generic_mcp', 'claude_desktop']);
    expect(packs[0].configTemplate).toContain('http://eko.test/mcp');
    // Another wallet cannot read this agent.
    expect((await app.inject({ url: `/v1/agents/${agent.id}`, headers: json })).statusCode).toBe(401);

    const mcp = (body: unknown, bearer?: string) => app.inject({ method: 'POST', url: '/mcp', headers: { ...json, ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, payload: body as object });
    const init = (await mcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } })).json();
    expect(init.result.serverInfo.name).toBe('eko-elysium');
    expect((await mcp({ jsonrpc: '2.0', method: 'notifications/initialized' })).statusCode).toBe(202);
    const list = (await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json().result.tools.map((t: { name: string }) => t.name);
    expect(list).toEqual(['coin_verdict', 'coin_card', 'playbook_match', 'deployer_history', 'new_launches', 'preflight', 'trade_prepare', 'journal']);
    const call = async (name: string, args: object, bearer?: string) => (await mcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } }, bearer)).json().result;
    expect((await call('coin_verdict', { coin: COIN })).isError).toBe(true);
    expect((await call('preflight', { clientOrderRef: 'order-1234', coin: COIN, side: 'buy', notionalUsd: 10 })).content[0].text).toMatch(/needs an agent key/);
    const denied = await call('preflight', { clientOrderRef: 'order-1234', coin: COIN, side: 'buy', notionalUsd: 10 }, key.secret);
    expect(denied.structuredContent).toMatchObject({ decision: 'deny' });
    expect((await call('journal', { kind: 'note', payload: { text: 'hello' } }, key.secret)).structuredContent).toMatchObject({ kind: 'note' });
    const journal = (await app.inject({ url: `/v1/agents/${agent.id}/journal`, headers: authed })).json().rows;
    expect(journal.map((e: { kind: string }) => e.kind)).toEqual(['note', 'decision']);
    expect((await app.inject({ url: '/v1/agents', headers: authed })).json().agents[0].lastSeen).toBeDefined();

    expect((await app.inject({ method: 'POST', url: `/v1/agents/${agent.id}/kill`, headers: authed, payload: { mode: 'hard' } })).statusCode).toBe(200);
    expect((await mcp({ jsonrpc: '2.0', id: 4, method: 'tools/list' }, key.secret)).statusCode).toBe(401);
    expect((await app.inject({ url: `/v1/agents/${agent.id}`, headers: authed })).json()).toMatchObject({ status: 'disconnected', policy: { killed: true } });
    await app.close();
  });
});
