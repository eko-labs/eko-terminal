-- Run with psql -X -v ON_ERROR_STOP=1 -f scripts/engine-throughput-report.sql after migration 0216.
-- Read-only, no RPC. Rolling 24h; UTC hour labels include partial boundary hours.
-- engine_runs is an upserted, retained history, NOT an attempt ledger. Its created_at does not advance on updates.
-- First retained run is only a first-rating proxy if earlier runs were pruned. Never infer failed/skipped = 0.
-- Minute counters are authoritative only since deployment, through the start of the current minute.
-- Planner skipped_candidate counts are repeated observations, not distinct coins or evaluation attempts.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='30s';
SET LOCAL TIME ZONE 'UTC';

SELECT now() AS report_at, applied_at AS instrumentation_since,
       greatest(applied_at,date_trunc('minute',now())-interval '24 hours') AS counter_window_start,
       date_trunc('minute',now()) AS counter_window_end
FROM eko_engine_migrations WHERE id='0216_engine_throughput';

-- Retained successful run rows: answers what the header / engine_runs can establish before instrumentation.
WITH recent AS MATERIALIZED (
 SELECT e.*,coalesce(e.created_at,to_timestamp(e.sec)) AS written_at
 FROM engine_runs e WHERE coalesce(e.created_at,to_timestamp(e.sec))>=now()-interval '24 hours'
), classified AS (
 SELECT r.*,NOT EXISTS(SELECT 1 FROM engine_runs p WHERE p.coin=r.coin
   AND (coalesce(p.created_at,to_timestamp(p.sec)),p.block,p.rules_version)
      <(r.written_at,r.block,r.rules_version)) AS first_retained
 FROM recent r
), hours AS (SELECT generate_series(date_trunc('hour',now()-interval '24 hours'),date_trunc('hour',now()),interval '1 hour') AS hour)
SELECT h.hour,count(c.coin) AS retained_run_rows,
 count(c.coin) FILTER(WHERE c.first_retained) AS first_retained_ratings,
 count(c.coin) FILTER(WHERE NOT c.first_retained) AS retained_reratings,
 NULL::bigint AS historical_failed_attempts_unknown,NULL::bigint AS historical_skips_unknown
FROM hours h LEFT JOIN classified c ON date_trunc('hour',c.written_at)=h.hour GROUP BY h.hour ORDER BY h.hour;

-- Actual live evaluation attempts after instrumentation (replay failures are labelled separately below), including repeated same-block writes absent from engine_runs.
WITH hours AS (SELECT generate_series(date_trunc('hour',now()-interval '24 hours'),date_trunc('hour',now()),interval '1 hour') AS hour)
SELECT h.hour,
 sum(c.count) FILTER(WHERE c.outcome='completed' AND c.first_rating) AS first_ratings,
 sum(c.count) FILTER(WHERE c.outcome='completed' AND NOT c.first_rating) AS reratings,
 sum(c.count) FILTER(WHERE c.outcome='failed' AND c.path<>'replay') AS failed_initial_attempts,
 sum(c.count) FILTER(WHERE c.outcome='retry_failed' AND c.path<>'replay') AS failed_retry_attempts,
 sum(c.count) FILTER(WHERE c.outcome='skipped') AS skipped_evaluations,
 sum(c.count) FILTER(WHERE c.outcome='skipped_candidate') AS skipped_candidate_observations,
 sum(c.count) FILTER(WHERE c.outcome='planned' AND c.first_rating) AS planned_first_checkpoints
FROM hours h LEFT JOIN engine_evaluation_counts c ON date_trunc('hour',c.minute)=h.hour
 AND c.minute>=date_trunc('minute',now())-interval '24 hours' AND c.minute<date_trunc('minute',now())
GROUP BY h.hour ORDER BY h.hour;

SELECT date_trunc('hour',minute) AS hour,path,outcome,reason,first_rating,sum(count) AS observations
FROM engine_evaluation_counts WHERE minute>=date_trunc('minute',now())-interval '24 hours'
 AND minute<date_trunc('minute',now()) GROUP BY 1,2,3,4,5 ORDER BY 1,2,3,4,5;

-- Current pending-first-card blockers, ALL tokens (includes reference assets); pricing/senders are overlapping flags.
-- no_recorded_plan means since instrumentation only; interrupted stages require process/log inspection.
WITH head AS (SELECT max(number) AS block FROM chain_blocks)
SELECT CASE
  WHEN t.deployer IS NULL THEN 'no_deployer'
  WHEN t.name IS NULL OR t.symbol IS NULL THEN 'missing_launch_identity'
  WHEN r.coin IS NULL THEN 'not_listed'
  WHEN r.activity<=now()-interval '7 days' THEN 'idle_seven_days'
  WHEN f.coin IS NOT NULL AND (SELECT block FROM head)-f.last_block<least(power(2,greatest(1,least(f.attempts,10))),1024)*600 THEN 'backoff:'||f.reason
  WHEN f.coin IS NOT NULL THEN 'retry_due:'||f.reason
  WHEN p.coin IS NULL THEN 'no_recorded_plan'
  WHEN p.started_at IS NULL THEN 'planned_not_started'
  WHEN p.sources_ready_at IS NOT NULL THEN 'waiting_on_write_or_interrupted'
  ELSE 'loading_sources_or_interrupted' END AS reason,
  count(*)::text AS coins,
  count(f.coin)::text AS previously_failed,
  count(*) FILTER(WHERE f.coin IS NOT NULL AND (SELECT block FROM head)-f.last_block<least(power(2,greatest(1,least(f.attempts,10))),1024)*600)::text AS backing_off,
  count(*) FILTER(WHERE r.pricing_pending)::text AS pricing_pending,
  count(*) FILTER(WHERE r.buyers_pending)::text AS senders_pending,
  count(*) FILTER(WHERE o.status IN ('unreadable','no_launch_wallet','skipped'))::text AS onboarding_filtered
FROM tokens t LEFT JOIN coin_card_latest c ON c.coin=t.address
LEFT JOIN read_coins r ON r.coin=t.address LEFT JOIN engine_card_failures f ON f.coin=t.address
LEFT JOIN engine_first_scan_plans p ON p.coin=t.address LEFT JOIN coin_onboarding o ON o.coin=t.address
WHERE c.coin IS NULL GROUP BY 1 ORDER BY 1;

-- Latest persisted failure reasons, attempts are cumulative and may include pre-window failures.
SELECT f.reason,count(*) AS pending_coins,sum(f.attempts) AS lifetime_failed_attempts,
 min(f.last_block) AS oldest_failure_block,max(f.last_block) AS newest_failure_block
FROM engine_card_failures f LEFT JOIN coin_card_latest c ON c.coin=f.coin
WHERE c.coin IS NULL GROUP BY f.reason ORDER BY pending_coins DESC,f.reason;

-- Written Pending cards are already rated; these gaps do not belong to the first-card backlog.
SELECT count(*) AS rated_pending,
 count(*) FILTER(WHERE r.pricing_pending) AS pricing_pending,
 count(*) FILTER(WHERE r.buyers_pending) AS senders_pending,
 count(*) FILTER(WHERE a.missing_honeypot) AS missing_sell_check,
 count(*) FILTER(WHERE s.coin IS NULL) AS no_schedule
FROM coin_card_latest c LEFT JOIN read_coins r ON r.coin=c.coin
LEFT JOIN engine_rating_candidates a ON a.coin=c.coin LEFT JOIN engine_schedule s ON s.coin=c.coin
WHERE c.data->'verdict'->>'level'='pending';
COMMIT;
