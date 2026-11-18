import { describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, getAddress, keccak256, parseAbi, toEventSelector, zeroAddress, type Address, type Hex } from 'viem';
import { loadRegistry, ponsCurveAbi, ponsFactoryAbi, v4PoolId } from '@eko/chain';
import launchFx from '../../../packages/chain/test/fixtures/4663/pons-launch.json' with { type: 'json' };
import curveFx from '../../../packages/chain/test/fixtures/4663/pons-curve-logs.json' with { type: 'json' };
import initFx from '../../../packages/chain/test/fixtures/4663/v4-initialize-donate-logs.json' with { type: 'json' };
import gradFx from './fixtures/robinhood/pons-graduation.json' with { type: 'json' };
import {
  applyRobinhoodEvent, curveProgressAt, curveProgressBps, curveProgressSeries, CURVE_BUY_TOPIC, CURVE_SELL_TOPIC, decodeRobinhoodLog, EthUsd,
  ethUsdFromSlot0, NO_POOL_ID, orderRobinhoodLogs, PONS_LOCK, PONS_TERMS, probeRobinhoodCoin, robinhoodAddresses, robinhoodExcluded,
  robinhoodLogQueries, TOKEN_LAUNCHED_TOPIC, INITIALIZE_TOPIC, type RawRobinhoodLog, type RobinhoodCoinState, type RobinhoodEvent,
} from '../src/chains/robinhood/index.js';
import type { Rpc } from '../src/tracker.js';

const addrs = robinhoodAddresses(loadRegistry());
const raw = (l: unknown) => l as RawRobinhoodLog;
const event = (sig: string) => toEventSelector((ponsFactoryAbi as readonly { type: string; name?: string }[]).concat(ponsCurveAbi as never).find(a => a.type === 'event' && a.name === sig) as never);

/** Decode and apply logs the way the tracker will: launches first, then chain order, with a curve → coin lookup. */
function replay(logs: RawRobinhoodLog[], ts = 1_790_000_000) {
  const coins = new Map<string, RobinhoodCoinState>(), curves = new Map<string, Address>();
  const events: RobinhoodEvent[] = [];
  for (const log of orderRobinhoodLogs(logs)) {
    const e = decodeRobinhoodLog(log, addrs, c => curves.get(c.toLowerCase()) ?? null);
    if (!e) continue;
    events.push(e);
    const token = e.kind === 'curve_trade' ? e.token! : e.token;
    const next = applyRobinhoodEvent(coins.get(token.toLowerCase()), e, { addrs, ts });
    if (!next) continue;
    coins.set(next.token.toLowerCase(), next);
    if (next.curve) curves.set(next.curve.address.toLowerCase(), next.token);
  }
  return { coins, events };
}

