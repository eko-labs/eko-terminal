# Engine query plans — 022f (archived)

022g replaces the rank aggregation query and SQL-reference fallbacks with an hourly row read plus exact in-memory sums. The plans below record the 022f source revision; its float-ranking fallback is no longer used by the worker.

The audit discovers 36 distinct SQL statements in engine sources that touch `swaps`, `token_transfers`, `balances`, `deployer_stats`, `outcomes`, `coin_cards`, `verdicts` or `engine_runs`. Reads use `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`; writes use `EXPLAIN (FORMAT JSON)` without executing the write. Source locations below identify shared statements.

The disposable PGlite fixture has 200 coins, 120,000 priced swaps, 24,000 holder transfers, 200,000 rows in each of the run/card/verdict/deployer tables, and 15,000 outcomes. Both phases use the same data and `VACUUM ANALYZE`; timings are single local samples, not production estimates. Empty future swap partitions can retain sequential scans.

Migration 0108 adds:

- `swaps (ts, block, coin) INCLUDE (usd) WHERE usd > 0`: covering hourly priced-volume reads, including the live/reference rank query.
- `deployer_stats (deployer, valid_from_block, coin)`: wallet history and exemption history bounds.
- `outcomes (coin, valid_from_block) WHERE outcome = 'rugged'`: exemption rug joins.
- `engine_runs (rules_version, block, coin)`: version-scoped replay startup.
- `deployer_stats (rules_version, valid_from_block, coin)`: version-scoped history bootstrap.

Existing coin/block swap indexes, token-transfer block/from/to indexes, balance keys, outcome coin/horizon keys, and card/verdict/run keys cover the other bounded accesses. The full-range replay preload intentionally reads all qualifying rows; small sorts on bounded results do not warrant duplicate indexes.

Normal forward replay uses the in-memory volume window instead of rank SQL. Creation snapshots run once per creation block and stay cached for the replay. SQL remains the reference for live, retrospective reads, non-finite amounts and numerically ambiguous floating-point ranks.

