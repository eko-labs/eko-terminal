-- Ingest records changed coins once per SQL statement. Projection work runs after commit in the API.
ALTER TABLE read_coins ADD COLUMN buyers_pending boolean NOT NULL DEFAULT false;
ALTER TABLE read_coins ADD COLUMN pricing_pending boolean NOT NULL DEFAULT false;
-- Read projections must not lock chain rows through FK checks while refreshing outside ingest.
ALTER TABLE read_coins DROP CONSTRAINT read_coins_coin_fkey;
ALTER TABLE read_buyers DROP CONSTRAINT read_buyers_coin_fkey;
ALTER TABLE read_feed DROP CONSTRAINT read_feed_coin_fkey;
ALTER TABLE read_first_verdict DROP CONSTRAINT read_first_verdict_coin_fkey;
CREATE TABLE read_dirty(coin bytea PRIMARY KEY,revision bigserial NOT NULL);
CREATE INDEX read_dirty_revision ON read_dirty(revision);
DROP TRIGGER read_swap_change ON swaps;
DROP TRIGGER read_bar_change ON bars_1m;
DROP TRIGGER read_token_change ON tokens;
DROP TRIGGER read_pool_change ON pools;
DROP FUNCTION read_swap_change();
DROP FUNCTION read_bar_change();
DROP FUNCTION read_token_change();
DROP FUNCTION read_pool_change();
-- statement-breakpoint
CREATE FUNCTION read_mark_dirty() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE field text; source text;
BEGIN
 field=CASE TG_TABLE_NAME WHEN 'tokens' THEN 'address' WHEN 'pools' THEN 'unnest(ARRAY[currency0,currency1])' ELSE 'coin' END;
 source=CASE TG_OP WHEN 'INSERT' THEN 'SELECT DISTINCT '||field||' AS coin FROM new_rows'
 WHEN 'DELETE' THEN 'SELECT DISTINCT '||field||' AS coin FROM old_rows'
 ELSE 'SELECT '||field||' AS coin FROM new_rows UNION SELECT '||field||' AS coin FROM old_rows' END;
 EXECUTE 'INSERT INTO read_dirty(coin) '||source||' ON CONFLICT(coin) DO UPDATE SET revision=excluded.revision';
 RETURN NULL;