describe('Robinhood events', () => {
  it('uses the selectors of the verified Pons ABI', () => {
    expect(TOKEN_LAUNCHED_TOPIC).toBe(event('TokenLaunched'));
    expect(CURVE_BUY_TOPIC).toBe(event('CurveBuy'));
    expect(CURVE_SELL_TOPIC).toBe(event('CurveSell'));
    expect(TOKEN_LAUNCHED_TOPIC).toBe(launchFx.launch.topics[0]);
    const [trades, inits] = robinhoodLogQueries(addrs);
    expect(trades!.address).toBeUndefined();
    expect(inits).toMatchObject({ address: addrs.poolManager, topics: [INITIALIZE_TOPIC, null, `0x${'0'.repeat(64)}`] });
  });

  it('decodes a native launch with its curve, threshold and supply; skips token-quoted launches and other emitters', () => {
    const e = decodeRobinhoodLog(raw(launchFx.launch), addrs)!;
    expect(e).toMatchObject({ kind: 'launch', token: getAddress(launchFx.launch.args.token), creator: getAddress(launchFx.launch.args.deployer),
      curve: getAddress(launchFx.launch.args.curve), quote: zeroAddress, launchConfigId: 0n, supply: 10n ** 27n, graduationThreshold: 42n * 10n ** 17n,
      block: 77_438_503, logIndex: 11, ts: null, name: null, symbol: null });
    // The same event quoting USDG (pairToken word set) is not followed.
    const usdg = { ...launchFx.launch, data: `0x${addrs.usdg.slice(2).toLowerCase().padStart(64, '0')}${launchFx.launch.data.slice(66)}` };
    expect(decodeRobinhoodLog(raw(usdg), addrs)).toBeNull();
    expect(decodeRobinhoodLog(raw({ ...launchFx.launch, address: '0x00000000000000000000000000000000000000f1' }), addrs)).toBeNull();
  });

  it('decodes curve buys and sells, only on curves it knows, and ignores the curve’s other events', () => {
    const known = (c: Address) => c.toLowerCase() === curveFx.curve.toLowerCase() ? getAddress(curveFx.token) : null;
    const decoded = curveFx.logs.map(l => decodeRobinhoodLog(raw(l), addrs, known)).filter(Boolean) as RobinhoodEvent[];
    const trades = decoded.filter(e => e.kind === 'curve_trade');
    expect(decoded).toHaveLength(trades.length);
    expect(trades.filter(t => t.side === 'buy').length).toBeGreaterThan(5);
    expect(trades.some(t => t.side === 'sell')).toBe(true);
    for (const t of trades) expect(t).toMatchObject({ curve: getAddress(curveFx.curve), token: getAddress(curveFx.token), reserves: null });
    expect(curveFx.logs.map(l => decodeRobinhoodLog(raw(l), addrs, () => null)).filter(Boolean)).toHaveLength(0);
  });

  it('builds a launch-day coin from the launch transaction: supply, curve inventory and the creator’s first buy', () => {
    const { coins } = replay([raw(launchFx.launch), ...curveFx.logs.map(raw)]);
    const coin = coins.get(launchFx.launch.args.token.toLowerCase())!;
    expect(coin).toMatchObject({ launchpad: 'pons', key: null, poolId: NO_POOL_ID, supply: 10n ** 27n, supplyFromMints: false, graduated: false,
      launcher: addrs.factory, quote: zeroAddress, creator: getAddress(launchFx.launch.args.deployer) });
    const buys = coin.trades.filter(t => t.side === 'buy'), launchBuy = curveFx.logs.find(l => l.topics[0] === CURVE_BUY_TOPIC && l.transactionHash === launchFx.launch.transactionHash)!;
    expect(coin.firstBuyIn).toBe(BigInt(`0x${launchBuy.data.slice(2, 66)}`));
    expect(buys.length).toBeGreaterThan(0);
    expect(coin.curve!.realQuoteReserve).toBeGreaterThan(0n);
    expect(coin.curve!.realTokenReserve).toBeLessThan(PONS_TERMS.sellable(10n ** 27n));
    expect(curveProgressBps(coin.curve!)).toBeGreaterThan(0);
  });

  it('follows a captured coin from launch to graduation: reserves to the wei, then its v4 key from the Pons hook’s Initialize', () => {
    const logs = [gradFx.launch, ...gradFx.curveLogs, gradFx.initialize].map(raw);
    const { coins, events } = replay(logs);
    const coin = coins.get(gradFx.token)!;
    expect(events.filter(e => e.kind === 'curve_trade')).toHaveLength(61);
    expect(coin.trades).toHaveLength(61);
    // The curve hands the factory exactly this much at graduation (its own completion event in the fixture).
    const completed = gradFx.curveLogs.find(l => l.topics[0]!.startsWith('0xf8d37a90'))!;
    expect(coin.curve!.realQuoteReserve).toBe(BigInt(`0x${completed.data.slice(66, 130)}`));
    expect(coin.curve!.realQuoteReserve).toBe(4_200_000_000_000_000_006n);
    expect(coin.curve!.realTokenReserve).toBe(0n);
    expect(PONS_TERMS.supply - PONS_TERMS.sellable(PONS_TERMS.supply)).toBe(BigInt(`0x${completed.data.slice(130, 194)}`));
    expect(coin.graduated).toBe(true);
    expect(coin.poolId).toBe(gradFx.initialize.topics[1]);
    expect(coin.key).toEqual({ currency0: zeroAddress, currency1: getAddress(gradFx.token), fee: 0, tickSpacing: 200, hooks: addrs.hook });
    expect(v4PoolId(coin.key!)).toBe(coin.poolId);
    expect(coin.manager).toBe(addrs.poolManager);
    expect(curveProgressBps(coin.curve!, coin.graduated)).toBe(10_000);
    expect(coin.netHype).toBeGreaterThan(4);
    // Curve trades after graduation do not count; a second Initialize does not move the key.
    const after = applyRobinhoodEvent(coin, events.find(e => e.kind === 'curve_trade')!, { addrs, ts: 1 });
    expect(after).toBe(coin);
  });

  it('rejects an Initialize that is not a Pons graduation: other hooks, other managers, a key that does not hash to its id', () => {
    for (const l of initFx.logs.Initialize) expect(decodeRobinhoodLog(raw(l), addrs)).toBeNull();
    expect(decodeRobinhoodLog(raw({ ...gradFx.initialize, address: '0x00000000000000000000000000000000000000f1' }), addrs)).toBeNull();
    const wrongId = { ...gradFx.initialize, topics: [gradFx.initialize.topics[0], `0x${'11'.repeat(32)}`, ...gradFx.initialize.topics.slice(2)] };
    expect(decodeRobinhoodLog(raw(wrongId), addrs)).toBeNull();
    // A graduation of a coin launched before the window has nothing to apply to.
    expect(applyRobinhoodEvent(undefined, decodeRobinhoodLog(raw(gradFx.initialize), addrs)!, { addrs })).toBeUndefined();
  });

  it('lists the curve, Pons contracts, PoolManager and locker as non-holders', () => {
    const { coins } = replay([raw(gradFx.launch)]);
    const ex = robinhoodExcluded(coins.get(gradFx.token), addrs).map(a => a.toLowerCase());
    for (const a of [gradFx.curve, addrs.hook, addrs.poolManager, addrs.factory, PONS_LOCK.locker]) expect(ex).toContain(a.toLowerCase());
  });
});