| # | Source | Before ms | After ms | Before plan | After plan |
| --- | --- | ---: | ---: | --- | --- |
| 1 | src/activity.ts:13 | — | — | ModifyTable:engine_block_times [Subquery Scan [Aggregate [Append [Index Only Scan:swaps_2026_10_block_ts_idx; Seq Scan:swaps_2026_11; Seq Scan:swaps_2026_12; Seq Scan:token_transfers_2026_10; Seq Scan:token_transfers_2026_11; Seq Scan:token_transfers_2026_12; Seq Scan:liquidity_events]]]] | ModifyTable:engine_block_times [Subquery Scan [Aggregate [Append [Index Only Scan:swaps_2026_10_block_ts_idx; Seq Scan:swaps_2026_11; Seq Scan:swaps_2026_12; Seq Scan:token_transfers_2026_10; Seq Scan:token_transfers_2026_11; Seq Scan:token_transfers_2026_12; Seq Scan:liquidity_events]]]] |
| 2 | src/activity.ts:80 | 174.337 | 163.271 | Sort [Append [Aggregate [Incremental Sort [Merge Append [Index Scan:swaps_2026_10_coin_block_idx; Index Scan:swaps_2026_11_coin_block_idx; Index Scan:swaps_2026_12_coin_block_idx]]]; Aggregate [Append [Seq Scan:token_transfers_2026_10; Seq Scan:token_transfers_2026_11; Seq Scan:token_transfers_2026_12]]; Aggregate [Sort [Nested Loop [Nested Loop [Seq Scan:liquidity_events; Seq Scan:pools]; Index Only Scan:tokens_pkey]]]; Aggregate [Sort [Nested Loop [Seq Scan:pons_events; Index Scan:engine_block_times_pkey]]]; Aggregate [Sort [Nested Loop [Seq Scan:pons_exemptions; Index Scan:engine_block_times_pkey]]]; Nested Loop [Nested Loop [Seq Scan:pools; Index Scan:engine_block_times_pkey]; Index Only Scan:tokens_pkey]]] | Sort [Append [Aggregate [Incremental Sort [Merge Append [Index Scan:swaps_2026_10_coin_block_idx; Index Scan:swaps_2026_11_coin_block_idx; Index Scan:swaps_2026_12_coin_block_idx]]]; Aggregate [Append [Seq Scan:token_transfers_2026_10; Seq Scan:token_transfers_2026_11; Seq Scan:token_transfers_2026_12]]; Aggregate [Sort [Nested Loop [Nested Loop [Seq Scan:liquidity_events; Seq Scan:pools]; Index Only Scan:tokens_pkey]]]; Aggregate [Sort [Nested Loop [Seq Scan:pons_events; Index Scan:engine_block_times_pkey]]]; Aggregate [Sort [Nested Loop [Seq Scan:pons_exemptions; Index Scan:engine_block_times_pkey]]]; Nested Loop [Nested Loop [Seq Scan:pools; Index Scan:engine_block_times_pkey]; Index Only Scan:tokens_pkey]]] |
| 3 | src/market.ts:4 | 3.395 | 2.549 | Sort [Aggregate [Append [Bitmap Heap Scan:swaps_2026_10 [Bitmap Index Scan:swaps_2026_10_pkey]; Seq Scan:swaps_2026_11; Seq Scan:swaps_2026_12]]] | Sort [Aggregate [Append [Index Only Scan:swaps_2026_10_ts_block_coin_usd_idx; Seq Scan:swaps_2026_11; Seq Scan:swaps_2026_12]]] |
| 4 | src/outcomes.ts:17 | 0.129 | 0.021 | Sort [Bitmap Heap Scan:outcomes [Bitmap Index Scan:outcomes_pkey]] | Sort [Bitmap Heap Scan:outcomes [Bitmap Index Scan:outcomes_pkey]] |
| 5 | src/outcomes.ts:20 | — | — | ModifyTable:deployer_stats [Result] | ModifyTable:deployer_stats [Result] |
| 6 | src/outcomes.ts:24 | 0.022 | 0.016 | Sort [Nested Loop [Index Only Scan:engine_block_times_ts; Seq Scan:tokens [Aggregate [Index Only Scan:outcomes_pkey]]]] | Sort [Nested Loop [Index Only Scan:engine_block_times_ts; Seq Scan:tokens [Aggregate [Index Only Scan:outcomes_pkey]]]] |
| 7 | src/outcomes.ts:30 | 0.017 | 0.007 | Index Only Scan:outcomes_pkey | Index Only Scan:outcomes_pkey |
| 8 | src/outcomes.ts:66 | — | — | ModifyTable:outcomes [Result] | ModifyTable:outcomes [Result] |
| 9 | src/replay-cache.ts:49 | 169.679 | 165.395 | Sort [Append [Seq Scan:swaps_2026_10; Seq Scan:swaps_2026_11; Seq Scan:swaps_2026_12]] | Sort [Append [Seq Scan:swaps_2026_10; Seq Scan:swaps_2026_11; Seq Scan:swaps_2026_12]] |
| 10 | src/replay-cache.ts:52 | 15.459 | 5.046 | Seq Scan:engine_runs | Index Only Scan:engine_runs_version_block_coin |
| 11 | src/replay-cache.ts:53 | 15.782 | 9.082 | Sort [Seq Scan:deployer_stats] | Sort [Bitmap Heap Scan:deployer_stats [Bitmap Index Scan:deployer_stats_version_block_coin]] |
| 12 | src/replay-cache.ts:55 | 5.03 | 4.892 | Sort [Seq Scan:outcomes] | Sort [Seq Scan:outcomes] |
| 13 | src/replay-cache.ts:61 | 0.422 | 0.403 | Sort [Append [Index Scan:swaps_2026_10_coin_block_idx; Seq Scan:swaps_2026_11; Seq Scan:swaps_2026_12]] | Sort [Append [Index Scan:swaps_2026_10_coin_block_idx; Seq Scan:swaps_2026_11; Seq Scan:swaps_2026_12]] |
| 14 | src/replay-cache.ts:64 | 0.111 | 0.084 | Sort [Append [Index Scan:token_transfers_2026_10_token_block_idx; Seq Scan:token_transfers_2026_11; Seq Scan:token_transfers_2026_12]] | Sort [Append [Index Scan:token_transfers_2026_10_token_block_idx; Seq Scan:token_transfers_2026_11; Seq Scan:token_transfers_2026_12]] |
| 15 | src/replay-cache.ts:65 | 0.029 | 0.022 | Result [Limit [Merge Append [Index Only Scan:token_transfers_2026_10_token_block_idx; Index Only Scan:token_transfers_2026_11_token_block_idx; Index Only Scan:token_transfers_2026_12_token_block_idx]]] | Result [Limit [Merge Append [Index Only Scan:token_transfers_2026_10_token_block_idx; Index Only Scan:token_transfers_2026_11_token_block_idx; Index Only Scan:token_transfers_2026_12_token_block_idx]]] |
| 16 | src/replay-cache.ts:66, src/sources.ts:45 | 0.065 | 0.041 | Index Scan:balances_pkey | Index Scan:balances_pkey |
| 17 | src/sources.ts:44 | 0.012 | 0.01 | Limit [Append [Index Only Scan:token_transfers_2026_10_token_block_idx; Seq Scan:token_transfers_2026_11; Seq Scan:token_transfers_2026_12]] | Limit [Append [Index Only Scan:token_transfers_2026_10_token_block_idx; Seq Scan:token_transfers_2026_11; Seq Scan:token_transfers_2026_12]] |
| 18 | src/sources.ts:46 | 0.305 | 1.346 | Sort [Aggregate [Append [Append [Index Scan:token_transfers_2026_10_token_block_idx; Seq Scan:token_transfers_2026_11; Seq Scan:token_transfers_2026_12]; Append [Index Scan:token_transfers_2026_10_token_block_idx; Seq Scan:token_transfers_2026_11; Seq Scan:token_transfers_2026_12]]]] | Sort [Aggregate [Append [Append [Index Scan:token_transfers_2026_10_token_block_idx; Seq Scan:token_transfers_2026_11; Seq Scan:token_transfers_2026_12]; Append [Index Scan:token_transfers_2026_10_token_block_idx; Seq Scan:token_transfers_2026_11; Seq Scan:token_transfers_2026_12]]]] |
| 19 | src/sources.ts:53 | 2.009 | 1.071 | Unique [Sort [Bitmap Heap Scan:deployer_stats [Bitmap Index Scan:deployer_stats_pkey]]] | Unique [Sort [Bitmap Heap Scan:deployer_stats [Bitmap Index Scan:deployer_stats_deployer_block_coin]]] |
| 20 | src/sources.ts:65 | 0.362 | 0.314 | Sort [Append [Index Scan:swaps_2026_10_coin_block_idx; Seq Scan:swaps_2026_11; Seq Scan:swaps_2026_12]] | Sort [Append [Index Scan:swaps_2026_10_coin_block_idx; Seq Scan:swaps_2026_11; Seq Scan:swaps_2026_12]] |
| 21 | src/sources.ts:109 | 4.391 | 2.256 | Aggregate [Sort [Hash Join [Index Only Scan:deployer_stats_pkey; Hash [Seq Scan:outcomes]]]] | Aggregate [Sort [Hash Join [Index Only Scan:deployer_stats_deployer_block_coin; Hash [Index Only Scan:outcomes_rugged_coin_block]]]] |
| 22 | src/sources.ts:206 | 6.513 | 5.207 | Limit [Sort [Aggregate [Hash Join [Append [Bitmap Heap Scan:swaps_2026_10 [Bitmap Index Scan:swaps_2026_10_pkey]; Seq Scan:swaps_2026_11; Seq Scan:swaps_2026_12]; Hash [Merge Join [Index Scan:engine_block_times_pkey; Sort [Seq Scan:tokens]]]]]]] | Limit [Sort [Aggregate [Hash Join [Append [Index Only Scan:swaps_2026_10_ts_block_coin_usd_idx; Seq Scan:swaps_2026_11; Seq Scan:swaps_2026_12]; Hash [Merge Join [Index Scan:engine_block_times_pkey; Sort [Seq Scan:tokens]]]]]]] |
| 23 | src/worker.ts:108, src/worker.ts:119 | 0.06 | 0.021 | Index Only Scan:engine_runs_pkey | Index Only Scan:engine_runs_version_block_coin |
| 24 | src/worker.ts:165 | 1.45 | 1.081 | Sort [Hash Join [Seq Scan:tokens; Hash [Seq Scan:engine_schedule]; Result [Limit [Append [Index Scan:swaps_2026_12_coin_ts_idx; Index Scan:swaps_2026_11_coin_ts_idx; Index Scan:swaps_2026_10_coin_ts_idx]]]]] | Sort [Hash Join [Seq Scan:tokens; Hash [Seq Scan:engine_schedule]; Result [Limit [Append [Index Scan:swaps_2026_12_coin_ts_idx; Index Scan:swaps_2026_11_coin_ts_idx; Index Scan:swaps_2026_10_coin_ts_idx]]]]] |
| 25 | src/worker.ts:174 | 0.032 | 0.018 | Limit [Index Scan:engine_runs_pkey] | Limit [Index Scan:engine_runs_version_block_coin] |
| 26 | src/worker.ts:179 | 0.02 | 0.017 | Aggregate [Append [Index Scan:swaps_2026_10_coin_block_idx; Seq Scan:swaps_2026_11; Seq Scan:swaps_2026_12]] | Aggregate [Append [Index Scan:swaps_2026_10_coin_block_idx; Seq Scan:swaps_2026_11; Seq Scan:swaps_2026_12]] |
| 27 | src/worker.ts:182 | 0.021 | 0.019 | Limit [Append [Append [Index Only Scan:token_transfers_2026_10_token_block_idx; Seq Scan:token_transfers_2026_11; Seq Scan:token_transfers_2026_12]; Seq Scan:pons_exemptions; Nested Loop [Seq Scan:liquidity_events; Seq Scan:pools]; Seq Scan:pools]] | Limit [Append [Append [Index Only Scan:token_transfers_2026_10_token_block_idx; Seq Scan:token_transfers_2026_11; Seq Scan:token_transfers_2026_12]; Seq Scan:pons_exemptions; Nested Loop [Seq Scan:liquidity_events; Seq Scan:pools]; Seq Scan:pools]] |
| 28 | src/worker.ts:217 | — | — | ModifyTable:engine_runs [Result] | ModifyTable:engine_runs [Result] |
| 29 | src/worker.ts:219 | — | — | ModifyTable:engine_runs [Index Scan:engine_runs_pkey] | ModifyTable:engine_runs [Index Scan:engine_runs_version_block_coin] |
| 30 | src/worker.ts:220 | — | — | ModifyTable:engine_runs [Result] | ModifyTable:engine_runs [Result] |
| 31 | src/worker.ts:230, src/worker.ts:245 | 0.055 | 0.031 | Limit [Sort [Bitmap Heap Scan:verdicts [Bitmap Index Scan:verdicts_coin_block]]] | Limit [Sort [Bitmap Heap Scan:verdicts [Bitmap Index Scan:verdicts_coin_block]]] |
| 32 | src/worker.ts:231 | 0.024 | 0.011 | Limit [Index Scan:coin_cards_coin_block] | Limit [Index Scan:coin_cards_coin_block] |
| 33 | src/worker.ts:232, src/worker.ts:262 | 0.012 | 0.013 | Limit [Index Scan:engine_runs_pkey] | Limit [Index Scan:engine_runs_version_block_coin] |
| 34 | src/worker.ts:251 | — | — | ModifyTable:verdicts [Result] | ModifyTable:verdicts [Result] |
| 35 | src/worker.ts:261 | 0.02 | 0.014 | Limit [Nested Loop [Index Scan:coin_cards_coin_block; Index Scan:engine_block_times_pkey]] | Limit [Nested Loop [Index Scan:coin_cards_coin_block; Index Scan:engine_block_times_pkey]] |
| 36 | src/worker.ts:269 | — | — | ModifyTable:coin_cards [Result] | ModifyTable:coin_cards [Result] |

