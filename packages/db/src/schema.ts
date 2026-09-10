import { pgTable, date, bigint, integer, smallint, text, numeric, doublePrecision, jsonb, boolean, primaryKey, index, unique } from 'drizzle-orm/pg-core';
import { bytes, ts } from './types.js';
const block = () => bigint('block', { mode: 'bigint' }).notNull();
const version = () => text('code_version').notNull().default('indexer-v1');
const event = () => ({ block: block(), txHash: bytes('tx_hash').notNull(), logIndex: integer('log_index').notNull(), codeVersion: version() });
export const chainBlocks = pgTable('chain_blocks', {
  number: bigint('number', { mode: 'bigint' }).primaryKey(), block: block(), hash: bytes('hash').notNull(),
  // Null only for a sparse log-head row below the reorg window whose parent block had no indexed log (0184).
  parentHash: bytes('parent_hash'), ts: ts('ts').notNull(),
});
// TODO(spec): Persist the selected pricing source so freshness uses the indexer's identity across roles.
export const ethUsdReferenceSources = pgTable('eth_usd_reference_sources', {
  block: block().primaryKey(), poolId: bytes('pool_id').notNull(), venue: text('venue').notNull(), fee: integer('fee').notNull(),
});
export const ingestCursors = pgTable('ingest_cursors', { stream: text('stream').primaryKey(), block: block(), hash: bytes('hash') });
export const ingestRanges = pgTable('ingest_ranges', {
  stream: text('stream').notNull(), fromBlock: bigint('from_block', { mode: 'bigint' }).notNull(), toBlock: bigint('to_block', { mode: 'bigint' }).notNull(),
  lastError: text('last_error'), errorRepeats: integer('error_repeats').notNull().default(0),
  status: text('status').notNull().default('todo'), leaseOwner: text('lease_owner'), leaseUntil: ts('lease_until'), attempts: integer('attempts').notNull().default(0),
}, t => [primaryKey({ columns: [t.stream, t.fromBlock] })]);
export const tokens = pgTable('tokens', {
  address: bytes('address').primaryKey(), symbol: text('symbol'), name: text('name'), decimals: integer('decimals'), launchpad: text('launchpad'), deployer: bytes('deployer'), curve: bytes('curve'),
  totalSupply: numeric('total_supply', { precision: 78, scale: 0 }), supplyBlock: bigint('supply_block', { mode: 'bigint' }), graduatedPool: bytes('graduated_pool'), graduatedBlock: bigint('graduated_block', { mode: 'bigint' }),
  firstBlock: bigint('first_block', { mode: 'bigint' }).notNull(), block: block(), codeVersion: version(),
}, t => [unique().on(t.curve)]);
export const pools = pgTable('pools', {
  id: bytes('id').primaryKey(), venue: text('venue').notNull(), currency0: bytes('currency0').notNull(), currency1: bytes('currency1').notNull(), fee: integer('fee').notNull(), tickSpacing: integer('tick_spacing').notNull(), hooks: bytes('hooks'),
  creationVerified: boolean('creation_verified').notNull().default(false),
  createdBlock: bigint('created_block', { mode: 'bigint' }).notNull(), block: block(), codeVersion: version(),
});
export const swaps = pgTable('swaps', {
  ts: ts('ts').notNull(), ...event(), venue: text('venue').notNull(), poolId: bytes('pool_id').notNull(), coin: bytes('coin').notNull(), quoteAsset: bytes('quote_asset').notNull(), trader: bytes('trader'), txFrom: bytes('tx_from'), txTo: bytes('tx_to'), sendersPending: boolean('senders_pending').notNull().default(false), recipient: bytes('recipient'), side: smallint('side').notNull(),
  amountCoin: numeric('amount_coin', { precision: 78, scale: 0 }).notNull(), amountQuote: numeric('amount_quote', { precision: 78, scale: 0 }).notNull(), priceQuote: doublePrecision('price_quote'), pricingPending: boolean('pricing_pending').notNull().default(false), usd: doublePrecision('usd'), pricedBlock: bigint('priced_block', { mode: 'bigint' }),
}, t => [primaryKey({ columns: [t.ts, t.txHash, t.logIndex] }), index('swaps_coin_order').on(t.coin, t.block, t.logIndex, t.txHash, t.ts)]);
export const liquidityEvents = pgTable('liquidity_events', {
  ...event(), ts: ts('ts').notNull(), venue: text('venue').notNull(), poolId: bytes('pool_id').notNull(), kind: text('kind').notNull(), actor: bytes('actor'), txFrom: bytes('tx_from'), txTo: bytes('tx_to'), sendersPending: boolean('senders_pending').notNull().default(false), data: jsonb('data').notNull(),
}, t => [primaryKey({ columns: [t.txHash, t.logIndex] })]);
export const tokenTransfers = pgTable('token_transfers', {
  ...event(), ts: ts('ts').notNull(), token: bytes('token').notNull(), from: bytes('from_address').notNull(), to: bytes('to_address').notNull(), amount: numeric('amount', { precision: 78, scale: 0 }).notNull(), kind: text('kind').notNull().default('Transfer'),
}, t => [primaryKey({ columns: [t.ts, t.txHash, t.logIndex] })]);
export const ponsEvents = pgTable('pons_events', {
  ...event(), token: bytes('token').notNull(), emitter: bytes('emitter').notNull(), kind: text('kind').notNull(), data: jsonb('data').notNull(),
}, t => [primaryKey({ columns: [t.txHash, t.logIndex] })]);
export const ponsExemptions = pgTable('pons_exemptions', {
  ...event(), token: bytes('token').notNull(), wallet: bytes('wallet').notNull(),
}, t => [primaryKey({ columns: [t.token, t.wallet] })]);
export const wallets = pgTable('wallets', { address: bytes('address').primaryKey(), block: block(), codeVersion: version() });

export const balances = pgTable('balances', {
  token: bytes('token').notNull(), holder: bytes('holder').notNull(), amount: numeric('amount', { precision: 78, scale: 0 }).notNull(), lastBlock: bigint('last_block', { mode: 'bigint' }).notNull(),
}, t => [primaryKey({ columns: [t.token, t.holder] })]);
export const bars1m = pgTable('bars_1m', {
  coin: bytes('coin').notNull(), minute: ts('minute').notNull(), open: doublePrecision('open').notNull(), high: doublePrecision('high').notNull(), low: doublePrecision('low').notNull(), close: doublePrecision('close').notNull(),
  volumeUsd: doublePrecision('volume_usd').notNull(), trades: integer('trades').notNull(), firstBlock: bigint('first_block', { mode: 'bigint' }).notNull(), lastBlock: bigint('last_block', { mode: 'bigint' }).notNull(),
}, t => [primaryKey({ columns: [t.coin, t.minute] })]);

/** __total__ is the serialized daily admission row; other methods contain per-method detail. */
export const rpcUsage = pgTable('rpc_usage', {
  day: date('day').notNull(), provider: text('provider').notNull(), method: text('method').notNull(),
  calls: bigint('calls', { mode: 'number' }).notNull().default(0), units: doublePrecision('units').notNull().default(0),
}, t => [primaryKey({ columns: [t.day, t.provider, t.method] })]);

/** Raw events from undiscovered non-Pons pool emitters, retained for on-demand canonical replay. */
export const pendingPoolEvents = pgTable('pending_pool_events', { ...event(), emitter: bytes('emitter').notNull(), currencyHints:jsonb('currency_hints').notNull(),data:jsonb('data').notNull() },t=>[primaryKey({columns:[t.txHash,t.logIndex]})]);
