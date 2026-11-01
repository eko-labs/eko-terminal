# @eko/edge — EKO on Elysium

One small stateless service: it follows Montra launches on Elysium (chain 99901) in memory, checks each coin, and
serves the read API the EKO web app already speaks, plus the built web app and landing site. No database, no signing
keys, nothing to back up. A restart replays the last `BACKFILL_BLOCKS` of chain history.

## What it does

| Piece | File | Notes |
| --- | --- | --- |
| Tracker | `src/tracker.ts` | Montra `TokenLaunched` and `Graduated`, plus every `Swap` on Uniswap's PoolManager for a tracked pool. Log spans shrink on a provider's "too many / range" reply and stay small. |
| Checks | `src/assess.ts` | One batched read (name, symbol, pool key, Montra fee terms, current buy fee) and EKO's V4 sell probe for ~$100 of HYPE inside one `eth_call`. Playbooks with the Elysium config; a probe that could not run, or Montra's early-buy window, leaves the verdict pending. |
| Views | `src/views.ts` | `@eko/shared` contract shapes. Anything not measured (wallet labels, holders, depth) is zero and named in `unavailable` / `meta.*.missing`. |
| HTTP | `src/server.ts` | `/v1` and `/v2` read routes, `/v1/rpc` read-only relay (allowlist), `/health`; landing at `/`, terminal elsewhere. |
| Realtime | `src/ws.ts` | `/v1/ws`: hello, pong, acks; pushes new feed items. |
| HYPE price | `src/hype.ts` | Hyperliquid's public `allMids` (no key). |

## Run

```sh
# from the repo root, after pnpm install
(cd apps/web && npx vite build) && (cd apps/landing && npx vite build)
apps/edge/scripts/dev.sh          # http://localhost:5185, keyless dRPC
pnpm --filter @eko/edge test
```

Production builds `Dockerfile.edge` (Railway: `RAILWAY_DOCKERFILE_PATH=Dockerfile.edge`).

## Settings

| Variable | Default | |
| --- | --- | --- |
| `RPC_HTTP_URL` | none | Paid RPC with a read-only key. The metered layer sends block-pinned `eth_call`s here. Use keyless `https://elysium.drpc.org` until the paid key exists. |
| `RPC_PUBLIC_HTTP_URL` | `https://rpc.elysium.kinetiq.xyz` | Kinetiq's public RPC rate-limits hard; prefer dRPC. |
| `LOG_CHUNK` | 2000 | Free RPC tiers allow ~100 blocks per `eth_getLogs`. |
| `BACKFILL_BLOCKS` | 32400 | ~1 h at ~111 ms blocks. Keep ~5400 on a free tier. |
| `ASSESS_CONCURRENCY` | 2 | Coin checks in flight (two `eth_call`s each). |
| `POLL_MS` | 2000 | Tracker poll interval. |

## Not done yet

Wallet labels (agent / crew / human), holder and depth figures, deployer and crew history (the builder and its
snapshot), the second-largest launchpad (unbranded hook on a second PoolManager) and Ascend, trading, the agent
connector (MCP), and the v2 Guard assessment. See `docs/elysium/`.
