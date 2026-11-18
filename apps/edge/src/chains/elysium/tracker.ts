import { getAddress, toEventSelector, zeroAddress, type Address, type Hex } from 'viem';
import { decodeMontraResult, montraFactoryAbi, montraHookAbi, type ElysiumRegistry } from '@eko/chain';
import { graduationBps, openPriceAt } from '../../graduation.js';
import type { CoinState, RawLog } from '../../tracker.js';
import type { TrackerCore } from '../types.js';
import { decodeLaunch, flaunchTrade, FLAUNCH_POOL_SWAP, LAUNCH_TOPICS } from './launchpads.js';

export const LAUNCH_TOPIC = toEventSelector(montraFactoryAbi[0]);
export const GRADUATED_TOPIC = toEventSelector(montraHookAbi[0]);

/**
 * Elysium's launches in the tracker: Montra (TokenLaunched, Graduated), the Flaunch fork (PoolCreated, and its PoolSwap
 * for trades), HyperForge clones and the tax launchpad (launchpads.ts). Launch events come from one topic-filtered call
 * (HyperForge clones emit from many addresses); Montra's and the fork's are accepted only from their own contracts.
 */
export function elysiumLogs(registry: ElysiumRegistry) {
  const factory = registry.address('montra.factory'), hook = registry.address('montra.hook'), manager = registry.address('uniswapV4.poolManager');
  const flaunchHook = registry.address('flaunchFork.hook').toLowerCase();
  return {
    // Launches and graduations of every launchpad, and the Flaunch fork's PoolSwap trades.
    queries: [{ topics: [[LAUNCH_TOPIC, GRADUATED_TOPIC, ...LAUNCH_TOPICS, FLAUNCH_POOL_SWAP] as Hex[]] }],
    swapManagers: [manager, registry.address('unbrandedLauncher.poolManager')] as Address[],
    isLaunch: (l: RawLog) => l.topics[0] === LAUNCH_TOPIC || LAUNCH_TOPICS.includes(l.topics[0]!),
    // A Flaunch-fork pool's Uniswap leg is part of its PoolSwap: counting it here would count it twice. A pool id is only
    // unique within its PoolManager: a swap counts only from the coin's own.
    countsSwap: (coin: CoinState, log: RawLog) => coin.launchpad !== 'flaunch' && log.address.toLowerCase() === coin.manager.toLowerCase(),
    // A launchpad with no graduation of its own graduates when its market cap first reaches Montra's line (graduation.ts).
    graduatesOnTrade: (coin: CoinState, openMcapHype: number) => coin.launchpad !== 'montra' && graduationBps(coin, openMcapHype) === 10_000,

    apply(log: RawLog, ts: number, t: TrackerCore) {
      const topic = log.topics[0], block = Number(BigInt(log.blockNumber));
      if (topic === FLAUNCH_POOL_SWAP) {
        const coin = t.coinByPool(log.topics[1]!);
        // Amounts and prices are in HYPE: a coin quoted in another token is left out (tracker.ts).
        if (!coin || coin.quote !== zeroAddress) return;
        // The fork's own record of the whole trade; only its hook may emit it.
        if (coin.launchpad !== 'flaunch' || log.address.toLowerCase() !== flaunchHook) return;
        const trade = flaunchTrade(log.data, coin.flipped);
        if (trade) t.trade(coin, { ts, block, tx: log.transactionHash, sender: getAddress(log.address), ...trade }, log);
        return;
      }
      if (LAUNCH_TOPICS.includes(topic!)) {
        const d = decodeLaunch(log, registry);
        if (!d) return;
        t.launch({ launchpad: d.launchpad, key: d.key, flipped: d.flipped, supplyFromMints: d.supply === 0n, launcher: getAddress(log.address), manager: d.manager,
          token: d.token, creator: d.creator, poolId: d.poolId, quote: zeroAddress, supply: d.supply, configId: 0n,
          firstBuyIn: 0n, firstBuyOut: 0n, feeRecipient: d.creator, feeLocked: false, block, ts, tx: log.transactionHash,
          trades: [], netHype: 0, sqrtPriceX96: null, graduated: false, name: d.name, symbol: d.symbol, flows: [] }, log);
        return;
      }
      // Montra's launch and graduation events count only from Montra's own factory and hook.
      if ((topic === LAUNCH_TOPIC && log.address.toLowerCase() !== factory.toLowerCase()) || (topic === GRADUATED_TOPIC && log.address.toLowerCase() !== hook.toLowerCase())) return;
      const decoded = decodeMontraResult({ address: getAddress(log.address), topics: log.topics as [Hex, ...Hex[]], data: log.data }, {
        registry,
        poolById: (id) => { const c = t.coinByPool(id); return c ? { token: c.token, quote: c.quote, feeBps: 0, liquidityUsd: 0, executable: false } : null; },
      });
      for (const e of decoded.events) {
        if (e.kind === 'launch' && e.poolId) {
          const coin: CoinState = { launchpad: 'montra', key: null, flipped: false, supplyFromMints: false, launcher: factory, manager, token: e.token, creator: e.deployer, poolId: e.poolId, quote: e.quote!, supply: e.supply ?? 0n, configId: e.launchConfigId ?? 0n,
            firstBuyIn: e.firstBuyIn ?? 0n, firstBuyOut: e.firstBuyOut ?? 0n, feeRecipient: e.feeRecipient ?? e.deployer, feeLocked: e.feeLocked ?? false,
            block, ts, tx: log.transactionHash, trades: [], netHype: 0, sqrtPriceX96: null, graduated: false, name: null, symbol: null, flows: [],
            ...(e.startTick !== undefined && e.quoteIsCurrency0 !== undefined ? { openPrice: openPriceAt(e.startTick, e.quoteIsCurrency0) } : {}) };
          if (t.coin(e.token)) continue;
          // The line in market cap for the other launchpads follows Montra's latest native-quoted opening.
          if (coin.openPrice && coin.quote === zeroAddress && coin.supply > 0n) t.openMcapHype = coin.openPrice * Number(coin.supply) / 1e18;
          t.launch(coin, log);
        } else if (e.kind === 'graduated') {
          const coin = t.coin(e.token);
          if (coin) t.graduate(coin, ts, log);
        }
      }
    },
  };
}
