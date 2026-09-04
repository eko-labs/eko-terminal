CREATE INDEX IF NOT EXISTS read_coins_volume_rank ON read_coins((-volume),coin) INCLUDE(tier,activity);
CREATE INDEX IF NOT EXISTS flow_events_feed_cursor ON flow_events(model_version,block DESC,id DESC) WHERE data->>'label' IN ('declared_agent','likely_agent','crew');
CREATE TABLE read_projection_locks(coin bytea PRIMARY KEY);
CREATE TABLE read_buyer_dirty(coin bytea NOT NULL,trader bytea NOT NULL,revision bigserial NOT NULL,PRIMARY KEY(coin,trader));
CREATE TABLE read_buyer_totals(coin bytea PRIMARY KEY,n bigint NOT NULL);
-- Freeze source and projection writes before seeding counts and dirty keys.
LOCK TABLE swaps,read_buyers IN SHARE ROW EXCLUSIVE MODE;
INSERT INTO read_buyer_totals SELECT coin,count(*) FROM read_buyers GROUP BY coin;
-- One-time upgrade reconciliation, outside the request path. Block source writes until the new trigger is installed.
-- Queue only differences, so the first live refresh does not revisit an already projected coin's entire buyer set.
WITH desired AS MATERIALIZED (SELECT DISTINCT coin,trader FROM swaps WHERE side=1 AND trader IS NOT NULL AND NOT senders_pending)
INSERT INTO read_buyer_dirty(coin,trader)
SELECT d.coin,d.trader FROM desired d WHERE NOT EXISTS(SELECT 1 FROM read_buyers b WHERE b.coin=d.coin AND b.trader=d.trader)
UNION SELECT b.coin,b.trader FROM read_buyers b WHERE NOT EXISTS(SELECT 1 FROM desired d WHERE d.coin=b.coin AND d.trader=b.trader)
 AND NOT EXISTS(SELECT 1 FROM history_prunes p WHERE p.coin=b.coin AND p.swaps_through_block IS NOT NULL);
-- statement-breakpoint
CREATE FUNCTION read_count_buyers() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='TRUNCATE' THEN
  DELETE FROM read_buyer_totals;
 ELSIF TG_OP='INSERT' THEN
  INSERT INTO read_buyer_totals SELECT coin,count(*) FROM new_rows GROUP BY coin ORDER BY coin
  ON CONFLICT(coin) DO UPDATE SET n=read_buyer_totals.n+excluded.n;
 ELSE
  INSERT INTO read_buyer_totals SELECT coin,-count(*) FROM old_rows GROUP BY coin ORDER BY coin
  ON CONFLICT(coin) DO UPDATE SET n=read_buyer_totals.n+excluded.n;
 END IF;
 RETURN NULL;
