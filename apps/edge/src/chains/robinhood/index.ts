import { getAddress, toFunctionSelector, zeroAddress, type Address, type Hex } from 'viem';
import { balanceSlot, loadRegistry, v4PoolId, type AddressRegistry, type BalanceSlot } from '@eko/chain';
import type { CoinState, RawLog, Rpc } from '../../tracker.js';
import { SWAP_TOPIC, TRANSFER_TOPIC } from '../logs.js';
import { ROBINHOOD_PROFILE } from '../profiles.js';
import { robinhoodVenue } from '../robinhood-venue.js';
import type { ChainAdapter, JudgeFacts } from '../types.js';
import { robinhoodAddresses, type RobinhoodAddresses } from './addresses.js';
import { applyRobinhoodEvent, CURVE_BUY_TOPIC, CURVE_SELL_TOPIC, decodeRobinhoodLog, INITIALIZE_TOPIC, isRobinhoodLaunch, LONG_CREATE_TOPIC, NATIVE_TOPIC, PANGEA_POOL_TOPIC, pangeaPoolKey, quotedSwapTrade, robinhoodLogQueries, TOKEN_LAUNCHED_TOPIC, type DecodeOptions, type RobinhoodCoinState } from './events.js';
import { EthUsd, QuotePrices } from './price.js';
import type { NativeUsd } from '../../hype.js';
import { probeRobinhoodCoin, robinhoodExcluded, type RobinhoodProbed } from './probe.js';
import { LONGXYZ, PONS_LOCK, PONS_TERMS } from './profile.js';
import { loadRobinhoodTradeAddresses, ponsPoolKey } from './trade.js';

/**
 * Robinhood Chain (4663) read modules for the edge: Pons launches, curve trades and graduation from logs (events.ts),
 * curve progress (progress.ts), ETH in USD (price.ts), the live check's chain reads (probe.ts) and the chain's measured
 * constants (profile.ts). Pure or dependency-injected; robinhoodChain below wires them into the tracker and the checks.
 */
export * from './addresses.js';
export * from './events.js';
export * from './price.js';
export * from './probe.js';
export * from './profile.js';
export * from './progress.js';

/**
 * Pons' launch snipe tax by whole second since `launchedAt` (the launch block's timestamp), for launch config 0: 9,900,
 * 618 and 19 bps, then nothing from 3 s (read block by block on every sampled launch: docs/robinhood/CHAIN-FACTS.md §3).
 */
/** The Pons hook's event on every swap through a Pons pool (topic 1: the pool id), read on chain 2026-11-18. */
export const PONS_HOOK_SWAP_TOPIC = '0xc532c43b3423e14ef72748f1c8291238829ca0af8ba9b67975ad1483485a4b4d' as Hex;
/**
 * long.xyz's (Doppler) hook's event on every swap through its pools, whatever they are quoted in (topic 1: the swapper;
 * topics 2 and 3: the pool id). Read on chain 2026-11-18: one per swap, 135 of 135 PoolManager swaps on its pools in
 * 3,000 blocks, in the same transactions; about 33,000 a day.
 */
export const LONG_HOOK_SWAP_TOPIC = '0x1d9f7b5e406d8c887155e1a78e070d2d41c5d0444dab8b21612f846835c27183' as Hex;
/** Pangea's hook's event on nearly every swap through its pools (topic 1: the pool id): 94 of 97 swaps read 2026-11-18. */
export const PANGEA_HOOK_SWAP_TOPIC = '0x7edb776720525c439f21754273aa041d1d10d0df5bb888af96f08ce359b373cb' as Hex;
/** Tick spacings long.xyz's pools have been opened with (8 and 200 seen; the others are Uniswap's usual ones), for
 *  rebuilding a pool's key from its id (its fee is always the dynamic-fee flag and its hook long.xyz's). */
const LONG_TICK_SPACINGS = [8, 200, 1, 10, 60, 100] as const;
/** How many coins one round of `active` adds, at most: each first lookup reads the coin's whole history. */
export const ACTIVE_PER_ROUND = 12;
/**
 * The logs one round of `active` may read for histories, estimated before each coin (its swaps in the last 24 hours, four
 * logs each with its transfers, times its age in days): a coin that would take the round over waits for a later round,
 * and one estimated over ACTIVE_COIN_LOG_LIMIT is not read at all. Memory does not grow with a history (it is read page
 * by page into capped state); these bound the RPC calls and the time. The estimate is rough both ways (measured
 * 2026-11-18: DacityCoin estimated 5.0 million, read 146,306; AI estimated 74,024, read 10,986,981 in about 20 minutes,
 * peak heap 335 MB): the hard stop is what bounds a pathological history.
 */
export const ACTIVE_ROUND_LOG_BUDGET = 12_000_000;
/** A single history read stops (the coin is dropped and logged) past this many logs, whatever was estimated. */
export const ACTIVE_COIN_LOG_LIMIT = 12_000_000;
/** Blocks in a day at Robinhood Chain's ~0.102 s blocks. */
const DAY_BLOCKS = 847_000n;
/** A history log with no estimate to go by: swaps and the transfers in their transactions. */
const LOGS_PER_SWAP = 4;
const REAL_QUOTE_RESERVE = toFunctionSelector('realQuoteReserve()'), SELLABLE_TOKENS = toFunctionSelector('sellableTokens()');
/**
 * Run-up (playbook run_up, calibrated on Pons in config v1): the share of supply bought out of the launch curve net of
 * sells, in all (from the curve's own token reserve: what is left of the 5/7 it sells) and in the last hour (net curve
 * trades). The old Robinhood engines measured it the same way, from every curve trade.
 */
export function curveRunUp(coin: CoinState & { curve: NonNullable<CoinState['curve']> }, nowSec: number) {
  const supply = Number(coin.supply) / 1e18;
  const out = Number(PONS_TERMS.sellable(coin.supply) - coin.curve.realTokenReserve) / 1e18;
  const hour = coin.trades.filter(t => t.ts > nowSec - 3600).reduce((n, t) => n + (t.side === "buy" ? 1 : -1) * t.tokens, 0);
  return { outShare: Math.max(0, out) / supply, hourShare: Math.max(0, hour) / supply, ageSec: Math.max(0, nowSec - coin.ts),
    evidence: [{ kind: 'address' as const, ref: coin.curve.address, label: 'Launch curve' }] };
}
/**
 * What backs a pool-launched coin's price (playbook fake_mcap), in native currency. EKO follows the pool from its launch
 * transaction, so the ETH in it is what the launch put in (the unbranded launcher's seed; none for Pangea and long.xyz,
 * whose pools open with only the coin in them) plus what buyers paid in on net, less the share of the launch position
 * taken out since. Price × supply can be set at any level with nothing behind it.
 */
