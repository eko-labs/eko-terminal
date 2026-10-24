#!/usr/bin/env bash
# Starts an Anvil fork of Robinhood Chain mainnet and runs the live-mode UI tests against it.
# The public RPC is rate-limited; set FORK_URL to a provider endpoint (e.g. Alchemy) for reliable runs.
set -euo pipefail
ANVIL="${ANVIL_BIN:-$HOME/.foundry/bin/anvil}"
PORT="${FORK_PORT:-8548}"
FORK_URL="${FORK_URL:-https://rpc.mainnet.chain.robinhood.com}"
"$ANVIL" --fork-url "$FORK_URL" --port "$PORT" --silent --retries 10 --fork-retry-backoff 3000 --compute-units-per-second 50 &
APID=$!
trap 'kill $APID 2>/dev/null || true' EXIT
for _ in $(seq 1 90); do
  kill -0 "$APID" 2>/dev/null || { echo "anvil exited (RPC unavailable or rate-limited). Set FORK_URL to another endpoint." >&2; exit 1; }
  curl -s -X POST "localhost:$PORT" -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' | grep -q 0x1237 && break
  sleep 1
done
E2E_LIVE=true E2E_MAINNET_RPC="http://127.0.0.1:$PORT" npx playwright test --project=live-fork "$@"
