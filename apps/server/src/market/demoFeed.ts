import {
  TIMEFRAMES,
  TIMEFRAME_SECONDS,
  bucketStart,
  type Candle,
  type MarketDataHealth,
  type MarketDef,
  type OrderBook,
  type OrderBookLevel,
  type Timeframe,
} from '@eko/shared';
import { gaussian, hashString, mulberry32 } from './rng.js';
import { BOOK_DEPTH, type Feed, type FeedHandlers } from './types.js';

const SIM_SPREAD = 0.00008;

/**
 * Simulated order book around a price: best bid/ask match the simulated ticker, levels step
 * outward by ~0.5 bp and sizes are a pure function of (seed, market, 250 ms bucket).
 */
export function syntheticBook(def: MarketDef, price: number, timeMs: number, seed: number, source: string): OrderBook {
  const r = mulberry32(hashString(`${def.id}:${seed}:book:${Math.floor(timeMs / 250)}`));
  const tick = 10 ** (Math.floor(Math.log10(price)) - 5);
  const snap = (p: number) => Math.round(p / tick) * tick;
  const half = (price * SIM_SPREAD) / 2;
  const step = Math.max(tick, price * 0.00005);
  const unit = 25_000 / price;
  const size = (i: number) => unit * Math.exp(0.6 * gaussian(r)) * (0.6 + i * 0.12) * (r() < 0.08 ? 4 : 1);
  const bids: OrderBookLevel[] = [];
  const asks: OrderBookLevel[] = [];
  for (let i = 0; i < BOOK_DEPTH; i++) {
    bids.push({ price: snap(price - half - i * step), size: size(i) });
    asks.push({ price: snap(price + half + i * step), size: size(i) });
  }
  if (asks[0]!.price <= bids[0]!.price) asks.forEach((a, i) => (a.price = bids[0]!.price + tick * (i + 1)));
  return { market: def.id, bids, asks, time: timeMs, source, simulated: true };
}

/** Fixed epoch so every minute's price is a pure function of (seed, market, minute). */
const EPOCH_SEC = Date.UTC(2026, 0, 1) / 1000;
const TICKS_PER_MINUTE = 240;
const TICK_MS = 60_000 / TICKS_PER_MINUTE;
const KEEP_FINE = 6000;
const TRIM_SLACK = 2000;

interface ModelState {
  price: number;
  logVol: number;
  drift: number;
}

/**
 * Deterministic market simulator. Clearly labelled as simulated everywhere it surfaces.
 * Used for the credential-free demo, offline development and automated tests.
 */
class DemoMarket {
  readonly def: MarketDef;
  private rand: () => number;
  private state: ModelState;
  private baseVol: number;
  private nextMinute = EPOCH_SEC; // open time of the next minute to generate
  /** Closed 1-minute bars, most recent KEEP_FINE. */
  private minutes: Candle[] = [];
  /** Aggregated bars for every timeframe (fine ones trimmed). */
  readonly bars = new Map<Timeframe, Candle[]>();
  /** The generated-but-still-forming minute. */
  current: Candle | null = null;
  emittedTicks = 0;
  vol24: number[] = [];
  last: { price: number; time: number } | null = null;
  /** Extremes of the current minute's emitted ticks. */
  private minuteHi = -Infinity;
  private minuteLo = Infinity;
  /** 24h extremes over closed minutes, recomputed once per minute. */
  private dayRange: { lastBar: number; hi: number; lo: number } | null = null;

  constructor(def: MarketDef, seed: number) {
    this.def = def;
    this.rand = mulberry32(hashString(`${def.id}:${seed}`));
    this.baseVol = def.demo.volPerMinute;
    this.state = { price: def.demo.seedPrice, logVol: Math.log(def.demo.volPerMinute), drift: 0 };
    for (const tf of TIMEFRAMES) this.bars.set(tf, []);
  }

  private genMinute(open: number): Candle {
    const r = this.rand;
    const s = this.state;
    if (r() < 1 / 240) s.drift = gaussian(r) * this.baseVol * 0.035;
    s.logVol = 0.992 * s.logVol + 0.008 * Math.log(this.baseVol) + 0.035 * gaussian(r);
    const vol = Math.min(Math.exp(s.logVol), this.baseVol * 3);
    let ret = s.drift + vol * gaussian(r);
    if (r() < 1 / 3000) ret += (r() < 0.5 ? -1 : 1) * vol * 6;
    // Weak pull toward the seed price keeps the simulation in a plausible range over months.
    ret += -0.00002 * Math.log(s.price / this.def.demo.seedPrice);
    const o = s.price;
    const c = o * Math.exp(ret);
    const h = Math.max(o, c) * Math.exp(Math.abs(gaussian(r)) * vol * 0.45);
    const l = Math.min(o, c) * Math.exp(-Math.abs(gaussian(r)) * vol * 0.45);
    const volume = (1_000_000 / this.def.demo.seedPrice) * Math.exp(0.45 * gaussian(r)) * (1 + (Math.abs(ret) / this.baseVol) * 0.8);
    s.price = c;
    return { time: open, open: o, high: h, low: l, close: c, volume };
  }

