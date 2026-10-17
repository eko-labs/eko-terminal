import type { Address, Hex, Transaction, TransactionReceipt } from 'viem';
import type { NetworkDef, OrderSide, Quote, RouteDef } from '@eko/shared';

export interface VenueQuoteInput {
  id: string;
  market: string;
  side: OrderSide;
  amountIn: number;
  slippageBps: number;
  /** Wallet that will sign; enables balance/allowance checks and eth_call simulation. */
  account?: Address;
  /** Chart mid at quote time, for display only. */
  referenceMid: number;
  mode: 'testnet' | 'live';
}

/**
 * On-chain execution venue. Implementations quote, build and simulate transactions for the
 * user's wallet to sign, and interpret receipts. They never hold keys or sign anything.
 *
 * To add a venue (e.g. an aggregator), implement this interface and register it in app.ts.
 */
export interface ExecutionAdapter {
  readonly id: string;
  readonly name: string;
  readonly network: NetworkDef;
  /** Verified route for a market on this network, or null (market is then paper-only here). */
  route(market: string): RouteDef | null;
  /** Executable quote incl. calldata, approval requirements, simulation warnings and fees. */
  quote(input: VenueQuoteInput): Promise<Quote>;
  receipt(hash: Hex): Promise<TransactionReceipt | null>;
  transaction(hash: Hex): Promise<Transaction | null>;
  /** Actual traded amounts from a confirmed receipt, or null if they cannot be determined. */
  parseSwap(receipt: TransactionReceipt, market: string): { baseQty: number; quoteQty: number; price: number } | null;
}
