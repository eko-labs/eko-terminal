import { decodeEventLog, getAddress, parseAbi, toEventSelector, type Address, type Hex } from 'viem';
import { decodeMontraResult, montraFactoryAbi, montraHookAbi, type ElysiumRegistry, type V4PoolKey } from '@eko/chain';
import { tradeFromSwap, type Trade } from './market.js';
import { DEFAULT_OPEN_MCAP_HYPE, graduationBps, openPriceAt } from './graduation.js';
import { decodeLaunch, flaunchTrade, FLAUNCH_POOL_SWAP, LAUNCH_TOPICS, type LaunchpadId } from './launchpads.js';

export interface Rpc { request(input: { method: string; params: readonly unknown[] }): Promise<unknown> }
export interface RawLog { address: string; topics: Hex[]; data: Hex; blockNumber: Hex; transactionHash: Hex; logIndex: Hex; blockTimestamp?: Hex }

export const swapAbi = parseAbi(['event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)']);
export const SWAP_TOPIC = toEventSelector(swapAbi[0]);
export const LAUNCH_TOPIC = toEventSelector(montraFactoryAbi[0]);
export const GRADUATED_TOPIC = toEventSelector(montraHookAbi[0]);
/** ERC-20 Transfer(address indexed from, address indexed to, uint256 value). */
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/** One token transfer of a tracked coin. */
export interface Flow { tx: Hex; block: number; ts: number; from: string; to: string; value: bigint }

export interface CoinState {
  /** Which launchpad launched it; Montra's own terms (config, fees) are read only for Montra coins. */
  launchpad: LaunchpadId;
  /** The pool key when the launch gave it (other launchpads); Montra coins read theirs from the hook. */
  key: V4PoolKey | null;
  /** The token is currency0 (HYPE currency1): swap signs are read the other way round. */
  flipped: boolean;
  /** Supply is summed from mints (the launch event did not give it). */
  supplyFromMints: boolean;
  /** The contract that announced the launch (it may hold fees or reserves; it is not a holder). */
  launcher: Address;
  /** The PoolManager its pool lives in: Uniswap's, or the unbranded launcher's fork. Swaps count only from it. */
  manager: Address;
  token: Address; creator: Address; poolId: Hex; quote: Address; supply: bigint; configId: bigint;
  firstBuyIn: bigint; firstBuyOut: bigint; feeRecipient: Address; feeLocked: boolean;
  block: number; ts: number; tx: Hex;
  trades: Trade[]; netHype: number; sqrtPriceX96: bigint | null; graduated: boolean;
  /** Montra: HYPE per token at the opening tick (graduation progress is measured from it). */
  openPrice?: number;
  /** When it graduated: Montra's Graduated event, or another launchpad's coin crossing the same line (graduation.ts). */
  graduatedTs?: number;
  /** Read in batches soon after launch (untrusted token text); null until read. */
  name: string | null; symbol: string | null;
  /** Every transfer of the coin since its mint (lowercase addresses), for holders, early buyers and the deployer. */
  flows: Flow[];
}
export interface FeedEvent { id: string; kind: 'new_pair' | 'graduation' | 'trade'; coin: Address; ts: number; block: number; side?: 'buy' | 'sell'; hype?: number; wallet?: Address }

export interface TrackerOptions {
  /** Blocks replayed at start-up (default 32,400: about 53 minutes at ~98 ms blocks). */
  backfillBlocks?: number;
  /** Largest block span per eth_getLogs call; halved on a "too many logs" reply. */
  chunk?: number;
  /** Coins launched longer ago than this are forgotten (default 25 h: the 24 h outcome is measured first). */
  keepSec?: number;
  maxTradesPerCoin?: number;
  maxFlowsPerCoin?: number;
  blockTimeSec?: number;
  now?: () => number;
  /** Called once per new launch, as it is applied. */
  onLaunch?: (coin: CoinState) => void;
}

const hex = (n: bigint | number) => `0x${n.toString(16)}`;
const big = (h: Hex) => BigInt(h);