  private pushClosed(bar: Candle) {
    // Arrays are trimmed in batches: trimming one element per minute is O(n) each and made
    // generating months of history take minutes.
    this.minutes.push(bar);
    if (this.minutes.length > KEEP_FINE + TRIM_SLACK) this.minutes.splice(0, this.minutes.length - KEEP_FINE);
    this.vol24.push(bar.volume);
    if (this.vol24.length > 1440 + TRIM_SLACK) this.vol24.splice(0, this.vol24.length - 1440);
    for (const tf of TIMEFRAMES) {
      const arr = this.bars.get(tf)!;
      const b = bucketStart(bar.time, tf);
      const lastBar = arr[arr.length - 1];
      if (lastBar && lastBar.time === b) {
        lastBar.high = Math.max(lastBar.high, bar.high);
        lastBar.low = Math.min(lastBar.low, bar.low);
        lastBar.close = bar.close;
        lastBar.volume += bar.volume;
      } else {
        arr.push({ ...bar, time: b });
        const cap = TIMEFRAME_SECONDS[tf] < 3600 ? KEEP_FINE : Infinity;
        if (arr.length > cap + TRIM_SLACK) arr.splice(0, arr.length - cap);
      }
    }
  }

  /** Generate every minute up to (and including) the one containing nowSec. Returns newly closed bars. */
  advanceTo(nowSec: number): Candle[] {
    const closed: Candle[] = [];
    const curOpen = bucketStart(nowSec, '1m');
    while (this.nextMinute <= curOpen) {
      if (this.current) {
        this.pushClosed(this.current);
        closed.push(this.current);
      }
      this.current = this.genMinute(this.nextMinute);
      this.nextMinute += 60;
      this.emittedTicks = 0;
    }
    return closed;
  }

  observeTick(price: number, time: number, newMinute: boolean) {
    if (newMinute) {
      this.minuteHi = -Infinity;
      this.minuteLo = Infinity;
    }
    this.minuteHi = Math.max(this.minuteHi, price);
    this.minuteLo = Math.min(this.minuteLo, price);
    this.last = { price, time };
  }

  /** High/low over the trailing 24h: closed minutes plus the ticks of the current minute. */
  range24h(): { high: number; low: number } | null {
    const mins = this.bars.get('1m')!;
    const lastBar = mins[mins.length - 1]?.time ?? 0;
    if (!this.dayRange || this.dayRange.lastBar !== lastBar) {
      let hi = -Infinity;
      let lo = Infinity;
      for (let i = Math.max(0, mins.length - 1439); i < mins.length; i++) {
        hi = Math.max(hi, mins[i]!.high);
        lo = Math.min(lo, mins[i]!.low);
      }
      this.dayRange = { lastBar, hi, lo };
    }
    const high = Math.max(this.dayRange.hi, this.minuteHi);
    const low = Math.min(this.dayRange.lo, this.minuteLo);
    return Number.isFinite(high) && Number.isFinite(low) ? { high, low } : null;
  }

  /** Deterministic intra-minute path hitting open → extreme → extreme → close exactly. */
  tickPath(bar: Candle): { price: number; size: number }[] {
    const r = mulberry32(hashString(`${this.def.id}:ticks:${bar.time}`));
    const highFirst = r() < 0.5;
    const tA = 0.08 + r() * 0.35;
    const tB = 0.55 + r() * 0.35;
    const anchors: [number, number][] = [
      [0, bar.open],
      [tA, highFirst ? bar.high : bar.low],
      [tB, highFirst ? bar.low : bar.high],
      [1, bar.close],
    ];
    const out: { price: number; size: number }[] = [];
    const weights: number[] = [];
    for (let i = 0; i < TICKS_PER_MINUTE; i++) {
      const x = i / (TICKS_PER_MINUTE - 1);
      let k = 0;
      while (k < anchors.length - 2 && x > anchors[k + 1]![0]) k++;
      const [x0, p0] = anchors[k]!;
      const [x1, p1] = anchors[k + 1]!;
      const f = x1 === x0 ? 0 : (x - x0) / (x1 - x0);
      let p = p0 + (p1 - p0) * f;
      const isAnchor = anchors.some(([ax]) => Math.abs(ax - x) < 0.5 / TICKS_PER_MINUTE);
      if (!isAnchor) p += gaussian(r) * (bar.high - bar.low) * 0.04;
      p = Math.min(bar.high, Math.max(bar.low, p));
      out.push({ price: p, size: 0 });
      weights.push(0.2 + r());
    }
    // Force exact anchor prices at the nearest ticks.
    for (const [ax, ap] of anchors) out[Math.round(ax * (TICKS_PER_MINUTE - 1))]!.price = ap;
    const wsum = weights.reduce((a, b) => a + b, 0);
    out.forEach((t, i) => (t.size = (bar.volume * weights[i]!) / wsum));
    return out;
  }