END $$;
-- statement-breakpoint
CREATE TRIGGER read_count_buyers_truncate AFTER TRUNCATE ON read_buyers FOR EACH STATEMENT EXECUTE FUNCTION read_count_buyers();
CREATE TRIGGER read_count_buyers_insert AFTER INSERT ON read_buyers REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION read_count_buyers();
CREATE TRIGGER read_count_buyers_delete AFTER DELETE ON read_buyers REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION read_count_buyers();
-- statement-breakpoint
-- Enrichment, backfills and reorgs invalidate only the buyer keys they actually changed.
CREATE OR REPLACE FUNCTION read_mark_dirty_swaps() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source text;
BEGIN
 source=CASE TG_OP WHEN 'INSERT' THEN 'SELECT coin,trader FROM new_rows WHERE side=1 AND trader IS NOT NULL AND NOT senders_pending'
 WHEN 'DELETE' THEN 'SELECT coin,trader FROM old_rows WHERE side=1 AND trader IS NOT NULL AND NOT senders_pending'
 ELSE 'SELECT coin,trader FROM new_rows WHERE side=1 AND trader IS NOT NULL AND NOT senders_pending UNION SELECT coin,trader FROM old_rows WHERE side=1 AND trader IS NOT NULL AND NOT senders_pending' END;
 EXECUTE 'INSERT INTO read_buyer_dirty(coin,trader) SELECT DISTINCT coin,trader FROM ('||source||') k ORDER BY coin,trader ON CONFLICT(coin,trader) DO UPDATE SET revision=excluded.revision';
 IF TG_OP='INSERT' THEN
  INSERT INTO read_dirty(coin,rebuild) SELECT n.coin,coalesce(bool_or(n.block<=r.buyers_block),false) FROM new_rows n LEFT JOIN read_coins r ON r.coin=n.coin GROUP BY n.coin
  ON CONFLICT(coin) DO UPDATE SET revision=excluded.revision,rebuild=read_dirty.rebuild OR excluded.rebuild;
 ELSIF TG_OP='DELETE' THEN
  INSERT INTO read_dirty(coin,rebuild) SELECT DISTINCT coin,true FROM old_rows
  ON CONFLICT(coin) DO UPDATE SET revision=excluded.revision,rebuild=true;
 ELSE
  INSERT INTO read_dirty(coin,rebuild) SELECT coin,true FROM new_rows UNION SELECT coin,true FROM old_rows
  ON CONFLICT(coin) DO UPDATE SET revision=excluded.revision,rebuild=true;
 END IF;
 RETURN NULL;
END $$;
-- statement-breakpoint
CREATE OR REPLACE FUNCTION refresh_read_models(a bytea[],window_sec bigint) RETURNS void LANGUAGE plpgsql AS $$
DECLARE first_blocks bigint[]; e bytea[]; mark_coins bytea[]; mark_blocks bigint[]; missing bytea[];
BEGIN
 -- Same-coin refreshes serialize. Only coins with a launch wallet are projected.
 INSERT INTO read_projection_locks SELECT DISTINCT c FROM unnest(a) c ORDER BY c ON CONFLICT DO NOTHING;
 PERFORM coin FROM read_projection_locks WHERE coin=ANY(a) ORDER BY coin FOR UPDATE;
 SELECT coalesce(array_agg(address),'{}') INTO e FROM tokens WHERE address=ANY(a) AND deployer IS NOT NULL;
 SELECT array_agg(DISTINCT first_block) INTO first_blocks FROM tokens WHERE address=ANY(e);
 -- Copy revisions, never lock the indexer's dirty keys. If an indexer changes one during the refresh it survives.
 WITH keys AS MATERIALIZED (SELECT d.* FROM read_buyer_dirty d WHERE d.coin=ANY(e)),
 desired AS MATERIALIZED (SELECT k.*,EXISTS(SELECT 1 FROM swaps s WHERE s.coin=k.coin AND s.trader=k.trader
   AND s.side=1 AND s.trader IS NOT NULL AND NOT s.senders_pending) AS present FROM keys k),
 gone AS (DELETE FROM read_buyers b USING desired d WHERE b.coin=d.coin AND b.trader=d.trader AND NOT d.present
   AND NOT EXISTS(SELECT 1 FROM history_prunes p WHERE p.coin=b.coin AND p.swaps_through_block IS NOT NULL)),
 added AS (INSERT INTO read_buyers SELECT coin,trader FROM desired WHERE present ON CONFLICT DO NOTHING),
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
 coalesce(t.graduated_block,t.first_block) AS pair_block,t.launchpad,coalesce(b.n,0) AS buyers,coalesce(s.buyers_pending,false) AS buyers_pending,
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
 coalesce(buyers_block,(SELECT r.buyers_block FROM read_coins r WHERE r.coin=saved.coin)) FROM saved
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
 INSERT INTO read_feed(id,coin,block,kind,data,verdict_id) SELECT d.id,d.coin,d.block,d.kind,'{}',NULL FROM read_pair_rows(e) d
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
 INSERT INTO read_projection_locks VALUES(a) ON CONFLICT DO NOTHING;
 PERFORM coin FROM read_projection_locks WHERE coin=a FOR UPDATE;
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
-- Pool reads use exact numeric sums maintained from transition rows, plus the existing retained lifetime baseline.
-- Zero-count keys are ignored by readers, preserving absence after reorgs and deletions.
CREATE TABLE read_pool_positions(pool_id bytea NOT NULL,kind text NOT NULL,lower_tick text NOT NULL,upper_tick text NOT NULL,
 liquidity numeric NOT NULL,n bigint NOT NULL,n_amount bigint NOT NULL,PRIMARY KEY(pool_id,kind,lower_tick,upper_tick));
