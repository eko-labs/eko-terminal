-- Extend 0213 invalidation without reading raw trade or transfer history.
CREATE OR REPLACE FUNCTION read_liquidity_dirty() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source text; ids text; last_coin bytea=''::bytea; batch bytea[];
BEGIN
 IF TG_OP='TRUNCATE' THEN
  LOOP
   SELECT array_agg(address ORDER BY address) INTO batch FROM (SELECT address FROM tokens WHERE address>last_coin ORDER BY address LIMIT 500) page;
   EXIT WHEN batch IS NULL;
   INSERT INTO read_dirty(coin) SELECT unnest(batch) ON CONFLICT(coin) DO UPDATE SET revision=excluded.revision;
   last_coin=batch[array_length(batch,1)];
  END LOOP;
  RETURN NULL;
 END IF;
 source=CASE TG_OP WHEN 'INSERT' THEN 'SELECT * FROM new_rows' WHEN 'DELETE' THEN 'SELECT * FROM old_rows'
 ELSE 'SELECT * FROM new_rows UNION ALL SELECT * FROM old_rows' END;
 IF TG_TABLE_NAME='pons_events' THEN
  EXECUTE 'INSERT INTO read_dirty(coin) SELECT DISTINCT token FROM ('||source||') s WHERE token IS NOT NULL ORDER BY token
   ON CONFLICT(coin) DO UPDATE SET revision=excluded.revision';
  RETURN NULL;
 END IF;
 IF TG_TABLE_NAME='pools' THEN
  -- Transition rows preserve deleted pools and former currencies after a currency repair.
  EXECUTE 'WITH coins AS (SELECT currency0 AS coin FROM ('||source||') s UNION SELECT currency1 FROM ('||source||') s
   UNION SELECT t.address FROM tokens t JOIN ('||source||') s ON t.graduated_pool=s.id)
   INSERT INTO read_dirty(coin) SELECT coin FROM coins ORDER BY coin
   ON CONFLICT(coin) DO UPDATE SET revision=excluded.revision';
  RETURN NULL;
 END IF;
 IF TG_TABLE_NAME='coin_lifetime' THEN
  ids='SELECT p.id FROM pools p JOIN ('||source||') s ON p.currency0=s.coin UNION SELECT p.id FROM pools p JOIN ('||source||') s ON p.currency1=s.coin';
 ELSE
  ids='SELECT '||CASE TG_TABLE_NAME WHEN 'pools' THEN 'id' ELSE 'pool_id' END||' AS id FROM ('||source||') s';
 END IF;
 EXECUTE 'WITH ids AS MATERIALIZED ('||ids||'), coins AS (
 SELECT p.currency0 AS coin FROM ids i JOIN pools p ON p.id=i.id
 UNION SELECT p.currency1 FROM ids i JOIN pools p ON p.id=i.id
 UNION SELECT t.address FROM ids i JOIN tokens t ON t.graduated_pool=i.id
 '||CASE WHEN TG_TABLE_NAME='coin_lifetime' THEN 'UNION SELECT coin FROM ('||source||') s' ELSE '' END||')
 INSERT INTO read_dirty(coin) SELECT coin FROM coins ORDER BY coin
 ON CONFLICT(coin) DO UPDATE SET revision=excluded.revision';
 RETURN NULL;
END $$;
-- statement-breakpoint
CREATE TRIGGER read_liquidity_pool_truncate AFTER TRUNCATE ON pools FOR EACH STATEMENT EXECUTE FUNCTION read_liquidity_dirty();
CREATE TRIGGER read_liquidity_pons_truncate AFTER TRUNCATE ON pons_events FOR EACH STATEMENT EXECUTE FUNCTION read_liquidity_dirty();
CREATE TRIGGER read_liquidity_card_truncate AFTER TRUNCATE ON coin_card_latest FOR EACH STATEMENT EXECUTE FUNCTION read_liquidity_dirty();
-- statement-breakpoint
-- Reconcile previously missed pool changes through bounded dirty-key batches.
DO $$
DECLARE last_coin bytea=''::bytea; batch bytea[];
BEGIN
 LOOP
  SELECT array_agg(address ORDER BY address) INTO batch FROM (SELECT address FROM tokens WHERE address>last_coin ORDER BY address LIMIT 500) page;
  EXIT WHEN batch IS NULL;
  INSERT INTO read_dirty(coin) SELECT unnest(batch) ON CONFLICT(coin) DO UPDATE SET revision=excluded.revision;
  last_coin=batch[array_length(batch,1)];
 END LOOP;
END $$;
