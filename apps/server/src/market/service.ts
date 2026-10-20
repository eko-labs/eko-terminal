import { EventEmitter } from 'node:events';
import { and, asc, desc, eq, gte, lt, sql } from 'drizzle-orm';
import {
  TIMEFRAMES,
  TIMEFRAME_SECONDS,
  bucketStart,
  type Candle,
  type MarketDataHealth,
  type MarketDef,
  type OrderBook,
  type Ticker,
  type Timeframe,
} from '@eko/shared';
import type { Db } from '../db/client.js';
import { candles as candlesTable } from '../db/schema.js';
import { logger } from '../obs/logger.js';
import { reportError } from '../obs/errors.js';
import { CandleStore } from './candleStore.js';
import type { Feed } from './types.js';

export const INITIAL_BARS: Record<Timeframe, number> = { '1m': 720, '5m': 600, '15m': 500, '1h': 500, '4h': 400, '1d': 300 };

interface Events {
  ticker: [Ticker];
  candle: [market: string, tf: Timeframe, candle: Candle, closed: boolean];
  barClose: [market: string, tf: Timeframe, candle: Candle, closedAtMs: number];
  health: [MarketDataHealth];
  book: [OrderBook];
  ready: [];
}

export class MarketDataService extends EventEmitter<Events> {
  readonly store = new CandleStore();
  private tickers = new Map<string, Ticker>();
  private books = new Map<string, OrderBook>();
  private sparkCache: { at: number; data: Record<string, number[]> } | null = null;
  private pendingPersist: { market: string; tf: Timeframe; c: Candle }[] = [];
  private timers: NodeJS.Timeout[] = [];
  ready = false;

  constructor(
    readonly feed: Feed,
    private db: Db,
    readonly markets: MarketDef[],
    private now: () => number = Date.now,
  ) {
    super();
    this.store.on('update', (m, tf, c) => this.emit('candle', m, tf, c, false));
    this.store.on('close', (m, tf, c, at) => {
      this.emit('candle', m, tf, c, true);
      this.emit('barClose', m, tf, c, at);
      this.pendingPersist.push({ market: m, tf, c: { ...c } });
    });
  }

  get source() {
    return this.feed.source;
  }
  get simulated() {
    return this.feed.simulated;
  }

  async start() {
    await this.feed.start(this.markets, {
      onTrade: (t) => this.store.ingestTrade(t.market, t.price, t.size, t.time),
      onTicker: (t) => {
        this.tickers.set(t.market, t);
        this.emit('ticker', t);
      },
      onStatus: (h) => this.emit('health', h),
      onReconnected: () => void this.repairGaps(),
      onBook: (b) => {
        this.books.set(b.market, b);
        this.emit('book', b);
      },
    });
    await this.backfillAll();
    this.ready = true;
    this.emit('ready');
    this.timers.push(setInterval(() => this.store.sweep(this.now()), 250));
    this.timers.push(setInterval(() => void this.flushPersist(), 5000));
  }

  stop() {
    this.feed.stop();
    for (const t of this.timers) clearInterval(t);
  }

  health(): MarketDataHealth {
    return this.feed.health();
  }

  ticker(market: string): Ticker | undefined {
    return this.tickers.get(market);
  }

  allTickers(): Ticker[] {
    return [...this.tickers.values()];
  }

  /** Stream order books for these markets only (the ones clients watch). */
  watchBooks(marketIds: string[]) {
    for (const id of this.books.keys()) if (!marketIds.includes(id)) this.books.delete(id);
    this.feed.watchBooks?.(marketIds);
  }

  /** Latest streamed book, or a one-off snapshot from the feed. */
  async book(marketId: string): Promise<OrderBook | null> {
    const cached = this.books.get(marketId);
    if (cached) return cached;
    const def = this.markets.find((m) => m.id === marketId);
    if (!def || !this.feed.book) return null;
    return this.feed.book(def);
  }

  /**
   * Last 24 hourly closes per market, oldest first. Closed 1h bars come from the backfilled
   * store (or persisted candles); the forming hour's close is the final point so the line ends
   * at the live price.
   */
  async sparklines(points = 24): Promise<Record<string, number[]>> {
    if (this.sparkCache && this.now() - this.sparkCache.at < 15_000) return this.sparkCache.data;
    const out: Record<string, number[]> = {};
    for (const m of this.markets) {
      const forming = this.store.forming(m.id, '1h');
      let closed = this.store.closed(m.id, '1h', points).map((c) => c.close);
      if (closed.length < points - 1) {
        const rows = await this.db
          .select({ close: candlesTable.close })
          .from(candlesTable)
          .where(and(eq(candlesTable.source, this.feed.source), eq(candlesTable.market, m.id), eq(candlesTable.timeframe, '1h')))
          .orderBy(desc(candlesTable.time))
          .limit(points);
        if (rows.length > closed.length) closed = rows.map((r) => r.close).reverse();
      }
      const series = forming ? [...closed.slice(-(points - 1)), forming.close] : closed.slice(-points);
      out[m.id] = series;
    }
    this.sparkCache = { at: this.now(), data: out };
    return out;
  }

