-- Parent indexes cover all attached months and are inherited by ensurePartitions, including future months.
-- Production prebuilds child indexes concurrently and attaches them before applying this migration.
CREATE INDEX IF NOT EXISTS swaps_tx_log_ts ON swaps(tx_hash,log_index,ts DESC);
CREATE INDEX IF NOT EXISTS swaps_known_buy_coin_trader ON swaps(coin,trader) WHERE side=1 AND trader IS NOT NULL AND NOT senders_pending;
CREATE INDEX IF NOT EXISTS swaps_feed_trade_window ON swaps(ts,block,tx_hash,log_index) INCLUDE(coin,side,recipient,trader,usd) WHERE usd>=500 AND coalesce(CASE WHEN side=1 THEN recipient END,trader) IS NOT NULL;
CREATE TABLE IF NOT EXISTS agent_registry_ids(agent_id numeric(78,0) PRIMARY KEY);
INSERT INTO agent_registry_ids SELECT DISTINCT agent_id FROM agent_registry ON CONFLICT DO NOTHING;
-- statement-breakpoint
CREATE FUNCTION agent_registry_remember_ids() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO agent_registry_ids SELECT DISTINCT agent_id FROM new_rows ORDER BY agent_id ON CONFLICT DO NOTHING;
 RETURN NULL;
END $$;
-- statement-breakpoint
CREATE TRIGGER agent_registry_remember_ids AFTER INSERT ON agent_registry REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION agent_registry_remember_ids();
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS swaps_positive_coin_order ON swaps(coin,block DESC,log_index DESC,tx_hash DESC) INCLUDE(pool_id,amount_coin,amount_quote,usd,ts) WHERE usd>0 AND amount_coin>0 AND amount_quote>0;
