import type { ElysiumRegistry } from '@eko/chain';
import { judge, probeCoin, readNames, type Assessment, type Probed } from './assess.js';
import type { HypeUsd } from './hype.js';
import type { CoinState, Rpc, Tracker } from './tracker.js';
import type { HistoryStore } from './history.js';
import type { Historian } from './historian.js';
import type { FunderTracer } from './funders.js';
import { FEATURE_POINTS, HORIZON_SEC } from './outcomes.js';
import type { ViewContext } from './views.js';

export interface EdgeOptions {
  /** Re-check a coin no more often than this (default 10 minutes; the first check runs as soon as it launches). */
  recheckSec?: number;
  /** Checks in flight at once (each is two eth_calls). */
  concurrency?: number;
  now?: () => number;
  log?: (event: string, fields: Record<string, unknown>) => void;
  /** EKO's memory: launches, verdicts, outcomes and funders. Without it the edge is stateless (no deployer history). */
  memory?: { store: HistoryStore; historian: Historian; funders: FunderTracer };
}

/** When a live coin is measured: features at five minutes and an hour (with the 1 h outcome), the 24 h outcome a minute late. */
const MEASURE_AT = [FEATURE_POINTS[0], Math.max(FEATURE_POINTS[1], HORIZON_SEC['1h']), HORIZON_SEC['24h'] + 60];

/**
 * The edge's state: the tracker, the cached probes (the only paid part of a check), and a small queue that probes new
 * launches first. Verdicts are recomputed from each coin's transfers whenever it trades, without another RPC call.
 * Requests for a coin page also enqueue (and await) a probe when the cached one is stale.
 */
export class Edge {
  readonly probes = new Map<string, Probed>();
  private readonly judged = new Map<string, { key: string; a: Assessment }>();
  private readonly inFlight = new Map<string, Promise<Assessment | null>>();
  private readonly queue: string[] = [];
  private readonly queued = new Set<string>();
  private running = 0;
  /** Per coin: when a failed check may be retried, and how many failed in a row (backoff doubles to 30 minutes). */
  private readonly failed = new Map<string, { until: number; n: number }>();
  /** Per coin: its trade count when last probed (a coin nobody traded since needs no scheduled re-check). */
  private readonly probedTrades = new Map<string, number>();
  /** All checks wait until then after the RPC provider reports its quota spent. */
  private pausedUntil = 0;
  readonly counters = { assessed: 0, honeypotsRefused: 0, failures: 0, startedAt: new Date().toISOString() };
  private readonly opts: Required<Omit<EdgeOptions, 'log' | 'memory'>> & Pick<EdgeOptions, 'log' | 'memory'>;
  /** Per live coin, how many of MEASURE_AT have been recorded. */
  private readonly measured = new Map<string, number>();

  constructor(readonly tracker: Tracker, private readonly rpc: Rpc, private readonly registry: ElysiumRegistry, readonly hype: HypeUsd, options: EdgeOptions = {}) {
    this.opts = { recheckSec: options.recheckSec ?? 600, concurrency: options.concurrency ?? 2, now: options.now ?? (() => Date.now()), log: options.log, memory: options.memory };
  }

  ctx(): ViewContext { return { nowSec: Math.floor(this.opts.now() / 1000), head: Number(this.tracker.head), hypeUsd: this.hype.latest, openMcapHype: this.tracker.openMcapHype }; }
  /** The coin's verdict now: memoised until it trades or transfers, the HYPE price moves or a minute passes. */
  assessment(token: string): Assessment | undefined {
    const k = token.toLowerCase(), probed = this.probes.get(k), coin = this.tracker.coins.get(k);
    if (!probed || !coin) return undefined;
    // Time-based checks matter most in a coin's first hour: past it, a verdict is recomputed every 10 minutes at most.
    const ctx = this.ctx(), bucket = ctx.nowSec - coin.ts < 3600 ? 60 : 600;
    const memo = `${probed.at}:${coin.flows.length}:${coin.trades.length}:${ctx.hypeUsd}:${Math.floor(ctx.nowSec / bucket)}`;
    const hit = this.judged.get(k);
    if (hit?.key === memo) return hit.a;
    const store = this.opts.memory?.store;
    const a = judge(coin, probed, { registry: this.registry, hypeUsd: ctx.hypeUsd, nowSec: ctx.nowSec, head: ctx.head,
      ...(store ? { history: store.historyFor(coin.creator, coin.ts), funders: (w: string) => store.attributedFunder(w) } : {}) });
    this.judged.set(k, { key: memo, a });
    return a;
  }
  /** Coins with at least one probe. */
  get assessedCount() { return this.probes.size; }

