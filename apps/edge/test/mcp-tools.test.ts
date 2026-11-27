import { describe, expect, it } from 'vitest';
import { getAddress, keccak256, toHex, zeroAddress, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { loadElysiumRegistry, loadRegistry } from '@eko/chain';
import { AgentActivitySchema, AgentCallSchema, ELYSIUM_CHAIN_ID, type RadarRow } from '@eko/shared';
import { AccountStore } from '../src/accounts.js';
import { AgentStore, PRESETS } from '../src/agents.js';
import { HistoryStore } from '../src/history.js';
import { robinhoodAddresses, robinhoodChain } from '../src/chains/robinhood/index.js';
import { Tracker, type CoinState, type FeedEvent, type Rpc } from '../src/tracker.js';
import { Edge } from '../src/service.js';
import { HypeUsd } from '../src/hype.js';
import { buildServer } from '../src/server.js';
import { COINS_PAGE_MAX, mcpInstructions, parseCoinQuery, queryCoins, ToolError } from '../src/mcp.js';
import { WatchStream } from '../src/watch.js';
import type { FeatureContext } from '../src/features/index.js';

const A = (n: number) => getAddress(`0x${keccak256(toHex(`mcp-tools-${n}`)).slice(26)}`);
const lc = (a: string) => a.toLowerCase();
const NOW = 1_800_000_000;
const rhRegistry = loadRegistry(), rh = robinhoodAddresses(rhRegistry);
const noRpc: Rpc = { request: async () => { throw new Error('no rpc in this test'); } };

/** A Robinhood Chain edge with no RPC: coins are put straight into the tracker. */
function robinhoodRig(opts: { features?: NonNullable<Parameters<typeof buildServer>[1]>['features'] } = {}) {
  const chain = robinhoodChain(rhRegistry, { moreLaunchpads: true }), tracker = new Tracker(noRpc, chain);
  tracker.head = 9_000_000n;
  const edge = new Edge(tracker, noRpc, chain, { latest: 3000, get: async () => 3000 }, { now: () => NOW * 1000 });
  const app = buildServer(edge, { rpc: noRpc, ...(opts.features ? { features: opts.features } : {}) });
  let n = 0;
  const add = (launchpad: CoinState['launchpad'], ageSec: number, symbol: string) => {
    const token = A(++n), ts = NOW - ageSec;
    const c = { token, launchpad, key: null, poolId: `0x${'0'.repeat(64)}` as Hex, manager: rh.poolManager, launcher: A(900), creator: A(800 + n), symbol, name: `${symbol} coin`,
      decimals: 18, supply: 10n ** 27n, graduated: false, quote: zeroAddress, flipped: false, ts, block: 1000 + n, tx: `0x${n.toString(16).padStart(64, '1')}` as Hex, trades: [],
      flows: [], netHype: 0, sqrtPriceX96: null, ...(launchpad === 'pons' ? { curve: { address: A(700 + n), graduationThreshold: 10n ** 19n, realQuoteReserve: 0n, realTokenReserve: 0n } } : {}) } as unknown as CoinState;
    tracker.coins.set(lc(token), c);
    return c;
  };
  const feed = (e: Omit<FeedEvent, 'id' | 'ts' | 'block'>) => (tracker.feed as FeedEvent[]).push({ id: `ev:${tracker.feed.length + 1}`, ts: NOW, block: 1, ...e });
  const mcp = async (body: unknown, headers: Record<string, string> = {}, ip = '10.1.0.1') => (await app.inject({ method: 'POST', url: '/mcp', remoteAddress: ip, headers: { 'content-type': 'application/json', ...headers }, payload: body as object })).json();
  const call = async (name: string, args: object, headers: Record<string, string> = {}, ip?: string) => (await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, headers, ip)).result;
  return { app, edge, tracker, add, feed, mcp, call };
}

