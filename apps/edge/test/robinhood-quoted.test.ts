import { describe, expect, it } from 'vitest';
import { decodeEventLog, decodeFunctionData, encodeAbiParameters, encodeFunctionResult, getAddress, keccak256, parseAbi, zeroAddress, type Address, type Hex } from 'viem';
import { loadRegistry, v4PoolId } from '@eko/chain';
import quoted from './fixtures/robinhood/longxyz-quoted.json' with { type: 'json' };
import {
  decodeRobinhoodLog, INITIALIZE_TOPIC, LONG_CREATE_TOPIC, NATIVE_TOPIC, pickStockPrice, probeRobinhoodCoin, QuotePrices, quotedSwapTrade, robinhoodAddresses,
  robinhoodChain, robinhoodLogQueries, ROBINHOOD_STOCK_TOKEN, v3TokenPrice, type RawRobinhoodLog, type RobinhoodCoinState, type RobinhoodProbed,
} from '../src/chains/robinhood/index.js';
import { loadChain } from '../src/chains/index.js';
import { judge, sellCheckOutstanding } from '../src/assess.js';
import { BURN_SINKS } from '../src/burn.js';
import { findSnipers } from '../src/snipers.js';
import { flowStats } from '../src/holders.js';
import { swapAbi } from '../src/chains/logs.js';
import { coinCard, coinSummary } from '../src/views.js';
import { Tracker, type CoinState, type RawLog, type Rpc } from '../src/tracker.js';

/**
 * Flag more_launchpads: long.xyz launches quoted in a token (docs/robinhood/CHAIN-FACTS.md §9), from logs read on chain on
 * 2026-11-18 (fixtures/robinhood/longxyz-quoted.json): a TTWO-, a USDG-, a WETH- and an NVDA-quoted launch (the NVDA coin
 * sorts before its quote, so its pool is keyed coin / NVDA), and the Uniswap v3 pools that price TTWO and NVDA.
 */
const addrs = robinhoodAddresses(loadRegistry());
const registry = loadRegistry();
const offline: Rpc = { request: async () => { throw new Error('no RPC in this test'); } };
const SECONDS_PER_BLOCK = 0.1;
type Launch = (typeof quoted.launches)[number] & { launchTx: RawLog[]; after: RawLog[] };
const launches = quoted.launches as unknown as Launch[];
const bySymbol = (s: string) => launches.find(l => l.quoteSymbol === s)!;
const SWAP = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f';
/** Every log once (the launch transaction's own swap is also in `after`). */
const logsOf = (l: Launch) => [...new Map([...l.launchTx, ...l.after].map(x => [`${x.transactionHash}:${BigInt(x.logIndex)}`, x])).values()];
const stamp = (l: Launch) => (x: RawLog) => Math.round(l.launchTs + (Number(BigInt(x.blockNumber)) - l.launchBlock) * SECONDS_PER_BLOCK);

// ETH, TTWO and NVDA in USD at the TTWO launch's block, from the fixture's v3 pools (USDG = $1).
const reading = (symbol: string, quote: string, fee: number) => quoted.pricing.find(p => p.symbol === symbol && p.quote === quote && p.fee === fee)!;
const priceOf = (p: (typeof quoted.pricing)[number], decimals: number, quoteDecimals: number) => v3TokenPrice(BigInt(p.sqrtPriceX96), p.tokenIsToken0, decimals, quoteDecimals);
const ETH_USD = priceOf(reading('WETH', 'USDG', 100), 18, 6);
const TTWO_USD = priceOf(reading('TTWO', 'USDG', 3000), 18, 6);
const NVDA_USD = priceOf(reading('NVDA', 'WETH', 500), 18, 18) * ETH_USD;
const PRICES: Record<string, { symbol: string; decimals: number; kind: 'ETH' | 'USDG' | 'stock_token'; usd: number }> = {
  [bySymbol('TTWO').quote]: { symbol: 'TTWO', decimals: 18, kind: 'stock_token', usd: TTWO_USD },
  [bySymbol('NVDA').quote]: { symbol: 'NVDA', decimals: 18, kind: 'stock_token', usd: NVDA_USD },
  [addrs.usdg.toLowerCase()]: { symbol: 'USDG', decimals: 6, kind: 'USDG', usd: 1 },
  [addrs.weth.toLowerCase()]: { symbol: 'WETH', decimals: 18, kind: 'ETH', usd: ETH_USD },
};
/** QuotePrices as the tracker reads it, with the fixture's prices (the class itself is tested below). */
function fixedQuotes(prices = PRICES) {
  const wanted: string[] = [];
  const quotes = {
    asset: (q: string) => { const p = prices[q.toLowerCase()]; return p ? { address: getAddress(q), symbol: p.symbol, decimals: p.decimals, kind: p.kind, ethPer: p.usd / ETH_USD } : null; },
    ethPer: (q: string) => { const p = prices[q.toLowerCase()]; return p ? p.usd / ETH_USD : null; },
    want: (q: string) => { wanted.push(q.toLowerCase()); }, isRejected: () => false, refresh: async () => {},
  };
  return { quotes: quotes as unknown as QuotePrices, wanted };
}
function track(l: Launch, moreLaunchpads = true, prices = PRICES) {
  const { quotes, wanted } = fixedQuotes(prices);
  const chain = robinhoodChain(registry, { moreLaunchpads, quotes });
  const tracker = new Tracker(offline, chain);
  tracker.applyAll(logsOf(l), stamp(l));
  return { tracker, chain, coin: tracker.coin(l.token), wanted };
}
const createOf = (l: Launch) => l.launchTx.find(x => x.topics[0] === LONG_CREATE_TOPIC)!;
const initOf = (l: Launch) => l.launchTx.find(x => x.topics[0] === INITIALIZE_TOPIC)!;
const swapsOf = (l: Launch) => logsOf(l).filter(x => x.topics[0] === SWAP);

