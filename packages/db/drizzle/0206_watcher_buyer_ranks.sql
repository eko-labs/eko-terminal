-- No source backfill here. Run scripts/backfill-watcher-buyers.sql after installing this migration.
CREATE TABLE read_buyer_firsts (LIKE coin_buyer_firsts INCLUDING DEFAULTS INCLUDING CONSTRAINTS);
ALTER TABLE read_buyer_firsts ADD PRIMARY KEY(coin,trader);
CREATE INDEX IF NOT EXISTS read_buyer_firsts_block ON read_buyer_firsts(coin,first_block);
CREATE TABLE read_unknown_buys (coin bytea NOT NULL,block bigint NOT NULL,n bigint NOT NULL,PRIMARY KEY(coin,block));
CREATE TABLE watcher_wallets (trader bytea PRIMARY KEY,checked_at timestamptz NOT NULL DEFAULT '-infinity');
CREATE INDEX IF NOT EXISTS watcher_wallets_checked ON watcher_wallets(checked_at,trader);
ALTER TABLE wallet_fingerprint_state ADD COLUMN pending_blocks bigint[] NOT NULL DEFAULT '{}';
ALTER TABLE wallet_fingerprint_state ADD COLUMN pending_revision text;
-- statement-breakpoint
-- Lock projection keys in a stable order before probing source indexes. Inserts use only transition rows.
CREATE FUNCTION watcher_buyer_firsts_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source text; keys text; fresh text; prior text;
BEGIN
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
-- statement-breakpoint
CREATE TRIGGER watcher_buyer_firsts_insert AFTER INSERT ON swaps REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION watcher_buyer_firsts_changed();
CREATE TRIGGER watcher_buyer_firsts_update AFTER UPDATE ON swaps REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION watcher_buyer_firsts_changed();
CREATE TRIGGER watcher_buyer_firsts_delete AFTER DELETE ON swaps REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION watcher_buyer_firsts_changed();
CREATE TRIGGER watcher_retained_firsts_insert AFTER INSERT ON coin_buyer_firsts REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION watcher_buyer_firsts_changed();
CREATE TRIGGER watcher_retained_firsts_update AFTER UPDATE ON coin_buyer_firsts REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION watcher_buyer_firsts_changed();
CREATE TRIGGER watcher_retained_firsts_delete AFTER DELETE ON coin_buyer_firsts REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION watcher_buyer_firsts_changed();
-- statement-breakpoint
CREATE FUNCTION watcher_swap_schedule() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source text;
BEGIN
 source=CASE TG_OP WHEN 'INSERT' THEN 'SELECT *,1 AS delta FROM new_rows' WHEN 'DELETE' THEN 'SELECT *,-1 AS delta FROM old_rows'
  ELSE 'SELECT *,1 AS delta FROM new_rows UNION ALL SELECT *,-1 AS delta FROM old_rows' END;
 EXECUTE 'SELECT pg_advisory_xact_lock(hashtextextended(encode(coin,''hex''),206)) FROM (SELECT DISTINCT coin FROM ('||source||') s) k ORDER BY coin';
 EXECUTE 'INSERT INTO watcher_wallets(trader) SELECT DISTINCT trader FROM ('||source||') s WHERE trader IS NOT NULL ORDER BY trader ON CONFLICT DO NOTHING';
 EXECUTE 'INSERT INTO read_unknown_buys SELECT coin,block,sum(delta) FROM ('||source||') s WHERE side=1 AND (trader IS NULL OR senders_pending)
  GROUP BY coin,block HAVING sum(delta)<>0 ORDER BY coin,block ON CONFLICT(coin,block) DO UPDATE SET n=read_unknown_buys.n+excluded.n';
 RETURN NULL;
END $$;
-- statement-breakpoint
CREATE TRIGGER watcher_schedule_insert AFTER INSERT ON swaps REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION watcher_swap_schedule();
CREATE TRIGGER watcher_schedule_update AFTER UPDATE ON swaps REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION watcher_swap_schedule();
CREATE TRIGGER watcher_schedule_delete AFTER DELETE ON swaps REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION watcher_swap_schedule();
