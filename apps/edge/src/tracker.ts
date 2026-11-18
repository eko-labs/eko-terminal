import { decodeEventLog, zeroAddress, type Address, type Hex } from 'viem';
import type { ElysiumRegistry, V4PoolKey } from '@eko/chain';
import { tradeFromSwap, type Trade } from './market.js';
import { DEFAULT_OPEN_MCAP_HYPE } from './graduation.js';
import type { LaunchpadId } from './chains/elysium/launchpads.js';
import { chainOf } from './chains/elysium/index.js';
import { swapAbi, SWAP_TOPIC, TRANSFER_TOPIC } from './chains/logs.js';
import type { ChainAdapter, LogFilter, TrackerCore } from './chains/types.js';

export interface Rpc { request(input: { method: string; params: readonly unknown[] }): Promise<unknown> }
export interface RawLog { address: string; topics: Hex[]; data: Hex; blockNumber: Hex; transactionHash: Hex; logIndex: Hex; blockTimestamp?: Hex }

export { swapAbi, SWAP_TOPIC, TRANSFER_TOPIC };
export { LAUNCH_TOPIC, GRADUATED_TOPIC } from './chains/elysium/tracker.js';
/** A bonding-curve coin's pool id until it graduates (it has no v4 pool yet). */
export const NO_POOL = `0x${'0'.repeat(64)}` as Hex;

/** One token transfer of a tracked coin. */
export interface Flow { tx: Hex; block: number; ts: number; from: string; to: string; value: bigint }

export interface CoinState {
  /** Which launchpad launched it; Montra's own terms (config, fees) are read only for Montra coins. */
  launchpad: LaunchpadId | 'pons' | 'pangea';
  /** The pool key when the launch gave it (other launchpads); Montra coins read theirs from the hook. A bonding-curve
   *  coin has none (and a zero poolId, NO_POOL) until it graduates into its v4 pool. */
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
  /** A launchpad bonding curve's state before graduation (Pons): progress is realQuoteReserve over graduationThreshold.
   *  On graduation the coin gets its v4 key, poolId and manager, and the v4 Swap path takes over. */
  curve?: { address: Address; graduationThreshold: bigint; realQuoteReserve: bigint; realTokenReserve: bigint };
}
export interface FeedEvent { id: string; kind: 'new_pair' | 'graduation' | 'trade'; coin: Address; ts: number; block: number; side?: 'buy' | 'sell'; hype?: number; wallet?: Address }


export interface TrackerOptions {
  /** Blocks replayed at start-up (default about 53 minutes of the chain's blocks: 32,400 on Elysium). */
  backfillBlocks?: number;
  /** Largest block span per eth_getLogs call; halved on a "too many logs" reply. */
  chunk?: number;
  /** Coins launched longer ago than this are forgotten (default 25 h: the 24 h outcome is measured first). */
  keepSec?: number;
  /** A graduate with at least this much native currency traded in its last 24 hours outlives keepSec; 0 turns it off.
   *  Default: the chain profile's. */
  activeQuote24h?: number;
  maxTradesPerCoin?: number;
  maxFlowsPerCoin?: number;
  /** Default: the chain profile's. */
  blockTimeSec?: number;
  now?: () => number;
  /** RPC for reads of old history (graduates, active graduates, missing coins, rebase): it must not answer an old span
   *  from a provider that keeps only recent blocks. Default: the tracker's own. */
  archiveRpc?: Rpc;
  /** Called once per new launch, as it is applied. */
  onLaunch?: (coin: CoinState) => void;
}

/** The default start-up replay in seconds (32,400 blocks at Elysium's ~98 ms). */
export const BACKFILL_SEC = 3_175.2;
const hex = (n: bigint | number) => `0x${n.toString(16)}`;
/** A coin stays in memory for keepSec after its launch, or after its graduation when that came later (a coin can sit on
 *  its curve for days and graduate today: the Graduated column shows it for a day). */