  private stale(token: string) {
    const k = token.toLowerCase(), p = this.probes.get(k);
    if (!p) return true;
    if (this.opts.now() / 1000 - Date.parse(p.at) / 1000 > this.opts.recheckSec) return true;
    // A probe that could not run, or one taken inside Montra's early-buy window, is retried once it can say more.
    return !p.probe || p.probe.status === 'unavailable' || (!!p.config && p.config.earlyBuyFeeUntil > Date.parse(p.at) / 1000 && p.config.earlyBuyFeeUntil < this.opts.now() / 1000);
  }

  /**
   * Whether the background scheduler should check a coin: never checked, a probe that could not run, Montra's early-buy
   * window just ended, or the time-based recheck for a coin that traded since its last probe (a dead coin keeps its
   * probe; a coin page still asks for a fresh one). Failed checks wait out their backoff.
   */
  private due(token: string, nowMs: number) {
    const k = token.toLowerCase(), f = this.failed.get(k);
    if (f && f.until > nowMs) return false;
    if (!this.stale(k)) return false;
    const p = this.probes.get(k), coin = this.tracker.coins.get(k);
    if (!p || !p.probe || p.probe.status === 'unavailable') return true;
    if (p.config && p.config.earlyBuyFeeUntil > Date.parse(p.at) / 1000 && p.config.earlyBuyFeeUntil < nowMs / 1000) return true;
    return !!coin && coin.trades.length !== (this.probedTrades.get(k) ?? 0);
  }

  /** Queue every tracked coin that needs a check, newest launches first. */
  schedule() {
    const nowMs = this.opts.now();
    const due = [...this.tracker.coins.values()].filter(c => { const k = c.token.toLowerCase(); return !this.queued.has(k) && !this.inFlight.has(k) && this.due(k, nowMs); })
      .sort((a, b) => b.ts - a.ts).map(c => c.token.toLowerCase());
    for (const k of due) { this.queue.push(k); this.queued.add(k); }
    this.pump();
  }

  private pump() {
    if (this.opts.now() < this.pausedUntil) return;
    while (this.running < this.opts.concurrency && this.queue.length) {
      const token = this.queue.shift()!;
      this.queued.delete(token);
      const coin = this.tracker.coins.get(token);
      if (!coin || !this.due(token, this.opts.now())) continue;
      this.running++;
      void this.check(coin).finally(() => { this.running--; this.pump(); });
    }
  }

  /** One more miss for this coin: the next try waits 1, 2, 4… minutes, at most 30. */
  private backOff(key: string, nowMs: number) {
    const n = (this.failed.get(key)?.n ?? 0) + 1;
    this.failed.set(key, { until: nowMs + Math.min(30 * 60_000, 60_000 * 2 ** (n - 1)), n });
  }

  /** Check one coin now (deduplicated with any check already running for it). */
  check(coin: CoinState): Promise<Assessment | null> {
    const key = coin.token.toLowerCase();
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const job = (async () => {
      try {
        const prior = this.assessment(key);
        const probed = await probeCoin(coin, this.tracker.head, { rpc: this.rpc, registry: this.registry, hypeUsd: () => this.hype.latest, now: this.opts.now },
          this.probes.get(key)?.tips);
        this.probes.set(key, probed); this.counters.assessed++;
        this.probedTrades.set(key, coin.trades.length);
        // A check whose sell test could not run is due again at once (stale), so it waits out the failure backoff
        // instead: retrying it every tick spent the paid RPC budget on the same unanswerable coins.
        if (!probed.probe || probed.probe.status === 'unavailable') this.backOff(key, this.opts.now());
        else this.failed.delete(key);
        const a = this.assessment(key)!;
        this.remember(coin, a);
        const honeypot = (x?: Assessment) => !!x?.verdict.playbooks.some(m => m.id === 'honeypot' && m.level === 'danger');
        if (honeypot(a) && !honeypot(prior)) this.counters.honeypotsRefused++;
        return a;
      } catch (error) {
        this.counters.failures++;
        const message = String((error as Error).message), nowMs = this.opts.now();
        this.backOff(key, nowMs);
        // A spent quota or daily budget fails every check alike: stop asking for a minute instead of burning through the queue.
        if (/quota|budget_exhausted|rate limit|too many requests|429/i.test(message)) {
          if (this.pausedUntil < nowMs) this.opts.log?.('assess_paused', { sec: 60, error: message.slice(0, 120) });
          this.pausedUntil = Math.max(this.pausedUntil, nowMs + 60_000);
        } else this.opts.log?.('assess_failed', { coin: coin.token, error: message.slice(0, 160) });
        return null;
      } finally { this.inFlight.delete(key); }
    })();
    this.inFlight.set(key, job);
    return job;
  }