## Reproduce

From the workspace root (no network):

```sh
AUDIT_MIGRATION=../../packages/db/drizzle/0108_engine_query_indexes.sql \
AUDIT_OUTPUT=/private/tmp/eko-engine-query-plans.json \
pnpm_config_verify_deps_before_run=false \
pnpm --filter @eko/engines exec node --import tsx test/query-plans.ts
```

The script drops the candidate indexes only inside its disposable in-memory database for the before phase, reapplies the migration for the after phase, and emits complete JSON plans. It never opens the indexer’s persisted database.

## Statements

### 1

src/activity.ts:13

```sql
INSERT INTO engine_block_times(number,ts,hash,source)
    SELECT block,min(ts),NULL,'activity' FROM (
      SELECT block,ts FROM swaps UNION ALL SELECT block,ts FROM token_transfers UNION ALL SELECT block,ts FROM liquidity_events
    ) e GROUP BY block ON CONFLICT(number) DO NOTHING
```

### 2

src/activity.ts:80

```sql
WITH activity AS (
    SELECT coin,block,'swap' AS kind,min(ts) AS ts,min(price_quote) AS low,max(price_quote) AS high,
      (array_agg(price_quote ORDER BY log_index DESC,tx_hash DESC))[1] AS price,
      count(*)::text||':'||count(usd)::text AS revision FROM swaps WHERE block<=$1 GROUP BY coin,block
    UNION ALL SELECT token,block,'transfer',min(ts),NULL,NULL,NULL,count(*)::text FROM token_transfers WHERE block<=$1 GROUP BY token,block
    UNION ALL SELECT t.address,e.block,'liquidity',min(e.ts),NULL,NULL,NULL,count(*)::text FROM liquidity_events e
      JOIN pools p ON p.id=e.pool_id JOIN tokens t ON t.address=p.currency0 OR t.address=p.currency1 WHERE e.block<=$1 GROUP BY t.address,e.block
    UNION ALL SELECT token,e.block,'pons',b.ts,NULL,NULL,NULL,count(*)::text FROM pons_events e
      JOIN engine_block_times b ON b.number=e.block WHERE e.block<=$1 GROUP BY token,e.block,b.ts
    UNION ALL SELECT token,e.block,'exemption',b.ts,NULL,NULL,NULL,count(*)::text FROM pons_exemptions e
      JOIN engine_block_times b ON b.number=e.block WHERE e.block<=$1 GROUP BY token,e.block,b.ts
    UNION ALL SELECT t.address,p.created_block,'pair',b.ts,NULL,NULL,NULL,'1' FROM pools p
      JOIN tokens t ON t.address=p.currency0 OR t.address=p.currency1 JOIN engine_block_times b ON b.number=p.created_block WHERE p.created_block<=$1
    ) SELECT * FROM activity ORDER BY coin,block,kind
```

