-- Small mutable freshness and full-record baseline, one row per rated coin
CREATE TABLE IF NOT EXISTS coin_rating_checks (
 coin bytea PRIMARY KEY, checked_block bigint NOT NULL, checked_at timestamptz NOT NULL,
 full_block bigint NOT NULL, full_price double precision, peak_recorded boolean NOT NULL DEFAULT false,
 outcome_signature text
);
-- Raw-unit prices use the same swap ratio as grade outcomes and survive raw-history retention
CREATE TABLE IF NOT EXISTS coin_rating_prices (
 coin bytea PRIMARY KEY, price double precision NOT NULL, peak double precision NOT NULL,
 ts timestamptz NOT NULL, block bigint NOT NULL, log_index integer NOT NULL, tx_hash bytea NOT NULL
);
-- Backfill runs separately without a lock (scripts/backfill-rating-checks.sql) because the swaps table is large and hot
-- statement-breakpoint
CREATE OR REPLACE FUNCTION rating_prices_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO coin_rating_prices(coin,price,peak,ts,block,log_index,tx_hash)
 SELECT DISTINCT ON(s.coin) s.coin,s.usd/s.amount_coin::double precision,
 max(s.usd/s.amount_coin::double precision) OVER(PARTITION BY s.coin),s.ts,s.block,s.log_index,s.tx_hash
 FROM new_rows s WHERE s.usd>0 AND s.amount_coin>0
 ORDER BY s.coin,s.ts DESC,s.block DESC,s.log_index DESC,s.tx_hash DESC
 ON CONFLICT(coin) DO UPDATE SET peak=greatest(coin_rating_prices.peak,excluded.peak),
 price=CASE WHEN (excluded.ts,excluded.block,excluded.log_index,excluded.tx_hash)>=(coin_rating_prices.ts,coin_rating_prices.block,coin_rating_prices.log_index,coin_rating_prices.tx_hash) THEN excluded.price ELSE coin_rating_prices.price END,
 ts=greatest(coin_rating_prices.ts,excluded.ts),
 block=CASE WHEN (excluded.ts,excluded.block,excluded.log_index,excluded.tx_hash)>=(coin_rating_prices.ts,coin_rating_prices.block,coin_rating_prices.log_index,coin_rating_prices.tx_hash) THEN excluded.block ELSE coin_rating_prices.block END,
 log_index=CASE WHEN (excluded.ts,excluded.block,excluded.log_index,excluded.tx_hash)>=(coin_rating_prices.ts,coin_rating_prices.block,coin_rating_prices.log_index,coin_rating_prices.tx_hash) THEN excluded.log_index ELSE coin_rating_prices.log_index END,
 tx_hash=CASE WHEN (excluded.ts,excluded.block,excluded.log_index,excluded.tx_hash)>=(coin_rating_prices.ts,coin_rating_prices.block,coin_rating_prices.log_index,coin_rating_prices.tx_hash) THEN excluded.tx_hash ELSE coin_rating_prices.tx_hash END;
 RETURN NULL;
END $$;
-- statement-breakpoint
DROP TRIGGER IF EXISTS rating_prices_insert ON swaps;
CREATE TRIGGER rating_prices_insert AFTER INSERT ON swaps REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION rating_prices_changed();
DROP TRIGGER IF EXISTS rating_prices_update ON swaps;
CREATE TRIGGER rating_prices_update AFTER UPDATE ON swaps REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION rating_prices_changed();
