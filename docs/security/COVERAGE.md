# Core line coverage

Candidate: base commit `532423b95c849b174eb594fc593ce583862ddd19` plus the uncommitted audit Path 1 packet, 2026-10-03. This is worktree evidence, not a committed release. The final source/config/test fingerprint and exact counters below identify the measured candidate. Input fingerprint: `cd74b4496fa575d523e7474b65b0ff6d804374e6ce5efd413d8404b0798babc8` (773 files). `coverage/candidate-manifest.json` records the base, input path selectors and sorted repository-relative `[path, file SHA-256]` pairs; the fingerprint is SHA-256 of that compact JSON array. It covers production source/tests/config/package manifests in all fourteen non-UI workspaces, root coverage/toolchain/lock inputs and authored Solidity source/tests/config/test runner; documentation and generated reports do not change it. No production runtime source changed in this packet.

## Denominator rule

The executable TypeScript denominator is V8's `total.lines.total` in `coverage/typescript/coverage-summary.json`, for every production runtime file matched by `coreFiles` in `vitest.coverage.config.ts`, including files never imported by tests. Do not substitute source line counts, average percentages, or remove uncovered core files. Core means implemented user/session/platform authentication and identity binding; private-data ownership/disclosure and keys; execution authorization, unsigned transaction construction and settlement/accounting; and receipt commitment/proof integrity. Prepared or transport-disabled implementations count. Whole files with mixed responsibilities count conservatively. Public market/research analytics without these decisions are outside this denominator. The census includes:

- Server app/config/role and database wiring, feature and provider-spend gates, account/referral reward accounting, review-assignment authorization, public share disclosure, private bags, watch/alert ownership and WebSocket subscriptions; execution (`exec/*`), harness (including transactional preflight, private journal, OAuth consent and tokens), HTTP authentication, the mixed legacy router, v1 account/agent/journal/receipt/trade/OAuth/Telegram/RPC/telemetry routes, session-dependent config and scan attribution, dev fixture ownership gates, launch monitoring, security collectors and worker wiring, sanctions and proxy trust.
- Operator backup/restore key-handling CLI, stream error containment and restore integrity/isolation checks; these count despite being operator-only.
- Telegram link/delivery services, including code expiry/reissue/replay, identity uniqueness and final owner/preference/lease rechecks. All Telegram, X and Farcaster bot runtime files include webhook verification, private-DM identity binding, HMAC storage, managed-signer checks, quota/lease/replay fencing and disabled transport adapters.
- MCP transport, runtime, OAuth, tool registry and read/harness wiring.
- Indexer canonical ingest, decoding, sender/receipt attribution, metadata, pricing, rows, reorg/backfill, scan acquisition, registry and wallet protocol accounting, and bounded evidence snapshots.
- Database receipt committer/outbox/API/anchors, guard/ghost-report proof integrity, review assignments and launch monitoring, journal/destruction crypto, connection/transaction and notification boundaries, indexer market accounting, migrations, locking and binary encoding.
- Policy runtime, including actual-order evaluation; chain execution, registry/actor/ABI/decoder and RPC boundaries, verification/build-record binding and executable v3/v4/Pons simulation helpers; the existing shared canonical/schema/contract runtime census.
- The production receipt signer CLI and worker, retained because the CLI loads signing material; public receipt payload construction and the independent receipt verifier (its substantive `index.ts` is included).

UI (`apps/web`) is out of scope and no web test project is instrumented. Re-export-only barrels and interface-only server execution/indexer `types.ts`, test fixtures, dependencies and generated code do not contribute executable core lines. There is no blanket `**/index.ts` exclusion: the server v1 registration and independent verifier contain executable security decisions and count. Production dev fixture gates count too. MCP/indexer process entry wrappers are excluded explicitly; their substantive runtime implementations remain in scope. Database `types.ts` contains executable binary encoding and remains included. The full mixed legacy router and execution services stay included.

