# The edge, as built

`apps/edge` is the whole live service at ekoterminal.com: one Node process (Fastify) that follows Montra launches on
Elysium (chain 99901), checks each coin, serves the web app and landing site, signs wallets in, prepares trades for
wallets and agents to sign, and answers agents over MCP. This page says who can do what, what it holds, and what it
trusts. The guarantees it relies on are listed, each with its test, in
[docs/security/INVARIANTS.md](../../docs/security/INVARIANTS.md#edge-elysium).

The rest of the repository (`apps/server`, `apps/engines`, `apps/indexer`, `apps/mcp`, `contracts/`) is the earlier
Robinhood Chain stack. It is not deployed for Elysium.

## Runtime

| Part | Where | Notes |
| --- | --- | --- |
| Process | Railway service `eko-edge`, image `Dockerfile.edge` | Deployed by Railway from GitHub `eko-labs/eko`, branch `main`, on each push; with "Wait for CI" on (the intended setting) only after CI passes. `/health` reports the commit (`build.ts`); `scripts/verify-edge.mjs` checks it and the live trading config. |
| State | One SQLite file on the service's volume (`HISTORY_DB`) | Accounts, sessions, preferences, watchlists, agents, keys, journals, approvals, orders, and EKO's chain memory (launches, outcomes, funders). Nothing in it is a signing key. |
| Chain reads | `RPC_HTTP_URL` (paid, read-only key) or the public RPC | Through the metered layer (`@eko/chain`): budgets, timeouts, back-off. The browser relay `/v1/rpc` has its own public-RPC client (`relay.ts`) and never uses the paid lane. |
| Other reads | Elysium Blockscout (`explorer.ts`), Hyperliquid `allMids` (`hype.ts`) | Funder history for deployers; HYPE's USD price. Both keyless. |

## Actors and what each can call

| Actor | How it is identified | Can | Cannot |
| --- | --- | --- | --- |
| Visitor | nothing | Read routes (`/v1/feed`, coins, verdicts, deployers, config, `/health`), quotes (`POST /v1/trade/quote`, no wallet), the read-only relay (`POST /v1/rpc`, allowlisted methods, no full blocks), the websocket (public channels), MCP read tools (`coin_verdict`, `coin_card`, `playbook_match`, `deployer_history`, `new_launches`, `coins`, `watch`, and a feature's own read tool while its flag is on) | Any write that needs a wallet (401). Private socket channels. |
| Wallet | SIWE on chain 99901, then a session cookie (`HttpOnly; SameSite=Lax`, 30 days) | Its own preferences, watchlist, alert settings, journal consent, data deletion; trade orders from its own quotes, and marking its own orders submitted or rejected; up to 3 active agents (10 kept in all, the oldest hard-killed one deleted first) with up to 5 live keys each, their policies, kill switches and approvals | Another account's anything: every read and write is filtered by the session's account (404, or 403 for another wallet's quote). Writes from another site's page (403, `sameOrigin`). |
| Agent | Bearer key `eko_…` on `POST /mcp` (stored as a SHA-256 hash, shown once) | `preflight` against its owner's policy, `trade_prepare` (an unsigned swap for the wallet its owner set), `journal` (notes, session starts, outcomes); every call it makes is summarised for its owner's live view (`src/agent-activity.ts`: tool, coin, verdict and score, decision, sizes, note; never its arguments or key) | Write decisions or orders into its own journal; trade without a fresh EKO-recorded allow; choose its own wallet; trade above its policy, slippage cap or `MAX_TRADE_USD`; act after its owner pauses or kills it, or after its key is revoked (401). |
| Owner (a wallet, over its agents) | the wallet's session | Approve or deny an agent's pending order (bound to that exact order, one use, 15 minutes), pause, resume, hard-kill (revokes every key), set policy and wallet; watch its calls live (`GET /v1/agents/:id/activity`, and `call` events on its private `agents` socket channel) | Approve orders of another account's agents (404). |
| Operator | Railway project access, GitHub `main` | Deploy (merging to `main`), set environment and flags (`EKO_FLAGS`), read the volume | — |

There is no admin route. Nothing on the server can sign a transaction or move funds: every trade is an unsigned
transaction that the user's wallet, or the agent's own wallet, signs.

## Secrets and sensitive data

| Item | Where | Exposure if leaked |
| --- | --- | --- |
| `RPC_HTTP_URL` key | Railway variable | RPC credit only (read-only key). |
| Session tokens | Cookie on the user's browser; the server keeps only their SHA-256 | A stolen cookie acts as that wallet in EKO (no funds: trades still need the wallet's signature). Logout and data deletion end it. |
| Agent keys | Shown once to the owner; the server keeps only their SHA-256 | Acts as that agent within its owner's policy and approvals. The owner revokes or hard-kills. |
| SIWE nonces | Server, single use, 10 minutes | — |
| Accounts' data | The volume | Wallet addresses, preferences, watchlists, agent journals, order history. `DELETE /v1/me/data` erases one account. |

The publishing secrets (`PUBLIC_DEPLOY_KEY`, `PRIVATE_DENYLIST`) live in GitHub Actions, never on the server.

## Trust assumptions

- **The RPC tells the truth about Elysium.** Verdicts, sell probes and order simulations are `eth_call`s against one
  provider. A lying RPC could show a honeypot as clear; the user's wallet still shows and signs the real transaction.
- **Railway's proxy is the only hop.** Client addresses for rate limits come from exactly `TRUST_PROXY_HOPS` (1)
  trusted proxies; anything a client writes before that is ignored. Add one per extra proxy (for example Cloudflare).
- **Hyperliquid's HYPE price is close enough.** It converts USD caps and quotes to HYPE. A wrong price moves the cap
  in HYPE terms; the swap's minimum output still protects the trade itself.
- **Blockscout's history is advisory.** Funder and deployer history feed the verdict's context, never a trade guard.
- **Wallets sign what they are shown.** Swap output always goes to whoever signs (Universal Router `MSG_SENDER`), never
  to an address in a request.
- **Railway and GitHub hold the deployment.** Whoever controls the Railway project or can merge to `main` controls the
  live code and its variables.

## Limits that keep one client from taking the service

Request bodies 16 KB (49 KB for SIWE, 64 KB for MCP); sign-in 30 nonces and 20 verifications a minute per address,
and 10 new accounts a day per address (known wallets always sign in). Trading has its own share of the paid RPC lane:
240 calls a minute and 8 in flight for quotes, order simulations and receipt checks from every route together, so no
number of accounts or agents can starve the tracker; within it, signed-out quotes share 40 a minute in all, quotes are 30 a minute per address and per wallet,
orders 20 a minute per account or agent (60 per address), 10 in flight per account. Receipt checks have a reserved
slice (60 a minute), and sign-in's contract-wallet check its own (60 a minute), so neither can be crowded out or crowd out
the tracker. MCP 120 calls a minute per agent
or address, counting each batch entry, and 600 per address across agents; within it `watch` 30 a minute and 2 waiting at once
per agent or address (500 waiting in all, each at most 25 s), `coins` pages of at most 50 rows from a list shared by every
agent and rebuilt at most every 10 s, and a live view of the newest 100 calls per agent in memory; the relay 120 calls a minute per address,
600 in all, 16 in flight; 20 websockets per address, 64 channels per socket, idle ones closed after 2 minutes; funder
lookups from page views in their own bounded lane behind live deployers. Stored per account: 3 active and 10 kept
agents, 5 live keys and 20 key rows per agent, journals of 1,000 rows and 90 days per agent, 2,000 journal rows (500
of them notes) per account a day, 20 pending and 200 settled approvals per agent, 20 sessions, 500 settled orders,
500 watchlist items. Across all accounts, the storage guard (`src/storage-guard.ts`) refuses every write of user
content (new accounts, agents, keys, journal rows, approvals, orders, watchlist, preferences, alert settings, consent)
with 507 while the database volume has less than `STORE_MIN_FREE_MB` (512 MB) free, keeping that reserve for EKO's
chain memory and existing sign-ins. Tests: `test/limits.test.ts`.

## Tests by concern

| Concern | File |
| --- | --- |
| Every write route refuses another site, no session, another account and bad input | `test/refusals.test.ts` |
| Agent trading guardrails (forged allows, approval binding, owner-set wallet, slippage and impact, `MSG_SENDER`) | `test/agent-trading.test.ts` |
| Request size, client address, relay, storage, websockets, build identity | `test/limits.test.ts` |
| Sign-in, sessions, quotes and the swap encoding against mainnet swaps | `test/accounts-trade.test.ts` |
| Agents, keys and MCP tools | `test/agents-mcp.test.ts` |
| MCP coins and watch, descriptions for every launchpad, feature tools, owners' live activity | `test/mcp-tools.test.ts` |
