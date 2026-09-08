import { pgTable, bigint, bigserial, integer, text, jsonb, timestamp, primaryKey, unique, index } from 'drizzle-orm/pg-core';
const publication = () => ({
  id: text('id').primaryKey(), producer: text('producer').notNull(), kind: text('kind').notNull(),
  chainId: bigint('chain_id', {mode:'number'}).notNull(), revisionId: text('revision_id').notNull(),
  payloadHash: text('payload_hash').notNull(), canonicalPayload: text('canonical_payload'),
  data: jsonb('data'), recordedAt: timestamp('recorded_at', {withTimezone:true}).notNull(),
});
export const receiptPublications = pgTable('receipt_publications', {...publication(),summary:jsonb('summary'),publicationSequence:bigserial('publication_sequence',{mode:'bigint'}).notNull()}, t => [unique().on(t.producer,t.revisionId), index('receipt_publications_recovery').on(t.recordedAt,t.id)]);
export const receiptItems = pgTable('receipt_items', {...publication(), leaf:text('leaf').notNull()}, t => [unique().on(t.producer,t.revisionId),index('receipt_items_pending').on(t.chainId,t.recordedAt,t.id)]);
export const receiptBatches = pgTable('receipt_batches', {
  id:text('id').primaryKey(),chainId:bigint('chain_id',{mode:'number'}).notNull(),root:text('root').notNull(),leafCount:integer('leaf_count').notNull(),
  through:timestamp('through',{withTimezone:true}).notNull(),recordedAt:timestamp('recorded_at',{withTimezone:true}).notNull(),
});
export const receiptBatchItems = pgTable('receipt_batch_items', {
  batchId:text('batch_id').notNull().references(()=>receiptBatches.id),receiptId:text('receipt_id').notNull().references(()=>receiptItems.id),
  itemIndex:integer('item_index').notNull(),proof:jsonb('proof').notNull(),
},t=>[primaryKey({columns:[t.batchId,t.receiptId]}),unique().on(t.batchId,t.itemIndex)]);
export const receiptWorkerLease = pgTable('receipt_worker_lease', {
  chainId:bigint('chain_id',{mode:'number'}).primaryKey(),owner:text('owner').notNull(),
  leaseUntil:timestamp('lease_until',{withTimezone:true}).notNull(),heartbeatAt:timestamp('heartbeat_at',{withTimezone:true}).notNull(),
});
export const receiptCommitAttempts = pgTable('receipt_commit_attempts', {
  txHash:text('tx_hash').primaryKey(),batchId:text('batch_id').notNull().references(()=>receiptBatches.id),
  registry:text('registry').notNull(),committer:text('committer').notNull(),nonce:bigint('nonce',{mode:'bigint'}).notNull(),
  rawTransaction:text('raw_transaction').notNull(),recordedAt:timestamp('recorded_at',{withTimezone:true}).notNull(),
},t=>[index('receipt_attempt_batch').on(t.batchId,t.recordedAt)]);
export const receiptCommitFailures = pgTable('receipt_commit_failures', {
  txHash:text('tx_hash').primaryKey().references(()=>receiptCommitAttempts.txHash),blockNumber:bigint('block_number',{mode:'bigint'}).notNull(),
  blockHash:text('block_hash').notNull(),recordedAt:timestamp('recorded_at',{withTimezone:true}).notNull(),
});
export const receiptCommitAnchors = pgTable('receipt_commit_anchors', {
  id:text('id').primaryKey(),batchId:text('batch_id').notNull().references(()=>receiptBatches.id),
  txHash:text('tx_hash').notNull().references(()=>receiptCommitAttempts.txHash),data:jsonb('data').notNull(),recordedAt:timestamp('recorded_at',{withTimezone:true}).notNull(),
});
export const receiptCommitAnchorEvents = pgTable('receipt_commit_anchor_events', {
  anchorId:text('anchor_id').notNull().references(()=>receiptCommitAnchors.id),kind:text('kind').notNull(),
  recordedAt:timestamp('recorded_at',{withTimezone:true}).notNull(),
},t=>[primaryKey({columns:[t.anchorId,t.kind]})]);