Solidity adds **all executable lines reported by `forge coverage --exclude-tests --include-libs`** for the authored registry and inherited OpenZeppelin ownership. The existing exclusions remove deployment scripts, test/vendor harnesses and unrelated utility implementations, never registry or ownership code. Inherited single-step ownership lines remain in the denominator even though the registry overrides that method.

The aggregate is **100 × (TS covered + Solidity covered) / (TS total + Solidity total)**. It is a weighted executable-line ratio, not an average of file or language percentages. `scripts/coverage.mjs` writes exact counters to `coverage/core-summary.json` only after both instrumented suites succeed and exits nonzero when the aggregate is below 95%. Failed runs cannot establish the target; old aggregate output is removed before each run.

## Reproduction and instrumentation

```sh
VITEST_MAX_WORKERS=2 node scripts/coverage.mjs
# Equivalent root script:
VITEST_MAX_WORKERS=2 pnpm coverage
# Individual measurements (do not run concurrently into the same report directory):
VITEST_MAX_WORKERS=2 pnpm exec vitest run --config vitest.coverage.config.ts --coverage
pnpm --filter @eko/contracts coverage
```

The installed V8 provider and Vitest are both **5.0.2**; the runner requires exact version equality. No dependencies were added by this packet. Ten workspace test projects (adding `apps/bots` and `packages/receipts-verifier`) run from their package roots. Coverage-only `testTimeout` is **300,000 ms** to accommodate V8 overhead in seeded analytics and database suites (including outcome labels, sampling/incidents, Scoreboard and dense indexer replay). Normal-suite timeouts are unchanged. The dense indexer test's explicit 120,000 ms override uses 300,000 ms only when `EKO_CORE_COVERAGE=1` is injected by the coverage project; the ordinary invocation retains 120,000 ms and all benchmark assertions.

Existing coverage-only exclusions remain: timing-budget tests (`performance*.test.ts`), optional live fork tests, and the engines CLI child-process test. They still run in the ordinary suite under its existing settings; child processes are not instrumented by the parent. No existing assertion was weakened and no new test is assertion-free.

Generated TypeScript text, JSON summary and LCOV are under `coverage/typescript/`; the Solidity transcript is `coverage/contracts-summary.txt`; combined counters are `coverage/core-summary.json`. Generated reports are ignored and not committed. Solidity measurement uses Forge **1.7.1**, solc **0.8.26**, offline compilation with instrumentation's optimizer/viaIR settings.

## Behavior added for audit Path 1

Existing negative tests remain intact. Added assertions exercise webhook-secret rotation before durable claims (Telegram and Farcaster), stable cross-restart replay identities, group-scoped and platform-specific HMAC keys, malformed configuration/author refusals, X lease expiry and stale-owner cursor/release fencing, wallet-only link issuance, same-sender code reissue without cancellation, replay refusal, corrupt Telegram sender suppression, and post-claim agent-trade threshold changes. Injected-tool backup tests assert WAL replay/conflict, ciphertext/restore checksum refusal, isolated target ownership, overwrite/path-escape refusal and fixed-error containment. They establish wrapper behavior, not age cryptography or real Postgres/PITR acceptance. Existing suites also assert Telegram expiry/reissue/foreign identity conflicts/unlink; bags owner-only reads/shares/redaction; watch ownership and replay; share metadata/private receipt refusal; OAuth owner binding, expiry, PKCE, refresh rotation and reuse detection. No assertion-free coverage tests, weakened assertions or normal-suite timeout changes.

## Explicit exclusions

The following is the complete production TypeScript exclusion inventory in the fourteen non-UI audit workspaces, grouped only where the same reason applies. Filenames are relative to the listed directory; every omitted file is named. This inventory describes the candidate, not a promise that a future file is non-core. New identity/key/settlement implementations must extend `coreFiles` even when transport-disabled. Dependencies, test files and generated outputs are excluded separately from production runtime; all coverage include patterns count unimported matches.

