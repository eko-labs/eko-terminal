# Pinned fork and live dependency results

Recorded 2026-10-03 UTC (2026-10-02 local), from base commit
`5bd225764739e7496da13827e32372299bde5325` (`git rev-parse HEAD`). Changes remain
uncommitted for lead review. This is **partial evidence; the complete integration gate is not green**.

Public RPC: `https://rpc.mainnet.chain.robinhood.com`, chain 4663. All remote
requests made for live checks were read-only JSON-RPC to this endpoint. Those
checks performed no signing, transaction submission, private key use, other
provider or Blockscout requests.
The contract probe executes ephemeral state changes inside `eth_call` only.

Environment: Node 26.0.0, pnpm 11.5.1, viem 2.56.9, Foundry/Anvil 1.7.1,
solc 0.8.26. The workflow uses Node 22 and the same pinned Foundry version as CI.

## Candidate linkage

The reviewed source snapshot SHA-256 is
`74078bd1b2319bd5a99fb19ce6199a4638a113436bd7a6d98761ddefc23b43cb`.
Compute it by sorting the following relative paths, concatenating each UTF-8
path, NUL, its exact file bytes, NUL, then hashing the concatenation:

- `.github/workflows/fork.yml`
- `apps/server/test/fork/live-route.fork.test.ts`
- `apps/web/e2e/run-fork.sh`
- `contracts/README.md`
- `packages/chain/test/fork/dependencies.fork.test.ts`
- `packages/chain/vitest.config.ts`
- `packages/chain/vitest.fork.config.ts`

The report itself and the supplied task file are excluded from this digest.
The unchanged Foundry test belongs to the base commit. The lead must link the
eventual commit to this snapshot; these runs are not evidence for later edits.

## Pins and commands actually run

| Pin | Canonical header hash observed before/after the chain suite | Purpose |
| --- | --- | --- |
| 77,469,811 | `0xf21a54dc71bc5e841d635a078a82385750a807e892d0ae00a7122b068e2af2d5` | Existing Foundry pin; now the default server/browser/chain pin and the documented pin |
| 78,680,366 | `0x1b12707287a381a69bffff8b636f0b3feaa39861420b75f2f664823696d6dbaa` | Supplementary fixed pin with available state; does not replace the required original pin |

From the repository root:

```sh
RPC_HTTP_URL=https://rpc.mainnet.chain.robinhood.com pnpm --filter @eko/contracts test:fork
FORK_URL=https://rpc.mainnet.chain.robinhood.com FORK_BLOCK_NUMBER=77469811 pnpm --filter @eko/chain exec vitest run --config vitest.fork.config.ts --reporter=verbose
FORK_URL=https://rpc.mainnet.chain.robinhood.com FORK_BLOCK_NUMBER=78680366 pnpm --filter @eko/chain exec vitest run --config vitest.fork.config.ts --reporter=verbose
pnpm typecheck
pnpm test
```

| Run | Result | Output summary |
| --- | --- | --- |
| Foundry, 77,469,811 | Exit 0; 1 passed, 0 failed, 0 skipped | Registry deployed locally, fixture root committed, all leaves verified; chain/block assertions passed |
| Live chain, 77,469,811 | Exit 1; 0 passed, 3 failed, 0 skipped | Header/log reads work, but code/storage/calls fail because historical state is unavailable |
| Live chain, 78,680,366 | Exit 0; 3 passed, 0 failed, 0 skipped | Real registry code/proxies/wiring/events, bidirectional QuoterV2 calls and contract-probe round trip |
| `pnpm typecheck` | Exit 0 | All workspace type checks passed, including final live-test code |
| `pnpm test` | Exit 0 | 164 Vitest files / 2,773 tests passed; Foundry 33 passed, 0 failed, 1 explicitly skipped fork; built role fixture checks passed |

The offline Foundry skip is `RPC_HTTP_URL unset: rhc fork skipped`; the separate
live Foundry command above ran that test successfully. The chain live file is
excluded from the offline suite and requires its dedicated configuration;
there are no conditional skips in that live file. The engine coverage-pilot
test passed during the full gate; no standalone rerun or edit was needed.