describe('curve progress', () => {
  const T = 42n * 10n ** 17n;
  it('is the real quote reserve over the threshold, capped and floored', () => {
    expect(curveProgressBps({ realQuoteReserve: 0n, graduationThreshold: T })).toBe(0);
    expect(curveProgressBps({ realQuoteReserve: 21n * 10n ** 17n, graduationThreshold: T })).toBe(5000);
    expect(curveProgressBps({ realQuoteReserve: T + 6n, graduationThreshold: T })).toBe(10_000);
    expect(curveProgressBps({ realQuoteReserve: 1n, graduationThreshold: 0n })).toBeNull();
    expect(curveProgressBps({ realQuoteReserve: 0n, graduationThreshold: T }, true)).toBe(10_000);
  });
  it('nets fees and tax out of buys and into sells, and gives up on impossible history', () => {
    const e18 = 10n ** 18n;
    const points = curveProgressSeries([
      { kind: 'launch', block: 10, graduationThreshold: T },
      { kind: 'trade', block: 11, side: 'buy', native: 105n * e18 / 100n, fee: e18 / 100n, tax: 4n * e18 / 100n },   // +1.00
      { kind: 'trade', block: 12, side: 'sell', native: 45n * e18 / 100n, fee: e18 / 100n, tax: 4n * e18 / 100n },   // −0.50
      { kind: 'trade', block: 13, side: 'sell', native: e18, fee: 0n, tax: 0n },                                       // below zero
      { kind: 'trade', block: 14, side: 'buy', native: e18, fee: 0n, tax: 0n },
    ], 10);
    expect(points.map(p => p.bps)).toEqual([0, 2380, 1190, undefined, undefined]);
    expect(curveProgressAt(points, 12)).toBe(1190);
    expect(curveProgressAt(points, 9)).toBeUndefined();
    // A launch seen at another block than the coin's gives no threshold.
    expect(curveProgressSeries([{ kind: 'launch', block: 9, graduationThreshold: T }], 10)[0]!.bps).toBeUndefined();
  });
});

