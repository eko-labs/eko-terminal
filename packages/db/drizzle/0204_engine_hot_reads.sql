-- Ordered pages avoid sorting a coin's entire swap history
CREATE INDEX IF NOT EXISTS swaps_coin_order ON swaps(coin,block,log_index,tx_hash,ts);
CREATE INDEX IF NOT EXISTS swaps_unpriced_coin ON swaps(coin) WHERE usd IS NULL;
-- Historical balance metadata only probes wallets changed after the requested checkpoint
CREATE INDEX IF NOT EXISTS transfers_holder_from_block ON token_transfers(token,from_address,block) WHERE kind='Transfer';
CREATE INDEX IF NOT EXISTS transfers_holder_to_block ON token_transfers(token,to_address,block) WHERE kind='Transfer';
-- A compact invalidation generation survives restarts and does not depend on the optional activity feed
CREATE TABLE IF NOT EXISTS engine_swap_versions (coin bytea PRIMARY KEY, revision bigint NOT NULL, high_block bigint NOT NULL);
CREATE TABLE IF NOT EXISTS engine_window_versions (bucket bigint PRIMARY KEY, revision bigint NOT NULL);
-- statement-breakpoint
CREATE OR REPLACE FUNCTION engine_swap_version_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  INSERT INTO engine_swap_versions AS v SELECT coin,0,max(block) FROM new_rows GROUP BY coin
  ON CONFLICT(coin) DO UPDATE SET revision=v.revision+CASE WHEN
    (SELECT min(block) FROM new_rows n WHERE n.coin=excluded.coin)<=v.high_block THEN 1 ELSE 0 END,
    high_block=greatest(v.high_block,excluded.high_block);
 ELSIF TG_OP='DELETE' THEN
  INSERT INTO engine_swap_versions AS v SELECT coin,1,max(block) FROM old_rows GROUP BY coin
  ON CONFLICT(coin) DO UPDATE SET revision=v.revision+1;
 ELSE
  INSERT INTO engine_swap_versions AS v SELECT coin,1,max(block) FROM (
   SELECT coin,block FROM old_rows UNION ALL SELECT coin,block FROM new_rows) r GROUP BY coin
  ON CONFLICT(coin) DO UPDATE SET revision=v.revision+1,high_block=greatest(v.high_block,excluded.high_block);
 END IF;
 -- Block buckets keep later appends from invalidating historical clone windows
 IF TG_OP='INSERT' THEN
  INSERT INTO engine_window_versions AS v SELECT DISTINCT block/10000,1 FROM new_rows
   ON CONFLICT(bucket) DO UPDATE SET revision=v.revision+1;
 ELSIF TG_OP='DELETE' THEN
  INSERT INTO engine_window_versions AS v SELECT DISTINCT block/10000,1 FROM old_rows
   ON CONFLICT(bucket) DO UPDATE SET revision=v.revision+1;
 ELSE
  INSERT INTO engine_window_versions AS v SELECT block/10000,1 FROM (SELECT block FROM old_rows UNION SELECT block FROM new_rows) r GROUP BY block/10000
   ON CONFLICT(bucket) DO UPDATE SET revision=v.revision+1;
 END IF;
 RETURN NULL;
END $$;
-- statement-breakpoint
CREATE TRIGGER engine_swap_version_insert AFTER INSERT ON swaps REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION engine_swap_version_changed();
CREATE TRIGGER engine_swap_version_update AFTER UPDATE ON swaps REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION engine_swap_version_changed();
CREATE TRIGGER engine_swap_version_delete AFTER DELETE ON swaps REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION engine_swap_version_changed();
-- Small durable mutex rows also serialize first writes when no schedule row exists yet
CREATE TABLE IF NOT EXISTS engine_write_locks (key text PRIMARY KEY);
