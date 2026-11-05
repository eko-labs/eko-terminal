# Launch eval runner

`pnpm evals:nightly --gate B` and `pnpm evals:nightly --gate T` select independent launch stages. The scheduled CI job runs both at 02:00 UTC; the same CLI is the application entry point. The workflow is prepared locally; it has not been installed or executed remotely. There is no provider client, credential injection, paid generation, flag mutation, signing or deployment. The manifest disables model generation with an approved budget of $0. A separately authorized, capped producer is needed for Luna generation/grading and approximately 5% Opus review; this runner never initiates that spend.

The manifest fixes commands, fixture inputs, stage membership, pass bars, merged dependencies, pending dependencies and quote-only v4. It inventories current code, rather than predicting what parallel packets will deliver. Update dependency state only after the owning packet has merged. Pending packets cannot pass through supplied evidence. Census acceptance is independent and skipped while headlines remain unavailable. D0, later-Drop and connector gates are explicitly skipped for B/T.

Each invocation writes a red checkpoint before starting, then updates its Markdown/JSON report after every suite. Use a new report basename for each attempt to retain red history. JSON contains exact argv, exit code/signal, test numerator/denominator/skips, candidate revision, sorted worktree file SHA-256s, combined worktree hash, fixture hash, dataset hash and config/lockfile hash. The final snapshot detects changes during execution. Generated reports and this packet's completion report are excluded from the candidate hash. Raw subprocess output is discarded because it can contain personal paths or provider errors; aggregate counts and exact relative commands are retained. Missing JSON results, missing selected files, skipped tests and nonzero exits fail fixture checks. Existing package timeouts are used unchanged.

Fixture passes certify the selected deterministic tests only. They cannot certify staging, archive-fork fidelity, deployed receipts, browser integration, beta observations or either launch gate. `local-B` and `final-B` retain earlier runner checks; `verified-B` and `verified-T` record the final candidate. Mandatory stage suites cannot be removed or reclassified as fixtures to produce a green report. Both gates stay red while acceptance evidence is missing. The inventory currently contains **0 genuinely labeled coins**, with gaps in all nine required classes. Synthetic coins, ABI captures and implementation reports do not supply ground truth. Populate the inventory with observed, labeled 4663 coins, decimal block numbers, block hashes, label versions and relative artifact paths with SHA-256s. Each distinct coin counts once; duplicates and invalid labels are retained as rejected indices. At least 200 distinct valid coins and representation of every class are required. Per-class minima beyond coverage are unspecified; none are invented.

## Supplying measured evidence

Place evidence and artifacts under `evals/reports/` so collection does not alter the tested source hash. Then run:

```sh
pnpm evals:nightly --gate B --evidence evals/reports/acceptance.json --report evals/reports/candidate-B.md
pnpm evals:nightly --gate T --evidence evals/reports/acceptance.json --report evals/reports/candidate-T.md
```

The input object is keyed by acceptance suite ID. Each entry supplies `candidate` (exact revision), `sourceHash`, `fixtureHash`, `datasetHash` and `configHash` from the candidate report; `source` matching the manifest; a collection `window: {from,to}` with increasing ISO timestamps; nonempty `commands: [{argv,exitCode}]`; and nonempty `artifacts: [{path,sha256}]`. All artifacts must exist within the repository and match their hashes. Commands use relative arguments without credentials, URLs, personal identifiers or home paths. Fixture sources, stale candidates, failed commands, omitted denominators and missing artifacts cannot pass. The envelope is an evidence interchange format, not an approval authority; the owning producers/operators must establish actual measured provenance.

Pass bars use these producer fields:

| Bar | Required data |
|---|---|
| `perfect` | `metrics: {total,passed,failed,skipped,missing}`; total > 0, passed = total, others zero |
| `truth` | Perfect fork results plus the genuinely labeled inventory |
| `precision` | `truePositive`, `falsePositive`, `regressions`, `missing`; nonzero classified predictions, precision ≥ 90%, no regression or missing data |
| `injection` | Perfect results, zero `regressions` and `untrustedLeaks`, measured `baitDetectionRate` and `swarmSteerRate` in [0,1]; no invented threshold for those rates |
| `latency` | `scanCohort` in the unchanged `scripts/scan-latency.mjs` format, complete staging discovery cohort and p95 ≤ 5000 ms; `metrics.preflightEligible` and every `preflightMs` sample, strict p95 < 150 ms |
| `fills` | Positive `observedOrders`, matching `classifiedOrders`, zero `honeypotFills` and `missing`; one unique `observations` row per order, with `orderId`, `label` (honeypot/clean), `outcome` (filled/refused); fills require transaction and block hashes. Unknown classifications cannot disappear from the denominator. |
| `guard` | Owned 061/062/063 report artifact, matching `packet`, `accepted`, `complete`, `denominatorsVerified`, full unchanged `gates` table with all statuses passed, and original `upstream: {datasetHash,labelHash,configHash}` |

Guard acceptance is consumed as artifacts plus the owning packet's gate table. The runner never regenerates labels, opens Guard datasets, computes Guard scores or repeats locked/live acceptance. The three original upstream hashes are retained independently of launch inventory/config hashes. The sole new `TODO(spec)` documents that 061–063 do not yet define a machine-readable envelope; their producers must provide the full table and independently verified denominator checks. Preparing this adapter does not mean those packets have passed.

B also requires staging, backfill, policy approval and restore evidence. T requires integrated harness, injection, product, measured latency and beta fill evidence. Existing legacy fork and browser commands do not certify the unmerged trade/harness/product packets. Their owning packets must deliver the complete acceptance suites before evidence is admitted. GitHub branch protection and any release authorization remain operator actions.
