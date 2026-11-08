# Supply-chain advisory record

## Production dependency evidence

- Date: 2026-10-02.
- Source revision: `2b1acbb`.
- Command: `pnpm audit --prod`.
- Result reported by the lead: **0 advisories** (info 0, low 0, moderate 0,
  high 0, critical 0).
- Scope: production dependencies of `apps/server`, `apps/engines`, `apps/indexer`,
  `apps/mcp`, `packages/chain`, `packages/db`, `packages/policy`,
  `packages/playbooks`, `packages/shared`, `packages/signal`, `packages/untrusted`
  and `contracts`. `apps/web` is outside this audit scope.

This records the lead's run; it is not a new local registry scan. The supply-chain
pin changes preserve all resolved npm versions. Seven scoped viem declarations
are exact `2.56.9`; OpenZeppelin Contracts `5.6.1` and Merkle Tree `1.0.8` were
already exact. The web manifest remains unchanged.

The Node CI job runs `pnpm audit --prod --audit-level high` immediately after
install, with registry access. It fails on High/Critical production advisories
and on registry errors. It audits the workspace production dependency graph,
which also includes the web workspace; no advisory exceptions are configured.
A dependency audit does not scan operating-system packages or container images,
and this dated result is not a claim about future advisories.

## Runtime, toolchain and service inventory

Production application builds and runtime both use Node **22.23.3**, with pnpm
**11.5.1** pinned in `packageManager` and the Docker build. CI selects Node 22;
the repository requires Node >=22.12. Foundry is pinned to **v1.7.1**, with solc
**0.8.26**. Existing analyzer pins are Slither **0.11.6**, Semgrep **1.179.0**
and Gitleaks **8.30.1**.

| Use | Image tag and immutable digest |
| --- | --- |
| Docker build and runtime | `node:22.23.3-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c` |
| Prometheus | `prom/prometheus:v3.2.1@sha256:6927e0919a144aa7616fd0137d4816816d42f6b816de3af269ab065250859a62` |
| Alertmanager | `prom/alertmanager:v0.28.1@sha256:27c475db5fb156cab31d5c18a4251ac7ed567746a2483ff264516437a39b15ba` |
| Grafana | `grafana/grafana:11.6.16@sha256:d67af92050b8d93b393dc741864752a69c9da1ffa39c1bb9af49ad5d9e47d2c3` |
| Uptime Kuma | `louislam/uptime-kuma:1.23.17@sha256:3d632903e6af34139a37f18055c4f1bfd9b7205ae1138f1e5e8940ddc1d176f9` |
| CI Semgrep | `semgrep/semgrep:1.179.0@sha256:93963d9295a366f59e4850127b1550400ee7b388f04fe144e4a1f6325d96e01b` |

Grafana moves from 11.6.0 to 11.6.16 and Kuma from 1.23.16 to 1.23.17.
The supplied image pins are an inventory, not container vulnerability-scan
results; no images were pulled or services started for this task.

As of the supplied 2026-10-02 task evidence, Node 22 and pnpm 11.5.1 are not
on the audit kit's advisory list. Its flagged items are Bun <=1.1.39,
Anchor 1.0.0-rc.1, RISC Zero 2.0.0–2.0.2, affected SP1 releases, and vulnerable
Redis images; none are used in this repository. This comparison is limited to
the kit's list, rather than general runtime or service advisory clearance.

## Install and image update controls

`pnpm-workspace.yaml` combines the existing `allowBuilds` allow-list (esbuild
only) with `minimumReleaseAge: 4320` minutes (three days). Newly published direct
and transitive dependency versions must clear the cooldown; pnpm 11.5.1 also
rechecks lockfile entries against the policy. Offline verification requires
registry release metadata in addition to cached package contents. No cooldown
exclusions are configured.

