import type { Address, Hex } from 'viem';
import type { ElysiumRegistry } from '@eko/chain';
import { judge, excludedFor, type Probed } from './assess.js';
import type { Explorer, ExplorerLog } from './explorer.js';
import type { FunderTracer } from './funders.js';
import type { HistoryStore } from './history.js';
import { FEATURE_POINTS, featuresAt, HORIZON_SEC, outcomeAt } from './outcomes.js';
import { LAUNCH_TOPIC, SWAP_TOPIC, TRANSFER_TOPIC, Tracker, type CoinState, type RawLog, type Rpc } from './tracker.js';

/**
 * The background historian. Three jobs, each resumable from a cursor in the history store, all on the free explorer
 * (never the RPC the live tracker depends on):
 * 1. launches: every Montra launch since the factory's first, recorded with its deployer and pool;
 * 2. swaps: a running count of swaps per Montra pool (one pass over Uniswap's PoolManager Swap logs, then kept current),
 *    which says which launches had real trading;
 * 3. replay: each launch with at least `minSwaps` swaps, a day old, without a 24 h outcome and not in the live tracker's
 *    memory is rebuilt from its own logs (its pool's swaps and its token's transfers for the first day), then gets its
 *    features, outcomes and a replayed verdict (flow checks only: there is no historical sell probe).
 * The live service records the same things for coins it watched from launch; the historian fills everything else,
 * including the days before EKO started and the gaps of a restart.
 */
export interface HistorianOptions {
  minSwaps?: number;
  /** First block to scan (the Montra factory's deployment). */
  fromBlock?: number;
  blockTimeSec?: number;
  replayBatch?: number;
  now?: () => number;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

const LAUNCH_CURSOR = 'historian.launches.block', SWAP_CURSOR = 'historian.swaps.block';
/** Blocks of PoolManager swaps counted per pass (about 7 hours of chain). */
const SWAP_WINDOW = 250_000;

export class Historian {
  readonly counters = { launches: 0, swapsCounted: 0, replayed: 0, failures: 0 };
  private stopped = false;
  private readonly o: Required<Omit<HistorianOptions, 'log'>> & Pick<HistorianOptions, 'log'>;

  constructor(private readonly explorer: Explorer, private readonly store: HistoryStore, private readonly registry: ElysiumRegistry,
    private readonly live: { tracker: Tracker; funders?: FunderTracer }, options: HistorianOptions = {}) {
    this.o = { minSwaps: options.minSwaps ?? 10, fromBlock: options.fromBlock ?? 580_000, blockTimeSec: options.blockTimeSec ?? 0.098, replayBatch: options.replayBatch ?? 25,
      now: options.now ?? (() => Date.now()), log: options.log };
  }

  stop() { this.stopped = true; }
  status() {
    return { ...this.counters, launchesThrough: Number(this.store.meta(LAUNCH_CURSOR) ?? 0), swapsThrough: Number(this.store.meta(SWAP_CURSOR) ?? 0), explorerCalls: this.explorer.calls };
  }

  /** Run forever: each pass advances every job a bounded step; it sleeps only once the jobs have caught up. */
  async run(intervalMs = 60_000) {
    while (!this.stopped) {
      let behind = false;
      try { behind = await this.step(); }
      catch (error) { this.counters.failures++; this.o.log?.('historian_failed', { error: String((error as Error).message).slice(0, 200) }); }
      await new Promise(r => setTimeout(r, behind ? 1000 : intervalMs));
    }
  }

  /** One pass of every job; true while the swap count is still catching up (exported for tests). */
  async step(): Promise<boolean> {
    const head = Number(this.live.tracker.head);
    if (!head) return false;
    await this.launches(head);
    // The swap count advances a window per pass so replays of the launches it has counted start early.
    const through = await this.swaps(Math.min(head, Number(this.store.meta(SWAP_CURSOR) ?? this.o.fromBlock) + SWAP_WINDOW));
    const replayed = await this.replay();
    // Behind while the swap count trails the head or a full batch of replays was due (more are likely waiting).
    return through < head - 1000 || replayed >= this.o.replayBatch;
  }

