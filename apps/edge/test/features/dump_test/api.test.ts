import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, getAddress, keccak256, parseAbi, toHex, zeroAddress, type Address, type Hex } from 'viem';
import { loadRegistry, v4PoolId, type V4PoolKey } from '@eko/chain';
import { AlertSchema } from '@eko/shared';
import { AccountStore } from '../../../src/accounts.js';
import { AlertInbox } from '../../../src/alerts.js';
import { HistoryStore } from '../../../src/history.js';
import { robinhoodAddresses, robinhoodChain, type RobinhoodCoinState } from '../../../src/chains/robinhood/index.js';
import { ponsPoolReserve } from '../../../src/chains/robinhood/probe.js';
import { loadRobinhoodTradeAddresses, PONS_CURVE_ABI, ponsBuyOut, ponsPoolKey, ponsSellOut, type PonsCurveState } from '../../../src/chains/robinhood/trade.js';
import { Tracker, type CoinState, type Rpc } from '../../../src/tracker.js';
import { Edge } from '../../../src/service.js';
import { buildServer } from '../../../src/server.js';
import { loadFeatures, type FeatureContext } from '../../../src/features/index.js';
import type { FundingLookup } from '../../../src/insiders.js';
import dumpTest, { ALERT, alertText, CAUGHT_UP_BLOCKS, EARLY_GAP_SEC, IDLE_SEC, REFRESH_SEC, RESTORED_SEC, riskOf, SERVE_SEC, setup, type DumpReply, type DumpSummary } from '../../../src/features/dump_test/index.js';
import { decodeDumps, DUMP_SNAPSHOT_VERSION, dumpSnapshotPath, encodeDumps, MAX_ENTRIES } from '../../../src/features/dump_test/snapshot.js';
import { curveDump, fullRangeReserves, insiderHoldings, poolDump, PONS_HOOK_SELL_FEE, quoterAbi, weiFor } from '../../../src/features/dump_test/dump.js';

const registry = loadRegistry(), addrs = robinhoodAddresses(registry), trade = { ...loadRobinhoodTradeAddresses(), ponsHook: addrs.hook };
const A = (n: number) => getAddress(`0x${keccak256(toHex(`dump-test-${n}`)).slice(26)}`);
const lc = (a: string) => a.toLowerCase();
const ETH_USD = 3000, HEAD = 9_000_000n, NOW = 1_800_000_000, LAUNCH_BLOCK = 1000, LAUNCH_TS = NOW - 3600;
const E18 = 10n ** 18n, SUPPLY = 1_000_000_000n * E18;
/** Millions of whole tokens, in base units. */
const M = (n: number) => BigInt(Math.round(n * 1e6)) * E18;
const wei = (eth: number) => BigInt(Math.round(eth * 1e6)) * 10n ** 12n;
const DEV = A(10), S1 = A(11), S2 = A(12), B1 = A(13), B2 = A(14), B3 = A(15), EARLY = A(16), LINKED = A(17), OUT = A(18), ROUTER = A(19);
const multicall = parseAbi(['struct Call3 { address target; bool allowFailure; bytes callData; }', 'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[] returnData)']);
const managerAbi = parseAbi(['function extsload(bytes32 slot) view returns (bytes32)']);

/** A Pons curve: 3 ETH of reserve (virtual included) against 800M tokens, a quarter of the ETH real, 1% fee. */
const curveState = (over: Partial<PonsCurveState> = {}): PonsCurveState => ({ quoteReserve: wei(3), tokenReserve: M(800), sellable: M(640), realQuote: wei(0.75),
  feeBps: 100n, creatorTaxBps: 0n, snipeTaxBps: 0n, graduated: false, readyToGraduate: false, ...over });
/** A constant-product v4 pool as the quoter sees it (whole ETH and tokens), with a hook cut off the ETH of a sell. */
interface Pool { eth: number; tokens: number; fee: number }
const sqrtOf = (p: Pool) => BigInt(Math.floor(Math.sqrt(p.tokens / p.eth) * 2 ** 96));