/** A Radar row with only what the coins tool reads. */
const row = (rank: number, over: Partial<RadarRow> & { score?: number; band?: 'danger' | 'careful' | 'ok' }): RadarRow => {
  const { score, band, ...rest } = over;
  return { rank, address: A(rank), symbol: { text: `C${rank}`, flags: [], truncated: false }, name: { text: `Coin ${rank}`, flags: [], truncated: false }, launchpad: 'pons', stage: 'curve',
    priceUsd: 0.0001, change1hPct: 0, liquidityUsd: 1000, verdict: score === undefined ? 'pending' : band === 'danger' ? 'danger' : band === 'careful' ? 'monitor' : 'clear', ageSec: 600,
    marketCapUsd: 10_000, volume1hUsd: 100, unavailable: [],
    ...(score !== undefined ? { ekoScore: { value: score, band: band ?? 'ok', cap: 100, parts: { momentum: 50, money: 50, holders: 50, exit: 50 }, ...(band === 'danger' ? { cappedBy: 'Bundled launch' } : {}) } } : {}),
    ...rest } as unknown as RadarRow;
};

describe('MCP tools cover every launchpad EKO follows', () => {
  it('never describes Robinhood Chain coins as Pons-only, and validates launchpads against the chain', async () => {
    const { mcp, app } = robinhoodRig();
    const tools = (await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).result.tools as { name: string; description: string; inputSchema: { properties: Record<string, { enum?: string[] }> } }[];
    for (const t of tools) expect(t.description, t.name).not.toMatch(/Pons (token|launches|coins)\b/);
    const verdict = tools.find(t => t.name === 'coin_verdict')!.description;
    for (const pad of ['Pons', 'Pangea', 'long.xyz', 'unbranded launchers']) expect(verdict).toContain(pad);
    expect(verdict).toMatch(/EKO score/);
    expect(tools.find(t => t.name === 'coins')!.inputSchema.properties.launchpad!.enum).toEqual(['pons', 'pangea', 'longxyz', 'unbranded']);
    const init = (await mcp({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-06-18' } })).result;
    expect(init.instructions).toContain('Pons, Pangea, long.xyz and unbranded launchers');
    expect(init.instructions).toMatch(/watch/);
    expect(mcpInstructions({ edge: { chain: { profile: { name: 'Elsewhere', launchpads: [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }] } } } as unknown as Edge })).toContain('on Elsewhere on Alpha and Beta');
    expect(() => parseCoinQuery({ launchpad: 'montra' }, ['pons', 'pangea', 'longxyz', 'unbranded'])).toThrow(/launchpad must be one of pons, pangea, longxyz, unbranded/);
    await app.close();
  });
});

describe('coins tool', () => {
  const rows = [
    row(1, { score: 82, band: 'ok', change1hPct: 12, marketCapUsd: 50_000, volume1hUsd: 9000, ageSec: 3000, liquidityUsd: 8000 }),
    row(2, { score: 55, band: 'careful', change1hPct: -40, marketCapUsd: 20_000, volume1hUsd: 4000, ageSec: 120, launchpad: 'pangea', stage: 'curve', graduationPct: 45 }),
    row(3, { score: 8, band: 'danger', change1hPct: 3, marketCapUsd: 90_000, volume1hUsd: 100, ageSec: 7200, stage: 'graduated', liquidityUsd: 30_000 }),
    row(4, { change1hPct: 0, marketCapUsd: 1000, volume1hUsd: 0, ageSec: 30, curvePct: 12, graduationPct: 12 }),
    row(5, { score: 74, band: 'ok', change1hPct: 1, marketCapUsd: 5000, volume1hUsd: 50, ageSec: 900, launchpad: 'longxyz', curvePct: 80, graduationPct: 80, unavailable: ['volume'] }),
  ];
  const q = (args: Record<string, unknown>) => queryCoins(rows, parseCoinQuery(args, ['pons', 'pangea', 'longxyz', 'unbranded']), 30);
  const ids = (r: ReturnType<typeof q>) => r.coins.map(c => c.rank);
  it('filters by band, score range, verdict, launchpad, age, stage, about-to-bond and liquidity', () => {
    expect(ids(q({}))).toEqual([1, 2, 3, 4, 5]);
    expect(ids(q({ band: 'ok' }))).toEqual([1, 5]);
    expect(ids(q({ minScore: 50, maxScore: 80 }))).toEqual([2, 5]);
    expect(ids(q({ minScore: 0 }))).toEqual([1, 2, 3, 5]); // no score while pending: never matches a score filter
    expect(ids(q({ verdict: 'pending' }))).toEqual([4]);
    expect(ids(q({ launchpad: 'pangea' }))).toEqual([2]);
    expect(ids(q({ maxAgeMin: 15 }))).toEqual([2, 4, 5]);
    expect(ids(q({ stage: 'bonded' }))).toEqual([3]);
    expect(ids(q({ aboutToBond: true }))).toEqual([2, 5]);
    expect(ids(q({ minLiquidityUsd: 5000 }))).toEqual([1, 3]);
  });
  it('sorts hottest, newest, score, market cap, volume and movers, and pages with a cursor', () => {
    expect(ids(q({ sort: 'newest' }))).toEqual([4, 2, 5, 1, 3]);
    expect(ids(q({ sort: 'score' }))).toEqual([1, 5, 2, 3, 4]);
    expect(ids(q({ sort: 'marketCap' }))).toEqual([3, 1, 2, 5, 4]);
    // An unmeasured volume (row 5) sorts last rather than as zero.
    expect(ids(q({ sort: 'volume' }))).toEqual([1, 2, 3, 4, 5]);
    expect(q({ sort: 'volume' }).coins.at(-1)!.volume1hUsd).toBeNull();
    expect(ids(q({ sort: 'movers' }))).toEqual([2, 1, 3, 5, 4]);
    const first = q({ sort: 'score', limit: 2 });
    expect(ids(first)).toEqual([1, 5]); expect(first.nextCursor).toBe('2'); expect(first.total).toBe(5);
    const second = q({ sort: 'score', limit: 2, cursor: first.nextCursor });
    expect(ids(second)).toEqual([2, 3]);
    expect(q({ sort: 'score', limit: 2, cursor: '4' }).nextCursor).toBeNull();
  });
  it('returns each row with its score band, cappedBy and stage in plain words', () => {
    const danger = q({ band: 'danger' }).coins[0]!;
    expect(danger).toMatchObject({ verdict: 'danger', score: { value: 8, band: 'danger', label: 'Danger', cappedBy: 'Bundled launch' }, stage: 'bonded', aboutToBond: false, ageMin: 120 });
    expect(q({ verdict: 'pending' }).coins[0]!.score).toBeNull();
  });
  it('refuses bad arguments with a reason and bounds the page size', () => {
    const bad = (args: Record<string, unknown>, re: RegExp) => expect(() => parseCoinQuery(args, ['pons'])).toThrow(re);
    bad({ band: 'great' }, /band must be one of/);
    bad({ limit: COINS_PAGE_MAX + 1 }, /limit must be a number from 1 to 50/);
    bad({ limit: 2.5 }, /whole number/);
    bad({ minScore: 80, maxScore: 20 }, /minScore is above maxScore/);
    bad({ sort: 'random' }, /sort must be one of/);
    bad({ cursor: 'abc' }, /cursor/);
    bad({ colour: 'red' }, /Unknown argument: colour/);
    expect(() => parseCoinQuery({ band: 1 }, ['pons'])).toThrow(ToolError);
  });
  it('serves the shared list over MCP without a key, with launchpad filters on real tracker coins', async () => {
    const { add, call, app } = robinhoodRig();
    add('pons', 600, 'MAPLE'); add('pangea', 300, 'PEARL'); add('longxyz', 60, 'LONG');
    const all = (await call('coins', { sort: 'newest' })).structuredContent;
    expect(all.coins.map((c: { symbol: { text: string } }) => c.symbol.text)).toEqual(['LONG', 'PEARL', 'MAPLE']);
    expect(all.coins[0]).toMatchObject({ launchpad: 'longxyz', verdict: 'pending', score: null, ageMin: 1 });
    expect(all.note).toMatch(/untrusted/);
    expect((await call('coins', { launchpad: 'pangea' })).structuredContent.coins).toHaveLength(1);
    const refused = await call('coins', { launchpad: 'montra' });
    expect(refused.isError).toBe(true); expect(refused.content[0].text).toMatch(/launchpad must be one of/);
    await app.close();
  });
});

describe('watch tool', () => {
  it('starts from now, returns events after a cursor, and skips what a kind filter leaves out', async () => {
    const { add, feed, call, app } = robinhoodRig();
    const first = (await call('watch', { waitSec: 0 })).structuredContent;
    expect(first.events).toEqual([]);
    const coin = add('pons', 10, 'NEWB');
    feed({ kind: 'new_pair', coin: coin.token });
    const next = (await call('watch', { cursor: first.cursor, waitSec: 0 })).structuredContent;
    expect(next.events).toHaveLength(1);
    expect(next.events[0]).toMatchObject({ kind: 'launch', coin: coin.token, launchpad: 'pons', symbol: { text: 'NEWB' }, verdict: 'pending', title: 'New launch' });
    expect(next.cursor).toBe(next.events[0].cursor);
    // Nothing new after it.
    expect((await call('watch', { cursor: next.cursor, waitSec: 0 })).structuredContent.events).toEqual([]);
    feed({ kind: 'graduation', coin: coin.token });
    const onlyLaunches = (await call('watch', { cursor: next.cursor, waitSec: 0, kinds: ['launch'] })).structuredContent;
    expect(onlyLaunches.events).toEqual([]);
    // The cursor moves past the filtered-out event, so it is not read again.
    expect(onlyLaunches.cursor).not.toBe(next.cursor);
    expect((await call('watch', { cursor: next.cursor, waitSec: 0, kinds: ['bonded'] })).structuredContent.events[0]).toMatchObject({ kind: 'bonded' });
    await app.close();
  });
  it('waits up to waitSec and returns empty on timeout, or as soon as an event arrives', async () => {
    const { add, feed, call, app } = robinhoodRig();
    const { cursor } = (await call('watch', { waitSec: 0 })).structuredContent;
    let t = Date.now();
    const empty = (await call('watch', { cursor, waitSec: 1 })).structuredContent;
    expect(empty.events).toEqual([]); expect(empty.cursor).toBe(cursor);
    expect(Date.now() - t).toBeGreaterThanOrEqual(900);
    const coin = add('pangea', 5, 'WAKE');
    t = Date.now();
    const waiting = call('watch', { cursor, waitSec: 10 });
    setTimeout(() => feed({ kind: 'new_pair', coin: coin.token }), 200);
    const woke = (await waiting).structuredContent;
    expect(woke.events.map((e: { kind: string }) => e.kind)).toEqual(['launch']);
    expect(Date.now() - t).toBeLessThan(3000);
    await app.close();
  });
  it('says reset for a cursor from before a restart, and validates its arguments', async () => {
    const { call, app } = robinhoodRig();
    const r = (await call('watch', { cursor: 'abcdef:12', waitSec: 0 })).structuredContent;
    expect(r.reset).toBe(true); expect(r.events).toEqual([]);
    expect((await call('watch', { waitSec: 99 })).content[0].text).toMatch(/waitSec must be a number from 0 to 25/);
    expect((await call('watch', { kinds: ['rugs'] })).content[0].text).toMatch(/kinds must be a list of/);
    expect((await call('watch', { coin: 'nope' })).content[0].text).toMatch(/coin must be a token address/);
    await app.close();
  });
  it('lets at most two calls wait at once per address, and rate limits watch per address', async () => {
    const { call, app } = robinhoodRig();
    const { cursor } = (await call('watch', { waitSec: 0 }, {}, '10.9.0.1')).structuredContent;
    const a = call('watch', { cursor, waitSec: 2 }, {}, '10.9.0.1'), b = call('watch', { cursor, waitSec: 2 }, {}, '10.9.0.1');
    await new Promise(r => setTimeout(r, 50));
    const third = await call('watch', { cursor, waitSec: 2 }, {}, '10.9.0.1');
    expect(third.isError).toBe(true); expect(third.content[0].text).toMatch(/At most 2 watch calls may wait at once/);
    // Another address is not held up.
    expect((await call('watch', { cursor, waitSec: 0 }, {}, '10.9.0.2')).isError).toBeUndefined();
    await Promise.all([a, b]);
    let limited = 0;
    for (let i = 0; i < 31; i++) if ((await call('watch', { waitSec: 0 }, {}, '10.9.0.3')).isError) limited++;
    expect(limited).toBe(1);
    await app.close();
  });
  it('turns verdict changes into events, newest verdict and the one before', () => {
    const levels = new Map<string, string>([['0xc', 'pending']]);
    const coin = { token: getAddress('0x000000000000000000000000000000000000000c'), launchpad: 'pons', symbol: 'VV', trades: [] } as unknown as CoinState;
    const edge = { tracker: { feed: [], coins: new Map([['0x000000000000000000000000000000000000000c', coin]]), coin: () => coin },
      cachedLevel: () => levels.get('0xc'), assessment: () => undefined, ctx: () => ({ nowSec: NOW, head: 1, hypeUsd: 3000 }) } as unknown as Edge;
    const w = new WatchStream(edge);
    expect(w.sync()).toBe(0);
    levels.set('0xc', 'danger');
    expect(w.sync()).toBe(1);
    w.stop();
  });
});

describe('features add MCP tools and watch events only while their flag is on', () => {
  const probe = { flag: 'dump_test' as const, register: (ctx: FeatureContext) => {
    ctx.mcp?.tool('dump_test', { name: 'flag_probe', description: 'A test tool.', inputSchema: { type: 'object', properties: {} }, run: async () => ({ ok: true }) });
    ctx.mcp?.event('dump_test', { kind: 'dump_risk', coin: A(1), title: 'Probe event' });
  } };
  it('registers a feature tool and posts its event', async () => {
    const { mcp, call, app } = robinhoodRig({ features: [probe] });
    const names = (await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).result.tools.map((t: { name: string }) => t.name);
    expect(names.at(-1)).toBe('flag_probe');
    expect((await call('flag_probe', {})).structuredContent).toEqual({ ok: true });
    await app.close();
  });
  it('has no such tool with the feature off', async () => {
    const { mcp, app } = robinhoodRig();
    const names = (await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).result.tools.map((t: { name: string }) => t.name);
    expect(names).not.toContain('flag_probe');
    expect((await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'flag_probe', arguments: {} } })).error.message).toBe('Unknown tool.');
    await app.close();
  });
  it('refuses a feature tool that takes one of EKO\'s own names', () => {
    expect(() => robinhoodRig({ features: [{ flag: 'dump_test', register: (ctx: FeatureContext) => ctx.mcp?.tool('dump_test', { name: 'coins', description: '', inputSchema: {}, run: async () => ({}) }) }] })).toThrow(/taken/);
  });
});

