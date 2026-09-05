-- Bar-derived payloads are maintained at write time, never aggregated by row readers.
-- History arrays cover the last day for clock rolls without rereading bars.
CREATE TABLE read_row_series (
 coin bytea PRIMARY KEY, revision bigint NOT NULL DEFAULT 0, window_sec double precision NOT NULL DEFAULT 0,
 minutes double precision[] NOT NULL DEFAULT '{}', closes double precision[] NOT NULL DEFAULT '{}',
 volumes double precision[] NOT NULL DEFAULT '{}', trade_counts bigint[] NOT NULL DEFAULT '{}',
 price double precision, previous1h double precision, previous24h double precision, volume double precision NOT NULL DEFAULT 0,
 trades bigint NOT NULL DEFAULT 0, prior_volume double precision NOT NULL DEFAULT 0, first_minute timestamptz, next_at double precision,
 points double precision[] NOT NULL DEFAULT '{}'
);
CREATE INDEX read_row_series_due ON read_row_series(next_at) WHERE next_at IS NOT NULL;
CREATE INDEX read_row_series_clock ON read_row_series(window_sec);
ALTER TABLE read_coins ADD COLUMN row_price double precision, ADD COLUMN row_previous1h double precision,
 ADD COLUMN row_previous24h double precision, ADD COLUMN row_volume double precision NOT NULL DEFAULT 0,
 ADD COLUMN row_trades bigint NOT NULL DEFAULT 0, ADD COLUMN row_prior_volume double precision NOT NULL DEFAULT 0,
 ADD COLUMN row_first_minute timestamptz;
-- statement-breakpoint
CREATE FUNCTION refresh_read_row_series(a bytea[],at_sec double precision,source_bars boolean DEFAULT true) RETURNS void LANGUAGE plpgsql AS $$
DECLARE k bytea; s read_row_series%ROWTYPE; h double precision; d double precision; v double precision; n bigint; prior double precision;
 first_spark double precision; width double precision; spark_points double precision[];
BEGIN
 FOR k IN SELECT DISTINCT unnest(a) ORDER BY 1 LOOP
  INSERT INTO read_row_series(coin) VALUES(k) ON CONFLICT DO NOTHING;
  SELECT * INTO s FROM read_row_series WHERE coin=k FOR UPDATE;
  IF source_bars OR at_sec<s.window_sec THEN
   SELECT coalesce(array_agg(extract(epoch FROM minute)::double precision ORDER BY minute),'{}'),
    coalesce(array_agg(close ORDER BY minute),'{}'),coalesce(array_agg(volume_usd ORDER BY minute),'{}'),coalesce(array_agg(trades ORDER BY minute),'{}')
   INTO s.minutes,s.closes,s.volumes,s.trade_counts FROM bars_1m WHERE coin=k AND minute>=to_timestamp(at_sec-86400);
   SELECT close INTO s.price FROM bars_1m WHERE coin=k ORDER BY minute DESC LIMIT 1;
   SELECT close INTO s.previous24h FROM bars_1m WHERE coin=k AND minute<=to_timestamp(at_sec-86400) ORDER BY minute DESC LIMIT 1;
   SELECT minute INTO s.first_minute FROM bars_1m WHERE coin=k ORDER BY minute LIMIT 1;
  END IF;
  SELECT x.close INTO h FROM unnest(s.minutes,s.closes) x(minute,close) WHERE minute<=at_sec-3600 ORDER BY minute DESC LIMIT 1;
  -- The day reference survives array expiry for a quiet coin.
  SELECT x.close INTO d FROM unnest(s.minutes,s.closes) x(minute,close) WHERE minute<=at_sec-86400 ORDER BY minute DESC LIMIT 1;
  s.previous24h=coalesce(d,s.previous24h);
  SELECT coalesce(sum(volume) FILTER(WHERE minute>=at_sec-3600),0),coalesce(sum(trades) FILTER(WHERE minute>=at_sec-3600),0),
   coalesce(sum(volume) FILTER(WHERE minute<at_sec-3600),0)
  INTO v,n,prior FROM unnest(s.minutes,s.volumes,s.trade_counts) x(minute,volume,trades) WHERE minute>=at_sec-86400;
  SELECT min(minute) INTO first_spark FROM unnest(s.minutes) minute WHERE minute>=at_sec-28800 AND minute<=at_sec;
  width=60*greatest(1,ceil((at_sec-first_spark)/5760.0));
  SELECT coalesce(array_agg(close ORDER BY bucket),'{}') INTO spark_points FROM (
   SELECT DISTINCT ON(floor((minute-first_spark)/width)) floor((minute-first_spark)/width) AS bucket,close
   FROM unnest(s.minutes,s.closes) x(minute,close) WHERE minute>=at_sec-28800 AND minute<=at_sec
   ORDER BY bucket,minute DESC
  ) b;
  UPDATE read_row_series SET revision=revision+1,window_sec=at_sec,minutes=s.minutes,closes=s.closes,volumes=s.volumes,trade_counts=s.trade_counts,
   price=s.price,previous24h=s.previous24h,first_minute=s.first_minute,points=spark_points,previous1h=coalesce(h,s.previous24h),volume=v,trades=n,prior_volume=prior,
   next_at=CASE WHEN coalesce(s.minutes[array_length(s.minutes,1)],0)>=at_sec-86400 THEN (floor(at_sec/60)+1)*60 END WHERE coin=k;
  UPDATE read_coins SET row_price=s.price,row_previous1h=coalesce(h,s.previous24h),row_previous24h=s.previous24h,
   row_volume=v,row_trades=n,row_prior_volume=prior,row_first_minute=s.first_minute WHERE coin=k
   AND (row_price,row_previous1h,row_previous24h,row_volume,row_trades,row_prior_volume,row_first_minute)
   IS DISTINCT FROM (s.price,coalesce(h,s.previous24h),s.previous24h,v,n,prior,s.first_minute);
 END LOOP;