  private tsOf = (l: RawLog) => l.blockTimestamp ? Number(BigInt(l.blockTimestamp)) : Math.floor(this.o.now() / 1000);

  async launches(head: number) {
    const from = Number(this.store.meta(LAUNCH_CURSOR) ?? this.o.fromBlock);
    if (from >= head) return;
    // A scratch tracker decodes the launch logs (it is never polled).
    const scratch = new Tracker(nullRpc, this.registry, { onLaunch: (c) => this.recordLaunch(c) });
    await this.explorer.logs({ address: this.registry.address('montra.factory'), topic0: LAUNCH_TOPIC }, from, head, (page, through) => {
      this.store.tx(() => { scratch.applyAll(page as RawLog[], this.tsOf); this.store.setMeta(LAUNCH_CURSOR, through); });
      scratch.coins.clear();
    });
    this.store.setMeta(LAUNCH_CURSOR, head);
  }

  private recordLaunch(c: CoinState) {
    this.store.recordLaunch({ token: c.token, launchpad: c.launchpad, deployer: c.creator, poolId: c.poolId, createdBlock: c.block, createdTs: c.ts, tx: c.tx, name: c.name, symbol: c.symbol, supply: c.supply.toString() });
    this.counters.launches++;
  }

  async swaps(head: number): Promise<number> {
    const from = Number(this.store.meta(SWAP_CURSOR) ?? this.o.fromBlock);
    if (from >= head) return from;
    const pools = new Map(this.store.query<{ pool_id: string; token: string }>('SELECT pool_id, token FROM launches WHERE pool_id IS NOT NULL').map(r => [r.pool_id, r.token]));
    await this.explorer.logs({ address: this.registry.address('uniswapV4.poolManager'), topic0: SWAP_TOPIC }, from, head, (page, through) => {
      const counts = new Map<string, number>();
      for (const l of page) { const token = pools.get(String(l.topics[1]).toLowerCase()); if (token) counts.set(token, (counts.get(token) ?? 0) + 1); }
      this.store.tx(() => {
        for (const [token, n] of counts) this.store.query('UPDATE launches SET swaps=coalesce(swaps,0)+? WHERE token=?', n, token);
        this.store.setMeta(SWAP_CURSOR, through);
      });
      this.counters.swapsCounted += page.length;
      if (this.stopped) throw new Error('stopped');
    });
    this.store.setMeta(SWAP_CURSOR, head);
    return head;
  }

  /** Launches due a replay: enough swaps, older than a day plus ten minutes, no 24 h outcome, not followed live. */
  due(limit: number) {
    const cutoff = Math.floor(this.o.now() / 1000) - HORIZON_SEC['24h'] - 600;
    return this.store.query<{ token: string; pool_id: string; created_block: number; created_ts: number }>(`SELECT l.token, l.pool_id, l.created_block, l.created_ts FROM launches l
      WHERE l.swaps >= ? AND l.created_ts <= ? AND l.pool_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM outcomes o WHERE o.token = l.token AND o.horizon = '24h')
      AND NOT EXISTS (SELECT 1 FROM meta m WHERE m.key = 'replay.skip.' || l.token)
      ORDER BY l.created_ts DESC LIMIT ?`, this.o.minSwaps, cutoff, limit * 3).filter(r => !this.live.tracker.coins.has(r.token)).slice(0, limit);
  }