const alive = (c: CoinState) => Math.max(c.ts, c.graduatedTs ?? 0);
/** Native currency a coin traded in the 24 hours before `nowSec`. */
export function quote24h(c: CoinState, nowSec: number): number {
  let sum = 0;
  for (let i = c.trades.length - 1; i >= 0 && c.trades[i]!.ts > nowSec - 86_400; i--) sum += c.trades[i]!.hype;
  return sum;
}
/** How often a running tracker looks for graduates still trading that it does not follow (chain.active). */
const ACTIVE_EVERY_SEC = 1800;
/** A start that restored fewer coins than this rebuilds the memory window's launches from the chain (chain.graduates). */
export const FULL_WARM_BELOW = 200;
const big = (h: Hex) => BigInt(h);

/**
 * Follows the chain's launches in memory: whatever its launchpads announce (the chain adapter's `topics` and `apply`;
 * chains/elysium/tracker.ts on Elysium), every Swap on its PoolManagers for a tracked pool, and every transfer of a
 * tracked coin. Nothing is persisted here; a restart replays the last `backfillBlocks` (EKO's memory keeps the rest:
 * history.ts).
 */
export class Tracker implements TrackerCore {
  readonly coins = new Map<string, CoinState>();
  /** Pool id (or a bonding curve's address) to coin. */
  private readonly byPool = new Map<string, string>();
  readonly feed: FeedEvent[] = [];
  head = 0n; cursor = 0n; headTs = 0; lastSyncAt = 0;
  /** Montra's opening market cap in HYPE: the base of the graduation line for launchpads without one (graduation.ts). */
  openMcapHype = DEFAULT_OPEN_MCAP_HYPE;
  readonly chain: ChainAdapter;
  private chunk: number;
  private readonly opts: Required<Omit<TrackerOptions, 'chunk' | 'onLaunch' | 'archiveRpc'>>;
  private readonly archive: Rpc;
  private readonly onLaunch?: (coin: CoinState) => void;

  constructor(private readonly rpc: Rpc, chain: ChainAdapter | ElysiumRegistry, options: TrackerOptions = {}) {
    this.chain = chainOf(chain);
    const blockTimeSec = options.blockTimeSec ?? this.chain.profile.blockTimeSec;
    this.chunk = options.chunk ?? this.chain.profile.tracker.chunk;
    this.opts = { backfillBlocks: options.backfillBlocks ?? this.chain.profile.tracker.backfillBlocks ?? Math.round(BACKFILL_SEC / blockTimeSec), keepSec: options.keepSec ?? 90_000,
      activeQuote24h: options.activeQuote24h ?? this.chain.profile.tracker.activeQuote24h ?? 0, maxTradesPerCoin: options.maxTradesPerCoin ?? 5000,
      maxFlowsPerCoin: options.maxFlowsPerCoin ?? 20_000, blockTimeSec, now: options.now ?? (() => Date.now() / 1000) };
    this.onLaunch = options.onLaunch;
    this.archive = options.archiveRpc ?? rpc;
  }

  coin(address: string): CoinState | undefined { return this.coins.get(address.toLowerCase()); }
  coinByPool(id: string): CoinState | undefined { const k = this.byPool.get(id.toLowerCase()); return k ? this.coins.get(k) : undefined; }
  link(id: string, coin: CoinState) { if (id.toLowerCase() !== NO_POOL) this.byPool.set(id.toLowerCase(), coin.token.toLowerCase()); }
  private index(coin: CoinState) { this.link(coin.poolId, coin); if (coin.curve) this.link(coin.curve.address, coin); }
  private unlink(coin: CoinState) { this.byPool.delete(coin.poolId.toLowerCase()); if (coin.curve) this.byPool.delete(coin.curve.address.toLowerCase()); }

  /** Coins saved before a restart (snapshot.ts), put back at start before the backfill runs. */
  private seeded: CoinState[] = [];
  restored = 0;
  /** Restored coins whose saved trades reach into the replayed span (chain.rebase resets their running balances). */
  private replayed: CoinState[] = [];
  seed(coins: CoinState[]) { this.seeded = coins; }