### 3

src/market.ts:4

```sql
SELECT coin FROM swaps WHERE block<=$1 AND ts>to_timestamp($2) AND usd>0 GROUP BY coin ORDER BY sum(usd) DESC,coin
```

### 4

src/outcomes.ts:17

```sql
SELECT horizon,outcome,data FROM outcomes WHERE coin=$1 AND valid_from_block<=$2 ORDER BY horizon
```

### 5

src/outcomes.ts:20

```sql
INSERT INTO deployer_stats VALUES($1,$2,$3,$4,$5) ON CONFLICT(deployer,coin,valid_from_block,rules_version) DO UPDATE SET data=excluded.data
```

### 6

src/outcomes.ts:24

```sql
SELECT t.address,b.ts FROM tokens t JOIN engine_block_times b ON b.number=t.first_block
    WHERE t.first_block<=$1 AND b.ts<=to_timestamp($2-3600) AND (SELECT count(*) FROM outcomes o WHERE o.coin=t.address)<3 ORDER BY t.first_block,t.address
```

### 7

src/outcomes.ts:30

```sql
SELECT 1 FROM outcomes WHERE coin=$1 AND horizon=$2
```

### 8

src/outcomes.ts:66

```sql
INSERT INTO outcomes VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING
```

### 9

src/replay-cache.ts:49

