-- Lock each mutex row as it is created, in one global coin order, before any projection write.
-- Tuple locks also support large rank refreshes without one heavyweight advisory lock per coin.
CREATE FUNCTION read_lock_coins(a bytea[]) RETURNS void LANGUAGE plpgsql AS $$
DECLARE c bytea;
BEGIN
 FOR c IN SELECT DISTINCT k FROM unnest(a) k WHERE k IS NOT NULL ORDER BY k LOOP
  INSERT INTO read_projection_locks(coin) VALUES(c) ON CONFLICT DO NOTHING;
  PERFORM coin FROM read_projection_locks WHERE coin=c FOR UPDATE;
 END LOOP;
END $$;
-- statement-breakpoint

-- Unresolved historical buys remain unknown after their raw source ages out
CREATE OR REPLACE FUNCTION refresh_read_models(a bytea[],window_sec bigint) RETURNS void LANGUAGE plpgsql AS $$
DECLARE first_blocks bigint[]; e bytea[]; mark_coins bytea[]; mark_blocks bigint[]; missing bytea[];
BEGIN
 -- Same-coin refreshes serialize. Only coins with a launch wallet are projected.
 PERFORM read_lock_coins(a);
 SELECT coalesce(array_agg(address),'{}') INTO e FROM tokens WHERE address=ANY(a) AND deployer IS NOT NULL;
 SELECT array_agg(DISTINCT first_block) INTO first_blocks FROM tokens WHERE address=ANY(e);
 -- Copy revisions, never lock the indexer's dirty keys. If an indexer changes one during the refresh it survives.
 WITH keys AS MATERIALIZED (SELECT d.* FROM read_buyer_dirty d WHERE d.coin=ANY(e)),
 desired AS MATERIALIZED (SELECT k.*,EXISTS(SELECT 1 FROM swaps s WHERE s.coin=k.coin AND s.trader=k.trader
   AND s.side=1 AND s.trader IS NOT NULL AND NOT s.senders_pending) AS present FROM keys k),
 gone AS (DELETE FROM read_buyers b USING desired d WHERE b.coin=d.coin AND b.trader=d.trader AND NOT d.present
   AND NOT EXISTS(SELECT 1 FROM history_prunes p WHERE p.coin=b.coin AND p.swaps_through_block IS NOT NULL)),
 added AS (INSERT INTO read_buyers SELECT coin,trader FROM desired WHERE present ORDER BY coin,trader ON CONFLICT DO NOTHING),
 unlocked AS (SELECT x.coin,x.trader FROM read_buyer_dirty x JOIN desired d ON x.coin=d.coin AND x.trader=d.trader AND x.revision=d.revision FOR UPDATE OF x SKIP LOCKED)
 DELETE FROM read_buyer_dirty d USING unlocked u WHERE d.coin=u.coin AND d.trader=u.trader;
 SELECT coalesce(array_agg(k.coin),'{}'),coalesce(array_agg(x.block),'{}') INTO mark_coins,mark_blocks
 FROM unnest(e) k(coin) CROSS JOIN LATERAL (SELECT block FROM swaps s WHERE s.coin=k.coin ORDER BY block DESC LIMIT 1) x;
 -- Source probes are indexed and restricted to changed coins.
 WITH selected AS (SELECT t.*,c.data FROM tokens t LEFT JOIN coin_card_latest c ON c.coin=t.address AND c.coin=ANY(e) WHERE t.address=ANY(e)),
 -- The last trade of a coin whose swaps were deleted is kept in history_prunes.
 -- Buyers are pending while a buy still waits for its trader. A buy that moved no coins to any wallet (one hop of a
 -- route inside the pool manager) has none to wait for. Price, volume and the series are pending while a swap of the
 -- last day waits for the coin's decimals; one swap quoted in a token without a USD price no longer hides them.
 -- Read through the coin's indexes: its latest swap, whether a buy still waits for its trader, and whether its newest
 -- swap still waiting for a price is from the last day (a swap's time rises with its block). Aggregated over the
 -- coin's whole history this took 300 to 900 ms for a 71,000-swap coin on a copy of 2026-10-13, on every refresh of a
 -- coin that trades in every block.
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
 AND coalesce(x.ts,bt.ts,cb.ts,(t.data->'identity'->>'createdAt')::timestamptz) IS NOT NULL),
 saved AS (SELECT * FROM fresh)
 INSERT INTO read_coins(coin,tier,activity,first_block,pair_column,pair_block,launchpad,buyers,buyers_pending,pricing_pending,volume,buyers_block)
 SELECT coin,tier,activity,first_block,pair_column,pair_block,launchpad,buyers,buyers_pending,pricing_pending,volume,
 coalesce(buyers_block,(SELECT r.buyers_block FROM read_coins r WHERE r.coin=saved.coin)) FROM saved ORDER BY coin
 ON CONFLICT(coin) DO UPDATE SET tier=excluded.tier,activity=excluded.activity,first_block=excluded.first_block,pair_column=excluded.pair_column,
 pair_block=excluded.pair_block,launchpad=excluded.launchpad,buyers=excluded.buyers,buyers_pending=excluded.buyers_pending,
 pricing_pending=excluded.pricing_pending,volume=excluded.volume,buyers_block=excluded.buyers_block
 WHERE (read_coins.tier,read_coins.activity,read_coins.first_block,read_coins.pair_column,read_coins.pair_block,read_coins.launchpad,read_coins.buyers,read_coins.buyers_pending,read_coins.pricing_pending,read_coins.volume,read_coins.buyers_block)
 IS DISTINCT FROM (excluded.tier,excluded.activity,excluded.first_block,excluded.pair_column,excluded.pair_block,excluded.launchpad,excluded.buyers,excluded.buyers_pending,excluded.pricing_pending,excluded.volume,excluded.buyers_block);
 DELETE FROM read_coins r WHERE r.coin=ANY(a) AND NOT EXISTS(SELECT 1 FROM tokens t WHERE t.address=r.coin AND t.deployer IS NOT NULL);
 -- The read_feed_identity trigger copies symbol and first block from tokens on every write, so only stale rows are updated.
 UPDATE read_feed f SET symbol=t.symbol,first_block=t.first_block FROM tokens t WHERE t.address=ANY(e) AND f.coin=t.address
 AND (f.symbol,f.first_block) IS DISTINCT FROM (t.symbol,t.first_block);
 DELETE FROM read_feed f WHERE f.coin=ANY(e) AND f.kind IN('new_pair','graduation') AND NOT EXISTS(SELECT 1 FROM read_pair_rows(e) d
 WHERE d.id=f.id AND d.coin=f.coin AND d.block=f.block AND d.kind=f.kind AND f.data='{}'::jsonb AND f.verdict_id IS NULL);
 INSERT INTO read_feed(id,coin,block,kind,data,verdict_id) SELECT d.id,d.coin,d.block,d.kind,'{}',NULL FROM read_pair_rows(e) d ORDER BY d.coin,d.id
 ON CONFLICT(id) DO UPDATE SET coin=excluded.coin,block=excluded.block,kind=excluded.kind,data=excluded.data,verdict_id=excluded.verdict_id
 WHERE (read_feed.coin,read_feed.block,read_feed.kind,read_feed.data,read_feed.verdict_id) IS DISTINCT FROM (excluded.coin,excluded.block,excluded.kind,excluded.data,excluded.verdict_id);
 -- Rows of tokens that no longer exist. The token is looked up once per coin: checked row by row, the 36,902 buyers
 -- of one busy coin were 36,902 lookups on every refresh.
 SELECT coalesce(array_agg(c),'{}') INTO missing FROM unnest(a) AS c WHERE NOT EXISTS(SELECT 1 FROM tokens WHERE address=c);
 IF cardinality(missing)>0 THEN
  DELETE FROM read_buyers WHERE coin=ANY(missing);
  DELETE FROM read_buyer_dirty WHERE coin=ANY(missing);
  DELETE FROM read_buyer_totals WHERE coin=ANY(missing);
  DELETE FROM read_feed WHERE coin=ANY(missing);
  DELETE FROM read_first_verdict WHERE coin=ANY(missing);
 END IF;
