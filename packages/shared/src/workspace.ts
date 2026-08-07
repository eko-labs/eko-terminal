
/**
 * Contract for the trading-workspace features added with the rebrand:
 * order book, sparklines and one-click position close.
 * Server implements these; the web app consumes them.
 */

export interface OrderBookLevel {
  price: number;
  /** Base-asset size at this level. */
  size: number;
}

export interface OrderBook {
  market: string;
  /** Best bid first (descending price). At most 20 levels. */
  bids: OrderBookLevel[];
  /** Best ask first (ascending price). At most 20 levels. */
  asks: OrderBookLevel[];
  /** Exchange/source timestamp, ms. */
  time: number;
  source: string;
  simulated: boolean;
}

/** GET /api/book?market=ETH-USD → { book: OrderBook | null } */
export interface BookResponse {
  book: OrderBook | null;
}

/** GET /api/sparklines → last 24 hourly closes per market, oldest first. */
export interface SparklinesResponse {
  sparklines: Record<string, number[]>;
}