Dependabot checks the root Dockerfile weekly, alongside the existing GitHub
Actions updates. The monitoring file `infra/monitoring/compose.json` cannot be
added effectively: Dependabot's [Compose file fetcher](https://github.com/dependabot/dependabot-core/blob/main/docker/lib/dependabot/docker_compose/file_fetcher.rb)
only discovers `.yml`/`.yaml` Compose filenames. Its [Docker manifest parser](https://github.com/dependabot/dependabot-core/blob/main/docker/lib/dependabot/docker/file_parser.rb)
also selects YAML filenames. Review monitoring tag/digest pairs manually until
the file format or updater support changes; this task preserves the JSON format.

## Frontend build isolation

The image builds the terminal (`apps/web`) and landing (`apps/landing`) bundles in
a separate `frontend` stage that installs only those two workspaces and their own
workspace dependencies. Their build-time tooling (Vite and `@vitejs/plugin-react`;
for the landing also `@tailwindcss/vite`, with the `@tailwindcss/oxide` and
`lightningcss` native binaries) never shares a filesystem with server sources, the
server bundle or `/out/node_modules`; only the two `dist` folders are copied into the
runtime image. The server stage installs every workspace except those two. CI builds
the landing on every push, so a broken landing build fails before deploy.

## Local verification limits for this change

The lockfile was regenerated offline with
`CI=true pnpm install --offline --no-frozen-lockfile --lockfile-only --trust-lockfile`
(exit 0). A structural comparison with the source revision proves that only the
seven scoped viem importer specifiers changed; all resolutions and package
integrities remain identical. `--trust-lockfile` was limited to regeneration
from the existing lockfile; it is not configured in the repository or CI and
that run does not prove release-age verification.

`pnpm install --frozen-lockfile --offline --fetch-retries=0` failed with
`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`: release metadata could not be fetched
from the registry in this sandbox. The initial required offline install also
hit registry DNS errors. A full offline relink with `--trust-lockfile` separately
failed with `ERR_PNPM_NO_OFFLINE_TARBALL` for
`@fontsource/bricolage-grotesque@5.3.0`. The workspace package cache alone is
insufficient for the requested standard frozen offline installation proof.

Preinstalled dependencies were restored from the primary checkout for local
validation, with `pnpm_config_verify_deps_before_run=false` to prevent an automatic
reinstall during typecheck/tests. These checks do not establish install-policy
clearance. Complete one normal install with registry access and populated package
and release metadata caches, then rerun `pnpm install --frozen-lockfile --offline`
in the target environment. The three-day cooldown and allow-list remain enabled;
no policy exceptions or dependency version changes were added.

Local checks on base `2b1acbb` plus this uncommitted change, using Node **26.0.0**
and pnpm **11.5.1**:

- `pnpm_config_verify_deps_before_run=false pnpm typecheck`: exit 0.
- `pnpm_config_verify_deps_before_run=false VITEST_MAX_WORKERS=1 pnpm test`:
  exit 0, including workspace tests, Foundry, web/server builds and the built
  role fixture checks. `coverage-pilot.test.ts` passed in the full run; no
  isolated rerun or test edit was needed. The existing Foundry suite reported
  33 passed and one pre-existing skipped test.
- Scoped manifest range search: no ranges for the listed chain/crypto libraries.
- YAML parsing (workspace, lockfile, CI and Dependabot), Compose JSON parsing,
  image tag/digest assertions and unchanged-resolution comparison: passed.
- `git diff --check`: exit 0.

Validation logs are `/private/tmp/eko-audit-05-typecheck.log` and
`/private/tmp/eko-audit-05-test.log`; install attempts are in
`/private/tmp/eko-audit-05-install.log`, `/private/tmp/eko-audit-05-lockfile.log`
and `/private/tmp/eko-audit-05-frozen.log`.

## Development-only advisories (2026-10-03)

`pnpm audit` including dev dependencies reports two moderate advisories, both present before audit 10 and not
reachable from production code (`pnpm audit --prod`: none):

- `esbuild <=0.24.2` (dev-server request exposure), via `apps/server` dev tool `drizzle-kit` → `@esbuild-kit/core-utils`.
- `uuid <11.1.1` (buffer bounds in v3/v5/v6 with a caller buffer), via `@openzeppelin/merkle-tree` → `@metamask/abi-utils`
  → `@metamask/utils`; EKO never calls uuid with a buffer.

Track upstream fixes; neither is a production finding.