describe('quote prices (more_launchpads)', () => {
  it('prices TTWO, NVDA and USDG from the registry factory\'s v3 pools, and the pools of one token agree', () => {
    expect(ETH_USD).toBeGreaterThan(1500); expect(ETH_USD).toBeLessThan(2100);
    expect(TTWO_USD).toBeGreaterThan(150); expect(TTWO_USD).toBeLessThan(300);
    expect(NVDA_USD).toBeGreaterThan(100); expect(NVDA_USD).toBeLessThan(250);
    // TTWO in WETH, NVDA in USDG and WETH at other fee tiers: within 3% of the deepest pool.
    expect(Math.abs(priceOf(reading('TTWO', 'WETH', 3000), 18, 18) * ETH_USD / TTWO_USD - 1)).toBeLessThan(0.03);
    expect(Math.abs(priceOf(reading('NVDA', 'USDG', 500), 18, 6) / NVDA_USD - 1)).toBeLessThan(0.03);
    // USDG against the same WETH/USDG pool: within 2% of a dollar when ETH's price is accepted (EthUsd's check).
    expect(Math.abs(priceOf(reading('WETH', 'USDG', 500), 18, 6) / ETH_USD - 1)).toBeLessThan(0.02);
  });

  it('picks the deepest pool, and refuses a thin market, pools that disagree, or a price out of range', () => {
    const r = (pool: string, usd: number, depthUsd: number, liquidity = 1n) => ({ pool: pool as Address, usd, depthUsd, liquidity });
    expect(pickStockPrice([r('0x1', 218, 190_000), r('0x2', 219, 4_000), r('0x3', 214, 0, 0n)], 10_000, 0.03)).toEqual({ usd: 218, pool: '0x1' });
    expect(pickStockPrice([r('0x1', 218, 9_000)], 10_000, 0.03)).toEqual({ refused: 'no pool holds enough' });
    expect(pickStockPrice([r('0x1', 218, 50_000, 0n)], 10_000, 0.03)).toEqual({ refused: 'no pool holds enough' });
    expect(pickStockPrice([r('0x1', 218, 190_000), r('0x2', 260, 20_000)], 10_000, 0.03)).toEqual({ refused: 'pools disagree' });
    expect(pickStockPrice([r('0x1', 3e50, 190_000)], 10_000, 0.03)).toEqual({ refused: 'price out of range' });
  });

  it('pins Robinhood\'s stock-token proxy as measured; a look-alike has other code', () => {
    expect(ROBINHOOD_STOCK_TOKEN.proxyCodeHash).toBe(quoted.stock.proxyCodeHash);
    expect(ROBINHOOD_STOCK_TOKEN.beacon.toLowerCase()).toBe(quoted.stock.beacon);
    expect(quoted.stock.fakeCodeHash).not.toBe(quoted.stock.proxyCodeHash);
  });

  /** An RPC serving one stock token, a look-alike and a coin, and the multicall reads QuotePrices makes. */
  function chainRpc(state: { usdgPrice: bigint; wethPrice: bigint; usdgHeld: bigint; wethHeld: bigint }) {
    const stock = getAddress(quoted.stock.sample), fake = getAddress(quoted.stock.fake), coin = getAddress(bySymbol('TTWO').token);
    const code: Record<string, Hex> = { [stock]: '0x6001', [fake]: '0x6002', [coin]: '0x6001' };
    const beacon: Record<string, Hex> = { [stock]: `0x${'0'.repeat(24)}${quoted.stock.beacon.slice(2)}`, [fake]: `0x${'0'.repeat(24)}${quoted.stock.beacon.slice(2)}`, [coin]: `0x${'0'.repeat(64)}` };
    const usdgPool = getAddress(reading('TTWO', 'USDG', 3000).pool), wethPool = getAddress(reading('TTWO', 'WETH', 3000).pool);
    const abi = parseAbi(['function getPool(address, address, uint24) view returns (address)', 'function slot0() view returns (uint160, int24, uint16, uint16, uint16, uint8, bool)',
      'function liquidity() view returns (uint128)', 'function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)', 'function symbol() view returns (string)']);
    const mc = parseAbi(['struct Call3 { address target; bool allowFailure; bytes callData; }', 'struct Result { bool success; bytes returnData; }', 'function aggregate3(Call3[] calls) payable returns (Result[] returnData)']);
    const calls: string[] = [];
    const rpc: Rpc = { request: async ({ method, params }) => {
      calls.push(method);
      const [a, b] = params as [unknown, unknown];
      if (method === 'eth_getCode') return code[getAddress(a as string)] ?? '0x';
      if (method === 'eth_getStorageAt') return beacon[getAddress(a as string)] ?? `0x${'0'.repeat(64)}`;
      if (method !== 'eth_call') throw new Error(method);
      const { args: [list] } = decodeFunctionData({ abi: mc, data: (a as { data: Hex }).data });
      void b;
      const out = list.map(c => {
        const { functionName, args } = decodeFunctionData({ abi, data: c.callData });
        const ok = (result: unknown) => ({ success: true, returnData: encodeFunctionResult({ abi, functionName, result } as never) as Hex });
        if (functionName === 'decimals') return ok(18);
        if (functionName === 'symbol') return ok('TTWO');
        if (functionName === 'getPool') { const [, q, fee] = args as [Address, Address, number];
          return ok(fee === 3000 ? (q.toLowerCase() === addrs.usdg.toLowerCase() ? usdgPool : wethPool) : zeroAddress); }
        if (functionName === 'slot0') return ok([c.target === usdgPool ? state.usdgPrice : state.wethPrice, 0, 0, 0, 0, 0, true]);
        if (functionName === 'liquidity') return ok(10n ** 20n);
        if (functionName === 'balanceOf') return ok(getAddress((args as [Address])[0]) === usdgPool ? state.usdgHeld : state.wethHeld);
        return { success: false, returnData: '0x' as Hex };
      });
      return encodeFunctionResult({ abi: mc, functionName: 'aggregate3', result: out });
    } };
    return { rpc, calls, stock, fake, coin };
  }

  it('checks a numeraire once: a Robinhood stock (proxy code and beacon) is priced from its deepest pool; a look-alike or a coin never', async () => {
    const usdg = BigInt(reading('TTWO', 'USDG', 3000).sqrtPriceX96), weth = BigInt(reading('TTWO', 'WETH', 3000).sqrtPriceX96);
    const { rpc, stock, fake, coin } = chainRpc({ usdgPrice: usdg, wethPrice: weth, usdgHeld: 187_816n * 10n ** 6n, wethHeld: 2n * 10n ** 18n });
    let now = 1_000_000;
    const eth = { latest: ETH_USD as number | null };
    const q = new QuotePrices({ ethUsd: eth, addrs: { weth: addrs.weth, usdg: addrs.usdg, v3Factory: registry.requireAddress('uniswapV3.factory'), multicall3: addrs.multicall3 },
      now: () => now, stock: { beacon: getAddress(quoted.stock.beacon), proxyCodeHash: keccak256('0x6001') } });
    // WETH 1:1, USDG at $1 through the accepted ETH price; nothing else before a check.
    expect(q.ethPer(addrs.weth)).toBe(1);
    expect(q.ethPer(addrs.usdg)).toBeCloseTo(1 / ETH_USD, 12);
    expect(q.asset(stock)).toBeNull();
    q.want(stock); q.want(fake); q.want(coin);
    await q.refresh(rpc);
    // The look-alike carries Robinhood's beacon in its slot but other code: rejected, as is a coin with neither.
    expect(q.isRejected(fake)).toBe(true);
    expect(q.asset(stock)).toMatchObject({ kind: 'stock_token', symbol: 'TTWO', decimals: 18 });
    expect(q.stockUsd(stock)!.usd).toBeCloseTo(TTWO_USD, 6);
    expect(q.stockUsd(stock)!.pool).toBe(getAddress(reading('TTWO', 'USDG', 3000).pool));
    expect(q.ethPer(stock)).toBeCloseTo(TTWO_USD / ETH_USD, 9);
    expect(q.isRejected(coin)).toBe(true);
    // No ETH price: nothing but WETH is priced.
    eth.latest = null;
    expect(q.ethPer(addrs.usdg)).toBeNull(); expect(q.ethPer(stock)).toBeNull(); expect(q.ethPer(addrs.weth)).toBe(1);
    eth.latest = ETH_USD;
    // Stale after six hours without an accepted reading.
    now += 6 * 3600_000 + 1;
    expect(q.ethPer(stock)).toBeNull();
  });

  it('rejects a token with Robinhood\'s beacon but other code (the look-alike), and holds a jump until a second reading agrees', async () => {
    const usdg = BigInt(reading('TTWO', 'USDG', 3000).sqrtPriceX96), weth = BigInt(reading('TTWO', 'WETH', 3000).sqrtPriceX96);
    const state = { usdgPrice: usdg, wethPrice: weth, usdgHeld: 187_816n * 10n ** 6n, wethHeld: 0n };
    const { rpc, stock, fake } = chainRpc(state);
    let now = 1_000_000;
    const q = new QuotePrices({ ethUsd: { latest: ETH_USD }, addrs: { weth: addrs.weth, usdg: addrs.usdg, v3Factory: registry.requireAddress('uniswapV3.factory'), multicall3: addrs.multicall3 },
      now: () => now, stock: { beacon: getAddress(quoted.stock.beacon), proxyCodeHash: keccak256('0x6001') } });
    q.want(stock); q.want(fake);
    await q.refresh(rpc);
    // The look-alike's stub code differs from the pinned proxy's ('0x6002').
    expect(q.isRejected(fake)).toBe(true);
    const first = q.stockUsd(stock)!.usd;
    // The pool doubles (TTWO is token0 against USDG: sqrt price × √2 is twice the USDG per TTWO).
    state.usdgPrice = usdg * 1414n / 1000n;
    now += 61_000; await q.refresh(rpc);
    expect(q.stockUsd(stock)!.usd).toBe(first);
    expect(q.refusals.get(stock.toLowerCase())?.why).toMatch(/moved too far/);
    now += 61_000; await q.refresh(rpc);
    expect(Math.abs(q.stockUsd(stock)!.usd / first - 2)).toBeLessThan(0.01);
  });
});