export function poolBacking(coin: CoinState, nowSec: number) {
  const price = coin.trades.at(-1)?.priceHype ?? coin.openPrice ?? 0;
  let volume24h = 0;
  for (let i = coin.trades.length - 1; i >= 0 && coin.trades[i]!.ts > nowSec - 86_400; i--) volume24h += coin.trades[i]!.hype;
  const p = coin.launchPosition, left = p && p.liquidity > 0n ? 1 - Math.min(1, Number(p.removed) / Number(p.liquidity)) : 1;
  const paidIn = (Number(p?.seed ?? 0n) / 1e18 + Math.max(0, coin.netHype)) * left;
  const label = p ? 'Pool (seeded with ETH at launch; launch position held by the creator)' : 'Pool (opened with only the coin in it)';
  return { mcap: price * Number(coin.supply) / 1e18, paidIn, volume24h, evidence: [{ kind: 'address' as const, ref: coin.poolId, label }] };
}
/** EKO's memory on Robinhood Chain in blocks: 25 hours (the tracker's keepSec) at ~0.102 s blocks. */
export const ROBINHOOD_KEEP_BLOCKS = 882_000n;

/**
 * eth_getLogs over any span: dRPC takes at most 100,000 blocks per call on Robinhood Chain, so longer spans are asked in
 * pieces that size, and a piece over the 10,000-log cap is halved until it fits.
 */
const RATE_LIMITED = /quota|rate.?limit|too many requests|429/i;
export function logsVia(rpc: Rpc) {
  const getLogs = async (filter: { address?: Address | Address[]; topics: (Hex | Hex[] | null)[] }, a: bigint, b: bigint): Promise<RawLog[]> => {
    if (b < a) return [];
    if (b - a >= 100_000n) {
      // Four pieces at a time (in order in the result): a month of a coin's transfers is ~260 pieces.
      const spans: [bigint, bigint][] = [];
      for (let x = a; x <= b; x += 100_000n) spans.push([x, x + 99_999n < b ? x + 99_999n : b]);
      const out: RawLog[][] = new Array(spans.length);
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(4, spans.length) }, async () => { while (next < spans.length) { const i = next++; out[i] = await getLogs(filter, spans[i]![0], spans[i]![1]); } }));
      return out.flat();
    }
    for (let attempt = 0; ; attempt++) {
      try { return await rpc.request({ method: 'eth_getLogs', params: [{ ...filter, fromBlock: `0x${a.toString(16)}`, toBlock: `0x${b.toString(16)}` }] }) as RawLog[]; }
      catch (error) {
        // A rate limit says nothing about the span: wait and ask again (halving on it multiplied the calls and failed).
        if (RATE_LIMITED.test(String((error as Error).message)) && attempt < 6) { await new Promise(r => setTimeout(r, 500 * 2 ** attempt)); continue; }
        if (b - a < 200n) throw error;
        const mid = (a + b) / 2n;
        return [...await getLogs(filter, a, mid), ...await getLogs(filter, mid + 1n, b)];
      }
    }
  };
  return getLogs;
}

/** The first log matching `filter` in [a, b]: 100,000-block pages read forward four at a time, stopping at the first
 *  page with a hit (a coin's graduation usually comes days after its launch, not months). */
export async function firstLog(rpc: Rpc, filter: { address?: Address | Address[]; topics: (Hex | Hex[] | null)[] }, a: bigint, b: bigint): Promise<RawLog | null> {
  const getLogs = logsVia(rpc);
  for (let x = a; x <= b; x += 400_000n) {
    const pages: Promise<RawLog[]>[] = [];
    for (let y = x; y < x + 400_000n && y <= b; y += 100_000n) pages.push(getLogs(filter, y, y + 99_999n < b ? y + 99_999n : b));
    for (const page of await Promise.all(pages)) if (page[0]) return page[0];
  }
  return null;
}

/**
 * The logs matching `filter` in [a, b], one 100,000-block page at a time in chain order, with at most `ahead` pages read
 * ahead: a long history is never held whole (an old coin's transfers are millions of logs).
 */
export async function* pagesOf(rpc: Rpc, filter: { address?: Address | Address[]; topics: (Hex | Hex[] | null)[] }, a: bigint, b: bigint, ahead = 2): AsyncGenerator<RawLog[]> {
  const getLogs = logsVia(rpc), pending: Promise<RawLog[]>[] = [];
  let x = a;
  const fill = () => {
    while (pending.length < ahead && x <= b) {
      const y = x + 99_999n < b ? x + 99_999n : b, page = getLogs(filter, x, y);
      // Awaited in order below; a page left behind when the reader stops must not surface as an unhandled rejection.
      page.catch(() => {});
      pending.push(page); x = y + 1n;
    }
  };
  fill();
  while (pending.length) { const page = await pending.shift()!; fill(); yield page; }
}

/** The first block at which `token` has code (a binary search over archive state), or null when it has none at `hi`. */
export async function deployBlock(rpc: Rpc, token: Address, hi: bigint): Promise<bigint | null> {
  const has = async (b: bigint) => (await rpc.request({ method: 'eth_getCode', params: [token, `0x${b.toString(16)}`] }) as string).length > 2;
  if (!await has(hi)) return null;
  let lo = 0n;
  while (lo < hi) { const mid = (lo + hi) / 2n; if (await has(mid)) hi = mid; else lo = mid + 1n; }
  return lo;
}

export const PONS_SNIPE_BPS = [9_900, 618, 19] as const;
export const PONS_SNIPE_SEC = PONS_SNIPE_BPS.length;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
/** Uniswap v4's LPFeeLibrary.DYNAMIC_FEE_FLAG: the pool's fee is set by its hook, not its key. */
const DYNAMIC_FEE_FLAG = 0x800000;
const rh = (coin: CoinState) => coin as unknown as RobinhoodCoinState;
/** The hooked pool launchpads `active` looks through (flag more_launchpads), besides Pons. */
type PoolHook = 'longxyz' | 'pangea';
/** A busy pool resolved to its coin: how its swaps read in ETH (the quote, its decimals, which side is the coin). */
type Candidate = { via: 'pons'; token: Address } | { via: PoolHook; token: Address; quote: Address; coinIs0: boolean; decimals: number };