```sql
SELECT coin,block,extract(epoch FROM ts)::double precision AS sec,usd FROM swaps WHERE block<=$1 AND usd>0 ORDER BY block,ts,tx_hash,log_index
```

### 10

src/replay-cache.ts:52

```sql
SELECT coin,block FROM engine_runs WHERE rules_version=$1 AND block<=$2
```

### 11

src/replay-cache.ts:53

```sql
SELECT deployer,valid_from_block,data FROM deployer_stats WHERE rules_version=$1 AND valid_from_block<=$2 ORDER BY valid_from_block,coin
```

### 12

src/replay-cache.ts:55

```sql
SELECT * FROM outcomes ORDER BY horizon
```

### 13

src/replay-cache.ts:61

```sql
SELECT block,ts,tx_hash,log_index,trader,side,amount_coin,amount_quote,price_quote,usd,venue,pool_id,quote_asset FROM swaps WHERE coin=$1 AND block<=$2 ORDER BY block,log_index,tx_hash
```

### 14

src/replay-cache.ts:64

```sql
SELECT block,from_address,to_address,amount,kind FROM token_transfers WHERE token=$1 AND block<=$2 ORDER BY block
```

### 15

src/replay-cache.ts:65

```sql
SELECT max(block) AS block FROM token_transfers WHERE token=$1
```

