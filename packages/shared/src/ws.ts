import type { Candle } from './indicators.js';
import type { Order } from './schemas.js';
import type { Timeframe } from './time.js';
import type { OrderBook } from './workspace.js';

export type FeedStatus = 'connecting' | 'live' | 'reconnecting' | 'stale' | 'down';

export interface MarketDataHealth {
  source: string;
  simulated: boolean;
  status: FeedStatus;
  lastMessageAt: number | null;
  /** Exchange event time → server receive time, ms (median of recent samples). */
  lagMs: number | null;
  reconnects: number;
  detail?: string;
}

export interface ProviderHealth {
  id: string;
  name: string;
  configured: boolean;
  status: 'ok' | 'degraded' | 'down' | 'unconfigured';
  lastError: string | null;
  lastLatencyMs: number | null;
  lastSuccessAt: number | null;
  /** 'direct' = the provider's own API key; 'gateway' = served through the shared AI gateway (e.g. PPQ). */
  route?: 'direct' | 'gateway' | null;
  /** Gateway label for display, e.g. "PPQ" → "Claude · via PPQ". */
  via?: string | null;
  /** Model id used when a bot does not pin one. */
  model?: string | null;
}

export interface NetworkHealth {
  id: string;
  name: string;
  chainId: number;
  status: 'ok' | 'degraded' | 'down' | 'unconfigured';
  blockNumber: number | null;
  lastCheckedAt: number | null;
  detail?: string;
}

export interface SystemHealth {
  marketData: MarketDataHealth;
  providers: ProviderHealth[];
  networks: NetworkHealth[];
  worker: { running: boolean; lastTickAt: number | null; activeBots: number };
}

export interface Ticker {
  market: string;
  price: number;
  bid: number | null;
  ask: number | null;
  /** Exchange timestamp, ms. */
  time: number;
  open24h: number | null;
  volume24h: number | null;
  /** 24h high/low (optional: not every feed provides them). */
  high24h?: number | null;
  low24h?: number | null;
}

export type ServerMessage =
  | { type: 'hello'; serverTime: number; clockSpeed: number; simulated: boolean; dataSource: string; version: string }
  | { type: 'ticker'; ticker: Ticker }
  | { type: 'candle'; market: string; timeframe: Timeframe; candle: Candle; closed: boolean }
  | { type: 'order'; order: Order }
  | { type: 'portfolio'; mode: string }
  | { type: 'health'; health: SystemHealth }
  | { type: 'book'; book: OrderBook }
  | { type: 'pong'; t: number; serverTime: number };

export type ClientMessage =
  | { type: 'subscribe'; markets: string[]; timeframes: Timeframe[] }
  | { type: 'ping'; t: number };