describe('EthUsd', () => {
  const pool = { address: '0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca' as Address, wethIsToken0: true, wethDecimals: 18, usdgDecimals: 6 };
  const slot0 = (usd: number) => encodeAbiParameters([{ type: 'uint160' }, { type: 'int24' }], [BigInt(Math.round(Math.sqrt(usd / 1e12) * 2 ** 96)), 0]);
  const setup = (hl: () => number | Error, chain: () => number | Error) => {
    let t = 1_000_000;
    const fetcher = vi.fn(async () => { const v = hl(); if (v instanceof Error) throw v; return new Response(JSON.stringify({ ETH: String(v), BTC: '90000' })); });
    const rpc: Rpc = { request: vi.fn(async ({ method, params }) => {
      expect(method).toBe('eth_call'); expect((params[0] as { to: string }).to).toBe(pool.address);
      const v = chain(); if (v instanceof Error) throw v; return slot0(v);
    }) };
    const p = new EthUsd({ fetcher: fetcher as unknown as typeof fetch, rpc, pool, ttlMs: 30_000, now: () => t });
    return { p, advance: (ms: number) => { t += ms; } };
  };
  it('reads the WETH/USDG slot0 as USD per ETH', () => {
    expect(ethUsdFromSlot0(BigInt(Math.round(Math.sqrt(1800 / 1e12) * 2 ** 96)), true, 18, 6)).toBeCloseTo(1800, 6);
    expect(() => ethUsdFromSlot0(0n, true, 18, 6)).toThrow();
  });
  it('accepts Hyperliquid’s ETH when the pool agrees within 2%', async () => {
    const { p } = setup(() => 1800.65, () => 1798.94);
    expect(await p.get()).toBe(1800.65);
    expect(p.latest).toBe(1800.65);
  });
  it('refuses a price the pool disagrees with by more than 2%, keeping the last accepted one', async () => {
    let hl = 1800, chain = 1790;
    const { p, advance } = setup(() => hl, () => chain);
    expect(await p.get()).toBe(1800);
    hl = 1900; advance(31_000);
    expect(await p.get()).toBe(1800);
    expect(p.lastRefusal).toMatchObject({ hyperliquid: 1900, pool: 1790 });
    // Never accepted: stays null.
    const fresh = setup(() => 2000, () => 1900);
    expect(await fresh.p.get()).toBeNull();
    expect(fresh.p.lastRefusal).not.toBeNull();
  });
  it('keeps the last value when either source fails, and needs both', async () => {
    let fail: 'hl' | 'chain' | null = null;
    const { p, advance } = setup(() => fail === 'hl' ? new Error('down') : 1800, () => fail === 'chain' ? new Error('429') : 1801);
    expect(await p.get()).toBe(1800);
    fail = 'chain'; advance(31_000);
    expect(await p.get()).toBe(1800);
    const lone = setup(() => 1800, () => new Error('429'));
    expect(await lone.p.get()).toBeNull();
  });
});