### 16

src/replay-cache.ts:66, src/sources.ts:45

```sql
SELECT holder,amount,last_block AS block FROM balances WHERE token=$1 AND amount>0 ORDER BY holder
```

### 17

src/sources.ts:44

```sql
SELECT 1 FROM token_transfers WHERE token=$1 AND block>$2 LIMIT 1
```

### 18

src/sources.ts:46

```sql
SELECT holder,sum(amount)::text AS amount,max(block)::text AS block FROM (
    SELECT to_address AS holder,amount,block FROM token_transfers WHERE token=$1 AND block<=$2 AND kind='Transfer'
    UNION ALL SELECT from_address,-amount,block FROM token_transfers WHERE token=$1 AND block<=$2 AND kind='Transfer'
    ) m GROUP BY holder HAVING sum(amount)>0 ORDER BY holder
```

### 19

src/sources.ts:53

```sql
SELECT DISTINCT ON(coin) data FROM deployer_stats
    WHERE deployer=$1 AND coin<>$2 AND valid_from_block<=$3 AND rules_version=$4 ORDER BY coin,valid_from_block DESC
```

### 20

src/sources.ts:65

```sql
SELECT * FROM swaps WHERE coin=$1 AND block<=$2 ORDER BY block,log_index,tx_hash
```

### 21

src/sources.ts:109

```sql
SELECT count(DISTINCT d.coin) AS n FROM deployer_stats d JOIN outcomes o ON o.coin=d.coin
        WHERE d.deployer=$1 AND d.coin<>$2 AND d.valid_from_block<=$3 AND o.valid_from_block<=$3 AND o.outcome='rugged'
```

