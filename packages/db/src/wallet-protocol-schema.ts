import { pgTable, integer, bigint, text, numeric, boolean, jsonb, primaryKey, index } from 'drizzle-orm/pg-core';
import { bytes, ts, now } from './types.js';
const base = () => ({ chainId:integer('chain_id').notNull(), block:bigint('block',{mode:'bigint'}).notNull(),
  blockHash:bytes('block_hash').notNull(), txHash:bytes('tx_hash').notNull(), transactionIndex:integer('transaction_index'),
  timestampSec:bigint('timestamp_sec',{mode:'bigint'}).notNull(), data:jsonb('data').notNull(), recordedAt:ts('recorded_at').notNull().default(now()) });
export const userops = pgTable('userops', { ...base(), logIndex:integer('log_index').notNull(), entryPoint:bytes('entry_point').notNull(), version:text('version').notNull(),
  userOpHash:bytes('user_op_hash').notNull(), sender:bytes('sender').notNull(), paymaster:bytes('paymaster').notNull(), nonce:numeric('nonce',{precision:78,scale:0}).notNull(),
  success:boolean('success').notNull(), actualGasCost:numeric('actual_gas_cost',{precision:78,scale:0}).notNull(), actualGasUsed:numeric('actual_gas_used',{precision:78,scale:0}).notNull(),
},t=>[primaryKey({columns:[t.chainId,t.txHash,t.logIndex]}),index('userops_sender_block').on(t.chainId,t.sender,t.block)]);
export const delegations7702 = pgTable('delegations_7702', { ...base(), kind:text('kind').notNull(), evidenceIndex:integer('evidence_index').notNull(),
  authority:bytes('authority'), implementation:bytes('implementation'), signatureValid:boolean('signature_valid'),
},t=>[primaryKey({columns:[t.chainId,t.txHash,t.kind,t.evidenceIndex]}),index('delegations_7702_authority_block').on(t.chainId,t.authority,t.block)]);
export const walletProtocolCoverage = pgTable('wallet_protocol_coverage', { ...base(), scope:text('scope').notNull(), inputHash:bytes('input_hash').notNull(),
},t=>[primaryKey({columns:[t.chainId,t.txHash,t.scope,t.inputHash]})]);
