import { randomBytes } from 'node:crypto';
import { getAddress, type Address } from 'viem';
import { toUntrusted, UNTRUSTED_LIMITS } from '@eko/untrusted';
import type { Edge } from './service.js';
import { coinSummary } from './views.js';

/**
 * Public events for agents that would rather wait than poll (the MCP `watch` tool): new launches, coins reaching their
 * graduation line, verdict changes, and whatever an enabled feature posts (an insider sell, a dump-risk change). Each
 * event gets a sequence number; a cursor is `<boot>:<seq>`, so a cursor from before a restart is recognised and the
 * agent is told to start over rather than silently missing events.
 *
 * Sources: the tracker's feed (the same launches and graduations the site's live feed pushes) and each coin's last
 * computed verdict (Edge.cachedLevel, no recomputation), read by `sync()` once a second while anyone waits, and on every
 * read. Features post with `post()`. Kept in memory, bounded: the newest MAX_EVENTS.
 */
export const MAX_EVENTS = 2000, MAX_WAIT_SEC = 25, MAX_PAGE = 100;
/** Waiting calls at once: per agent key or address, and in all (each one holds a connection open). */
export const WAITERS_PER_CLIENT = 2, WAITERS_TOTAL = 500;

export const WATCH_KINDS = ['launch', 'bonded', 'verdict', 'dev_sell', 'insider_sell', 'dump_risk'] as const;
export type WatchKind = (typeof WATCH_KINDS)[number];
export interface WatchEvent {
  cursor: string; ts: string; kind: WatchKind; coin: Address;
  symbol?: ReturnType<typeof toUntrusted>; launchpad?: string;
  /** EKO's verdict and score when the event was made (verdict events: the new verdict and the one before). */
  verdict?: string; previous?: string; score?: number; band?: string;
  /** One line in plain words. */
  title: string;
  /** Kind-specific figures (a sell's share of supply, a dump estimate). */
  data?: Record<string, unknown>;
}
/** What a feature posts: the stream fills in the cursor, time, symbol, verdict and score. */
export type WatchInput = Pick<WatchEvent, 'kind' | 'coin' | 'title'> & { data?: Record<string, unknown> };

