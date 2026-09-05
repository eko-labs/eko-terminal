import { pgTable, bigint, text, jsonb, integer, doublePrecision, boolean, timestamp, primaryKey, unique, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { bytes } from './types.js';
const validBlock=()=>bigint('valid_from_block',{mode:'bigint'}).notNull();
export const engineCursors=pgTable('engine_cursors',{stream:text('stream').primaryKey(),block:bigint('block',{mode:'bigint'}).notNull(),hash:bytes('hash')});
export const engineSchedule=pgTable('engine_schedule',{coin:bytes('coin').primaryKey(),lastBlock:bigint('last_block',{mode:'bigint'}).notNull(),lastSec:bigint('last_sec',{mode:'bigint'}).notNull(),price:doublePrecision('price')});
export const engineRuns=pgTable('engine_runs',{coin:bytes('coin').notNull(),block:bigint('block',{mode:'bigint'}).notNull(),sec:bigint('sec',{mode:'bigint'}).notNull(),price:doublePrecision('price'),signal:jsonb('signal'),rulesVersion:text('rules_version').notNull().default('1.0.0')},t=>[primaryKey({columns:[t.coin,t.block,t.rulesVersion]}),index('engine_runs_version_block_coin').on(t.rulesVersion,t.block,t.coin)]);
export const engineReads=pgTable('engine_reads',{coin:bytes('coin').notNull(),block:bigint('block',{mode:'bigint'}).notNull(),blockHash:bytes('block_hash'),profile:jsonb('profile')},t=>[primaryKey({columns:[t.coin,t.block]})]);
export const codeTemplates=pgTable('code_templates',{codehash:text('codehash').primaryKey(),template:text('template').notNull(),profile:jsonb('profile').notNull(),firstBlock:bigint('first_block',{mode:'bigint'}).notNull()});
export const ownerPowers=pgTable('owner_powers',{coin:bytes('coin').notNull(),validFromBlock:validBlock(),data:jsonb('data').notNull()},t=>[primaryKey({columns:[t.coin,t.validFromBlock]})]);
export const playbookMatches=pgTable('playbook_matches',{coin:bytes('coin').notNull(),validFromBlock:validBlock(),rulesVersion:text('rules_version').notNull(),playbookId:text('playbook_id').notNull(),data:jsonb('data').notNull()},t=>[primaryKey({columns:[t.coin,t.validFromBlock,t.rulesVersion,t.playbookId]})]);
export const verdicts=pgTable('verdicts',{id:text('id').primaryKey(),coin:bytes('coin').notNull(),validFromBlock:validBlock(),rulesVersion:text('rules_version').notNull(),signature:text('signature').notNull(),data:jsonb('data').notNull()},t=>[index('verdicts_coin_block').on(t.coin,t.validFromBlock)]);
export const verdictEvents=pgTable('verdict_events',{id:text('id').primaryKey(),verdictId:text('verdict_id').notNull().references(()=>verdicts.id),kind:text('kind').notNull(),block:bigint('block',{mode:'bigint'}).notNull(),data:jsonb('data').notNull()});
export const outcomes=pgTable('outcomes',{coin:bytes('coin').notNull(),horizon:text('horizon').notNull(),validFromBlock:validBlock(),outcome:text('outcome').notNull(),data:jsonb('data').notNull()},t=>[primaryKey({columns:[t.coin,t.horizon]}),index('outcomes_rugged_coin_block').on(t.coin,t.validFromBlock).where(sql`${t.outcome}='rugged'`)]);
export const deployerStats=pgTable('deployer_stats',{deployer:bytes('deployer').notNull(),coin:bytes('coin').notNull(),validFromBlock:validBlock(),data:jsonb('data').notNull(),rulesVersion:text('rules_version').notNull().default('1.0.0')},t=>[primaryKey({columns:[t.deployer,t.coin,t.validFromBlock,t.rulesVersion]}),index('deployer_stats_deployer_block_coin').on(t.deployer,t.validFromBlock,t.coin),index('deployer_stats_version_block_coin').on(t.rulesVersion,t.validFromBlock,t.coin)]);
export const coinCards=pgTable('coin_cards',{id:text('id').primaryKey(),coin:bytes('coin').notNull(),validFromBlock:validBlock(),hash:text('hash').notNull(),data:jsonb('data').notNull(),rulesVersion:text('rules_version').notNull().default('1.0.0')},t=>[unique().on(t.coin,t.validFromBlock,t.rulesVersion,t.hash),index('coin_cards_coin_block').on(t.coin,t.validFromBlock)]);
export const coinCardLatest=pgTable('coin_card_latest',{coin:bytes('coin').primaryKey(),cardId:text('card_id').notNull().references(()=>coinCards.id),asOfBlock:bigint('as_of_block',{mode:'bigint'}).notNull(),data:jsonb('data').notNull()});

export const engineBlockTimes=pgTable('engine_block_times',{number:bigint('number',{mode:'bigint'}).primaryKey(),ts:timestamp('ts',{withTimezone:true,mode:'date'}).notNull(),hash:bytes('hash'),source:text('source').notNull()});
export const engineActivityState=pgTable('engine_activity_state',{coin:bytes('coin').primaryKey(),revision:text('revision').notNull(),throughBlock:bigint('through_block',{mode:'bigint'}).notNull(),
  baseBlock:bigint('base_block',{mode:'bigint'}),baseSum:text('base_sum'),baseSec:doublePrecision('base_sec'),lastSec:doublePrecision('last_sec')},t=>[index('engine_activity_state_last_sec').on(t.lastSec)]);

export const enginePonsStatic=pgTable('engine_pons_static',{coin:bytes('coin').primaryKey(),firstReadBlock:bigint('first_read_block',{mode:'bigint'}).notNull(),firstReadHash:bytes('first_read_hash'),data:jsonb('data').notNull()});

/** Internal captured/uncaptured shadow runs; never a source of active verdicts. */
export const guardShadowRuns=pgTable('guard_shadow_runs',{id:text('id').primaryKey(),coin:text('coin').notNull(),block:bigint('block',{mode:'bigint'}).notNull(),legacyVerdictId:text('legacy_verdict_id').notNull().references(()=>verdicts.id),manifestId:text('manifest_id'),revisionId:text('revision_id'),status:text('status').notNull(),data:jsonb('data').notNull(),recordedAt:timestamp('recorded_at',{withTimezone:true}).notNull()},t=>[index('guard_shadow_runs_coin_block').on(t.coin,t.block)]);

/** Inactive local predictions with their exact reconstruction/domain provenance. */
export const directionalDepthRuns=pgTable('directional_depth_runs',{id:text('id').primaryKey(),coin:bytes('coin').notNull(),block:bigint('block',{mode:'bigint'}).notNull(),blockHash:bytes('block_hash').notNull(),methodVersion:text('method_version').notNull(),acquiredAt:timestamp('acquired_at',{withTimezone:true}).notNull().defaultNow(),data:jsonb('data').notNull()},t=>[index('directional_depth_runs_coin_block').on(t.coin,t.block,t.acquiredAt)]);

export const engineCardFailures=pgTable('engine_card_failures',{coin:bytes('coin').primaryKey(),attempts:bigint('attempts',{mode:'bigint'}).notNull().default(0n),lastBlock:bigint('last_block',{mode:'bigint'}).notNull(),reason:text('reason').notNull()});

/** Explicit offline shadow reconstruction queue; no automatic evaluator or release path. */
export const campaignReplayJobs=pgTable('campaign_replay_jobs',{id:text('id').primaryKey(),coin:bytes('coin').notNull(),sourceRevision:text('source_revision').notNull(),input:jsonb('input').notNull(),status:text('status').notNull().default('queued'),result:jsonb('result'),queuedAt:timestamp('queued_at',{withTimezone:true}).notNull().defaultNow(),completedAt:timestamp('completed_at',{withTimezone:true})},t=>[index('campaign_replay_jobs_pending').on(t.queuedAt,t.id).where(sql`${t.status}='queued'`)]);

/** Versioned independent shadow labels and timer work; never legacy history input. */
export const outcomeLabelJobs=pgTable('outcome_label_jobs',{id:text('id').primaryKey(),streamId:text('stream_id').notNull(),coin:bytes('coin').notNull(),sourceRevision:text('source_revision').notNull(),input:jsonb('input').notNull(),nextDueSec:bigint('next_due_sec',{mode:'bigint'}).notNull(),status:text('status').notNull(),queuedAt:timestamp('queued_at',{withTimezone:true}).notNull().defaultNow()},t=>[index('outcome_label_jobs_due').on(t.nextDueSec,t.id).where(sql`${t.status}='queued'`)]);
export const outcomeLabelRevisions=pgTable('outcome_label_revisions',{id:text('id').primaryKey(),jobId:text('job_id').notNull().references(()=>outcomeLabelJobs.id),streamId:text('stream_id').notNull(),revision:integer('revision').notNull(),supersedes:text('supersedes'),data:jsonb('data').notNull(),dependencyIds:jsonb('dependency_ids').notNull(),pins:jsonb('pins').notNull(),recordedAt:timestamp('recorded_at',{withTimezone:true}).notNull().defaultNow()},t=>[unique().on(t.streamId,t.revision),index('outcome_label_revisions_stream').on(t.streamId,t.revision)]);
export const outcomeLabelEvents=pgTable('outcome_label_events',{id:text('id').primaryKey(),targetId:text('target_id').notNull().references(()=>outcomeLabelRevisions.id),kind:text('kind').notNull(),replacementId:text('replacement_id').references(()=>outcomeLabelRevisions.id),causeId:text('cause_id').notNull(),knownAt:jsonb('known_at').notNull(),recordedAt:timestamp('recorded_at',{withTimezone:true}).notNull().defaultNow()},t=>[index('outcome_label_events_target').on(t.targetId)]);

export const coinRatingChecks=pgTable('coin_rating_checks',{
  coin:bytes('coin').primaryKey(),checkedBlock:bigint('checked_block',{mode:'bigint'}).notNull(),
  checkedAt:timestamp('checked_at',{withTimezone:true,mode:'date'}).notNull(),fullBlock:bigint('full_block',{mode:'bigint'}).notNull(),
  fullPrice:doublePrecision('full_price'),peakRecorded:boolean('peak_recorded').notNull().default(false),outcomeSignature:text('outcome_signature'),
});
export const coinRatingPrices=pgTable('coin_rating_prices',{
  coin:bytes('coin').primaryKey(),price:doublePrecision('price').notNull(),peak:doublePrecision('peak').notNull(),
  ts:timestamp('ts',{withTimezone:true,mode:'date'}).notNull(),block:bigint('block',{mode:'bigint'}).notNull(),
  logIndex:integer('log_index').notNull(),txHash:bytes('tx_hash').notNull(),
});