| Directory | Excluded files | Reason |
| --- | --- | --- |
| `apps/server/src/ai/providers` | `anthropic.ts`, `chat.ts`, `gemini.ts`, `responses.ts` | Model provider adapters; no account authentication, keys or transaction settlement. Provider spend authorization is included in `ai/budget.ts`. |
| `apps/server/src/ai` | `registry.ts`, `swarm-worker.ts`, `types.ts` | Model routing/research worker and interfaces; advisory outputs, no user execution or identity binding. |
| `apps/server/src` | `build-identity.ts`, `dev.ts`, `index.ts`, `launch.ts` | Build-identity metadata and process/dev dispatch wrappers. Substantive startup gates/configuration, HTTP/WS auth wiring and role lease decisions are included in `config.ts`, `app.ts`, `roles.ts` and the indexer/engine runtimes they call. |
| `apps/server/src/db` | `migrate-cli.ts`, `schema.ts` | Declarative Drizzle schema and migration command wrapper; adapter/migration execution is included in `db/client.ts` and DB runtime. Schema creation and SQL constraints remain exercised by migrated storage tests. |
| `apps/server/src/exec` | `types.ts` | Interface-only types; no executable lines. |
| `apps/server/src/http/v1` | `defaults.ts`, `demo-token-cli.ts`, `drop-manifest.ts`, `health.ts`, `packs.ts` | Static defaults/drop manifests, public health/pack listing and demo-token command wrapper. Token signing/validation and flag parsing implementations are included in `demo.ts` and `flags/service.ts`. |
| `apps/server/src/http` | `v2-guard.ts` | Public Guard read projections without user identity/private access or execution authorization. |
| `apps/server/src/market` | `candleStore.ts`, `demoFeed.ts`, `rng.ts`, `service.ts`, `stored.ts`, `types.ts` | Public market data, demo feed and candle projections; portfolio/fill/accounting and execution guards are included. |
| `apps/server/src/obs` | `errors.ts`, `launch.ts`, `logger.ts`, `metrics.ts`, `telemetry.ts` | Generic logger/error/metrics/latency plumbing and launch metric storage adapter. No auth/key/settlement decisions; launch-monitoring HTTP/schema/DB security decisions and incident/security workers are included. |
| `apps/server/src/ops` | `census-eval-cli.ts`, `ghost-reports-cli.ts` | Operator public analytics/report-generation command wrappers; no user identities, private keys or transaction settlement. Backup/restore wrappers are included because they mount operator key material and load journal KEKs. |
| `apps/server/src/quant` | `service.ts` | Advisory indicators; no account authorization or transaction preparation/settlement. |
| `apps/server/src/read` | `coins.ts`, `feed.ts`, `guard-card.ts`, `guard-compat.ts`, `guard-consumers.ts`, `guard-store.ts`, `live.ts`, `pagination.ts`, `pairs.ts`, `radar.ts`, `scan.ts`, `scoreboard.ts`, `senses.ts`, `store.ts` | Public analytics/card/feed/scan/scoreboard projection and storage helpers; no private-account authorization. Bags ownership/redaction and receipt-reader binding are included; session scan attribution is included at the HTTP boundary. |
| `apps/server/src/swarm` | `cli.ts`, `paper.ts`, `runner.ts`, `source.ts` | Advisory research/paper simulation and operator wrapper; not user execution or private keys. |
| `apps/engines/src` | `acquisition-run-cli.ts`, `acquisition-run.ts`, `activity.ts`, `aggregates.ts`, `attribution-coverage.ts`, `buyer-benchmark-cli.ts`, `buyer-benchmark-input.ts`, `buyer-benchmark-pons.ts`, `buyer-benchmark.ts`, `campaign-replay.ts`, `card.ts`, `cli.ts`, `control-acquisition.ts`, `control-observations.ts`, `control-profile.ts`, `control-profiles.ts`, `coverage-pilot-cli.ts`, `coverage-pilot-store.ts`, `coverage-pilot.ts`, `curve-progress.ts`, `development-fit-cli.ts`, `development-fit-statistics.ts`, `development-fit.ts`, `directional-depth.ts`, `graduation-inventory.ts`, `grouped-coverage-input.ts`, `grouped-coverage.ts`, `guard-performance.ts`, `identity-v2.ts`, `incremental-guard.ts`, `index.ts`, `label-completion-cli.ts`, `label-completion.ts`, `live-shadow-cli.ts`, `live-shadow.ts`, `locked-test-cli.ts`, `locked-test-statistics.ts`, `locked-test.ts`, `lot-arithmetic.ts`, `lot-input.ts`, `lot-metrics.ts`, `lot-selling.ts`, `market.ts`, `matched-source.ts`, `metrics.ts`, `outcome-input.ts`, `outcome-labels.ts`, `outcome-queue.ts`, `outcomes.ts`, `pons-profile.ts`, `pons-reference.ts`, `probability-sample.ts`, `qualified-graph-input.ts`, `qualified-graphs.ts`, `reference-simulation.ts`, `registry-labels.ts`, `replay-cache.ts`, `sampling-and-incidents-cli.ts`, `selective-backfill-cli.ts`, `selective-backfill.ts`, `shadow-observations.ts`, `shadow-v2.ts`, `signal-v2.ts`, `sources.ts`, `supply-v2.ts`, `v4-reference.ts`, `worker.ts` | Public token/market attribution, evidence acquisition, Guard analysis, research fitting and worker projections; token launch/control identities are chain evidence, not user authentication. Receipt payload construction and production signer/committer remain included. |
| `apps/engines/src/swarm` | `calibration.ts`, `index.ts` | Research calibration or re-exports, not user auth or executable settlement. |
| `apps/engines/src/swarm/personas` | `v1.ts` | Advisory persona constants. |
| `apps/engines/src/watcher` | `calldata.ts`, `evaluate.ts`, `features.ts`, `flow-store.ts`, `flow.ts`, `score.ts`, `store.ts` | Public flow/label/evidence classification and storage; no user authentication or transaction execution. |
| `apps/mcp/src` | `cli.ts` | Process/command entry wrapper; substantive runtime is instrumented. No independent auth/key/settlement logic. |
| `apps/mcp/src` | `index.ts` | Re-export-only barrel. |
| `apps/indexer/src` | `backfill-gate-cli.ts`, `cli.ts` | Process/command entry wrapper; substantive runtime is instrumented. No independent auth/key/settlement logic. |
| `apps/indexer/src` | `index.ts` | Re-export-only barrel. |
| `apps/indexer/src` | `types.ts` | Interface-only types; no executable lines. |
| `apps/bots/src` | `index.ts` | Re-export-only barrel; every substantive bot module is included. |
| `apps/og-renderer/src` | `index.ts`, `runtime.ts`, `sample.ts` | Deterministic public image/layout generation and sample tool; no private-account reader, identity binder or signer. Share disclosure/authorization decisions are included at server boundaries. |
| `packages/db/src` | `engines-schema.ts`, `flow-read.ts`, `flow-schema.ts`, `guard-schema.ts`, `guard-store.ts`, `index.ts`, `migrate-cli.ts`, `receipt-schema.ts`, `registry-schema.ts`, `scan-jobs.ts`, `scan-schema.ts`, `schema.ts`, `wallet-protocol-schema.ts` | Declarative schema/migration data, public analytics/Guard evidence/scan queue storage and re-export/wrapper files. Private identity/crypto/review and receipt verification/commitment/settlement storage remain included; these excluded modules do not authenticate users or hold/sign user funds. |
| `packages/chain/src` | `abi-pull-cli.ts`, `abi-pull.ts`, `index.ts`, `verify-cli.ts` | ABI acquisition tooling, re-export barrel and verifier process wrapper. Address/ABI runtime, verification/build binding and execution implementations are included. |
| `packages/chain/src/control` | `collector.ts`, `fork.ts`, `types.ts` | Token authority evidence and fork diagnostics, not application caller authorization or user transaction settlement. |
| `packages/chain/src/custody` | `collector.ts`, `ticks.ts`, `types.ts` | Public pool custody/tick evidence collectors and interfaces; no application custody or user signing. |
| `packages/chain/src/funding` | `acquisition.ts`, `diagnostic.ts`, `provider.ts` | Public historical funding-flow attribution and acquisition diagnostics, not application fees or user settlement. |
| `packages/chain/src/launchpads` | `flap.ts`, `klik.ts`, `launch-roles.ts`, `occupy.ts`, `pons.ts`, `principal-services.ts`, `trace-acquisition.ts`, `trace-principals.ts`, `types.ts` | Public token launch/role/principal provenance collectors and interfaces. These identities are token chain evidence, not authenticated application accounts or managed bot signers. |
| `packages/chain/src/simulation` | `campaign-input.ts`, `campaign-pressure.ts`, `campaign-replay.ts`, `depth-removal.ts`, `depth-run.ts`, `depth-v3.ts`, `depth.ts`, `directional-depth.ts`, `fork-check-cli.ts`, `fork-gateway-cli.ts`, `fork-gateway.ts`, `fork-manifest-cli.ts`, `fork-manifest.ts`, `fork-runtime.ts`, `pons-fork-cli.ts`, `probe-runtime.ts`, `types.ts`, `v4-probe-runtime.ts` | Public diagnostic depth/campaign/fork evidence, interfaces, CLI wrappers and generated probe bytecode. Actual unsigned execution and supporting v3/v4/Pons route/math/RPC helpers remain included. Generated probe constants have no authored TypeScript decisions. |
| `packages/policy/src` | `index.ts` | Re-export-only barrel. |
| `packages/shared/src` | `backtest.ts`, `census-gate.ts`, `drops.ts`, `flags.ts`, `format.ts`, `index.ts`, `indicators.ts`, `markets.ts`, `strategies.ts`, `telemetry.ts`, `time.ts`, `workspace.ts` | Public market/analytics/presentation/flag/drop/telemetry constants and helpers, re-exports and workspace types. Authentication, identity, transaction, receipt and privacy boundary validators remain included. |
| `packages/shared/src/contracts` | `backtest-result.ts`, `burn.ts`, `bus.ts`, `coin.ts`, `feed.ts`, `ghost-reports.ts`, `guard-card-api.ts`, `guard-consumers.ts`, `guard-copy.ts`, `guard-history.ts`, `guard-lots.ts`, `guard-scoring.ts`, `guard-storage.ts`, `guard-supply.ts`, `guard-transport.ts`, `index.ts`, `labels.ts`, `loop.ts`, `mcp-senses.ts`, `research.ts`, `scoreboard.ts`, `swarm.ts` | Public analytics/research/card/evidence schemas or re-export-only barrel; no user authentication, private keys or execution/settlement authorization. Core input/proof/identity validators are included. |
| `packages/playbooks/src` | `guard-allocation.ts`, `guard-factors.ts`, `guard-registry.ts`, `guard-scoring.ts`, `history-v2.ts`, `index.ts`, `rules.ts`, `types.ts`, `verdict.ts` | Advisory public token Guard rules/evidence scoring and interfaces; user actual-order/policy authorization is included separately in `packages/policy`. |
| `packages/signal/src` | `index.ts`, `readings.ts`, `types.ts`, `v2.ts` | Advisory public token indicators and schemas; not caller authentication or execution authorization. |
| `packages/untrusted/src` | `index.ts` | Public text sanitization (names/prose), not auth/identity binding, private-key handling or settlement. Authorization modules must still validate identities themselves. |