  async start(): Promise<void> {
    this.head = big(await this.rpc.request({ method: 'eth_blockNumber', params: [] }) as Hex);
    this.cursor = this.head > BigInt(this.opts.backfillBlocks) ? this.head - BigInt(this.opts.backfillBlocks) : 0n;
    const seeded = this.seeded; this.seeded = [];
    this.restored = this.restore(seeded);
    // Only coins that traded inside the replayed span carry balances the replay would count twice.
    if (this.replayed.length && this.chain.rebase) await this.chain.rebase(this.replayed, this.cursor, this.archive);
    // Coins that graduated within the memory window but before this start (none restored for them): their whole history.
    if (this.chain.graduates && this.cursor > 0n) {
      const span = BigInt(Math.round(this.opts.keepSec / this.opts.blockTimeSec)), from = this.cursor > span ? this.cursor - span : 0n;
      try {
        // The whole window's launches only when the snapshot was missing or nearly empty (a first start, a lost volume):
        // otherwise the snapshot already holds them and the rebuild would only slow the restart.
        const logs = await this.chain.graduates(this.archive, from, this.cursor, (token) => this.coins.has(token.toLowerCase()), { coins: this.restored < FULL_WARM_BELOW });
        if (logs.length) {
          const refTs = await this.blockTs(this.cursor);
          this.applyAll(logs, (l) => l.blockTimestamp && big(l.blockTimestamp) > 0n ? Number(big(l.blockTimestamp)) : Math.round(refTs - Number(this.cursor - big(l.blockNumber)) * this.opts.blockTimeSec));
          this.prune();
        }
      } catch { /* The column fills as coins graduate; a failed look-back only leaves it emptier. */ }
    }
    // The lookup for graduates still trading (findActive) starts on the first tick, after this replay: run beside it,
    // it shares the metered RPC and slowed the restart from ~70 s to ~170 s.
    await this.syncTo(this.head);
  }

  /** A coin stays while it is inside the memory window, or graduated and still trading (activeQuote24h). */
  private kept(c: CoinState, cutoff: number, nowSec: number): boolean {
    return alive(c) >= cutoff || (c.graduated && this.opts.activeQuote24h > 0 && quote24h(c, nowSec) >= this.opts.activeQuote24h);
  }

  private activeAt = 0;
  private activeRun: Promise<void> | null = null;
  private activeFound: { logs: RawLog[]; to: bigint }[] = [];
  /** Look for graduates still trading that EKO does not follow (chain.active), in the background: the lookup reads each
   *  one's whole history and can take many minutes, so the tracker keeps syncing and applies each coin on the tick after
   *  its history is read (a restart midway keeps the coins already applied: the snapshot saves them). */
  private findActive(to: bigint): void {
    if (!this.chain.active || this.opts.activeQuote24h <= 0 || to === 0n || this.activeRun) return;
    this.activeAt = this.opts.now();
    const span = BigInt(Math.round(86_400 / this.opts.blockTimeSec)), from = to > span ? to - span : 0n;
    this.activeRun = this.chain.active(this.archive, from, to, { token: (t) => this.coins.has(t.toLowerCase()), pool: (id) => this.byPool.has(id.toLowerCase()) }, this.opts.activeQuote24h, (logs) => { this.activeFound.push({ logs, to }); })
      .catch(() => { /* tried again on the next round; the column only misses the older active graduates meanwhile */ })
      .finally(() => { this.activeRun = null; });
  }
  /** Apply each coin the lookup has read so far (its logs end at `to`), then its swaps and transfers since `to`. */
  private async applyActive(): Promise<void> {
    for (const found of this.activeFound.splice(0)) await this.applyOneActive(found);
  }
  private async applyOneActive(found: { logs: RawLog[]; to: bigint }): Promise<void> {
    const before = new Set(this.coins.keys()), refTs = this.headTs, cursor = this.cursor;
    const stamp = (l: RawLog) => l.blockTimestamp && big(l.blockTimestamp) > 0n ? Number(big(l.blockTimestamp)) : Math.round(refTs - Number(cursor - big(l.blockNumber)) * this.opts.blockTimeSec);
    this.applyAll(found.logs, stamp);
    const fresh = [...this.coins.values()].filter(c => !before.has(c.token.toLowerCase()) && c.graduated);
    if (!fresh.length || cursor <= found.to) return;
    try {
      const [swaps, transfers] = await Promise.all([
        this.logs({ address: this.chain.swapManagers, topics: [SWAP_TOPIC, fresh.map(c => c.poolId as Hex)] }, found.to + 1n, cursor, this.archive),
        this.logs({ address: fresh.map(c => c.token as Address), topics: [TRANSFER_TOPIC] }, found.to + 1n, cursor, this.archive),
      ]);
      this.applyAll([...swaps, ...transfers], stamp);
    } catch { /* the coins' next trades still arrive; only the minutes the lookup took are missing from their history */ }
  }