/** The chain as the dump test reads it: one Multicall3 eth_call of curve reads, or slot0 and V4Quoter sells. Nothing else. */
function chainRpc(curves: Map<string, PonsCurveState & { token: Address }>, pools: Map<string, Pool>) {
  const calls: { method: string; params: readonly unknown[] }[] = [];
  const rpc: Rpc = {
    async request({ method, params }) {
      calls.push({ method, params });
      const [call] = params as [{ to: Address; data: Hex }];
      if (method !== 'eth_call' || call.to.toLowerCase() !== addrs.multicall3.toLowerCase()) throw new Error(`unexpected ${method} to ${call.to}`);
      const [parts] = decodeFunctionData({ abi: multicall, data: call.data }).args;
      const result = parts.map(p => {
        const curve = curves.get(p.target.toLowerCase());
        if (curve) {
          const { functionName } = decodeFunctionData({ abi: PONS_CURVE_ABI, data: p.callData });
          const value = { graduated: curve.graduated, readyToGraduate: curve.readyToGraduate, token: curve.token, pairToken: zeroAddress, getReserves: [curve.quoteReserve, curve.tokenReserve],
            sellableTokens: curve.sellable, realQuoteReserve: curve.realQuote, feeBps: curve.feeBps, creatorTaxBps: curve.creatorTaxBps, currentSnipeTaxBps: curve.snipeTaxBps }[functionName as string];
          return { success: true, returnData: encodeFunctionResult({ abi: PONS_CURVE_ABI, functionName, result: value } as never) };
        }
        const pool = [...pools.values()][0]!;
        if (p.target.toLowerCase() === addrs.poolManager.toLowerCase()) {
          decodeFunctionData({ abi: managerAbi, data: p.callData });
          return { success: true, returnData: toHex(sqrtOf(pool), { size: 32 }) };
        }
        if (p.target.toLowerCase() !== trade.quoter.toLowerCase()) throw new Error('unexpected target');
        const q = decodeFunctionData({ abi: quoterAbi, data: p.callData }), args = q.args[0];
        if (args.zeroForOne) throw new Error('the dump test only sells');
        const tokens = Number(args.exactAmount) / 1e18, out = pool.eth * tokens / (pool.tokens + tokens) * (1 - pool.fee);
        return { success: true, returnData: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [BigInt(Math.floor(out * 1e18)), 150_000n]) };
      });
      return encodeFunctionResult({ abi: multicall, functionName: 'aggregate3', result });
    },
  };
  return { rpc, calls };
}

let txn = 0;
const tx = () => `0x${(++txn).toString(16).padStart(64, '7')}` as Hex;
const at = (blocks: number, sec = blocks * 0.1) => ({ block: LAUNCH_BLOCK + blocks, ts: Math.floor(LAUNCH_TS + sec) });
/** A coin on its Pons curve, minted to the curve in its launch transaction. */
function curveCoin(token: Address, curve: Address, opts: { partial?: boolean } = {}): RobinhoodCoinState {
  const launchTx = tx();
  return { token, launchpad: 'pons', key: null, poolId: `0x${'0'.repeat(64)}`, manager: addrs.poolManager, launcher: A(90), creator: DEV, symbol: 'MAPLE', name: 'Maple Run', decimals: 18,
    supply: SUPPLY, graduated: false, quote: zeroAddress, flipped: false, ts: LAUNCH_TS, block: LAUNCH_BLOCK, tx: launchTx, trades: [], sqrtPriceX96: null,
    curve: { address: curve, graduationThreshold: 10n ** 19n, realQuoteReserve: 0n, realTokenReserve: 0n },
    // A partial history: EKO's first transfer is a later trade's, not the mint.
    flows: opts.partial ? [] : [{ tx: launchTx, block: LAUNCH_BLOCK, ts: LAUNCH_TS, from: zeroAddress, to: lc(curve), value: SUPPLY }] } as unknown as RobinhoodCoinState;
}
/** A buy (curve → router → wallet) or a sell (wallet → router → curve). */
function swap(c: RobinhoodCoinState, wallet: Address, side: 'buy' | 'sell', value: bigint, when: { block: number; ts: number }) {
  const h = tx(), venue = lc((c as unknown as CoinState).curve?.address ?? addrs.poolManager), eth = Number(value / E18) * 4e-9;
  (c.trades as CoinState['trades']).push({ ts: when.ts, block: when.block, tx: h, sender: ROUTER, side, hype: eth, tokens: Number(value / E18), priceHype: 4e-9 });
  const legs = side === 'buy' ? [[venue, lc(ROUTER)], [lc(ROUTER), lc(wallet)]] : [[lc(wallet), lc(ROUTER)], [lc(ROUTER), venue]];
  for (const [from, to] of legs) (c.flows as CoinState['flows']).push({ tx: h, block: when.block, ts: when.ts, from: from!, to: to!, value });
}
/** One transaction that buys for several wallets (a bundler). */
function bundleBuy(c: RobinhoodCoinState, wallets: Address[], value: bigint, when: { block: number; ts: number }) {
  const h = tx(), venue = lc((c as unknown as CoinState).curve!.address);
  (c.trades as CoinState['trades']).push({ ts: when.ts, block: when.block, tx: h, sender: ROUTER, side: 'buy', hype: 0.1, tokens: Number(value / E18) * wallets.length, priceHype: 4e-9 });
  (c.flows as CoinState['flows']).push({ tx: h, block: when.block, ts: when.ts, from: venue, to: lc(ROUTER), value: value * BigInt(wallets.length) });
  for (const w of wallets) (c.flows as CoinState['flows']).push({ tx: h, block: when.block, ts: when.ts, from: lc(ROUTER), to: lc(w), value });
}
/** The launch: dev 5%, snipers 3% and 2%, a bundle of three at 1% each, an early buyer 1.5%, a dev-funded wallet 4%, an outsider 10%. */
function launched(c: RobinhoodCoinState) {
  swap(c, DEV, 'buy', M(50), at(0));
  swap(c, S1, 'buy', M(30), at(2)); swap(c, S2, 'buy', M(20), at(3));
  bundleBuy(c, [B1, B2, B3], M(10), at(5));
  swap(c, EARLY, 'buy', M(15), at(100, 20));
  swap(c, LINKED, 'buy', M(40), at(2000, 200));
  swap(c, OUT, 'buy', M(100), at(3000, 300));
  return c;
}
const funding: FundingLookup = (w) => lc(w) === lc(LINKED) ? { funder: DEV, fundedTs: NOW - 9000, hub: false } : undefined;

