import { getAddress, toFunctionSelector, type Address, type Hex } from 'viem';
import { loadRegistry, v4PoolId, type AddressRegistry } from '@eko/chain';
import type { CoinState, RawLog, Rpc } from '../../tracker.js';
import { SWAP_TOPIC, TRANSFER_TOPIC } from '../logs.js';
import { ROBINHOOD_PROFILE } from '../profiles.js';
import { robinhoodVenue } from '../robinhood-venue.js';
import type { ChainAdapter, JudgeFacts } from '../types.js';
import { robinhoodAddresses, type RobinhoodAddresses } from './addresses.js';
import { applyRobinhoodEvent, CURVE_BUY_TOPIC, CURVE_SELL_TOPIC, decodeRobinhoodLog, INITIALIZE_TOPIC, NATIVE_TOPIC, robinhoodLogQueries, TOKEN_LAUNCHED_TOPIC, type RobinhoodCoinState } from './events.js';
import { EthUsd } from './price.js';
import { probeRobinhoodCoin, robinhoodExcluded, type RobinhoodProbed } from './probe.js';
import { PONS_LOCK, PONS_TERMS } from './profile.js';
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
const rh = (coin: CoinState) => coin as unknown as RobinhoodCoinState;

/**
 * Robinhood Chain: native ETH, Pons coins on their own bonding curve (native-ETH curves only; USDG- and token-quoted
 * launches are skipped) and, after graduation, in a Uniswap v4 pool with the Pons hook, where the tracker's v4 Swap path
 * takes over. Checks run at the head (the public RPC keeps about ten minutes of state).
 */
