-- Live engine polls load only coins whose activity changed (apps/engines/src/live-activity.ts). Until 2026-10-08 every
-- poll aggregated every swap, transfer, liquidity and Pons event of every coin, which took many minutes per poll in
-- production and starved the indexer. New blocks are read directly by block number. This log records every other
-- change to an engine activity source: rows written or rewritten at old blocks (backfills, sender enrichment, reorg
-- rollbacks, retention), pool and launch changes, and block times written by any process. One row per statement.
--
-- Rows are written only while a live engine follows the log (engine_activity_feed.seen_at within a day), so an indexer
-- running without engines does not grow it. The engine reads the rows committed since its previous read by transaction
-- snapshot, so several readers never take rows from each other, and it deletes rows older than a day. `block` is the
-- newest block a live poll has read. `complete` is false from a start without a live log until that start's refresh
-- has made up for what the log missed.
CREATE TABLE engine_activity_feed (id boolean PRIMARY KEY DEFAULT true CHECK(id), block bigint NOT NULL, seen_at timestamptz NOT NULL, complete boolean NOT NULL);
CREATE TABLE engine_activity_changes (
 xid xid8 NOT NULL DEFAULT pg_current_xact_id(), at timestamptz NOT NULL DEFAULT now(),
 source text NOT NULL, coins bytea[], blocks bigint[] NOT NULL
);
CREATE INDEX engine_activity_changes_xid ON engine_activity_changes(xid);
CREATE INDEX engine_activity_changes_at ON engine_activity_changes(at)
-- statement-breakpoint
-- For each coin a statement touched, the lowest block it touched; for block times, the block numbers. Liquidity rows
-- belong to both pool currencies, as in the engine's activity query. A token row counts only when a field the engine
-- reads changed (first_block, supply_block, graduated_block); metadata updates are not logged.
CREATE FUNCTION engine_activity_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
 cols text; touched text;
