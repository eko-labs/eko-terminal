import { binary, type ChainDb } from '@eko/db';
import type { Address } from '@eko/shared';

export interface EvaluationCount { path:string; outcome:string; reason:string; firstRating:boolean; count:number; coin?:Address }
/** Counters are attempts/observations, not unique coins. Successful writes call this inside their transaction. */
export async function countEvaluations(db:ChainDb,counts:readonly EvaluationCount[]) {
  if(!counts.length)return;
  await db.sql.query(`INSERT INTO engine_evaluation_counts(minute,path,outcome,reason,first_rating,count,coin)
    SELECT date_trunc('minute',clock_timestamp()),path,outcome,reason,first_rating,sum(n),coin
    FROM unnest($1::text[],$2::text[],$3::text[],$4::boolean[],$5::bigint[],$6::bytea[]) AS x(path,outcome,reason,first_rating,n,coin)
    GROUP BY path,outcome,reason,first_rating,coin
    ON CONFLICT(minute,path,outcome,reason,first_rating,coin) DO UPDATE SET count=engine_evaluation_counts.count+excluded.count`,
  [counts.map(c=>c.path),counts.map(c=>c.outcome),counts.map(c=>c.reason),counts.map(c=>c.firstRating),counts.map(c=>c.count),counts.map(c=>c.coin?binary(c.coin):new Uint8Array())]);
}

/** Minute log summaries share the durable report counters; no per-coin payload or provider errors are logged. */
export async function logThroughput(db:ChainDb,budget?:{dailyRequests:number;reservePct:number}) {
  const rows=(await db.sql.query(`SELECT path,outcome,reason,first_rating,sum(count)::text AS count
    FROM engine_evaluation_counts WHERE minute>=date_trunc('minute',now())-interval '1 minute'
      AND minute<date_trunc('minute',now()) GROUP BY path,outcome,reason,first_rating ORDER BY path,outcome,reason,first_rating`)).rows;
  const pending=(await db.sql.query(pendingSnapshotSql)).rows;
  const ratedPending=(await db.sql.query(ratingGapSnapshotSql)).rows;
  const classes=(await db.sql.query(`SELECT schedule_class AS class,count(*) AS checks,coalesce(sum(requests),0) AS requests
    FROM sell_check_runs WHERE checked_at>=date_trunc('minute',now())-interval '1 minute'
    AND checked_at<date_trunc('minute',now()) GROUP BY schedule_class ORDER BY schedule_class`)).rows;
  const spent=Number((await db.sql.query(`SELECT coalesce(sum(requests),0) AS n FROM sell_check_runs
    WHERE checked_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AND checked_at<=now()`)).rows[0]!.n);
  const remaining=budget ? Math.max(0,budget.dailyRequests-spent) : null;
  const sellCheck={enabled:!!budget,classes,spentRequests:spent,remainingRequests:remaining,
    routineRemainingRequests:budget ? Math.max(0,remaining!-Math.ceil(budget.dailyRequests*budget.reservePct/100)) : null};
  console.log(JSON.stringify({event:'engine_throughput',intervalSec:60,counts:rows,pending,ratedPending,sellCheck}));
}

/** Current blockers overlap: missing prices/senders/sell checks can still produce a first card. No raw-history scan. */
export const pendingSnapshotSql=`WITH head AS (SELECT max(number) AS block FROM chain_blocks)
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
WHERE c.coin IS NULL GROUP BY 1 ORDER BY 1`;

/** Gaps on existing Pending cards are distinct from failure to write a first card. */
export const ratingGapSnapshotSql=`SELECT count(*) AS rated_pending,
 count(*) FILTER(WHERE r.pricing_pending) AS pricing_pending,
 count(*) FILTER(WHERE r.buyers_pending) AS senders_pending,
 count(*) FILTER(WHERE a.missing_honeypot) AS missing_sell_check,
 count(*) FILTER(WHERE s.coin IS NULL) AS no_schedule
FROM coin_card_latest c LEFT JOIN read_coins r ON r.coin=c.coin
LEFT JOIN engine_rating_candidates a ON a.coin=c.coin LEFT JOIN engine_schedule s ON s.coin=c.coin
WHERE c.data->'verdict'->>'level'='pending'`;

/** Keep the first durable plan for each never-rated coin; the rows are diagnostic, never scheduling inputs. */
export async function recordFirstPlans(db:ChainDb,coins:readonly Address[],block:number,path:string) {
  if(!coins.length)return;
  await db.sql.query(`INSERT INTO engine_first_scan_plans(coin,block,path)
    SELECT DISTINCT coin,$2::bigint,$3::text FROM unnest($1::bytea[]) a(coin)
    WHERE NOT EXISTS(SELECT 1 FROM coin_card_latest c WHERE c.coin=a.coin)
    ON CONFLICT(coin) DO NOTHING`,[coins.map(binary),block,path]);
}