export function robinhoodChain(registry: AddressRegistry = loadRegistry()): ChainAdapter {
  const addrs: RobinhoodAddresses = robinhoodAddresses(registry), trade = loadRobinhoodTradeAddresses();
  // Graduations seen live for coins not followed, drained by `missing` on the next tick.
  const pendingGraduates: { init: RawLog & { seenAt?: number }; token: Address; poolId: Hex }[] = [];
  const topic = (a: Address) => `0x${a.slice(2).toLowerCase().padStart(64, '0')}` as Hex;
  // Pons-hook pools that are not a coin's native-ETH Pons pool (USDG- or token-quoted): not resolved again (active).
  const notNative = new Set<string>();

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
    queries: robinhoodLogQueries(addrs),
    swapManagers: [addrs.poolManager],
    isLaunch: (l) => l.topics[0] === TOKEN_LAUNCHED_TOPIC,
    countsSwap: (coin, log) => coin.graduated && same(log.address, coin.manager),
    graduatesOnTrade: () => false,
    apply(log, ts, t) {
      const e = decodeRobinhoodLog(log, addrs, (curve) => t.coinByPool(curve)?.token ?? null);
      if (!e) return;
      if (e.kind === 'launch') {
        const coin = applyRobinhoodEvent(undefined, e, { addrs, ts });
        if (coin) t.launch(coin as unknown as CoinState, log);
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
      const p = await probeRobinhoodCoin(rh(coin), block, { rpc: deps.rpc, addrs, ethUsd: deps.hypeUsd, ...(deps.now ? { now: deps.now } : {}) }, priorTips);
      // A probe inside the snipe window paid up to 99% going in: it is redone once the window ends (service.ts).
      return coin.curve && !coin.graduated ? { ...p, earlyUntil: coin.ts + PONS_SNIPE_SEC } : p;
    },
    facts(coin, p, nowSec): JudgeFacts {
      const { pons, lock } = p as RobinhoodProbed, key = p.key;
      const elapsed = nowSec - coin.ts, antiSnipeActive = !!coin.curve && !coin.graduated && elapsed < PONS_SNIPE_SEC;
      const ponsHook = !!key && same(key.hooks, addrs.hook);
      return {
        antiSnipeActive,
        antiSnipe: antiSnipeActive ? { taxPct: PONS_SNIPE_BPS[Math.max(0, elapsed)]! / 100, endsInSec: coin.ts + PONS_SNIPE_SEC - nowSec } : null,
        // The pool's own fee is 0 on every Pons pool; the hook's cut comes after the swap (in the quoter's quotes).
        feeBps: key ? key.fee / 100 : pons ? pons.feePct * 100 : 0,
        // Graduation parks the full-range position in the Pons launch locker; the proof (probe.ts) pins both contracts' code.
        liquidity: lock ? lock.locked ? { owner: PONS_LOCK.locker, status: 'locked', label: 'Pons launch locker holds the graduation liquidity (locker and PositionManager code pinned)' }
          : { owner: PONS_LOCK.locker, status: 'removable', label: 'The graduation liquidity is not proven locked in the Pons launch locker' } : null,
        hook: {
          // TODO(review): the registry's Pons hook takes its documented cut through an after-swap return delta (flags 0x2044).
          // Treated as reviewed so its permission bits alone do not flag every graduated coin, as Montra's hook is on Elysium.
          label: ponsHook ? 'Pons hook (registry-listed; takes its fee after the swap)' : 'v4 hook', reviewed: ponsHook, sourceVerified: false,
          buyFeePct: null, sellFeePct: null,
        },
        ...(coin.curve && !coin.graduated && coin.supply > 0n ? { runUp: curveRunUp(coin as CoinState & { curve: NonNullable<CoinState['curve']> }, nowSec) } : {}),
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
    // ETH from Hyperliquid, accepted only within 2% of Robinhood Chain's WETH/USDG pool.
    price: (rpc) => new EthUsd({ rpc }),
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
    // Graduates still trading that EKO does not follow. The chain swaps ~500k times a day across all pools, so the
    // Pons pools are found from the Pons hook's own per-swap event (topic 1 is the pool id; ~40k a day), and only the
    // pools not followed with 10 or more of them have their swaps summed (amount0 is native ETH on every Pons pool).
    // For each busy pool: its coin from one swap's receipt (the token whose Pons pool id is that pool), its Initialize
    // (the graduation) and its history, as for a graduation seen live.
    async active(rpc, from, to, known, minQuote, emit) {
      const getLogs = logsVia(rpc);
      const seen = new Map<string, { n: number; tx: Hex }>();
      for (const l of await getLogs({ address: addrs.hook, topics: [PONS_HOOK_SWAP_TOPIC] }, from, to)) {
        const id = l.topics[1]?.toLowerCase();
        if (!id || known.pool(id) || notNative.has(id)) continue;
        const p = seen.get(id) ?? { n: 0, tx: l.transactionHash };
        p.n++; seen.set(id, p);
      }
      // The hook also serves USDG- and token-quoted Pons pools (amount0 is not ETH there): each busy pool is first
      // resolved to its coin from one swap's receipt, and kept only when it is that coin's native-ETH Pons pool.
      const coins = new Map<string, Address>();
      const candidates = [...seen].filter(([, p]) => p.n >= 10).sort((a, b) => b[1].n - a[1].n).slice(0, 60);
      for (let i = 0; i < candidates.length; i += 6) await Promise.all(candidates.slice(i, i + 6).map(async ([id, { tx }]) => {
        try {
          const receipt = await rpc.request({ method: 'eth_getTransactionReceipt', params: [tx] }) as { logs: RawLog[] } | null;
          const tokens = new Set((receipt?.logs ?? []).filter(l => l.topics[0] === TRANSFER_TOPIC && !same(l.address, addrs.poolManager)).map(l => getAddress(l.address)));
          const token = [...tokens].find(t => v4PoolId(ponsPoolKey(t, addrs.hook)).toLowerCase() === id);
          if (!token) notNative.add(id);
          else if (!known.token(token)) coins.set(id, token);
        } catch { /* left for the next round */ }
      }));
      if (!coins.size) return;
      const volume = new Map<string, number>();
      for (const s of await getLogs({ address: addrs.poolManager, topics: [SWAP_TOPIC, [...coins.keys()] as Hex[]] }, from, to)) {
        const id = s.topics[1]!.toLowerCase(), a0 = BigInt.asIntN(256, BigInt(`0x${s.data.slice(2, 66)}`));
        volume.set(id, (volume.get(id) ?? 0) + Number(a0 < 0n ? -a0 : a0) / 1e18);
      }
      // The 12 busiest, one at a time: a coin's first lookup reads its whole transfer history (hundreds of log pages for
      // an old one) through the same metered RPC the live tracker uses. A coin found once stays followed (snapshot).
      const busy = [...volume].filter(([, q]) => q >= minQuote).sort((a, b) => b[1] - a[1]).slice(0, 12);
      let total = 0; const keep = to > ROBINHOOD_KEEP_BLOCKS ? to - ROBINHOOD_KEEP_BLOCKS : 0n, began = Date.now();
      const found: string[] = [], failed: { token: string; why: string }[] = [];
      for (const [id] of busy) {
        const token = coins.get(id)!;
        try {
          const launch = await launchOf(rpc, token, keep, to);
          if (!launch) { failed.push({ token, why: 'no launch found' }); continue; }
          const init = await firstLog(rpc, { address: addrs.poolManager, topics: [INITIALIZE_TOPIC, id as Hex] }, BigInt(launch.blockNumber), to);
          if (!init) { failed.push({ token, why: 'no graduation found' }); continue; }
          const logs = await graduateHistory(rpc, init, token, id as Hex, keep, to);
          if (logs.length) { emit(logs); total += logs.length; found.push(token); } else failed.push({ token, why: 'launch not a native-ETH Pons launch' });
        } catch (error) {
          // One coin's failure leaves the others; it is tried again on the next round. Messages only, never the RPC URL.
          failed.push({ token, why: String((error as Error).message).replace(/https?:\/\/\S+/g, '<rpc>').slice(0, 160) });
        }
      }
      console.log(JSON.stringify({ t: new Date().toISOString(), event: 'active_graduates', busy: busy.length, found, failed, logs: total, sec: Math.round((Date.now() - began) / 1000) }));
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
