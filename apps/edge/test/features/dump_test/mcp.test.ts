import { describe, expect, it } from 'vitest';
import { getAddress, keccak256, toHex, zeroAddress, type Hex } from 'viem';
import { loadRegistry } from '@eko/chain';
import { robinhoodAddresses, robinhoodChain } from '../../../src/chains/robinhood/index.js';
import { loadRobinhoodTradeAddresses } from '../../../src/chains/robinhood/trade.js';
import { Tracker, type CoinState, type Rpc } from '../../../src/tracker.js';
import { Edge } from '../../../src/service.js';
import { buildServer } from '../../../src/server.js';
import type { FeatureContext } from '../../../src/features/index.js';
import { setup, type DumpReply } from '../../../src/features/dump_test/index.js';

const registry = loadRegistry(), addrs = robinhoodAddresses(registry), trade = { ...loadRobinhoodTradeAddresses(), ponsHook: addrs.hook };
const A = (n: number) => getAddress(`0x${keccak256(toHex(`dump-mcp-${n}`)).slice(26)}`);
const NOW = 1_800_000_000;
const noRpc: Rpc = { request: async () => { throw new Error('no rpc'); } };

function rig(on: boolean) {
  const chain = robinhoodChain(registry, { moreLaunchpads: true }), tracker = new Tracker(noRpc, chain);
  tracker.head = 9_000_000n;
  const edge = new Edge(tracker, noRpc, chain, { latest: 3000, get: async () => 3000 }, { now: () => NOW * 1000 });
  let api!: ReturnType<typeof setup>;
  const app = buildServer(edge, { rpc: noRpc, ...(on ? { features: [{ flag: 'dump_test' as const, register: (ctx: FeatureContext) => { api = setup(ctx, { now: () => NOW, trade }); } }] } : {}) });
  // A curve coin with no RPC to read its curve: the dump test gives no figure for it (measured: false).
  const token = A(1), coin = { token, launchpad: 'pons', key: null, poolId: `0x${'0'.repeat(64)}`, manager: addrs.poolManager, launcher: A(2), creator: A(3), symbol: 'LATE', name: 'Late',
    decimals: 18, supply: 10n ** 27n, graduated: false, quote: zeroAddress, flipped: false, ts: NOW - 600, block: 1000, tx: `0x${'1'.repeat(64)}` as Hex, trades: [], flows: [], netHype: 0, sqrtPriceX96: null,
    curve: { address: A(4), graduationThreshold: 10n ** 19n, realQuoteReserve: 0n, realTokenReserve: 0n } } as unknown as CoinState;
  tracker.coins.set(token.toLowerCase(), coin);
  const rpc = async (method: string, params?: object) => (await app.inject({ method: 'POST', url: '/mcp', headers: { 'content-type': 'application/json' }, payload: { jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) } })).json();
  return { app, coin, rpc, api: () => api };
}

describe('dump test for agents (MCP)', () => {
  it('adds a dump_test tool while the flag is on, answering with the same figure as the API', async () => {
    const { app, coin, rpc } = rig(true);
    const tools = (await rpc('tools/list')).result.tools as { name: string; description: string }[];
    expect(tools.map(t => t.name)).toContain('dump_test');
    expect(tools.find(t => t.name === 'dump_test')!.description).toMatch(/insiders/);
    const out = (await rpc('tools/call', { name: 'dump_test', arguments: { coin: coin.token } })).result.structuredContent as DumpReply;
    expect(out).toMatchObject({ version: 1, coin: coin.token, measured: false });
    const api = (await app.inject({ url: `/v2/coins/${coin.token}/dump` })).json();
    expect(api).toEqual(out);
    const bad = (await rpc('tools/call', { name: 'dump_test', arguments: { coin: 'nope' } })).result;
    expect(bad.isError).toBe(true); expect(bad.content[0].text).toMatch(/coin \(a token address\)/);
    await app.close();
  });
  it('has no dump_test tool with the flag off', async () => {
    const { app, coin, rpc } = rig(false);
    expect(((await rpc('tools/list')).result.tools as { name: string }[]).map(t => t.name)).not.toContain('dump_test');
    expect((await rpc('tools/call', { name: 'dump_test', arguments: { coin: coin.token } })).error.message).toBe('Unknown tool.');
    await app.close();
  });
  it('posts a dump_risk event to the watch stream when the estimate crosses its line', async () => {
    const { app, coin, rpc, api } = rig(true);
    const { cursor } = (await rpc('tools/call', { name: 'watch', arguments: { waitSec: 0 } })).result.structuredContent;
    const figure = { id: 'all' as const, wallets: 6, tokens: '1', sharePct: 31, changePct: -62, usd100: 38 };
    api().alertOn(coin, { version: 1, coin: coin.token, at: new Date(NOW * 1000).toISOString(), asOfBlock: 1, measured: true, venue: 'curve', groups: [], all: figure, sellFeePct: 1, funding: false }, 30);
    const events = (await rpc('tools/call', { name: 'watch', arguments: { cursor, waitSec: 0 } })).result.structuredContent.events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'dump_risk', coin: coin.token, data: { dropPct: 62, wasPct: 30, usd100: 38 } });
    await app.close();
  });
});
