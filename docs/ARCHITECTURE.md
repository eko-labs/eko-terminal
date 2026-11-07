# Architecture

## Shape of the system

```
 Browser (React)                           Server (Node, one process)                         External
┌──────────────────────────┐   HTTPS   ┌───────────────────────────────────────────┐
│ Workspace                │◄────────► │ Fastify API (zod-validated, rate-limited)  │
│  chart core (LWC v5)     │           │  sessions · SIWE · prefs · layouts          │
│  SignalLayer (DOM)       │   WS      │  quotes · orders · portfolio · bots · lab   │
│  Buy / Sell (one tap)    │◄────────► │ WebSocket hub (per-client subscriptions)    │
│ wagmi/viem wallet ───────┼──────────►│                                             │   Coinbase public WS/REST
│   (user signs)           │   RPC     │ MarketDataService ── Feed (Coinbase|Demo) ──┼──► (trades, tickers, L2 books)
└──────────────────────────┘           │   CandleStore: trades → bars, bar-close ev. │
          │                            │ SignalEngine (worker)                        │
          │ signed tx                  │   rules · provisional · ensembles · expiry   │
          ▼                            │ ProviderRegistry (idle: no model calls)      │
   Robinhood Chain ◄───────────────────┤ ExecutionService                             │
   (Uniswap v3)          eth_call /    │   Paper adapter · UniswapV3Adapter           │
                         receipts      │   reconciler (receipts → confirmed/failed)   │
                                       │ QuantService (backtests, forward records)    │
                                       │ Postgres (Drizzle) — or PGlite in dev        │
                                       └───────────────────────────────────────────┘
```

A single process keeps the latency path short. Signals, quotes and orders never cross a queue or a second service. `RUN_WORKER=false` lets you add API-only replicas later. Exactly one process must run the worker.

## Packages

| Package | Responsibility |
|---|---|
| `packages/shared` | Pure, deterministic code shared by server and browser: indicators, rule strategies, backtester, risk math, zod schemas, the AI output contract and validator, the market and network registries (verified addresses), formatting. |
| `apps/server` | HTTP/WS API, market data ingestion, signal worker, AI adapters, execution adapters, persistence, observability. |
| `apps/web` | The workspace and pages. It has no business logic that could diverge from the server: every number shown on a signal comes from the server record. |

## Signal lifecycle

```
          intrabar (watched charts, rules bots, every 10 s)
               │ condition true on the forming bar
               ▼
          PROVISIONAL ──bar closes, condition holds──► ACTIVE ──lifetime elapses──► EXPIRED
               │                                     │  ▲
               │ condition fails at close            │  └─ created directly at bar close
               ▼                                     ▼
          WITHDRAWN                          INVALIDATED (close breaches invalidation level)
```

- Every transition appends a row to `signal_events` with the before and after status. If a reference price or expiry changes (for example when a provisional signal is confirmed at the close price), `revision` is incremented and both the old and new values are stored. Nothing is repositioned silently.
- The key `(bot, market, timeframe, bar, action)` is unique, which makes duplicate signals impossible even if the worker runs twice.
- Signals are anchored on the chart to the bar that contains the moment they were formed (`signalMath.anchorTime`), and to their exact `referencePrice`. Markers are never moved to "better" prices.
- Expired, invalidated and withdrawn signals stay visible, but they are never actionable. The server re-checks actionability at quote time and again at order time.

### Rules bots

Rules bots run on every bar close and see only closed bars. `strategy.prepare(candles)(i)` uses only `candles[0..i]`, and a property test in `packages/shared/test` checks this for every strategy.

### AI and agents

There is no server-side LLM bot path: nothing in the server runs a model at bar close, turns model output into signals or serves an "analyze now" route. What exists today:

