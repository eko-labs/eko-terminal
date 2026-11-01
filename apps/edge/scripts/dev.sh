#!/bin/sh
# Run the Elysium edge locally against keyless RPC, serving the built web app and landing site.
# Build first: (cd apps/web && vite build) and (cd apps/landing && vite build).
cd "$(dirname "$0")/.." || exit 1
export PORT="${PORT:-5185}"
export RPC_PUBLIC_HTTP_URL="${RPC_PUBLIC_HTTP_URL:-https://elysium.drpc.org}"
# The metered RPC layer sends block-pinned eth_calls (the sell probe) to the "paid" provider. Locally that is the
# keyless endpoint too; in production it is the paid key (dRPC Pro).
export RPC_HTTP_URL="${RPC_HTTP_URL:-https://elysium.drpc.org}"
export LOG_CHUNK="${LOG_CHUNK:-100}"            # keyless dRPC allows ~100-block log spans
export BACKFILL_BLOCKS="${BACKFILL_BLOCKS:-5400}" # about ten minutes of history on a free endpoint
export RPC_USAGE_DIR="${RPC_USAGE_DIR:-${TMPDIR:-/tmp}/eko-rpc-usage}"
export NODE_USE_ENV_PROXY=1
exec node --import tsx src/main.ts
