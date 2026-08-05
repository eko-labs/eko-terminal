/**
 * Market registry — the chart/data side of each market.
 *
 * Execution availability is declared separately per network in `networks.ts`; a market
 * without a verified on-chain route is paper-only and live execution is disabled for it.
 */
export interface MarketDef {
  id: string;
  base: string;
  quote: string;
  name: string;
  /** Deterministic simulator parameters (demo mode only). */
  demo: { seedPrice: number; volPerMinute: number };
  /** Order-size precision for the base asset in paper mode. */
  qtyDecimals: number;
  accent: string;
}

export const MARKETS: MarketDef[] = [
  { id: 'ETH-USD', base: 'ETH', quote: 'USD', name: 'Ether', demo: { seedPrice: 2480, volPerMinute: 0.00068 }, qtyDecimals: 6, accent: '#8EA2FF' },
  { id: 'BTC-USD', base: 'BTC', quote: 'USD', name: 'Bitcoin', demo: { seedPrice: 64200, volPerMinute: 0.0005 }, qtyDecimals: 8, accent: '#F2A93B' },
  { id: 'SOL-USD', base: 'SOL', quote: 'USD', name: 'Solana', demo: { seedPrice: 148, volPerMinute: 0.00095 }, qtyDecimals: 4, accent: '#B58CFF' },
  { id: 'LINK-USD', base: 'LINK', quote: 'USD', name: 'Chainlink', demo: { seedPrice: 13.4, volPerMinute: 0.001 }, qtyDecimals: 3, accent: '#5B8CFF' },
  { id: 'AVAX-USD', base: 'AVAX', quote: 'USD', name: 'Avalanche', demo: { seedPrice: 27.1, volPerMinute: 0.00105 }, qtyDecimals: 3, accent: '#FF6B6B' },
  { id: 'DOGE-USD', base: 'DOGE', quote: 'USD', name: 'Dogecoin', demo: { seedPrice: 0.121, volPerMinute: 0.0012 }, qtyDecimals: 0, accent: '#D9B26A' },
  { id: 'UNI-USD', base: 'UNI', quote: 'USD', name: 'Uniswap', demo: { seedPrice: 8.8, volPerMinute: 0.0011 }, qtyDecimals: 3, accent: '#FF5FB0' },
  { id: 'ARB-USD', base: 'ARB', quote: 'USD', name: 'Arbitrum', demo: { seedPrice: 0.202, volPerMinute: 0.00115 }, qtyDecimals: 2, accent: '#4DA3FF' },
  { id: 'SUI-USD', base: 'SUI', quote: 'USD', name: 'Sui', demo: { seedPrice: 1.168, volPerMinute: 0.0012 }, qtyDecimals: 2, accent: '#6FD3F7' },
  { id: 'PEPE-USD', base: 'PEPE', quote: 'USD', name: 'Pepe', demo: { seedPrice: 0.0000042, volPerMinute: 0.0015 }, qtyDecimals: 0, accent: '#5DBB63' },
];

export const MARKET_BY_ID: Record<string, MarketDef> = Object.fromEntries(MARKETS.map((m) => [m.id, m]));

export function getMarket(id: string): MarketDef | undefined {
  return MARKET_BY_ID[id];
}

/** Paper accounts start with this simulated cash balance. */
export const PAPER_STARTING_CASH = 10_000;
export const PAPER_QUOTE_ASSET = 'USD';
