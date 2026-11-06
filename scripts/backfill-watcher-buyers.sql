-- Rerunnable backfill for 0206. Run after migration, before enabling watcher refreshes.
-- psql -v ON_ERROR_STOP=1 -f scripts/backfill-watcher-buyers.sql
-- Reads existing swaps outside migration. Run during a quiet period.
-- Each coin commits separately, with a pause. Source triggers share this coin mutex,
-- so concurrent enrichment, reorgs and compaction cannot lose a first or a count.
CREATE OR REPLACE FUNCTION pg_temp.backfill_watcher_coin(c bytea) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(encode(c,'hex'),206));
 DELETE FROM read_buyer_firsts WHERE coin=c;
 INSERT INTO read_buyer_firsts
 SELECT DISTINCT ON(coin,trader) * FROM (
  SELECT coin,trader,block AS first_block,pool_id,tx_hash,log_index FROM swaps
   WHERE coin=c AND side=1 AND trader IS NOT NULL AND NOT senders_pending
  UNION ALL SELECT * FROM coin_buyer_firsts WHERE coin=c
 ) s ORDER BY coin,trader,first_block,tx_hash,log_index;
 DELETE FROM read_unknown_buys WHERE coin=c;
 INSERT INTO read_unknown_buys SELECT coin,block,count(*) FROM swaps
  WHERE coin=c AND side=1 AND (trader IS NULL OR senders_pending) GROUP BY coin,block;
 INSERT INTO watcher_wallets(trader) SELECT DISTINCT trader FROM swaps WHERE coin=c AND trader IS NOT NULL ON CONFLICT DO NOTHING;
END $$;
-- psql executes each generated statement in its own transaction, never one transaction for the whole database.
SELECT format('SELECT pg_temp.backfill_watcher_coin(decode(%L,''hex'')); SELECT pg_sleep(0.1)',encode(coin,'hex'))
 FROM (SELECT DISTINCT coin FROM swaps UNION SELECT coin FROM coin_buyer_firsts UNION SELECT coin FROM read_buyer_firsts UNION SELECT coin FROM read_unknown_buys) coins
 ORDER BY coin
\gexec
ANALYZE read_buyer_firsts;
ANALYZE read_unknown_buys;
ANALYZE watcher_wallets;
