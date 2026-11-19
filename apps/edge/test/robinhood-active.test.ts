import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAddress, type Address, type Hex } from 'viem';
import { loadRegistry } from '@eko/chain';
import fx from './fixtures/robinhood/active-pools.json' with { type: 'json' };
import quoted from './fixtures/robinhood/longxyz-quoted.json' with { type: 'json' };
import {
  ACTIVE_PER_ROUND, INITIALIZE_TOPIC, LONG_CREATE_TOPIC, LONG_HOOK_SWAP_TOPIC, PANGEA_HOOK_SWAP_TOPIC, PONS_HOOK_SWAP_TOPIC, robinhoodAddresses, robinhoodChain,
  v3TokenPrice, type QuotePrices,
} from '../src/chains/robinhood/index.js';
import { TRANSFER_TOPIC } from '../src/chains/logs.js';
import { compactFlows, FOLDED_TX, Tracker, type CoinState, type RawLog, type Rpc } from '../src/tracker.js';

/**
 * Coins still trading that launched before EKO's memory (flag more_launchpads), from one real slice of Robinhood Chain
 * read 2026-11-18 (fixtures/robinhood/active-pools.json): the long.xyz hook's per-swap events, the pools' swaps, each
 * pool's first swap's transfers, and DacityCoin (DCTY), a TTWO-quoted long.xyz coin launched 2026-10-18.
 */
const registry = loadRegistry(), addrs = robinhoodAddresses(registry);
const offline: Rpc = { request: async () => { throw new Error('no RPC in this test'); } };
const DCTY = getAddress(fx.dcty.token), POOL = fx.dcty.poolId!, FROM = BigInt(fx.window.from), TO = BigInt(fx.window.to);
const SWAP = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f';
const TTWO = quoted.launches.find(l => l.quoteSymbol === 'TTWO')!.quote;
const lower = (v: string) => v.toLowerCase();

// TTWO and ETH in USD from the quoted fixture's v3 pools (the same day), as QuotePrices would give them.
const reading = (symbol: string, quote: string, fee: number) => quoted.pricing.find(p => p.symbol === symbol && p.quote === quote && p.fee === fee)!;
const ETH_USD = v3TokenPrice(BigInt(reading('WETH', 'USDG', 100).sqrtPriceX96), reading('WETH', 'USDG', 100).tokenIsToken0, 18, 6);
const TTWO_USD = v3TokenPrice(BigInt(reading('TTWO', 'USDG', 3000).sqrtPriceX96), reading('TTWO', 'USDG', 3000).tokenIsToken0, 18, 6);
type Price = { symbol: string; decimals: number; kind: 'ETH' | 'USDG' | 'stock_token'; usd: number };
const PRICES = (): Record<string, Price> => ({
  [lower(TTWO)]: { symbol: 'TTWO', decimals: 18, kind: 'stock_token', usd: TTWO_USD },
  [lower(addrs.usdg)]: { symbol: 'USDG', decimals: 6, kind: 'USDG', usd: 1 },
  [lower(addrs.weth)]: { symbol: 'WETH', decimals: 18, kind: 'ETH', usd: ETH_USD },
});
function fixedQuotes(prices: Record<string, Price>) {
  const wanted = new Set<string>();
  const quotes = {
    asset: (q: string) => { const p = prices[lower(q)]; return p ? { address: getAddress(q), symbol: p.symbol, decimals: p.decimals, kind: p.kind, ethPer: p.usd / ETH_USD } : null; },
    ethPer: (q: string) => { const p = prices[lower(q)]; return p ? p.usd / ETH_USD : null; },
    want: (q: string) => { wanted.add(lower(q)); }, isRejected: () => false, refresh: async () => {},
  };
  return { quotes: quotes as unknown as QuotePrices, wanted };
}