  async replay(): Promise<number> {
    const due = this.due(this.o.replayBatch);
    for (const row of due) {
      if (this.stopped) return due.length;
      try { await this.replayOne(row.token as Address, row.pool_id as Hex, row.created_block); this.counters.replayed++; }
      catch (error) {
        this.counters.failures++;
        this.o.log?.('replay_failed', { coin: row.token, error: String((error as Error).message).slice(0, 160) });
        // A coin that cannot be rebuilt is not retried on every pass.
        this.store.setMeta(`replay.skip.${row.token}`, Math.floor(this.o.now() / 1000));
      }
    }
    return due.length;
  }

  /** Rebuild one launch's first day from the explorer and record what it measures. */
  async replayOne(token: Address, poolId: Hex, createdBlock: number): Promise<CoinState | null> {
    // Blocks are about 98 ms but vary: read 20% past the day so the 24 h horizon is always covered (coinAt trims by time).
    const end = createdBlock + Math.ceil((HORIZON_SEC['24h'] * 1.2) / this.o.blockTimeSec);
    const launch = (await this.explorer.logs({ address: this.registry.address('montra.factory'), topic0: LAUNCH_TOPIC }, createdBlock, createdBlock))
      .filter(l => l.data.length > 2);
    const [swaps, transfers] = [
      await this.explorer.logs({ address: this.registry.address('uniswapV4.poolManager'), topic0: SWAP_TOPIC, topic1: poolId }, createdBlock, end),
      await this.explorer.logs({ address: token, topic0: TRANSFER_TOPIC as Hex }, createdBlock, end),
    ];
    const scratch = new Tracker(nullRpc, this.registry);
    scratch.applyAll([...launch, ...swaps, ...transfers] as RawLog[], this.tsOf);
    const coin = scratch.coin(token);
    if (!coin) throw new Error('launch log not found');
    this.measure(coin, 'replay');
    return coin;
  }

  /**
   * Record features, outcomes and (for replays) a verdict for a coin whose first day is in hand. Shared with the live
   * service, which calls it as each point in time passes.
   */
  measure(coin: CoinState, source: 'live' | 'replay', tips: Record<string, number> = {}, nowSec = Math.floor(this.o.now() / 1000)) {
    const excluded = excludedFor(this.registry, coin), age = nowSec - coin.ts;
    const stored = this.store.launch(coin.token);
    const honeypot = !!stored?.matches.some(m => m.id === 'honeypot' && m.level === 'danger');
    this.store.tx(() => {
      for (const at of FEATURE_POINTS) if (age >= at && coin.trades.length >= 2) this.store.recordFeatures(coin.token, at, featuresAt(coin, at, excluded, tips));
      for (const h of ['1h', '24h'] as const) {
        if (age < HORIZON_SEC[h]) continue;
        const o = outcomeAt(coin, h, excluded, honeypot, (w) => this.store.attributedFunder(w));
        if (o) this.store.recordOutcome(coin.token, h, o.outcome, nowSec, o.detail);
      }
      if (source === 'replay') {
        // What the flow checks said an hour in (the honeypot probe cannot be replayed).
        const atHour: Probed = { block: coin.block, at: new Date((coin.ts + 3600) * 1000).toISOString(), name: coin.name ?? '', symbol: coin.symbol ?? '', key: null, config: null,
          currentBuyFeePips: null, probe: null, probeUsd: 0, tips };
        const hour = { ...coin, trades: coin.trades.filter(t => t.ts <= coin.ts + 3600), flows: coin.flows.filter(f => f.ts <= coin.ts + 3600) };
        const a = judge(hour, atHour, { registry: this.registry, hypeUsd: null, nowSec: coin.ts + 3600, head: coin.block,
          history: this.store.historyFor(coin.creator, coin.ts), funders: (w) => this.store.attributedFunder(w) });
        this.store.recordVerdict(coin.token, a.verdict.level, a.matches.map(m => ({ id: m.id, level: m.level })), coin.ts + 3600, 'replay');
      }
    });
  }
}

/** The scratch trackers never call the chain. */
const nullRpc: Rpc = { request: async () => { throw new Error('scratch tracker has no RPC'); } };
export type { ExplorerLog };
