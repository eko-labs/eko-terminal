-- Hide sealed source rows while the separate detach transaction waits for its lock.
CREATE OR REPLACE VIEW retention_read_swaps AS
 SELECT coin,pool_id,block,log_index,tx_hash,amount_coin,amount_quote,usd,ts FROM raw_history_live_swaps
 UNION ALL
 SELECT l.coin,decode(substring(r->>'pool_id' FROM 3),'hex'),(r->>'block')::bigint,(r->>'log_index')::integer,decode(substring(r->>'tx_hash' FROM 3),'hex'),
 (r->>'amount_coin')::numeric,(r->>'amount_quote')::numeric,(r->>'usd')::double precision,(r->>'ts')::timestamptz
 FROM coin_lifetime l CROSS JOIN LATERAL jsonb_array_elements(coalesce(l.data->'tail','[]') ||
 CASE WHEN coalesce(l.data->'lastRatingPriced',l.data->'lastPositivePriced') IS NOT NULL AND NOT EXISTS(
 SELECT 1 FROM jsonb_array_elements(coalesce(l.data->'tail','[]')) t
 WHERE t->>'tx_hash'=coalesce(l.data->'lastRatingPriced',l.data->'lastPositivePriced')->>'tx_hash'
 AND t->>'log_index'=coalesce(l.data->'lastRatingPriced',l.data->'lastPositivePriced')->>'log_index')
 THEN jsonb_build_array(coalesce(l.data->'lastRatingPriced',l.data->'lastPositivePriced')) ELSE '[]'::jsonb END) r;


-- statement-breakpoint
-- Bulk retained publication writes read_buyer_firsts explicitly; parent ingest still uses the original mutex.
CREATE OR REPLACE FUNCTION watcher_buyer_firsts_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source text; keys text; fresh text; prior text;
BEGIN
 IF TG_TABLE_NAME='coin_buyer_firsts' AND current_setting('eko.raw_partition_seal',true)='on' THEN RETURN NULL; END IF;
 -- Acquire every affected coin before either projection, including unknown-only coins.
 source=CASE TG_OP WHEN 'INSERT' THEN 'SELECT coin FROM new_rows' WHEN 'DELETE' THEN 'SELECT coin FROM old_rows'
  ELSE 'SELECT coin FROM new_rows UNION SELECT coin FROM old_rows' END;
 EXECUTE 'SELECT pg_advisory_xact_lock(hashtextextended(encode(coin,''hex''),206)) FROM (SELECT DISTINCT coin FROM ('||source||') s) k ORDER BY coin';
 IF TG_TABLE_NAME='swaps' THEN
  fresh='SELECT coin,trader,block AS first_block,pool_id,tx_hash,log_index FROM new_rows WHERE side=1 AND trader IS NOT NULL AND NOT senders_pending';
  prior='SELECT coin,trader,block AS first_block,pool_id,tx_hash,log_index FROM old_rows WHERE side=1 AND trader IS NOT NULL AND NOT senders_pending';
  -- Price-only repairs do not change a first buy and must not probe wallet histories again.
  source=CASE TG_OP WHEN 'INSERT' THEN fresh WHEN 'DELETE' THEN prior
   ELSE '('||fresh||' EXCEPT '||prior||') UNION ALL ('||prior||' EXCEPT '||fresh||')' END;
 ELSE
  source=CASE TG_OP WHEN 'INSERT' THEN 'SELECT * FROM new_rows' WHEN 'DELETE' THEN 'SELECT * FROM old_rows' ELSE 'SELECT * FROM new_rows UNION ALL SELECT * FROM old_rows' END;
 END IF;
 IF TG_OP='INSERT' THEN
  EXECUTE 'INSERT INTO read_buyer_firsts SELECT DISTINCT ON(coin,trader) * FROM ('||source||') s ORDER BY coin,trader,first_block,tx_hash,log_index
   ON CONFLICT(coin,trader) DO UPDATE SET first_block=excluded.first_block,pool_id=excluded.pool_id,tx_hash=excluded.tx_hash,log_index=excluded.log_index
   WHERE (excluded.first_block,excluded.tx_hash,excluded.log_index)<(read_buyer_firsts.first_block,read_buyer_firsts.tx_hash,read_buyer_firsts.log_index)';
 ELSE
  keys='SELECT DISTINCT coin,trader FROM ('||source||') s';
  EXECUTE 'SELECT coin FROM read_buyer_firsts WHERE (coin,trader) IN ('||keys||') ORDER BY coin,trader FOR UPDATE';
  EXECUTE 'WITH keys AS MATERIALIZED ('||keys||'), desired AS MATERIALIZED (
   SELECT k.coin,k.trader,x.* FROM keys k CROSS JOIN LATERAL (
    SELECT * FROM (
     (SELECT block AS first_block,pool_id,tx_hash,log_index FROM swaps s WHERE s.coin=k.coin AND s.trader=k.trader AND s.side=1 AND s.trader IS NOT NULL AND NOT s.senders_pending ORDER BY block,tx_hash,log_index LIMIT 1)
     UNION ALL SELECT first_block,pool_id,tx_hash,log_index FROM coin_buyer_firsts b WHERE b.coin=k.coin AND b.trader=k.trader
    ) a ORDER BY first_block,tx_hash,log_index LIMIT 1) x),
   removed AS (DELETE FROM read_buyer_firsts b USING keys k WHERE b.coin=k.coin AND b.trader=k.trader AND NOT EXISTS(SELECT 1 FROM desired d WHERE d.coin=k.coin AND d.trader=k.trader))
   INSERT INTO read_buyer_firsts SELECT * FROM desired ORDER BY coin,trader
   ON CONFLICT(coin,trader) DO UPDATE SET first_block=excluded.first_block,pool_id=excluded.pool_id,tx_hash=excluded.tx_hash,log_index=excluded.log_index';
 END IF;
 RETURN NULL;
END $$;