describe('live activity for the agent\'s owner', () => {
  it('summarises each call made with an agent key, pushes it to the owner, and serves it with today\'s counts', async () => {
    const registry = loadElysiumRegistry(), store = new HistoryStore(':memory:'), accounts = new AccountStore(store.db);
    const edge = new Edge(new Tracker(noRpc, registry), noRpc, registry, new HypeUsd(async () => new Response('{}')));
    const app = buildServer(edge, { store, accounts });
    const host = 'eko.test', json = { host, 'content-type': 'application/json' };
    const wallet = privateKeyToAccount(generatePrivateKey());
    const n = (await app.inject({ method: 'POST', url: '/v1/auth/siwe/nonce', headers: { host } })).json();
    const message = createSiweMessage({ domain: n.domain, address: wallet.address, uri: n.uri, version: '1', chainId: ELYSIUM_CHAIN_ID, nonce: n.nonce, issuedAt: new Date(n.issuedAt) });
    const signedIn = await app.inject({ method: 'POST', url: '/v1/auth/siwe/verify', headers: json, payload: { message, signature: await wallet.signMessage({ message }) } });
    const authed = { ...json, cookie: String(signedIn.headers['set-cookie']).split(';')[0]! };
    const agent = (await app.inject({ method: 'POST', url: '/v1/agents', headers: authed, payload: { name: 'Scout', kind: 'onchain', preset: 'Balanced' } })).json();
    const { secret } = (await app.inject({ method: 'POST', url: `/v1/agents/${agent.id}/keys`, headers: authed, payload: {} })).json();
    const pushed: { accountId: string; ch: string; kind: string; data: unknown }[] = [];
    app.accountPush!.deliver = (accountId, ch, kind, data) => pushed.push({ accountId, ch, kind, data });
    const before = (await app.inject({ url: `/v1/agents/${agent.id}/activity`, headers: authed })).json();
    expect(AgentActivitySchema.parse(before)).toMatchObject({ calls: [] });

    const call = (name: string, args: object) => app.inject({ method: 'POST', url: '/mcp', headers: { ...json, authorization: `Bearer ${secret}` }, payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } });
    const coin = getAddress('0xabababababababababababababababababababab');
    await call('coins', { sort: 'newest' });
    await call('preflight', { clientOrderRef: 'order-0001', coin, side: 'buy', notionalUsd: 20 });
    await call('journal', { kind: 'note', payload: { text: 'Skipping: EKO has not checked it.' } });
    // Read tools without a key are nobody's activity.
    await app.inject({ method: 'POST', url: '/mcp', headers: json, payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'coins', arguments: {} } } });

    expect(pushed.map(p => [p.ch, p.kind, (p.data as { tool: string }).tool])).toEqual([['agents', 'call', 'coins'], ['agents', 'call', 'preflight'], ['agents', 'call', 'journal']]);
    const calls = pushed.map(p => AgentCallSchema.parse(p.data));
    expect(calls[0]).toMatchObject({ ok: true, results: 0 });
    expect(calls[1]!.preflight).toMatchObject({ decision: 'deny', side: 'buy', notionalUsd: 20 });
    expect(calls[1]!.coin?.address.toLowerCase()).toBe(coin.toLowerCase());
    expect(calls[2]!.journal).toMatchObject({ kind: 'note', text: { text: 'Skipping: EKO has not checked it.' } });
    expect(JSON.stringify(pushed)).not.toContain(secret);

    const since = new Date(Date.now() - 3_600_000).toISOString();
    const after = AgentActivitySchema.parse((await app.inject({ url: `/v1/agents/${agent.id}/activity?since=${encodeURIComponent(since)}`, headers: authed })).json());
    expect(after.calls.map(c => c.tool)).toEqual(['journal', 'preflight', 'coins']);
    expect(after.today).toMatchObject({ calls: 3, checks: 1, denied: 1, allowed: 0, notes: 1, prepared: 0 });
    expect(after.lastCallAt).not.toBeNull();
    // Owner only.
    expect((await app.inject({ url: `/v1/agents/${agent.id}/activity`, headers: json })).statusCode).toBe(401);
    // The owner's account erased: the live log goes with it.
    const agents = new AgentStore(accounts.db);
    expect(agents.countsSince(agent.id, 0)).toMatchObject({ checks: 1, notes: 1 });
    expect(PRESETS).toHaveLength(3);
    await app.close();
  });
});
