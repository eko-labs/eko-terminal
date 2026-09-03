-- Lifetime sufficient statistics share the existing history prune and transfer baseline boundary
CREATE TABLE coin_lifetime (coin bytea PRIMARY KEY, data jsonb NOT NULL, revision bigint NOT NULL DEFAULT 0, graduation_holdings jsonb, opening_holdings jsonb);
ALTER TABLE history_prunes DROP CONSTRAINT history_prunes_rule_check;
ALTER TABLE history_prunes ADD CONSTRAINT history_prunes_rule_check CHECK(rule IN ('danger_quiet','quiet_coin','settled','raw_cap'));
CREATE TABLE coin_buyer_firsts (coin bytea NOT NULL,trader bytea NOT NULL,first_block bigint NOT NULL,pool_id bytea NOT NULL,
 tx_hash bytea NOT NULL,log_index integer NOT NULL,PRIMARY KEY(coin,trader));
CREATE INDEX coin_buyer_firsts_block ON coin_buyer_firsts(coin,first_block);
CREATE TABLE coin_unknown_buys (coin bytea NOT NULL,block bigint NOT NULL,n bigint NOT NULL,PRIMARY KEY(coin,block));
ALTER TABLE history_prunes ADD COLUMN buyer_stats_complete boolean NOT NULL DEFAULT false;
CREATE TABLE coin_match_lifetime (coin bytea NOT NULL, rules_version text NOT NULL, playbook_id text NOT NULL,
 level text NOT NULL, first_block bigint NOT NULL, PRIMARY KEY(coin,rules_version,playbook_id,level));
CREATE TABLE retention_grade_prices (coin bytea NOT NULL, since timestamptz NOT NULL, horizon_sec integer NOT NULL,
 graded_at timestamptz NOT NULL, level text NOT NULL, p0 double precision, p1 double precision, hi double precision,
 PRIMARY KEY(coin,since,horizon_sec));
CREATE VIEW retention_read_swaps AS
 SELECT coin,pool_id,block,log_index,tx_hash,amount_coin,amount_quote,usd,ts FROM swaps
 UNION ALL
 SELECT l.coin,decode(substring(r->>'pool_id' FROM 3),'hex'),(r->>'block')::bigint,(r->>'log_index')::integer,decode(substring(r->>'tx_hash' FROM 3),'hex'),
 (r->>'amount_coin')::numeric,(r->>'amount_quote')::numeric,(r->>'usd')::double precision,(r->>'ts')::timestamptz
 FROM coin_lifetime l CROSS JOIN LATERAL jsonb_array_elements(coalesce(l.data->'tail','[]') ||
 CASE WHEN l.data->'lastPositivePriced' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(l.data->'tail','[]')) t
 WHERE t->>'tx_hash'=l.data->'lastPositivePriced'->>'tx_hash' AND t->>'log_index'=l.data->'lastPositivePriced'->>'log_index')
 THEN jsonb_build_array(l.data->'lastPositivePriced') ELSE '[]'::jsonb END) r;
-- Payload tombstones retain immutable receipt identity and a small reader projection
ALTER TABLE receipt_publications ALTER COLUMN canonical_payload DROP NOT NULL;
ALTER TABLE receipt_publications ALTER COLUMN data DROP NOT NULL;
ALTER TABLE receipt_publications ADD COLUMN summary jsonb;
CREATE INDEX receipt_publications_live_payload ON receipt_publications(recorded_at,id) WHERE producer='engines' AND kind='verdict' AND chain_id=4663 AND data IS NOT NULL;
ALTER TABLE receipt_items ALTER COLUMN canonical_payload DROP NOT NULL;
ALTER TABLE receipt_items ALTER COLUMN data DROP NOT NULL;
-- statement-breakpoint
CREATE FUNCTION retention_receipt_payload() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND current_setting('eko.retention',true)='on'
 AND OLD.producer='engines' AND OLD.kind='verdict' AND OLD.chain_id=4663
 AND OLD.data IS NOT NULL AND NEW.data IS NULL AND NEW.canonical_payload IS NULL
 AND (to_jsonb(NEW)-'data'-'canonical_payload'-'summary')=(to_jsonb(OLD)-'data'-'canonical_payload'-'summary')
 AND (TG_TABLE_NAME='receipt_items' OR to_jsonb(NEW)->'summary' IS NOT NULL) THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'receipt payload is append-only';
