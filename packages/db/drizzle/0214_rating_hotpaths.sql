-- Compact generations are independent of the optional live feed and survive restarts.
CREATE TABLE engine_rating_versions(coin bytea PRIMARY KEY,revision bigint NOT NULL);
CREATE TABLE engine_activity_versions(coin bytea PRIMARY KEY,revision bigint NOT NULL);
CREATE TABLE engine_activity_block_versions(coin bytea NOT NULL,block bigint NOT NULL,revision bigint NOT NULL,PRIMARY KEY(coin,block));
CREATE INDEX engine_activity_block_versions_revision ON engine_activity_block_versions(coin,revision,block);
CREATE INDEX sell_check_runs_coin_block_result ON sell_check_runs(coin,block) WHERE status IN ('sellable','refused');
CREATE INDEX pons_exemptions_token_block ON pons_exemptions(token,block);
CREATE INDEX pools_currency0_created ON pools(currency0,created_block);
CREATE INDEX pools_currency1_created ON pools(currency1,created_block);
-- Card JSON is decoded once per write, rather than on every candidate poll.
CREATE TABLE engine_rating_candidates(coin bytea PRIMARY KEY,card_id text NOT NULL,as_of_block bigint NOT NULL,
 legacy boolean NOT NULL,pending boolean NOT NULL,missing_honeypot boolean NOT NULL,missing_pricing boolean NOT NULL,control_unavailable boolean NOT NULL);
CREATE VIEW engine_rating_candidate_rows AS SELECT coin,card_id,as_of_block,
 (NOT coalesce(data->'verdict'->'evaluatedPlaybooks','[]'::jsonb) ?& ARRAY['bundle_dump','holder_concentration','dev_dump','run_up']
 OR coalesce(data->'playbooks','[]'::jsonb) @> '[{"id":"bundle_dump"}]'
 OR coalesce(data->'playbooks','[]'::jsonb) @> '[{"id":"run_up"}]') AS legacy,
 coalesce(data->'verdict'->>'level'='pending',false) AS pending,
 NOT coalesce(data->'verdict'->'evaluatedPlaybooks','[]'::jsonb) ? 'honeypot' AS missing_honeypot,
 (NOT coalesce(data->'verdict'->'evaluatedPlaybooks','[]'::jsonb) ? 'wash_to_trend'
 OR NOT coalesce(data->'verdict'->'evaluatedPlaybooks','[]'::jsonb) ? 'stuck_at_bonding') AS missing_pricing,
 coalesce(data->'meta'->'control'->>'unavailable'='true',false) AS control_unavailable FROM coin_card_latest;
INSERT INTO engine_rating_candidates SELECT * FROM engine_rating_candidate_rows;
-- statement-breakpoint
CREATE FUNCTION engine_rating_candidate_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN DELETE FROM engine_rating_candidates WHERE coin IN(SELECT coin FROM old_rows);
 ELSIF TG_OP='UPDATE' THEN DELETE FROM engine_rating_candidates WHERE coin IN(SELECT coin FROM old_rows EXCEPT SELECT coin FROM new_rows); END IF;
 IF TG_OP<>'DELETE' THEN
  INSERT INTO engine_rating_candidates SELECT r.* FROM new_rows n CROSS JOIN LATERAL(SELECT * FROM engine_rating_candidate_rows WHERE coin=n.coin OFFSET 0) r
  ON CONFLICT(coin) DO UPDATE SET card_id=excluded.card_id,as_of_block=excluded.as_of_block,legacy=excluded.legacy,
  pending=excluded.pending,missing_honeypot=excluded.missing_honeypot,missing_pricing=excluded.missing_pricing,control_unavailable=excluded.control_unavailable;
 END IF;
 RETURN NULL;
END $$;
-- statement-breakpoint
CREATE FUNCTION engine_rating_version_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE col text; src text;
BEGIN
 col=CASE TG_TABLE_NAME WHEN 'tokens' THEN 'address' ELSE 'coin' END;
 src=CASE TG_OP WHEN 'INSERT' THEN 'SELECT '||col||' coin FROM new_rows' WHEN 'DELETE' THEN 'SELECT '||col||' coin FROM old_rows'
 ELSE 'SELECT '||col||' coin FROM new_rows UNION SELECT '||col||' coin FROM old_rows' END;
 EXECUTE 'INSERT INTO engine_rating_versions AS v SELECT DISTINCT coin,1 FROM ('||src||') x ORDER BY coin
 ON CONFLICT(coin) DO UPDATE SET revision=v.revision+1';
 RETURN NULL;
