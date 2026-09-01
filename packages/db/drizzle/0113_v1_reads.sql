-- Indexed, transactionally maintained read projections. Historical backfill happens once at migration.
CREATE INDEX verdict_events_verdict_kind ON verdict_events(verdict_id,kind);
CREATE INDEX engine_runs_sec_coin ON engine_runs(sec,coin);
CREATE TABLE read_coins (
 coin bytea PRIMARY KEY REFERENCES tokens(address) ON DELETE CASCADE,
 tier smallint NOT NULL, volume double precision NOT NULL DEFAULT 0,
 activity timestamptz NOT NULL, first_block bigint NOT NULL,
 pair_column text NOT NULL, pair_block bigint NOT NULL, launchpad text,
 buyers bigint NOT NULL DEFAULT 0
);
CREATE INDEX read_coins_rank ON read_coins(tier,(-volume),coin);
CREATE INDEX read_coins_activity ON read_coins(activity,tier);
CREATE INDEX read_coins_pair ON read_coins(pair_column,pair_block DESC,coin DESC) WHERE launchpad='pons';
CREATE TABLE read_buyers (coin bytea NOT NULL REFERENCES tokens(address) ON DELETE CASCADE,trader bytea NOT NULL, PRIMARY KEY(coin,trader));
CREATE TABLE read_feed (id text PRIMARY KEY, coin bytea NOT NULL REFERENCES tokens(address) ON DELETE CASCADE,block bigint NOT NULL,kind text NOT NULL,data jsonb NOT NULL,verdict_id text,first_block bigint,symbol text);
CREATE INDEX read_feed_cursor ON read_feed(block DESC,id DESC);
CREATE INDEX read_feed_kind_cursor ON read_feed(kind,block DESC,id DESC);
CREATE INDEX read_feed_coin_block ON read_feed(coin,block);
CREATE INDEX read_feed_verdict ON read_feed(verdict_id) WHERE verdict_id IS NOT NULL;
CREATE TABLE read_first_verdict (coin bytea PRIMARY KEY REFERENCES tokens(address) ON DELETE CASCADE,block bigint NOT NULL);

-- Upgrade mutable latest cards only. Historical hashed card versions stay intact.
-- Use balances when the card includes the latest curve movement, otherwise reconstruct its block view.
WITH launches AS (
 SELECT DISTINCT ON(t.address) t.address,t.curve,c.as_of_block,x.amount AS initial
 FROM tokens t JOIN coin_card_latest c ON c.coin=t.address JOIN token_transfers x ON x.token=t.address AND x.to_address=t.curve
 WHERE t.launchpad='pons' AND t.deployer IS NOT NULL AND x.kind='Transfer' AND x.amount>0 AND x.block<=c.as_of_block AND c.data->'identity'->'curvePct' IS NULL
 ORDER BY t.address,x.block,x.log_index,x.tx_hash
), inventory AS (
 SELECT l.address,l.initial,l.as_of_block,max(x.block) AS last_block,
 coalesce(sum(CASE WHEN x.block<=l.as_of_block THEN CASE WHEN x.to_address=l.curve THEN x.amount ELSE 0 END-CASE WHEN x.from_address=l.curve THEN x.amount ELSE 0 END ELSE 0 END),0) AS at_block,
 coalesce(b.amount,0) AS balance
 FROM launches l LEFT JOIN token_transfers x ON x.token=l.address AND x.kind='Transfer' AND (x.to_address=l.curve OR x.from_address=l.curve)
 LEFT JOIN balances b ON b.token=l.address AND b.holder=l.curve GROUP BY l.address,l.initial,l.as_of_block,b.amount
)
UPDATE coin_card_latest c SET data=jsonb_set(c.data,'{identity,curvePct}',to_jsonb(trunc(greatest(0,least(100,100*(i.initial-CASE WHEN i.last_block<=i.as_of_block THEN i.balance ELSE i.at_block END)/i.initial))*100)/100))
 FROM inventory i WHERE c.coin=i.address;