export class WatchStream {
  private readonly events: WatchEvent[] = [];
  private seq = 0;
  readonly boot = randomBytes(3).toString('hex');
  private fed: string | null = null;
  private ready = false;
  private levels = new Map<string, string>();
  private waiters = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly edge: Edge, private readonly now: () => number = () => Date.now()) {}
  /** Start at the present (the first read): what happened before is the site's feed, not news. */
  private init() {
    this.ready = true;
    this.fed = this.edge.tracker.feed.at(-1)?.id ?? null;
    for (const c of this.edge.tracker.coins.values()) this.levels.set(c.token.toLowerCase(), this.edge.cachedLevel(c.token));
  }

  get size() { return this.events.length; }
  get waiting() { return this.waiters.size; }

  /** Read new feed items and verdict changes; wake waiting calls when there is news. */
  sync(): number {
    if (!this.ready) this.init();
    const before = this.seq, edge = this.edge, feed = edge.tracker.feed;
    const from = this.fed ? feed.findIndex(e => e.id === this.fed) + 1 : 0;
    // A cursor that fell out of the feed (it keeps 1,000) starts from the newest 50 rather than replaying everything.
    const fresh = feed.slice(from > 0 ? from : this.fed && feed.length > 50 ? feed.length - 50 : 0);
    if (feed.length) this.fed = feed.at(-1)!.id;
    for (const e of fresh) {
      if (e.kind === 'new_pair') this.add({ kind: 'launch', coin: e.coin, title: 'New launch' });
      else if (e.kind === 'graduation') this.add({ kind: 'bonded', coin: e.coin, title: 'Reached its graduation line' });
    }
    const seen = new Set<string>();
    for (const c of edge.tracker.coins.values()) {
      const k = c.token.toLowerCase(), level = edge.cachedLevel(c.token), was = this.levels.get(k);
      seen.add(k);
      if (was === undefined) { this.levels.set(k, level); continue; }
      if (was !== level) {
        this.levels.set(k, level);
        if (level !== 'pending') this.add({ kind: 'verdict', coin: c.token, title: `Verdict ${was === 'pending' ? 'is' : 'changed to'} ${level}`, data: { from: was } }, was);
      }
    }
    for (const k of this.levels.keys()) if (!seen.has(k)) this.levels.delete(k);
    if (this.seq !== before) this.wake();
    return this.seq - before;
  }

  /** Add an event a feature found (an insider sell, a dump-risk change). */
  post(e: WatchInput) { this.add(e); this.wake(); }

  private add(e: WatchInput, previous?: string) {
    const edge = this.edge, c = edge.tracker.coin(e.coin);
    let summary: ReturnType<typeof coinSummary> | undefined;
    try { summary = c ? coinSummary(c, edge.assessment(c.token), edge.ctx()) : undefined; } catch { summary = undefined; }
    const seq = ++this.seq;
    this.events.push({ cursor: `${this.boot}:${seq}`, ts: new Date(this.now()).toISOString(), kind: e.kind, coin: getAddress(e.coin),
      ...(summary?.symbol.text ? { symbol: summary.symbol } : c?.symbol ? { symbol: toUntrusted(c.symbol, UNTRUSTED_LIMITS.symbol) } : {}),
      ...(c ? { launchpad: c.launchpad } : {}), ...(summary ? { verdict: summary.verdict } : {}), ...(previous ? { previous } : {}),
      ...(summary?.ekoScore ? { score: summary.ekoScore.value, band: summary.ekoScore.band } : {}), title: e.title, ...(e.data ? { data: e.data } : {}) });
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
  }

  private wake() { const w = [...this.waiters]; this.waiters.clear(); for (const f of w) f(); }

  /**
   * Events after `cursor` (oldest first, at most `limit`), waiting up to `waitSec` for the first one. No cursor: nothing
   * old, only what arrives from now (the reply's cursor marks the present). A cursor from another boot: `reset`.
   */
  async read(opts: { cursor?: string; kinds?: ReadonlySet<string>; coin?: string; waitSec?: number; limit?: number; signal?: AbortSignal }) {
    this.sync();
    const limit = Math.min(MAX_PAGE, Math.max(1, Math.floor(opts.limit ?? 50))), wait = Math.min(MAX_WAIT_SEC, Math.max(0, opts.waitSec ?? MAX_WAIT_SEC));
    const parsed = /^([0-9a-f]{6}):(\d{1,12})$/.exec(opts.cursor ?? '');
    const reset = !!opts.cursor && (!parsed || parsed[1] !== this.boot || Number(parsed[2]) > this.seq);
    // A reset (or no cursor) starts at the present; the agent re-reads coins it cares about with `coins`.
    let after = parsed && !reset ? Number(parsed[2]) : this.seq;
    const coin = opts.coin?.toLowerCase();
    const pick = () => {
      const out: WatchEvent[] = [];
      for (const e of this.events) {
        const seq = Number(e.cursor.slice(7));
        if (seq <= after) continue;
        if (opts.kinds?.size && !opts.kinds.has(e.kind)) continue;
        if (coin && e.coin.toLowerCase() !== coin) continue;
        out.push(e);
        if (out.length >= limit) break;
      }
      return out;
    };
    // Older than the buffer: say so (some events were dropped) and go on from the oldest kept.
    const oldest = this.events[0] ? Number(this.events[0].cursor.slice(7)) : this.seq + 1;
    const gap = !reset && after < oldest - 1;
    let events = pick();
    const deadline = this.now() + wait * 1000;
    while (!events.length && wait > 0 && !opts.signal?.aborted && this.now() < deadline) {
      this.start();
      await new Promise<void>(done => {
        const t = setTimeout(finish, Math.max(0, deadline - this.now()));
        function finish() { clearTimeout(t); done(); }
        this.waiters.add(finish);
        opts.signal?.addEventListener('abort', finish, { once: true });
      });
      events = pick();
    }
    // The next cursor: the last event returned, or (none) everything seen so far, so filtered-out events are skipped.
    const last = events.at(-1);
    if (!last && this.seq > after) after = this.seq;
    return { events, cursor: last ? last.cursor : `${this.boot}:${after}`, ...(reset ? { reset: true } : {}), ...(gap ? { gap: true } : {}) };
  }

  /** While calls wait, look for news once a second; stop when nobody waits. */
  private start() {
    if (this.timer) return;
    this.timer = setInterval(() => { this.sync(); if (!this.waiters.size) this.stop(); }, 1000);
    this.timer.unref?.();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; this.wake(); }
}
