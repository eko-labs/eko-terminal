import { pgTable, bigint, text, timestamp, integer, index, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { bytes } from './types.js';
const time=(name:string)=>timestamp(name,{withTimezone:true,mode:'date'});
export const scanJobs=pgTable('scan_jobs',{
  id:text('id').primaryKey(),query:text('query').notNull(),coin:bytes('coin'),phase:text('phase').notNull(),status:text('status').notNull(),
  createdAt:time('created_at').notNull().default(sql`clock_timestamp()`),firstPendingAt:time('first_pending_at'),startedAt:time('started_at'),finishedAt:time('finished_at'),
  leaseId:text('lease_id'),leaseUntil:time('lease_until'),attempts:integer('attempts').notNull().default(0),lastError:text('last_error'),
},t=>[uniqueIndex('scan_jobs_target').on(t.coin).where(sql`${t.coin} IS NOT NULL`),index('scan_jobs_queue').on(t.phase,t.createdAt),
  check('scan_jobs_phase_check',sql`${t.phase} IN ('queued','acquiring','evaluating','running','waiting','done')`),
  check('scan_jobs_status_check',sql`${t.status} IN ('pending','ready','not_found','ambiguous')`)]);
export const scanTimings=pgTable('scan_timings',{
  coin:bytes('coin').primaryKey(),discoveryBlock:bigint('discovery_block',{mode:'bigint'}).notNull(),discoveredAt:time('discovered_at').notNull().default(sql`clock_timestamp()`),
  engineStartedAt:time('engine_started_at'),firstVerdictAt:time('first_verdict_at'),criticalCompleteAt:time('critical_complete_at'),verdictId:text('verdict_id'),
});