  /**
   * Put back coins saved before a restart. The backfill replays every block after the cursor, so what a saved coin
   * recorded there is taken out first (it comes back once, from the logs). A coin launched after the cursor is left to
   * the backfill entirely, and one older than the memory keeps is dropped. Returns how many were restored.
   */
  restore(coins: CoinState[]): number {
    const cursor = Number(this.cursor), now = this.opts.now(), cutoff = now - this.opts.keepSec;
    let n = 0;
    for (const coin of coins) {
      const k = coin.token.toLowerCase();
      if (coin.block > cursor || !this.kept(coin, cutoff, now) || this.coins.has(k)) continue;
      for (const t of coin.trades) if (t.block > cursor) coin.netHype -= t.side === 'buy' ? t.hype : -t.hype;
      for (const f of coin.flows) if (f.block > cursor && coin.supplyFromMints && f.from === '0x0000000000000000000000000000000000000000') coin.supply -= f.value;
      if (coin.trades.some(t => t.block > cursor)) this.replayed.push(coin);
      coin.trades = coin.trades.filter(t => t.block <= cursor); coin.flows = coin.flows.filter(f => f.block <= cursor);
      // Graduation stays as saved: it is sticky, and the replay only skips a coin already graduated.
      this.coins.set(k, coin); this.index(coin); n++;
    }
    return n;
  }

  /** One poll: catch up to the current head. Safe to call repeatedly; a failed span is retried on the next tick. */
  async tick(): Promise<void> {
    // A start-up backfill that failed is retried, never replaced by a scan from block 0.
    if (this.cursor === 0n) return this.start();
    this.head = big(await this.rpc.request({ method: 'eth_blockNumber', params: [] }) as Hex);
    await this.syncTo(this.head);
    if (this.chain.missing) {
      try {
        const logs = await this.chain.missing(this.archive, this.cursor, (token) => this.coins.has(token.toLowerCase()));
        if (logs.length) this.applyAll(logs, (l) => l.blockTimestamp && big(l.blockTimestamp) > 0n ? Number(big(l.blockTimestamp)) : Math.round(this.headTs - Number(this.cursor - big(l.blockNumber)) * this.opts.blockTimeSec));
      } catch { /* retried with the next graduation it sees; the coin otherwise ages in normally */ }
    }
    await this.applyActive();
    if (this.opts.now() - this.activeAt >= ACTIVE_EVERY_SEC) this.findActive(this.cursor);
    this.prune();
  }

  private async blockTs(block: bigint): Promise<number> {
    const b = await this.rpc.request({ method: 'eth_getBlockByNumber', params: [hex(block), false] }) as { timestamp: Hex } | null;
    if (!b) throw new Error('Block not found');
    return Number(big(b.timestamp));
  }

  private async logs(filter: LogFilter, from: bigint, to: bigint, rpc: Rpc = this.rpc): Promise<RawLog[]> {
    return await rpc.request({ method: 'eth_getLogs', params: [{ ...(filter.address ? { address: filter.address } : {}), topics: filter.topics, fromBlock: hex(from), toBlock: hex(to) }] }) as RawLog[];
  }