At the supplementary pin, all 50 verification rows passed: 14 deployed-code
checks (including proxy implementation reads), router factory/WETH wiring,
chain/pin checks, 9 event checks, and informational registry TODO rows. All
9 event checks found actual emitted logs, including Pons anti-snipe exemption
events and v4 Initialize/Swap/ModifyLiquidity/Donate. Optional/D0 TODO rows do
not establish deployed contracts or trading readiness.

Real WETH/USDG quotes at fee tier 10,000:

- 50,000,000,000,000,000 wei WETH input → 132,570,196 raw USDG output.
- 40,000,000 raw USDG input → 14,785,310,706,439,719 wei WETH output.
- Contract probe: 50,000,000,000,000,000 wei spent → 132,570,196 raw USDG
  bought → 49,005,020,541,618,210 wei returned. Buy/sell succeeded, the actual
  sell amount matched the post-buy quote and router return, and the debit
  equalled the requested amount. Only probe code/native balance were
  overridden; deployed tokens, router, quoter and pool storage were real.

The successful supplementary run used 64 metered upstream units. An earlier
run encountered a malformed upstream batch response during an event read;
the final helper limits requests to 120/minute and enables bounded 15-second
transient retries using the existing meter. Assertions were preserved.

## Discovery and remaining blockers

| Suite/tool | Environment inputs | Status/coverage |
| --- | --- | --- |
| `contracts/test/fork/ReceiptsRegistry.fork.t.sol` | `RPC_HTTP_URL`; hardcoded pin 77,469,811 via `rhc` | Executed; local registry fixture verification, not proof of archive dependency state |
| `pnpm test:fork` / server `live-route.fork.test.ts` | `FORK_URL`, `FORK_BLOCK_NUMBER`, `ANVIL_BIN` | 5 tests not run: requires disposable private keys and signing/submission to loopback Anvil |
| `pnpm e2e:fork` / browser `live.fork.spec.ts` | `FORK_URL`, `FORK_BLOCK_NUMBER`, `ANVIL_BIN`, `FORK_PORT`; launcher sets `E2E_LIVE=true`, `E2E_MAINNET_RPC`; browser uses `PW_CHANNEL` | 2 tests not run: same fork-only signing restriction |
| New chain `dependencies.fork.test.ts` | Required `FORK_URL`, optional positive `FORK_BLOCK_NUMBER` (default 77,469,811); finite in-memory budget | Executed at both pins; includes real contract probe through read-only `eth_call` |
| Chain `reference-anvil`, `reference-simulation`, `pons-simulation`, `fork-runtime`, `fork-gateway`, `fork-manifest`; probe Solidity tests | Injected fixture transports/local contracts; no live-RPC switch | Synthetic tests; not counted as live dependency evidence |
| Chain `verify:chain` | `RPC_PUBLIC_HTTP_URL`, `RPC_HTTP_URL`, `CHAIN_ID`, meter settings | Its verification logic runs through the new live suite with every read pinned; standalone CLI uses head and was not substituted for a pinned run |
| `fork:check` / `fork:manifest` operator CLIs | `RPC_HTTP_URL`, mandatory finite `RPC_SESSION_BUDGET`, budget persistence settings; manifest/review evidence | Not test suites; no reviewed live manifest or independent predictions supplied. No invented route approval or synthetic matches counted |

The task explicitly says “Never sign or send a transaction; never use a private
key.” The server/browser suites generate disposable keys and sign messages and
transactions locally. Clarification allowing those operations **only on
loopback Anvil** was requested and had not arrived when this report was written.
No required assertion was skipped or weakened to avoid that restriction.

The public RPC independently returned JSON-RPC error `-32000` for pinned WETH
`eth_getCode`: `historical state 3434b718a97ebfb72434ad5e5dc94f173a8e7570978944500b4c24009cc8ca0c is not available`.
Retries cannot restore pruned archive state. The original-pin dependency gate
remains failing; completing it needs archive availability at the allowed public
endpoint, or explicit permission to use a different archive endpoint/pin.
The Foundry pass does not remove this blocker because its fixture test creates
its own registry and does not load the deployed router/token storage.

Commands prepared for the remaining signing suites, pending clarification:

