# Integrations

Everything here was verified against primary sources on **2026-09-28**. Contract addresses and chain IDs were additionally checked on-chain (bytecode present, router wiring, live quotes). Re-verify before relying on anything that may have changed.

## Robinhood Chain

Robinhood Chain is an Arbitrum Nitro rollup with ETH as its gas token. It is **not** a Robinhood brokerage account and **not** the Robinhood brokerage trading API.

| | Mainnet | Testnet |
|---|---|---|
| Chain ID | 4663 (`0x1237`) | 46630 (`0xb626`) |
| Public RPC | `https://rpc.mainnet.chain.robinhood.com` | `https://rpc.testnet.chain.robinhood.com` |
| Explorer | https://robinhoodchain.blockscout.com | https://explorer.testnet.chain.robinhood.com |
| Faucet | none | https://faucet.testnet.chain.robinhood.com |
| Status | Live since 2026-07-01 | Live since 2026-02-10 |

- Sources: https://docs.robinhood.com/chain/connecting and https://docs.robinhood.com/chain.
- The **public RPC endpoints are rate-limited and "not recommended for production"**, and we hit HTTP 429 while forking. Use a listed provider (Alchemy, Chainstack, QuickNode, Blockdaemon, dRPC, Validation Cloud or GlobalStake) through `RH_MAINNET_RPC_URL`.
- **Wallets.** The docs name Robinhood Wallet and MetaMask; any EVM wallet can add the chain. SignalOS discovers injected wallets through EIP-6963 using wagmi's `injected()` connector.
- **viem** ships `robinhood` and `robinhoodTestnet`. We override their transports with the official RPCs, because viem's default mainnet list includes an unlisted third-party RPC.

### Execution venue: Uniswap v3 (mainnet only)

Sources:
- https://developers.uniswap.org/docs/protocols/v3/deployments/v3-robinhood-chain-deployments
- https://docs.robinhood.com/chain/contracts (tokens)

| Contract | Address |
|---|---|
| UniswapV3Factory | `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA` |
| QuoterV2 | `0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7` |
| SwapRouter02 | `0xCaf681a66D020601342297493863E78C959E5cb2` |
| WETH (18 decimals) | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| USDG "Global Dollar" (6 decimals) | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` |

- **On-chain checks** (see `apps/server` fork tests):
  - SwapRouter02 `factory()` and `WETH9()` match the addresses above.
  - WETH/USDG pools exist at all four fee tiers (0.01/0.05/0.3/1%).
  - A live QuoterV2 quote returned 0.1 WETH → ≈269.6 USDG in the 0.01% pool.
- **Read-only re-check on 2026-09-28** through the server's own `ChainClients` + `UniswapV3Adapter` against the public RPC (no wallet, nothing signed): `eth_chainId` 4663, block 75,219,607 (166 ms); SELL 0.1 ETH → 268.8968 USDG (2,688.97 USDG/ETH, 0.01% pool, 345 ms end to end); BUY 250 USDG → 0.0929537 ETH (2,689.51, 0.01% pool, 309 ms). Coinbase ETH-USD was 2,687.41 at the time.
- **RPC default.** With `RH_MAINNET_RPC_URL` unset, the server (and the browser wallet client) use the official public RPC above; set a provider URL for production.
- **Route.** `ETH-USD` → ETH ⇄ USDG. For a BUY: USDG → WETH, then unwrapped to native ETH. For a SELL: native ETH in → USDG.
- **Calls.**
  - Quotes use `QuoterV2.quoteExactInputSingle` on every tier; the best output is used.
  - Swaps use `SwapRouter02.multicall(deadline, [exactInputSingle(...), unwrapWETH9(min, recipient)?])` with `amountOutMinimum` derived from the user's slippage tolerance and a 120 s deadline.
  - Approvals are exact-amount ERC-20 `approve`, never unlimited.
- **Markets without a verified token and venue** (BTC, SOL, LINK, AVAX, DOGE, UNI, ARB, SUI and PEPE) are **paper-only**. They are labelled in the UI, and the server refuses live quotes for them with `no_route`.
- **Testnet.** Uniswap lists no Robinhood testnet deployment, and the v3 contracts have no code at those addresses on 46630. Testnet mode therefore supports wallet, network and balance checks only, and swaps are refused with an explanation. For end-to-end execution tests we fork mainnet locally with Anvil.
- **Not integrated.** Aggregators (Uniswap Trading API, 0x, 1inch, LI.FI and KyberSwap all list chain 4663) could improve routing and add stock-token liquidity. They need API keys or terms and are left as adapters to add later; see `ExecutionAdapter` in `apps/server/src/exec`.
- **Stock tokens** exist on mainnet but are **not offered to US persons** (and are restricted in Canada, the UK, Switzerland, the UAE and sanctioned jurisdictions). SignalOS does not list them, and adding them requires jurisdiction gating.

## Market data

### Coinbase (default)

- **Streaming.** `wss://ws-feed.exchange.coinbase.com` on the unauthenticated `matches`, `ticker` and `heartbeat` channels. Trades are aggregated into 1m…1d bars on the server. The `ticker` channel's `open_24h`, `volume_24h`, `high_24h` and `low_24h` fill the 24h stats.
- **Order books.** `level2_batch` (verified to work unauthenticated on 2026-09-28; Coinbase acknowledges it as `level2_50`) is subscribed only for markets a client is watching (at most 6), maintained in memory from `snapshot` + `l2update`, and sent to watching clients as the top 20 levels per side at ≤ 4 Hz (`{type:'book'}` over the WebSocket, `GET /api/book?market=`). If Coinbase ever refuses level 2 without authentication, the feed keeps streaming trades and polls `GET https://api.exchange.coinbase.com/products/{id}/book?level=2` every 1.5 s for watched markets instead.
- **Markets.** ETH, BTC, SOL, LINK, AVAX, DOGE, UNI, ARB, SUI and PEPE against USD (Coinbase product ids of the same name). Prices below one cent display with four significant digits (PEPE ≈ $0.000004210).
- **History and gap repair.** `GET https://api.coinbase.com/api/v3/brokerage/market/products/{id}/candles` with native `FOUR_HOUR`, at most 350 bars per request, returned newest first. Requests are paced to stay well under the public limits.
- **Resilience.** Reconnects use exponential backoff with jitter. A stale-data watchdog marks the feed stale after 8 s without data and forces a reconnect at 20 s. After every reconnect the most recent 30 bars are repaired from REST. Paper fills refuse to execute on stale data.
- **⚠ Licensing.** Coinbase's Market Data Terms restrict displaying or redistributing the data to third parties without an agreement (https://www.coinbase.com/legal/market_data), and Kraken requires permission for commercial use. The feed is fine for development and a private beta. A public launch needs a licensed feed or written permission; see [LAUNCH.md](LAUNCH.md).