  private async syncTo(head: bigint) {
    while (this.cursor < head) {
      const from = this.cursor + 1n, to = from + BigInt(this.chunk) - 1n < head ? from + BigInt(this.chunk) - 1n : head;
      let launches: RawLog[], swaps: RawLog[], transfers: RawLog[];
      try {
        [launches, swaps, transfers] = await Promise.all([
          // The chain's launches, graduations and launchpad trade records (on Elysium one topic-OR call).
          Promise.all(this.chain.queries.map(q => this.logs(q, from, to))).then(r => r.flat()),
          this.logs({ address: this.chain.swapManagers, topics: [SWAP_TOPIC] }, from, to),
          // Every ERC-20 transfer in the span (three to eight a block); only tracked coins are kept.
          this.logs({ topics: [TRANSFER_TOPIC] }, from, to),
        ]);
      } catch (error) {
        // Too many logs in the span: retry it smaller. Anything else is left for the next tick, a rate limit included: a
        // 429 ("Too Many Requests", the meter's provider_quota_exceeded) says nothing about the span, and halving on it
        // left the span at 62 blocks for good on Robinhood Chain's public RPC.
        const message = String((error as Error).message);
        if (this.chunk > 50 && !/quota|rate.?limit|too many requests|429/i.test(message) && /limit|too many|exceed|range|block range|not supported/i.test(message)) { this.chunk = Math.floor(this.chunk / 2); continue; }
        throw error;
      }
      const endTs = await this.blockTs(to);
      // A zero blockTimestamp is a missing one, never epoch 0 (Robinhood Chain's public RPC sends 0x0 on logs).
      const tsOf = (l: RawLog) => l.blockTimestamp && big(l.blockTimestamp) > 0n ? Number(big(l.blockTimestamp)) : Math.round(endTs - Number(to - big(l.blockNumber)) * this.opts.blockTimeSec);
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
    const isLaunch = (l: RawLog) => this.chain.isLaunch(l);
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
    if (topic === SWAP_TOPIC) {
      const coin = this.coinByPool(log.topics[1]!);
      if (!coin) return;
      // A trade's amounts and price are in the native coin. A coin quoted in another token would be read in the wrong unit
      // (and upside down when the coin sorts first in its pool), showing absurd prices and volume: its trades are left
      // out until that token is priced. And a swap counts only where the chain says it does (its own PoolManager).
      if (coin.quote !== zeroAddress || !this.chain.countsSwap(coin, log)) return;
      const { args } = decodeEventLog({ abi: swapAbi, topics: log.topics as [Hex, ...Hex[]], data: log.data });
      const trade = tradeFromSwap({ amount0: coin.flipped ? args.amount1 : args.amount0, amount1: coin.flipped ? args.amount0 : args.amount1, sqrtPriceX96: args.sqrtPriceX96, sender: args.sender, tx: log.transactionHash, block, ts });
      if (!coin.flipped) coin.sqrtPriceX96 = args.sqrtPriceX96;
      // A swap's sender is the router, not the wallet: buyers come from transfers (holders.ts).
      if (trade) this.trade(coin, trade, log);
      return;
    }
    // Launches, graduations and launchpads' own trade records.
    this.chain.apply(log, ts, this);
  }

  launch(coin: CoinState, log: RawLog): boolean {
    const k = coin.token.toLowerCase();
    if (this.coins.has(k)) return false;
    this.coins.set(k, coin); this.index(coin);
    this.onLaunch?.(coin);
    this.push({ id: `launch:${log.transactionHash}:${big(log.logIndex)}`, kind: 'new_pair', coin: coin.token, ts: coin.ts, block: coin.block });
    return true;
  }

  trade(coin: CoinState, trade: Trade, log: RawLog) {
    coin.trades.push(trade);
    if (coin.trades.length > this.opts.maxTradesPerCoin) coin.trades.splice(0, coin.trades.length - this.opts.maxTradesPerCoin);
    coin.netHype += trade.side === 'buy' ? trade.hype : -trade.hype;
    if (!coin.graduated && this.chain.graduatesOnTrade(coin, this.openMcapHype)) this.graduate(coin, trade.ts, log);
  }

  graduate(coin: CoinState, ts: number, log: RawLog) {
    if (coin.graduated) return;
    coin.graduated = true; coin.graduatedTs = ts;
    this.push({ id: `grad:${log.transactionHash}:${big(log.logIndex)}`, kind: 'graduation', coin: coin.token, ts, block: Number(big(log.blockNumber)) });
  }

  private push(event: FeedEvent) { this.feed.push(event); if (this.feed.length > 1000) this.feed.splice(0, this.feed.length - 1000); }

  private prune() {
    const now = this.headTs || this.opts.now(), cutoff = now - this.opts.keepSec;
    for (const [key, coin] of this.coins) if (!this.kept(coin, cutoff, now)) { this.coins.delete(key); this.unlink(coin); }
  }
}
