-- Position inputs change independently of prices and card metadata.
CREATE TABLE read_liquidity_versions(coin bytea PRIMARY KEY,revision bigserial NOT NULL);
CREATE TABLE read_liquidity_inputs(coin bytea PRIMARY KEY,revision bigint NOT NULL,signature text NOT NULL,data jsonb NOT NULL);
-- statement-breakpoint
CREATE FUNCTION read_liquidity_mark(a bytea[],positions boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 IF positions THEN
  INSERT INTO read_liquidity_versions(coin) SELECT DISTINCT c FROM unnest(a) c WHERE c IS NOT NULL ORDER BY c
  ON CONFLICT(coin) DO UPDATE SET revision=excluded.revision;
 END IF;
 INSERT INTO read_dirty(coin) SELECT DISTINCT c FROM unnest(a) c WHERE c IS NOT NULL ORDER BY c
 ON CONFLICT(coin) DO UPDATE SET revision=excluded.revision;
END $$;
-- statement-breakpoint
CREATE OR REPLACE FUNCTION read_liquidity_dirty() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source text; ids text; keys bytea[]; last_coin bytea=''::bytea; batch bytea[]; positions boolean;
BEGIN
 positions=TG_TABLE_NAME IN ('liquidity_events','pools','coin_lifetime');
 IF TG_OP='TRUNCATE' THEN
  LOOP
   SELECT array_agg(address ORDER BY address) INTO batch FROM (SELECT address FROM tokens WHERE address>last_coin ORDER BY address LIMIT 500) page;
   EXIT WHEN batch IS NULL;
   PERFORM read_liquidity_mark(batch,positions);
   last_coin=batch[array_length(batch,1)];
  END LOOP;
  RETURN NULL;
 END IF;
 source=CASE TG_OP WHEN 'INSERT' THEN 'SELECT * FROM new_rows' WHEN 'DELETE' THEN 'SELECT * FROM old_rows'
 ELSE 'SELECT * FROM new_rows UNION ALL SELECT * FROM old_rows' END;
 IF TG_TABLE_NAME='pons_events' THEN
  EXECUTE 'SELECT array_agg(DISTINCT token ORDER BY token) FROM ('||source||') s WHERE token IS NOT NULL' INTO keys;
 ELSIF TG_TABLE_NAME='pools' THEN
  EXECUTE 'SELECT array_agg(coin ORDER BY coin) FROM (SELECT currency0 AS coin FROM ('||source||') s UNION SELECT currency1 FROM ('||source||') s
   UNION SELECT t.address FROM tokens t JOIN ('||source||') s ON t.graduated_pool=s.id) coins' INTO keys;
 ELSE
  IF TG_TABLE_NAME='coin_lifetime' THEN
   -- Price-tail changes do not invalidate positions. Retention moves liquidity into the lifetime record.
   IF TG_OP='UPDATE' THEN
    source='SELECT n.* FROM new_rows n LEFT JOIN old_rows o USING(coin) WHERE n.data->''liquidity'' IS DISTINCT FROM o.data->''liquidity''
     UNION ALL SELECT o.* FROM old_rows o LEFT JOIN new_rows n USING(coin) WHERE n.data->''liquidity'' IS DISTINCT FROM o.data->''liquidity''';
   END IF;
   ids='SELECT p.id FROM pools p JOIN ('||source||') s ON p.currency0=s.coin UNION SELECT p.id FROM pools p JOIN ('||source||') s ON p.currency1=s.coin';
  ELSE
   ids='SELECT pool_id AS id FROM ('||source||') s';
  END IF;
  EXECUTE 'WITH ids AS MATERIALIZED ('||ids||'), coins AS (
   SELECT p.currency0 AS coin FROM ids i JOIN pools p ON p.id=i.id
   UNION SELECT p.currency1 FROM ids i JOIN pools p ON p.id=i.id
   UNION SELECT t.address FROM ids i JOIN tokens t ON t.graduated_pool=i.id
   '||CASE WHEN TG_TABLE_NAME='coin_lifetime' THEN 'UNION SELECT coin FROM ('||source||') s' ELSE '' END||')
   SELECT array_agg(coin ORDER BY coin) FROM coins' INTO keys;
  -- Curve thresholds and retained prices also change valuation without changing positions.
  IF TG_TABLE_NAME='coin_lifetime' THEN
   EXECUTE 'INSERT INTO read_dirty(coin) SELECT coin FROM ('||CASE TG_OP WHEN 'INSERT' THEN 'SELECT coin FROM new_rows' WHEN 'DELETE' THEN 'SELECT coin FROM old_rows'
    ELSE 'SELECT coin FROM new_rows UNION SELECT coin FROM old_rows' END||') s ORDER BY coin ON CONFLICT(coin) DO UPDATE SET revision=excluded.revision';
  END IF;
 END IF;
 PERFORM read_liquidity_mark(keys,positions);
 RETURN NULL;
END $$;
-- statement-breakpoint
-- Card writes only enqueue work. Taking projection locks in a row trigger used input order,
-- whereas batch refreshes acquire the entire sorted coin set before touching projections.
CREATE OR REPLACE FUNCTION read_card_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RETURN NULL;
END $$;
-- statement-breakpoint
-- Generic dirty writers use the same key order. They never acquire projection mutexes.
CREATE OR REPLACE FUNCTION read_mark_dirty() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE field text; source text;
BEGIN
 field=CASE TG_TABLE_NAME WHEN 'tokens' THEN 'address' WHEN 'pools' THEN 'unnest(ARRAY[currency0,currency1])' ELSE 'coin' END;
 source=CASE TG_OP WHEN 'INSERT' THEN 'SELECT '||field||' AS coin FROM new_rows'
 WHEN 'DELETE' THEN 'SELECT '||field||' AS coin FROM old_rows'
 ELSE 'SELECT '||field||' AS coin FROM new_rows UNION SELECT '||field||' AS coin FROM old_rows' END;
 EXECUTE 'INSERT INTO read_dirty(coin) SELECT DISTINCT coin FROM ('||source||') s ORDER BY coin ON CONFLICT(coin) DO UPDATE SET revision=excluded.revision';
 RETURN NULL;
END $$;
-- statement-breakpoint
CREATE OR REPLACE FUNCTION read_mark_dirty_swaps() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source text;
BEGIN
 source=CASE TG_OP WHEN 'INSERT' THEN 'SELECT coin,trader FROM new_rows WHERE side=1 AND trader IS NOT NULL AND NOT senders_pending'
 WHEN 'DELETE' THEN 'SELECT coin,trader FROM old_rows WHERE side=1 AND trader IS NOT NULL AND NOT senders_pending'
 ELSE 'SELECT coin,trader FROM new_rows WHERE side=1 AND trader IS NOT NULL AND NOT senders_pending UNION SELECT coin,trader FROM old_rows WHERE side=1 AND trader IS NOT NULL AND NOT senders_pending' END;
 EXECUTE 'INSERT INTO read_buyer_dirty(coin,trader) SELECT DISTINCT coin,trader FROM ('||source||') k ORDER BY coin,trader ON CONFLICT(coin,trader) DO UPDATE SET revision=excluded.revision';
 IF TG_OP='INSERT' THEN
  INSERT INTO read_dirty(coin,rebuild) SELECT n.coin,coalesce(bool_or(n.block<=r.buyers_block),false) FROM new_rows n LEFT JOIN read_coins r ON r.coin=n.coin GROUP BY n.coin ORDER BY n.coin
  ON CONFLICT(coin) DO UPDATE SET revision=excluded.revision,rebuild=read_dirty.rebuild OR excluded.rebuild;
 ELSIF TG_OP='DELETE' THEN
  INSERT INTO read_dirty(coin,rebuild) SELECT DISTINCT coin,true FROM old_rows ORDER BY coin
  ON CONFLICT(coin) DO UPDATE SET revision=excluded.revision,rebuild=true;
 ELSE
  INSERT INTO read_dirty(coin,rebuild) SELECT coin,true FROM (SELECT coin FROM new_rows UNION SELECT coin FROM old_rows) k ORDER BY coin
  ON CONFLICT(coin) DO UPDATE SET revision=excluded.revision,rebuild=true;
 END IF;
 RETURN NULL;
END $$;
-- statement-breakpoint
-- Retained per-pool price pointers are decoded once per lifetime write, independently of position revisions.
CREATE TABLE read_liquidity_retained(coin bytea PRIMARY KEY,prices jsonb NOT NULL);
-- statement-breakpoint
CREATE FUNCTION read_liquidity_retained_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='TRUNCATE' THEN DELETE FROM read_liquidity_retained;RETURN NULL; END IF;
 IF TG_OP='DELETE' THEN
  DELETE FROM read_liquidity_retained WHERE coin IN(SELECT coin FROM old_rows);
 ELSE
  IF TG_OP='UPDATE' THEN DELETE FROM read_liquidity_retained WHERE coin IN(SELECT coin FROM old_rows EXCEPT SELECT coin FROM new_rows); END IF;
  INSERT INTO read_liquidity_retained(coin,prices)
  SELECT n.coin,coalesce(p.prices,'{}') FROM new_rows n LEFT JOIN LATERAL (
   SELECT jsonb_object_agg(pool_id,r) AS prices FROM (
    SELECT DISTINCT ON(r->>'pool_id') r->>'pool_id' AS pool_id,r
    FROM jsonb_array_elements(coalesce(n.data->'tail','[]')||CASE WHEN n.data ? 'lastPositivePriced' THEN jsonb_build_array(n.data->'lastPositivePriced') ELSE '[]' END) r
    WHERE (r->>'usd')::float8>0 AND (r->>'amount_coin')::numeric>0 AND (r->>'amount_quote')::numeric>0
    ORDER BY r->>'pool_id',(r->>'block')::bigint DESC,(r->>'log_index')::int DESC,r->>'tx_hash' DESC
   ) latest
  ) p ON true ORDER BY n.coin
  ON CONFLICT(coin) DO UPDATE SET prices=excluded.prices WHERE read_liquidity_retained.prices IS DISTINCT FROM excluded.prices;
 END IF;
 RETURN NULL;
END $$;
-- statement-breakpoint
CREATE TRIGGER read_liquidity_retained_insert AFTER INSERT ON coin_lifetime REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION read_liquidity_retained_changed();
CREATE TRIGGER read_liquidity_retained_update AFTER UPDATE ON coin_lifetime REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION read_liquidity_retained_changed();
CREATE TRIGGER read_liquidity_retained_delete AFTER DELETE ON coin_lifetime REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION read_liquidity_retained_changed();
CREATE TRIGGER read_liquidity_retained_truncate AFTER TRUNCATE ON coin_lifetime FOR EACH STATEMENT EXECUTE FUNCTION read_liquidity_retained_changed();
-- statement-breakpoint
-- Prime existing retained pointers in bounded key batches. No raw history is read.
DO $$
DECLARE last_coin bytea=''::bytea; batch bytea[];
BEGIN
 LOOP
  SELECT array_agg(coin ORDER BY coin) INTO batch FROM (SELECT coin FROM coin_lifetime WHERE coin>last_coin ORDER BY coin LIMIT 500) page;
  EXIT WHEN batch IS NULL;
  INSERT INTO read_liquidity_retained(coin,prices)
  SELECT n.coin,coalesce(p.prices,'{}') FROM coin_lifetime n LEFT JOIN LATERAL (
   SELECT jsonb_object_agg(pool_id,r) AS prices FROM (
    SELECT DISTINCT ON(r->>'pool_id') r->>'pool_id' AS pool_id,r
    FROM jsonb_array_elements(coalesce(n.data->'tail','[]')||CASE WHEN n.data ? 'lastPositivePriced' THEN jsonb_build_array(n.data->'lastPositivePriced') ELSE '[]' END) r
    WHERE (r->>'usd')::float8>0 AND (r->>'amount_coin')::numeric>0 AND (r->>'amount_quote')::numeric>0
    ORDER BY r->>'pool_id',(r->>'block')::bigint DESC,(r->>'log_index')::int DESC,r->>'tx_hash' DESC
   ) latest
  ) p ON true WHERE n.coin=ANY(batch) ORDER BY n.coin;
  last_coin=batch[array_length(batch,1)];
 END LOOP;
END $$;