describe('probeRobinhoodCoin', () => {
  const multicallAbi = parseAbi(['struct Call3 { address target; bool allowFailure; bytes callData; }', 'function aggregate3(Call3[] calls) payable returns ((bool success, bytes returnData)[])']);
  const word = (v: bigint | boolean | string) => encodeAbiParameters([{ type: typeof v === 'string' ? 'address' : typeof v === 'boolean' ? 'bool' : 'uint256' }], [v as never]);
  const str = (s: string) => encodeAbiParameters([{ type: 'string' }], [s]);
  const code = '0x6080604052' as Hex;
  /** A chain with one native curve and, after graduation, a locked Pons pool: answers by function selector. */
  function chain(coin: RobinhoodCoinState, over: Record<string, Hex> = {}) {
    const sel = (sig: string) => keccak256(new TextEncoder().encode(sig)).slice(0, 10);
    const answers: Record<string, Hex> = {
      [sel('name()')]: str('Sample coin'), [sel('symbol()')]: str('SMPL'),
      [sel('creatorTaxBps()')]: word(400n), [sel('feeBps()')]: word(100n), [sel('currentSnipeTaxBps(address)')]: word(0n),
      [sel('realQuoteReserve()')]: word(38_762_000_000_000_000n), [sel('sellableTokens()')]: word(691_733_435_377_988_841_470_114_621n),
      [sel('graduated()')]: word(false), [sel('readyToGraduate()')]: word(false), [sel('token()')]: word(coin.token), [sel('pairToken()')]: word(zeroAddress),
      [sel('factory()')]: word(addrs.factory), [sel('launchedAt()')]: word(1_790_000_000n), [sel('snipeTaxSeconds()')]: word(3n),
      [sel('locker()')]: word(PONS_LOCK.locker), [sel('positionManager()')]: word(PONS_LOCK.positionManager), [sel('memeHook()')]: word(addrs.hook),
      [sel('lockedPositions(address)')]: word(4_304_534n), [sel('poolManager()')]: word(addrs.poolManager), [sel('ownerOf(uint256)')]: word(PONS_LOCK.locker),
      [sel('getApproved(uint256)')]: word(zeroAddress), [sel('getPositionLiquidity(uint256)')]: word(10n ** 20n),
      [sel('getPoolAndPositionInfo(uint256)')]: coin.key ? encodeAbiParameters([{ type: 'tuple', components: [{ name: 'c0', type: 'address' }, { name: 'c1', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'ts', type: 'int24' }, { name: 'hooks', type: 'address' }] }, { type: 'uint256' }],
        [{ c0: coin.key.currency0, c1: coin.key.currency1, fee: coin.key.fee, ts: coin.key.tickSpacing, hooks: coin.key.hooks }, 0n]) : '0x',
      ...over,
    };
    const routes: string[] = [];
    const rpc: Rpc = { request: async ({ method, params }) => {
      if (method === 'eth_getCode') return code;
      const [tx, , overrides] = params as [{ to: Address; data: Hex }, string, Record<string, unknown> | undefined];
      if (overrides) {
        routes.push(tx.to);
        // The probe contract's round trip: tokens, quotedSell, returned, spent, buyOk, sellOk, err.
        return encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bool' }, { type: 'bool' }, { type: 'bytes' }],
          [10n ** 24n, 0n, 9n * 10n ** 16n, 10n ** 17n, true, true, '0x']);
      }
      expect(tx.to).toBe(addrs.multicall3);
      const { args: [calls] } = decodeFunctionData({ abi: multicallAbi, data: tx.data });
      return encodeFunctionResult({ abi: multicallAbi, functionName: 'aggregate3', result: calls.map(c => { const a = answers[c.callData.slice(0, 10)];
        return { success: a !== undefined && a !== '0x', returnData: a ?? '0x' }; }) });
    } };
    return { rpc, routes };
  }
  const launched = () => replay([raw(gradFx.launch)]).coins.get(gradFx.token)!;
  const graduated = () => replay([gradFx.launch, ...gradFx.curveLogs, gradFx.initialize].map(raw)).coins.get(gradFx.token)!;

  it('reads the curve’s terms through readPonsProfile and probes the curve before graduation', async () => {
    const coin = launched(), { rpc } = chain(coin);
    const p = await probeRobinhoodCoin(coin, 116_000_000n, { rpc, addrs, ethUsd: () => 2000, now: () => 1_790_000_100_000 });
    expect(p).toMatchObject({ name: 'Sample coin', symbol: 'SMPL', key: null, config: null, probeUsd: 1000, taxPct: { buy: 5, sell: 5 }, lock: null,
      pons: { feePct: 1, creatorTaxPct: 4, antiSnipe: null, realQuoteReserve: 38_762_000_000_000_000n, graduated: false, tokenCodeHash: keccak256(code) } });
    expect(p.probe).toMatchObject({ venue: 'pons_curve', routeId: `pons_curve:${gradFx.curve}`, status: 'sellable', sizeWei: String(5n * 10n ** 17n) });
  });

  it('reports a live anti-snipe tax, and does not probe a curve that is not this coin’s', async () => {
    const coin = launched();
    const snipe = await probeRobinhoodCoin(coin, 1n, { rpc: chain(coin, { [keccak256(new TextEncoder().encode('currentSnipeTaxBps(address)')).slice(0, 10)]: word(9900n) }).rpc,
      addrs, ethUsd: () => null, now: () => 1_790_000_001_000 });
    expect(snipe.pons!.antiSnipe).toEqual({ taxPct: 99, endsInSec: 2 });
    expect(snipe.probe!.sizeWei).toBe(String(25n * 10n ** 16n));
    const other = await probeRobinhoodCoin(coin, 1n, { rpc: chain(coin, { [keccak256(new TextEncoder().encode('factory()')).slice(0, 10)]: word(addrs.router) }).rpc, addrs, ethUsd: () => 2000 });
    expect(other.pons).toBeNull();
    expect(other.probe).toBeNull();
  });

  it('probes the Pons pool after graduation and proves its lock against the pinned code hashes', async () => {
    const coin = graduated(), { rpc } = chain(coin);
    const pins = { locker: keccak256(code), positionManager: keccak256(code) };
    const p = await probeRobinhoodCoin(coin, 116_000_000n, { rpc, addrs, ethUsd: () => 2000, pins });
    expect(p.key).toEqual(coin.key);
    expect(p.pons).toBeNull();
    expect(p.taxPct).toBeUndefined();
    expect(p.probe).toMatchObject({ venue: 'uniswap_v4', routeId: `uniswap_v4:${coin.poolId}` });
    expect(p.lock).toEqual({ locked: true, tokenId: 4_304_534n, liquidity: 10n ** 20n, locker: PONS_LOCK.locker });
    // The reviewed hashes, not whatever code is there: an unreviewed locker is not a lock.
    const unpinned = await probeRobinhoodCoin(coin, 116_000_000n, { rpc, addrs, ethUsd: () => 2000 });
    expect(unpinned.lock!.locked).toBe(false);
  });
});

