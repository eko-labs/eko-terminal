-- Read-only. UTC today, attempts (not distinct coins), and actual paid requests.
-- Previous means the immediately preceding retained run, ordered by checked_at then id.
-- History is retained 30 days: first_retained is not proof of a lifetime first check.
-- Listed-live is the CURRENT read_coins snapshot, activity within the last day at report time.
-- Historical listing membership was not recorded, so it cannot be reconstructed exactly.
-- No-new-trades uses indexed swaps between the previous and current checked blocks.
-- A pruned interval without a retained trade is unknown, never counted as idle.
WITH bounds AS (
 SELECT date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS midnight, now() AS at
), attempts AS (
 SELECT c.*,p.status AS previous_status,p.checked_at AS previous_at,p.block AS previous_block,
   p.id AS previous_id,
   coalesce(r.activity>b.at-interval '1 day',false) AS listed_live,
   CASE WHEN EXISTS(SELECT 1 FROM swaps s WHERE s.coin=c.coin AND s.block>p.block AND s.block<=c.block) THEN false
     WHEN p.block<coalesce((SELECT through_block FROM raw_history_watermarks WHERE name='swaps'),-1) THEN NULL
     ELSE true END AS no_new_trades
 FROM bounds b JOIN sell_check_runs c ON c.checked_at>=b.midnight AND c.checked_at<=b.at
 LEFT JOIN LATERAL(SELECT id,status,checked_at,block FROM sell_check_runs p
   WHERE p.coin=c.coin AND (p.checked_at,p.id)<(c.checked_at,c.id)
   ORDER BY p.checked_at DESC,p.id DESC LIMIT 1) p ON true
 LEFT JOIN read_coins r ON r.coin=c.coin
), classified AS (
 SELECT *,previous_status IN ('unsupported','buy_failed') AND previous_at>=checked_at-interval '7 days' AS repeat_failed_7d
 FROM attempts
)
SELECT count(*) AS checks_today,coalesce(sum(requests),0) AS requests_today,
 count(*) FILTER(WHERE repeat_failed_7d) AS repeat_failed_7d,
 count(*) FILTER(WHERE repeat_failed_7d AND previous_status='unsupported') AS repeat_unsupported_7d,
 count(*) FILTER(WHERE repeat_failed_7d AND previous_status='buy_failed') AS repeat_buy_failed_7d,
 coalesce(sum(requests) FILTER(WHERE repeat_failed_7d),0) AS repeat_failed_requests,
 count(*) FILTER(WHERE previous_status='sellable' AND no_new_trades) AS sellable_no_new_trades,
 count(*) FILTER(WHERE previous_status='sellable' AND no_new_trades IS NULL) AS sellable_trade_history_unknown,
 coalesce(sum(requests) FILTER(WHERE previous_status='sellable' AND no_new_trades),0) AS sellable_no_new_trade_requests,
 count(*) FILTER(WHERE previous_id IS NULL AND listed_live) AS first_retained_listed_live,
 count(*) FILTER(WHERE previous_id IS NULL AND NOT listed_live) AS first_retained_unlisted
FROM classified;
