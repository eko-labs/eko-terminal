-- One-off backfill for migration 0203 (rating checks and prices). Safe to rerun: every statement is an upsert.
-- Run by hand on production after the migration's tables exist, with no table lock, for example
--   psql -v ON_ERROR_STOP=1 -c 'SET statement_timeout=0' -f scripts/backfill-rating-checks.sql
-- The first statement reads the whole swaps table once (sequential), so run it when the box is otherwise quiet.
INSERT INTO coin_rating_prices(coin,price,peak,ts,block,log_index,tx_hash)
 SELECT peaks.coin,s.usd/s.amount_coin::double precision,peaks.peak,s.ts,s.block,s.log_index,s.tx_hash
 FROM (SELECT coin,max(usd/amount_coin::double precision) AS peak FROM retention_read_swaps WHERE usd>0 AND amount_coin>0 GROUP BY coin) peaks
 CROSS JOIN LATERAL (SELECT * FROM retention_read_swaps WHERE coin=peaks.coin AND usd>0 AND amount_coin>0 ORDER BY ts DESC,block DESC,log_index DESC,tx_hash DESC LIMIT 1) s
 ON CONFLICT(coin) DO UPDATE SET peak=greatest(coin_rating_prices.peak,excluded.peak);
-- Retained minute highs preserve older peaks when the underlying swaps are already gone
UPDATE coin_rating_prices p SET peak=greatest(p.peak,b.peak) FROM (
 SELECT b.coin,max(b.high)/power(10,coalesce(t.decimals,18)) AS peak FROM bars_1m b JOIN tokens t ON t.address=b.coin GROUP BY b.coin,t.decimals
) b WHERE b.coin=p.coin;
INSERT INTO coin_rating_prices(coin,price,peak,ts,block,log_index,tx_hash)
 SELECT peaks.coin,b.close/power(10,coalesce(t.decimals,18)),peaks.peak/power(10,coalesce(t.decimals,18)),b.minute,b.last_block,0,decode(repeat('00',32),'hex')
 FROM (SELECT coin,max(high) AS peak FROM bars_1m GROUP BY coin) peaks JOIN tokens t ON t.address=peaks.coin
 CROSS JOIN LATERAL (SELECT close,minute,last_block FROM bars_1m WHERE coin=peaks.coin ORDER BY minute DESC LIMIT 1) b
 WHERE b.close>0 ON CONFLICT DO NOTHING;
INSERT INTO coin_rating_checks(coin,checked_block,checked_at,full_block,full_price)
 SELECT c.coin,c.as_of_block,coalesce(e.created_at,bt.ts,cb.ts,now()),coalesce(v.valid_from_block,card.valid_from_block,c.as_of_block),
 coalesce((SELECT s.usd/s.amount_coin::double precision FROM retention_read_swaps s WHERE s.coin=c.coin AND s.block<=coalesce(v.valid_from_block,card.valid_from_block,c.as_of_block)
 AND s.usd>0 AND s.amount_coin>0 ORDER BY s.ts DESC,s.block DESC,s.log_index DESC,s.tx_hash DESC LIMIT 1),
 (SELECT g.p0 FROM retention_grade_prices g WHERE g.coin=c.coin AND g.graded_at=coalesce(vbt.ts,vcb.ts) AND g.p0>0 ORDER BY g.since DESC,g.horizon_sec LIMIT 1))
 FROM coin_card_latest c LEFT JOIN coin_cards card ON card.id=c.card_id LEFT JOIN verdicts v ON v.id=c.data->'verdict'->'receipt'->>'id'
 LEFT JOIN engine_block_times vbt ON vbt.number=v.valid_from_block LEFT JOIN chain_blocks vcb ON vcb.number=v.valid_from_block
 LEFT JOIN engine_runs e ON e.coin=c.coin AND e.block=c.as_of_block AND e.rules_version=card.rules_version
 LEFT JOIN engine_block_times bt ON bt.number=c.as_of_block LEFT JOIN chain_blocks cb ON cb.number=c.as_of_block
 ON CONFLICT(coin) DO NOTHING;
