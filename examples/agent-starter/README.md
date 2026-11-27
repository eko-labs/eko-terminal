# EKO starter agent (dry run)

A small TypeScript agent you run on your own machine. It connects to EKO's MCP server with your agent key,
waits for news with `watch`, keeps coins that EKO rates **clear** with an **EKO score** of at least `MIN_SCORE`,
asks `preflight` before every would-be buy, prepares the trade with `trade_prepare` when preflight allows it, and
writes its reasoning to your journal. Open the agent's page in Mission Control to watch each call as it happens.

**It never signs or sends anything.** There is no private key in this program, and EKO never holds keys. A prepared
trade is an unsigned transaction for the wallet you set for this agent in Mission Control; the starter prints it
and drops it.

## Run it

1. On EKO: Mission Control → Connect an agent → create the agent and its key (shown once; copy it).
2. Optional: on the agent's page, Connection → set the wallet it would trade from (needed for `trade_prepare`).
3. Node 18 or later:

```sh
cd examples/agent-starter
EKO_KEY=eko_your_key_here npx tsx agent.ts
```

On Node 23.6 or later `EKO_KEY=eko_your_key_here node agent.ts` works too (Node runs the TypeScript directly).

| Variable | Default | Meaning |
| --- | --- | --- |
| `EKO_KEY` | (required) | The agent key from Mission Control (`eko_…`). Keep it out of your shell history and out of git. |
| `EKO_MCP_URL` | `https://ekoterminal.com/mcp` | EKO's MCP endpoint. |
| `MIN_SCORE` | `70` | Lowest EKO score to consider (70-100 is the OK band). |
| `BUY_USD` | `25` | Size of each would-be buy. Your owner policy still caps it. |
| `MAX_AGE_MIN` | `60` | On start, look at coins launched at most this long ago. |
| `ONCE` | unset | `1`: one pass over the current list, then exit. |

Stop it with Ctrl-C.

## What it calls

- `coins` once at start (clear, score at least `MIN_SCORE`, newest hour, best score first).
- `watch` in a loop (long-poll, up to 25 s, with the cursor it got back): new launches and verdict changes.
- `coin_verdict`, then `preflight` (your policy decides: allow, deny or needs approval), then `trade_prepare`.
- `journal` for its session start and each decision, in plain words.

## Adding your own signing (at your own risk)

The starter stops at the unsigned transaction on purpose. If **you** want an agent that trades, you add signing
yourself, in your own program, with a wallet you control and can afford to lose:

1. Use a separate hot wallet with a small balance, never your main wallet. Set that wallet as this agent's wallet in
   Mission Control (EKO prepares trades only for it).
2. Keep its private key in your own secret store or environment, never in code, git, a prompt or the journal. EKO
   never asks for it and must never receive it.
3. Where the starter prints "prepared (unsigned, NOT sent)", sign and send `tx` with a library such as viem
   (`walletClient.sendTransaction({ to: tx.to, data: tx.data, value: BigInt(tx.value) })`) within five minutes
   (the trade reverts if the price moves past `minOut`). If `trade_prepare` returns `approve_first`, send those
   approval transactions first, then call `trade_prepare` again.
4. Keep the owner protections on: preflight before every order, your policy's caps, approvals above your line, and
   the kill switch in Mission Control.

EKO's checks and score are risk information, not financial advice; a score is not a recommendation to buy.