/** The slice as an archive RPC: logs by address, topics and block range; the receipts; DCTY's code from its deployment. */
const ALL = [...new Map([...fx.longHookSwaps, ...fx.pangeaHookSwaps, ...fx.poolSwaps, ...fx.dcty.create, ...fx.dcty.initialize, ...fx.dcty.launchTransfers, ...fx.dcty.recentTransfers]
  .map(l => [`${l.transactionHash}:${BigInt(l.logIndex)}`, l as RawLog])).values()];
/** Extra logs the RPC serves for a filter and block range (a synthetic history), on top of the slice's. */
type Extra = (f: { address?: string | string[]; topics: (string | string[] | null)[] }, a: bigint, b: bigint) => RawLog[];
function sliceRpc(extra?: Extra) {
  const calls: { method: string; filter?: { address?: string | string[]; topics?: (string | string[] | null)[] }; code?: string }[] = [];
  const rpc: Rpc = { async request({ method, params }) {
    const p = (params as unknown[])[0] as Record<string, unknown> | string;
    calls.push({ method, ...(method === 'eth_getLogs' ? { filter: p as never } : {}), ...(method === 'eth_getCode' ? { code: lower(p as string) } : {}) });
    if (method === 'eth_getLogs') {
      const f = p as { address?: string | string[]; topics: (string | string[] | null)[]; fromBlock: string; toBlock: string };
      const a = BigInt(f.fromBlock), b = BigInt(f.toBlock), at = f.address ? [f.address].flat().map(lower) : null;
      const real = ALL.filter(l => { const n = BigInt(l.blockNumber); return n >= a && n <= b && (!at || at.includes(lower(l.address)))
        && f.topics.every((t, i) => t === null || [t].flat().map(lower).includes(lower(l.topics[i] ?? ''))); });
      return extra ? [...extra(f, a, b), ...real] : real;
    }
    if (method === 'eth_getTransactionReceipt') return (fx.receipts as Record<string, unknown>)[p as string] ?? null;
    if (method === 'eth_getCode') return lower(p as string) === lower(DCTY) && BigInt((params as string[])[1]!) >= BigInt(fx.dcty.deployBlock) ? '0x6080' : '0x';
    throw new Error(`not in the slice: ${method}`);
  } };
  return { rpc, calls };
}
async function round(chain: ReturnType<typeof robinhoodChain>, rpc: Rpc, known: Set<string> = new Set(), minQuote = 0.5) {
  const found: RawLog[][] = [];
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  // Each history arrives page by page and counts only once ended.
  const history = () => { const pages: RawLog[][] = []; return { add: (l: RawLog[]) => { pages.push(l); }, end: () => { found.push(pages.flat()); } }; };
  await chain.active!(rpc, FROM, TO, { token: (t) => known.has(lower(t)), pool: () => false }, minQuote, history);
  const line = log.mock.calls.map(c => String(c[0])).find(s => s.includes('active_graduates'));
  log.mockRestore();
  return { found, report: line ? JSON.parse(line) as { busy: { token: string; launchpad: string; quote24h: number }[]; found: { token: string; calls: number; logs: number; estLogs: number }[]; skipped: { token: string; estLogs: number; why: string }[]; failed: { token: string; why: string }[]; calls: { find: number; rank: number; history: number } } : null };
}
const stamp = (l: RawLog) => Number(BigInt(l.blockTimestamp!));

afterEach(() => { vi.restoreAllMocks(); });