/**
 * Follows launches on Elysium in memory: Montra (TokenLaunched, Graduated), the Flaunch fork (PoolCreated, and its
 * PoolSwap for trades), HyperForge clones and the tax launchpad (launchpads.ts), every Swap on Uniswap's PoolManager for
 * a tracked pool, and every transfer of a tracked coin. Launch events come from one topic-filtered call (HyperForge
 * clones emit from many addresses); Montra's and the fork's are accepted only from their own contracts.
 * Nothing is persisted here; a restart replays the last `backfillBlocks` (EKO's memory keeps the rest: history.ts).
 */
export class Tracker {
  readonly coins = new Map<string, CoinState>();
  private readonly byPool = new Map<string, string>();
  readonly feed: FeedEvent[] = [];
  head = 0n; cursor = 0n; headTs = 0; lastSyncAt = 0;
  /** Montra's opening market cap in HYPE: the base of the graduation line for launchpads without one (graduation.ts). */
  openMcapHype = DEFAULT_OPEN_MCAP_HYPE;
  private chunk: number;
  private readonly opts: Required<Omit<TrackerOptions, 'chunk' | 'onLaunch'>>;
  private readonly onLaunch?: (coin: CoinState) => void;
  private readonly factory: Address; private readonly hook: Address; private readonly manager: Address;

  constructor(private readonly rpc: Rpc, private readonly registry: ElysiumRegistry, options: TrackerOptions = {}) {
    this.chunk = options.chunk ?? 2000;
    this.opts = { backfillBlocks: options.backfillBlocks ?? 32_400, keepSec: options.keepSec ?? 90_000, maxTradesPerCoin: options.maxTradesPerCoin ?? 5000, maxFlowsPerCoin: options.maxFlowsPerCoin ?? 20_000,
      blockTimeSec: options.blockTimeSec ?? 0.098, now: options.now ?? (() => Date.now() / 1000) };
    this.onLaunch = options.onLaunch;
    this.factory = registry.address('montra.factory'); this.hook = registry.address('montra.hook'); this.manager = registry.address('uniswapV4.poolManager');
  }

  coin(address: string): CoinState | undefined { return this.coins.get(address.toLowerCase()); }

  /** Coins saved before a restart (snapshot.ts), put back at start before the backfill runs. */
  private seeded: CoinState[] = [];
  restored = 0;
  seed(coins: CoinState[]) { this.seeded = coins; }

  async start(): Promise<void> {
    this.head = big(await this.rpc.request({ method: 'eth_blockNumber', params: [] }) as Hex);
    this.cursor = this.head > BigInt(this.opts.backfillBlocks) ? this.head - BigInt(this.opts.backfillBlocks) : 0n;
    this.restored = this.restore(this.seeded); this.seeded = [];
    await this.syncTo(this.head);
  }

  /**
   * Put back coins saved before a restart. The backfill replays every block after the cursor, so what a saved coin
   * recorded there is taken out first (it comes back once, from the logs). A coin launched after the cursor is left to
   * the backfill entirely, and one older than the memory keeps is dropped. Returns how many were restored.
   */
  restore(coins: CoinState[]): number {
    const cursor = Number(this.cursor), cutoff = this.opts.now() - this.opts.keepSec;
    let n = 0;
    for (const coin of coins) {
      const k = coin.token.toLowerCase();
      if (coin.block > cursor || coin.ts < cutoff || this.coins.has(k)) continue;
      for (const t of coin.trades) if (t.block > cursor) coin.netHype -= t.side === 'buy' ? t.hype : -t.hype;
      for (const f of coin.flows) if (f.block > cursor && coin.supplyFromMints && f.from === '0x0000000000000000000000000000000000000000') coin.supply -= f.value;
      coin.trades = coin.trades.filter(t => t.block <= cursor); coin.flows = coin.flows.filter(f => f.block <= cursor);
      // Graduation stays as saved: it is sticky, and the replay only skips a coin already graduated.
      this.coins.set(k, coin); this.byPool.set(coin.poolId.toLowerCase(), k); n++;
    }
    return n;
  }

