-- The read-model refresh finds a coin's activity through its indexes, and adds new buyers instead of rebuilding the
-- coin's whole buyer set on every refresh. read_coins keeps the block a coin's buyers are counted through, and a dirty
-- mark says whether the coin's swap history was rewritten
ALTER TABLE read_coins ADD COLUMN IF NOT EXISTS buyers_block bigint
-- statement-breakpoint
ALTER TABLE read_dirty ADD COLUMN IF NOT EXISTS rebuild boolean NOT NULL DEFAULT false
-- statement-breakpoint
-- Only swaps decide a coin's buyers, so only their marks ask for a rebuild: a stored swap above the block the buyers
-- are counted through is added on its own. One at or below it, an updated one or a deleted one rewrites the history
CREATE FUNCTION read_mark_dirty_swaps() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
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
DROP TRIGGER read_swap_insert ON swaps;
DROP TRIGGER read_swap_update ON swaps;
DROP TRIGGER read_swap_delete ON swaps;
CREATE TRIGGER read_swap_insert AFTER INSERT ON swaps REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION read_mark_dirty_swaps();
CREATE TRIGGER read_swap_update AFTER UPDATE ON swaps REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION read_mark_dirty_swaps();
CREATE TRIGGER read_swap_delete AFTER DELETE ON swaps REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION read_mark_dirty_swaps()
-- statement-breakpoint
DROP FUNCTION refresh_read_models(bytea[],bigint)
-- statement-breakpoint
CREATE FUNCTION refresh_read_models(a bytea[],window_sec bigint) RETURNS void LANGUAGE plpgsql AS $$
DECLARE first_blocks bigint[]; e bytea[]; whole bytea[]; mark_coins bytea[]; mark_blocks bigint[]; missing bytea[];
BEGIN
 -- Only a coin with a launch wallet is ever listed. The rest (WETH, USDG, stock tokens, coins not onboarded yet) trade
 -- on every block, so every refresh read their whole history for nothing: WETH's 2.2 million swaps alone took most of a
 -- four-to-eight-second refresh on 2026-10-13, during which card writes waited on the tables it locks.
 SELECT coalesce(array_agg(address),'{}') INTO e FROM tokens WHERE address=ANY(a) AND deployer IS NOT NULL;
 SELECT array_agg(DISTINCT first_block) INTO first_blocks FROM tokens WHERE address=ANY(e);
 -- Buyers. A coin's buyers are rebuilt from its whole history only when that history was rewritten: a swap updated or
 -- deleted, a swap stored at or below the block its buyers are counted through (read_mark_dirty_swaps sets `rebuild`), or
 -- no count yet. Otherwise only the swaps above that block are read (less a minute of blocks for writers that commit
 -- out of order) and their buyers added. Rebuilding on every refresh read 71,000 swaps (0.86 s on a copy of
 -- 2026-10-13) each time a coin that trades in every block was refreshed.
 SELECT coalesce(array_agg(c),'{}') INTO whole FROM unnest(e) AS c
  WHERE NOT EXISTS(SELECT 1 FROM read_coins r WHERE r.coin=c AND r.buyers_block IS NOT NULL) OR EXISTS(SELECT 1 FROM read_dirty d WHERE d.coin=c AND d.rebuild);
 -- Rebuild: delete pairs whose buys are gone, insert new pairs. Existing pairs are left alone (DO NOTHING writes no row).
 -- A coin whose swaps retention deleted keeps its buyers: they cover its whole life, not only the retained swaps.
 -- The block counted through is read in the same statement, so it is the history these buyers were taken from.
 WITH desired AS MATERIALIZED (SELECT DISTINCT s.coin,s.trader FROM swaps s JOIN tokens t ON t.address=s.coin
  WHERE s.coin=ANY(whole) AND s.side=1 AND s.trader IS NOT NULL AND NOT s.senders_pending),
 gone AS (DELETE FROM read_buyers b WHERE b.coin=ANY(whole) AND NOT EXISTS(SELECT 1 FROM desired d WHERE d.coin=b.coin AND d.trader=b.trader)
  AND NOT EXISTS(SELECT 1 FROM history_prunes p WHERE p.coin=b.coin AND p.swaps_through_block IS NOT NULL)),
 added AS (INSERT INTO read_buyers SELECT coin,trader FROM desired ON CONFLICT DO NOTHING)
 SELECT coalesce(array_agg(k.coin),'{}'),coalesce(array_agg(x.block),'{}') INTO mark_coins,mark_blocks
  FROM unnest(whole) AS k(coin) CROSS JOIN LATERAL (SELECT s.block FROM swaps s WHERE s.coin=k.coin ORDER BY s.block DESC LIMIT 1) x;
 -- Added to: the swaps above the block counted through.
 WITH recent AS MATERIALIZED (SELECT s.coin,s.trader,s.block,s.side,s.senders_pending FROM read_coins r JOIN swaps s ON s.coin=r.coin AND s.block>r.buyers_block-600
  WHERE r.coin=ANY(e) AND NOT r.coin=ANY(whole)),
 added AS (INSERT INTO read_buyers SELECT DISTINCT coin,trader FROM recent WHERE side=1 AND trader IS NOT NULL AND NOT senders_pending ON CONFLICT DO NOTHING)
 SELECT mark_coins||coalesce(array_agg(m.coin),'{}'),mark_blocks||coalesce(array_agg(m.block),'{}') INTO mark_coins,mark_blocks
  FROM (SELECT coin,max(block) AS block FROM recent GROUP BY coin) m;
 -- All source scans are bounded to the changed coins. No per-swap writes to read projections.
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
 buyers AS (SELECT coin,count(*) AS n FROM read_buyers WHERE coin=ANY(e) GROUP BY coin),
 volume AS (SELECT coin,sum(volume_usd) AS usd FROM bars_1m WHERE coin=ANY(e) AND minute>=to_timestamp(window_sec-3540) AND minute<=to_timestamp(window_sec) GROUP BY coin),
 fresh AS (SELECT t.address AS coin,CASE t.data->'verdict'->>'level' WHEN 'clear' THEN 0 WHEN 'monitor' THEN 1 WHEN 'danger' THEN 3 ELSE 2 END AS tier,
 coalesce(x.ts,bt.ts,cb.ts,(t.data->'identity'->>'createdAt')::timestamptz) AS activity,t.first_block,
 CASE WHEN t.graduated_block IS NOT NULL THEN 'migrated' WHEN coalesce((t.data->'identity'->>'curvePct')::double precision,0)>=75 THEN 'near_grad' ELSE 'new' END AS pair_column,
 coalesce(t.graduated_block,t.first_block) AS pair_block,t.launchpad,coalesce(b.n,0) AS buyers,coalesce(s.buyers_pending,false) AS buyers_pending,
 coalesce(s.pricing_pending,false) AS pricing_pending,CASE WHEN s.pricing_pending THEN 0 ELSE coalesce(v.usd,0) END AS volume,
 -- A rebuilt coin is counted through its newest swap (or keeps its mark when none is left: retention deleted them, and
 -- a mark that is too high only costs a rebuild). A coin added to keeps the higher of its mark and the newest swap read.
 CASE WHEN t.address=ANY(whole) THEN coalesce(w.block,(SELECT r.buyers_block FROM read_coins r WHERE r.coin=t.address))
  ELSE greatest(w.block,(SELECT r.buyers_block FROM read_coins r WHERE r.coin=t.address)) END AS buyers_block
 FROM selected t LEFT JOIN activity s ON s.coin=t.address LEFT JOIN traded x ON x.coin=t.address LEFT JOIN buyers b ON b.coin=t.address LEFT JOIN volume v ON v.coin=t.address
 LEFT JOIN unnest(mark_coins,mark_blocks) AS w(coin,block) ON w.coin=t.address
 LEFT JOIN engine_block_times bt ON bt.number=t.first_block AND bt.number=ANY(first_blocks) LEFT JOIN chain_blocks cb ON cb.number=t.first_block AND cb.number=ANY(first_blocks)
 WHERE t.deployer IS NOT NULL
 AND coalesce(x.ts,bt.ts,cb.ts,(t.data->'identity'->>'createdAt')::timestamptz) IS NOT NULL),
 changed AS (UPDATE read_coins r SET tier=f.tier,activity=f.activity,first_block=f.first_block,pair_column=f.pair_column,pair_block=f.pair_block,launchpad=f.launchpad,
 buyers=f.buyers,buyers_pending=f.buyers_pending,pricing_pending=f.pricing_pending,volume=f.volume,buyers_block=f.buyers_block FROM fresh f WHERE r.coin=f.coin
 AND (r.tier,r.activity,r.first_block,r.pair_column,r.pair_block,r.launchpad,r.buyers,r.buyers_pending,r.pricing_pending,r.volume,r.buyers_block)
 IS DISTINCT FROM (f.tier,f.activity,f.first_block,f.pair_column,f.pair_block,f.launchpad,f.buyers,f.buyers_pending,f.pricing_pending,f.volume,f.buyers_block))
 -- Callers hold read_coins in SHARE ROW EXCLUSIVE mode, so no other writer inserts a coin between these two writes.
 INSERT INTO read_coins(coin,tier,activity,first_block,pair_column,pair_block,launchpad,buyers,buyers_pending,pricing_pending,volume,buyers_block)
 SELECT f.coin,f.tier,f.activity,f.first_block,f.pair_column,f.pair_block,f.launchpad,f.buyers,f.buyers_pending,f.pricing_pending,f.volume,f.buyers_block
 FROM fresh f WHERE NOT EXISTS(SELECT 1 FROM read_coins r WHERE r.coin=f.coin) ON CONFLICT(coin) DO NOTHING;
 DELETE FROM read_coins r WHERE r.coin=ANY(a) AND NOT EXISTS(SELECT 1 FROM tokens t WHERE t.address=r.coin AND t.deployer IS NOT NULL);
 -- The read_feed_identity trigger copies symbol and first block from tokens on every write, so only stale rows are updated.
 UPDATE read_feed f SET symbol=t.symbol,first_block=t.first_block FROM tokens t WHERE t.address=ANY(e) AND f.coin=t.address
 AND (f.symbol,f.first_block) IS DISTINCT FROM (t.symbol,t.first_block);
 DELETE FROM read_feed f WHERE f.coin=ANY(e) AND f.kind IN('new_pair','graduation') AND NOT EXISTS(SELECT 1 FROM read_pair_rows(e) d
 WHERE d.id=f.id AND d.coin=f.coin AND d.block=f.block AND d.kind=f.kind AND f.data='{}'::jsonb AND f.verdict_id IS NULL);
 INSERT INTO read_feed(id,coin,block,kind,data,verdict_id) SELECT d.id,d.coin,d.block,d.kind,'{}',NULL FROM read_pair_rows(e) d
 WHERE NOT EXISTS(SELECT 1 FROM read_feed f WHERE f.id=d.id);
 -- Rows of tokens that no longer exist. The token is looked up once per coin: checked row by row, the 36,902 buyers
 -- of one busy coin were 36,902 lookups on every refresh.
 SELECT coalesce(array_agg(c),'{}') INTO missing FROM unnest(a) AS c WHERE NOT EXISTS(SELECT 1 FROM tokens WHERE address=c);
 IF cardinality(missing)>0 THEN
  DELETE FROM read_buyers WHERE coin=ANY(missing);
  DELETE FROM read_feed WHERE coin=ANY(missing);
  DELETE FROM read_first_verdict WHERE coin=ANY(missing);
 END IF;
END $$;