describe('coins still trading that launched before EKO\'s memory (more_launchpads)', () => {
  it('reads the long.xyz hook\'s per-swap event: one for each PoolManager swap on its pools, naming the pool', () => {
    const hook = fx.longHookSwaps, swaps = fx.poolSwaps;
    expect(hook.every(l => lower(l.address) === lower(addrs.longHook) && l.topics[0] === LONG_HOOK_SWAP_TOPIC && l.topics[2] === l.topics[3])).toBe(true);
    const key = (tx: string, pool: string) => `${tx}:${pool}`;
    const count = (pairs: string[]) => pairs.reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map<string, number>());
    expect(count(hook.map(l => key(l.transactionHash, l.topics[2]!)))).toEqual(count(swaps.filter(s => hook.some(h => h.topics[2] === s.topics[1])).map(s => key(s.transactionHash, s.topics[1]!))));
    expect(hook.filter(l => l.topics[2] === POOL)).toHaveLength(69);
  });

  it('finds DacityCoin, a month-old TTWO-quoted long.xyz coin, ranks it by volume in ETH, and reads its whole history', async () => {
    const { quotes } = fixedQuotes(PRICES());
    const chain = robinhoodChain(registry, { moreLaunchpads: true, quotes }), { rpc, calls } = sliceRpc();
    const { found, report } = await round(chain, rpc);
    // Its 69 swaps in the slice, in ETH at TTWO's price (TTWO is currency0 of the pool: amount0 is the quote).
    const ttwo = fx.poolSwaps.filter(s => s.topics[1] === POOL).reduce((n, s) => { const a = BigInt.asIntN(256, BigInt(`0x${s.data.slice(2, 66)}`)); return n + Number(a < 0n ? -a : a) / 1e18; }, 0);
    expect(report!.busy[0]).toMatchObject({ token: DCTY, launchpad: 'longxyz' });
    expect(report!.busy[0]!.quote24h).toBeCloseTo(ttwo * TTWO_USD / ETH_USD, 1);
    expect(report!.busy.length).toBeLessThanOrEqual(ACTIVE_PER_ROUND);
    // Its history: the Airlock's Create and the pool's Initialize (found from the block its contract appeared), every
    // transfer and every swap since, in 100,000-block pages: what one month of history costs in calls.
    const logs = found[0]!;
    expect(logs.filter(l => l.topics[0] === LONG_CREATE_TOPIC)).toHaveLength(1);
    expect(logs.filter(l => l.topics[0] === INITIALIZE_TOPIC && l.topics[1] === POOL)).toHaveLength(1);
    expect(logs.filter(l => l.topics[0] === SWAP)).toHaveLength(69);
    expect(logs.filter(l => l.topics[0] === TRANSFER_TOPIC)).toHaveLength(fx.dcty.launchTransfers.length + fx.dcty.recentTransfers.length);
    const pages = Math.ceil(Number(TO - BigInt(fx.dcty.launchBlock) + 1n) / 100_000);
    const transferPages = calls.filter(c => c.filter?.address === DCTY && c.filter.topics?.[0] === TRANSFER_TOPIC).length;
    expect(transferPages).toBe(pages);
    expect(report!.found[0]!.calls).toBe(calls.filter(c => c.code === lower(DCTY)).length + 2 + 2 * pages);
    // Finding: one call each for the Pons, long.xyz and Pangea hooks' events over the slice; ranking: a receipt per busy pool and their swaps.
    expect(report!.calls.find).toBe(3);
    expect(calls.filter(c => c.method === 'eth_getLogs' && [c.filter!.topics![0]].flat().some(t => [PONS_HOOK_SWAP_TOPIC, LONG_HOOK_SWAP_TOPIC, PANGEA_HOOK_SWAP_TOPIC].includes(t as Hex)))).toHaveLength(3);
  });

  it('builds the coin as if followed from launch, and keeps it past the memory window while it trades', async () => {
    const { quotes } = fixedQuotes(PRICES());
    const chain = robinhoodChain(registry, { moreLaunchpads: true, quotes }), { rpc } = sliceRpc();
    const { found } = await round(chain, rpc);
    const tracker = new Tracker(offline, chain, { now: () => fx.window.toTs, activeQuote24h: 1 });
    tracker.applyAll(found[0]!, stamp);
    const coin = tracker.coin(DCTY)!;
    expect(coin).toMatchObject({ launchpad: 'longxyz', quote: getAddress(TTWO), quoteConverted: { symbol: 'TTWO', kind: 'stock_token' }, poolId: POOL, flipped: false, ts: fx.dcty.launchTs });
    expect(coin.key?.hooks).toBe(getAddress(addrs.longHook));
    expect(coin.trades).toHaveLength(69);
    expect(coin.supply).toBeGreaterThan(0n);
    expect(fx.window.toTs - coin.ts).toBeGreaterThan(30 * 86_400);
    (tracker as unknown as { prune(): void }).prune();
    expect(tracker.coin(DCTY)).toBeDefined();
    // Without the flag's rule a pool-launched coin is not kept for trading: it leaves with its launch's day.
    const { pooled: _pooled, ...before } = chain;
    const old = new Tracker(offline, before, { now: () => fx.window.toTs, activeQuote24h: 1 });
    old.applyAll(found[0]!, stamp);
    expect(old.coin(DCTY)).toBeDefined();
    (old as unknown as { prune(): void }).prune();
    expect(old.coin(DCTY)).toBeUndefined();
  });

  it('waits a round for a quote not priced yet, and does not ask for a resolved pool\'s receipt again', async () => {
    const prices: Record<string, Price> = {}, { quotes, wanted } = fixedQuotes(prices);
    const chain = robinhoodChain(registry, { moreLaunchpads: true, quotes });
    const first = sliceRpc(), one = await round(chain, first.rpc);
    // Neither TTWO nor DCTY priced: both are queued as quotes to check, and nothing is read for the pool yet.
    expect(one.found).toEqual([]);
    expect(wanted.has(lower(TTWO)) && wanted.has(lower(DCTY))).toBe(true);
    Object.assign(prices, PRICES());
    const second = sliceRpc(), two = await round(chain, second.rpc);
    expect(two.report!.busy[0]!.token).toBe(DCTY);
    // Followed now: the next round asks for no receipt (every busy pool is resolved) and reads no history.
    const third = sliceRpc(), three = await round(chain, third.rpc, new Set([lower(DCTY)]));
    expect(third.calls.filter(c => c.method === 'eth_getTransactionReceipt')).toEqual([]);
    expect(three.found.flat().some(l => lower(l.address) === lower(DCTY))).toBe(false);
  });

  it('flag off: reads only the Pons hook\'s events, as before', async () => {
    const chain = robinhoodChain(registry, { moreLaunchpads: false }), { rpc, calls } = sliceRpc();
    const { found } = await round(chain, rpc);
    expect(found).toEqual([]);
    expect(chain.pooled).toBeUndefined();
    expect(calls.map(c => [c.method, c.filter?.address])).toEqual([['eth_getLogs', addrs.hook]]);
  });

  it('builds the coin page by page in a scratch tracker and hands it over whole (the production path)', async () => {
    const { quotes } = fixedQuotes(PRICES());
    const chain = robinhoodChain(registry, { moreLaunchpads: true, quotes }), { rpc } = sliceRpc();
    const tracker = new Tracker(offline, chain, { now: () => fx.window.toTs, activeQuote24h: 1 });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await chain.active!(rpc, FROM, TO, { token: () => false, pool: () => false }, 0.5, () => tracker.historySink(TO));
    expect(tracker.coin(DCTY)).toBeUndefined();
    await (tracker as unknown as { applyActive(): Promise<void> }).applyActive();
    const coin = tracker.coin(DCTY)!;
    expect(coin).toMatchObject({ launchpad: 'longxyz', poolId: POOL, ts: fx.dcty.launchTs });
    expect(coin.trades).toHaveLength(69);
    expect(tracker.coinByPool(POOL)).toBe(coin);
    expect(tracker.feed.some(e => e.kind === 'new_pair' && lower(e.coin) === lower(DCTY))).toBe(true);
  });

  it('a large history (a month of transfers and swaps) never sits in memory whole, and the coin keeps its caps and balances', async () => {
    const { quotes } = fixedQuotes(PRICES());
    const chain = robinhoodChain(registry, { moreLaunchpads: true, quotes });
    const LAUNCH = BigInt(fx.dcty.launchBlock), template = fx.poolSwaps.find(s => s.topics[1] === POOL)!;
    const wallets = Array.from({ length: 40 }, (_, i) => `0x${(0xa11ce000 + i * 7919).toString(16).padStart(40, '0')}`);
    const truth = new Map<string, bigint>(), word = (v: bigint) => v.toString(16).padStart(64, '0');
    let generated = 0, consumed = 0, held = 0, n = 0, netEth = 0;
    const ethPer = TTWO_USD / ETH_USD;
    // 400 transfers and 100 swaps per 100,000-block page between the launch and the slice: about 105,000 and 26,000.
    const extra: Extra = (f, a, b) => {
      const lo = a > LAUNCH + 5_000n ? a : LAUNCH + 5_000n, hi = b < FROM - 1n ? b : FROM - 1n;
      if (lo > hi) return [];
      const isTransfers = lower([f.address].flat()[0] ?? '') === lower(DCTY), isSwaps = f.topics[0] === SWAP && [f.topics[1]].flat().map(x => lower(x ?? '')).includes(POOL);
      if (!isTransfers && !isSwaps) return [];
      const count = isTransfers ? 400 : 100, out: RawLog[] = [];
      for (let i = 0; i < count; i++) {
        const block = lo + (hi - lo) * BigInt(i) / BigInt(count), tx = `0x${word(BigInt(++n) + (isTransfers ? 0n : 1n << 200n))}` as Hex;
        const ts = `0x${(fx.dcty.launchTs + Math.round(Number(block - LAUNCH) * 0.1)).toString(16)}`;
        if (isTransfers) {
          const from = wallets[n % 40]!, to = wallets[(n * 7 + 3) % 40]!, value = BigInt(1 + (n % 97)) * 10n ** 18n;
          truth.set(from, (truth.get(from) ?? 0n) - value); truth.set(to, (truth.get(to) ?? 0n) + value);
          out.push({ address: DCTY, topics: [TRANSFER_TOPIC as Hex, `0x${from.slice(2).padStart(64, '0')}` as Hex, `0x${to.slice(2).padStart(64, '0')}` as Hex],
            data: `0x${word(value)}` as Hex, blockNumber: `0x${block.toString(16)}`, transactionHash: tx, logIndex: '0x0', blockTimestamp: ts } as RawLog);
        } else {
          // A third of them the other way round (both amounts flipped): sells.
          const a0 = BigInt.asIntN(256, BigInt(`0x${template.data.slice(2, 66)}`)), a1 = BigInt.asIntN(256, BigInt(`0x${template.data.slice(66, 130)}`));
          const sign = n % 3 ? 1n : -1n, q = a0 * sign;
          netEth += (q < 0n ? 1 : -1) * Number(q < 0n ? -q : q) / 1e18 * ethPer;
          out.push({ ...template, data: `0x${word(BigInt.asUintN(256, q))}${word(BigInt.asUintN(256, a1 * sign))}${template.data.slice(130)}` as Hex, blockNumber: `0x${block.toString(16)}`, transactionHash: tx, logIndex: '0x0', blockTimestamp: ts } as RawLog);
        }
      }
      generated += out.length; held = Math.max(held, generated - consumed);
      return out;
    };
    const { rpc } = sliceRpc(extra);
    const tracker = new Tracker(offline, chain, { now: () => fx.window.toTs, activeQuote24h: 1, maxFlowsPerCoin: 2_000, maxTradesPerCoin: 500 });
    const sink = () => { const s = tracker.historySink(TO); return { add: (l: RawLog[]) => { s.add(l); consumed += l.filter(x => BigInt(x.blockNumber) < FROM && BigInt(x.blockNumber) > LAUNCH + 4_000n).length; }, end: () => s.end() }; };
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await chain.active!(rpc, FROM, TO, { token: () => false, pool: () => false }, 0.5, sink);
    await (tracker as unknown as { applyActive(): Promise<void> }).applyActive();
    const coin = tracker.coin(DCTY)!;
    expect(generated).toBeGreaterThan(130_000);
    // At most the pages read ahead (two) and the one being applied were ever held.
    expect(held).toBeLessThanOrEqual(3 * 400);
    expect(coin.flows.length).toBeLessThanOrEqual(2_000);
    expect(coin.trades.length).toBe(500);
    // Balances summed over the kept flows are every wallet's true balance (the slice's transfers included).
    for (const l of [...fx.dcty.launchTransfers, ...fx.dcty.recentTransfers]) {
      const from = `0x${l.topics[1]!.slice(26)}`, to = `0x${l.topics[2]!.slice(26)}`, v = BigInt(l.data.slice(0, 66));
      truth.set(from, (truth.get(from) ?? 0n) - v); truth.set(to, (truth.get(to) ?? 0n) + v);
    }
    const kept = new Map<string, bigint>();
    for (const f of coin.flows) { kept.set(f.from, (kept.get(f.from) ?? 0n) - f.value); kept.set(f.to, (kept.get(f.to) ?? 0n) + f.value); }
    for (const [w, v] of truth) if (!['0x0000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000001'].includes(w)) expect([w, kept.get(w) ?? 0n]).toEqual([w, v]);
    expect(coin.flows.some(f => f.tx === FOLDED_TX)).toBe(true);
    // Net paid in counts every swap, not only the 500 kept.
    const sliceNet = fx.poolSwaps.filter(s => s.topics[1] === POOL).reduce((m, s) => { const q = BigInt.asIntN(256, BigInt(`0x${s.data.slice(2, 66)}`)); return m + (q < 0n ? 1 : -1) * Number(q < 0n ? -q : q) / 1e18 * ethPer; }, 0);
    expect(coin.netHype).toBeCloseTo(netEth + sliceNet, 6);
  });

  it('does not read a history estimated too large, and says so', async () => {
    const { quotes } = fixedQuotes(PRICES());
    const chain = robinhoodChain(registry, { moreLaunchpads: true, quotes, historyLogs: { coin: 1_000 } }), { rpc, calls } = sliceRpc();
    const { found, report } = await round(chain, rpc);
    expect(found).toEqual([]);
    // 69 swaps in the slice, four logs each, over the coin's 30-odd days.
    expect(report!.skipped[0]).toMatchObject({ token: DCTY, why: expect.stringMatching(/^too large/) });
    expect(report!.skipped[0]!.estLogs).toBeGreaterThan(8_000);
    expect(calls.some(c => c.filter?.address === DCTY)).toBe(false);
    // Not estimated again: the next round leaves the pool out.
    const again = sliceRpc(), next = await round(chain, again.rpc);
    expect(next.report?.skipped ?? []).toEqual([]);
  });
});