describe('long.xyz launches quoted in a token (more_launchpads)', () => {
  const ttwo = bySymbol('TTWO'), nvda = bySymbol('NVDA'), usdg = bySymbol('USDG'), weth = bySymbol('WETH');

  it('decodes a token-quoted Create and its pool\'s Initialize only with quoted pools followed', () => {
    const create = createOf(ttwo) as RawRobinhoodLog, init = initOf(ttwo) as RawRobinhoodLog;
    expect(decodeRobinhoodLog(create, addrs)).toBeNull();
    expect(decodeRobinhoodLog(init, addrs)).toBeNull();
    expect(decodeRobinhoodLog(create, addrs, undefined, { quotedPools: true })).toMatchObject({ kind: 'pool_launch', launchpad: 'longxyz', token: getAddress(ttwo.token), quote: getAddress(ttwo.quote), key: null });
    const e = decodeRobinhoodLog(init, addrs, undefined, { quotedPools: true });
    expect(e).toMatchObject({ kind: 'pool_init', poolId: ttwo.poolId });
    if (e?.kind !== 'pool_init') throw new Error('not an Initialize');
    expect(e.key).toMatchObject({ currency0: getAddress(ttwo.quote), currency1: getAddress(ttwo.token), hooks: addrs.longHook, fee: 0x800000 });
    expect(v4PoolId(e.key).toLowerCase()).toBe(ttwo.poolId);
    // Another hook's token-quoted pool is never read.
    const other = { ...init, data: init.data.replace(addrs.longHook.slice(2).toLowerCase(), addrs.hook.slice(2).toLowerCase()) as Hex };
    expect(decodeRobinhoodLog(other, addrs, undefined, { quotedPools: true })).toBeNull();
    // The queries: every Initialize only with quoted pools followed.
    expect(robinhoodLogQueries(addrs)[1]).toEqual({ address: addrs.poolManager, topics: [INITIALIZE_TOPIC, null, NATIVE_TOPIC] });
    expect(robinhoodLogQueries(addrs, { quotedPools: true })[1]).toEqual({ address: addrs.poolManager, topics: [INITIALIZE_TOPIC] });
  });

  it('with the flag off follows none of them, exactly as before', () => {
    for (const l of [ttwo, nvda, usdg, weth]) expect(track(l, false).coin).toBeUndefined();
    expect(robinhoodChain().quotedTrade).toBeUndefined();
    expect(loadChain('robinhood').queries).toEqual(robinhoodChain().queries);
    expect(loadChain('robinhood', new Set(['more_launchpads'])).queries[1]).toEqual({ address: addrs.poolManager, topics: [INITIALIZE_TOPIC] });
  });

  it('follows a TTWO-quoted coin: key from its Initialize, every swap in ETH at TTWO\'s price', () => {
    const { tracker, coin } = track(ttwo);
    expect(coin).toMatchObject({ launchpad: 'longxyz', quote: getAddress(ttwo.quote), flipped: false, poolId: ttwo.poolId, quoteConverted: { kind: 'stock_token', symbol: 'TTWO', decimals: 18 } });
    expect(tracker.coinByPool(ttwo.poolId)?.token).toBe(getAddress(ttwo.token));
    expect(coin!.supply).toBeGreaterThan(0n);
    expect(coin!.openPrice).toBeGreaterThan(0);
    const swaps = swapsOf(ttwo);
    expect(coin!.trades).toHaveLength(swaps.length);
    // Each trade: the swap's TTWO leg in ETH at TTWO's price, and the pool price close to what the trade paid.
    const ethPer = TTWO_USD / ETH_USD;
    swaps.forEach((s, i) => {
      const { args } = decodeEventLog({ abi: swapAbi, topics: s.topics as [Hex, ...Hex[]], data: s.data });
      const t = coin!.trades[i]!;
      expect(t.hype).toBeCloseTo(Math.abs(Number(args.amount0)) / 1e18 * ethPer, 9);
      expect(t.side).toBe(args.amount0 < 0n ? 'buy' : 'sell');
      expect(Math.abs(t.priceHype / (t.hype / t.tokens) - 1)).toBeLessThan(0.25);
    });
  });

  it('reads the NVDA coin, which sorts before its quote, the other way round (flipped)', () => {
    const { coin } = track(nvda);
    expect(coin).toMatchObject({ flipped: true, quoteConverted: { kind: 'stock_token', symbol: 'NVDA' } });
    expect(coin!.key).toMatchObject({ currency0: getAddress(nvda.token), currency1: getAddress(nvda.quote) });
    expect(coin!.trades).toHaveLength(swapsOf(nvda).length);
    for (const t of coin!.trades) expect(Math.abs(t.priceHype / (t.hype / t.tokens) - 1)).toBeLessThan(0.25);
    // The opening price reads the tick the other way round too: within the first trades' price range.
    expect(Math.abs(Math.log10(coin!.openPrice! / coin!.trades[0]!.priceHype))).toBeLessThan(1);
  });

  it('follows USDG- and WETH-quoted coins: USDG at $1 (6 decimals), WETH 1:1', () => {
    const u = track(usdg).coin!, w = track(weth).coin!;
    const ctx = { nowSec: u.ts + 60, head: u.block, hypeUsd: ETH_USD, native: 'ETH' as const };
    // WETH is named as such (the API's quoteAsset reads ETH for it), and a native coin carries no ticker.
    expect(coinCard(w, undefined, ctx).identity).toMatchObject({ quoteAsset: 'ETH', quoteSymbol: 'WETH' });
    expect(coinCard(u, undefined, ctx).identity).toMatchObject({ quoteAsset: 'USDG', quoteSymbol: 'USDG' });
    expect(coinSummary({ ...u, quote: zeroAddress, quoteConverted: undefined }, undefined, ctx).quoteSymbol).toBeUndefined();
    // A ticker that is not plain letters and digits is never sent.
    expect(coinSummary({ ...u, quoteConverted: { ...u.quoteConverted!, symbol: 'US<b>' } }, undefined, ctx).quoteSymbol).toBeUndefined();
    expect(u.quoteConverted).toEqual({ kind: 'USDG', symbol: 'USDG', decimals: 6 });
    expect(w.quoteConverted).toEqual({ kind: 'ETH', symbol: 'WETH', decimals: 18 });
    expect(u.trades).toHaveLength(swapsOf(usdg).length);
    expect(w.trades).toHaveLength(swapsOf(weth).length);
    const s = swapsOf(usdg)[0]!, { args } = decodeEventLog({ abi: swapAbi, topics: s.topics as [Hex, ...Hex[]], data: s.data });
    expect(u.trades[0]!.hype).toBeCloseTo(Math.abs(Number(args.amount0)) / 1e6 / ETH_USD, 12);
    const ws = swapsOf(weth)[0]!, wa = decodeEventLog({ abi: swapAbi, topics: ws.topics as [Hex, ...Hex[]], data: ws.data }).args;
    expect(w.trades[0]!.hype).toBeCloseTo(Math.abs(Number(wa.amount0)) / 1e18, 12);
  });

  it('does not follow a launch whose numeraire is not priced, and queues it for a check', () => {
    const { coin, wanted } = track(ttwo, true, { ...PRICES, [ttwo.quote]: undefined as never });
    expect(coin).toBeUndefined();
    expect(wanted).toContain(ttwo.quote.toLowerCase());
  });

  it('shows the coin with market cap and volume in USD, its quote named; checked (holders, fake_mcap) but never traded', () => {
    const { coin, chain } = track(ttwo);
    const last = coin!.trades.at(-1)!, now = last.ts + 5, head = last.block;
    const ctx = { nowSec: now, head, hypeUsd: ETH_USD, native: 'ETH' as const };
    const probed: RobinhoodProbed = { block: head, at: new Date(now * 1000).toISOString(), name: 'Sample', symbol: 'SMPL', key: coin!.key, config: null, currentBuyFeePips: null,
      probeUsd: 1000, tips: {}, pons: null, lock: null, probe: null };
    const a = judge(coin!, probed, { chain, hypeUsd: ETH_USD, nowSec: now, head });
    const summary = coinSummary(coin!, a, ctx);
    expect(summary.unavailable).not.toContain('marketCap');
    expect(summary.unavailable).not.toContain('volume');
    expect(summary.marketCapUsd).toBeGreaterThan(0);
    // Price in USD: the last trade's TTWO per coin at TTWO's dollar price.
    expect(summary.priceUsd).toBeCloseTo(last.priceHype * ETH_USD, 9);
    const card = coinCard(coin!, a, ctx);
    expect(card.identity.quoteAsset).toBe('stock_token');
    // The ticker names the stock (the web reads "Stock token · TTWO"), on the card and on rows.
    expect(card.identity.quoteSymbol).toBe('TTWO');
    expect(summary.quoteSymbol).toBe('TTWO');
    expect(card.identity.pools[0]).toMatchObject({ quote: getAddress(ttwo.quote) });
    expect(a.stats.holders).toBeDefined();
    expect(chain.facts(coin!, probed, now).backing).toBeDefined();
    expect(a.matches.find(m => m.id === 'malicious_hook')?.level).toBe('monitor');
    expect(() => chain.trade.precheck!(coin!)).toThrow(/runs a hook EKO does not trade through/);
    try { chain.trade.precheck!(coin!); } catch (error) { expect(error).toMatchObject({ code: 'not_traded', status: 409 }); }
    expect(() => chain.trade.route({ ...coin!, key: { ...coin!.key!, hooks: zeroAddress } }, undefined)).toThrow();
  });

  it('keeps a coin with 9 decimals scaled in displays only', () => {
    const { coin } = track(ttwo);
    const ctx = { nowSec: coin!.trades.at(-1)!.ts + 5, head: coin!.trades.at(-1)!.block, hypeUsd: ETH_USD, native: 'ETH' as const };
    const p18 = coinSummary(coin!, undefined, ctx);
    const nine = { ...coin!, decimals: 9 } as CoinState;
    const p9 = coinSummary(nine, undefined, ctx);
    expect(p9.priceUsd / p18.priceUsd).toBeCloseTo(1e-9, 15);
    expect(p9.marketCapUsd).toBeCloseTo(p18.marketCapUsd!, 6);
  });

  it('runs no sell probe on a token-quoted pool (it spends ETH): the check is named missing, not failed', async () => {
    const { coin } = track(ttwo);
    const mc = parseAbi(['struct Call3 { address target; bool allowFailure; bytes callData; }', 'function aggregate3(Call3[] calls) payable returns ((bool success, bytes returnData)[])']);
    const overrides: unknown[] = [];
    const rpc: Rpc = { request: async ({ method, params }) => {
      if (method !== 'eth_call') throw new Error(`unexpected ${method}`);
      const [tx, , o] = params as [{ data: Hex }, string, unknown];
      if (o) overrides.push(o);
      const { args: [calls] } = decodeFunctionData({ abi: mc, data: tx.data });
      return encodeFunctionResult({ abi: mc, functionName: 'aggregate3', result: calls.map(() => ({ success: true, returnData: encodeAbiParameters([{ type: 'string' }], ['X']) })) });
    } };
    const p = await probeRobinhoodCoin(coin as unknown as RobinhoodCoinState, BigInt(ttwo.launchBlock + 10), { rpc, addrs, ethUsd: () => ETH_USD });
    expect(p.key).toEqual(coin!.key);
    expect(p.probe).toBeNull();
    expect(overrides).toHaveLength(0);
    // Named as a pool the check can never run on, so it is not waited for or retried as a failure.
    expect(p.sellCheckUnavailable).toBe('token_quoted_pool');
    expect(sellCheckOutstanding(p)).toBe(false);
    // Gated: a coin without a converted quote (Pons, Pangea: native ETH) is never marked, so a missing probe still waits.
    const native = await probeRobinhoodCoin({ ...coin!, quoteConverted: undefined } as unknown as RobinhoodCoinState, BigInt(ttwo.launchBlock + 10), { rpc, addrs, ethUsd: () => ETH_USD });
    expect(native.sellCheckUnavailable).toBeUndefined();
    expect(sellCheckOutstanding(native)).toBe(true);
  });

  it('probes a token-quoted pool with about $1,000 of its quote token when its price and balance slot are known', async () => {
    const { coin } = track(ttwo);
    const mc = parseAbi(['struct Call3 { address target; bool allowFailure; bytes callData; }', 'function aggregate3(Call3[] calls) payable returns ((bool success, bytes returnData)[])']);
    const probes: { overrides: Record<string, unknown> }[] = [];
    const rpc: Rpc = { request: async ({ method, params }) => {
      if (method !== 'eth_call') throw new Error(`unexpected ${method}`);
      const [tx, , o] = params as [{ data: Hex }, string, Record<string, unknown> | undefined];
      if (o) { probes.push({ overrides: o }); return encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bool' }, { type: 'bool' }, { type: 'bytes' }], [5000n, 97n * 10n ** 17n, 97n * 10n ** 17n, 10n ** 19n, true, true, '0x']); }
      const { args: [calls] } = decodeFunctionData({ abi: mc, data: tx.data });
      return encodeFunctionResult({ abi: mc, functionName: 'aggregate3', result: calls.map(() => ({ success: true, returnData: encodeAbiParameters([{ type: 'string' }], ['X']) })) });
    } };
    const c = coin as unknown as RobinhoodCoinState;
    const quoteProbe = async (q: RobinhoodCoinState) => ({ pair: { token: q.quote, balance: { layout: 'erc7201' as const } }, amount: 10n ** 19n });
    const p = await probeRobinhoodCoin(c, BigInt(ttwo.launchBlock + 10), { rpc, addrs, ethUsd: () => ETH_USD, quoteProbe });
    expect(p.probe).toMatchObject({ status: 'sellable', venue: 'uniswap_v4', exitCostPct: 3, sizeWei: String(10n ** 19n) });
    expect(p.sellCheckUnavailable).toBeUndefined();
    expect(probes).toHaveLength(1);
    expect(Object.keys(probes[0]!.overrides).map(k => k.toLowerCase())).toContain(c.quote.toLowerCase());
    // No price or balance slot yet: named missing, as before.
    const unknown = await probeRobinhoodCoin(c, BigInt(ttwo.launchBlock + 10), { rpc, addrs, ethUsd: () => ETH_USD, quoteProbe: async () => null });
    expect(unknown.probe).toBeNull();
    expect(unknown.sellCheckUnavailable).toBe('token_quoted_pool');
  });

  it('grades a pool the sell check can never run on from the checks that do run: Monitor, not an endless Pending', () => {
    const { coin, chain } = track(usdg);
    const last = coin!.trades.at(-1)!, now = last.ts + 5, head = last.block;
    const ctx = { nowSec: now, head, hypeUsd: ETH_USD, native: 'ETH' as const };
    const probed: RobinhoodProbed = { block: head, at: new Date(now * 1000).toISOString(), name: 'Sample', symbol: 'SMPL', key: coin!.key, config: null, currentBuyFeePips: null,
      probeUsd: 1000, tips: {}, pons: null, lock: null, probe: null };
    // Without the mark (a probe that has not run yet) the verdict waits, as before.
    expect(judge(coin!, probed, { chain, hypeUsd: ETH_USD, nowSec: now, head }).verdict.level).toBe('pending');
    const a = judge(coin!, { ...probed, sellCheckUnavailable: 'token_quoted_pool' }, { chain, hypeUsd: ETH_USD, nowSec: now, head });
    expect(a.verdict.level).toBe('monitor');
    expect(a.verdict.playbooks.map(m => m.id)).toContain('malicious_hook');
    // The honeypot check still did not run, and the card says why rather than waiting.
    expect(a.verdict.evaluatedPlaybooks).not.toContain('honeypot');
    const summary = coinSummary(coin!, a, ctx), card = coinCard(coin!, a, ctx);
    expect(summary).toMatchObject({ verdict: 'monitor', verdictPending: false });
    expect(summary.sellCheck).toBeUndefined();
    expect(card.meta?.tradeability).toMatchObject({ unavailable: true, missing: ['exitCostPct'] });
    expect(card.meta?.tradeability?.flags).toContain('sell_check_not_available');
    // Danger findings still win (the TTWO coin's unbacked market cap).
    const t = track(ttwo), tl = t.coin!.trades.at(-1)!;
    expect(judge(t.coin!, { ...probed, key: t.coin!.key, block: tl.block, sellCheckUnavailable: 'token_quoted_pool' }, { chain: t.chain, hypeUsd: ETH_USD, nowSec: tl.ts + 5, head: tl.block }).verdict.level).toBe('danger');
  });

  it('never counts a burn address as a sniper, holder or trader (real USDG launch: a buy that also sent coins to 0x…dEaD)', () => {
    const { coin, chain } = track(usdg);
    const dead = '0x000000000000000000000000000000000000dead';
    // The launch transaction moved coins to 0x…dEaD: before the fix it was read as a third launch sniper.
    expect(coin!.flows.some(f => f.to === dead)).toBe(true);
    const snipers = findSnipers(coin!, chain.excluded(coin!), {}, chain.profile.sniperBlocks);
    expect(snipers.length).toBeGreaterThan(0);
    expect(snipers.map(s => s.wallet.toLowerCase()).filter(w => BURN_SINKS.includes(w))).toEqual([]);
    const stats = flowStats(coin!, { excluded: chain.excluded(coin!), hypeUsd: ETH_USD });
    const roles = [...stats.earlyBuyers.map(b => b.wallet), ...(stats.holders.largest ? [stats.holders.largest] : [])].map(w => w.toLowerCase());
    expect(roles.filter(w => BURN_SINKS.includes(w))).toEqual([]);
  });

  it('converts a swap by hand the same way (quotedSwapTrade)', () => {
    const s = swapsOf(ttwo)[0]!, { args } = decodeEventLog({ abi: swapAbi, topics: s.topics as [Hex, ...Hex[]], data: s.data });
    const t = quotedSwapTrade(false, { ...args, tx: s.transactionHash, block: 1, ts: 1 }, { decimals: 18, ethPer: 0.1 })!;
    expect(t.hype).toBeCloseTo(Math.abs(Number(args.amount0)) / 1e18 * 0.1, 12);
    expect(quotedSwapTrade(false, { ...args, amount0: 0n, tx: s.transactionHash, block: 1, ts: 1 }, { decimals: 18, ethPer: 0.1 })).toBeNull();
    expect(quotedSwapTrade(false, { ...args, tx: s.transactionHash, block: 1, ts: 1 }, { decimals: 18, ethPer: 0 })).toBeNull();
  });
});