Other exclusions:

- `apps/web/**`: browser/UI code and UI tests are outside this non-UI core audit; no web coverage project or UI success inflates the counters.
- `**/test/**`, dependencies under `**/node_modules/**`, generated build/report artifacts and JSON/ABI assets: not authored production TypeScript runtime decisions. Authored schema-validator TypeScript in the include census is counted even if V8 reports zero executable lines.
- Coverage test-project exclusions: optional `test/fork/**` requires external RPC; `test/**/performance*.test.ts` measures normal timing budgets that instrumentation distorts; only `apps/engines/test/cli.test.ts` spawns an uninstrumented child with package-root assumptions. Normal suites retain all three classes; the production signer CLI itself remains in the coverage denominator. No normal-suite timeout was raised.
- Solidity `script/`, `lib/` and `node_modules/@openzeppelin/contracts/utils/` are excluded by the existing Forge command: deployment wrappers, vendor test harnesses and utility implementations unrelated to registry/ownership. All authored `src/*.sol` and inherited OpenZeppelin ownership remain counted. Test contracts are excluded by `--exclude-tests`.

## Measured result

`VITEST_MAX_WORKERS=2 node scripts/coverage.mjs` **passed, exit 0**, on 2026-10-03 for the fingerprint above: **191/191 TypeScript suites, 2,524/2,524 tests**, followed by the successful inherited Solidity measurement. The ≥95% aggregate target is established for this uncommitted candidate.

