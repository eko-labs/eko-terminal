# Engines worker (task 022)

Follows BACKEND §§3.2, 6.4–6.5, 7.1–7.5, 7.7, 9.5, 21.1 and FACTS §7 / CA-31 / CA-34 (lead).
Rules version 1.0.2 follows the calibrated wash and serial-deployer thresholds in §§7.2–7.3. Serial history excludes its own matches: launch spam stays Monitor, while Danger needs three distinct priors with matured bad outcomes or another playbook at Danger. Outcome horizon time and availability block prevent replay lookahead.
CA-32 adds feed fields; this worker does not publish feed/API/WebSocket payloads (task 023).

From the workspace root, use the **same absolute directory** used to fill the indexer database:

```sh
export pnpm_config_verify_deps_before_run=false
export PGLITE_DIR="$PWD/.data/indexer"
APP_ROLE=engines pnpm --filter @eko/engines start
APP_ROLE=engines ENGINE_MODE=replay FROM=77438503 TO=77438550 pnpm --filter @eko/engines start
```

Replace the replay bounds with the inclusive indexed range. Finish/stop the indexer before opening its local
PGlite directory in this process. A PGlite in-process bus is available on a shared `ChainDb`; the CLI polls durable
coin activity (launches, swaps, transfers, liquidity and Pons events) and persists per-coin progress. Backfilled rows
work even when `chain_blocks` is empty. Production uses `DATABASE_URL` and Postgres LISTEN, with polling as fallback.
Optional `RPC_HTTP_URL` enables block-stamped archive Pons reads and missing block timestamps; its chain ID must be 4663. Without RPC or cached
reads, taxes and anti-snipe remain unknown. Exemption holdings/history can still be evaluated from indexed rows.
Live catch-up: a lagging live poll used to replay every historical checkpoint for every coin in block order. Each
uncached checkpoint reloads the coin's history, rebuilds holders from transfers (later transfers exist, so the
balance fast path is unusable), scans the hourly market twice and makes the Pons archive reads, so lag made every
evaluation slower and new launches waited behind hours of backlog showing "Scanning…". Now:

- `ENGINE_LIVE_BACKLOG_SEC` (default 900, 60–604800): checkpoints further than this behind the indexed head are
  coalesced; the coin is evaluated at its recent checkpoints, or once at head if all were stale. 604800 keeps full
  catch-up. `ENGINE_MODE=replay` over the skipped range fills the history later (existing runs are skipped).
- Coins with no card yet (first scans) run before refreshes of scanned coins, newest launch first; each coin's own
  checkpoints stay in block order. Replay order is unchanged.
- `ENGINE_LIVE_SLICE_MS` (default 60000): after this long, a poll yields once first scans are done if a token was
  indexed beyond its head, so that launch is scanned next. Only coins whose checkpoints all ran advance their progress.
- The hourly market-rank read is shared by every evaluation at the same block within a poll.
- `ENGINE_STALL_SEC` (default 600, 60–86400): a live loop with no completed poll and no finished evaluation for
  this long logs `engines_stalled` and exits 1, so the platform restarts it instead of leaving it hung.
- `engine_evaluation` logs a live poll's evaluation phase every minute, with or without completed cards, and at its
  end: tasks attempted, skipped (run exists), failed (sources unavailable) and completed, outcome horizons evaluated,
  whether outcomes are still catching up, and the current phase (`sources`, `write`, `outcomes`).
- Outcomes catch up at most eight horizon evaluations per card write (oldest launches first; later writes and polls
  continue). After an outage the first write used to evaluate every launch's passed horizons inside its transaction
  (2026-10-09: about 34,000 coins), so no card committed for hours.
- `live_planned` logs the task count, first scans and coalesced checkpoints when it coalesces or has more than ten
  first scans queued.

`pnpm --filter @eko/engines exec node --import tsx test/live-catchup-benchmark.ts` compares one lagging live poll
with and without coalescing on a timestamped PGlite fixture (`BENCH_SWAPS`, `BENCH_HOURS` resize it).

Live activity reads (`src/live-activity.ts`, migration 0189). Until 2026-10-08 every live poll aggregated every swap,
transfer, liquidity and Pons event of every coin and loaded every block time: minutes per poll under load, then an
out-of-memory crash on the first poll after a restart. A live poll now reads what changed since the previous poll, and
plans exactly the checkpoints a full-history read plans (`test/live-activity.test.ts` runs both side by side):