- **Providers.** `ProviderRegistry` (`apps/server/src/ai/registry.ts`) gives each provider its direct adapter when its own key is set, otherwise (if `GATEWAY_API_KEY` is set) a Chat Completions adapter against the AI gateway (`GATEWAY_BASE_URL`, PPQ by default) with a per-provider gateway model. Health reports `route` and `via` per provider; the legacy `GET /api/ai/usage` reports spend, limits and provider health.
- **Budget.** `AI_DAILY_BUDGET_USD` (default `0`, which disables inference) is the daily ceiling on estimated model spend across providers. `AI_MAX_CALLS_PER_BOT_HOUR` is reserved: it is parsed and reported but nothing enforces it.
- **Swarm.** `SwarmWorker` (`apps/server/src/ai/swarm-worker.ts`) is the only model caller in code. It runs only with `SWARM_ENABLED=true`, verified `SWARM_MODELS` and nonzero AI and Swarm budgets, reserves each call's maximum cost under a database lock before calling, and validates every reply as untrusted data. No image role starts it yet (`swarm` is unavailable in `apps/server/src/roles.ts`).
- **Agent harness.** Agents are the user's own programs. `HarnessService` (`apps/server/src/harness/`) keeps agents, versioned policies and HMAC-hashed API keys behind `/v1/agents`; the MCP server (`apps/mcp`, `APP_ROLE=mcp`) gives key holders Senses reads, advisory preflight and the private journal. EKO calls no model on an agent's behalf.

AI inference is never on the execution path, and model output grants no signing authority.

### Ensembles

An ensemble is evaluated after its members. It emits a signal only when at least `quorum` members agree within `windowBars` and no member disagrees. Membership and quorum are part of the ensemble's version.

## Market data extras