| Scope | Covered / executable lines | Line % |
| --- | ---: | ---: |
| TypeScript core, 187 measured runtime files | 8,324 / 8,694 | 95.7442% |
| Solidity, including inherited ownership | 46 / 50 | 92.0000% |
| **Aggregate core** | **8,370 / 8,744** | **95.7228%** |

An independent path reconciliation expanded every `coreFiles` include and the explicit exclusions, then compared repository-relative paths with the successful V8 JSON summary: **187 expected, 187 reported, 0 missing, 0 unexpected**. This checks report membership, including unimported files, rather than estimating lines from source. `coverage/census-check.json` retains that reconciliation and workspace counters. All 773 candidate input hashes were rechecked unchanged after the successful measurement.

| Workspace | Measured files | Covered / executable lines |
| --- | ---: | ---: |
| `apps/bots` | 16 | 371 / 385 |
| `apps/engines` | 3 | 122 / 131 |
| `apps/indexer` | 21 | 1,525 / 1,574 |
| `apps/mcp` | 7 | 288 / 295 |
| `apps/server` | 68 | 3,504 / 3,728 |
| `packages/chain` | 22 | 1,212 / 1,257 |
| `packages/db` | 16 | 683 / 698 |
| `packages/policy` | 7 | 163 / 164 |
| `packages/receipts-verifier` | 1 | 43 / 44 |
| `packages/shared` | 26 | 413 / 418 |