END $$;
-- statement-breakpoint
-- Exact changed blocks let a reader replace only repaired/deleted blocks in its cached prefix.
CREATE FUNCTION engine_activity_block_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cols text; src text; same_bounds boolean;
BEGIN
 cols=CASE TG_TABLE_NAME
 WHEN 'swaps' THEN 'SELECT coin,block FROM %s'
 WHEN 'token_transfers' THEN 'SELECT token coin,block FROM %s'
 WHEN 'pons_events' THEN 'SELECT token coin,block FROM %s'
 WHEN 'pons_exemptions' THEN 'SELECT token coin,block FROM %s'
 WHEN 'liquidity_events' THEN 'SELECT c coin,e.block FROM %s e JOIN pools p ON p.id=e.pool_id CROSS JOIN LATERAL(VALUES(p.currency0),(p.currency1)) x(c)'
 WHEN 'pools' THEN 'SELECT c coin,p.created_block block FROM %s p CROSS JOIN LATERAL(VALUES(p.currency0),(p.currency1)) x(c)
 UNION ALL SELECT c,e.block FROM %s p JOIN liquidity_events e ON e.pool_id=p.id CROSS JOIN LATERAL(VALUES(p.currency0),(p.currency1)) x(c)'
 WHEN 'engine_block_times' THEN 'SELECT e.token coin,e.block FROM %s b JOIN pons_events e ON e.block=b.number
 UNION ALL SELECT e.token,e.block FROM %s b JOIN pons_exemptions e ON e.block=b.number
 UNION ALL SELECT c,p.created_block FROM %s b JOIN pools p ON p.created_block=b.number CROSS JOIN LATERAL(VALUES(p.currency0),(p.currency1)) x(c)'
 WHEN 'raw_history_seals' THEN 'SELECT s.coin,s.block FROM %s r JOIN swaps s ON r.name=''swaps'' AND s.ts>=r.start_ts AND s.ts<r.end_ts
 UNION ALL SELECT t.token,t.block FROM %s r JOIN token_transfers t ON r.name=''token_transfers'' AND t.ts>=r.start_ts AND t.ts<r.end_ts'
 WHEN 'raw_history_seal_days' THEN 'SELECT s.coin,s.block FROM %s r JOIN swaps s ON r.name=''swaps'' AND s.ts>=r.day AND s.ts<r.end_ts AND s.coin<=r.last_coin
 UNION ALL SELECT t.token,t.block FROM %s r JOIN token_transfers t ON r.name=''token_transfers'' AND t.ts>=r.day AND t.ts<r.end_ts AND t.token<=r.last_coin'
 END;
 src=CASE TG_OP WHEN 'INSERT' THEN replace(cols,'%s','new_rows') WHEN 'DELETE' THEN replace(cols,'%s','old_rows')
 ELSE replace(cols,'%s','new_rows')||' UNION ALL '||replace(cols,'%s','old_rows') END;
 IF TG_TABLE_NAME='pools' AND TG_OP='UPDATE' THEN
  src=replace(cols,'%s','(SELECT n.* FROM new_rows n LEFT JOIN old_rows o USING(id)
    WHERE (n.currency0,n.currency1,n.created_block) IS DISTINCT FROM (o.currency0,o.currency1,o.created_block))')
   ||' UNION ALL '||replace(cols,'%s','(SELECT o.* FROM old_rows o LEFT JOIN new_rows n USING(id)
    WHERE (n.currency0,n.currency1,n.created_block) IS DISTINCT FROM (o.currency0,o.currency1,o.created_block))');
 ELSIF TG_TABLE_NAME='engine_block_times' AND TG_OP='UPDATE' THEN
  src=replace(cols,'%s','(SELECT n.* FROM new_rows n LEFT JOIN old_rows o USING(number) WHERE n.ts IS DISTINCT FROM o.ts)')
   ||' UNION ALL '||replace(cols,'%s','(SELECT o.* FROM old_rows o LEFT JOIN new_rows n USING(number) WHERE n.ts IS DISTINCT FROM o.ts)');
 ELSIF TG_TABLE_NAME='raw_history_seal_days' AND TG_OP='UPDATE' THEN
  EXECUTE 'SELECT NOT EXISTS(SELECT 1 FROM old_rows o FULL JOIN new_rows n USING(name,partition_name,day)
   WHERE o.name IS NULL OR n.name IS NULL OR o.end_ts IS DISTINCT FROM n.end_ts)' INTO same_bounds;
  IF same_bounds THEN
  src='SELECT s.coin,s.block FROM old_rows o JOIN new_rows n USING(name,partition_name,day) JOIN swaps s
    ON n.name=''swaps'' AND s.ts>=n.day AND s.ts<n.end_ts
    AND s.coin>least(coalesce(o.last_coin,''''::bytea),coalesce(n.last_coin,''''::bytea))
    AND s.coin<=greatest(o.last_coin,n.last_coin)
   UNION ALL SELECT t.token,t.block FROM old_rows o JOIN new_rows n USING(name,partition_name,day) JOIN token_transfers t
    ON n.name=''token_transfers'' AND t.ts>=n.day AND t.ts<n.end_ts
    AND t.token>least(coalesce(o.last_coin,''''::bytea),coalesce(n.last_coin,''''::bytea))
    AND t.token<=greatest(o.last_coin,n.last_coin)';
  END IF;
 ELSIF TG_TABLE_NAME='raw_history_seals' AND TG_OP='UPDATE' THEN
  src=replace(cols,'%s','(SELECT n.* FROM new_rows n LEFT JOIN old_rows o USING(name,partition_name)
    WHERE (n.sealed AND NOT n.dropped,n.start_ts,n.end_ts) IS DISTINCT FROM (o.sealed AND NOT o.dropped,o.start_ts,o.end_ts))')
   ||' UNION ALL '||replace(cols,'%s','(SELECT o.* FROM old_rows o LEFT JOIN new_rows n USING(name,partition_name)
    WHERE (n.sealed AND NOT n.dropped,n.start_ts,n.end_ts) IS DISTINCT FROM (o.sealed AND NOT o.dropped,o.start_ts,o.end_ts))');
 END IF;
 EXECUTE 'WITH touched AS MATERIALIZED(SELECT DISTINCT coin,block FROM ('||src||') x WHERE coin IS NOT NULL),
 versions AS (INSERT INTO engine_activity_versions AS v SELECT DISTINCT coin,1 FROM touched ORDER BY coin
 ON CONFLICT(coin) DO UPDATE SET revision=v.revision+1 RETURNING coin,revision)
 INSERT INTO engine_activity_block_versions AS b SELECT t.coin,t.block,v.revision FROM touched t JOIN versions v USING(coin) ORDER BY t.coin,t.block
 ON CONFLICT(coin,block) DO UPDATE SET revision=excluded.revision';
 RETURN NULL;
END $$;
-- statement-breakpoint
CREATE TRIGGER engine_rating_candidate_changed_coin_card_latest_insert AFTER INSERT ON coin_card_latest REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION engine_rating_candidate_changed();
CREATE TRIGGER engine_rating_candidate_changed_coin_card_latest_update AFTER UPDATE ON coin_card_latest REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION engine_rating_candidate_changed();
CREATE TRIGGER engine_rating_candidate_changed_coin_card_latest_delete AFTER DELETE ON coin_card_latest REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION engine_rating_candidate_changed();
CREATE TRIGGER engine_rating_version_changed_coin_card_latest_insert AFTER INSERT ON coin_card_latest REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION engine_rating_version_changed();
CREATE TRIGGER engine_rating_version_changed_coin_card_latest_update AFTER UPDATE ON coin_card_latest REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION engine_rating_version_changed();
CREATE TRIGGER engine_rating_version_changed_coin_card_latest_delete AFTER DELETE ON coin_card_latest REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION engine_rating_version_changed();
CREATE TRIGGER engine_rating_version_changed_engine_runs_insert AFTER INSERT ON engine_runs REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION engine_rating_version_changed();
CREATE TRIGGER engine_rating_version_changed_engine_runs_update AFTER UPDATE ON engine_runs REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION engine_rating_version_changed();
CREATE TRIGGER engine_rating_version_changed_engine_runs_delete AFTER DELETE ON engine_runs REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION engine_rating_version_changed();
CREATE TRIGGER engine_rating_version_changed_tokens_insert AFTER INSERT ON tokens REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION engine_rating_version_changed();
CREATE TRIGGER engine_rating_version_changed_tokens_update AFTER UPDATE ON tokens REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION engine_rating_version_changed();
CREATE TRIGGER engine_rating_version_changed_tokens_delete AFTER DELETE ON tokens REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION engine_rating_version_changed();
CREATE TRIGGER engine_rating_version_changed_sell_check_runs_insert AFTER INSERT ON sell_check_runs REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION engine_rating_version_changed();
CREATE TRIGGER engine_rating_version_changed_sell_check_runs_update AFTER UPDATE ON sell_check_runs REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION engine_rating_version_changed();
CREATE TRIGGER engine_rating_version_changed_sell_check_runs_delete AFTER DELETE ON sell_check_runs REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION engine_rating_version_changed();
CREATE TRIGGER engine_activity_block_changed_swaps_insert AFTER INSERT ON swaps REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION engine_activity_block_changed();
CREATE TRIGGER engine_activity_block_changed_swaps_update AFTER UPDATE ON swaps REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION engine_activity_block_changed();
CREATE TRIGGER engine_activity_block_changed_swaps_delete AFTER DELETE ON swaps REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION engine_activity_block_changed();
CREATE TRIGGER engine_activity_block_changed_token_transfers_insert AFTER INSERT ON token_transfers REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION engine_activity_block_changed();
CREATE TRIGGER engine_activity_block_changed_token_transfers_update AFTER UPDATE ON token_transfers REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION engine_activity_block_changed();
CREATE TRIGGER engine_activity_block_changed_token_transfers_delete AFTER DELETE ON token_transfers REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION engine_activity_block_changed();
CREATE TRIGGER engine_activity_block_changed_pons_events_insert AFTER INSERT ON pons_events REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION engine_activity_block_changed();
CREATE TRIGGER engine_activity_block_changed_pons_events_update AFTER UPDATE ON pons_events REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION engine_activity_block_changed();
CREATE TRIGGER engine_activity_block_changed_pons_events_delete AFTER DELETE ON pons_events REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION engine_activity_block_changed();
CREATE TRIGGER engine_activity_block_changed_pons_exemptions_insert AFTER INSERT ON pons_exemptions REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION engine_activity_block_changed();
CREATE TRIGGER engine_activity_block_changed_pons_exemptions_update AFTER UPDATE ON pons_exemptions REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION engine_activity_block_changed();
CREATE TRIGGER engine_activity_block_changed_pons_exemptions_delete AFTER DELETE ON pons_exemptions REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION engine_activity_block_changed();
CREATE TRIGGER engine_activity_block_changed_liquidity_events_insert AFTER INSERT ON liquidity_events REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION engine_activity_block_changed();
CREATE TRIGGER engine_activity_block_changed_liquidity_events_update AFTER UPDATE ON liquidity_events REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION engine_activity_block_changed();
CREATE TRIGGER engine_activity_block_changed_liquidity_events_delete AFTER DELETE ON liquidity_events REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION engine_activity_block_changed();
CREATE TRIGGER engine_activity_block_changed_pools_insert AFTER INSERT ON pools REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION engine_activity_block_changed();
CREATE TRIGGER engine_activity_block_changed_pools_update AFTER UPDATE ON pools REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION engine_activity_block_changed();
CREATE TRIGGER engine_activity_block_changed_pools_delete AFTER DELETE ON pools REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION engine_activity_block_changed();
CREATE TRIGGER engine_activity_block_changed_engine_block_times_insert AFTER INSERT ON engine_block_times REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION engine_activity_block_changed();
CREATE TRIGGER engine_activity_block_changed_engine_block_times_update AFTER UPDATE ON engine_block_times REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION engine_activity_block_changed();
CREATE TRIGGER engine_activity_block_changed_engine_block_times_delete AFTER DELETE ON engine_block_times REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION engine_activity_block_changed();
CREATE TRIGGER engine_activity_block_changed_raw_history_seals_insert AFTER INSERT ON raw_history_seals REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION engine_activity_block_changed();
CREATE TRIGGER engine_activity_block_changed_raw_history_seals_update AFTER UPDATE ON raw_history_seals REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION engine_activity_block_changed();
CREATE TRIGGER engine_activity_block_changed_raw_history_seals_delete AFTER DELETE ON raw_history_seals REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION engine_activity_block_changed();
CREATE TRIGGER engine_activity_block_changed_raw_history_seal_days_insert AFTER INSERT ON raw_history_seal_days REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION engine_activity_block_changed();
CREATE TRIGGER engine_activity_block_changed_raw_history_seal_days_update AFTER UPDATE ON raw_history_seal_days REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION engine_activity_block_changed();
CREATE TRIGGER engine_activity_block_changed_raw_history_seal_days_delete AFTER DELETE ON raw_history_seal_days REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION engine_activity_block_changed();
