-- Worker-owned source listings retain first sighting across refreshes and removals
CREATE TABLE coin_listings (
 coin bytea NOT NULL CHECK(octet_length(coin)=20), source text NOT NULL, external_id text NOT NULL,
 first_seen timestamptz NOT NULL DEFAULT now(), last_seen timestamptz NOT NULL DEFAULT now(),
 active boolean NOT NULL DEFAULT true, PRIMARY KEY(coin,source)
);
CREATE TABLE coin_listing_sync (source text PRIMARY KEY, last_success timestamptz NOT NULL);
-- Engine-owned measurements published at the same block as the latest rating
CREATE TABLE read_blue_chip (
 coin bytea PRIMARY KEY, as_of_block bigint NOT NULL, created_at timestamptz NOT NULL,
 real_pool boolean NOT NULL, liquidity_usd double precision, holders bigint,
 CHECK(liquidity_usd>=0 AND liquidity_usd<'Infinity'::double precision), CHECK(holders>=0)
);
-- Sticky observation survives pruning and orphaning because the rule says never had a danger verdict
CREATE TABLE read_blue_chip_danger (coin bytea PRIMARY KEY);
INSERT INTO read_blue_chip_danger SELECT DISTINCT coin FROM verdicts WHERE data->>'level'='danger' ON CONFLICT DO NOTHING;
INSERT INTO read_blue_chip_danger SELECT coin FROM history_prunes WHERE verdict_level='danger' ON CONFLICT DO NOTHING;
INSERT INTO read_blue_chip_danger SELECT coin FROM coin_card_latest WHERE data->'verdict'->>'level'='danger' ON CONFLICT DO NOTHING;
-- statement-breakpoint
CREATE FUNCTION blue_chip_remember_danger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (TG_TABLE_NAME='verdicts' AND to_jsonb(NEW)->'data'->>'level'='danger') OR
    (TG_TABLE_NAME='coin_card_latest' AND to_jsonb(NEW)->'data'->'verdict'->>'level'='danger') OR
    (TG_TABLE_NAME='history_prunes' AND to_jsonb(NEW)->>'verdict_level'='danger') THEN
   INSERT INTO read_blue_chip_danger(coin) VALUES(NEW.coin) ON CONFLICT DO NOTHING;
 END IF;
 RETURN NEW;
END $$;
-- statement-breakpoint
CREATE TRIGGER blue_chip_verdict_danger AFTER INSERT OR UPDATE ON verdicts FOR EACH ROW EXECUTE FUNCTION blue_chip_remember_danger();
CREATE TRIGGER blue_chip_card_danger AFTER INSERT OR UPDATE ON coin_card_latest FOR EACH ROW EXECUTE FUNCTION blue_chip_remember_danger();
CREATE TRIGGER blue_chip_prune_danger AFTER INSERT OR UPDATE ON history_prunes FOR EACH ROW EXECUTE FUNCTION blue_chip_remember_danger();