### 22

src/sources.ts:206

```sql
SELECT s.coin,t.name,t.symbol,b.ts AS created,min(s.ts) AS started,sum(s.usd) AS volume
    FROM swaps s JOIN tokens t ON t.address=s.coin JOIN engine_block_times b ON b.number=t.first_block
    WHERE s.block<=$1 AND s.ts>to_timestamp($2) AND s.usd>0 AND t.name IS NOT NULL AND t.symbol IS NOT NULL
    GROUP BY s.coin,t.name,t.symbol,b.ts ORDER BY volume DESC,s.coin LIMIT 50
```

### 23

src/worker.ts:108, src/worker.ts:119

```sql
SELECT 1 FROM engine_runs WHERE coin=$1 AND block=$2 AND rules_version=$3
```

### 24

src/worker.ts:165

```sql
SELECT t.address AS coin,t.first_block,e.last_block,e.last_sec,e.price,
      (SELECT max(ts) FROM swaps s WHERE s.coin=t.address AND s.block<=$1) AS last_trade
      FROM tokens t LEFT JOIN engine_schedule e ON e.coin=t.address WHERE t.first_block<=$1 ORDER BY t.first_block,t.address
```

### 25

src/worker.ts:174

```sql
SELECT block,sec,price FROM engine_runs WHERE coin=$1 AND block<$2 AND rules_version=$3 ORDER BY block DESC LIMIT 1
```

### 26

src/worker.ts:179

```sql
SELECT min(price_quote) AS low,max(price_quote) AS high FROM swaps WHERE coin=$1 AND block=$2
```

### 27

src/worker.ts:182

```sql
SELECT 1 FROM token_transfers WHERE token=$1 AND block=$2
        UNION ALL SELECT 1 FROM pons_exemptions WHERE token=$1 AND block=$2
        UNION ALL SELECT 1 FROM liquidity_events e JOIN pools p ON p.id=e.pool_id WHERE (p.currency0=$1 OR p.currency1=$1) AND e.block=$2
        UNION ALL SELECT 1 FROM pools WHERE (currency0=$1 OR currency1=$1) AND created_block=$2 LIMIT 1
```

### 28

src/worker.ts:217

```sql
INSERT INTO engine_runs VALUES($1,$2,$3,$4,NULL,$5) ON CONFLICT DO NOTHING RETURNING coin
```

### 29

src/worker.ts:219

```sql
UPDATE engine_runs SET signal=$3 WHERE coin=$1 AND block=$2 AND rules_version=$4
```

### 30

src/worker.ts:220

```sql
INSERT INTO engine_runs VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING
```

### 31

src/worker.ts:230, src/worker.ts:245

```sql
SELECT id,signature,data FROM verdicts WHERE coin=$1 AND valid_from_block<=$2 ORDER BY (rules_version=$3) DESC,valid_from_block DESC,rules_version DESC LIMIT 1
```

### 32

src/worker.ts:231

```sql
SELECT id,hash FROM coin_cards WHERE coin=$1 AND valid_from_block<$2 AND rules_version=$3 ORDER BY valid_from_block DESC LIMIT 1
```

### 33

src/worker.ts:232, src/worker.ts:262

```sql
SELECT signal FROM engine_runs WHERE coin=$1 AND block<$2 AND rules_version=$3 ORDER BY block DESC LIMIT 1
```

### 34

src/worker.ts:251

```sql
INSERT INTO verdicts VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id
```

### 35

src/worker.ts:261

```sql
SELECT c.*,b.ts FROM coin_cards c JOIN engine_block_times b ON b.number=c.valid_from_block WHERE c.coin=$1 AND c.valid_from_block<$2 AND c.rules_version=$3 ORDER BY c.valid_from_block DESC LIMIT 1
```

### 36

src/worker.ts:269

```sql
INSERT INTO coin_cards VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id
```