-- statement-breakpoint
CREATE FUNCTION read_feed_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 SELECT first_block,symbol INTO NEW.first_block,NEW.symbol FROM tokens WHERE address=NEW.coin; RETURN NEW;
END $$;
-- statement-breakpoint
CREATE TRIGGER read_feed_identity BEFORE INSERT OR UPDATE ON read_feed FOR EACH ROW EXECUTE FUNCTION read_feed_identity();
-- statement-breakpoint
CREATE FUNCTION refresh_read_coin(a bytea) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO read_coins(coin,tier,activity,first_block,pair_column,pair_block,launchpad)
 SELECT t.address,CASE c.data->'verdict'->>'level' WHEN 'clear' THEN 0 WHEN 'monitor' THEN 1 WHEN 'danger' THEN 3 ELSE 2 END,
 coalesce((SELECT max(ts) FROM swaps WHERE coin=t.address),bt.ts,cb.ts,(c.data->'identity'->>'createdAt')::timestamptz),t.first_block,
 CASE WHEN t.graduated_block IS NOT NULL THEN 'migrated' WHEN coalesce((c.data->'identity'->>'curvePct')::double precision,0)>=75 THEN 'near_grad' ELSE 'new' END,
 coalesce(t.graduated_block,t.first_block),t.launchpad
 FROM tokens t LEFT JOIN coin_card_latest c ON c.coin=t.address
 LEFT JOIN engine_block_times bt ON bt.number=t.first_block LEFT JOIN chain_blocks cb ON cb.number=t.first_block
 WHERE t.address=a AND t.deployer IS NOT NULL AND (c.coin IS NOT NULL OR t.launchpad='pons')
 AND coalesce((SELECT max(ts) FROM swaps WHERE coin=t.address),bt.ts,cb.ts,(c.data->'identity'->>'createdAt')::timestamptz) IS NOT NULL
 ON CONFLICT(coin) DO UPDATE SET tier=excluded.tier,first_block=excluded.first_block,pair_column=excluded.pair_column,pair_block=excluded.pair_block,launchpad=excluded.launchpad;
 IF NOT EXISTS(SELECT 1 FROM tokens t LEFT JOIN coin_card_latest c ON c.coin=t.address WHERE t.address=a AND t.deployer IS NOT NULL AND (c.coin IS NOT NULL OR t.launchpad='pons')) THEN DELETE FROM read_coins WHERE coin=a; END IF;
 UPDATE read_coins SET buyers=(SELECT count(*) FROM read_buyers WHERE coin=a) WHERE coin=a;
END $$;
-- statement-breakpoint
CREATE FUNCTION read_card_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM refresh_read_coin(coalesce(NEW.coin,OLD.coin)); RETURN NULL;
END $$;
-- statement-breakpoint
CREATE TRIGGER read_card_change AFTER INSERT OR UPDATE OR DELETE ON coin_card_latest FOR EACH ROW EXECUTE FUNCTION read_card_change();
SELECT refresh_read_coin(address) FROM tokens WHERE deployer IS NOT NULL;
INSERT INTO read_buyers SELECT DISTINCT s.coin,s.trader FROM swaps s JOIN tokens t ON t.address=s.coin WHERE s.side=1 AND s.trader IS NOT NULL;
UPDATE read_coins r SET activity=s.ts FROM (SELECT coin,max(ts) AS ts FROM swaps GROUP BY coin) s WHERE s.coin=r.coin;
UPDATE read_coins r SET buyers=b.n FROM (SELECT coin,count(*) AS n FROM read_buyers GROUP BY coin) b WHERE b.coin=r.coin;
UPDATE read_coins r SET volume=b.volume FROM (SELECT coin,sum(volume_usd) AS volume FROM bars_1m WHERE minute>=date_trunc('minute',now())-interval '59 minutes' AND minute<=now() GROUP BY coin) b WHERE b.coin=r.coin;
-- statement-breakpoint
CREATE FUNCTION read_swap_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE added bigint;
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.side=1 AND NEW.trader IS NOT NULL AND EXISTS(SELECT 1 FROM tokens WHERE address=NEW.coin) THEN INSERT INTO read_buyers VALUES(NEW.coin,NEW.trader) ON CONFLICT DO NOTHING; GET DIAGNOSTICS added=ROW_COUNT; ELSE added=0; END IF;
  UPDATE read_coins SET activity=greatest(activity,NEW.ts),buyers=buyers+added WHERE coin=NEW.coin;
 ELSE
  DELETE FROM read_buyers b WHERE b.coin=OLD.coin AND b.trader=OLD.trader AND NOT EXISTS(SELECT 1 FROM swaps s WHERE s.coin=b.coin AND s.trader=b.trader AND s.side=1);
  UPDATE read_coins SET activity=coalesce((SELECT max(ts) FROM swaps WHERE coin=OLD.coin),activity),buyers=(SELECT count(*) FROM read_buyers WHERE coin=OLD.coin) WHERE coin=OLD.coin;
 END IF; RETURN NULL;