function rig(curves: Record<string, PonsCurveState & { token: Address }> = {}, pools: Record<string, Pool> = {}, opts: { accounts?: boolean; snapshotPath?: string; replaying?: boolean; now?: number } = {}) {
  const fake = chainRpc(new Map(Object.entries(curves).map(([k, v]) => [k.toLowerCase(), v])), new Map(Object.entries(pools)));
  const chain = robinhoodChain(registry, { moreLaunchpads: true });
  const tracker = new Tracker(fake.rpc, chain);
  // Caught up with the head, unless the start-up replay is still running (its cursor an hour behind).
  tracker.head = HEAD; tracker.cursor = opts.replaying ? HEAD - 32_400n : HEAD;
  let t = opts.now ?? NOW;
  const edge = new Edge(tracker, fake.rpc, chain, { latest: ETH_USD, get: async () => ETH_USD }, { now: () => t * 1000 });
  const store = opts.accounts ? new HistoryStore(':memory:') : undefined, accounts = store ? new AccountStore(store.db) : undefined, alerts = new AlertInbox();
  let api!: ReturnType<typeof setup>;
  const app = buildServer(edge, { rpc: fake.rpc, alerts, ...(store ? { store } : {}), ...(accounts ? { accounts } : {}),
    features: [{ flag: 'dump_test', register: (ctx: FeatureContext) => { api = setup(ctx, { now: () => t, trade, snapshotPath: opts.snapshotPath ?? null, log: () => undefined }); } }] });
  const add = (c: RobinhoodCoinState) => { tracker.coins.set(lc(c.token), c as unknown as CoinState); return c; };
  const ask = async (coin: Address, ip = '10.0.0.1') => app.inject({ url: `/v2/coins/${coin}/dump`, remoteAddress: ip });
  const row = async (coin: Address) => ((await app.inject({ url: '/v2/radar' })).json() as { rows: { address: string; extras?: { dump_test?: DumpSummary } }[] })
    .rows.find(x => lc(x.address) === lc(coin))?.extras?.dump_test;
  return { app, edge, tracker, add, ask, row, calls: fake.calls, store, alerts, api: () => api, clock: { advance: (sec: number) => { t += sec; }, now: () => t } };
}
/** The Radar row's figure the route's answer implies: what both must agree on. */
const summaryOfReply = (r: DumpReply): DumpSummary | undefined => r.measured && r.all.changePct !== null && r.all.usd100 !== null
  ? { changePct: r.all.changePct, usd100: r.all.usd100, sharePct: r.all.sharePct, ...(r.all.drains ? { drains: true as const } : {}) } : undefined;
const measured = (r: DumpReply) => { if (!r.measured) throw new Error(`not measured: ${JSON.stringify(r)}`); return r; };
const group = (r: DumpReply, id: string) => measured(r).groups.find(g => g.id === id)!;

describe('dump test: who holds the insider tokens', () => {
  const opts = { excluded: [] as Address[], sniperBlocks: 35, bundle: { firstBlocks: 35, fundingWindowH: 24, minWallets: 3 } };
  it('counts each insider wallet once, in its first group, at its balance now', () => {
    const token = A(1), c = launched(curveCoin(token, A(2)));
    const h = insiderHoldings(c as unknown as CoinState, { ...opts, funding });
    expect(h.groups.dev).toEqual({ wallets: 1, tokens: M(50) });
    expect(h.groups.linked).toEqual({ wallets: 1, tokens: M(40) });
    // The bundle's wallets bought inside the sniper window too: counted as bundle only.
    expect(h.groups.bundle).toEqual({ wallets: 3, tokens: M(30) });
    expect(h.groups.sniper).toEqual({ wallets: 2, tokens: M(50) });
    expect(h.groups.early).toEqual({ wallets: 1, tokens: M(15) });
    expect(h.all).toEqual({ wallets: 8, tokens: M(185) });
    expect(h.insiders.has(lc(OUT))).toBe(false);
    // Without traced funding no wallet is dev-funded; a sell lowers what the group holds; a wallet that sold out is still an insider.
    swap(c, S1, 'sell', M(30), at(4000, 400));
    const after = insiderHoldings(c as unknown as CoinState, opts);
    expect(after.groups.linked.tokens).toBe(0n);
    expect(after.groups.sniper).toEqual({ wallets: 1, tokens: M(20) });
    expect(after.insiders.has(lc(S1))).toBe(true);
  });
});

