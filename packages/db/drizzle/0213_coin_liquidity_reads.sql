-- API-owned projection, rebuilt in bounded dirty-coin batches without reading raw history at migration time.
CREATE TABLE read_coin_liquidity(
 coin bytea PRIMARY KEY,usd double precision NOT NULL,unavailable boolean NOT NULL,curve_pct double precision
);
CREATE INDEX IF NOT EXISTS tokens_graduated_pool_reads ON tokens(graduated_pool) WHERE graduated_pool IS NOT NULL;
CREATE INDEX IF NOT EXISTS pools_currency1_reads ON pools(currency1);
-- statement-breakpoint
CREATE FUNCTION read_liquidity_dirty() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source text; ids text;
BEGIN
 IF TG_OP='TRUNCATE' THEN
  INSERT INTO read_dirty(coin) SELECT address FROM tokens ORDER BY address
  ON CONFLICT(coin) DO UPDATE SET revision=excluded.revision;
  RETURN NULL;
 END IF;
 source=CASE TG_OP WHEN 'INSERT' THEN 'SELECT * FROM new_rows' WHEN 'DELETE' THEN 'SELECT * FROM old_rows'
 ELSE 'SELECT * FROM new_rows UNION ALL SELECT * FROM old_rows' END;
 IF TG_TABLE_NAME='pons_events' THEN
  EXECUTE 'INSERT INTO read_dirty(coin) SELECT DISTINCT token FROM ('||source||') s WHERE token IS NOT NULL ORDER BY token
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
CREATE TRIGGER read_liquidity_insert AFTER INSERT ON liquidity_events REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION read_liquidity_dirty();
CREATE TRIGGER read_liquidity_update AFTER UPDATE ON liquidity_events REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION read_liquidity_dirty();
CREATE TRIGGER read_liquidity_delete AFTER DELETE ON liquidity_events REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION read_liquidity_dirty();
CREATE TRIGGER read_liquidity_truncate AFTER TRUNCATE ON liquidity_events FOR EACH STATEMENT EXECUTE FUNCTION read_liquidity_dirty();
CREATE TRIGGER read_liquidity_pool_insert AFTER INSERT ON pools REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION read_liquidity_dirty();
CREATE TRIGGER read_liquidity_pool_update AFTER UPDATE ON pools REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION read_liquidity_dirty();
CREATE TRIGGER read_liquidity_pool_delete AFTER DELETE ON pools REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION read_liquidity_dirty();
CREATE TRIGGER read_liquidity_lifetime_insert AFTER INSERT ON coin_lifetime REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION read_liquidity_dirty();
CREATE TRIGGER read_liquidity_lifetime_update AFTER UPDATE ON coin_lifetime REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION read_liquidity_dirty();
CREATE TRIGGER read_liquidity_lifetime_delete AFTER DELETE ON coin_lifetime REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION read_liquidity_dirty();
CREATE TRIGGER read_liquidity_lifetime_truncate AFTER TRUNCATE ON coin_lifetime FOR EACH STATEMENT EXECUTE FUNCTION read_liquidity_dirty();
INSERT INTO read_dirty(coin) SELECT address FROM tokens ORDER BY address ON CONFLICT(coin) DO UPDATE SET revision=excluded.revision;
CREATE TRIGGER read_liquidity_card_insert AFTER INSERT ON coin_card_latest REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION read_mark_dirty();
CREATE TRIGGER read_liquidity_card_update AFTER UPDATE ON coin_card_latest REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION read_mark_dirty();
CREATE TRIGGER read_liquidity_card_delete AFTER DELETE ON coin_card_latest REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION read_mark_dirty();
CREATE TRIGGER read_liquidity_pons_insert AFTER INSERT ON pons_events REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION read_liquidity_dirty();
CREATE TRIGGER read_liquidity_pons_update AFTER UPDATE ON pons_events REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION read_liquidity_dirty();
CREATE TRIGGER read_liquidity_pons_delete AFTER DELETE ON pons_events REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION read_liquidity_dirty();
