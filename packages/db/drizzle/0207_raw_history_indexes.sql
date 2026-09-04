-- Coin order and wallet order serve the removed prefix indexes
DROP INDEX IF EXISTS swaps_coin_block;
DROP INDEX IF EXISTS swaps_trader_block;
DROP INDEX IF EXISTS swaps_known_buy_coin_trader;
CREATE TABLE raw_history_watermarks(name text PRIMARY KEY,through_block bigint NOT NULL);
CREATE TABLE raw_history_bar_keys(coin bytea NOT NULL,minute timestamptz NOT NULL,PRIMARY KEY(coin,minute));
CREATE TABLE reference_price_baselines(pool_id bytea NOT NULL,coin bytea NOT NULL,quote_asset bytea NOT NULL,block bigint NOT NULL,log_index integer NOT NULL,price_quote double precision NOT NULL,PRIMARY KEY(pool_id,coin,quote_asset));
-- statement-breakpoint
CREATE FUNCTION raw_history_insert_boundary() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM raw_history_watermarks w WHERE w.name=TG_TABLE_NAME
   AND EXISTS(SELECT 1 FROM new_rows n WHERE n.block<=w.through_block)) THEN
  RAISE EXCEPTION 'Insert crosses compacted raw history: use an archive';
 END IF;
 RETURN NULL;
END $$;
-- statement-breakpoint
CREATE TRIGGER raw_history_swap_insert AFTER INSERT ON swaps REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION raw_history_insert_boundary();
CREATE TRIGGER raw_history_transfer_insert AFTER INSERT ON token_transfers REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION raw_history_insert_boundary();