describe('dump test: the price after a dump, per venue', () => {
  it('Pons curve: (T/(T+t))² of the price, and $100 sold on the curve as the dump leaves it', () => {
    const s = curveState(), t = M(185), o = curveDump(s, t, ETH_USD);
    expect(o.drains).toBe(false);
    expect(o.changePct).toBeCloseTo(-(1 - (800 / 985) ** 2) * 100, 1);
    // Your $100: bought now (its ETH goes into the curve), the insiders sell into that, then you sell what you bought.
    const v0 = weiFor(100, ETH_USD), buy = ponsBuyOut(s, v0);
    const bought = { ...s, quoteReserve: s.quoteReserve + buy.net, tokenReserve: s.tokenReserve - buy.tokens, realQuote: s.realQuote + buy.net, sellable: s.sellable - buy.tokens };
    const gross = t * bought.quoteReserve / (bought.tokenReserve + t);
    const after = { ...bought, quoteReserve: bought.quoteReserve - gross, tokenReserve: bought.tokenReserve + t, realQuote: bought.realQuote - gross, sellable: bought.sellable + t };
    expect(o.usd100).toBeCloseTo(Number(ponsSellOut(after, buy.tokens).out) / Number(v0) * 100, 1);
    // About the price ratio less the fees: a little under the bare ratio.
    expect(o.usd100).toBeLessThan(100 * (800 / 985) ** 2); expect(o.usd100).toBeGreaterThan(100 * (800 / 985) ** 2 * 0.99 - 2);
    // Nothing sold: no change; $100 in and straight back out loses only the fees.
    expect(curveDump(s, 0n, ETH_USD)).toMatchObject({ changePct: 0, drains: false });
    expect(curveDump(s, 0n, ETH_USD).usd100).toBeGreaterThan(97);
  });
  it('Pons curve: an empty curve drains a buyer: insiders sell into the next $100', () => {
    // No real ETH: insiders can sell nothing today, but they can sell into the next buyer's $100.
    const empty = curveState({ realQuote: 0n }), o = curveDump(empty, M(80), ETH_USD);
    expect(o.drains).toBe(true);
    expect(o.usd100).toBeLessThan(20);
  });
  it('Pons curve: a curve holding less than $100 still answers "your $100" (it never reads $0 without a dump)', () => {
    // 0.01 ETH of real ETH (~$30): selling $100 of tokens into it would fail, but buying $100 first funds the way out.
    const tiny = curveState({ realQuote: wei(0.01) });
    expect(curveDump(tiny, 0n, ETH_USD).usd100).toBeGreaterThan(97);
    expect(curveDump(tiny, M(1), ETH_USD).usd100).toBeGreaterThan(90);
  });
  it('Pons curve: a dump bigger than its real ETH stops when the ETH runs out, and leaves nothing for a holder', () => {
    const s = curveState({ realQuote: wei(0.3) }), o = curveDump(s, M(400), ETH_USD);
    expect(o.drains).toBe(true);
    expect(o.usd100).toBe(0);
    // The sells stop at t = R·T/(Q−R), where they have taken all 0.3 ETH: the price is then ((Q−R)/Q)² of before.
    expect(o.changePct).toBeCloseTo(-(1 - (2.7 / 3) ** 2) * 100, 1);
  });
  it('full-range pool: closed form from the check\'s pool reading, moved to the price now', () => {
    // A pool of 4 ETH and 400M tokens, as the check's probe read it (ponsPoolReserve from sqrtP and L).
    const sqrtP = sqrtOf({ eth: 4, tokens: 4e8, fee: 0 }), L = BigInt(Math.floor(Math.sqrt(4 * 4e8) * 1e18));
    const probe = ponsPoolReserve(sqrtP, L), r = fullRangeReserves(probe, null)!;
    expect(r.eth).toBeCloseTo(4, 3); expect(r.tokens / 1e8).toBeCloseTo(4, 3);
    // The price has since doubled (sqrtP / √2): the same L holds more ETH and fewer tokens.
    const moved = fullRangeReserves(probe, BigInt(Math.floor(Number(sqrtP) / Math.SQRT2)))!;
    expect(moved.eth).toBeCloseTo(4 * Math.SQRT2, 2); expect(moved.eth * moved.tokens).toBeCloseTo(r.eth * r.tokens, -10);
    const o = poolDump(r, 1e8, PONS_HOOK_SELL_FEE, ETH_USD);
    expect(o.changePct).toBeCloseTo(-(1 - (4 / 5) ** 2) * 100, 1);
    expect(o.usd100).toBeCloseTo(100 * (4 / 5) ** 2 * (1 - PONS_HOOK_SELL_FEE), 0);
  });

  it('serves a curve coin in one eth_call: every group, all insiders together, and the curve\'s charges', async () => {
    const token = A(3), curve = A(4), s = curveState({ creatorTaxBps: 100n });
    const { add, ask, calls } = rig({ [curve]: { ...s, token } });
    add(launched(curveCoin(token, curve)));
    const r = measured((await ask(token)).json() as DumpReply);
    expect(calls).toHaveLength(1);
    expect(r).toMatchObject({ version: 1, coin: token, venue: 'curve', sellFeePct: 2, funding: false });
    expect(r.groups.map(g => g.id)).toEqual(['dev', 'linked', 'bundle', 'sniper', 'early']);
    // No traced funding on this edge: the dev-funded wallet bought after the first minute, so it is no insider here.
    expect(group(r, 'linked')).toMatchObject({ wallets: 0, tokens: '0', sharePct: 0, changePct: 0 });
    expect(group(r, 'dev')).toMatchObject({ wallets: 1, sharePct: 5 });
    expect(group(r, 'dev').changePct).toBeCloseTo(-(1 - (800 / 850) ** 2) * 100, 1);
    expect(r.all).toMatchObject({ id: 'all', wallets: 7, sharePct: 14.5 });
    expect(r.all.changePct).toBeCloseTo(-(1 - (800 / 945) ** 2) * 100, 1);
    expect(r.all.usd100).toBe(curveDump(s, M(145), ETH_USD).usd100);
    expect(r.all.usd100! / 100 / ((800 / 945) ** 2 * 0.98)).toBeCloseTo(0.99, 1);
  });

  it('serves a graduated Pons coin from its full-range pool with no RPC, the hook\'s cut off "your $100"', async () => {
    const token = A(5), key = ponsPoolKey(token, addrs.hook);
    const { add, ask, calls, edge } = rig();
    const c = launched(curveCoin(token, A(6)));
    Object.assign(c, { graduated: true, key, poolId: v4PoolId(key) });
    add(c);
    const sqrtP = sqrtOf({ eth: 10, tokens: 5e8, fee: 0 }), L = BigInt(Math.floor(Math.sqrt(10 * 5e8) * 1e18));
    edge.probes.set(lc(token), { poolReserve: ponsPoolReserve(sqrtP, L) } as never);
    const r = measured((await ask(token)).json() as DumpReply);
    expect(calls).toHaveLength(0);
    expect(r.venue).toBe('pool');
    expect(r.all.changePct).toBeCloseTo(-(1 - (500 / 645) ** 2) * 100, 1);
    expect(r.all.usd100).toBeCloseTo(100 * (500 / 645) ** 2 * (1 - PONS_HOOK_SELL_FEE), 0);
  });

  it('serves any other native-ETH v4 pool through the quoter in one eth_call: marginal price before and after', async () => {
    const token = A(7), key: V4PoolKey = { currency0: zeroAddress, currency1: token, fee: 3000, tickSpacing: 60, hooks: zeroAddress };
    const pool: Pool = { eth: 20, tokens: 6e8, fee: 0.01 };
    const { add, ask, calls } = rig({}, { [token]: pool });
    const c = launched(curveCoin(token, A(8)));
    Object.assign(c, { graduated: true, key, poolId: v4PoolId(key), curve: undefined, launchpad: 'unbranded' });
    add(c);
    const r = measured((await ask(token)).json() as DumpReply);
    expect(calls).toHaveLength(1);
    expect(r.venue).toBe('quoter');
    const ratio = (600 / 745) ** 2;
    expect(r.all.changePct).toBeCloseTo(-(1 - ratio) * 100, 0);
    expect(r.all.usd100).toBeCloseTo(100 * ratio * 0.99, 0);
    expect(group(r, 'dev').changePct).toBeCloseTo(-(1 - (600 / 650) ** 2) * 100, 0);
  });
});

