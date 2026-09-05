-- Latest positive trade by chain order, independent of the rating price's timestamp order.
-- Empty pool_id is a coin-wide entry for curve probes. trade_pool_id always holds the actual pool.
-- Historical swaps are backfilled separately by scripts/backfill-pool-prices.ts.
CREATE TABLE IF NOT EXISTS coin_pool_prices (
 coin bytea NOT NULL, pool_id bytea NOT NULL, trade_pool_id bytea NOT NULL,
 amount_coin numeric(78,0) NOT NULL, amount_quote numeric(78,0) NOT NULL, usd double precision NOT NULL,
 block bigint NOT NULL, log_index integer NOT NULL, tx_hash bytea NOT NULL, valid boolean NOT NULL DEFAULT true,
 PRIMARY KEY(coin,pool_id)
);
-- statement-breakpoint
CREATE OR REPLACE FUNCTION pool_prices_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='TRUNCATE' THEN
  DELETE FROM coin_pool_prices;
  RETURN NULL;
 END IF;
 IF TG_OP IN ('UPDATE','DELETE') THEN
  -- Keep the ordering boundary so a subsequent older repair cannot publish an obsolete winner.
  -- Invalid entries use the bounded read fallback until backfill or a qualifying new trade restores them.
  UPDATE coin_pool_prices p SET valid=false FROM old_rows o
  WHERE p.coin=o.coin AND p.trade_pool_id=o.pool_id AND (p.block,p.log_index,p.tx_hash)=(o.block,o.log_index,o.tx_hash);
 END IF;
 IF TG_OP IN ('INSERT','UPDATE') THEN
  INSERT INTO coin_pool_prices(coin,pool_id,trade_pool_id,amount_coin,amount_quote,usd,block,log_index,tx_hash)
  SELECT DISTINCT ON(s.coin,k.pool_id) s.coin,k.pool_id,s.pool_id,s.amount_coin,s.amount_quote,s.usd,s.block,s.log_index,s.tx_hash
  FROM new_rows s CROSS JOIN LATERAL (VALUES(s.pool_id),(''::bytea)) k(pool_id)
  WHERE s.usd>0 AND s.amount_coin>0 AND s.amount_quote>0
  ORDER BY s.coin,k.pool_id,s.block DESC,s.log_index DESC,s.tx_hash DESC
  ON CONFLICT(coin,pool_id) DO UPDATE SET valid=true,trade_pool_id=excluded.trade_pool_id,amount_coin=excluded.amount_coin,
   amount_quote=excluded.amount_quote,usd=excluded.usd,block=excluded.block,log_index=excluded.log_index,tx_hash=excluded.tx_hash
  WHERE (excluded.block,excluded.log_index,excluded.tx_hash)>=(coin_pool_prices.block,coin_pool_prices.log_index,coin_pool_prices.tx_hash);
 END IF;
 RETURN NULL;
END $$;
-- statement-breakpoint
CREATE TRIGGER pool_prices_insert AFTER INSERT ON swaps REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION pool_prices_changed();
CREATE TRIGGER pool_prices_update AFTER UPDATE ON swaps REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION pool_prices_changed();
CREATE TRIGGER pool_prices_delete AFTER DELETE ON swaps REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION pool_prices_changed();
CREATE TRIGGER pool_prices_truncate AFTER TRUNCATE ON swaps FOR EACH STATEMENT EXECUTE FUNCTION pool_prices_changed();
-- The header needs only card presence, never card JSON. This compact projection shares no read-model mutex.
CREATE TABLE IF NOT EXISTS read_coin_verdicts(coin bytea PRIMARY KEY);
INSERT INTO read_coin_verdicts SELECT coin FROM coin_card_latest ON CONFLICT DO NOTHING;
-- statement-breakpoint
CREATE OR REPLACE FUNCTION read_coin_verdicts_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='TRUNCATE' THEN
  DELETE FROM read_coin_verdicts;
  RETURN NULL;
 END IF;
 IF TG_OP='UPDATE' THEN
 IF NOT EXISTS(
  (SELECT coin FROM old_rows EXCEPT SELECT coin FROM new_rows)
  UNION ALL (SELECT coin FROM new_rows EXCEPT SELECT coin FROM old_rows)
 ) THEN RETURN NULL; END IF;
 END IF;
 IF TG_OP IN ('UPDATE','DELETE') THEN
  DELETE FROM read_coin_verdicts p USING old_rows o WHERE p.coin=o.coin;
 END IF;
 IF TG_OP IN ('INSERT','UPDATE') THEN
  INSERT INTO read_coin_verdicts SELECT DISTINCT coin FROM new_rows ORDER BY coin ON CONFLICT DO NOTHING;
 END IF;
 RETURN NULL;
END $$;
-- statement-breakpoint
CREATE TRIGGER read_coin_verdicts_insert AFTER INSERT ON coin_card_latest REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION read_coin_verdicts_changed();
-- Payload updates cannot change presence. Only key changes need the update trigger's transition rows.
CREATE TRIGGER read_coin_verdicts_update AFTER UPDATE ON coin_card_latest REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION read_coin_verdicts_changed();
CREATE TRIGGER read_coin_verdicts_delete AFTER DELETE ON coin_card_latest REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION read_coin_verdicts_changed();
CREATE TRIGGER read_coin_verdicts_truncate AFTER TRUNCATE ON coin_card_latest FOR EACH STATEMENT EXECUTE FUNCTION read_coin_verdicts_changed();
-- Legacy pre-0191 runs retain their block-time semantics without an OR across time indexes.
CREATE INDEX IF NOT EXISTS engine_runs_legacy_sec_coin ON engine_runs(sec,coin) WHERE created_at IS NULL;