  /** Latest trade price, falling back to the forming 1m close. */
  lastPrice(market: string): { price: number; at: number } | null {
    const t = this.tickers.get(market);
    if (t) return { price: t.price, at: t.time };
    const p = this.store.lastPrice(market);
    return p ? { price: p, at: this.now() } : null;
  }

  private async backfillAll() {
    const nowSec = Math.floor(this.now() / 1000);
    const jobs: Promise<void>[] = [];
    for (const m of this.markets) {
      for (const tf of TIMEFRAMES) {
        jobs.push(
          (async () => {
            const step = TIMEFRAME_SECONDS[tf];
            const from = bucketStart(nowSec, tf) - step * INITIAL_BARS[tf];
            try {
              const bars = await this.feed.history(m, tf, from, nowSec + step);
              this.store.mergeHistory(m.id, tf, bars, this.now());
              await this.persist(m.id, tf, bars.filter((b) => b.time + step <= nowSec));
            } catch (err) {
              reportError(err, { where: 'backfill', market: m.id, tf });
            }
          })(),
        );
      }
    }
    await Promise.all(jobs);
    logger.info({ source: this.feed.source, markets: this.markets.length }, 'market data backfilled');
  }

  /** After a reconnect, re-fetch recent bars so trades missed while disconnected are reflected. */
  async repairGaps() {
    const nowSec = Math.floor(this.now() / 1000);
    for (const m of this.markets) {
      for (const tf of TIMEFRAMES) {
        const step = TIMEFRAME_SECONDS[tf];
        try {
          const bars = await this.feed.history(m, tf, bucketStart(nowSec, tf) - step * 30, nowSec + step);
          this.store.mergeHistory(m.id, tf, bars, this.now());
        } catch (err) {
          reportError(err, { where: 'repairGaps', market: m.id, tf });
        }
      }
    }
    logger.info('market data gaps repaired after reconnect');
  }

  private async flushPersist() {
    if (!this.pendingPersist.length) return;
    const batch = this.pendingPersist.splice(0, this.pendingPersist.length);
    const byKey = new Map<string, Candle[]>();
    for (const b of batch) {
      const k = `${b.market}|${b.tf}`;
      (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(b.c);
    }
    for (const [k, cs] of byKey) {
      const [market, tf] = k.split('|') as [string, Timeframe];
      await this.persist(market, tf, cs).catch((err) => reportError(err, { where: 'persist candles' }));
    }
  }

  private async persist(market: string, tf: Timeframe, bars: Candle[]) {
    if (!bars.length) return;
    const now = this.now();
    for (let i = 0; i < bars.length; i += 400) {
      const chunk = bars.slice(i, i + 400).map((c) => ({
        source: this.feed.source,
        market,
        timeframe: tf,
        time: c.time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
        ingestedAt: now,
      }));
      await this.db
        .insert(candlesTable)
        .values(chunk)
        .onConflictDoUpdate({
          target: [candlesTable.source, candlesTable.market, candlesTable.timeframe, candlesTable.time],
          set: {
            open: sql`excluded.open`,
            high: sql`excluded.high`,
            low: sql`excluded.low`,
            close: sql`excluded.close`,
            volume: sql`excluded.volume`,
            ingestedAt: sql`excluded.ingested_at`,
          },
        });
    }
  }

  /**
   * Point-in-time history for backtests: stored candles first, topping up from the feed's
   * REST history when coverage is incomplete. Only closed bars are returned.
   */
  async loadRange(market: MarketDef, tf: Timeframe, fromSec: number, toSec: number): Promise<Candle[]> {
    const step = TIMEFRAME_SECONDS[tf];
    const nowSec = Math.floor(this.now() / 1000);
    const end = Math.min(toSec, bucketStart(nowSec, tf));
    const expected = Math.max(1, Math.floor((end - fromSec) / step));
    const read = async () =>
      (
        await this.db
          .select()
          .from(candlesTable)
          .where(
            and(
              eq(candlesTable.source, this.feed.source),
              eq(candlesTable.market, market.id),
              eq(candlesTable.timeframe, tf),
              gte(candlesTable.time, fromSec),
              lt(candlesTable.time, end),
            ),
          )
          .orderBy(asc(candlesTable.time))
      ).map((r) => ({ time: r.time, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume }));
    let rows = await read();
    if (rows.length < expected * 0.9) {
      const fetched = await this.feed.history(market, tf, fromSec, end);
      await this.persist(market.id, tf, fetched.filter((b) => b.time + step <= nowSec));
      rows = await read();
    }
    return rows;
  }
}
