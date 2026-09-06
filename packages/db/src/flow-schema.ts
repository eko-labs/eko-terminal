import { pgTable, bigint, boolean, integer, text, jsonb, doublePrecision, timestamp, bigserial, primaryKey, unique, index } from 'drizzle-orm/pg-core';
import { bytes } from './types.js';
const block=()=>bigint('block',{mode:'bigint'}).notNull();
const clock=(name:string)=>timestamp(name,{withTimezone:true,mode:'date'}).notNull();
export const flowWindows=pgTable('flow_windows',{
  coin:bytes('coin').notNull(),window:text('window_kind').notNull(),block:block(),blockHash:bytes('block_hash').notNull(),asOf:clock('as_of'),modelVersion:text('model_version').notNull(),data:jsonb('data').notNull(),updatedAt:clock('updated_at').defaultNow(),
},t=>[primaryKey({columns:[t.coin,t.window]})]);
export const flowEvents=pgTable('flow_events',{
  id:text('id').primaryKey(),coin:bytes('coin').notNull(),txHash:bytes('tx_hash').notNull(),logIndex:integer('log_index').notNull(),block:block(),blockHash:bytes('block_hash').notNull(),ts:clock('ts'),modelVersion:text('model_version').notNull(),data:jsonb('data').notNull(),
},t=>[unique().on(t.txHash,t.logIndex),index('flow_events_coin_time').on(t.coin,t.ts,t.id),index('flow_events_block').on(t.block)]);
export const evalGates=pgTable('eval_gates',{
  id:text('id').primaryKey(),metric:text('metric').notNull(),modelVersion:text('model_version').notNull(),value:doublePrecision('value').notNull(),wilsonLower:doublePrecision('wilson_lower').notNull(),recall:doublePrecision('recall').notNull(),evaluatedAt:clock('evaluated_at'),expiresAt:timestamp('expires_at',{withTimezone:true}),modelHash:text('model_hash'),datasetHash:text('dataset_hash'),evidence:jsonb('evidence'),
},t=>[index('eval_gates_model_latest').on(t.modelVersion,t.evaluatedAt,t.id)]);
export const censusSnapshots=pgTable('census_snapshots',{
  modelVersion:text('model_version').primaryKey(),block:block(),blockHash:bytes('block_hash').notNull(),asOf:clock('as_of'),data:jsonb('data').notNull(),
});
export const flowDirty=pgTable('flow_dirty',{coin:bytes('coin').primaryKey(),revision:bigserial('revision',{mode:'bigint'}).notNull(),fromSec:doublePrecision('from_sec').notNull().default(0)});
export const watcherFlowModel=pgTable('watcher_flow_model',{singleton:boolean('singleton').primaryKey().default(true),modelVersion:text('model_version').notNull()});