END $$
-- statement-breakpoint
DROP TRIGGER receipt_publications_immutable ON receipt_publications;
CREATE TRIGGER receipt_publications_immutable BEFORE UPDATE OR DELETE ON receipt_publications FOR EACH ROW EXECUTE FUNCTION retention_receipt_payload();
DROP TRIGGER receipt_items_immutable ON receipt_items;
CREATE TRIGGER receipt_items_immutable BEFORE UPDATE OR DELETE ON receipt_items FOR EACH ROW EXECUTE FUNCTION retention_receipt_payload();
-- statement-breakpoint
CREATE FUNCTION retention_record_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' AND current_setting('eko.retention',true)='on' THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'record is append-only';
END $$
-- statement-breakpoint
DROP TRIGGER guard_shadow_runs_immutable ON guard_shadow_runs;
CREATE TRIGGER guard_shadow_runs_immutable BEFORE UPDATE OR DELETE ON guard_shadow_runs FOR EACH ROW EXECUTE FUNCTION retention_record_delete();
DROP TRIGGER verdicts_immutable ON verdicts;
CREATE TRIGGER verdicts_immutable BEFORE UPDATE OR DELETE ON verdicts FOR EACH ROW EXECUTE FUNCTION retention_record_delete();
DROP TRIGGER verdict_events_immutable ON verdict_events;
CREATE TRIGGER verdict_events_immutable BEFORE UPDATE OR DELETE ON verdict_events FOR EACH ROW EXECUTE FUNCTION retention_record_delete();
DROP TRIGGER wallet_fingerprint_dependencies_immutable ON wallet_fingerprint_dependencies;
CREATE TRIGGER wallet_fingerprint_dependencies_immutable BEFORE UPDATE OR DELETE ON wallet_fingerprint_dependencies FOR EACH ROW EXECUTE FUNCTION retention_record_delete();
CREATE INDEX guard_shadow_runs_legacy_verdict ON guard_shadow_runs(legacy_verdict_id);
CREATE INDEX coin_card_latest_card_id ON coin_card_latest(card_id);
CREATE INDEX wallet_label_fingerprint_run ON wallet_label_fingerprint_dependencies(run_id);
-- Correction verdicts, first ratings and FK targets stay, obsolete ratings go with their events
-- statement-breakpoint
CREATE OR REPLACE FUNCTION watcher_flow_dirty_swaps() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' AND current_setting('eko.retention',true)='on' THEN RETURN NULL; END IF;
 -- A statement that changed no row changes nothing here either.
 IF TG_OP='INSERT' THEN
  IF NOT EXISTS(SELECT 1 FROM new_rows) THEN RETURN NULL; END IF;
  DELETE FROM census_snapshots;
  INSERT INTO flow_dirty(coin,from_sec) SELECT coin,min(extract(epoch FROM ts)) FROM new_rows GROUP BY coin ORDER BY coin
  ON CONFLICT(coin) DO UPDATE SET revision=excluded.revision,from_sec=least(flow_dirty.from_sec,excluded.from_sec);
 ELSIF TG_OP='DELETE' THEN
  IF NOT EXISTS(SELECT 1 FROM old_rows) THEN RETURN NULL; END IF;
  DELETE FROM census_snapshots;
  INSERT INTO flow_dirty(coin,from_sec) SELECT coin,min(extract(epoch FROM ts)) FROM old_rows GROUP BY coin ORDER BY coin
  ON CONFLICT(coin) DO UPDATE SET revision=excluded.revision,from_sec=least(flow_dirty.from_sec,excluded.from_sec);
 ELSE
  IF NOT EXISTS(SELECT 1 FROM new_rows) THEN RETURN NULL; END IF;
  DELETE FROM census_snapshots;
  INSERT INTO flow_dirty(coin,from_sec) SELECT coin,min(extract(epoch FROM ts)) FROM (SELECT coin,ts FROM new_rows UNION ALL SELECT coin,ts FROM old_rows) r GROUP BY coin ORDER BY coin
  ON CONFLICT(coin) DO UPDATE SET revision=excluded.revision,from_sec=least(flow_dirty.from_sec,excluded.from_sec);
 END IF;
 RETURN NULL;
