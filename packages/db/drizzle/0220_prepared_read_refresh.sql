-- Source preparation is read-only and runs before any projection mutex is acquired.
CREATE FUNCTION prepare_read_models(a bytea[],window_sec bigint) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE first_blocks bigint[]; e bytea[]; mark_coins bytea[]; mark_blocks bigint[];
 revisions jsonb; desired jsonb; coins jsonb; identities jsonb; pairs jsonb; missing jsonb; unlisted jsonb;
BEGIN
 SELECT coalesce(array_agg(address),'{}') INTO e FROM tokens WHERE address=ANY(a) AND deployer IS NOT NULL;
 SELECT array_agg(DISTINCT first_block) INTO first_blocks FROM tokens WHERE address=ANY(e);
 SELECT coalesce(jsonb_agg(jsonb_build_object('coin',k.coin,'revision',d.revision::text)),'[]') INTO revisions
 FROM unnest(a) k(coin) LEFT JOIN read_dirty d ON d.coin=k.coin;
 SELECT coalesce(jsonb_agg(to_jsonb(x)||jsonb_build_object('revision',x.revision::text)),'[]') INTO desired FROM (
  SELECT k.*,EXISTS(SELECT 1 FROM swaps s WHERE s.coin=k.coin AND s.trader=k.trader AND s.side=1 AND s.trader IS NOT NULL AND NOT s.senders_pending) AS present,
   EXISTS(SELECT 1 FROM history_prunes p WHERE p.coin=k.coin AND p.swaps_through_block IS NOT NULL) AS pruned
  FROM read_buyer_dirty k WHERE k.coin=ANY(e)
 ) x;
 SELECT coalesce(array_agg(k.coin),'{}'),coalesce(array_agg(x.block),'{}') INTO mark_coins,mark_blocks
 FROM unnest(e) k(coin) CROSS JOIN LATERAL (SELECT block FROM swaps s WHERE s.coin=k.coin ORDER BY s.block DESC LIMIT 1) x;
 WITH selected AS (SELECT t.*,c.data FROM tokens t LEFT JOIN coin_card_latest c ON c.coin=t.address AND c.coin=ANY(e) WHERE t.address=ANY(e)),
 -- Read only selected coins through their existing source indexes.
 activity AS (SELECT k.coin,x.ts,
 EXISTS(SELECT 1 FROM swaps s WHERE s.coin=k.coin AND s.senders_pending AND s.side=1) AS buyers_pending,
 coalesce((SELECT z.ts>to_timestamp(window_sec)-interval '1 day' FROM swaps z WHERE z.coin=k.coin AND z.pricing_pending ORDER BY z.block DESC LIMIT 1),false) AS pricing_pending
 FROM unnest(e) AS k(coin) CROSS JOIN LATERAL (SELECT s.ts FROM swaps s WHERE s.coin=k.coin ORDER BY s.ts DESC LIMIT 1) x),
 traded AS (SELECT t.address AS coin,greatest(s.ts,p.last_trade_ts) AS ts FROM tokens t LEFT JOIN activity s ON s.coin=t.address
 LEFT JOIN history_prunes p ON p.coin=t.address WHERE t.address=ANY(e)),
 buyers AS (SELECT coin,n FROM read_buyer_totals WHERE coin=ANY(e)),
 volume AS (SELECT coin,sum(volume_usd) AS usd FROM bars_1m WHERE coin=ANY(e) AND minute>=to_timestamp(window_sec-3540) AND minute<=to_timestamp(window_sec) GROUP BY coin),
 fresh AS (SELECT t.address AS coin,CASE t.data->'verdict'->>'level' WHEN 'clear' THEN 0 WHEN 'monitor' THEN 1 WHEN 'danger' THEN 3 ELSE 2 END AS tier,
 coalesce(x.ts,bt.ts,cb.ts,(t.data->'identity'->>'createdAt')::timestamptz) AS activity,t.first_block,
 CASE WHEN t.graduated_block IS NOT NULL THEN 'migrated' WHEN coalesce((t.data->'identity'->>'curvePct')::double precision,0)>=75 THEN 'near_grad' ELSE 'new' END AS pair_column,
 coalesce(t.graduated_block,t.first_block) AS pair_block,t.launchpad,coalesce(b.n,0) AS buyers,(coalesce(s.buyers_pending,false) OR EXISTS(SELECT 1 FROM coin_unknown_buys u WHERE u.coin=t.address AND u.n>0)) AS buyers_pending,
 coalesce(s.pricing_pending,false) AS pricing_pending,CASE WHEN s.pricing_pending THEN 0 ELSE coalesce(v.usd,0) END AS volume,
 w.block AS buyers_block
 FROM selected t LEFT JOIN activity s ON s.coin=t.address LEFT JOIN traded x ON x.coin=t.address LEFT JOIN buyers b ON b.coin=t.address LEFT JOIN volume v ON v.coin=t.address
 LEFT JOIN unnest(mark_coins,mark_blocks) AS w(coin,block) ON w.coin=t.address
 LEFT JOIN engine_block_times bt ON bt.number=t.first_block AND bt.number=ANY(first_blocks) LEFT JOIN chain_blocks cb ON cb.number=t.first_block AND cb.number=ANY(first_blocks)
 WHERE t.deployer IS NOT NULL
 AND coalesce(x.ts,bt.ts,cb.ts,(t.data->'identity'->>'createdAt')::timestamptz) IS NOT NULL)
 SELECT coalesce(jsonb_agg(to_jsonb(fresh)),'[]') INTO coins FROM fresh;
 SELECT coalesce(jsonb_agg(jsonb_build_object('coin',address,'first_block',first_block,'symbol',symbol)),'[]') INTO identities FROM tokens WHERE address=ANY(e);
 SELECT coalesce(jsonb_agg(to_jsonb(d)||jsonb_build_object('first_block',t.first_block,'symbol',t.symbol)),'[]') INTO pairs
 FROM read_pair_rows(e) d JOIN tokens t ON t.address=d.coin;
 SELECT coalesce(jsonb_agg(k.coin),'[]') INTO missing FROM unnest(a) k(coin) WHERE NOT EXISTS(SELECT 1 FROM tokens WHERE address=k.coin);
 SELECT coalesce(jsonb_agg(k.coin),'[]') INTO unlisted FROM unnest(a) k(coin) WHERE NOT EXISTS(SELECT 1 FROM tokens WHERE address=k.coin AND deployer IS NOT NULL);
 RETURN jsonb_build_object('revisions',revisions,'buyers',desired,'coins',coins,'identity',identities,'pairs',pairs,'missing',missing,'unlisted',unlisted);
