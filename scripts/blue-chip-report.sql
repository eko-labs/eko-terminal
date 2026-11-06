-- Run against the engines database after migration 0200, e.g. psql -X -f scripts/blue-chip-report.sql.
-- Read-only snapshot, no RPC, ratings or raw-history scans. A 10-second timeout bounds each query.
-- Listed universe: read_coins.coin (terminal listings, not CoinGecko's rule-A listings).
-- Rule B: latest Clear, never Danger, real pool, minimum age, liquidity USD and external holders.
-- Thresholds are inclusive. Missing measurements fail their rule, rather than becoming zero.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '10s';

-- Coverage: row presence and non-null measurements from read_blue_chip, freshness via as_of_block.
SELECT count(*) AS listed_coins,
       count(b.coin) AS coins_with_read_blue_chip_row,
       count(*) FILTER (WHERE b.liquidity_usd IS NOT NULL) AS coins_with_liquidity_usd,
       count(*) FILTER (WHERE b.holders IS NOT NULL) AS coins_with_holders,
       count(*) FILTER (WHERE b.liquidity_usd IS NOT NULL AND b.holders IS NOT NULL) AS coins_with_both_measurements,
       count(*) FILTER (WHERE b.as_of_block=c.as_of_block) AS coins_with_latest_card_measurements
FROM read_coins r LEFT JOIN read_blue_chip b ON b.coin=r.coin
LEFT JOIN coin_card_latest c ON c.coin=r.coin;

-- All 48 threshold combinations. Each failure count requires EVERY other rule to pass.
-- Age: b.created_at, liquidity: b.liquidity_usd, holders: b.holders, real pool: b.real_pool.
-- Clear: c.data.verdict.level, never Danger: absence from read_blue_chip_danger.coin.
-- Current snapshot: b.as_of_block = c.as_of_block (missing cards/rows also fail this prerequisite).
WITH coins AS MATERIALIZED (
  SELECT b.created_at,b.liquidity_usd,b.holders,
         coalesce(b.real_pool,false) AS real_pool,
         coalesce(c.data->'verdict'->>'level'='clear',false) AS clear,
         d.coin IS NULL AS never_danger,
         coalesce(b.as_of_block=c.as_of_block,false) AS latest_measurements
  FROM read_coins r LEFT JOIN read_blue_chip b ON b.coin=r.coin
  LEFT JOIN coin_card_latest c ON c.coin=r.coin
  LEFT JOIN read_blue_chip_danger d ON d.coin=r.coin
), levels AS (
  SELECT age_days,liquidity_usd_floor,holders_floor
  FROM (VALUES (1),(3),(7)) a(age_days)
  CROSS JOIN (VALUES (10000),(25000),(50000),(100000)) l(liquidity_usd_floor)
  CROSS JOIN (VALUES (100),(250),(500),(1000)) h(holders_floor)
), checked AS (
  SELECT l.*,c.clear,c.never_danger,c.real_pool,c.latest_measurements,
         coalesce(c.created_at<=now()-l.age_days*interval '1 day',false) AS age,
         coalesce(c.liquidity_usd>=l.liquidity_usd_floor,false) AS liquidity,
         coalesce(c.holders>=l.holders_floor,false) AS holders
  FROM levels l CROSS JOIN coins c
), counted AS (
  SELECT *,clear::int+never_danger::int+real_pool::int+latest_measurements::int+
           age::int+liquidity::int+holders::int AS passed
  FROM checked
)
SELECT l.age_days,l.liquidity_usd_floor,l.holders_floor,
       count(*) FILTER (WHERE passed=7) AS rule_b_members,
       count(*) FILTER (WHERE passed=6 AND NOT clear) AS fail_only_clear,
       count(*) FILTER (WHERE passed=6 AND NOT never_danger) AS fail_only_never_danger,
       count(*) FILTER (WHERE passed=6 AND NOT real_pool) AS fail_only_real_pool,
       count(*) FILTER (WHERE passed=6 AND NOT age) AS fail_only_age,
       count(*) FILTER (WHERE passed=6 AND NOT liquidity) AS fail_only_liquidity,
       count(*) FILTER (WHERE passed=6 AND NOT holders) AS fail_only_holders,
       count(*) FILTER (WHERE passed=6 AND NOT latest_measurements) AS fail_only_latest_measurements
FROM levels l LEFT JOIN counted c USING(age_days,liquidity_usd_floor,holders_floor)
GROUP BY l.age_days,l.liquidity_usd_floor,l.holders_floor
ORDER BY l.age_days,l.liquidity_usd_floor,l.holders_floor;

-- Largest = highest b.liquidity_usd (the latest-card table has no market-cap USD measurement).
-- Loosest level: age >= 1 day, liquidity >= 10,000 USD, holders >= 100, and all other rule-B checks.
-- Address: r.coin, name/symbol/verdict: latest card JSON, all remaining figures: read_blue_chip.
SELECT '0x'||encode(r.coin,'hex') AS coin,
       c.data->'identity'->'name'->>'text' AS name,
       c.data->'identity'->'symbol'->>'text' AS symbol,
       b.liquidity_usd,b.holders,
       extract(epoch FROM now()-b.created_at)/86400 AS age_days,
       b.as_of_block,c.data->'verdict'->>'level' AS verdict
FROM read_coins r JOIN read_blue_chip b ON b.coin=r.coin
JOIN coin_card_latest c ON c.coin=b.coin AND c.as_of_block=b.as_of_block
LEFT JOIN read_blue_chip_danger d ON d.coin=b.coin
WHERE c.data->'verdict'->>'level'='clear' AND d.coin IS NULL AND b.real_pool
  AND b.created_at<=now()-interval '1 day' AND b.liquidity_usd>=10000 AND b.holders>=100
ORDER BY b.liquidity_usd DESC,b.holders DESC,r.coin LIMIT 15;
COMMIT;