describe('GET /v2/coins/:address/dump (dump_test)', () => {
  it('is a feature folder the edge loads only while its flag is on', async () => {
    expect((await loadFeatures(new Set())).map(f => f.flag)).not.toContain('dump_test');
    expect((await loadFeatures(new Set(['dump_test']))).map(f => f.flag)).toContain('dump_test');
    expect(typeof dumpTest.register).toBe('function');
  });

  it('refuses a bad address and a coin EKO does not follow', async () => {
    const { ask, app } = rig();
    expect((await app.inject({ url: '/v2/coins/0x123/dump' })).statusCode).toBe(400);
    expect((await ask(A(99))).statusCode).toBe(404);
  });

  it('gives no figure on a partial history, or for a pool quoted in a token', async () => {
    const curve = A(21), { add, ask, calls } = rig({ [curve]: { ...curveState(), token: A(20) } });
    const partial = curveCoin(A(20), curve, { partial: true });
    swap(partial, OUT, 'buy', M(10), at(5000, 500));
    add(partial);
    expect((await ask(A(20))).json()).toMatchObject({ measured: false, reason: 'partial_history' });
    const quoted = launched(curveCoin(A(22), A(23)));
    Object.assign(quoted, { graduated: true, curve: undefined, key: { currency0: A(24), currency1: A(22), fee: 3000, tickSpacing: 60, hooks: zeroAddress } });
    add(quoted);
    expect((await ask(A(22))).json()).toMatchObject({ measured: false, reason: 'unknown_venue' });
    expect(calls).toHaveLength(0);
  });

  it('shares one figure for REFRESH_SEC, recomputes early when an insider\'s transfer lands, and not at all while nothing changes', async () => {
    const token = A(30), curve = A(31), { add, ask, calls, clock, api } = rig({ [curve]: { ...curveState(), token } });
    const c = add(launched(curveCoin(token, curve)));
    const first = (await ask(token)).json() as DumpReply;
    await ask(token, '10.0.0.2');
    expect(calls).toHaveLength(1);
    // An outsider trades: due only after REFRESH_SEC.
    swap(c, OUT, 'buy', M(5), at(6000, 600));
    clock.advance(EARLY_GAP_SEC + 1);
    expect(await api().tick()).toBe(0);
    clock.advance(REFRESH_SEC);
    expect(await api().tick()).toBe(1);
    expect(calls).toHaveLength(2);
    // The dev buys more: due after EARLY_GAP_SEC, and the figure deepens.
    swap(c, DEV, 'buy', M(60), at(7000, 700));
    clock.advance(EARLY_GAP_SEC);
    expect(await api().tick()).toBe(1);
    const later = (await ask(token)).json() as DumpReply;
    expect(calls).toHaveLength(3);
    expect(measured(later).all.changePct!).toBeLessThan(measured(first).all.changePct!);
    // Nothing changes: no read until IDLE_SEC.
    clock.advance(REFRESH_SEC * 3);
    expect(await api().tick()).toBe(0);
    clock.advance(IDLE_SEC);
    expect(await api().tick()).toBe(1);
  });

  it('keeps the last figure while servable when the RPC budget or provider fails, then shows none', async () => {
    const token = A(32), curve = A(33), r = rig({ [curve]: { ...curveState(), token } });
    const c = r.add(launched(curveCoin(token, curve)));
    const first = (await r.ask(token)).json() as DumpReply;
    r.calls.length = 0;
    // The curve stops answering (as a budget refusal would), after a new trade.
    Object.assign(c, { curve: { ...c.curve!, address: A(34) } });
    swap(c, DEV, 'buy', M(1), at(8000, 800));
    r.clock.advance(REFRESH_SEC + 1);
    expect(await r.api().tick()).toBe(1);
    expect(r.calls).toHaveLength(1);
    expect((await r.ask(token)).json()).toEqual(first);
    expect(await r.row(token)).toEqual(summaryOfReply(first));
    // Past SERVE_SEC with every read failing: neither the route nor the row shows the old figure.
    r.clock.advance(SERVE_SEC);
    expect((await r.ask(token)).json()).toMatchObject({ measured: false, reason: 'unavailable' });
    expect(await r.row(token)).toBeUndefined();
  });

  it('answers the route and the Radar row from one computation: they agree at every step', async () => {
    const token = A(35), curve = A(36), r = rig({ [curve]: { ...curveState(), token } });
    const c = r.add(launched(curveCoin(token, curve)));
    const agree = async () => {
      const route = (await r.ask(token)).json() as DumpReply, list = await r.row(token);
      expect(list).toEqual(summaryOfReply(route));
      return route;
    };
    // Nothing worked out yet: the route works it out, and the next list carries the same.
    expect(await r.row(token)).toBeUndefined();
    const first = await agree();
    // An insider sells after the figure was worked out: the route keeps serving it (no second, fresher answer) until
    // the background pass works it out again, and then both move together.
    swap(c, S1, 'sell', M(30), at(8100, 810));
    r.clock.advance(EARLY_GAP_SEC + 4);
    expect(await agree()).toEqual(first);
    expect(await r.api().tick()).toBe(1);
    const after = await agree();
    expect(measured(after).all.sharePct).toBeLessThan(measured(first).all.sharePct);
    expect(r.calls).toHaveLength(2);
  });

  it('works nothing out during the start-up replay, when a restored coin\'s later transfers are not back yet', async () => {
    const token = A(37), curve = A(38), r = rig({ [curve]: { ...curveState(), token } }, {}, { replaying: true });
    const c = r.add(launched(curveCoin(token, curve)));
    expect(r.api().caughtUp()).toBe(false);
    expect(await r.api().tick()).toBe(0);
    expect((await r.ask(token)).json()).toMatchObject({ measured: false, reason: 'unavailable' });
    expect(await r.row(token)).toBeUndefined();
    expect(r.calls).toHaveLength(0);
    // The replay brings back a sniper's sell; once caught up, the figure counts it.
    swap(c, S1, 'sell', M(30), at(8200, 820));
    r.tracker.cursor = HEAD - BigInt(CAUGHT_UP_BLOCKS);
    expect(await r.api().tick()).toBe(1);
    const reply = measured((await r.ask(token)).json() as DumpReply);
    expect(reply.all.sharePct).toBe(11.5);
    expect(await r.row(token)).toEqual(summaryOfReply(reply));
  });

  it('puts the all-insiders figure on each Radar row once worked out', async () => {
    const token = A(40), curve = A(41), { add, app, api } = rig({ [curve]: { ...curveState(), token } });
    add(launched(curveCoin(token, curve)));
    await api().tick();
    const rows = (await app.inject({ url: '/v2/radar' })).json() as { rows: { address: string; extras?: { dump_test?: DumpSummary } }[] };
    const summary = rows.rows.find(x => lc(x.address) === lc(token))?.extras?.dump_test;
    expect(summary).toMatchObject({ sharePct: 14.5 });
    expect(summary!.changePct).toBeCloseTo(-(1 - (800 / 945) ** 2) * 100, 1);
    // $100 sold on the curve as the dump leaves it: its own small move included.
    expect(summary!.usd100).toBe(curveDump(curveState(), M(145), ETH_USD).usd100);
  });
});