  /** One poll: catch up to the current head. Safe to call repeatedly; a failed span is retried on the next tick. */
  async tick(): Promise<void> {
    // A start-up backfill that failed is retried, never replaced by a scan from block 0.
    if (this.cursor === 0n) return this.start();
    this.head = big(await this.rpc.request({ method: 'eth_blockNumber', params: [] }) as Hex);
    await this.syncTo(this.head);
    this.prune();
  }

  private async blockTs(block: bigint): Promise<number> {
    const b = await this.rpc.request({ method: 'eth_getBlockByNumber', params: [hex(block), false] }) as { timestamp: Hex } | null;
    if (!b) throw new Error('Block not found');
    return Number(big(b.timestamp));
  }

  private async logs(filter: { address?: Address | Address[]; topics: (Hex | Hex[])[] }, from: bigint, to: bigint): Promise<RawLog[]> {
    return await this.rpc.request({ method: 'eth_getLogs', params: [{ ...(filter.address ? { address: filter.address } : {}), topics: filter.topics, fromBlock: hex(from), toBlock: hex(to) }] }) as RawLog[];
  }

  private async syncTo(head: bigint) {
    while (this.cursor < head) {
      const from = this.cursor + 1n, to = from + BigInt(this.chunk) - 1n < head ? from + BigInt(this.chunk) - 1n : head;
      let launches: RawLog[], swaps: RawLog[], transfers: RawLog[];
      try {
        [launches, swaps, transfers] = await Promise.all([
          // Launches and graduations of every launchpad, and the Flaunch fork's PoolSwap trades: one topic-OR call.
          this.logs({ topics: [[LAUNCH_TOPIC, GRADUATED_TOPIC, ...LAUNCH_TOPICS, FLAUNCH_POOL_SWAP]] }, from, to),
          this.logs({ address: [this.manager, this.registry.address('unbrandedLauncher.poolManager')], topics: [SWAP_TOPIC] }, from, to),
          // Every ERC-20 transfer in the span (about three a block); only tracked coins are kept.
          this.logs({ topics: [TRANSFER_TOPIC] }, from, to),
        ]);
      } catch (error) {
        // Too many logs in the span: retry it smaller. Anything else is left for the next tick.
        if (this.chunk > 50 && /limit|too many|exceed|range|block range|not supported/i.test(String((error as Error).message))) { this.chunk = Math.floor(this.chunk / 2); continue; }
        throw error;
      }
      const endTs = await this.blockTs(to);
      const tsOf = (l: RawLog) => l.blockTimestamp ? Number(big(l.blockTimestamp)) : Math.round(endTs - Number(to - big(l.blockNumber)) * this.opts.blockTimeSec);
      this.applyAll([...launches, ...swaps, ...transfers], tsOf);
      this.cursor = to; this.headTs = endTs; this.lastSyncAt = this.opts.now();
      // A provider's span limit does not change between calls: keep the size that worked (free tiers allow ~100 blocks).
    }
  }

  /**
   * Apply logs in chain order, launches first: Montra logs the mint and the creator's first buy before TokenLaunched in
   * the same transaction. Also the historian's way in: a past coin's logs from the explorer rebuild it here.
   */
  applyAll(logs: RawLog[], tsOf: (l: RawLog) => number) {
    const order = (a: RawLog, b: RawLog) => Number(big(a.blockNumber) - big(b.blockNumber)) || Number(big(a.logIndex) - big(b.logIndex));
    const isLaunch = (l: RawLog) => l.topics[0] === LAUNCH_TOPIC || LAUNCH_TOPICS.includes(l.topics[0]!);
    for (const log of logs.filter(isLaunch).sort(order)) this.apply(log, tsOf(log));
    for (const log of logs.filter(l => !isLaunch(l)).sort(order)) this.apply(log, tsOf(log));
  }