BEGIN
 IF NOT EXISTS (SELECT 1 FROM engine_activity_feed WHERE seen_at > now() - interval '1 day') THEN RETURN NULL; END IF;
 cols := CASE TG_TABLE_NAME
  WHEN 'swaps' THEN 'SELECT coin, block FROM %1$s'
  WHEN 'token_transfers' THEN 'SELECT token, block FROM %1$s'
  WHEN 'pons_events' THEN 'SELECT token, block FROM %1$s'
  WHEN 'pons_exemptions' THEN 'SELECT token, block FROM %1$s'
  WHEN 'liquidity_events' THEN 'SELECT c, e.block FROM %1$s e JOIN pools p ON p.id = e.pool_id CROSS JOIN LATERAL (VALUES (p.currency0), (p.currency1)) v(c)'
  WHEN 'pools' THEN 'SELECT c, p.created_block FROM %1$s p CROSS JOIN LATERAL (VALUES (p.currency0), (p.currency1)) v(c)'
  WHEN 'tokens' THEN 'SELECT address, first_block FROM %1$s'
  WHEN 'engine_block_times' THEN 'SELECT NULL::bytea, number FROM %1$s'
 END;
 IF TG_TABLE_NAME = 'tokens' AND TG_OP = 'UPDATE' THEN
  touched := 'SELECT n.address, least(n.first_block, o.first_block) FROM new_rows n JOIN old_rows o ON o.address = n.address
   WHERE (n.first_block, n.supply_block, n.graduated_block) IS DISTINCT FROM (o.first_block, o.supply_block, o.graduated_block)';
 ELSIF TG_OP = 'INSERT' THEN touched := format(cols, 'new_rows');
 ELSIF TG_OP = 'DELETE' THEN touched := format(cols, 'old_rows');
 ELSE touched := format(cols, 'old_rows') || ' UNION ALL ' || format(cols, 'new_rows');
 END IF;
 IF TG_TABLE_NAME = 'engine_block_times' THEN
  EXECUTE format('INSERT INTO engine_activity_changes(source, blocks) SELECT %L, array_agg(DISTINCT b) FROM (%s) x(c, b) HAVING count(*) > 0',
   TG_TABLE_NAME, touched);
 ELSE
  EXECUTE format('INSERT INTO engine_activity_changes(source, coins, blocks) SELECT %L, array_agg(c ORDER BY c), array_agg(b ORDER BY c)
   FROM (SELECT c, min(b) AS b FROM (%s) x(c, b) WHERE c IS NOT NULL GROUP BY c) y HAVING count(*) > 0', TG_TABLE_NAME, touched);
 END IF;
 RETURN NULL;
END $$
-- statement-breakpoint
-- Statement-level triggers cost one small insert per statement, not one per row. Transition tables need one trigger per
-- event. Partitioned tables (swaps, token_transfers) carry them on the parent, which covers every partition.
CREATE TRIGGER engine_activity_swaps_insert AFTER INSERT ON swaps REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION engine_activity_changed();
CREATE TRIGGER engine_activity_swaps_update AFTER UPDATE ON swaps REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION engine_activity_changed();
CREATE TRIGGER engine_activity_swaps_delete AFTER DELETE ON swaps REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION engine_activity_changed();
CREATE TRIGGER engine_activity_token_transfers_insert AFTER INSERT ON token_transfers REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION engine_activity_changed();
CREATE TRIGGER engine_activity_token_transfers_update AFTER UPDATE ON token_transfers REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION engine_activity_changed();
CREATE TRIGGER engine_activity_token_transfers_delete AFTER DELETE ON token_transfers REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION engine_activity_changed();
CREATE TRIGGER engine_activity_liquidity_events_insert AFTER INSERT ON liquidity_events REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION engine_activity_changed();
CREATE TRIGGER engine_activity_liquidity_events_update AFTER UPDATE ON liquidity_events REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION engine_activity_changed();
CREATE TRIGGER engine_activity_liquidity_events_delete AFTER DELETE ON liquidity_events REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION engine_activity_changed();
CREATE TRIGGER engine_activity_pons_events_insert AFTER INSERT ON pons_events REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION engine_activity_changed();
CREATE TRIGGER engine_activity_pons_events_update AFTER UPDATE ON pons_events REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION engine_activity_changed();
CREATE TRIGGER engine_activity_pons_events_delete AFTER DELETE ON pons_events REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION engine_activity_changed();
CREATE TRIGGER engine_activity_pons_exemptions_insert AFTER INSERT ON pons_exemptions REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION engine_activity_changed();
CREATE TRIGGER engine_activity_pons_exemptions_update AFTER UPDATE ON pons_exemptions REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION engine_activity_changed();
CREATE TRIGGER engine_activity_pons_exemptions_delete AFTER DELETE ON pons_exemptions REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION engine_activity_changed();
CREATE TRIGGER engine_activity_pools_insert AFTER INSERT ON pools REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION engine_activity_changed();
CREATE TRIGGER engine_activity_pools_update AFTER UPDATE ON pools REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION engine_activity_changed();
CREATE TRIGGER engine_activity_pools_delete AFTER DELETE ON pools REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION engine_activity_changed();
CREATE TRIGGER engine_activity_tokens_insert AFTER INSERT ON tokens REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION engine_activity_changed();
CREATE TRIGGER engine_activity_tokens_update AFTER UPDATE ON tokens REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION engine_activity_changed();
CREATE TRIGGER engine_activity_tokens_delete AFTER DELETE ON tokens REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION engine_activity_changed();
CREATE TRIGGER engine_activity_engine_block_times_insert AFTER INSERT ON engine_block_times REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION engine_activity_changed();
CREATE TRIGGER engine_activity_engine_block_times_update AFTER UPDATE ON engine_block_times REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION engine_activity_changed();
CREATE TRIGGER engine_activity_engine_block_times_delete AFTER DELETE ON engine_block_times REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION engine_activity_changed();
-- Per-coin progress: the coin's revision is a sum over its activity rows (apps/engines/src/activity.ts partHash). The
-- sum and newest event time of its rows at or below base_block let the next poll, or the next process, read only the
-- rows above it. last_sec (newest event time, epoch seconds) selects the coins a new process may plan.
ALTER TABLE engine_activity_state ADD COLUMN base_block bigint, ADD COLUMN base_sum text, ADD COLUMN base_sec double precision, ADD COLUMN last_sec double precision;
CREATE INDEX engine_activity_state_last_sec ON engine_activity_state(last_sec);
-- Block lookups for the per-poll window over the small tables (the large ones have them since 0188), and for launches
-- at startup.
CREATE INDEX IF NOT EXISTS pons_exemptions_block ON pons_exemptions(block);
CREATE INDEX IF NOT EXISTS pools_created_block ON pools(created_block);
CREATE INDEX IF NOT EXISTS tokens_first_block ON tokens(first_block)