END $$;
-- statement-breakpoint
CREATE TRIGGER read_swap_change AFTER INSERT OR DELETE ON swaps FOR EACH ROW EXECUTE FUNCTION read_swap_change();
INSERT INTO read_feed SELECT 'token:'||encode(address,'hex'),address,first_block,'new_pair','{}',NULL FROM tokens WHERE curve IS NOT NULL;
INSERT INTO read_feed SELECT 'pool:'||encode(p.id,'hex')||':'||encode(t.address,'hex'),t.address,p.created_block,'new_pair','{}',NULL FROM pools p JOIN tokens t ON t.address IN(p.currency0,p.currency1) WHERE t.curve IS NULL;
INSERT INTO read_feed SELECT e.id,v.coin,e.block,'verdict',v.data,v.id FROM verdict_events e JOIN verdicts v ON v.id=e.verdict_id WHERE e.kind='created' AND NOT EXISTS(SELECT 1 FROM verdict_events x WHERE x.verdict_id=v.id AND x.kind='orphaned');
INSERT INTO read_feed SELECT 'match:'||encode(coin,'hex')||':'||valid_from_block||':'||rules_version||':'||playbook_id,coin,valid_from_block,CASE WHEN playbook_id='wash_to_trend' THEN 'wash' ELSE 'playbook' END,data,NULL FROM playbook_matches WHERE data->>'level' IN('monitor','danger');
INSERT INTO read_feed SELECT 'graduation:'||encode(address,'hex')||':'||graduated_block,address,graduated_block,'graduation','{}',NULL FROM tokens WHERE graduated_block IS NOT NULL;
INSERT INTO read_first_verdict SELECT coin,min(block) FROM read_feed WHERE kind='verdict' GROUP BY coin;
-- statement-breakpoint
CREATE FUNCTION read_token_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RETURN NULL; END IF;
 IF TG_OP='INSERT' THEN INSERT INTO read_buyers SELECT DISTINCT coin,trader FROM swaps WHERE coin=NEW.address AND side=1 AND trader IS NOT NULL ON CONFLICT DO NOTHING; END IF;
 PERFORM refresh_read_coin(NEW.address);
 UPDATE read_feed SET symbol=NEW.symbol,first_block=NEW.first_block WHERE coin=NEW.address;
 DELETE FROM read_feed WHERE coin=NEW.address AND kind IN('new_pair','graduation');
 IF NEW.curve IS NOT NULL THEN INSERT INTO read_feed VALUES('token:'||encode(NEW.address,'hex'),NEW.address,NEW.first_block,'new_pair','{}',NULL);
 ELSE INSERT INTO read_feed SELECT 'pool:'||encode(id,'hex')||':'||encode(NEW.address,'hex'),NEW.address,created_block,'new_pair','{}',NULL FROM pools WHERE currency0=NEW.address OR currency1=NEW.address; END IF;
 IF NEW.graduated_block IS NOT NULL THEN INSERT INTO read_feed VALUES('graduation:'||encode(NEW.address,'hex')||':'||NEW.graduated_block,NEW.address,NEW.graduated_block,'graduation','{}',NULL); END IF;
 RETURN NULL;
END $$;
-- statement-breakpoint
CREATE TRIGGER read_token_change AFTER INSERT OR UPDATE ON tokens FOR EACH ROW EXECUTE FUNCTION read_token_change();
-- statement-breakpoint
CREATE FUNCTION read_pool_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN DELETE FROM read_feed WHERE id LIKE 'pool:'||encode(OLD.id,'hex')||':%';
 ELSE INSERT INTO read_feed SELECT 'pool:'||encode(NEW.id,'hex')||':'||encode(address,'hex'),address,NEW.created_block,'new_pair','{}',NULL FROM tokens WHERE address IN(NEW.currency0,NEW.currency1) AND curve IS NULL ON CONFLICT DO NOTHING; END IF; RETURN NULL;