  private apply(log: RawLog, ts: number) {
    const topic = log.topics[0], block = Number(big(log.blockNumber));
    if (topic === TRANSFER_TOPIC) {
      const coin = this.coins.get(log.address.toLowerCase());
      // ERC-20 only (three topics); an ERC-721 transfer has four.
      if (!coin || log.topics.length !== 3 || log.data.length < 66) return;
      const flow = { tx: log.transactionHash, block, ts, from: `0x${log.topics[1]!.slice(26)}`.toLowerCase(), to: `0x${log.topics[2]!.slice(26)}`.toLowerCase(), value: BigInt(log.data.slice(0, 66)) };
      coin.flows.push(flow);
      if (coin.supplyFromMints && flow.from === '0x0000000000000000000000000000000000000000') coin.supply += flow.value;
      if (coin.flows.length > this.opts.maxFlowsPerCoin) coin.flows.splice(0, coin.flows.length - this.opts.maxFlowsPerCoin);
      return;
    }
    if (topic === SWAP_TOPIC || topic === FLAUNCH_POOL_SWAP) {
      const key = this.byPool.get(log.topics[1]!.toLowerCase());
      const coin = key ? this.coins.get(key) : undefined;
      if (!coin) return;
      // A trade's amounts and price are in HYPE. A Montra coin quoted in another token would be read in the wrong unit
      // (and upside down when the coin sorts first in its pool), showing absurd prices and volume: its trades are left
      // out until that token is priced.
      if (coin.quote !== '0x0000000000000000000000000000000000000000') return;
      let trade: Trade | null;
      if (topic === FLAUNCH_POOL_SWAP) {
        // The fork's own record of the whole trade; only its hook may emit it.
        if (coin.launchpad !== 'flaunch' || log.address.toLowerCase() !== this.registry.address('flaunchFork.hook').toLowerCase()) return;
        const t = flaunchTrade(log.data, coin.flipped);
        trade = t ? { ts, block, tx: log.transactionHash, sender: getAddress(log.address), ...t } : null;
      } else {
        // A Flaunch-fork pool's Uniswap leg is part of its PoolSwap: counting it here would count it twice. A pool id is
        // only unique within its PoolManager: a swap counts only from the coin's own.
        if (coin.launchpad === 'flaunch' || log.address.toLowerCase() !== coin.manager.toLowerCase()) return;
        const { args } = decodeEventLog({ abi: swapAbi, topics: log.topics as [Hex, ...Hex[]], data: log.data });
        trade = tradeFromSwap({ amount0: coin.flipped ? args.amount1 : args.amount0, amount1: coin.flipped ? args.amount0 : args.amount1, sqrtPriceX96: args.sqrtPriceX96, sender: args.sender, tx: log.transactionHash, block, ts });
        if (!coin.flipped) coin.sqrtPriceX96 = args.sqrtPriceX96;
      }
      if (!trade) return;
      coin.trades.push(trade);
      if (coin.trades.length > this.opts.maxTradesPerCoin) coin.trades.splice(0, coin.trades.length - this.opts.maxTradesPerCoin);
      coin.netHype += trade.side === 'buy' ? trade.hype : -trade.hype;
      // A launchpad with no graduation of its own graduates when its market cap first reaches Montra's line (graduation.ts).
      if (coin.launchpad !== 'montra' && !coin.graduated && graduationBps(coin, this.openMcapHype) === 10_000) {
        coin.graduated = true; coin.graduatedTs = ts;
        this.push({ id: `grad:${log.transactionHash}:${big(log.logIndex)}`, kind: 'graduation', coin: coin.token, ts, block });
      }
      // A swap's sender is the router, not the wallet: buyers come from transfers (holders.ts).
      return;
    }
    if (LAUNCH_TOPICS.includes(topic!)) {
      const d = decodeLaunch(log, this.registry);
      if (!d || this.coins.has(d.token.toLowerCase())) return;
      const coin: CoinState = { launchpad: d.launchpad, key: d.key, flipped: d.flipped, supplyFromMints: d.supply === 0n, launcher: getAddress(log.address), manager: d.manager,
        token: d.token, creator: d.creator, poolId: d.poolId, quote: '0x0000000000000000000000000000000000000000', supply: d.supply, configId: 0n,
        firstBuyIn: 0n, firstBuyOut: 0n, feeRecipient: d.creator, feeLocked: false, block, ts, tx: log.transactionHash,
        trades: [], netHype: 0, sqrtPriceX96: null, graduated: false, name: d.name, symbol: d.symbol, flows: [] };
      this.coins.set(d.token.toLowerCase(), coin); this.byPool.set(d.poolId.toLowerCase(), d.token.toLowerCase());
      this.onLaunch?.(coin);
      this.push({ id: `launch:${log.transactionHash}:${big(log.logIndex)}`, kind: 'new_pair', coin: d.token, ts, block });
      return;
    }
    // Montra's launch and graduation events count only from Montra's own factory and hook.
    if ((topic === LAUNCH_TOPIC && log.address.toLowerCase() !== this.factory.toLowerCase()) || (topic === GRADUATED_TOPIC && log.address.toLowerCase() !== this.hook.toLowerCase())) return;
    const decoded = decodeMontraResult({ address: getAddress(log.address), topics: log.topics as [Hex, ...Hex[]], data: log.data }, {
      registry: this.registry,
      poolById: (id) => { const k = this.byPool.get(id.toLowerCase()); const c = k ? this.coins.get(k) : undefined;
        return c ? { token: c.token, quote: c.quote, feeBps: 0, liquidityUsd: 0, executable: false } : null; },
    });
    for (const e of decoded.events) {
      if (e.kind === 'launch' && e.poolId) {
        const coin: CoinState = { launchpad: 'montra', key: null, flipped: false, supplyFromMints: false, launcher: this.factory, manager: this.manager, token: e.token, creator: e.deployer, poolId: e.poolId, quote: e.quote!, supply: e.supply ?? 0n, configId: e.launchConfigId ?? 0n,
          firstBuyIn: e.firstBuyIn ?? 0n, firstBuyOut: e.firstBuyOut ?? 0n, feeRecipient: e.feeRecipient ?? e.deployer, feeLocked: e.feeLocked ?? false,
          block, ts, tx: log.transactionHash, trades: [], netHype: 0, sqrtPriceX96: null, graduated: false, name: null, symbol: null, flows: [],
          ...(e.startTick !== undefined && e.quoteIsCurrency0 !== undefined ? { openPrice: openPriceAt(e.startTick, e.quoteIsCurrency0) } : {}) };
        if (this.coins.has(e.token.toLowerCase())) continue;
        // The line in market cap for the other launchpads follows Montra's latest native-quoted opening.
        if (coin.openPrice && coin.quote === '0x0000000000000000000000000000000000000000' && coin.supply > 0n) this.openMcapHype = coin.openPrice * Number(coin.supply) / 1e18;
        this.coins.set(e.token.toLowerCase(), coin); this.byPool.set(e.poolId.toLowerCase(), e.token.toLowerCase());
        this.onLaunch?.(coin);
        this.push({ id: `launch:${log.transactionHash}:${big(log.logIndex)}`, kind: 'new_pair', coin: e.token, ts, block });
      } else if (e.kind === 'graduated') {
        const coin = this.coin(e.token);
        if (coin && !coin.graduated) { coin.graduated = true; coin.graduatedTs = ts; this.push({ id: `grad:${log.transactionHash}:${big(log.logIndex)}`, kind: 'graduation', coin: e.token, ts, block }); }
      }
    }
  }

  private push(event: FeedEvent) { this.feed.push(event); if (this.feed.length > 1000) this.feed.splice(0, this.feed.length - 1000); }

  private prune() {
    const cutoff = (this.headTs || this.opts.now()) - this.opts.keepSec;
    for (const [key, coin] of this.coins) if (coin.ts < cutoff) { this.coins.delete(key); this.byPool.delete(coin.poolId.toLowerCase()); }
  }
}