  history(tf: Timeframe, fromSec: number, toSec: number): Candle[] {
    const arr = this.bars.get(tf)!;
    return arr.filter((c) => c.time >= fromSec && c.time < toSec).map((c) => ({ ...c }));
  }
}

export class DemoFeed implements Feed {
  readonly source = 'EKO simulator';
  readonly simulated = true;
  private models = new Map<string, DemoMarket>();
  private timer: NodeJS.Timeout | null = null;
  private handlers: FeedHandlers | null = null;
  private lastMessageAt: number | null = null;
  private paused = false;
  private bookMarkets = new Set<string>();

  constructor(
    private seed: number,
    private now: () => number = Date.now,
  ) {}

  async start(markets: MarketDef[], handlers: FeedHandlers) {
    this.handlers = handlers;
    const nowSec = Math.floor(this.now() / 1000);
    for (const m of markets) {
      const model = new DemoMarket(m, this.seed);
      model.advanceTo(nowSec);
      this.models.set(m.id, model);
    }
    handlers.onStatus(this.health());
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Test hook: simulate an outage (no messages) until resumed. */
  setPaused(p: boolean) {
    this.paused = p;
    if (!p) this.handlers?.onReconnected();
    this.handlers?.onStatus(this.health());
  }

  private tick() {
    if (this.paused || !this.handlers) return;
    const nowMs = this.now();
    const nowSec = Math.floor(nowMs / 1000);
    for (const model of this.models.values()) {
      // Flush any remaining ticks of the minute that is about to close.
      const cur0 = model.current;
      if (cur0 && nowSec >= cur0.time + 60) this.emitTicks(model, cur0, TICKS_PER_MINUTE);
      model.advanceTo(nowSec);
      const cur = model.current;
      if (!cur) continue;
      const due = Math.min(TICKS_PER_MINUTE, Math.floor((nowMs - cur.time * 1000) / TICK_MS) + 1);
      this.emitTicks(model, cur, due);
    }
  }

  private emitTicks(model: DemoMarket, bar: Candle, upTo: number) {
    if (model.emittedTicks >= upTo) return;
    const path = model.tickPath(bar);
    let last = path[0]!;
    for (let i = model.emittedTicks; i < upTo; i++) {
      const t = path[i]!;
      last = t;
      const time = bar.time * 1000 + i * TICK_MS;
      model.observeTick(t.price, time, i === 0);
      this.handlers!.onTrade({ market: model.def.id, price: t.price, size: t.size, time });
    }
    model.emittedTicks = upTo;
    this.lastMessageAt = this.now();
    const day = model.bars.get('1m')!;
    const open24 = day.length >= 1440 ? day[day.length - 1440]!.open : day[0]?.open ?? null;
    const spread = last.price * SIM_SPREAD;
    const time = bar.time * 1000 + (upTo - 1) * TICK_MS;
    const range = model.range24h();
    this.handlers!.onTicker({
      market: model.def.id,
      price: last.price,
      bid: last.price - spread / 2,
      ask: last.price + spread / 2,
      time,
      open24h: open24,
      volume24h: model.vol24.slice(-1440).reduce((a, b) => a + b, 0),
      high24h: range?.high ?? null,
      low24h: range?.low ?? null,
    });
    if (this.bookMarkets.has(model.def.id)) this.handlers!.onBook?.(syntheticBook(model.def, last.price, time, this.seed, this.source));
  }

  watchBooks(marketIds: string[]) {
    this.bookMarkets = new Set(marketIds);
  }

  async book(market: MarketDef): Promise<OrderBook | null> {
    const last = this.models.get(market.id)?.last;
    return last ? syntheticBook(market, last.price, last.time, this.seed, this.source) : null;
  }

  async history(market: MarketDef, tf: Timeframe, fromSec: number, toSec: number): Promise<Candle[]> {
    const model = this.models.get(market.id);
    if (!model) return [];
    // Only bars built from already-closed minutes; the in-progress minute arrives as ticks.
    return model.history(tf, fromSec, toSec);
  }

  health(): MarketDataHealth {
    return {
      source: this.source,
      simulated: true,
      status: this.paused ? 'down' : 'live',
      lastMessageAt: this.lastMessageAt,
      lagMs: 0,
      reconnects: 0,
      detail: this.paused ? 'Simulated outage (test hook)' : 'Deterministic simulated market data',
    };
  }
}
