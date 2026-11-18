#!/bin/bash
# Local counterpart of .github/workflows/ci.yml. Compatible with the Bash shipped on macOS.
set -euo pipefail

allow_missing_scanners=false
case "${1:-}" in
  --allow-missing-scanners) allow_missing_scanners=true; shift ;;
  -h|--help)
    echo "Usage: scripts/ci-local.sh [--allow-missing-scanners]"
    exit 0 ;;
esac
if [[ $# -ne 0 ]]; then
  echo "Usage: scripts/ci-local.sh [--allow-missing-scanners]" >&2
  exit 2
fi

cd "$(dirname "${BASH_SOURCE[0]}")/.."
logs=$(mktemp -d "${TMPDIR:-/tmp}/eko-ci.XXXXXXXX")
echo "Local CI logs are in $logs"
export CI=true FOUNDRY_OFFLINE=false VITEST_MAX_WORKERS=2
unset VITE_EKO_CHAIN

pnpm() {
  npx --yes pnpm@11.5.1 "$@"
}

record() {
  local job=$1 status=$2
  shift 2
  printf '%s\n' "$status" "$@" > "$logs/$job.status"
}

run_job() {
  local job=$1
  shift
  printf 'Running %s\n' "$job"
  if ( "$@" ) > "$logs/$job.log" 2>&1; then
    record "$job" PASS
  else
    record "$job" FAIL "log: $logs/$job.log"
  fi
}

missing_tool() {
  local job=$1 tool=$2 install=$3 status=${4:-SKIPPED}
  printf '%s is missing. Install with: %s\n' "$tool" "$install" > "$logs/$job.log"
  record "$job" "$status" "$tool is missing. Install with: $install" "log: $logs/$job.log"
}

check_version() {
  local tool=$1 pattern=$2 install=$3 actual
  actual=$("$tool" --version) || return 1
  if [[ ! $actual =~ $pattern ]]; then
    printf 'Unexpected %s version:\n%s\nUse the CI version with: %s\n' "$tool" "$actual" "$install" >&2
    return 1
  fi
}

foundry_install='foundryup --install v1.7.1'
slither_install='pipx install slither-analyzer==0.11.6'
semgrep_install='pipx install semgrep==1.179.0'
gitleaks_install='brew install gitleaks'

workspace_setup() {
  # CI runs Node 22; a newer local Node is accepted with a note (the public repo's CI still runs 22).
  check_version node '^v(2[2-9]|[3-9][0-9])\.' 'brew install node@22' &&
  { [[ $(node --version) == v22.* ]] || echo "Note: local Node is $(node --version); GitHub CI uses Node 22."; } &&
    pnpm install --frozen-lockfile
}

# Typecheck and web tests per chain run beside everything else; the builds write apps/web/dist, as the root checks do,
# so those three run one after another.
frontend() {
  local failed=0
  export VITE_EKO_CHAIN=$1
  pnpm --filter @eko/web --filter @eko/landing typecheck || failed=1
  pnpm --filter @eko/web test || failed=1
  return "$failed"
}
frontend_build() {
  local failed=0
  export VITE_EKO_CHAIN=$1
  pnpm --filter @eko/landing build || failed=1
  pnpm --filter @eko/web build || failed=1
  return "$failed"
}

contracts() {
  check_version forge '(^|[[:space:]])1\.(7\.[1-9]|([89]|[1-9][0-9])\.[0-9]+)($|[-[:space:]])' "$foundry_install" &&
    (cd contracts && node scripts/build-record.mjs && forge test) &&
    pnpm --filter @eko/contracts coverage
}

slither_scan() {
  check_version forge '(^|[[:space:]])1\.(7\.[1-9]|([89]|[1-9][0-9])\.[0-9]+)($|[-[:space:]])' "$foundry_install" &&
    check_version slither '^0\.11\.6$' "$slither_install" &&
    slither contracts/ --config-file contracts/slither.config.json --fail-high --json "$logs/slither-report.json"
}

semgrep_scan() {
  check_version semgrep '^1\.179\.0$' "$semgrep_install" &&
    semgrep scan --config p/typescript --config p/nodejs --config p/secrets \
      --severity ERROR --error --metrics off --json --output "$logs/semgrep-report.json" \
      apps/edge apps/server apps/indexer apps/engines apps/mcp apps/bots apps/og-renderer packages/*
}

gitleaks_scan() {
  check_version gitleaks '(^|[[:space:]])8\.30\.1$' "$gitleaks_install" &&
    gitleaks git --config .gitleaks.toml --redact --log-opts="--all" .
}

if command -v semgrep >/dev/null; then run_job semgrep semgrep_scan &
else missing_tool semgrep semgrep "$semgrep_install"; fi
if command -v gitleaks >/dev/null; then run_job gitleaks gitleaks_scan &
elif "$allow_missing_scanners"; then missing_tool gitleaks gitleaks "$gitleaks_install"
else missing_tool gitleaks gitleaks "$gitleaks_install" FAIL; fi

if command -v node >/dev/null && command -v npx >/dev/null; then
  run_job workspace-setup workspace_setup
else
  missing_tool workspace-setup 'Node.js or npx' 'brew install node@22' FAIL
fi

setup_status=$(head -n 1 "$logs/workspace-setup.status")
if [[ $setup_status = PASS ]]; then
  run_job dependency-audit pnpm audit --prod --audit-level high &
  run_job workspace-typecheck pnpm typecheck &
  # Frontend jobs cover the web tests and the contracts job covers Forge. Packages test three at a time (one at a time
  # this took ~15 minutes); the two chains' web tests run beside them, and only writes to apps/web/dist take turns.
  run_job workspace-tests pnpm -r --workspace-concurrency=3 --no-bail --filter '!@eko/contracts' --filter '!@eko/web' test &
  ( run_job workspace-checks pnpm test:checks; run_job role-image pnpm test:role-image
    run_job build-robinhood frontend_build robinhood; run_job build-elysium frontend_build elysium ) &
  run_job frontend-robinhood frontend robinhood &
  run_job frontend-elysium frontend elysium &
else
  for job in dependency-audit workspace-typecheck workspace-checks workspace-tests role-image frontend-robinhood frontend-elysium build-robinhood build-elysium; do
    record "$job" SKIPPED 'workspace setup failed'
  done
fi

(
  # Forge and Slither share the contracts build output and cache.
  if ! command -v forge >/dev/null; then missing_tool contracts forge "$foundry_install"
  elif [[ $setup_status = PASS ]]; then run_job contracts contracts
  else record contracts SKIPPED 'workspace setup failed'; fi
  if ! command -v slither >/dev/null; then missing_tool slither slither "$slither_install"
  elif ! command -v forge >/dev/null; then missing_tool slither forge "$foundry_install"
  elif [[ $setup_status = PASS ]]; then run_job slither slither_scan
  else record slither SKIPPED 'workspace setup failed'; fi
) &
wait

printf '\nLocal CI summary\n'
failed=0
for job in workspace-setup dependency-audit workspace-typecheck workspace-checks workspace-tests role-image frontend-robinhood frontend-elysium build-robinhood build-elysium contracts slither semgrep gitleaks; do
  {
    read -r status
    printf '  %-8s %s\n' "$status" "$job"
    while IFS= read -r detail; do printf '           %s\n' "$detail"; done
  } < "$logs/$job.status"
  if [[ $status = FAIL ]]; then failed=1; fi
done
exit "$failed"