END $$
-- statement-breakpoint
CREATE OR REPLACE FUNCTION read_mark_dirty_swaps() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' AND current_setting('eko.retention',true)='on' THEN RETURN NULL; END IF;
 IF TG_OP='INSERT' THEN
  INSERT INTO read_dirty(coin,rebuild) SELECT n.coin,coalesce(bool_or(n.block<=r.buyers_block),false) FROM new_rows n LEFT JOIN read_coins r ON r.coin=n.coin GROUP BY n.coin
  ON CONFLICT(coin) DO UPDATE SET revision=excluded.revision,rebuild=read_dirty.rebuild OR excluded.rebuild;
 ELSIF TG_OP='DELETE' THEN
  INSERT INTO read_dirty(coin,rebuild) SELECT DISTINCT coin,true FROM old_rows
  ON CONFLICT(coin) DO UPDATE SET revision=excluded.revision,rebuild=true;
 ELSE
  INSERT INTO read_dirty(coin,rebuild) SELECT coin,true FROM new_rows UNION SELECT coin,true FROM old_rows
  ON CONFLICT(coin) DO UPDATE SET revision=excluded.revision,rebuild=true;
 END IF;
 RETURN NULL;
END $$
-- statement-breakpoint
CREATE OR REPLACE FUNCTION read_verdict_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a bytea;
BEGIN
 IF TG_OP='DELETE' AND current_setting('eko.retention',true)='on' THEN RETURN NULL; END IF;
 SELECT coin INTO a FROM verdicts WHERE id=coalesce(NEW.verdict_id,OLD.verdict_id);
 DELETE FROM read_feed WHERE verdict_id=coalesce(NEW.verdict_id,OLD.verdict_id);
 INSERT INTO read_feed SELECT e.id,v.coin,e.block,'verdict',v.data,v.id FROM verdict_events e JOIN verdicts v ON v.id=e.verdict_id WHERE v.id=coalesce(NEW.verdict_id,OLD.verdict_id) AND e.kind='created' AND NOT EXISTS(SELECT 1 FROM verdict_events x WHERE x.verdict_id=v.id AND x.kind='orphaned');
 DELETE FROM read_first_verdict WHERE coin=a;
 INSERT INTO read_first_verdict SELECT coin,min(block) FROM read_feed WHERE coin=a AND kind='verdict' GROUP BY coin;
 RETURN NULL;
END $$
-- statement-breakpoint
CREATE OR REPLACE FUNCTION read_match_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE k text;
BEGIN
 IF TG_OP='DELETE' AND current_setting('eko.retention',true)='on' THEN RETURN NULL; END IF;
 k='match:'||encode(coalesce(NEW.coin,OLD.coin),'hex')||':'||coalesce(NEW.valid_from_block,OLD.valid_from_block)||':'||coalesce(NEW.rules_version,OLD.rules_version)||':'||coalesce(NEW.playbook_id,OLD.playbook_id);
 DELETE FROM read_feed WHERE id=k;
 IF TG_OP<>'DELETE' AND NEW.data->>'level' IN('monitor','danger') THEN INSERT INTO read_feed VALUES(k,NEW.coin,NEW.valid_from_block,CASE WHEN NEW.playbook_id='wash_to_trend' THEN 'wash' ELSE 'playbook' END,NEW.data,NULL); END IF; RETURN NULL;
END $$