### Simulator

`MARKET_DATA_SOURCE=demo` selects a deterministic, seeded model: volatility regimes, drift regimes and intraminute tick paths, calibrated to realistic daily volatility (ETH ≈3.4%, BTC ≈2.5%). It is always labelled "Simulated data" and never mixed with real data, and every stored record carries a `simulatedData` flag. It also synthesizes a deterministic 20-level order book around the simulated price (`simulated: true`) and 24h high/low.

## AI providers

All adapters live in `apps/server/src/ai/providers`. Keys are server-side only. A provider is enabled when its own key is set, or when the AI gateway key is set (below). The direct adapters have **not** been exercised against the providers' own APIs (no direct keys were available); they are written against the current docs and covered by tests with a scripted provider.

### AI gateway (one key for every analyst)

Like Anonyma, SignalOS can run every AI analyst through **one OpenAI-compatible gateway key**: PPQ.ai by default (`GATEWAY_BASE_URL=https://api.ppq.ai`, `GATEWAY_API_KEY`). Run `pnpm setup:ai`: it prompts for the key with hidden input, verifies it with `POST https://api.ppq.ai/credits/balance` (no generation, nothing spent), and writes the two variables to `apps/server/.env` atomically with mode 0600. It never prints the key.

- **Routing.** Each provider without its own direct key is served by `ChatCompletionsProvider` against `${GATEWAY_BASE_URL}/v1/chat/completions`. A direct key always wins. OpenRouter is itself a router and is never proxied. Health and `/api/config` expose `route: 'direct' | 'gateway'` and `via: 'PPQ'` per provider, so the UI can show "Claude · via PPQ".
- **Default gateway models** (ids from PPQ's live catalog snapshot of 2026-09-28; override with `GATEWAY_MODEL_<PROVIDER>`):

| Provider | Gateway model | PPQ price in/out per MTok |
|---|---|---|
| Anthropic (Pulse) | `claude-sonnet-5` | $2.11 / $10.55 |
| OpenAI (Atlas) | `gpt-5.6-sol` (flagship option: `gpt-6-astra-pro`, $10.55 / $52.75) | $2.11 / $10.55 |
| Google (Lumen) | `google/gemini-3.8-flash` | $0.375 / $1.875 |
| xAI (Halcyon) | `grok-4.6` | $2.11 / $6.33 |
| DeepSeek (Deep Current) | `deepseek/deepseek-v4.1-flash` | $0.2321 / $0.6963 |
| Mistral / Groq | `mistralai/mistral-small-2603` / `openai/gpt-oss-120b` | $0.158 / $0.633 |

- **Structured output.** The gateway request starts with `response_format: json_schema` (strict). If the gateway rejects it (a 400/422 about the format, or a router 404 "No endpoints found … Filter by Parameters"), the adapter retries with `json_object` and then with a prompt-only request that carries the schema, and remembers the mode that worked per model. Claude starts at `json_object` because PPQ has no json_schema-capable endpoint for it. `validateModelOutput` guards every answer either way. Router error bodies are stripped of account identifiers before they are logged or shown.
- **Verified for real on 2026-09-28**, one call per route with the default models, the ETH-USD 1h snapshot of that hour and the production prompt; every answer passed `validateModelOutput`:

| Route | Model returned | Mode that worked | Latency | Tokens in/out | Decision |
|---|---|---|---|---|---|
| Claude via PPQ | `anthropic/claude-sonnet-5` | `json_object` (json_schema → 404 "No endpoints found") | 10.4 s | 2,463 / 769 | abstain |
| GPT via PPQ | `openai/gpt-5.6-sol` | `json_schema` | 4.2 s | 1,757 / 330 | abstain |
| Gemini via PPQ | `google/gemini-3.8-flash` | `json_schema` | 7.6 s | 2,582 / 882 | abstain |
| Grok via PPQ | `x-ai/grok-4.6` | `json_schema` | 12.7 s | 1,908 / 1,178 | abstain |
| DeepSeek via PPQ | `deepseek/deepseek-v4.1-flash` | `json_schema` | 8.8 s | 1,579 / 1,176 | hold |

  All five fit inside the default `AI_TIMEOUT_MS=25000`. The full server path ("Analyze now" → persist → broadcast) was exercised with a scripted provider, not with the live gateway.

### Direct provider keys

| Provider | Endpoint | Structured output | Default model |
|---|---|---|---|
| Anthropic | Messages API through the official SDK (`@anthropic-ai/sdk`) | `output_config.format` JSON Schema, `effort: low`, `fallbacks: "default"` (beta header); `stop_reason: refusal` handled | `claude-opus-5` |
| OpenAI | `POST /v1/responses`, `store: false` | `text.format` json_schema, strict | `gpt-6-luna` |
| Google | `POST v1beta/models/{m}:generateContent` | `generationConfig.responseFormat.text` JSON Schema | `gemini-3.8-flash` |
| xAI | `POST /v1/responses`, `store: false` | `text.format` json_schema, strict | `grok-4.3` |
| DeepSeek | `POST /chat/completions` | `json_object` only, so validation is server-side (zod) | `deepseek-flash` |
| Mistral / Groq / OpenRouter | Chat Completions | `response_format` json_schema (OpenRouter with `provider.require_parameters`) | configurable |

- **Errors.** Errors are mapped to typed codes. 429 and 5xx are retried once, honouring `Retry-After`. Quota and billing errors are never retried. Three consecutive failures open a circuit breaker with exponential backoff.
- **Cost controls.**
  - `AI_DAILY_BUDGET_USD` is a hard stop checked before every call, including on-demand runs.
  - `AI_MAX_CALLS_PER_BOT_HOUR` caps calls per bot; "Analyze now" is also limited to 6 runs per account per minute.
  - Identical inputs are cached by input hash (a repeated "Analyze now" on the same bar returns the stored result without a model call).
  - AI bots run on 5m–1d timeframes (never 1m). Scheduled runs happen only at bar close of a chart someone is watching **with that bot enabled** (or a member of an enabled ensemble).
  - Through the gateway, the cost recorded per run is the gateway's reported upstream cost × 1.055 (PPQ's markup); otherwise it is estimated from token counts with the direct or gateway price table.
  - Unverified prices use a pessimistic fallback ($15/$75 per MTok) so budgets err on the safe side.