describe('Robinhood restart rebase', () => {
  it('resets a restored curve coin to the curve\'s own reserves at the replay block, and leaves graduated or newer coins', async () => {
    const { robinhoodChain } = await import('../src/chains/robinhood/index.js');
    const curve = (n: number) => `0x${String(n).repeat(40)}` as Address;
    const coin = (n: number, extra: object) => ({ token: curve(n), block: 100, graduated: false, curve: { address: curve(n), graduationThreshold: 10n, realQuoteReserve: 999n, realTokenReserve: 999n }, ...extra });
    const coins = [coin(1, {}), coin(2, { graduated: true }), coin(3, { block: 600 })];
    const calls: unknown[] = [];
    const rpc: Rpc = { request: async ({ params }) => { calls.push(params); const [{ data }, at] = params as [{ data: Hex }, Hex];
      expect(at).toBe('0x1f4'); return data.startsWith('0x') && data.length === 10 && calls.length % 2 ? '0x2a' : '0x07'; } };
    await robinhoodChain().rebase!(coins as never, 500n, rpc);
    expect(calls).toHaveLength(2);
    expect([coins[0]!.curve.realQuoteReserve, coins[0]!.curve.realTokenReserve].sort()).toEqual([7n, 42n].sort());
    expect(coins[1]!.curve.realQuoteReserve).toBe(999n);
    expect(coins[2]!.curve.realQuoteReserve).toBe(999n);
  });
});