describe('dump test across restarts', () => {
  it('saves the figures and puts them back at start, served by the route and the list during the replay', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dump-snapshot-')), file = join(dir, 'dump.json');
    const token = A(70), curve = A(71), state = { [curve]: { ...curveState(), token } };
    const before = rig(state, {}, { snapshotPath: file });
    before.add(launched(curveCoin(token, curve)));
    await before.api().tick();
    const figure = (await before.ask(token)).json() as DumpReply;
    await before.app.close();
    // A restart two minutes later: the coin is back from the coin snapshot, the replay still running.
    const after = rig(state, {}, { snapshotPath: file, replaying: true, now: NOW + 120 });
    after.add(launched(curveCoin(token, curve)));
    expect((await after.ask(token)).json()).toEqual(figure);
    expect(await after.row(token)).toEqual(summaryOfReply(figure));
    expect(after.calls).toHaveLength(0);
    // Caught up: worked out again first, and both readers move to the new figure together.
    after.tracker.cursor = HEAD;
    expect(await after.api().tick()).toBe(1);
    const fresh = (await after.ask(token)).json() as DumpReply;
    expect(fresh).not.toEqual(figure);
    expect(await after.row(token)).toEqual(summaryOfReply(fresh));
    // Too old to put back: nothing restored.
    const late = rig(state, {}, { snapshotPath: file, replaying: true, now: NOW + 120 + RESTORED_SEC + 60 });
    late.add(launched(curveCoin(token, curve)));
    expect(await late.row(token)).toBeUndefined();
  });
  it('keeps the file versioned and bounded, and ignores one it cannot read', () => {
    const reply = { version: 1, coin: A(72), at: '2026-11-27T00:00:00.000Z', asOfBlock: 1, measured: false, reason: 'unknown_venue' } as DumpReply;
    const entries = Array.from({ length: MAX_ENTRIES + 5 }, () => ({ token: lc(A(72)), at: NOW, reply }));
    const { text, kept } = encodeDumps(entries, NOW);
    expect(kept).toBe(MAX_ENTRIES);
    const decoded = decodeDumps(text);
    if ('error' in decoded) throw new Error(decoded.error);
    expect(decoded.entries).toHaveLength(MAX_ENTRIES);
    expect(decodeDumps(text.replace(`"version":${DUMP_SNAPSHOT_VERSION}`, '"version":99'))).toEqual({ error: 'version 99 (expected 1)' });
    expect(decodeDumps('{')).toEqual({ error: 'unparseable' });
    // A malformed entry (the coin does not match its key) is dropped on its own.
    const mixed = decodeDumps(JSON.stringify({ version: 1, savedAt: NOW, entries: [{ token: lc(A(72)), at: NOW, reply }, { token: lc(A(73)), at: NOW, reply }] }));
    expect('entries' in mixed && mixed.entries).toHaveLength(1);
    const dir = mkdtempSync(join(tmpdir(), 'dump-snapshot-')), file = join(dir, 'dump.json');
    writeFileSync(file, 'not json');
    const r = rig({}, {}, { snapshotPath: file });
    expect(r.api().cache.size).toBe(0);
    expect(dumpSnapshotPath({ DUMP_SNAPSHOT: 'off' }, true)).toBeNull();
    expect(dumpSnapshotPath({ HISTORY_DB: '/data/history.db' }, true)).toBe('/data/dump.json');
    expect(dumpSnapshotPath({ COLUMNS_SNAPSHOT: '/vol/columns.json' }, false)).toBe('/vol/dump.json');
    expect(dumpSnapshotPath({}, false)).toBeNull();
  });
});