END $$;
-- statement-breakpoint
CREATE FUNCTION read_row_bars_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a bytea[];
BEGIN
 IF TG_OP='TRUNCATE' THEN
  DELETE FROM read_row_series;
  UPDATE read_coins SET row_price=NULL,row_previous1h=NULL,row_previous24h=NULL,row_volume=0,row_trades=0,row_prior_volume=0,row_first_minute=NULL;
  RETURN NULL;
 END IF;
 IF TG_OP='INSERT' THEN SELECT array_agg(DISTINCT coin) INTO a FROM new_rows;
 ELSIF TG_OP='DELETE' THEN SELECT array_agg(DISTINCT coin) INTO a FROM old_rows;
 ELSE SELECT array_agg(coin) INTO a FROM (SELECT coin FROM old_rows UNION SELECT coin FROM new_rows) k;
 END IF;
 PERFORM refresh_read_row_series(a,extract(epoch FROM now())::double precision);
 RETURN NULL;
END $$;
-- statement-breakpoint
CREATE TRIGGER read_row_bars_insert AFTER INSERT ON bars_1m REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION read_row_bars_changed();
CREATE TRIGGER read_row_bars_update AFTER UPDATE ON bars_1m REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION read_row_bars_changed();
CREATE TRIGGER read_row_bars_delete AFTER DELETE ON bars_1m REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION read_row_bars_changed();
CREATE TRIGGER read_row_bars_truncate AFTER TRUNCATE ON bars_1m FOR EACH STATEMENT EXECUTE FUNCTION read_row_bars_changed();
-- Revisions include same-card-id data repairs and token identity changes.
CREATE SEQUENCE read_row_card_revision;
CREATE TABLE read_row_cards(coin bytea PRIMARY KEY,revision bigint NOT NULL DEFAULT nextval('read_row_card_revision'));
INSERT INTO read_row_cards(coin) SELECT address FROM tokens;
-- statement-breakpoint
CREATE FUNCTION read_row_card_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE k bytea;
BEGIN
 IF TG_OP='TRUNCATE' THEN
  IF TG_TABLE_NAME='tokens' THEN DELETE FROM read_row_series; END IF;
  DELETE FROM read_row_cards;
  INSERT INTO read_row_cards(coin) SELECT address FROM tokens;
  RETURN NULL;
 END IF;
 IF TG_TABLE_NAME='tokens' AND TG_OP='INSERT' THEN
  INSERT INTO read_row_series(coin) VALUES(NEW.address) ON CONFLICT DO NOTHING;
 END IF;
 IF TG_TABLE_NAME='tokens' AND TG_OP='DELETE' THEN
  DELETE FROM read_row_cards WHERE coin=OLD.address;
  DELETE FROM read_row_series WHERE coin=OLD.address;
  RETURN NULL;
 END IF;
 k=coalesce(to_jsonb(NEW)->>CASE WHEN TG_TABLE_NAME='tokens' THEN 'address' ELSE 'coin' END,
  to_jsonb(OLD)->>CASE WHEN TG_TABLE_NAME='tokens' THEN 'address' ELSE 'coin' END)::bytea;
 INSERT INTO read_row_cards(coin) VALUES(k) ON CONFLICT(coin) DO UPDATE SET revision=excluded.revision;
 IF TG_OP='UPDATE' THEN
  k=(to_jsonb(OLD)->>CASE WHEN TG_TABLE_NAME='tokens' THEN 'address' ELSE 'coin' END)::bytea;
  INSERT INTO read_row_cards(coin) VALUES(k) ON CONFLICT(coin) DO UPDATE SET revision=excluded.revision;
 END IF;
 RETURN NULL;
END $$;
-- statement-breakpoint
CREATE TRIGGER read_row_card_change AFTER INSERT OR UPDATE OR DELETE ON coin_card_latest FOR EACH ROW EXECUTE FUNCTION read_row_card_changed();
CREATE TRIGGER read_row_token_change AFTER INSERT OR UPDATE OR DELETE ON tokens FOR EACH ROW EXECUTE FUNCTION read_row_card_changed();
CREATE TRIGGER read_row_card_truncate AFTER TRUNCATE ON coin_card_latest FOR EACH STATEMENT EXECUTE FUNCTION read_row_card_changed();
CREATE TRIGGER read_row_token_truncate AFTER TRUNCATE ON tokens FOR EACH STATEMENT EXECUTE FUNCTION read_row_card_changed();
-- Seed newly listed coins from the independently maintained bar projection.
-- statement-breakpoint
CREATE FUNCTION read_row_coin_inserted() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s read_row_series%ROWTYPE;
BEGIN
 -- Take the series lock before the coin row exists, matching the bar writer lock order.
 SELECT * INTO s FROM read_row_series WHERE coin=NEW.coin FOR SHARE;
 IF FOUND THEN
  NEW.row_price=s.price;NEW.row_previous1h=s.previous1h;NEW.row_previous24h=s.previous24h;
  NEW.row_volume=s.volume;NEW.row_trades=s.trades;NEW.row_prior_volume=s.prior_volume;NEW.row_first_minute=s.first_minute;
 END IF;
 RETURN NEW;
END $$;
-- statement-breakpoint
CREATE TRIGGER read_row_coin_insert BEFORE INSERT ON read_coins FOR EACH ROW EXECUTE FUNCTION read_row_coin_inserted();