END $$;
-- statement-breakpoint
CREATE TRIGGER read_swap_insert AFTER INSERT ON swaps REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION read_mark_dirty();
CREATE TRIGGER read_swap_update AFTER UPDATE ON swaps REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION read_mark_dirty();
CREATE TRIGGER read_swap_delete AFTER DELETE ON swaps REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION read_mark_dirty();
CREATE TRIGGER read_bar_insert AFTER INSERT ON bars_1m REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION read_mark_dirty();
CREATE TRIGGER read_bar_update AFTER UPDATE ON bars_1m REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION read_mark_dirty();
CREATE TRIGGER read_bar_delete AFTER DELETE ON bars_1m REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION read_mark_dirty();
CREATE TRIGGER read_token_insert AFTER INSERT ON tokens REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION read_mark_dirty();
CREATE TRIGGER read_token_update AFTER UPDATE ON tokens REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION read_mark_dirty();
CREATE TRIGGER read_token_delete AFTER DELETE ON tokens REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION read_mark_dirty();
CREATE TRIGGER read_pool_insert AFTER INSERT ON pools REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION read_mark_dirty();
CREATE TRIGGER read_pool_update AFTER UPDATE ON pools REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION read_mark_dirty();
CREATE TRIGGER read_pool_delete AFTER DELETE ON pools REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION read_mark_dirty();
-- statement-breakpoint
CREATE FUNCTION refresh_read_models(a bytea[],window_sec bigint) RETURNS void LANGUAGE plpgsql AS $$
DECLARE first_blocks bigint[];
BEGIN
 SELECT array_agg(DISTINCT first_block) INTO first_blocks FROM tokens WHERE address=ANY(a);
 DELETE FROM read_buyers WHERE coin=ANY(a);
 INSERT INTO read_buyers SELECT DISTINCT s.coin,s.trader FROM swaps s JOIN tokens t ON t.address=s.coin
 WHERE s.coin=ANY(a) AND s.side=1 AND s.trader IS NOT NULL AND NOT s.senders_pending;
 -- All source scans are bounded to the changed coins. No per-swap writes to read projections.
 WITH selected AS (SELECT t.*,c.data FROM tokens t LEFT JOIN coin_card_latest c ON c.coin=t.address AND c.coin=ANY(a) WHERE t.address=ANY(a)),
 activity AS (SELECT coin,max(ts) AS ts,bool_or(side=1 AND (senders_pending OR trader IS NULL)) AS buyers_pending,
 bool_or(pricing_pending OR price_quote IS NULL OR usd IS NULL) AS pricing_pending FROM swaps WHERE coin=ANY(a) GROUP BY coin),
 buyers AS (SELECT coin,count(*) AS n FROM read_buyers WHERE coin=ANY(a) GROUP BY coin),
 volume AS (SELECT coin,sum(volume_usd) AS usd FROM bars_1m WHERE coin=ANY(a) AND minute>=to_timestamp(window_sec-3540) AND minute<=to_timestamp(window_sec) GROUP BY coin)
 INSERT INTO read_coins(coin,tier,activity,first_block,pair_column,pair_block,launchpad,buyers,buyers_pending,pricing_pending,volume)
 SELECT t.address,CASE t.data->'verdict'->>'level' WHEN 'clear' THEN 0 WHEN 'monitor' THEN 1 WHEN 'danger' THEN 3 ELSE 2 END,
 coalesce(s.ts,bt.ts,cb.ts,(t.data->'identity'->>'createdAt')::timestamptz),t.first_block,
 CASE WHEN t.graduated_block IS NOT NULL THEN 'migrated' WHEN coalesce((t.data->'identity'->>'curvePct')::double precision,0)>=75 THEN 'near_grad' ELSE 'new' END,
 coalesce(t.graduated_block,t.first_block),t.launchpad,coalesce(b.n,0),coalesce(s.buyers_pending,false),coalesce(s.pricing_pending,false),CASE WHEN s.pricing_pending THEN 0 ELSE coalesce(v.usd,0) END
 FROM selected t LEFT JOIN activity s ON s.coin=t.address LEFT JOIN buyers b ON b.coin=t.address LEFT JOIN volume v ON v.coin=t.address
 LEFT JOIN engine_block_times bt ON bt.number=t.first_block AND bt.number=ANY(first_blocks) LEFT JOIN chain_blocks cb ON cb.number=t.first_block AND cb.number=ANY(first_blocks)
 WHERE t.deployer IS NOT NULL AND (t.data IS NOT NULL OR t.launchpad='pons')
 AND coalesce(s.ts,bt.ts,cb.ts,(t.data->'identity'->>'createdAt')::timestamptz) IS NOT NULL
 ON CONFLICT(coin) DO UPDATE SET tier=excluded.tier,activity=excluded.activity,first_block=excluded.first_block,pair_column=excluded.pair_column,pair_block=excluded.pair_block,launchpad=excluded.launchpad,buyers=excluded.buyers,buyers_pending=excluded.buyers_pending,pricing_pending=excluded.pricing_pending,volume=excluded.volume;
 DELETE FROM read_coins r WHERE r.coin=ANY(a) AND NOT EXISTS(SELECT 1 FROM tokens t LEFT JOIN coin_card_latest c ON c.coin=t.address WHERE t.address=r.coin AND t.deployer IS NOT NULL AND (c.coin IS NOT NULL OR t.launchpad='pons'));
 UPDATE read_feed f SET symbol=t.symbol,first_block=t.first_block FROM tokens t WHERE t.address=ANY(a) AND f.coin=t.address;
 DELETE FROM read_feed WHERE coin=ANY(a) AND kind IN('new_pair','graduation');
 INSERT INTO read_feed SELECT 'token:'||encode(address,'hex'),address,first_block,'new_pair','{}',NULL FROM tokens WHERE address=ANY(a) AND curve IS NOT NULL;
 INSERT INTO read_feed SELECT 'pool:'||encode(p.id,'hex')||':'||encode(t.address,'hex'),t.address,p.created_block,'new_pair','{}',NULL FROM pools p JOIN tokens t ON t.address IN(p.currency0,p.currency1) WHERE t.address=ANY(a) AND t.curve IS NULL;
 INSERT INTO read_feed SELECT 'graduation:'||encode(address,'hex')||':'||graduated_block,address,graduated_block,'graduation','{}',NULL FROM tokens WHERE address=ANY(a) AND graduated_block IS NOT NULL;
 DELETE FROM read_buyers WHERE coin=ANY(a) AND NOT EXISTS(SELECT 1 FROM tokens WHERE address=coin);
 DELETE FROM read_feed WHERE coin=ANY(a) AND NOT EXISTS(SELECT 1 FROM tokens WHERE address=coin);
 DELETE FROM read_first_verdict WHERE coin=ANY(a) AND NOT EXISTS(SELECT 1 FROM tokens WHERE address=coin);
END $$;
-- statement-breakpoint
-- Existing projections become pending-aware on the next refresh without a startup history scan.
INSERT INTO read_dirty(coin) SELECT address FROM tokens ON CONFLICT(coin) DO NOTHING;
