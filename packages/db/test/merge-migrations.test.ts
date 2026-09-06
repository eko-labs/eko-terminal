import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { binary, migrate, migrateEngines } from '../src/index.js';
import { openDb } from './helpers/historical-db.js';
import type { ChainDb } from '../src/index.js';

// Main's migration ledgers at the merge boundary. Use the actual retained SQL,
// not a synthetic schema, to exercise upgrades from a fully migrated main DB.
const mainIndexer = ['0101_chain','0102_market','0103_range_errors','0110_rpc_usage','0111_pending_senders','0112_pending_pricing','0117_pons_progress'];
const mainEngines = ['0104_engines','0105_engine_activity','0106_engine_rules_versions','0107_engine_pons_static','0108_engine_query_indexes','0113_v1_reads','0114_batched_read_models'];
const mergedTail = [
  ['engines','0221_pool_prices_headers'],
  ['indexer','0222_rpc_read_cache'],
  ['indexer','0224_watcher_evidence'],
  ['engines','0223_radar_row_projection'],
  ['engines','0225_rpc_provider_pause'],
] as const;
const mergedIndexer = [...mainIndexer.slice(0,-1),'0115_guard_sources','0117_pons_progress','0136_wallet_protocol','0150_agent_registry','0180_eth_usd_reference_sources','0181_transfer_baselines','0184_sparse_parent_links','0187_drop_holder_transfer_indexes','0188_block_and_pool_lookups','0190_chain_block_time_index','0195_reference_swaps_unnamed', '0199_swaps_index_diet', '0205_chain_read_indexes', '0206_watcher_read_indexes', '0207_raw_history_indexes', '0208_raw_history_progress', '0209_bar_write_locks', '0210_daily_raw_history','0211_bounded_raw_seals',...mergedTail.filter(([role])=>role==='indexer').map(([,id])=>id)];
const mergedEngines = [...mainEngines,'0116_guard_revisions','0118_guard_receipts','0119_guard_shadow','0120_receipt_outbox','0121_v3_reference_simulation','0122_private_receipts','0123_receipt_committer','0124_signal_shadow','0134_directional_depth','0135_scan_jobs','0137_v4_reference_simulation','0142_ghost_reports','0147_card_availability','0149_wallet_labels','0153_wallet_fingerprints','0154_wallet_fingerprint_indexes','0158_watcher_flow','0159_watcher_flow_invalidation','0161_campaign_replay','0168_outcome_labels','0169_swarm_worker','0175_swarm_paper','0179_review_api','0182_sell_checks','0183_engine_pool_indexes','0185_read_churn_and_history_prunes','0186_history_prune_ratings','0189_engine_activity_changes','0191_engine_run_written_at','0192_uniswap_coins','0193_refresh_listed_coins','0194_flow_dirty_statements','0196_verdicts_danger','0197_publication_sequence_index','0198_read_model_buyers_mark','0200_blue_chip','0201_determination_retention','0202_retention_probe_indexes','0203_rating_checks','0204_engine_hot_reads','0205_incremental_api_reads','0206_watcher_buyer_ranks','0207_raw_history_summaries','0208_retention_reads','0210_daily_raw_reads','0212_retention_batches','0213_coin_liquidity_reads','0214_rating_hotpaths','0215_radar_reads','0216_engine_throughput','0217_liquidity_revisions','0218_card_projection_sync','0219_sell_check_budget','0220_prepared_read_refresh',...mergedTail.filter(([role])=>role==='engines').map(([,id])=>id)];
async function applyMain(db: ChainDb) {
  for(const [ledger,ids] of [['eko_indexer_migrations',mainIndexer],['eko_engine_migrations',mainEngines]] as const) {
    await db.sql.query(`CREATE TABLE ${ledger}(id text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())`);
    for(const id of ids) {
      const sql=await readFile(new URL(`../drizzle/${id}.sql`,import.meta.url),'utf8');
      const statements=['0113_v1_reads','0114_batched_read_models'].includes(id)
        ? sql.split('-- statement-breakpoint').flatMap(s=>s.includes('CREATE FUNCTION')?[s]:s.split(';')) : sql.split(';');
      for(const statement of statements.map(s=>s.trim()).filter(Boolean))await db.sql.query(statement);
      await db.sql.query(`INSERT INTO ${ledger}(id) VALUES($1)`,[id]);
    }
  }
}
async function assertMerged(db: ChainDb) {
  expect((await db.sql.query("SELECT tablename FROM pg_tables WHERE tablename IN ('rpc_code_cache','token_balance_origins','rpc_paid_daily')")).rows).toHaveLength(3);
  const keptSwapIndexes = ['swaps_pkey','swaps_pool_block','swaps_coin_ts','swaps_priced_ts_block_coin','swaps_pending_coin','swaps_pending_pricing_coin','swaps_block_ts','swaps_coin_order','swaps_unpriced_coin','swaps_tx_log_ts','swaps_feed_trade_window','swaps_positive_coin_order','swaps_buy_wallet_first','swaps_fingerprint_wallet_order','swaps_unpriced_time'].sort();
  expect((await db.sql.query<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE tablename='swaps' ORDER BY indexname")).rows.map(r=>r.indexname)).toEqual(keptSwapIndexes);
  expect((await db.sql.query<{indexname:string}>("SELECT indexname FROM pg_indexes WHERE tablename='token_transfers' ORDER BY indexname")).rows.map(r=>r.indexname)).toEqual(['token_transfers_block','token_transfers_pkey','token_transfers_token_block','transfers_holder_from_block','transfers_holder_to_block']);
  expect((await db.sql.query("SELECT indexname FROM pg_indexes WHERE tablename LIKE 'swaps_%' AND indexdef LIKE '%(quote_asset, block)%'")).rows).toHaveLength(0);
  const partitions = (await db.sql.query<{ relname: string; indexes: number }>(`SELECT c.relname,count(x.indexrelid)::integer AS indexes
    FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid LEFT JOIN pg_index x ON x.indrelid=c.oid
    WHERE i.inhparent='swaps'::regclass GROUP BY c.relname`)).rows;
  expect(partitions.length).toBeGreaterThanOrEqual(3);
  for (const partition of partitions) expect(partition.indexes).toBe(keptSwapIndexes.length);
  expect((await db.sql.query("SELECT tablename FROM pg_tables WHERE tablename='eth_usd_reference_sources'")).rows).toHaveLength(1);
  expect((await db.sql.query("SELECT tablename FROM pg_tables WHERE tablename IN ('swarm_paper_positions','swarm_paper_events','swarm_paper_grades','swarm_calibration_inputs','swarm_calibration_outcomes','swarm_calibration_baselines','swarm_calibration_reports','swarm_paper_checkpoint','swarm_paper_ticks','swarm_momentum_models','swarm_calibration_cohorts')")).rows).toHaveLength(11);
  expect((await db.sql.query("SELECT tgname FROM pg_trigger WHERE tgname IN ('swarm_paper_events_immutable','swarm_paper_grades_immutable','swarm_calibration_inputs_immutable','swarm_calibration_outcomes_immutable','swarm_calibration_baselines_immutable','swarm_calibration_reports_immutable','swarm_paper_ticks_immutable','swarm_momentum_models_immutable','swarm_calibration_cohorts_immutable')")).rows).toHaveLength(9);
  expect((await db.sql.query("SELECT tablename FROM pg_tables WHERE tablename IN ('swarm_jobs','persona_sets','swarm_budget_reservations','persona_votes','swarm_cache','forecasts')")).rows).toHaveLength(6);
  expect((await db.sql.query("SELECT tgname FROM pg_trigger WHERE tgname IN ('persona_sets_immutable','swarm_budget_immutable','persona_votes_immutable','swarm_cache_immutable','forecasts_immutable')")).rows).toHaveLength(5);
  expect((await db.sql.query("SELECT tablename FROM pg_tables WHERE tablename IN ('flow_windows','flow_events','eval_gates','flow_dirty','census_snapshots','watcher_flow_model')")).rows).toHaveLength(6);
  expect((await db.sql.query("SELECT tablename FROM pg_tables WHERE tablename IN ('wallet_fingerprint_runs','wallet_fingerprint_dependencies','wallet_label_fingerprint_dependencies','wallet_fingerprint_state')")).rows).toHaveLength(4);
  expect((await db.sql.query("SELECT tgname FROM pg_trigger WHERE tgname IN ('wallet_fingerprint_runs_immutable','wallet_fingerprint_dependencies_immutable','wallet_label_fingerprint_dependencies_immutable')")).rows).toHaveLength(3);
  expect((await db.sql.query("SELECT tablename FROM pg_tables WHERE tablename IN ('review_cases','review_case_revisions','review_assignments','review_labels','review_adjudications')")).rows).toHaveLength(5);
  expect((await db.sql.query("SELECT tgname FROM pg_trigger WHERE tgname IN ('review_cases_immutable','review_case_revisions_immutable','review_assignments_immutable','review_labels_immutable','review_adjudications_immutable')")).rows).toHaveLength(5);
  expect((await db.sql.query("SELECT tablename FROM pg_tables WHERE tablename IN ('outcome_label_jobs','outcome_label_revisions','outcome_label_events')")).rows).toHaveLength(3);
  expect((await db.sql.query("SELECT tablename FROM pg_tables WHERE tablename='campaign_replay_jobs'")).rows).toHaveLength(1);
  expect((await db.sql.query("SELECT tablename FROM pg_tables WHERE tablename IN ('ghost_report_drafts','ghost_report_reviews')")).rows).toHaveLength(2);
  expect((await db.sql.query("SELECT tgname FROM pg_trigger WHERE tgname IN ('ghost_report_drafts_immutable','ghost_report_reviews_immutable')")).rows).toHaveLength(2);
  expect((await db.sql.query("SELECT tablename FROM pg_tables WHERE tablename='engine_card_failures'")).rows).toHaveLength(1);
  expect((await db.sql.query("SELECT tablename FROM pg_tables WHERE tablename IN ('engine_evaluation_counts','engine_first_scan_plans')")).rows).toHaveLength(2);
  expect((await db.sql.query("SELECT tablename FROM pg_tables WHERE tablename IN ('scan_jobs','scan_timings')")).rows).toHaveLength(2);
  expect((await db.sql.query("SELECT tgname FROM pg_trigger WHERE tgname IN ('scan_launch_discovery','scan_pair_discovery')")).rows).toHaveLength(2);
  expect((await db.sql.query("SELECT tablename FROM pg_tables WHERE tablename='directional_depth_runs'")).rows).toHaveLength(1);
  expect((await db.sql.query("SELECT tablename FROM pg_tables WHERE tablename='v4_reference_runs'")).rows).toHaveLength(1);
  expect((await db.sql.query("SELECT tablename FROM pg_tables WHERE tablename='signal_shadow_runs'")).rows).toHaveLength(1);
  expect((await db.sql.query("SELECT tablename FROM pg_tables WHERE tablename IN ('receipt_worker_lease','receipt_commit_attempts','receipt_commit_failures','receipt_commit_anchors','receipt_commit_anchor_events')")).rows).toHaveLength(5);
  expect((await db.sql.query('SELECT * FROM receipt_commit_health')).rows).toHaveLength(1);
  expect((await db.sql.query<{id:string}>('SELECT id FROM eko_indexer_migrations ORDER BY id')).rows.map(r=>r.id)).toEqual(mergedIndexer);
  expect((await db.sql.query<{id:string}>('SELECT id FROM eko_engine_migrations ORDER BY id')).rows.map(r=>r.id)).toEqual(mergedEngines);
  expect((await db.sql.query("SELECT tablename FROM pg_tables WHERE tablename='sim_runs'")).rows).toHaveLength(1);
  expect((await db.sql.query("SELECT tablename FROM pg_tables WHERE tablename IN ('sell_check_latest','sell_check_runs','sell_check_refusals')")).rows).toHaveLength(3);
  expect((await db.sql.query("SELECT tgname FROM pg_trigger WHERE tgname IN ('read_sell_check_insert','read_sell_check_update')")).rows).toHaveLength(2);
  expect((await db.sql.query("SELECT indexname FROM pg_indexes WHERE indexname='pons_events_token_block'")).rows).toHaveLength(1);
  expect((await db.sql.query("SELECT tablename FROM pg_tables WHERE tablename IN ('guard_availability','guard_verdict_revisions','guard_receipt_payloads','guard_shadow_runs')")).rows).toHaveLength(4);
}
describe('main and Guard migration union',()=>{
  it('applies all migrations on a fresh DB, then replays idempotently',async()=>{
    const db=await openDb({pgliteDir:':memory:'});
    try {
      await migrate(db);await migrateEngines(db);await assertMerged(db);
      await migrate(db);await migrateEngines(db);await assertMerged(db);
    }finally{await db.close();}
  });
  it('bootstraps buyer counts and only differing buyer keys when upgrading populated projections',async()=>{
    const db=await openDb({pgliteDir:':memory:'});
    try {
      await migrate(db);
      await db.sql.query('CREATE TABLE eko_engine_migrations(id text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
      // Defer the refresh replacement too until its projection tables are installed.
      await db.sql.query("INSERT INTO eko_engine_migrations(id) VALUES('0205_incremental_api_reads'),('0207_raw_history_summaries'),('0208_retention_reads'),('0210_daily_raw_reads'),('0217_liquidity_revisions'),('0218_card_projection_sync'),('0220_prepared_read_refresh')");
      await migrateEngines(db);
      const coin=binary(`0x${'ab'.repeat(20)}`),trader=binary(`0x${'ef'.repeat(20)}`);
      await db.sql.query('INSERT INTO tokens(address,deployer,first_block,block) VALUES($1,$2,1,1)',[coin,trader]);
      await db.sql.query('INSERT INTO chain_blocks(number,block,hash,parent_hash,ts) VALUES(1,1,$1,$1,now())',[binary(`0x${'00'.repeat(32)}`)]);
      await db.sql.query(`INSERT INTO swaps(ts,block,tx_hash,log_index,venue,pool_id,coin,quote_asset,trader,side,amount_coin,amount_quote)
        VALUES(now(),1,$1,0,'pons_curve',$2,$2,$2,$3,1,1,1)`,[binary(`0x${'cd'.repeat(32)}`),coin,trader]);
      await db.sql.query('SELECT refresh_read_models(ARRAY[$1::bytea],extract(epoch FROM now())::bigint)',[coin]);
      await db.sql.query('INSERT INTO read_buyers VALUES($1,$2)',[coin,binary(`0x${'dd'.repeat(20)}`)]);
      await db.sql.query("DELETE FROM eko_engine_migrations WHERE id IN ('0205_incremental_api_reads','0207_raw_history_summaries','0208_retention_reads','0210_daily_raw_reads','0217_liquidity_revisions','0218_card_projection_sync','0220_prepared_read_refresh')");
      await migrateEngines(db);
      expect((await db.sql.query('SELECT n::int FROM read_buyer_totals WHERE coin=$1',[coin])).rows).toEqual([{n:2}]);
      expect((await db.sql.query("SELECT encode(trader,'hex') AS trader FROM read_buyer_dirty WHERE coin=$1",[coin])).rows).toEqual([{trader:'dd'.repeat(20)}]);
      await db.sql.query('SELECT refresh_read_models(ARRAY[$1::bytea],extract(epoch FROM now())::bigint)',[coin]);
      expect((await db.sql.query('SELECT n::int FROM read_buyer_totals WHERE coin=$1',[coin])).rows).toEqual([{n:1}]);
      expect((await db.sql.query('SELECT buyers::int FROM read_coins WHERE coin=$1',[coin])).rows).toEqual([{buyers:1}]);
    }finally{await db.close();}
  });
  it('inherits all read indexes into newly created days and indexes transaction lookups without a swap scan',async()=>{
    const db=await openDb({pgliteDir:':memory:'});
    try {
      await migrate(db);await migrateEngines(db);await db.ensurePartitions(new Date('2027-01-01T00:00:00Z'));
      for(const table of ['swaps_d2027_01_01','swaps_d2027_01_02','swaps_d2027_01_03']) {
        const defs=(await db.sql.query<{indexdef:string}>('SELECT indexdef FROM pg_indexes WHERE tablename=$1',[table])).rows.map(r=>r.indexdef).join('\n');
        expect(defs).toContain('(tx_hash, log_index, ts DESC)');expect(defs).toContain('(coin, trader, block, tx_hash, log_index)');expect(defs).toContain('(ts, block, tx_hash, log_index)');
      }
      const coin=binary(`0x${'ab'.repeat(20)}`),hash=binary(`0x${'cd'.repeat(32)}`);
      await db.sql.query('INSERT INTO tokens(address,first_block,block) VALUES($1,1,1)',[coin]);
      await db.sql.query(`INSERT INTO swaps(ts,block,tx_hash,log_index,venue,pool_id,coin,quote_asset,side,amount_coin,amount_quote)
        SELECT '2027-01-01'::timestamptz+n*interval '1 second',n,decode(lpad(to_hex(n),64,'0'),'hex'),0,'pons_curve',$1,$1,$1,1,1,1 FROM generate_series(1,5000) n`,[coin]);
      await db.sql.query('ANALYZE swaps_d2027_01_01');
      const plan=JSON.stringify((await db.sql.query(`EXPLAIN SELECT s.*,t.decimals FROM swaps s JOIN tokens t ON t.address=s.coin
        WHERE tx_hash=$1 AND log_index=$2 AND s.ts>to_timestamp($3::double precision)-interval '1 hour' ORDER BY ts DESC LIMIT 1`,[hash,0,Date.parse('2027-01-01T02:00:00Z')/1000])).rows);
      expect(plan).toContain('Index Scan');expect(plan).toContain('tx_hash');expect(plan).not.toContain('Seq Scan on swaps');
    }finally{await db.close();}
  });
  it('upgrades a main-migrated DB without replaying its migrations or losing launch/verdict data',async()=>{
    const db=await openDb({pgliteDir:':memory:'});
    try {
      await applyMain(db);
      await db.ensurePartitions(new Date('2026-01-01T00:00:00Z'));
      expect((await db.sql.query("SELECT indexname FROM pg_indexes WHERE tablename='swaps_d2026_01_01' AND indexdef LIKE '%(quote_asset, block)%'")).rows).toHaveLength(1);
      const coin=binary(`0x${'ab'.repeat(20)}`),txHash=binary(`0x${'cd'.repeat(32)}`),data={kind:'launch',graduationThreshold:'1000',creatorTaxBps:250};
      await db.sql.query('INSERT INTO pons_events(block,tx_hash,log_index,token,emitter,kind,data) VALUES(1,$1,0,$2,$2,$3,$4)',[txHash,coin,'launch',JSON.stringify(data)]);
      await db.sql.query("INSERT INTO verdicts(id,coin,valid_from_block,rules_version,signature,data) VALUES('main-fixture',$1,1,'1.0.2','fixture','{}')",[coin]);
      await db.sql.query("INSERT INTO coin_cards VALUES('main-card',$1,1,'initial','{}','1.0.2')",[coin]);
      await db.sql.query("INSERT INTO coin_card_latest VALUES($1,'main-card',1,'{}')",[coin]);
      const cardsBefore=(await db.sql.query('SELECT * FROM coin_cards')).rows;
      const before=(await db.sql.query('SELECT * FROM eko_indexer_migrations ORDER BY id')).rows;
      await migrate(db);await migrateEngines(db);await assertMerged(db);
      expect((await db.sql.query<{data:unknown}>('SELECT data FROM pons_events')).rows[0].data).toEqual(data);
      expect((await db.sql.query("SELECT id FROM verdicts WHERE id='main-fixture'")).rows).toHaveLength(1);
      const after=(await db.sql.query('SELECT * FROM eko_indexer_migrations WHERE id NOT IN ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) ORDER BY id',['0115_guard_sources','0136_wallet_protocol','0150_agent_registry','0180_eth_usd_reference_sources','0181_transfer_baselines','0184_sparse_parent_links','0187_drop_holder_transfer_indexes','0188_block_and_pool_lookups','0190_chain_block_time_index','0195_reference_swaps_unnamed', '0199_swaps_index_diet', '0205_chain_read_indexes', '0206_watcher_read_indexes', '0207_raw_history_indexes', '0208_raw_history_progress', '0209_bar_write_locks', '0210_daily_raw_history','0211_bounded_raw_seals','0222_rpc_read_cache','0224_watcher_evidence'])).rows;
      expect(after).toEqual(before);
      expect((await db.sql.query('SELECT * FROM coin_cards')).rows).toEqual(cardsBefore);
      await db.sql.query("INSERT INTO coin_cards VALUES('enriched-card',$1,1,'enriched','{}','1.0.2')",[coin]);
      expect((await db.sql.query('SELECT * FROM coin_cards')).rows).toHaveLength(2);
      expect((await db.sql.query('SELECT card_id FROM coin_card_latest')).rows[0].card_id).toBe('main-card');
      await migrate(db);await migrateEngines(db);await assertMerged(db);
    }finally{await db.close();}
  });
  it('renumbers a pre-merge Guard ledger while retaining the immutable journal',async()=>{
    const db=await openDb({pgliteDir:':memory:'});
    try {
      await migrate(db);await migrateEngines(db);
      const id=`0x${'de'.repeat(32)}`,coin=`0x${'ab'.repeat(20)}`;
      await db.sql.query("INSERT INTO verdicts(id,coin,valid_from_block,rules_version,signature,data) VALUES('guard-fixture',$1,1,'1.0.2','fixture','{}')",[binary(coin)]);
      await db.sql.query("INSERT INTO guard_shadow_runs(id,coin,block,legacy_verdict_id,status,data,recorded_at) VALUES($1,$2,1,'guard-fixture','missing_cursor','{}',now())",[id,coin]);
      const before=(await db.sql.query('SELECT * FROM guard_shadow_runs')).rows;
      await db.sql.query('UPDATE eko_engine_migrations SET id=$1 WHERE id=$2',[['0117','guard_shadow'].join('_'),'0119_guard_shadow']);
      await migrate(db);await migrateEngines(db);await assertMerged(db);
      expect((await db.sql.query('SELECT * FROM guard_shadow_runs')).rows).toEqual(before);
      await expect(db.sql.query('DELETE FROM guard_shadow_runs')).rejects.toThrow('append-only');
    }finally{await db.close();}
  });
});
