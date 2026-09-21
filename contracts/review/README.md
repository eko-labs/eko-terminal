# ReceiptsRegistry review gate

This is scaffolding for BACKEND §14.0, not a completed review. D0 covers only
`src/ReceiptsRegistry.sol`, which holds no funds. Freeze the candidate commit and
record its hash, tool versions, reports and anonymous reviewer roles here before
the public window. The planned public window is **October 13, 2026, 13:00 UTC
to October 16, 2026, 13:00 UTC**. Rechecks and the final hash are due October 17;
owner D0 sign-off is October 18, reconfirmed October 19. Changes to the candidate
require fresh evidence for affected checks.

The [launch handoff](../../docs/public-launch/CHECKLIST.md) supersedes inherited
Oct 5–8 window and D0-only deadlines under GO-PLAN §§6.2–6.3, 9, 16.
The read-only BACKEND §14.0 retains older dates; its stricter no-open-High/Medium
bar and full-window restart requirement still apply. Registry deployment can
precede acceptance because it holds no funds; neither deployment nor this
scaffolding proves D0 acceptance.

The completed repository review record is [.audit-grade/REPORT.md](../../.audit-grade/REPORT.md),
with its exact candidate, planned tag, path inclusions/exclusions and unavailable
tools frozen in [SCOPE.md](../../.audit-grade/SCOPE.md). Its findings and history
are retained beside the report. That broader review of candidate
`94495af646eb03a35eabb0e22e5892f6e82427df` is separate from the D0 contract gate
below: it does not establish a completed public window, a passing fork or a
professional audit. Raw run artifacts are intentionally ignored.

| Step | Work and evidence | Pass bar |
| --- | --- | --- |
| 1. AI multi-agent review | Three independent sessions on the frozen commit, using different models or prompts with no shared context: adversarial state/griefing, spec comparison, invariants/math. Record each report and every finding in `findings.yaml`. | Every High/Medium fixed and rechecked by a fresh reviewer; every Low/Info resolved or accepted with a reason. |
| 2. Static analysis | Run Slither and Aderyn on every PR touching `contracts/`; archive output and triage it in the findings log. | No untriaged finding and no open High/Medium. |
| 3. Foundry tests | Unit, 1,000-run fuzz, handler invariants and pinned chain-4663 fork tests, plus coverage and gas reports from the same candidate. | 100% of the ReceiptsRegistry §14.6 row; attach coverage. A skipped fork is still pending. |
| 4. Public code-review window | Publish the frozen commit hash, findings and test reports in a GitHub release and announcement; accept public issues for 72 hours. | No open High/Medium at close; a High/Medium fix restarts the full 72-hour window. |
| 5. Private vulnerability reporting | No bug bounty (owner decision 2026-10-05). Keep the root `SECURITY.md` current and GitHub private advisories enabled (`security@ekoterminal.com` forwarding was confirmed on 2026-10-04). | Both private channels open at T, October 13, 13:00 UTC. |

Run from `contracts/` with the installed tools (no dependency installation):

```sh
forge test
forge test --match-path 'test/fork/*'
forge coverage --report summary
forge coverage --report lcov --report-file review/coverage.lcov
forge snapshot
forge test --match-contract ReceiptsRegistryGasTest --gas-report
slither . --config-file slither.config.json --json review/slither.json
aderyn . --src src --output review/aderyn.md
```

The fork needs `RPC_HTTP_URL`; without it Foundry reports a skip. Never attach
RPC credentials or absolute machine paths to published reports. Record the fork
block and actual chain id in the evidence. Coverage disables optimization for
instrumentation; production gas uses the normal §14.1 profile.

Slither keeps all detectors enabled and filters dependency/test/script findings
using its [configuration format](https://github.com/crytic/slither/wiki/Usage#configuration-file).
The [Aderyn configuration](https://cyfrin.gitbook.io/cyfrin-docs/aderyn-vs-code/aderyn.toml-configuration)
is also available to its editor integration; the CLI command supplies the source
scope explicitly. Neither configuration marks findings as resolved.

Each finding requires `id`, anonymous `reviewer`, `severity`, `location`, `title`,
`status` (`open|fixed|accepted|invalid`), `fix_commit`, and `recheck`. Use `null`
until a fix/recheck exists. Add a reason for acceptance or invalidation; a recheck
records the fresh reviewer role, checked commit, result and report location.
The initial entries flag preserved §14.2 behaviours for the independent reviews.