LOCK TABLE liquidity_events IN SHARE ROW EXCLUSIVE MODE;
INSERT INTO read_pool_positions
SELECT pool_id,kind,coalesce(data->>'tickLower',''),coalesce(data->>'tickUpper',''),coalesce(sum(amount),0),count(*),count(amount)
FROM (SELECT e.*,CASE WHEN kind='Mint' THEN (data->>'amount')::numeric WHEN kind='Burn' THEN -(data->>'amount')::numeric ELSE (data->>'liquidityDelta')::numeric END AS amount
 FROM liquidity_events e WHERE kind IN ('Mint','Burn','ModifyLiquidity') AND data ? 'tickLower' AND data ? 'tickUpper') positions
GROUP BY pool_id,kind,coalesce(data->>'tickLower',''),coalesce(data->>'tickUpper','');
-- statement-breakpoint
CREATE FUNCTION read_pool_position_delta() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source text;
BEGIN
 IF TG_OP='TRUNCATE' THEN DELETE FROM read_pool_positions; RETURN NULL; END IF;
 source=CASE TG_OP WHEN 'INSERT' THEN 'SELECT *,1 AS delta FROM new_rows' WHEN 'DELETE' THEN 'SELECT *,-1 AS delta FROM old_rows'
 ELSE 'SELECT *,1 AS delta FROM new_rows UNION ALL SELECT *,-1 AS delta FROM old_rows' END;
 EXECUTE 'INSERT INTO read_pool_positions
 SELECT pool_id,kind,coalesce(data->>''tickLower'',''''),coalesce(data->>''tickUpper'',''''),coalesce(sum(delta*amount),0),sum(delta),coalesce(sum(delta) FILTER(WHERE amount IS NOT NULL),0)
 FROM (SELECT e.*,CASE WHEN kind=''Mint'' THEN (data->>''amount'')::numeric WHEN kind=''Burn'' THEN -(data->>''amount'')::numeric ELSE (data->>''liquidityDelta'')::numeric END AS amount
 FROM ('||source||') e WHERE kind IN (''Mint'',''Burn'',''ModifyLiquidity'') AND data ? ''tickLower'' AND data ? ''tickUpper'') positions
 GROUP BY pool_id,kind,coalesce(data->>''tickLower'',''''),coalesce(data->>''tickUpper'','''') ORDER BY pool_id,kind,coalesce(data->>''tickLower'',''''),coalesce(data->>''tickUpper'','''')
 ON CONFLICT(pool_id,kind,lower_tick,upper_tick) DO UPDATE SET liquidity=read_pool_positions.liquidity+excluded.liquidity,n=read_pool_positions.n+excluded.n,n_amount=read_pool_positions.n_amount+excluded.n_amount';
 RETURN NULL;
END $$;
-- statement-breakpoint
CREATE TRIGGER read_pool_position_insert AFTER INSERT ON liquidity_events REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION read_pool_position_delta();
CREATE TRIGGER read_pool_position_update AFTER UPDATE ON liquidity_events REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION read_pool_position_delta();
CREATE TRIGGER read_pool_position_delete AFTER DELETE ON liquidity_events REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION read_pool_position_delta();
CREATE TRIGGER read_pool_position_truncate AFTER TRUNCATE ON liquidity_events FOR EACH STATEMENT EXECUTE FUNCTION read_pool_position_delta();
