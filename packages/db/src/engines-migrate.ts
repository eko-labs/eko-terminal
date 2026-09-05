import { readFile } from 'node:fs/promises';
import type { ChainDb } from './client.js';
/** Applied by the engines role; indexer and heritage migrations keep separate ledgers. */
export async function migrateEngines(db: ChainDb) {
  const migrations=await Promise.all(['0104_engines','0105_engine_activity','0106_engine_rules_versions','0107_engine_pons_static','0108_engine_query_indexes','0113_v1_reads','0114_batched_read_models','0116_guard_revisions','0118_guard_receipts','0119_guard_shadow','0120_receipt_outbox','0121_v3_reference_simulation','0122_private_receipts','0123_receipt_committer','0124_signal_shadow','0134_directional_depth','0135_scan_jobs','0137_v4_reference_simulation','0142_ghost_reports','0147_card_availability','0149_wallet_labels','0153_wallet_fingerprints','0154_wallet_fingerprint_indexes','0158_watcher_flow','0159_watcher_flow_invalidation','0161_campaign_replay','0168_outcome_labels','0169_swarm_worker','0175_swarm_paper','0179_review_api','0182_sell_checks','0183_engine_pool_indexes','0185_read_churn_and_history_prunes','0186_history_prune_ratings','0189_engine_activity_changes','0191_engine_run_written_at','0192_uniswap_coins','0193_refresh_listed_coins','0194_flow_dirty_statements','0196_verdicts_danger','0197_publication_sequence_index','0198_read_model_buyers_mark','0200_blue_chip','0201_determination_retention','0202_retention_probe_indexes','0203_rating_checks','0204_engine_hot_reads','0205_incremental_api_reads','0206_watcher_buyer_ranks','0207_raw_history_summaries','0208_retention_reads','0210_daily_raw_reads','0212_retention_batches','0213_coin_liquidity_reads','0214_rating_hotpaths','0215_radar_reads','0216_engine_throughput','0217_liquidity_revisions','0218_card_projection_sync','0219_sell_check_budget','0220_prepared_read_refresh','0221_pool_prices_headers','0223_radar_row_projection','0225_rpc_provider_pause'].map(async id=>({id,sql:await readFile(new URL(`${import.meta.url.includes('/dist/') ? './chain-drizzle/' : '../drizzle/'}${id}.sql`,import.meta.url),'utf8')})));
  await db.sql.query('CREATE TABLE IF NOT EXISTS eko_engine_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  await db.tx(async tx=>{
    await tx.sql.query("SET LOCAL lock_timeout='5s'");
    await tx.sql.query('LOCK TABLE eko_engine_migrations IN EXCLUSIVE MODE');
    for (const {id,sql} of migrations) {
      const applied=await tx.sql.query('SELECT id FROM eko_engine_migrations WHERE id=$1',[id]);
      if (applied.rows.length) continue;
      // Renumber an already-applied Guard journal without recreating its table
      // or touching immutable records. Main's Pons ID belongs to the other ledger.
      if (id==='0119_guard_shadow') {
        const prior=(await tx.sql.query<{id:string}>("SELECT id FROM eko_engine_migrations WHERE id ~ '^[0-9]{4}_guard_shadow$' AND id<$1 ORDER BY id DESC LIMIT 1",[id])).rows[0];
        if(prior) {
          await tx.sql.query('UPDATE eko_engine_migrations SET id=$1 WHERE id=$2',[id,prior.id]);
          continue;
        }
      }
      // Repair successful pre-review installs without rerunning projection/table backfills.
      if (id==='0113_v1_reads' && (await tx.sql.query("SELECT id FROM eko_engine_migrations WHERE id='0111_v1_reads'")).rows.length) {
        await tx.sql.query('DROP INDEX IF EXISTS tokens_symbol_lower');
        await tx.sql.query('DROP INDEX IF EXISTS tokens_symbol_address');
        const index=sql.match(/^CREATE INDEX tokens_symbol_address .*;$/m)?.[0];
        if (!index) throw new Error('Read migration is missing its bounded symbol index');
        await tx.sql.query(index);
        await tx.sql.query("UPDATE eko_engine_migrations SET id=$1 WHERE id='0111_v1_reads'",[id]);
        continue;
      }
      for (const statement of (['0113_v1_reads','0114_batched_read_models','0116_guard_revisions','0135_scan_jobs','0149_wallet_labels','0159_watcher_flow_invalidation','0185_read_churn_and_history_prunes','0189_engine_activity_changes','0192_uniswap_coins','0193_refresh_listed_coins','0194_flow_dirty_statements','0198_read_model_buyers_mark','0200_blue_chip','0201_determination_retention','0203_rating_checks','0204_engine_hot_reads','0205_incremental_api_reads','0206_watcher_buyer_ranks','0207_raw_history_summaries','0208_retention_reads','0210_daily_raw_reads','0213_coin_liquidity_reads','0214_rating_hotpaths','0215_radar_reads','0217_liquidity_revisions','0218_card_projection_sync','0220_prepared_read_refresh','0221_pool_prices_headers','0223_radar_row_projection'].includes(id) ? sql.split('-- statement-breakpoint').flatMap(s=>(s.includes('CREATE FUNCTION') || s.includes('CREATE OR REPLACE FUNCTION') || s.includes('DO $$')) ? [s] : s.split(';')) : sql.split(';')).map(s=>s.trim()).filter(Boolean)) await tx.sql.query(statement);
      await tx.sql.query('INSERT INTO eko_engine_migrations(id) VALUES($1)',[id]);
    }
  });
}