- **Order books.** `Feed.watchBooks(markets)` is driven by the WebSocket hub's subscriptions, so books stream only for markets someone watches. Coinbase keeps a full level-2 book per watched market from `level2_batch` (REST polling fallback); the simulator synthesizes a deterministic book. The server sends the top 20 levels per side at ≤ 4 Hz (`{type:'book'}`) and serves `GET /api/book`.
- **Sparklines.** `GET /api/sparklines` returns 24 hourly points per market (23 closed 1h bars from the store or persisted candles, then the forming hour's close), cached 15 s.
- **24h stats.** Tickers carry `open24h`, `volume24h`, `high24h` and `low24h` from Coinbase's ticker channel or the simulator.

## Execution

A tap on **Buy** or **Sell** (or the BUY/SELL pill on the chart) trades the chosen USD amount immediately; there is no review step. Both modes run every check of the quote → order path, composed differently:

- **Paper — one server call.** `POST /api/orders/instant` `{ mode: 'paper', market, side, amountUsd | all, signalId?, idempotencyKey, slippageBps? }` quotes and fills atomically through `ExecutionService.instantPaper` (the same `paperQuote` → `place` code). Buys spend `amountUsd` of paper cash. Sells convert it to the base asset at the live bid (`sellQuantity`, floored to the market's precision) and are capped at the holding: a holding worth less — or `all: true` — is sold in full; nothing held → `409 nothing_to_sell`. Slippage defaults to the account's preference.
- **Live — composed in the browser** (`runLive` in `apps/web/src/lib/instantFlow.ts`, wired up by `useInstantTrade` in `lib/instant.ts`): switch network and Sign-In With Ethereum if needed → `POST /api/quotes` for the connected wallet → if an exact approval is required, the wallet sends it, the receipt is awaited and the quote refreshed → `POST /api/orders` (`awaiting_signature`) → the wallet sends the server-built calldata → `POST /api/orders/:id/submitted` (`submitted`) → the order stream reports `confirmed` or `failed`. The tap is answered at *submitted*, so the UI isn't blocked while the chain confirms. Sells keep `GAS_RESERVE_ETH` in the wallet. Live taps above `preferences.confirmLargeTradeUsd` return `confirm_required` before anything reaches the wallet.

| Step | Paper | Live (Robinhood Chain) |
|---|---|---|
| Quote | Live bid/ask from the feed; modelled fee. Stale data (> 15 s, or feed down) → refused. | QuoterV2 across four fee tiers, choosing the best. Pool `slot0` gives impact. Balance and allowance are checked, the swap is simulated with `eth_call` from the user's address, and gas is estimated (L2 plus L1 data). An unreachable RPC is reported as such, never as "no liquidity". |
| Pre-trade | Signal actionable? Side matches? Quote unexpired and unused? Balance sufficient (spot sells need holdings)? | The same checks, plus: `LIVE_TRADING_ENABLED`, a SIWE-verified wallet, and no pending approval or failed simulation. |
| Submit | Atomic DB transaction: order, fill, balances, position. | The order is created as `awaiting_signature`. The wallet signs the server-built calldata. The hash is reported and the order becomes `submitted`. |
| Settle | Immediate `filled`. | The reconciler polls receipts every 1.5 s and checks sender, router, calldata and value against the order. The Swap event gives the actual amounts: `confirmed`, `failed` (reverted or mismatch) or `expired`. |

- **Submitted is not confirmed.** A live order is `submitted` once the wallet has broadcast it and becomes `confirmed` only when the reconciler has checked its receipt; the UI shows it as pending until then.
- **Duplicate prevention.** Each tap has its own client idempotency key, backed by a unique `(account, key)` index and single-use quotes; a concurrent repeat of the same key returns the one order. The hook runs one trade at a time (until filled, or submitted on Live) and answers extra taps with `busy`.
- **Reconnects.** If the wallet returned a hash but the report never reached the server, the hash is kept in `localStorage` and replayed on reconnect. The server reconciler works independently of any browser. Unsigned orders expire after 3 minutes; an expired order can still be revived if a valid hash is reported within an hour.
- **Custody.** The server never signs and never stores keys. Approvals are for the exact amount only, never unlimited.
- **Wallet binding.** A live quote records the wallet its calldata pays out to; an order is refused (`wallet_mismatch`) unless that is the SIWE-verified wallet.
- **Closing positions.** Close is a one-tap sell of the whole holding: `all: true` on paper; on-chain, the wallet's ETH less the gas reserve, signed in the wallet.

## Data model

Drizzle migrations live in `apps/server/drizzle/` and apply automatically on boot. The tables are:

| Area | Tables |
|---|---|
| Accounts | `accounts`, `sessions`, `siwe_nonces`, `preferences`, `workspace_layouts` |
| Bots | `bots`, `bot_versions`, `bot_installs` |
| Signals | `signals`, `signal_events`, `signal_rejections`, `inference_runs` |
| Market data | `candles` (the persisted point-in-time bars used by backtests and forward records) |
| Trading | `orders`, `fills`, `paper_balances`, `positions`, `journal_entries` |
| Evaluation | `strategy_evaluations` (`backtest`, `forward_paper`, `live`) |
| Ops | `audit_log`, `latency_samples` |

Paper, testnet and live records are separated by a `mode` column on orders, fills and positions. Paper balances have their own table, and on-chain balances are always read live from the chain.

## Chart overlay technique

The chart is TradingView Lightweight Charts v5. Signals are **DOM elements**, not canvas marks. That makes them focusable buttons that support hover, keyboard access and rich animation.

- **Staying pixel-locked to the canvas.** A no-op series primitive's `updateAllViews()` runs on every chart redraw, including price-scale autoscale, which has no public event. It schedules a single `requestAnimationFrame` sync that writes `transform` directly to each marker, so pan and zoom never re-render React.
- **Positioning.** Positions use logical indices (`logicalToCoordinate`), so time gaps and history paging never misplace markers.
- **Clustering.** Overlapping markers are clustered greedily in priority order: selected, then actionable, then newest.
- **Pointer isolation.** Overlay controls stop pointer and wheel propagation, so trading never pans the chart.

## Observability

- **Health.** `/api/health` gives detail: market data, providers, networks and worker. `/api/health/live` is the liveness probe and `/api/health/ready` the readiness probe.
- **Metrics.** `/api/metrics` returns p50/p90/p99 for market lag, bar-close→evaluation, signal publish, inference, quote, order handling and confirmation, plus client metrics reported through `/api/telemetry`. Samples are persisted to `latency_samples`.
- **Logs and errors.** Logs are structured pino JSON, with secrets and cookies redacted. Errors go to Sentry when `SENTRY_DSN` is set.
