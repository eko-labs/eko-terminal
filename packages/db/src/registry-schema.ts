import { pgTable, bigint, integer, text, numeric, jsonb, doublePrecision, primaryKey, index, unique } from 'drizzle-orm/pg-core';
import { bytes } from './types.js';
export const agentRegistryEvents=pgTable('agent_registry_events',{
  block:bigint('block',{mode:'bigint'}).notNull(),blockHash:bytes('block_hash').notNull(),txHash:bytes('tx_hash').notNull(),logIndex:integer('log_index').notNull(),
  agentId:numeric('agent_id',{precision:78,scale:0}).notNull(),kind:text('kind').notNull(),owner:bytes('owner'),evidence:jsonb('evidence').notNull(),
},t=>[primaryKey({columns:[t.txHash,t.logIndex]}),index('agent_registry_events_agent_block').on(t.agentId,t.block)]);
export const agentRegistry=pgTable('agent_registry',{
  agentId:numeric('agent_id',{precision:78,scale:0}).notNull(),owner:bytes('owner').notNull(),wallet:bytes('wallet').notNull(),tokenUri:text('token_uri'),
  registeredBlock:bigint('registered_block',{mode:'bigint'}).notNull(),walletBlock:bigint('wallet_block',{mode:'bigint'}).notNull(),block:bigint('block',{mode:'bigint'}).notNull(),
  blockHash:bytes('block_hash').notNull(),evidence:jsonb('evidence').notNull(),
},t=>[primaryKey({columns:[t.agentId,t.walletBlock]}),index('agent_registry_wallet_block').on(t.wallet,t.walletBlock)]);
export const agentRegistryCheckpoints=pgTable('agent_registry_checkpoints',{fromBlock:bigint('from_block',{mode:'bigint'}).notNull(),block:bigint('block',{mode:'bigint'}).notNull(),blockHash:bytes('block_hash').notNull()},t=>[primaryKey({columns:[t.fromBlock,t.block]})]);
export const walletLabels=pgTable('wallet_labels',{
  id:text('id').primaryKey(),address:bytes('address').notNull(),label:text('label').notNull(),confidence:doublePrecision('confidence').notNull(),tier:text('tier'),
  source:text('source').notNull(),crewId:text('crew_id'),features:jsonb('features').notNull(),modelVersion:text('model_version').notNull(),validFromBlock:bigint('valid_from_block',{mode:'bigint'}).notNull(),
},t=>[unique().on(t.address,t.validFromBlock,t.modelVersion),index('wallet_labels_address_block').on(t.address,t.validFromBlock)]);
export const walletLabelRegistryDependencies=pgTable('wallet_label_registry_dependencies',{
  labelId:text('label_id').notNull().references(()=>walletLabels.id),agentId:numeric('agent_id',{precision:78,scale:0}).notNull(),walletBlock:bigint('wallet_block',{mode:'bigint'}).notNull(),blockHash:bytes('block_hash').notNull(),
},t=>[primaryKey({columns:[t.labelId,t.agentId]})]);
export const walletLabelSupersessions=pgTable('wallet_label_supersessions',{
  priorId:text('prior_id').notNull().references(()=>walletLabels.id),replacementId:text('replacement_id').notNull().references(()=>walletLabels.id),
},t=>[primaryKey({columns:[t.priorId,t.replacementId]})]);
export const walletFingerprintRuns=pgTable('wallet_fingerprint_runs',{
  id:text('id').primaryKey(),address:bytes('address').notNull(),block:bigint('block',{mode:'bigint'}).notNull(),blockHash:bytes('block_hash').notNull(),
  modelVersion:text('model_version').notNull(),inputHash:text('input_hash').notNull(),features:jsonb('features').notNull(),score:doublePrecision('score').notNull(),
},t=>[unique().on(t.address,t.block,t.blockHash,t.modelVersion,t.inputHash),index('wallet_fingerprint_runs_wallet_block').on(t.address,t.block)]);
export const walletFingerprintDependencies=pgTable('wallet_fingerprint_dependencies',{
  runId:text('run_id').notNull().references(()=>walletFingerprintRuns.id),block:bigint('block',{mode:'bigint'}).notNull(),blockHash:bytes('block_hash').notNull(),
},t=>[primaryKey({columns:[t.runId,t.block]}),index('wallet_fingerprint_dependencies_block').on(t.block,t.blockHash)]);
export const walletLabelFingerprintDependencies=pgTable('wallet_label_fingerprint_dependencies',{
  labelId:text('label_id').primaryKey().references(()=>walletLabels.id),runId:text('run_id').notNull().references(()=>walletFingerprintRuns.id),
},t=>[index('wallet_label_fingerprint_dependencies_run').on(t.runId)]);
export const walletFingerprintState=pgTable('wallet_fingerprint_state',{
  address:bytes('address').notNull(),modelVersion:text('model_version').notNull(),revision:text('revision').notNull(),throughBlock:bigint('through_block',{mode:'bigint'}).notNull(),
},t=>[primaryKey({columns:[t.address,t.modelVersion]})]);