END $$;
-- statement-breakpoint
CREATE TRIGGER read_pool_change AFTER INSERT OR DELETE ON pools FOR EACH ROW EXECUTE FUNCTION read_pool_change();
-- statement-breakpoint
CREATE FUNCTION read_verdict_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a bytea;
BEGIN
 SELECT coin INTO a FROM verdicts WHERE id=coalesce(NEW.verdict_id,OLD.verdict_id);
 DELETE FROM read_feed WHERE verdict_id=coalesce(NEW.verdict_id,OLD.verdict_id);
 INSERT INTO read_feed SELECT e.id,v.coin,e.block,'verdict',v.data,v.id FROM verdict_events e JOIN verdicts v ON v.id=e.verdict_id WHERE v.id=coalesce(NEW.verdict_id,OLD.verdict_id) AND e.kind='created' AND NOT EXISTS(SELECT 1 FROM verdict_events x WHERE x.verdict_id=v.id AND x.kind='orphaned');
 DELETE FROM read_first_verdict WHERE coin=a;
 INSERT INTO read_first_verdict SELECT coin,min(block) FROM read_feed WHERE coin=a AND kind='verdict' GROUP BY coin;
 RETURN NULL;
END $$;
-- statement-breakpoint
CREATE TRIGGER read_verdict_change AFTER INSERT OR DELETE ON verdict_events FOR EACH ROW EXECUTE FUNCTION read_verdict_change();
-- statement-breakpoint
CREATE FUNCTION read_match_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE k text;
BEGIN
 k='match:'||encode(coalesce(NEW.coin,OLD.coin),'hex')||':'||coalesce(NEW.valid_from_block,OLD.valid_from_block)||':'||coalesce(NEW.rules_version,OLD.rules_version)||':'||coalesce(NEW.playbook_id,OLD.playbook_id);
 DELETE FROM read_feed WHERE id=k;
 IF TG_OP<>'DELETE' AND NEW.data->>'level' IN('monitor','danger') THEN INSERT INTO read_feed VALUES(k,NEW.coin,NEW.valid_from_block,CASE WHEN NEW.playbook_id='wash_to_trend' THEN 'wash' ELSE 'playbook' END,NEW.data,NULL); END IF; RETURN NULL;
END $$;
-- statement-breakpoint
CREATE TRIGGER read_match_change AFTER INSERT OR UPDATE OR DELETE ON playbook_matches FOR EACH ROW EXECUTE FUNCTION read_match_change();

-- statement-breakpoint
CREATE FUNCTION read_bar_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE read_coins SET volume=(SELECT coalesce(sum(volume_usd),0) FROM bars_1m WHERE coin=coalesce(NEW.coin,OLD.coin) AND minute>=date_trunc('minute',now())-interval '59 minutes' AND minute<=now()) WHERE coin=coalesce(NEW.coin,OLD.coin);
 RETURN NULL;
END $$;
-- statement-breakpoint
CREATE TRIGGER read_bar_change AFTER INSERT OR UPDATE OR DELETE ON bars_1m FOR EACH ROW EXECUTE FUNCTION read_bar_change();

-- statement-breakpoint
-- Each GIN key is at most three Unicode characters (12 UTF-8 bytes).
-- Keep terms from the full name so substring matches beyond a prefix remain discoverable.
-- The full identity and JSON payloads are never B-tree keys or INCLUDE columns.
CREATE FUNCTION read_name_terms(value text) RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
 SELECT ARRAY(SELECT DISTINCT substr(lower(value),i,n) FROM generate_series(1,length(value)) i CROSS JOIN generate_series(1,3) n WHERE i+n-1<=length(value))
$$;
-- statement-breakpoint
CREATE INDEX tokens_name_terms ON tokens USING gin(read_name_terms(name));

CREATE INDEX bars_1m_read_cover ON bars_1m(coin,minute DESC) INCLUDE(close,volume_usd);
-- Bound attacker-controlled text in keys. Raw identity stays in the heap, never in INCLUDE.
CREATE INDEX tokens_symbol_address ON tokens(left(lower(symbol),64),address);

CREATE INDEX bars_1m_read_window ON bars_1m(minute,coin) INCLUDE(volume_usd);
CREATE INDEX read_coins_nonzero_volume ON read_coins(coin) WHERE volume<>0;
CREATE TABLE read_rank_clock(singleton boolean PRIMARY KEY CHECK(singleton),window_sec bigint NOT NULL);
INSERT INTO read_rank_clock VALUES(true,0);