- Every coin's rows above the previous poll minus 256 blocks (the indexer's reorg window) are re-read by block.
  `engine_activity_changes`, written by statement-level triggers, reports every other write: rows written, rewritten or
  deleted at older blocks (backfills, sender enrichment, retention), pool and launch changes, and block times. Readers
  follow it by transaction snapshot; it keeps a day of rows and is written only while a live engine follows it
  (`engine_activity_feed`).
- A coin's revision is a sum over its activity rows, so `engine_activity_state` keeps the sum and newest event time of
  its rows below the window (`base_block`, `base_sum`, `base_sec`, `last_sec`) and the next poll, or the next process,
  adds the rows above. A changed coin without a usable base is summed once in the database.
- Plans resume after the coin's newest block at or below its previous plan with non-swap activity and a stored time:
  that checkpoint does not depend on anything earlier, so its state comes from a few indexed reads.
- A new process takes the watermark from `engine_activity_feed` and the coins active in the last seven days from
  `last_sec`; it holds eight days of block times, read by block range. The first start without a live log (this
  deploy, or a day without a live engine) also fills every missing block time once and takes recent coins from the
  activity tables by time; coins written before this change keep their revision until they next change.
- The block-time cache keeps the newest re-read range and at most 100,000 entries; every reader falls back to the
  database. Replay still reads every coin's whole history and every block time, as before.
- `ENGINE_LIVE_ACTIVITY=full` (default `incremental`) restores the whole-history read for live polls; it only suits
  small databases. `live_activity` logs a refresh that started cold, summed a base in the database or took 10 s.

`pnpm --filter @eko/engines exec node --import tsx test/live-activity-benchmark.ts` reads one live poll's activity over
the same recent activity on top of growing older history (`BENCH_SCALES`, default `1,4,16`). On a local PGlite run:

| Older history | History rows | Full read ms / rows | Incremental warm poll ms / rows | New process ms / rows |
| ---: | ---: | ---: | ---: | ---: |
| 1x | 25,307 | 160 / 25,407 | 6 / 40 | 7 / 375 |
| 4x | 85,353 | 541 / 85,644 | 7 / 40 | 7 / 375 |
| 16x | 325,353 | 2,109 / 326,244 | 12 / 40 | 13 / 375 |

`test/live-bounds.test.ts` requires a warm poll and the first poll of a new process to read the same rows over one and
five times as much older history. With these reads a normal live poll finishes well within the default
`ENGINE_STALL_SEC` of 600; the first start after deploying migration 0189 also fills missing block times once.

Live sell checks (BACKEND §6.2, the "probe through `eth_call` with a state-override set" fallback; off by default):

- `SELL_CHECK_ENABLED=true` with `RPC_HTTP_URL`, live mode only. One `eth_call` per size runs the never-deployed probe
  (`packages/chain/probe/BwProbe.sol`, or `V4Probe.sol` for native-ETH v4 pools) at the indexed head block, with only
  the probe's code and ETH balance overridden. Routes come from indexed rows: the Pons curve until graduation, then the
  graduated pool, else the native-ETH v3/v4 pool with the most USD volume in the last day. Sizes are $100 and $1,000 at
  the indexer's own ETH-USD (recent ETH-quoted swaps); no price means no check.
- A coin is checked once it is 30 s old, then again only after new activity (at most every
  `SELL_CHECK_MIN_INTERVAL_SEC`, default 600), after `SELL_CHECK_MAX_AGE_SEC` idle (default 86400), on graduation, or
  15 min after a provider failure. `SELL_CHECK_BATCH` (default 8) coins per `SELL_CHECK_POLL_MS` (default 5000) tick.
- Cost: 2 paid requests per check, plus 1 when a Pons curve sell fails (to rule out graduation closing the curve).
  `SELL_CHECK_DAILY_REQUESTS` (default 60000) caps it per UTC day; the process budget still applies, and an exhausted
  budget pauses the checks until the next UTC day.
- Results: `sell_check_latest` (one reading per coin; a provider failure keeps the earlier reading of the same route),
  `sell_check_runs` (every check, kept 30 days). `refused` means a buy went through and the sell reverted or returned
  under 5%; it is a contract-probe result, not the deep-simulated `honeypot` playbook match, which is unchanged.