- **Usage policies that matter for launch.** Anthropic's AUP classes consumer-facing investment advice as high-risk: it requires human review by a qualified professional and disclosure of AI at the start of each session. Google and DeepSeek disclaim financial reliance, and OpenAI prohibits tailored licensed advice without professional involvement. See [LAUNCH.md](LAUNCH.md).

## Wallets and authentication

- **wagmi v3 and viem 2.56.** Injected wallets are discovered via EIP-6963. The app detects the wrong network from the connection's own `chainId`, because `useChainId()` falls back to a configured chain, and switches networks with `wallet_switchEthereumChain` (or `wallet_addEthereumChain` if the chain is missing).
- **Sign-In With Ethereum (EIP-4361).**
  - Nonces are bound to the session, single-use, and valid for 10 minutes.
  - The domain, chain and expiry are validated.
  - EOA signatures are verified offline; smart wallets fall back to ERC-1271/6492 verification over RPC.
  - The session rotates on login.
  - SIWE is required for on-chain orders and for publishing bots.
- WalletConnect is not bundled; it would need `@walletconnect/ethereum-provider` and a project ID.

## Charting

TradingView Lightweight Charts™ **5.2.1**, Apache-2.0. The in-chart logo is disabled and replaced by a visible "Charts by TradingView" link in the status bar plus the [NOTICE](../NOTICE) file, which satisfies the attribution requirement.
