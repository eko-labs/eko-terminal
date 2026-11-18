import { getAddress, toFunctionSelector, type Address, type Hex } from 'viem';
import { loadRegistry, v4PoolId, type AddressRegistry } from '@eko/chain';
import type { CoinState, RawLog } from '../../tracker.js';
import { SWAP_TOPIC, TRANSFER_TOPIC } from '../logs.js';
import { ROBINHOOD_PROFILE } from '../profiles.js';
import { robinhoodVenue } from '../robinhood-venue.js';
import type { ChainAdapter, JudgeFacts } from '../types.js';
import { robinhoodAddresses, type RobinhoodAddresses } from './addresses.js';
import { applyRobinhoodEvent, CURVE_BUY_TOPIC, CURVE_SELL_TOPIC, decodeRobinhoodLog, INITIALIZE_TOPIC, robinhoodLogQueries, TOKEN_LAUNCHED_TOPIC, type RobinhoodCoinState } from './events.js';
import { EthUsd } from './price.js';
import { probeRobinhoodCoin, robinhoodExcluded, type RobinhoodProbed } from './probe.js';
import { PONS_LOCK } from './profile.js';
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
const REAL_QUOTE_RESERVE = toFunctionSelector('realQuoteReserve()'), SELLABLE_TOKENS = toFunctionSelector('sellableTokens()');
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
      if (!coin) return;
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