`ENGINE_CONCURRENCY` defaults to 4 (1–32); `ENGINE_POLL_MS` defaults to 2000. SIGINT/SIGTERM finish the current
coin evaluation, drain in-flight reads and close the database. Replay prints `replay_complete` or `replay_interrupted`
with evaluations/s, elapsed time, RPC call counts by method, and wall-time shares for source loading, writes and
RPC (RPC time overlaps source loading), plus evaluation count, distinct coins evaluated in this invocation, verdict counts by level, and playbook counts by
level (one count per coin's final evaluated match). Repeated signals keep the shutdown handler active while draining.

`ENGINE_MODE=replay` selects coins launched or active in the inclusive range and evaluates their checkpoints in
ascending block order: t0, +2 s, +10 s, +60 s, +5 min, meaningful activity, then every 10 min while traded in the
last hour, hourly otherwise, stopping after 7 idle days. Deadlines map to the first observed block at/after the time,
bounded by `TO`. Indexed event timestamps establish an engine-owned clock; missing launch/Pons/pool timestamps
require `RPC_HTTP_URL` archive headers and cause an explicit error when unresolved. Swaps/transfers/liquidity rows
and actual stored Pons/pool timestamp fields seed the clock first. Genuine gaps are deduplicated by block, fetched
in JSON-RPC batches of up to 50, and cached in memory and `engine_block_times`. Legacy Pons/pool rows with no
timestamp still require this fallback. No head-follower rows or hashes
are fabricated. Each read is bounded to its historical block;
balances are reconstructed when current balances contain future transfers. Historical supply samples are used only
at/after their sample block. Replay assumes the canonical input range has finished indexing. Repeating a complete
range preserves identical rows; completed coin/block runs are skipped after interruption. Replay does not advance
the live cursor. Live startup catches up every coin active in the last 7 days, then follows activity and cadence.
Replay batches load each coin’s swaps/liquidity/transfers once through `TO`, take block/time windows by binary search, and advance
holder balances, counts, burned/curve inventory, bought amounts and curve volumes from deltas. A deterministic
balance tree supplies top-ten holdings without a full holder sort. Active-hour actor buckets supply dominant
actor volumes without filtering the hour once per actor. Address strings and timestamps are normalized once
per loaded row. Timestamp anomalies preserve block/log order through the conservative filtering fallback.
Full historical arrays are lazy and only needed by horizon outcomes; ordinary card evaluations never copy them. Replay market ranks use a shared sliding one-hour priced-swap window, advanced in task order. Running per-coin exact binary USD sums expire by timestamp; active coins sort by bigint sum then address, without rounding or float-tie guards. Creation-time trending snapshots stay cached once per creation block for the whole replay. A 256-block LRU retains recent rank results. Live reads load the priced hourly rows in one query and use the same exact-sum ranking rule. Historical replay requests recompute exact ranks from already-loaded rows without SQL. Both loaders exclude non-finite USD values; the window defensively filters them too. Indexed swap timestamps retain sub-millisecond precision in the market window. The worker caches run
identities, prior verdict/card/Signal state and block-time searches; caches are discarded after the replay.
`replay_planned` reports the scheduled task count, distinct coins and inclusive bounds before evaluations begin.
`engine_progress` reports throughput, time shares, RPC counters and `rssMb` every 100 evaluations or 30 seconds.
Coin histories/aggregates are evicted after the final activity’s seven-day idle horizon; shared deployer/outcome
history remains available to later launches.

Migration 0106 scopes run progress, immutable card versions and deployer history to the rules version. A replay over
earlier rules data evaluates 1.0.2, preserving old rows while excluding obsolete matches from the current serial history.

Engine migrations use a separate `eko_engine_migrations` ledger; the indexer migration ledger is unchanged.

Tables written:

- Normalizer: `coin_cards`, `coin_card_latest`, `owner_powers` (template tax fact only), `code_templates`.
- Playbooks: `playbook_matches`, `verdicts`, `verdict_events`, `deployer_stats`, `outcomes`.
- Worker state: `engine_cursors`, `engine_schedule`, `engine_runs` (historical cadence and Signal clock), `engine_reads`
  (Pons reads, including unavailable results), `engine_block_times` (observed times, optional actual header hash),
  `engine_activity_state` (per-coin activity revision, processed range and live progress base), `engine_activity_feed` and `engine_activity_changes` (live change log, migration 0189). `engine_pons_static` (fixed profile facts and canonical first-read anchor). Migrations 0104–0108 are applied automatically.

`coin_cards` are immutable hash-change versions; `coin_card_latest.data` carries the current observation stamps,
including when content did not change. `freshness.ageSec` is zero in stored assemblies: task 023 sets it when served.
Notifications contain row IDs/coin addresses only. Signals are descriptive and do not feed ranking or guard decisions.

Playbooks available from today's sources:

| Playbook | Available inputs / limitation |
| --- | --- |
| `tax_trap` | Fixed Pons tax, archive read/cache; inactive anti-snipe required. Generic mutable tax waits for §6.3. |
| `exempt_insiders` | Exemption logs, supply, swaps, observed balances, wallet's own prior deployer rugs; crew history waits for §5. |
| `wash_to_trend` | At least $10k/hour, counting only wallets with ≥ 2 disjoint qualifying round trips; the high-volume/few-trader branch shares the volume floor. |
| `clone_swarm` | Launch-time USD trending snapshot and normalized identities; actor concentration can escalate. |
| `fee_trap_pool` | Indexed fixed pool fees; reserve-backed deepest pool can escalate. Dynamic fees remain unknown. |
| `removable_liquidity` | Observed position owner/share and prior removals; unknown depth does not trigger thin liquidity. |
| `migration_dump` | Graduation marker, deployer/exempt holdings before graduation, sells within five minutes. |
| `agent_bait` | Sanitized name/symbol evidence from the untrusted detector. |
| `serial_deployer` | Prior launches, matches and horizon outcomes, bounded to the historical block. |

Deferred: `honeypot` waits for the simulation packet (§6.2); `malicious_hook` waits for reviewed hook/owner analysis
and quote/simulation inputs (§6.1–6.3); `stuck_at_bonding` and `bundle_dump` wait for wallet funding/crew clustering
(§5). Full crew-dependent escalation for other rules also waits for §5. Missing source sections are absent from
rule inputs, and a no-match verdict is `pending` until all required checks can run. Missing identity/deployer metadata
prevents assembly rather than inventing identity values.

CA-34 (ratified by the lead): `Verdict.level = 'pending'`, optional
`evaluatedPlaybooks: PlaybookId[]`, and section-meta `unavailable`, `missing`, `flags` (including `supply_anomaly`).
Existing CoinCard requires numeric/boolean fields even for unavailable sections. Those structural zero/false fields
are explicitly masked by metadata; they are not observations and must not be rendered as completed checks.
Policy preflight refuses pending buys and unavailable inputs needed by active limits. The terminal and Mission journal
render pending verdicts as checking. Other API/UI field displays must honor availability metadata. Supply anomaly omits any market-cap output.

Other `TODO(spec)` decisions: reviewed Pons owner-power profile; exempt-wallet rug history uses only its own
observed deployer history until crews exist; trend onset is approximated by the first trade in the launch-time
hourly window; dominant pair means leading buy/sell actors' combined volume; hash scope excludes timestamps/block
stamps and receipt identity; multi-pool LP aggregation needs observed reserve USD, otherwise it stays absent;
`survived` requires observed price/liquidity and does not certify unrun checks. Known locks/vesting and complete
transfer coverage are not indexed, so supply confidence is partial. Anti-snipe end timing is unavailable.
Migration 0107 persists fixed creator tax, fee and token code by coin, invalidating them when the first-read
block hash changes. The RPC budget is three fixed reads plus one anti-snipe read per checkpoint until the first
canonical zero: four total if zero initially; seven for three nonzero checkpoints followed by zero, even across
50 checkpoints. `TODO(spec)`: anti-snipe tax is non-increasing, so observed zero can be reused at later blocks.
Missing or failed reads remain unavailable; failures suppress repeated RPC attempts for the current DB session.
An earlier requested block cannot use facts first read at a later block. Historical clock gaps still cost one
header request per missing block, shared across coins.

A changed canonical cursor hash halts processing for explicit derived-history reconciliation; reorg correction/version
identity needs a later contract decision, and existing verdict history is never deleted.

Tests cover real Pons fixtures and synthetic threshold boundaries, cadence, pending coverage, notification rollback,
version events, hash stability, supply anomaly, Signal cooldown, horizon outcomes and replay determinism on PGlite.
No personal identifiers were ported into new source/mock values; neutral token names are used.

Reproduce the fractional dense-hour PGlite benchmark (300 coins: 200 active with 3,000 swaps and 2,200
holders each, plus 100 sparse coins with one trade/hour; 12 hours, 22,050 evaluations, no network).
Thirty percent of active trades draw from fixed sizes `394.12`, `25`, `0.37`; the rest use varied fractional
USD values. Sparse coins use the same fixed sizes and create many exact ties.

```sh
pnpm_config_verify_deps_before_run=false pnpm --filter @eko/engines exec node --import tsx test/replay-benchmark.ts
```

The benchmark counts SQL-rank/reference calls, asserts zero unconditionally, and reports in-memory historical
rank reconstructions. `BENCH_MARKET=live` disables the replay market window and exercises the shared live row-read
path; `BENCH_CACHE=off` disables all replay source caches. Neither path uses SQL float ranking.
The benchmark includes planning/cache setup in overall elapsed time. First/last 10% rates use evaluation
callbacks; the first window includes cold per-coin loads and the last window has warm caches.

| Source path, same fractional fixture | SQL-rank/reference calls | First 10% / s | Last 10% / s | Whole replay / s |
| --- | ---: | ---: | ---: | ---: |
| 022f float guard | 3,591 | 53.7 | 186.1 | 130.9 |
| 022g exact sum | 0 | 83.1 | 423.9 | 295.9 |

These archived throughput measurements used rules 1.0.1; the lead reruns production data under the current rules. No header/profile RPC was used.
The previous `reference()` branches were ambiguous fractional comparisons, non-finite sums, and historical
requests. All three SQL-reference branches are removed, so each has zero SQL fallback calls on the final benchmark.
Historical requests use an in-memory exact reconstruction instead (0 requests in the final run).
Creation-time metadata/trending snapshots remain ordinary once-per-creation-block SQL reads, not rank fallbacks.

Tests compare every stored verdict, card, playbook match and run (plus outcome/history/event rows) across
cached, uncached, repeated and resumed replays with repeated fractional trade sizes. Randomized dense fractional
checkpoints compare live exact ranks with the replay window; known near-ties and order permutations prove exact
sum/address ordering independently of PostgreSQL float accumulation. SQL remains a test-only oracle on integer
fixtures without ambiguous ranks. Timestamp anomalies, microsecond edges, non-finite amounts and retrospective
requests are covered. Missing or failed checks remain unavailable and pending coverage is unchanged.

Migration 0108 adds five indexes for hourly priced swaps, wallet/deployer history, rugged outcomes, versioned
run startup and versioned deployer bootstrap. [The complete 36-statement EXPLAIN audit](QUERY-PLANS.md) includes
before/after plans and a reproducible disposable-PGlite audit command. On its vacuumed fixture:

| Query | Before ms | After ms | Scan change |
| --- | ---: | ---: | --- |
| 022f float-rank SQL (now test-only) | 3.395 | 2.549 | Heap/bitmap → covering index-only |
| Creation trending snapshot | 6.513 | 5.207 | Swap heap/bitmap → covering index-only |
| Exemption rug history | 4.391 | 2.256 | Outcome sequential scan → rugged partial index-only |
| Run startup | 15.459 | 5.046 | Sequential → version/block index-only |
| Deployer bootstrap | 15.782 | 9.082 | Sequential → version/block bitmap |

EXPLAIN timings are single local samples, not production latency estimates. No new spec assumptions are introduced
by the sliding window or indexes; BACKEND §6.5 replay order and §§7.2–7.3 historical inputs remain unchanged.

`ENGINE_WATCHER_REFRESH_ENABLED=false` (default `true`) pauses fingerprint and flow refreshes, including replay,
with one `watcher_refresh_paused` log per process. Restart engines after changing the service environment.
Pause before installing 0206, then run `scripts/backfill-watcher-buyers.sql` before enabling refreshes.
The backfill commits one coin at a time and shares the source triggers’ coin mutex.
Live refreshes rotate through four wallets, process eight original snapshot cuts per wallet, and pause 100 ms
between wallets. Each wallet reads at most 3,400 swap candidates (200 revision rows plus eight samples of 200
and at most 200 indexed own-first buys per cut). Remaining cuts resume on subsequent refreshes.