END $$;
-- statement-breakpoint
-- Prepared feed writes already include identity. Other writers keep the original identity trigger behavior.
CREATE OR REPLACE FUNCTION read_feed_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF current_setting('eko.prepared_read_write',true) IS DISTINCT FROM 'on' THEN
  SELECT first_block,symbol INTO NEW.first_block,NEW.symbol FROM tokens WHERE address=NEW.coin;
 END IF;
 RETURN NEW;
END $$;
-- statement-breakpoint
-- Only prepared payloads and compact projection/revision tables are accessed after read_lock_coins.
CREATE FUNCTION refresh_read_models(a bytea[],window_sec bigint,prepared jsonb) RETURNS bytea[] LANGUAGE plpgsql AS $$
DECLARE active bytea[]; missing bytea[]; previous_mode text;
BEGIN
 PERFORM read_lock_coins(a);
 SELECT coalesce(array_agg(k.coin),'{}') INTO active FROM jsonb_to_recordset(prepared->'revisions') k(coin bytea,revision bigint)
 LEFT JOIN read_dirty d ON d.coin=k.coin WHERE k.coin=ANY(a) AND k.revision IS NOT DISTINCT FROM d.revision;
 previous_mode=coalesce(current_setting('eko.prepared_read_write',true),'off');
 PERFORM set_config('eko.prepared_read_write','on',true);
 DELETE FROM read_buyers b USING jsonb_to_recordset(prepared->'buyers') d(coin bytea,trader bytea,revision bigint,present boolean,pruned boolean)
 WHERE b.coin=ANY(active) AND b.coin=d.coin AND b.trader=d.trader AND NOT d.present AND NOT d.pruned;
 INSERT INTO read_buyers(coin,trader) SELECT coin,trader FROM jsonb_to_recordset(prepared->'buyers') d(coin bytea,trader bytea,revision bigint,present boolean,pruned boolean)
 WHERE coin=ANY(active) AND present ORDER BY coin,trader ON CONFLICT DO NOTHING;
 WITH unlocked AS (
  SELECT x.coin,x.trader FROM read_buyer_dirty x JOIN jsonb_to_recordset(prepared->'buyers') d(coin bytea,trader bytea,revision bigint,present boolean,pruned boolean)
   ON x.coin=d.coin AND x.trader=d.trader AND x.revision=d.revision WHERE x.coin=ANY(active) FOR UPDATE OF x SKIP LOCKED
 ) DELETE FROM read_buyer_dirty d USING unlocked u WHERE d.coin=u.coin AND d.trader=u.trader;
 INSERT INTO read_coins(coin,tier,activity,first_block,pair_column,pair_block,launchpad,buyers,buyers_pending,pricing_pending,volume,buyers_block)
 SELECT s.coin,s.tier,s.activity,s.first_block,s.pair_column,s.pair_block,s.launchpad,coalesce(b.n,0),s.buyers_pending,s.pricing_pending,
  CASE WHEN (SELECT c.window_sec FROM read_rank_clock c WHERE singleton)>window_sec THEN coalesce(r.volume,s.volume) ELSE s.volume END,
  coalesce(s.buyers_block,r.buyers_block)
 FROM jsonb_populate_recordset(NULL::read_coins,prepared->'coins') s LEFT JOIN read_buyer_totals b ON b.coin=s.coin LEFT JOIN read_coins r ON r.coin=s.coin
 WHERE s.coin=ANY(active) ORDER BY s.coin
 ON CONFLICT(coin) DO UPDATE SET tier=excluded.tier,activity=excluded.activity,first_block=excluded.first_block,pair_column=excluded.pair_column,
 pair_block=excluded.pair_block,launchpad=excluded.launchpad,buyers=excluded.buyers,buyers_pending=excluded.buyers_pending,
 pricing_pending=excluded.pricing_pending,volume=excluded.volume,buyers_block=excluded.buyers_block
 WHERE (read_coins.tier,read_coins.activity,read_coins.first_block,read_coins.pair_column,read_coins.pair_block,read_coins.launchpad,read_coins.buyers,read_coins.buyers_pending,read_coins.pricing_pending,read_coins.volume,read_coins.buyers_block)
 IS DISTINCT FROM (excluded.tier,excluded.activity,excluded.first_block,excluded.pair_column,excluded.pair_block,excluded.launchpad,excluded.buyers,excluded.buyers_pending,excluded.pricing_pending,excluded.volume,excluded.buyers_block);
 DELETE FROM read_coins WHERE coin=ANY(active) AND coin IN(SELECT value::bytea FROM jsonb_array_elements_text(prepared->'unlisted'));
 UPDATE read_feed f SET symbol=t.symbol,first_block=t.first_block FROM jsonb_to_recordset(prepared->'identity') t(coin bytea,symbol text,first_block bigint)
 WHERE f.coin=ANY(active) AND f.coin=t.coin AND (f.symbol,f.first_block) IS DISTINCT FROM (t.symbol,t.first_block);
 DELETE FROM read_feed f WHERE f.coin=ANY(active) AND f.kind IN('new_pair','graduation') AND NOT EXISTS(
  SELECT 1 FROM jsonb_populate_recordset(NULL::read_feed,prepared->'pairs') d
  WHERE d.id=f.id AND d.coin=f.coin AND d.block=f.block AND d.kind=f.kind AND f.data='{}'::jsonb AND f.verdict_id IS NULL);
 INSERT INTO read_feed(id,coin,block,kind,data,verdict_id,first_block,symbol)
 SELECT d.id,d.coin,d.block,d.kind,'{}',NULL,d.first_block,d.symbol FROM jsonb_populate_recordset(NULL::read_feed,prepared->'pairs') d
 WHERE d.coin=ANY(active) ORDER BY d.coin,d.id
 ON CONFLICT(id) DO UPDATE SET coin=excluded.coin,block=excluded.block,kind=excluded.kind,data=excluded.data,verdict_id=excluded.verdict_id,first_block=excluded.first_block,symbol=excluded.symbol
 WHERE (read_feed.coin,read_feed.block,read_feed.kind,read_feed.data,read_feed.verdict_id,read_feed.first_block,read_feed.symbol)
 IS DISTINCT FROM (excluded.coin,excluded.block,excluded.kind,excluded.data,excluded.verdict_id,excluded.first_block,excluded.symbol);
 SELECT coalesce(array_agg(value::bytea),'{}') INTO missing FROM jsonb_array_elements_text(prepared->'missing') WHERE value::bytea=ANY(active);
 IF cardinality(missing)>0 THEN
  DELETE FROM read_buyers WHERE coin=ANY(missing);
  DELETE FROM read_buyer_dirty WHERE coin=ANY(missing);
  DELETE FROM read_buyer_totals WHERE coin=ANY(missing);
  DELETE FROM read_feed WHERE coin=ANY(missing);
  DELETE FROM read_first_verdict WHERE coin=ANY(missing);
 END IF;
 PERFORM set_config('eko.prepared_read_write',previous_mode,true);
 RETURN active;
END $$;
-- statement-breakpoint
-- Compatibility for tools calling the original entry point. Reads still precede the mutex.
CREATE OR REPLACE FUNCTION refresh_read_models(a bytea[],window_sec bigint) RETURNS void LANGUAGE plpgsql AS $$
DECLARE prepared jsonb;
BEGIN
 prepared=prepare_read_models(a,window_sec);
 PERFORM refresh_read_models(a,window_sec,prepared);
END $$;