```sh
ANVIL_BIN=anvil FORK_URL=https://rpc.mainnet.chain.robinhood.com FORK_BLOCK_NUMBER=77469811 pnpm test:fork
ANVIL_BIN=anvil FORK_URL=https://rpc.mainnet.chain.robinhood.com FORK_BLOCK_NUMBER=77469811 pnpm e2e:fork
```

## CI and specification

`.github/workflows/fork.yml` adds manual dispatch and daily 04:17 UTC runs,
using the original pin and public RPC without secrets. It runs Foundry, the
chain dependency/probe file, server fork suite and browser fork suite, retaining
all logs plus checked-out commit/date/pin as a 14-day artifact. Later suites
still attempt execution after an earlier suite fails; Bash pipefail preserves
nonzero command exits. All action SHAs match `ci.yml`, checkout disables
credential persistence, permissions default to none with job-level
`contents: read`, and jobs/commands have timeouts. YAML/hardening assertions,
`bash -n apps/web/e2e/run-fork.sh` and `git diff --check` passed. The workflow was
authored, not dispatched or live-verified; signing suites need the clarification
above, and the original-pin archive check is expected to fail while state is missing.

Followed BACKEND §§12.1, 14.1, 14.6 and 20: real deployed dependency checks,
pinned forks, registry fixture verification and integration evidence. No spec
files, dependencies or lockfile changed; no new `TODO(spec)` ambiguity. This
does not establish arbitrary Pons/v4 execution, fee-destination assertions,
oracle-feed coverage, independent-provider fidelity or all deployment gates.

## Lead run: all fork suites green (2026-10-03 01:18 UTC)

Run by the lead outside the agent sandbox (the server suite starts a loopback Anvil, which the sandbox cannot bind),
on this branch based on `5bd2257`, against `https://rpc.mainnet.chain.robinhood.com` at pin **78,689,667** (public RPC
head minus 20; the public endpoint keeps no archive state, so 77,469,811 needs an archive endpoint).

| Suite | Command | Result |
| --- | --- | --- |
| Registry fork (Foundry) | `RPC_HTTP_URL=$FORK_URL pnpm --filter @eko/contracts test:fork` | 1 passed |
| Live chain dependencies + read-only probe | `pnpm --filter @eko/chain exec vitest run --config vitest.fork.config.ts` | 3 passed |
| Server live route on loopback Anvil (local fork-only keys, fork-only ETH) | `pnpm test:fork` | 5 passed (run twice) |

Fix made during this run: the server revert test sent the order's swap with value 0 to force a revert, but the
execution service now (correctly) classifies any reported transaction whose calldata or value differs from the order
as `tx_mismatch`. The test now sends the exact order transaction after moving the fork clock past the router multicall
deadline (120 s), inside an `evm_snapshot`/`evm_revert` so later tests keep the original chain clock. The assertions
are unchanged (`failed`, `reverted`, no fill).

Pin policy: `.github/workflows/fork.yml` pins each run to the public RPC head minus 20 and records the pin and commit in
its artifact; a manual run can pass an exact `block` (use an archive `FORK_URL` for older pins). The browser e2e fork
flow is UI and out of audit scope, so the workflow no longer runs it.

## Hosted runs (2026-10-03)

A manual run of `.github/workflows/fork.yml` on GitHub's hosted runner (run 37086421466, commit 72d33eb, pin 78,697,893)
failed. The registry fork got `historical state … is not available` from the public endpoint. The dependency check's
20 failing rows were **not** RPC errors: audit 06 made the deploy verifier fail closed on undeployed EKO entries, and
this live test (written in parallel by audit 11) called it in strict mode. Audit 13 runs it with `prelaunch: true`.
After that fix, on merged main, all three suites pass from the lead's machine at pin 78,731,181 (2026-10-03 02:28 UTC):
registry fork 1 passed, live chain dependencies 3 passed, server live route 5 passed. Reliable
hosted runs need an archive endpoint: set the repository secret `FORK_RPC_URL` (for example a provider archive URL) and,
to enable the daily schedule, the repository variable `FORK_SCHEDULE=on`. Without the secret the workflow falls back to
the public endpoint and is manual-only. The endpoint URL is never written to artifacts (logs are redacted; `pin.txt`
records only which endpoint kind was used).