describe('compactFlows', () => {
  const w = (i: number) => `0x${(0xbeef00 + i).toString(16).padStart(40, '0')}`;
  const flow = (i: number, from: string, to: string, value: bigint, ts: number) => ({ tx: `0x${i.toString(16).padStart(64, '0')}` as Hex, block: i, ts, from, to, value });
  it('folds the oldest transfers past the launch span into one per wallet, keeping every balance', () => {
    const coin = { ts: 1_000, flows: [] as CoinState['flows'] };
    for (let i = 0; i < 50; i++) coin.flows.push(flow(i, '0x0000000000000000000000000000000000000000', w(i % 5), 10n, 1_000 + i));
    for (let i = 50; i < 1_200; i++) coin.flows.push(flow(i, w(i % 7), w((i * 3) % 11), BigInt(i), 5_000 + i));
    const balances = (fs: CoinState['flows']) => fs.reduce((m, f) => m.set(f.from, (m.get(f.from) ?? 0n) - f.value).set(f.to, (m.get(f.to) ?? 0n) + f.value), new Map<string, bigint>());
    const before = balances(coin.flows), launch = coin.flows.slice(0, 50), recent = coin.flows.slice(-500);
    compactFlows(coin, 1_000);
    expect(coin.flows.length).toBeLessThanOrEqual(1_000);
    expect(coin.flows.slice(0, 50)).toEqual(launch);
    expect(coin.flows.slice(-500)).toEqual(recent);
    const after = balances(coin.flows);
    for (let i = 0; i < 11; i++) expect(after.get(w(i)) ?? 0n).toBe(before.get(w(i)) ?? 0n);
  });
});