describe('Robinhood run-up and snipers', () => {
  const supply = 10n ** 27n, e18 = 10n ** 18n;
  const base = { token: '0x1111111111111111111111111111111111111111' as Address, creator: '0x2222222222222222222222222222222222222222' as Address, block: 1000, ts: 10_000, supply, graduated: false };
  it('measures supply bought out of the curve in all (from its token reserve) and net in the last hour', async () => {
    const { curveRunUp } = await import('../src/chains/robinhood/index.js');
    // 5/7 of supply is sold on the curve; 300M tokens (30% of supply) have left it.
    const sellable = supply - supply * 2n / 7n;
    const coin = { ...base, curve: { address: '0x3333333333333333333333333333333333333333' as Address, graduationThreshold: 42n * e18 / 10n, realQuoteReserve: 0n, realTokenReserve: sellable - 300_000_000n * e18 },
      trades: [{ ts: 10_000, side: 'buy', tokens: 200_000_000 }, { ts: 13_700, side: 'buy', tokens: 150_000_000 }, { ts: 13_800, side: 'sell', tokens: 50_000_000 }] };
    const r = curveRunUp(coin as never, 14_000);
    expect(r.outShare).toBeCloseTo(0.30, 6);
    expect(r.hourShare).toBeCloseTo(0.10, 6);
    expect(r.ageSec).toBe(4000);
    expect(r.evidence[0]!.ref).toBe(coin.curve.address);
  });
  it('gives the run_up playbook a Monitor at 30% out and a Danger at 30% in an hour (config v1)', async () => {
    const { evaluatePlaybooks, CONFIG_V1 } = await import('@eko/playbooks');
    const run = (outShare: number, hourShare: number) => evaluatePlaybooks({ coin: base.token, deployer: base.creator, asOfBlock: 1, asOfSec: 1, createdAtSec: 0, createdAtBlock: 0, launchpad: 'pons',
      name: 'Sample', symbol: 'SMPL', runUp: { outShare, hourShare, ageSec: 600, evidence: [] }, history: { launches: [] } } as never, CONFIG_V1).find(m => m.id === 'run_up')?.level ?? null;
    expect(run(0.05, 0.05)).toBeNull();
    expect(run(0.31, 0.10)).toBe('monitor');
    expect(run(0.35, 0.31)).toBe('danger');
  });
  it('counts buyers in the first 35 blocks as launch snipers on Robinhood (Pons\'s anti-snipe tax ends at 3 s)', async () => {
    const { findSnipers } = await import('../src/snipers.js');
    const { ROBINHOOD_PROFILE } = await import('../src/chains/profiles.js');
    expect(ROBINHOOD_PROFILE.sniperBlocks).toBe(35);
    const bot = '0x4444444444444444444444444444444444444444', curve = '0x3333333333333333333333333333333333333333', tx = `0x${'ab'.repeat(32)}` as Hex;
    const coin = { ...base, trades: [{ ts: 10_003, block: 1032, tx, side: 'buy', hype: 0.1, tokens: 1, priceHype: 0.1 }],
      flows: [{ tx, block: 1032, ts: 10_003, from: curve, to: bot, value: 50_000_000n * e18 }] };
    expect(findSnipers(coin as never, [curve as Address])).toEqual([]);
    const s = findSnipers(coin as never, [curve as Address], {}, ROBINHOOD_PROFILE.sniperBlocks);
    expect(s).toHaveLength(1);
    expect(s[0]!.boughtShare).toBeCloseTo(0.05, 6);
  });
});