export interface RobinhoodChainOptions {
  /**
   * Flag more_launchpads: also follow long.xyz launches quoted in a token EKO can price on chain (WETH, USDG, Robinhood
   * stock tokens: price.ts QuotePrices), their swaps counted in ETH at that price. Off, the adapter is exactly as before.
   */
  moreLaunchpads?: boolean;
  /** The quote prices to use (tests); by default built with the ETH price in `price(rpc)`. */
  quotes?: QuotePrices;
  /** The logs `active` may read for histories per round and per coin (tests); ACTIVE_ROUND_LOG_BUDGET and
   *  ACTIVE_COIN_LOG_LIMIT by default. */
  historyLogs?: { round?: number; coin?: number };
}

/**
 * Robinhood Chain: native ETH, Pons coins on their own bonding curve (native-ETH curves only; USDG- and token-quoted
 * launches are skipped) and, after graduation, in a Uniswap v4 pool with the Pons hook, where the tracker's v4 Swap path
 * takes over. Pangea, long.xyz and unbranded-launcher coins (native-ETH pools; with more_launchpads, long.xyz's priced
 * token-quoted pools too) trade in their v4 pool from launch, on the same Swap path. Checks run at the head (the public
 * RPC keeps about ten minutes of state).
 */
export function robinhoodChain(registry: AddressRegistry = loadRegistry(), options: RobinhoodChainOptions = {}): ChainAdapter {
  const addrs: RobinhoodAddresses = robinhoodAddresses(registry), trade = loadRobinhoodTradeAddresses();
  const decodeOpts: DecodeOptions = options.moreLaunchpads ? { quotedPools: true } : {};
  // Set by `price(rpc)` (the edge builds it before the tracker starts) or by the caller.
  let quotes: QuotePrices | null = options.moreLaunchpads ? options.quotes ?? null : null;
  /** Where each quote token keeps balances, for the sell check on pools quoted in it (null: none found). */
  const balanceSlots = new Map<string, BalanceSlot | null>();
  const quoteOf = (token: Address) => {
    const q = quotes?.asset(token) ?? null;
    // A numeraire not checked yet is queued: the next price refresh checks it (a launch in it is not followed until then).
    if (!q && quotes && !quotes.isRejected(token)) quotes.want(token);
    return q;
  };
  // Graduations seen live for coins not followed, drained by `missing` on the next tick.
  const pendingGraduates: { init: RawLog & { seenAt?: number }; token: Address; poolId: Hex }[] = [];
  const topic = (a: Address) => `0x${a.slice(2).toLowerCase().padStart(64, '0')}` as Hex;
  // Busy pools EKO cannot follow (a Pons pool in USDG or a token, a long.xyz pool quoted in a coin EKO cannot price, a
  // key not rebuilt): not resolved again (active).
  const notNative = new Set<string>();
  // Busy pools already resolved to their coin: not asked for a receipt again (each round re-ranks them by volume).
  const resolved = new Map<string, Candidate>();

  /** A busy Pons-hook pool's coin: the token in the swap whose native-ETH Pons pool it is, or 'skip'. */
  const ponsCandidate = (id: string, tokens: Address[]): Candidate | 'skip' => {
    const token = tokens.find(t => v4PoolId(ponsPoolKey(t, addrs.hook)).toLowerCase() === id);
    return token ? { via: 'pons', token } : 'skip';
  };
  /**
   * A busy long.xyz or Pangea pool's coin, from the currencies one of its swaps moved: the pool key (rebuilt, its id must
   * match) and which side is the coin. A long.xyz pool is quoted in native ETH or in a token EKO prices (WETH, USDG, a
   * stock token: price.ts); one quoted in a token not checked yet waits for the next round (null) while it is checked.
   */
  const poolCandidate = (id: string, tokens: Address[], via: PoolHook): Candidate | 'skip' | null => {
    if (via === 'pangea') {
      const token = tokens.find(t => v4PoolId(pangeaPoolKey(t, addrs.pangeaHook)).toLowerCase() === id);
      return token ? { via, token, quote: zeroAddress, coinIs0: false, decimals: 18 } : 'skip';
    }
    const currencies = [zeroAddress as Address, ...tokens];
    for (const a of currencies) for (const b of currencies) {
      if (BigInt(a) >= BigInt(b)) continue;
      const ts = LONG_TICK_SPACINGS.find(s => v4PoolId({ currency0: a, currency1: b, fee: DYNAMIC_FEE_FLAG, tickSpacing: s, hooks: addrs.longHook }).toLowerCase() === id);
      if (ts === undefined) continue;
      if (a === zeroAddress) return { via, token: b, quote: zeroAddress, coinIs0: false, decimals: 18 };
      const qa = quotes?.asset(a) ?? null, qb = quotes?.asset(b) ?? null;
      if (qa && !qb) return { via, token: b, quote: a, coinIs0: false, decimals: qa.decimals };
      if (qb && !qa) return { via, token: a, quote: b, coinIs0: true, decimals: qb.decimals };
      if (qa && qb) return 'skip';
      // Neither priced: each one not refused yet is checked as a quote on the next price refresh.
      if (!quotes || (quotes.isRejected(a) && quotes.isRejected(b))) return 'skip';
      quotes.want(a); quotes.want(b);
      return null;
    }
    return 'skip';
  };
  /** A swap's size in ETH: amount0 on a native-ETH pool, else the quote's amount at its price now (null when unpriced). */
  const swapEth = (c: Candidate, s: RawLog): number | null => {
    const word = (i: number) => BigInt.asIntN(256, BigInt(`0x${s.data.slice(2 + 64 * i, 66 + 64 * i)}`));
    const abs = (v: bigint) => Number(v < 0n ? -v : v);
    if (c.via === 'pons' || c.quote === zeroAddress) return abs(word(0)) / 1e18;
    const ethPer = quotes?.ethPer(c.quote) ?? null;
    return ethPer === null ? null : abs(word(c.coinIs0 ? 1 : 0)) / 10 ** c.decimals * ethPer;
  };
  /**
   * A pool-launched coin's history, however old, into `feed` in chain order: its launch record and pool opening (in the
   * blocks after its contract appeared), then every transfer (holders) and every swap in its pool since, page by page.
   * The tracker applies them as it would have live: the record creates the coin, the opening sets its key, the swaps its
   * trades. Returns false when the record or the opening is not found. `estimate` is told the launch block first and may
   * refuse the read (returns a reason).
   */
  async function poolHistory(rpc: Rpc, c: Extract<Candidate, { via: PoolHook }>, id: Hex, to: bigint, feed: (logs: RawLog[]) => void, estimate: (launch: bigint) => string | null): Promise<true | string> {
    const getLogs = logsVia(rpc);
    const deployed = await deployBlock(rpc, c.token, to);
    if (deployed === null) return 'no launch record or pool opening found';
    const end = deployed + 2_000n < to ? deployed + 2_000n : to;
    const [records, inits] = await Promise.all([
      c.via === 'longxyz' ? getLogs({ address: addrs.longAirlock, topics: [LONG_CREATE_TOPIC, topic(c.quote)] }, deployed, end)
        : getLogs({ address: addrs.pangeaLauncher, topics: [PANGEA_POOL_TOPIC, null, topic(c.token)] }, deployed, end),
      getLogs({ address: addrs.poolManager, topics: [INITIALIZE_TOPIC, id] }, deployed, end),
    ]);
    const record = records.find(l => { const e = decodeRobinhoodLog(l, addrs, undefined, decodeOpts); return e?.kind === 'pool_launch' && same(e.token, c.token); });
    const init = inits[0];
    if (!record || !init) return 'no launch record or pool opening found';
    const start = BigInt(init.blockNumber) < BigInt(record.blockNumber) ? BigInt(init.blockNumber) : BigInt(record.blockNumber);
    const refused = estimate(start);
    if (refused) return refused;
    feed([record, init]);
    for await (const page of pagesOf(rpc, { address: c.token, topics: [TRANSFER_TOPIC] }, start, to)) feed(page);
    for await (const page of pagesOf(rpc, { address: addrs.poolManager, topics: [SWAP_TOPIC, id] }, start, to)) feed(page);
    return true;
  }
  /** A Pons graduate's history into `feed`, as graduateHistory reads it, page by page: its launch, its curve trades when it
   *  launched after `keep`, its graduation, then its transfers and its pool's swaps. */
  async function graduateHistoryPaged(rpc: Rpc, token: Address, id: Hex, keep: bigint, to: bigint, feed: (logs: RawLog[]) => void, estimate: (launch: bigint) => string | null): Promise<true | string> {
    const launch = await launchOf(rpc, token, keep, to);
    if (!launch) return 'no launch found';
    const l = decodeRobinhoodLog(launch, addrs);
    if (!l || l.kind !== 'launch') return 'launch not a native-ETH Pons launch';
    const start = BigInt(launch.blockNumber);
    const init = await firstLog(rpc, { address: addrs.poolManager, topics: [INITIALIZE_TOPIC, id] }, start, to);
    if (!init) return 'no graduation found';
    const refused = estimate(start);
    if (refused) return refused;
    const gradBlock = BigInt(init.blockNumber);
    feed([launch]);
    if (start >= keep) for await (const page of pagesOf(rpc, { address: l.curve, topics: [[CURVE_BUY_TOPIC, CURVE_SELL_TOPIC]] }, start, gradBlock)) feed(page);
    feed([init]);
    for await (const page of pagesOf(rpc, { address: token, topics: [TRANSFER_TOPIC] }, start, to)) feed(page);
    for await (const page of pagesOf(rpc, { address: addrs.poolManager, topics: [SWAP_TOPIC, id] }, gradBlock, to)) feed(page);
    return true;
  }

  /** The launch of `token`: looked for in [from, before]; when it is older, found from the block its contract appeared. */
  async function launchOf(rpc: Rpc, token: Address, from: bigint, before: bigint): Promise<RawLog | null> {
    const getLogs = logsVia(rpc), filter = { address: addrs.factory, topics: [TOKEN_LAUNCHED_TOPIC, topic(token)] };
    const near = await getLogs(filter, from, before);
    if (near[0]) return near[0];
    const deployed = await deployBlock(rpc, token, before);
    return deployed === null ? null : (await getLogs(filter, deployed, deployed + 2_000n < before ? deployed + 2_000n : before))[0] ?? null;
  }
  /** A graduate's history: its launch, transfers (holders), pool swaps, and its curve trades when it launched after `from`. */
  async function graduateHistory(rpc: Rpc, init: RawLog, token: Address, poolId: Hex, from: bigint, to: bigint): Promise<RawLog[]> {
    const getLogs = logsVia(rpc), gradBlock = BigInt(init.blockNumber);
    const launch = await launchOf(rpc, token, from < 0n ? 0n : from, gradBlock), l = launch ? decodeRobinhoodLog(launch, addrs) : null;
    if (!launch || !l || l.kind !== 'launch') return [];
    const start = BigInt(launch.blockNumber);
    const [trades, transfers, swaps] = await Promise.all([
      start >= from ? getLogs({ address: l.curve, topics: [[CURVE_BUY_TOPIC, CURVE_SELL_TOPIC]] }, start, gradBlock) : Promise.resolve([]),
      getLogs({ address: token, topics: [TRANSFER_TOPIC] }, start, to),
      getLogs({ address: addrs.poolManager, topics: [SWAP_TOPIC, poolId] }, gradBlock, to),
    ]);
    return [launch, ...trades, init, ...transfers, ...swaps];
  }
  /** Pons launches in [from, to] not followed yet, their curve trades, and the transfers of the ones that traded. */
  async function curveCoins(rpc: Rpc, from: bigint, to: bigint, known: (token: string) => boolean): Promise<RawLog[]> {
    const getLogs = logsVia(rpc);
    const all = await getLogs({ topics: [[TOKEN_LAUNCHED_TOPIC, CURVE_BUY_TOPIC, CURVE_SELL_TOPIC]] }, from, to);
    const curves = new Map<string, Address>(), launches: RawLog[] = [];
    for (const log of all) {
      if (log.topics[0] !== TOKEN_LAUNCHED_TOPIC) continue;
      const e = decodeRobinhoodLog(log, addrs);
      if (e?.kind === 'launch' && !known(e.token)) { curves.set(e.curve.toLowerCase(), e.token); launches.push(log); }
    }
    const trades = all.filter(l => l.topics[0] !== TOKEN_LAUNCHED_TOPIC && curves.has(l.address.toLowerCase()));
    const traded = [...new Set(trades.map(l => curves.get(l.address.toLowerCase())!))];
    const transfers: RawLog[] = [];
    for (let i = 0; i < traded.length; i += 40) transfers.push(...await getLogs({ address: traded.slice(i, i + 40), topics: [TRANSFER_TOPIC] }, from, to));
    return [...launches, ...trades, ...transfers];
  }

  return {
    profile: ROBINHOOD_PROFILE, multicall3: addrs.multicall3,
    // Launches and curve trades in one topic-OR call from any address (a curve per coin), and graduations: a v4
    // Initialize of a native-ETH pool on the PoolManager, kept only with the Pons hook.
    queries: robinhoodLogQueries(addrs, decodeOpts),
    swapManagers: [addrs.poolManager],
    isLaunch: isRobinhoodLaunch,
    // A Pons coin's pool swaps count from graduation; a pool-launched coin trades only in its pool, from launch.
    countsSwap: (coin, log) => (coin.graduated || coin.launchpad !== 'pons') && same(log.address, coin.manager),
    graduatesOnTrade: () => false,
    // With more_launchpads, a Pangea, long.xyz or unbranded coin still trading stays past EKO's memory, like a graduate.
    ...(options.moreLaunchpads ? { pooled: (coin: CoinState) => coin.launchpad !== 'pons' } : {}),
    // A long.xyz coin quoted in WETH, USDG or a stock token (more_launchpads): each swap in ETH at the quote's price now.
    ...(options.moreLaunchpads ? { quotedTrade: (coin: CoinState, swap: Parameters<NonNullable<ChainAdapter['quotedTrade']>>[1]) => {
      const ethPer = quotes?.ethPer(coin.quote) ?? null;
      return coin.quoteConverted && ethPer !== null ? quotedSwapTrade(coin.flipped, swap, { decimals: coin.quoteConverted.decimals, ethPer }) : null;
    } } : {}),
    apply(log, ts, t) {
      const e = decodeRobinhoodLog(log, addrs, (curve) => t.coinByPool(curve)?.token ?? null, decodeOpts);
      if (!e) return;
      if (e.kind === 'launch' || e.kind === 'pool_launch') {
        const coin = applyRobinhoodEvent(undefined, e, { addrs, ts, quote: quoteOf });
        if (coin) t.launch(coin as unknown as CoinState, log);
        return;
      }
      if (e.kind === 'pool_init' || e.kind === 'liquidity') {
        // A pool-launched coin's own pool: its key (long.xyz), opening price, or launch position. Nothing else.
        // A token-quoted pool's coin may be either currency (address order).
        const coin = e.kind === 'pool_init' ? t.coin(e.token) ?? (e.key.currency0 !== zeroAddress ? t.coin(e.key.currency0) : undefined) : t.coinByPool(e.poolId);
        if (!coin || coin.launchpad === 'pons') return;
        const next = applyRobinhoodEvent(rh(coin), e, { addrs, ts, quote: quoteOf });
        if (!next || next === rh(coin)) return;
        const linked = !coin.key && next.key;
        Object.assign(coin, next);
        if (linked) t.link(next.poolId, coin);
        return;
      }
      const coin = e.token ? t.coin(e.token) : undefined;
      if (!coin) {
        // A Pons graduation of a coin launched before EKO's memory: its history is fetched on the next tick.
        if (e.kind === 'graduated' && !pendingGraduates.some(p => same(p.token, e.token))) pendingGraduates.push({ init: log, token: e.token, poolId: e.poolId });
        return;
      }
      const next = applyRobinhoodEvent(rh(coin), e, { addrs, ts });
      if (!next || next === rh(coin)) return;
      // The tracker holds coins by reference: the event's result is written into the one it has.
      if (e.kind === 'curve_trade') { Object.assign(coin, next); return; }
      // Graduation: the Pons pool's key, id and PoolManager, then the tracker's own graduation (feed, sticky flag).
      Object.assign(coin, { key: next.key, poolId: next.poolId, manager: next.manager, flipped: false, sqrtPriceX96: next.sqrtPriceX96 });
      t.link(next.poolId, coin);
      t.graduate(coin, next.graduatedTs ?? ts, log);
    },
    excluded: (coin) => robinhoodExcluded(coin as Pick<RobinhoodCoinState, 'curve'> | undefined, addrs),
    async probe(coin, block, deps, priorTips) {
      // Pons coins have 18 decimals; other launchpads' may not (Pangea's have 9): read once, for displays (views.ts).
      if (coin.decimals === undefined && coin.launchpad !== 'pons') {
        try {
          const d = Number(BigInt(await deps.rpc.request({ method: 'eth_call', params: [{ to: coin.token, data: '0x313ce567' }, 'latest'] }) as Hex));
          if (Number.isInteger(d) && d >= 0 && d <= 36) coin.decimals = d;
        }
        catch { /* displays keep 18 until the next check reads it */ }
      }
      // long.xyz: which fee module the pool's hook calls (fixed at launch), read once; it decides whether the hook is reviewed.
      if (coin.launchpad === 'longxyz' && !coin.longModule) {
        try {
          const state = await deps.rpc.request({ method: 'eth_call', params: [{ to: LONGXYZ.hook, data: `0x1bab58f5${coin.token.slice(2).toLowerCase().padStart(64, '0')}` }, 'latest'] }) as Hex;
          // getState(asset): numeraire, totalTokensOnBondingCurve, dopplerHook, ... (the struct's arrays are left out).
          if (state.length >= 2 + 64 * 3) coin.longModule = `0x${state.slice(2 + 64 * 2 + 24, 2 + 64 * 3)}`.toLowerCase();
        }
        catch { /* read again on the next check; until then the hook counts as not reviewed */ }
      }
      // A pool quoted in a token is probed with about $1,000 of it: its price now (QuotePrices) and where it keeps
      // balances (found once per token; a failed search is tried again on a later check).
      const quoteProbe = async (c: RobinhoodCoinState) => {
        const ethUsd = deps.hypeUsd(), ethPer = quotes?.ethPer(c.quote) ?? null, decimals = c.quoteConverted?.decimals;
        if (!ethUsd || !ethPer || decimals === undefined || c.quote === zeroAddress) return null;
        const k = c.quote.toLowerCase();
        let slot = balanceSlots.get(k);
        if (slot === undefined) {
          const found = await balanceSlot(deps.rpc, c.quote, block);
          if (found.failed) return null;
          balanceSlots.set(k, slot = found.balance);
        }
        if (!slot) return null;
        const whole = 1000 / ethUsd / ethPer;
        if (!Number.isFinite(whole) || whole <= 0) return null;
        return { pair: { token: c.quote, balance: slot }, amount: BigInt(Math.round(whole * 1e6)) * 10n ** BigInt(decimals) / 10n ** 6n };
      };
      const p = await probeRobinhoodCoin(rh(coin), block, { rpc: deps.rpc, addrs, ethUsd: deps.hypeUsd, quoteProbe, ...(deps.now ? { now: deps.now } : {}) }, priorTips);
      // A probe inside the snipe window paid up to 99% going in: it is redone once the window ends (service.ts).
      return coin.curve && !coin.graduated ? { ...p, earlyUntil: coin.ts + PONS_SNIPE_SEC } : p;
    },
    facts(coin, p, nowSec): JudgeFacts {
      const { pons, lock } = p as RobinhoodProbed, key = p.key;
      const elapsed = nowSec - coin.ts, antiSnipeActive = !!coin.curve && !coin.graduated && elapsed < PONS_SNIPE_SEC;
      const ponsHook = !!key && same(key.hooks, addrs.hook), pangeaHook = !!key && same(key.hooks, addrs.pangeaHook), longHook = !!key && same(key.hooks, addrs.longHook);
      const longReviewed = longHook && !!coin.longModule && LONGXYZ.reviewedModules.some(m => same(m, coin.longModule!));
      const position = coin.launchPosition;
      return {
        antiSnipeActive,
        antiSnipe: antiSnipeActive ? { taxPct: PONS_SNIPE_BPS[Math.max(0, elapsed)]! / 100, endsInSec: coin.ts + PONS_SNIPE_SEC - nowSec } : null,
        // The pool's own fee is 0 on every Pons pool; the hook's cut comes after the swap (in the quoter's quotes).
        // A dynamic-fee pool (v4's 0x800000 flag: long.xyz's hook sets the fee per swap) has no fixed fee to report.
        feeBps: key ? (key.fee & DYNAMIC_FEE_FLAG ? 0 : key.fee / 100) : pons ? pons.feePct * 100 : 0,
        // Graduation parks the full-range position in the Pons launch locker; the proof (probe.ts) pins both contracts' code.
        liquidity: lock ? lock.locked ? { owner: PONS_LOCK.locker, status: 'locked', label: 'Pons launch locker holds the graduation liquidity (locker and PositionManager code pinned)' }
          : { owner: PONS_LOCK.locker, status: 'removable', label: 'The graduation liquidity is not proven locked in the Pons launch locker' }
          // The unbranded launcher mints the launch position's PositionManager NFT to the creator: removable at will.
          : position ? { owner: position.owner, status: 'removable', controlledBy: 'deployer',
            label: 'The creator was given the pool\'s launch position (a Uniswap position NFT) and can take the liquidity out',
            ...(position.removed > 0n && position.liquidity > 0n ? { pulled: { share: Math.min(1, Number(position.removed) / Number(position.liquidity)),
              evidence: [{ kind: 'tx' as const, ref: position.removedTx ?? coin.tx, label: 'Launch liquidity taken out' }] } } : {}) } : null,
        hook: {
          // TODO(review): the registry's Pons hook takes its documented cut through an after-swap return delta (flags 0x2044).
          // Treated as reviewed so its permission bits alone do not flag every graduated coin, as Montra's hook is on Elysium.
          // Pangea's hook is not reviewed: its address grants before- and after-swap return deltas (flags 0x28cc), so it
          // can change what a swap pays or returns. Measured 2026-11-18: EKO's 0.005 ETH sell probe lost 1.99% on five
          // Pangea pools.
          label: ponsHook ? 'Pons hook (registry-listed; takes its fee after the swap)'
            : pangeaHook ? 'Pangea hook (not reviewed; can change swap amounts before and after each swap)'
            : longReviewed ? 'long.xyz (Doppler) hook (source verified; takes a fixed fee after the swap, the same on buys and sells; higher in the first seconds after launch)'
            : longHook ? 'long.xyz (Doppler) hook (its fee module is not reviewed; sets the fee and can change what a swap returns)' : 'v4 hook',
          reviewed: ponsHook || longReviewed, sourceVerified: longReviewed,
          buyFeePct: null, sellFeePct: null,
        },
        ...(coin.curve && !coin.graduated && coin.supply > 0n ? { runUp: curveRunUp(coin as CoinState & { curve: NonNullable<CoinState['curve']> }, nowSec) } : {}),
        ...(coin.launchpad !== 'pons' && coin.key && coin.supply > 0n ? { backing: poolBacking(coin, nowSec) } : {}),
      };
    },
    trade: robinhoodVenue(trade),
    historian: {
      launches: { address: addrs.factory, topic0: TOKEN_LAUNCHED_TOPIC },
      swaps: { address: addrs.poolManager, topic0: SWAP_TOPIC },
      async replayLogs(explorer, { token, createdBlock }, end) {
        // The launch (topic 1 is the token) names the curve; its trades, the Pons pool's Initialize and swaps, and the transfers.
        const launch = await explorer.logs({ address: addrs.factory, topic0: TOKEN_LAUNCHED_TOPIC, topic1: `0x${token.slice(2).toLowerCase().padStart(64, '0')}` as Hex }, createdBlock, createdBlock);
        const curveTopic = launch[0]?.topics[2];
        if (!curveTopic) return [];
        const curve = getAddress(`0x${curveTopic.slice(26)}`) as Address, poolId = v4PoolId(ponsPoolKey(token, addrs.hook));
        const logs = [...launch];
        for (const topic0 of [CURVE_BUY_TOPIC, CURVE_SELL_TOPIC]) logs.push(...await explorer.logs({ address: curve, topic0 }, createdBlock, end));
        logs.push(...await explorer.logs({ address: addrs.poolManager, topic0: INITIALIZE_TOPIC, topic1: poolId }, createdBlock, end));
        logs.push(...await explorer.logs({ address: addrs.poolManager, topic0: SWAP_TOPIC, topic1: poolId }, createdBlock, end));
        logs.push(...await explorer.logs({ address: token, topic0: TRANSFER_TOPIC as Hex }, createdBlock, end));
        return logs as RawLog[];
      },
    },
    // ETH from Hyperliquid, accepted only within 2% of Robinhood Chain's WETH/USDG pool. With more_launchpads, each refresh
    // also refreshes the quote tokens' prices; the first one queues every numeraire long.xyz launched in over EKO's memory
    // (about 25 hours), so they are priced before the start-up replay applies those launches.
    price: (rpc) => {
      const eth = new EthUsd({ rpc });
      if (!options.moreLaunchpads) return eth;
      const q = quotes ??= new QuotePrices({ ethUsd: eth, addrs: { weth: addrs.weth, usdg: addrs.usdg, v3Factory: registry.requireAddress('uniswapV3.factory'), multicall3: addrs.multicall3 } });
      let seeded = false;
      const seed = async () => {
        const head = BigInt(await rpc.request({ method: 'eth_blockNumber', params: [] }) as Hex);
        const from = head > ROBINHOOD_KEEP_BLOCKS ? head - ROBINHOOD_KEEP_BLOCKS : 0n;
        for (const l of await logsVia(rpc)({ address: addrs.longAirlock, topics: [LONG_CREATE_TOPIC] }, from, head))
          if (l.topics[1] && l.topics[1] !== NATIVE_TOPIC) q.want(getAddress(`0x${l.topics[1].slice(26)}`));
      };
      const usd: NativeUsd = {
        get latest() { return eth.latest; },
        async get() {
          const value = await eth.get();
          if (!seeded) { try { await seed(); seeded = true; } catch { /* tried again on the next refresh */ } }
          await q.refresh(rpc);
          return value;
        },
      };
      return usd;
    },
    // Start-up warm-up, so a restart loses nothing the columns show (needs an RPC that serves old logs and state; dRPC
    // does):
    // - every Pons graduation between `from` and `to` (v4 Initialize of a native pool with the Pons hook) of a coin not
    //   tracked yet, however long ago it launched (a coin can sit on its curve for days): its launch, transfers and pool
    //   swaps, and its curve trades when it launched inside the window;
    // - every Pons launch in the window not tracked yet (snapshot lost or never taken): its launch and curve trades, and
    //   the transfers of those that traded (holders, early buyers and the deployer need them).
    async graduates(rpc, from, to, known, opts) {
      const out: RawLog[] = [];
      const inits = await logsVia(rpc)({ address: addrs.poolManager, topics: [INITIALIZE_TOPIC, null, NATIVE_TOPIC] }, from, to);
      for (const init of inits) {
        const g = decodeRobinhoodLog(init, addrs);
        if (g && g.kind === 'graduated' && !known(g.token)) out.push(...await graduateHistory(rpc, init, g.token, g.poolId, from, to));
      }
      const seen = new Set(out.filter(l => l.topics[0] === TOKEN_LAUNCHED_TOPIC).map(l => `0x${l.topics[1]!.slice(26)}`.toLowerCase()));
      if (opts?.coins !== false) out.push(...await curveCoins(rpc, from, to, (token) => known(token) || seen.has(token.toLowerCase())));
      return out;
    },
    // A graduation seen live for a coin EKO does not follow (it launched before EKO's memory): fetched on the next tick.
    async missing(rpc, to, known) {
      const wanted = pendingGraduates.splice(0);
      const out: RawLog[] = [];
      for (const { init, token, poolId } of wanted) if (!known(token)) {
        try { out.push(...await graduateHistory(rpc, init, token, poolId, BigInt(init.blockNumber) - ROBINHOOD_KEEP_BLOCKS, to)); }
        catch { if (Date.now() - Number(init.seenAt ?? Date.now()) < 600_000) pendingGraduates.push({ init: { ...init, seenAt: init.seenAt ?? Date.now() }, token, poolId }); }
      }
      return out;
    },
    // Coins still trading that EKO does not follow (they left its memory, or launched before it started). The chain swaps
    // ~500k times a day across all pools, too many to read every round, so pools are found from their hooks' own per-swap
    // events, which name the pool: the Pons hook's (~40k a day), and with more_launchpads long.xyz's (~33k a day: pools in
    // stock tokens, WETH, USDG and native ETH) and Pangea's. Only pools not followed with 10 or more of them are resolved
    // to their coin (from one swap's receipt) and have their swaps summed, in ETH. The busiest at or over `minQuote` are
    // read in full: a Pons graduate's launch, curve, graduation and pool history as for a graduation seen live, a pool
    // launch's record, pool opening, transfers and swaps. Hookless pools (the unbranded launcher's) have no such event and
    // are not looked for: docs/robinhood/CHAIN-FACTS.md §10.
    async active(rpc, from, to, known, minQuote, history) {
      let calls = 0;
      const metered: Rpc = { request: (args) => { calls++; return rpc.request(args); } };
      const getLogs = logsVia(metered);
      const seen = new Map<string, { n: number; tx: Hex; via: 'pons' | PoolHook }>();
      const count = (via: 'pons' | PoolHook) => (l: RawLog) => {
        // The pool id: topic 1 on the Pons and Pangea hooks' events, topic 2 on long.xyz's (topic 1 is the swapper).
        const id = l.topics[via === 'longxyz' ? 2 : 1]?.toLowerCase();
        if (!id || known.pool(id) || notNative.has(id)) return;
        const p = seen.get(id) ?? { n: 0, tx: l.transactionHash, via };
        p.n++; seen.set(id, p);
      };
      const reads: Promise<void>[] = [getLogs({ address: addrs.hook, topics: [PONS_HOOK_SWAP_TOPIC] }, from, to).then(ls => ls.forEach(count('pons')))];
      if (options.moreLaunchpads) reads.push(
        getLogs({ address: addrs.longHook, topics: [LONG_HOOK_SWAP_TOPIC] }, from, to).then(ls => ls.forEach(count('longxyz'))),
        getLogs({ address: addrs.pangeaHook, topics: [PANGEA_HOOK_SWAP_TOPIC] }, from, to).then(ls => ls.forEach(count('pangea'))));
      await Promise.all(reads);
      const findCalls = calls;
      // Each busy pool is resolved to its coin from one swap's receipt: the hooks also serve pools EKO cannot price (a
      // Pons pool in USDG, a long.xyz coin quoted in another coin), whose amounts are not ETH.
      const coins = new Map<string, Candidate>();
      const candidates = [...seen].filter(([, p]) => p.n >= 10).sort((a, b) => b[1].n - a[1].n).slice(0, options.moreLaunchpads ? 120 : 60);
      for (let i = 0; i < candidates.length; i += 6) await Promise.all(candidates.slice(i, i + 6).map(async ([id, { tx, via }]) => {
        const cached = resolved.get(id);
        if (cached) { if (!known.token(cached.token)) coins.set(id, cached); return; }
        try {
          const receipt = await metered.request({ method: 'eth_getTransactionReceipt', params: [tx] }) as { logs: RawLog[] } | null;
          const tokens = [...new Set((receipt?.logs ?? []).filter(l => l.topics[0] === TRANSFER_TOPIC && !same(l.address, addrs.poolManager)).map(l => getAddress(l.address)))];
          const c = via === 'pons' ? ponsCandidate(id, tokens) : poolCandidate(id, tokens, via);
          if (c === 'skip') notNative.add(id);
          else if (c) { resolved.set(id, c); if (!known.token(c.token)) coins.set(id, c); }
        } catch { /* left for the next round */ }
      }));
      if (!coins.size) return;
      const volume = new Map<string, number>(), swaps24h = new Map<string, number>(), ids = [...coins.keys()] as Hex[];
      for (let i = 0; i < ids.length; i += 60) for (const s of await getLogs({ address: addrs.poolManager, topics: [SWAP_TOPIC, ids.slice(i, i + 60)] }, from, to)) {
        const id = s.topics[1]!.toLowerCase(), eth = swapEth(coins.get(id)!, s);
        swaps24h.set(id, (swaps24h.get(id) ?? 0) + 1);
        if (eth !== null) volume.set(id, (volume.get(id) ?? 0) + eth);
      }
      // The busiest few, one at a time: a coin's first lookup reads its whole transfer history (hundreds of log pages for
      // an old one) through the same metered RPC the live tracker uses. A coin found once stays followed (snapshot).
      const busy = [...volume].filter(([, q]) => q >= minQuote).sort((a, b) => b[1] - a[1]).slice(0, ACTIVE_PER_ROUND);
      const rankCalls = calls - findCalls;
      let total = 0, budget = options.historyLogs?.round ?? ACTIVE_ROUND_LOG_BUDGET; const coinLimit = options.historyLogs?.coin ?? ACTIVE_COIN_LOG_LIMIT; const keep = to > ROBINHOOD_KEEP_BLOCKS ? to - ROBINHOOD_KEEP_BLOCKS : 0n, began = Date.now();
      const found: { token: string; launchpad: string; quote24h: number; calls: number; logs: number; estLogs: number }[] = [];
      const failed: { token: string; why: string }[] = [], skipped: { token: string; estLogs: number; why: string }[] = [];
      for (const [id, quote24h] of busy) {
        const c = coins.get(id)!, token = c.token, before = calls;
        let read = 0, est = 0;
        // Before any page is read: the history's size from the pool's swaps today and the coin's age. Too large for any
        // round, it is never read (and not looked at again); too large for what is left of this round, it waits.
        const estimate = (launch: bigint) => {
          const days = Number(to - launch) / Number(DAY_BLOCKS);
          est = Math.round((swaps24h.get(id) ?? 0) * LOGS_PER_SWAP * Math.max(1, days));
          if (est > coinLimit) { notNative.add(id); return `too large: about ${est} logs`; }
          if (est > budget && found.length) return 'waits for a later round';
          return null;
        };
        const sink = history();
        const feed = (logs: RawLog[]) => {
          read += logs.length;
          if (read > coinLimit) throw new Error(`stopped after ${read} logs`);
          sink.add(logs);
        };
        try {
          const done = c.via === 'pons' ? await graduateHistoryPaged(metered, token, id as Hex, keep, to, feed, estimate) : await poolHistory(metered, c, id as Hex, to, feed, estimate);
          if (done === true) {
            sink.end(); total += read; budget -= read;
            found.push({ token, launchpad: c.via, quote24h: Math.round(quote24h * 100) / 100, calls: calls - before, logs: read, estLogs: est });
          } else if (done.startsWith('too large') || done.startsWith('waits')) skipped.push({ token, estLogs: est, why: done });
          else {
            failed.push({ token, why: done });
            // A pool coin's launch record is where it is or nowhere: not read again every round.
            if (c.via !== 'pons') notNative.add(id);
          }
        } catch (error) {
          // One coin's failure leaves the others (its partial history is dropped with its sink); it is tried again on the
          // next round. Messages only, never the RPC URL.
          failed.push({ token, why: String((error as Error).message).replace(/https?:\/\/\S+/g, '<rpc>').slice(0, 160) });
        }
      }
      console.log(JSON.stringify({ t: new Date().toISOString(), event: 'active_graduates', candidates: coins.size,
        busy: busy.map(([id, q]) => ({ token: coins.get(id)!.token, launchpad: coins.get(id)!.via, quote24h: Math.round(q * 100) / 100 })), found, failed, skipped, logs: total,
        calls: { find: findCalls, rank: rankCalls, history: calls - findCalls - rankCalls }, sec: Math.round((Date.now() - began) / 1000) }));
    },
    // A saved curve coin's reserves are as of the save, but the backfill replays from `block` and adds each curve trade
    // again: read the curve's own reserves at `block` (dRPC keeps history) so the replay lands on today's values.
    async rebase(coins, block, rpc) {
      const at = `0x${block.toString(16)}`, list = coins.filter(c => c.curve && !c.graduated && c.block <= Number(block));
      const read = async (curve: Address, data: Hex) => BigInt(await rpc.request({ method: 'eth_call', params: [{ to: curve, data }, at] }) as Hex);
      let failed = 0;
      for (let i = 0; i < list.length; i += 8) await Promise.all(list.slice(i, i + 8).map(async (c) => {
        try {
          const [q, t] = await Promise.all([read(c.curve!.address, REAL_QUOTE_RESERVE), read(c.curve!.address, SELLABLE_TOKENS)]);
          c.curve = { ...c.curve!, realQuoteReserve: q, realTokenReserve: t };
        } catch { failed++; }
      }));
      if (failed) console.log(JSON.stringify({ t: new Date().toISOString(), event: 'curve_rebase_failed', coins: failed, of: list.length }));
    },
  };
}