describe('dump risk alerts', () => {
  it('alerts watchers and holders when the figure crosses 50% or rises 20 points, once per cooldown', async () => {
    const token = A(50), curve = A(51), r = rig({ [curve]: { ...curveState({ realQuote: wei(2.5) }), token } }, {}, { accounts: true });
    const c = r.add(launched(curveCoin(token, curve)));
    const db = r.store!.db, holderWallet = lc(OUT);
    db.prepare('INSERT INTO accounts(id, wallet, created_at) VALUES(?, ?, ?)').run('acct-watch', lc(A(60)), NOW);
    db.prepare('INSERT INTO accounts(id, wallet, created_at) VALUES(?, ?, ?)').run('acct-hold', holderWallet, NOW);
    db.prepare('INSERT INTO accounts(id, wallet, created_at) VALUES(?, ?, ?)').run('acct-other', lc(A(61)), NOW);
    db.prepare("INSERT INTO watch(account_id, kind, target, created_at) VALUES(?, 'coin', ?, ?)").run('acct-watch', token, NOW);
    await r.api().tick();
    const first = measured((await r.ask(token)).json() as DumpReply);
    expect(-first.all.changePct!).toBeLessThan(ALERT.crossPct);
    expect(r.alerts.page('acct-watch').rows).toHaveLength(0);
    // The dev buys 30% of supply: the figure crosses 50%.
    swap(c, DEV, 'buy', M(300), at(9000, 900));
    r.clock.advance(EARLY_GAP_SEC);
    await r.api().tick();
    const now = measured((await r.ask(token)).json() as DumpReply);
    expect(-now.all.changePct!).toBeGreaterThanOrEqual(ALERT.crossPct);
    const [alert] = r.alerts.page('acct-watch').rows.map(a => AlertSchema.parse(a));
    expect(alert).toMatchObject({ kind: 'dump_risk', coin: lc(token), url: `/coin/${token}`, level: 'monitor' });
    expect(alert!.title).toBe(`Dump risk rose on $MAPLE: insiders now hold enough to drop it ${Math.round(-now.all.changePct!)}%`);
    expect(alert!.body).toContain('EKO estimates');
    expect(r.alerts.page('acct-hold').rows).toHaveLength(1);
    expect(r.alerts.page('acct-other').rows).toHaveLength(0);
    // Deeper still, within the cooldown: no second alert.
    swap(c, S2, 'buy', M(250), at(9100, 910));
    r.clock.advance(EARLY_GAP_SEC);
    await r.api().tick();
    expect(r.alerts.page('acct-watch').rows).toHaveLength(1);
  });
  it('reads a draining curve\'s risk as what a $100 buyer loses, and says so', () => {
    expect(riskOf({ changePct: -1.3, usd100: 91.74, drains: true })).toBeCloseTo(8.26, 2);
    expect(riskOf({ changePct: -40, usd100: 58 })).toBe(40);
    const t = alertText('$MAPLE', 72, 30, 28, 'watched', true);
    expect(t.title).toBe('Dump risk rose on $MAPLE: insiders now hold enough to drain its curve');
    expect(t.body).toContain('EKO estimates'); expect(t.body).toContain('$100 bought now would come back as about $28');
  });
  it('words the alert as an estimate, with what $100 keeps', () => {
    const t = alertText('$MAPLE', 70.4, 45, 26.2, 'bag');
    expect(t.title).toBe('Dump risk rose on $MAPLE: insiders now hold enough to drop it 70%');
    expect(t.body).toBe('EKO estimates the price would fall 70% if the coin\'s insiders sold everything at once, up from 45%. $100 bought now would come back as about $26 after. Your wallet holds this coin.');
  });
});