  /** Record the verdict, and ask who funded the deployer and (on a coin people trade) the first minute's buyers. */
  private remember(coin: CoinState, a: Assessment) {
    const m = this.opts.memory;
    if (!m) return;
    try {
      m.store.recordLaunch({ token: coin.token, launchpad: coin.launchpad, deployer: coin.creator, poolId: coin.poolId, createdBlock: coin.block, createdTs: coin.ts, tx: coin.tx,
        name: a.name || coin.name, symbol: a.symbol || coin.symbol, supply: coin.supply.toString() });
      m.store.recordVerdict(coin.token, a.verdict.level, a.matches.map(x => ({ id: x.id, level: x.level })), Math.floor(Date.parse(a.at) / 1000), 'live');
      const early = coin.trades.length >= 3 ? a.stats.earlyBuyers.filter(b => !b.deployer).slice(0, 40).map(b => b.wallet) : [];
      m.funders.want([coin.creator, ...early]);
    } catch (error) { this.opts.log?.('memory_failed', { coin: coin.token, error: String((error as Error).message).slice(0, 160) }); }
  }

  /** Record each live coin's features and outcomes as their times pass (cheap: no RPC). */
  settle() {
    const m = this.opts.memory;
    if (!m) return;
    const nowSec = Math.floor(this.opts.now() / 1000);
    for (const coin of this.tracker.coins.values()) {
      const key = coin.token.toLowerCase(), done = this.measured.get(key) ?? 0, due = MEASURE_AT.filter(at => nowSec - coin.ts >= at).length;
      if (due <= done) continue;
      this.measured.set(key, due);
      try { m.historian.measure(coin, 'live', this.probes.get(key)?.tips ?? {}, nowSec); }
      catch (error) { this.opts.log?.('measure_failed', { coin: coin.token, error: String((error as Error).message).slice(0, 160) }); }
    }
  }

  /** For a coin page: the cached check if fresh, otherwise a new one (bounded wait). */
  async fresh(coin: CoinState, waitMs = 8000): Promise<Assessment | undefined> {
    if (!this.stale(coin.token)) return this.assessment(coin.token);
    // Page views wait out the same RPC pause and per-coin backoff as the scheduler: requests cannot force extra RPC work.
    const nowMs = this.opts.now(), f = this.failed.get(coin.token.toLowerCase());
    if (nowMs < this.pausedUntil || (f && f.until > nowMs)) return this.assessment(coin.token);
    const job = this.check(coin);
    const timeout = new Promise<null>(resolve => setTimeout(resolve, waitMs, null));
    return (await Promise.race([job, timeout])) ?? this.assessment(coin.token);
  }

  private naming = false;
  private namesAfter = 0;
  /** Read names and symbols for up to `batch` coins that have none yet, in one multicall (30 s pause after a failure). */
  async name(batch = 60) {
    if (this.naming || this.opts.now() < this.namesAfter || this.opts.now() < this.pausedUntil) return;
    const todo = [...this.tracker.coins.values()].filter(c => c.name === null).sort((a, b) => b.ts - a.ts).slice(0, batch);
    if (!todo.length) return;
    this.naming = true;
    try {
      // At "latest": a name never changes, and an unpinned read can use the public RPC once the paid budget is spent.
      const names = await readNames(this.rpc, this.registry.address('multicall3'), todo.map(c => c.token), 'latest');
      todo.forEach((c, i) => { c.name = names[i]?.name ?? ''; c.symbol = names[i]?.symbol ?? ''; });
    } catch (error) { this.namesAfter = this.opts.now() + 30_000; this.opts.log?.('names_failed', { error: String((error as Error).message).slice(0, 160) }); }
    finally { this.naming = false; }
  }

  /** Drop checks for coins the tracker has forgotten. */
  prune() {
    for (const key of this.probes.keys()) if (!this.tracker.coins.has(key)) { this.probes.delete(key); this.judged.delete(key); this.measured.delete(key); this.probedTrades.delete(key); }
    for (const key of this.failed.keys()) if (!this.tracker.coins.has(key)) this.failed.delete(key);
  }

  /** The level from the coin's last computed verdict, without recomputing it (for counts over every coin). */
  cachedLevel(token: string): string {
    return this.judged.get(token.toLowerCase())?.a.verdict.level ?? 'pending';
  }
  /** When the coin was first probed, in seconds (null before its first check). */
  probedAtSec(token: string): number | null {
    const p = this.probes.get(token.toLowerCase());
    return p ? Date.parse(p.at) / 1000 : null;
  }
}
