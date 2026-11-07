# Measured performance

The runs were measured on 2026-09-28 on an Apple-silicon MacBook Pro. The server ran locally (`node dist/index.js`, production build, embedded PGlite) against **live Coinbase market data** and the **real Robinhood Chain mainnet public RPC**. Browser numbers come from the dev build (unminified React with StrictMode), so production will be at least as fast.

Every metric is collected continuously by the app itself and exposed at `GET /api/metrics`, with persisted samples in `latency_samples`. You can reproduce these numbers on any deployment. Each stage is measured separately, as the brief requires.

## Signal → trade path

| Stage | Metric | Result | Notes |
|---|---|---|---|
| Market-data freshness | `market.lag_ms` (exchange time → server receipt) | p50 ≈ 0 ms · p90 19–27 ms · p99 56–74 ms (n ≈ 33k trades) | The p50 is distorted by clock skew between Coinbase and the local clock: negative lags are clamped to 0. Treat p90/p99 as the meaningful values. |
| Bar close → strategy evaluation | `market.candle_close_to_eval_ms` | p50 750 ms · p90 788 ms · p99 849 ms (live data) | Busy markets close a bar on the next trade. Quiet markets close after a 600 ms late-trade grace period plus a 250 ms sweep. Before tuning, p90 was 1.8 s. |
| Bar close → signal persisted and broadcast | `signal.publish_ms` | p50 642 ms · p90 857 ms (rules bots, live data) | Includes the grace window above. Evaluation itself takes < 5 ms for all rules bots across 6 markets × 6 timeframes. |
| Signal broadcast → marker in DOM | browser harness | p50 21.5 ms · p90 46 ms | Measured from the moment the injecting HTTP request starts, so it includes the DB insert, the WebSocket fan-out and the React render. |
| WebSocket → marker painted | `ui.signal_arrival_to_paint_ms` | p50 12.8–14.5 ms | Sampled only while the tab is visible. |
| Open signal → execution card in DOM | browser harness | p50 ≈ 10 ms · p90 19 ms | |
| Open signal → executable **paper** quote rendered | browser harness | p50 23 ms · p90 42 ms | Previously ~242 ms: a 220 ms input debounce was also delaying the *first* quote. Now the first quote is immediate and only edits are debounced. |
| Paper quote (server) | `quote.latency_ms` | p50 0.5 ms · p90 0.7 ms | |
| Paper quote round-trip (client) | `ui.quote_roundtrip_ms` | p50 6.1 ms · p90 7.3 ms | |
| **Live mainnet quote** (Robinhood Chain, Uniswap v3) | `quote.latency_ms` | p50 **313 ms** · first/cold 1.8 s (n = 10) | Four QuoterV2 tier calls in parallel, then pool `slot0`/`token0`, then gas price. Uses the public RPC, and more calls are added when a wallet is attached (balance, allowance, `eth_call` simulation, `estimateGas`). A dedicated RPC provider should reduce this and remove the cold outlier. |
| Paper order handling (server) | `order.submit_server_ms` | p50 4 ms | Atomic transaction covering order, fill, balances and position. |
| On-chain confirmation | `order.confirm_ms` | Not measured on mainnet | On the local Anvil fork, the reconciler reports confirmation within one 1.5 s polling interval of the receipt. No real mainnet transaction was sent (see [LAUNCH.md](LAUNCH.md)). |
| AI inference | `ai.inference_ms` | Not measured against real providers | No API keys were available. The pipeline was tested with a scripted provider. Inference is off the execution path: a click never waits for a model. |
| WebSocket RTT | `ws.rtt_ms` | p50 0.6 ms · p90 1.8 ms (localhost) | |
| Chart load | `ui.chart_load_ms` | p50 8–49 ms | 800 bars from the in-memory candle store. |

## Load and footprint

| | |
|---|---|
| REST latency (candles, signals, bots) | 1–4 ms locally |
| Simulator cold start | ~9 s. It generates ~390k minute bars × 6 markets deterministically, which is dev/demo only. |
| Coinbase backfill at boot | ~15 s: 36 paced REST requests, 6 markets × 6 timeframes |
| Production dependencies (`pnpm deploy --prod`) | 192 MB of `node_modules` |
| Web bundle | Main chunk 606 kB (188 kB gzip). Pages are code-split. |

## Reproduce

```bash
# live data, production build
pnpm build
cd apps/server
NODE_ENV=production SESSION_SECRET=$(openssl rand -hex 32) SERVE_WEB=true PUBLIC_ORIGIN=http://localhost:8710 node dist/index.js
curl localhost:8710/api/metrics | jq '.metrics[] | select(.count>0) | {metric,p50,p90,p99,count}'
```