Solidity counters from this invocation: authored `src/ReceiptsRegistry.sol` **17/17**, inherited `Ownable2Step.sol` **12/12**, inherited `Ownable.sol` **17/21**. The four uncovered inherited ownership lines remain counted. The authored subtotal is already part of the 46/50 subtotal and is never added twice.

The earlier diagnostic run passed at 7,530/7,792, but started before the census review finished; those counters are superseded by the complete final run above. An initial new WAL fixture used a symlinked temporary path and was correctly refused by the isolation guard; the fixture now uses its canonical path. No production refusal was relaxed.

## Verification

| Command | Exit code | Result |
| --- | ---: | --- |
| `pnpm typecheck` | 0 | All workspace checks passed on the final source/test candidate. |
| `VITEST_MAX_WORKERS=2 pnpm test` | 0 | Root checks, all workspace suites (including the new backup tests), production builds and built-role checks passed. Existing optional RPC fork remains skipped; no new skips. |
| `VITEST_MAX_WORKERS=2 node scripts/coverage.mjs` | 0 | Complete configured census and exact counters above. |
| `pnpm brand:check` | 0 | Standalone brand check passed. |
| `git diff --check` | 0 | No whitespace errors. |

No new dependencies, production runtime changes, normal-suite timeout changes, commits or spec edits. Scope follows BACKEND §§9, 12, 13, 15–18 and §23 CA-6/CA-22/CA-28 plus FACTS §7. Existing `TODO(spec)` behavior is retained; no new ambiguity or deferred core coverage work. The historical audit score remains pending independent rescore.
