-- Read-model refreshes write only what changed. refresh_read_models (0114) deleted and reinserted every buyer and every
-- new-pair and graduation row of each refreshed coin, and rewrote all of its Feed rows and its read_coins row, so every
-- trade left dead rows behind (read_feed reached 30.8M dead rows for 89k live ones). Results are unchanged: each
-- statement computes the same target rows as before and touches only rows that differ.
--
-- Per-coin history retention (packages/db/src/retention.ts) keeps one summary row per pruned coin. Transfers at or
-- below through_block are compacted into transfer_baselines and the coin's liquidity and Pons events there are deleted
-- (removal events by the coin's deployer stay, other launches' prior-removal checks read them). swaps_through_block is
-- set once its swaps at or below it are deleted. The trade times and buyer count summarise the deleted swaps.
CREATE TABLE history_prunes (
 coin bytea PRIMARY KEY, rule text NOT NULL CHECK(rule IN ('danger_quiet','quiet_coin')), through_block bigint NOT NULL,
 swaps_through_block bigint, first_trade_ts timestamptz, last_trade_ts timestamptz, buyers bigint NOT NULL DEFAULT 0,
 transfers bigint NOT NULL DEFAULT 0, swaps bigint NOT NULL DEFAULT 0, liquidity bigint NOT NULL DEFAULT 0, pons bigint NOT NULL DEFAULT 0,
 updated_at timestamptz NOT NULL DEFAULT now()
)
-- statement-breakpoint
-- The hourly volume leaders before a launch block (clone_swarm's trending input), saved before the swaps they are read
-- from can be deleted. Engines read a saved list instead of recomputing it.
CREATE TABLE trending_snapshots (created_block bigint PRIMARY KEY, data jsonb NOT NULL)
-- statement-breakpoint
DROP FUNCTION refresh_read_models(bytea[],bigint)
-- statement-breakpoint
-- New-pair and graduation rows a coin should have, as 0114 inserted them.
CREATE FUNCTION read_pair_rows(a bytea[]) RETURNS TABLE(id text,coin bytea,block bigint,kind text) LANGUAGE sql STABLE AS $$
 SELECT 'token:'||encode(address,'hex'),address,first_block,'new_pair' FROM tokens WHERE address=ANY(a) AND curve IS NOT NULL
 UNION ALL SELECT 'pool:'||encode(p.id,'hex')||':'||encode(t.address,'hex'),t.address,p.created_block,'new_pair' FROM pools p JOIN tokens t ON t.address IN(p.currency0,p.currency1) WHERE t.address=ANY(a) AND t.curve IS NULL
 UNION ALL SELECT 'graduation:'||encode(address,'hex')||':'||graduated_block,address,graduated_block,'graduation' FROM tokens WHERE address=ANY(a) AND graduated_block IS NOT NULL
$$;
-- statement-breakpoint
CREATE FUNCTION refresh_read_models(a bytea[],window_sec bigint) RETURNS void LANGUAGE plpgsql AS $$
DECLARE first_blocks bigint[];
BEGIN
 SELECT array_agg(DISTINCT first_block) INTO first_blocks FROM tokens WHERE address=ANY(a);
 -- Buyers: delete pairs whose buys are gone, insert new pairs. Existing pairs are left alone (DO NOTHING writes no row).
 -- A coin whose swaps retention deleted keeps its buyers: they cover its whole life, not only the retained swaps.
 WITH desired AS MATERIALIZED (SELECT DISTINCT s.coin,s.trader FROM swaps s JOIN tokens t ON t.address=s.coin
  WHERE s.coin=ANY(a) AND s.side=1 AND s.trader IS NOT NULL AND NOT s.senders_pending),
 gone AS (DELETE FROM read_buyers b WHERE b.coin=ANY(a) AND NOT EXISTS(SELECT 1 FROM desired d WHERE d.coin=b.coin AND d.trader=b.trader)
  AND NOT EXISTS(SELECT 1 FROM history_prunes p WHERE p.coin=b.coin AND p.swaps_through_block IS NOT NULL))
 INSERT INTO read_buyers SELECT coin,trader FROM desired ON CONFLICT DO NOTHING;
 -- All source scans are bounded to the changed coins. No per-swap writes to read projections.
 WITH selected AS (SELECT t.*,c.data FROM tokens t LEFT JOIN coin_card_latest c ON c.coin=t.address AND c.coin=ANY(a) WHERE t.address=ANY(a)),
 -- The last trade of a coin whose swaps were deleted is kept in history_prunes.
 activity AS (SELECT coin,max(ts) AS ts,bool_or(side=1 AND (senders_pending OR trader IS NULL)) AS buyers_pending,
 bool_or(pricing_pending OR price_quote IS NULL OR usd IS NULL) AS pricing_pending FROM swaps WHERE coin=ANY(a) GROUP BY coin),
 traded AS (SELECT t.address AS coin,greatest(s.ts,p.last_trade_ts) AS ts FROM tokens t LEFT JOIN activity s ON s.coin=t.address
 LEFT JOIN history_prunes p ON p.coin=t.address WHERE t.address=ANY(a)),
 buyers AS (SELECT coin,count(*) AS n FROM read_buyers WHERE coin=ANY(a) GROUP BY coin),
 volume AS (SELECT coin,sum(volume_usd) AS usd FROM bars_1m WHERE coin=ANY(a) AND minute>=to_timestamp(window_sec-3540) AND minute<=to_timestamp(window_sec) GROUP BY coin),
 fresh AS (SELECT t.address AS coin,CASE t.data->'verdict'->>'level' WHEN 'clear' THEN 0 WHEN 'monitor' THEN 1 WHEN 'danger' THEN 3 ELSE 2 END AS tier,
 coalesce(x.ts,bt.ts,cb.ts,(t.data->'identity'->>'createdAt')::timestamptz) AS activity,t.first_block,
 CASE WHEN t.graduated_block IS NOT NULL THEN 'migrated' WHEN coalesce((t.data->'identity'->>'curvePct')::double precision,0)>=75 THEN 'near_grad' ELSE 'new' END AS pair_column,
 coalesce(t.graduated_block,t.first_block) AS pair_block,t.launchpad,coalesce(b.n,0) AS buyers,coalesce(s.buyers_pending,false) AS buyers_pending,
 coalesce(s.pricing_pending,false) AS pricing_pending,CASE WHEN s.pricing_pending THEN 0 ELSE coalesce(v.usd,0) END AS volume
 FROM selected t LEFT JOIN activity s ON s.coin=t.address LEFT JOIN traded x ON x.coin=t.address LEFT JOIN buyers b ON b.coin=t.address LEFT JOIN volume v ON v.coin=t.address
 LEFT JOIN engine_block_times bt ON bt.number=t.first_block AND bt.number=ANY(first_blocks) LEFT JOIN chain_blocks cb ON cb.number=t.first_block AND cb.number=ANY(first_blocks)
 WHERE t.deployer IS NOT NULL AND (t.data IS NOT NULL OR t.launchpad='pons')
 AND coalesce(x.ts,bt.ts,cb.ts,(t.data->'identity'->>'createdAt')::timestamptz) IS NOT NULL),
 changed AS (UPDATE read_coins r SET tier=f.tier,activity=f.activity,first_block=f.first_block,pair_column=f.pair_column,pair_block=f.pair_block,launchpad=f.launchpad,
 buyers=f.buyers,buyers_pending=f.buyers_pending,pricing_pending=f.pricing_pending,volume=f.volume FROM fresh f WHERE r.coin=f.coin
 AND (r.tier,r.activity,r.first_block,r.pair_column,r.pair_block,r.launchpad,r.buyers,r.buyers_pending,r.pricing_pending,r.volume)
 IS DISTINCT FROM (f.tier,f.activity,f.first_block,f.pair_column,f.pair_block,f.launchpad,f.buyers,f.buyers_pending,f.pricing_pending,f.volume))
 -- Callers hold read_coins in SHARE ROW EXCLUSIVE mode, so no other writer inserts a coin between these two writes.
 INSERT INTO read_coins(coin,tier,activity,first_block,pair_column,pair_block,launchpad,buyers,buyers_pending,pricing_pending,volume)
 SELECT f.coin,f.tier,f.activity,f.first_block,f.pair_column,f.pair_block,f.launchpad,f.buyers,f.buyers_pending,f.pricing_pending,f.volume
 FROM fresh f WHERE NOT EXISTS(SELECT 1 FROM read_coins r WHERE r.coin=f.coin) ON CONFLICT(coin) DO NOTHING;
 DELETE FROM read_coins r WHERE r.coin=ANY(a) AND NOT EXISTS(SELECT 1 FROM tokens t LEFT JOIN coin_card_latest c ON c.coin=t.address WHERE t.address=r.coin AND t.deployer IS NOT NULL AND (c.coin IS NOT NULL OR t.launchpad='pons'));
 -- The read_feed_identity trigger copies symbol and first block from tokens on every write, so only stale rows are updated.
 UPDATE read_feed f SET symbol=t.symbol,first_block=t.first_block FROM tokens t WHERE t.address=ANY(a) AND f.coin=t.address
 AND (f.symbol,f.first_block) IS DISTINCT FROM (t.symbol,t.first_block);
 DELETE FROM read_feed f WHERE f.coin=ANY(a) AND f.kind IN('new_pair','graduation') AND NOT EXISTS(SELECT 1 FROM read_pair_rows(a) d
 WHERE d.id=f.id AND d.coin=f.coin AND d.block=f.block AND d.kind=f.kind AND f.data='{}'::jsonb AND f.verdict_id IS NULL);
 INSERT INTO read_feed(id,coin,block,kind,data,verdict_id) SELECT d.id,d.coin,d.block,d.kind,'{}',NULL FROM read_pair_rows(a) d
 WHERE NOT EXISTS(SELECT 1 FROM read_feed f WHERE f.id=d.id);
 DELETE FROM read_buyers WHERE coin=ANY(a) AND NOT EXISTS(SELECT 1 FROM tokens WHERE address=coin);
 DELETE FROM read_feed WHERE coin=ANY(a) AND NOT EXISTS(SELECT 1 FROM tokens WHERE address=coin);
 DELETE FROM read_first_verdict WHERE coin=ANY(a) AND NOT EXISTS(SELECT 1 FROM tokens WHERE address=coin);
END $$;
-- statement-breakpoint
DROP FUNCTION refresh_read_coin(bytea)
-- statement-breakpoint
-- The card-change trigger's single-coin refresh (0113), with the same change checks and the kept last trade time.
CREATE FUNCTION refresh_read_coin(a bytea) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO read_coins(coin,tier,activity,first_block,pair_column,pair_block,launchpad)
 SELECT t.address,CASE c.data->'verdict'->>'level' WHEN 'clear' THEN 0 WHEN 'monitor' THEN 1 WHEN 'danger' THEN 3 ELSE 2 END,
 coalesce(greatest((SELECT max(ts) FROM swaps WHERE coin=t.address),(SELECT last_trade_ts FROM history_prunes WHERE coin=t.address)),bt.ts,cb.ts,(c.data->'identity'->>'createdAt')::timestamptz),t.first_block,
 CASE WHEN t.graduated_block IS NOT NULL THEN 'migrated' WHEN coalesce((c.data->'identity'->>'curvePct')::double precision,0)>=75 THEN 'near_grad' ELSE 'new' END,
 coalesce(t.graduated_block,t.first_block),t.launchpad
 FROM tokens t LEFT JOIN coin_card_latest c ON c.coin=t.address
 LEFT JOIN engine_block_times bt ON bt.number=t.first_block LEFT JOIN chain_blocks cb ON cb.number=t.first_block
 WHERE t.address=a AND t.deployer IS NOT NULL AND (c.coin IS NOT NULL OR t.launchpad='pons')
 AND coalesce(greatest((SELECT max(ts) FROM swaps WHERE coin=t.address),(SELECT last_trade_ts FROM history_prunes WHERE coin=t.address)),bt.ts,cb.ts,(c.data->'identity'->>'createdAt')::timestamptz) IS NOT NULL
 ON CONFLICT(coin) DO UPDATE SET tier=excluded.tier,first_block=excluded.first_block,pair_column=excluded.pair_column,pair_block=excluded.pair_block,launchpad=excluded.launchpad
 WHERE (read_coins.tier,read_coins.first_block,read_coins.pair_column,read_coins.pair_block,read_coins.launchpad)
 IS DISTINCT FROM (excluded.tier,excluded.first_block,excluded.pair_column,excluded.pair_block,excluded.launchpad);
 IF NOT EXISTS(SELECT 1 FROM tokens t LEFT JOIN coin_card_latest c ON c.coin=t.address WHERE t.address=a AND t.deployer IS NOT NULL AND (c.coin IS NOT NULL OR t.launchpad='pons')) THEN DELETE FROM read_coins WHERE coin=a; END IF;
 UPDATE read_coins r SET buyers=n.n FROM (SELECT count(*) AS n FROM read_buyers WHERE coin=a) n WHERE r.coin=a AND r.buyers IS DISTINCT FROM n.n;
END $$;