END $$;

-- statement-breakpoint

CREATE OR REPLACE FUNCTION refresh_read_coin(a bytea) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 PERFORM read_lock_coins(ARRAY[a]);
 INSERT INTO read_coins(coin,tier,activity,first_block,pair_column,pair_block,launchpad)
 SELECT t.address,CASE c.data->'verdict'->>'level' WHEN 'clear' THEN 0 WHEN 'monitor' THEN 1 WHEN 'danger' THEN 3 ELSE 2 END,
 coalesce(greatest((SELECT max(ts) FROM swaps WHERE coin=t.address),(SELECT last_trade_ts FROM history_prunes WHERE coin=t.address)),bt.ts,cb.ts,(c.data->'identity'->>'createdAt')::timestamptz),t.first_block,
 CASE WHEN t.graduated_block IS NOT NULL THEN 'migrated' WHEN coalesce((c.data->'identity'->>'curvePct')::double precision,0)>=75 THEN 'near_grad' ELSE 'new' END,
 coalesce(t.graduated_block,t.first_block),t.launchpad
 FROM tokens t LEFT JOIN coin_card_latest c ON c.coin=t.address
 LEFT JOIN engine_block_times bt ON bt.number=t.first_block LEFT JOIN chain_blocks cb ON cb.number=t.first_block
 WHERE t.address=a AND t.deployer IS NOT NULL
 AND coalesce(greatest((SELECT max(ts) FROM swaps WHERE coin=t.address),(SELECT last_trade_ts FROM history_prunes WHERE coin=t.address)),bt.ts,cb.ts,(c.data->'identity'->>'createdAt')::timestamptz) IS NOT NULL
 ON CONFLICT(coin) DO UPDATE SET tier=excluded.tier,first_block=excluded.first_block,pair_column=excluded.pair_column,pair_block=excluded.pair_block,launchpad=excluded.launchpad
 WHERE (read_coins.tier,read_coins.first_block,read_coins.pair_column,read_coins.pair_block,read_coins.launchpad)
 IS DISTINCT FROM (excluded.tier,excluded.first_block,excluded.pair_column,excluded.pair_block,excluded.launchpad);
 IF NOT EXISTS(SELECT 1 FROM tokens t LEFT JOIN coin_card_latest c ON c.coin=t.address WHERE t.address=a AND t.deployer IS NOT NULL) THEN DELETE FROM read_coins WHERE coin=a; END IF;
 UPDATE read_coins r SET buyers=n.n FROM (SELECT coalesce((SELECT n FROM read_buyer_totals WHERE coin=a),0) AS n) n WHERE r.coin=a AND r.buyers IS DISTINCT FROM n.n;
END $$;

-- statement-breakpoint
-- A pending launch queue avoids rejoining every already-saved launch on every retention batch.
CREATE TABLE trending_snapshot_queue(created_block bigint PRIMARY KEY);
INSERT INTO trending_snapshot_queue SELECT DISTINCT first_block FROM tokens t
 WHERE NOT EXISTS(SELECT 1 FROM trending_snapshots s WHERE s.created_block=t.first_block);
CREATE INDEX IF NOT EXISTS verdicts_grade_seek ON verdicts(coin,valid_from_block,id) WHERE data->>'level' IN ('clear','monitor','danger');
-- statement-breakpoint
CREATE FUNCTION trending_queue_launch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO trending_snapshot_queue VALUES(NEW.first_block) ON CONFLICT DO NOTHING;
 RETURN NULL;
END $$;
-- statement-breakpoint
CREATE TRIGGER trending_queue_launch AFTER INSERT OR UPDATE OF first_block ON tokens FOR EACH ROW EXECUTE FUNCTION trending_queue_launch();
