import type { Candle, MarketDataHealth, MarketDef, OrderBook, Ticker, Timeframe } from '@eko/shared';

export interface Trade {
  market: string;
  price: number;
  size: number;
  /** Exchange time, ms. */
  time: number;
}

export interface FeedHandlers {
  onTrade(t: Trade): void;
  onTicker(t: Ticker): void;
  onStatus(h: MarketDataHealth): void;
  /** Called after a reconnect so the service can repair gaps from REST history. */
  onReconnected(): void;
  /** Order-book update for a watched market (feeds may call this at any rate; the service throttles). */
  onBook?(b: OrderBook): void;
}

/** Levels per side kept in order books sent to clients. */
export const BOOK_DEPTH = 20;

export interface Feed {
  readonly source: string;
  readonly simulated: boolean;
  start(markets: MarketDef[], handlers: FeedHandlers): Promise<void>;
  stop(): void;
  /** Closed + possibly in-progress candles with open time in [fromSec, toSec), ascending. */
  history(market: MarketDef, tf: Timeframe, fromSec: number, toSec: number): Promise<Candle[]>;
  health(): MarketDataHealth;
  /** Markets whose order book should stream (the ones clients are watching). Optional capability. */
  watchBooks?(marketIds: string[]): void;
  /** Current top-of-book snapshot for one market, fetching it if the feed is not streaming it. */
  book?(market: MarketDef): Promise<OrderBook | null>;
}