describe('Robinhood graduates at start-up', () => {
  it('finds a Pons graduation in the window and fetches that coin\'s launch, curve trades, transfers and pool swaps', async () => {
    const { robinhoodChain } = await import('../src/chains/robinhood/index.js');
    const fx = gradFx as unknown as { token: Address; curve: Address; launchBlock: number; graduationBlock: number; launch: RawFx; curveLogs: RawFx[]; initialize: RawFx };
    const from = BigInt(fx.launchBlock) - 10n, to = BigInt(fx.graduationBlock) + 10n;
    const asks: { address?: string; topics: unknown[] }[] = [];
    const rpc: Rpc = { request: async ({ method, params }) => {
      expect(method).toBe('eth_getLogs');
      const f = (params as [{ address?: string; topics: (string | string[] | null)[] }])[0]; asks.push(f);
      const addr = f.address?.toLowerCase();
      if (f.topics[0] === fx.initialize.topics[0]) return [fx.initialize];
      if (addr === fx.curve.toLowerCase()) return fx.curveLogs;
      if (f.topics[0] === fx.launch.topics[0]) return [fx.launch];
      return [];
    } };
    const logs = await robinhoodChain().graduates!(rpc, from, to, () => false);
    expect(logs[0]).toBe(fx.launch);
    expect(logs).toContain(fx.initialize);
    expect(logs.length).toBe(2 + fx.curveLogs.length);
    // The coin's own transfers and its pool's swaps were asked for.
    expect(asks.some(a => a.address?.toLowerCase() === fx.token.toLowerCase())).toBe(true);
    expect(asks.some(a => (a.topics as string[])[1] === fx.initialize.topics[1])).toBe(true);
    // A coin already tracked is skipped.
    expect(await robinhoodChain().graduates!(rpc, from, to, () => true)).toEqual([]);
  });
});
type RawFx = { address: string; topics: Hex[]; data: Hex; blockNumber: Hex; transactionHash: Hex; logIndex: Hex };

describe('Robinhood coverage: old-launch graduates, live misses, warm start', () => {
  it('finds a launch older than the window from the block the token first had code', async () => {
    const { deployBlock } = await import('../src/chains/robinhood/index.js');
    let calls = 0;
    const rpc: Rpc = { request: async ({ method, params }) => { calls++; expect(method).toBe('eth_getCode'); return BigInt((params as string[])[1]!) >= 12_345n ? '0x60' : '0x'; } };
    expect(await deployBlock(rpc, '0x1111111111111111111111111111111111111111', 1_000_000n)).toBe(12_345n);
    expect(calls).toBeLessThan(25);
    expect(await deployBlock({ request: async () => '0x' }, '0x1111111111111111111111111111111111111111', 10n)).toBeNull();
  });
  it('queues a live graduation of a coin it does not follow and fetches its history on the next tick', async () => {
    const { robinhoodChain } = await import('../src/chains/robinhood/index.js');
    const fx = gradFx as unknown as { token: Address; curve: Address; launch: RawFx; curveLogs: RawFx[]; initialize: RawFx };
    const chain = robinhoodChain();
    const t = { coin: () => undefined, coinByPool: () => undefined } as never;
    chain.apply(fx.initialize as never, 1, t);
    const rpc: Rpc = { request: async ({ params }) => { const f = (params as [{ address?: string; topics: unknown[] }])[0];
      if (f.topics[0] === fx.launch.topics[0]) return [fx.launch];
      if (f.address?.toLowerCase() === fx.curve.toLowerCase()) return fx.curveLogs;
      return []; } };
    const logs = await chain.missing!(rpc, BigInt(fx.initialize.blockNumber) + 10n, () => false);
    expect(logs[0]).toBe(fx.launch);
    expect(logs).toContain(fx.initialize);
    expect(await chain.missing!(rpc, BigInt(fx.initialize.blockNumber) + 10n, () => false)).toEqual([]);
  });
  it('skips the whole-window launch rebuild when asked to (a healthy snapshot)', async () => {
    const { robinhoodChain } = await import('../src/chains/robinhood/index.js');
    const asks: unknown[] = [];
    const rpc: Rpc = { request: async ({ params }) => { asks.push((params as [{ topics: unknown[] }])[0].topics[0]); return []; } };
    await robinhoodChain().graduates!(rpc, 1n, 50_000n, () => false, { coins: false });
    expect(asks.some(t => Array.isArray(t))).toBe(false);
    await robinhoodChain().graduates!(rpc, 1n, 50_000n, () => false);
    expect(asks.some(t => Array.isArray(t))).toBe(true);
  });
});
