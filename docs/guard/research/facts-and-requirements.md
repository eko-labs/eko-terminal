# EKO guard rules 2.0: facts we measured and the owner's requirements

EKO is a harness for trading agents plus a trench terminal on Robinhood Chain (chain id 4663, an Arbitrum Orbit L2).
The engines turn chain data into a per-coin **guard verdict** (today: Clear / Monitor / Danger, plus `pending` when
required checks haven't run, CA-34) and a separate **Signal** (five readings, §7.7, beta, never ranks, never feeds
the guard). Agents' orders pass a preflight that denies buys on Danger and on pending (`packages/policy`). The spec
is in `spec/` (04-BACKEND §6–7 and §23 are the most relevant; FACTS is the contract sheet). Current rule code and
config are in `code/`.

## 1. The owner's requirements (from the review conversation, Oct 2, 2026)

1. The guard is **not a scam detector**. It tells an agent (and a human) **how much risk a buyer takes on right now**:
   "more risk or less risk", never "good to buy". DYOR / NFA must stay central. The Signal and the agent's own rules
   decide entries; the guard decides whether and how carefully an agent may touch the coin.
2. It must be **accurate today** (Q3–Q4 2026 meta, which changes every few months), on Robinhood Chain first, with
   Solana, Base and Hyperliquid in mind. "It can't be that the average trencher has more alpha than our dashboard."
   Definitions must not be invented on a whim: adopt or adapt what proven tools and research use, then calibrate on
   our own chain's data.
3. **Serial deployer must not reach Danger on its own.** It can raise the weight of other red flags (thin liquidity,
   concentration, etc.). History only counts **harm caused by the deployer's own side**: if a deployer's earlier coins
   were dumped by unrelated sniper or copy-trade bots (10–20% bundles from sniping bots), that is not the deployer's
   fault and must not count against them.
4. **Who is the deployer?** A launch service or shared launch contract used by many people is not one person. One
   funding wallet that funded three projects over three years is not a serial scammer: links must be recent and tight.
5. **What is a dump?** Selling must be distinguished from tokens leaving a wallet (burns are not sells; transfers are
   not sells unless the receiver sells). A wallet that bought $10 and sold half at a $500k market cap is taking profit,
   not dumping. Size and timing matter.
6. **Snipe-tax exemption is a normal Pons mechanic.** An exempt wallet can be the deployer, a treasury, a custodian, a
   burn wallet, the fee recipient. Exemption alone is not insider status.
7. **Bundles:** "two connected wallets" is far too weak. Use the strongest published linking signals.
8. Heavy sniping and thin liquidity are real risks for a buyer even when nobody is scamming. They belong in the risk
   level, explained.
9. Every verdict must show its reasons so a trencher can verify them.

## 2. Chain and data facts (measured Oct 1–2, 2026)

- Robinhood Chain makes about **10 blocks per second** (about 860,000 per day, measured over 1,000,000 blocks).
- Logs on 4663 include `blockTimestamp`. The public RPC sustains about 5–6 requests per second (12/s gets throttled
  with non-JSON replies). The paid provider (dRPC) costs about $6 per million requests, flat.
- Pons v2 events (verified): `TokenLaunched(address indexed token, address indexed curve, address indexed deployer,
  address pairToken, uint256 launchConfigId, uint256 graduationThreshold)` (deployer = msg.sender of the factory);
  `CurveBuy(address indexed buyer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee,
  uint256 tax)`; `CurveSell(...)`; `SnipeTaxExempted(address indexed account)` (emitted in the launch block; a wallet
  can appear twice when the launcher is also the fee recipient). Curve views: `creatorTaxBps()`, `feeBps()` (100 =
  the 1% Pons fee), `currentSnipeTaxBps(token)`, `launchedAt()`, `graduated()`.
- Our indexer stores: tokens (launchpad, deployer, curve, first_block, total_supply, graduated block/pool), pools (v3,
  v4), swaps (block, ts, trader, tx_from, tx_to, recipient, side, amounts, price, usd), token_transfers, liquidity
  events, Pons events and exemptions, balances, 1-minute bars. **Native ETH transfers are not indexed** (they aren't
  logs), so "who first funded this wallet" needs a new data source (traces, or full transactions for candidate
  wallets, or an explorer API). Live senders (tx_from) are now resolved only for Pons-coin activity, to keep RPC cost
  near $0.50/day; other tokens are enriched on demand.
- Real-data replay window: 200,000 blocks (**only about 5.6 hours** of chain time, Oct 1): 2,475 Pons launches,
  113,430 curve trades, about 405,000 swaps in total, 2,683 non-Pons tokens seen through Uniswap pools (no known
  deployer, so no card today).

## 3. What the current rules (1.0.2) produced, and why it was wrong

- Verdicts on the 2,475 Pons coins: 0 Clear, 1,803 pending (no buy-then-sell simulation yet), 392 Monitor, 280 Danger.
  **268 of the 280 Danger came from `serial_deployer`.** The owner rejected this, correctly.
- The four biggest "deployers":
  - `0x69bb…`: an EOA calling the Pons factory directly; 172 launches in 5.6 h; never buys or sells its own coins;
    exempts only itself; **0 dumps in 44 measured outcomes**. Got 81 Danger because 3 of its earlier coins matched
    `clone_swarm` at danger (a clone farm, but it holds no supply).
  - `0x0e16…`: **a contract** (130 bytes of code): launches come from many different EOAs calling it; 108 launches with
    **108 distinct exempt-wallet sets (182 wallets)** = 108 different people using a shared launch tool, wrongly
    treated as one deployer. 36 Danger.
  - `0x037d…`: an EIP-7702-delegated EOA calling itself (batched); 75 launches; the same ~10 exempt wallets (2 distinct
    sets); **buys its own coin in the first 3 blocks on all 75** = one operator. 72 Danger.
  - `0x61e6…`: an EIP-7702-delegated EOA with nonce 12,133 (a bot or service), calls the Pons router; 31 launches; buys
    its own coin in the first 3 blocks on all 31. 28 Danger.
- Exemptions overall: 8,273 rows, 3,715 wallets, 2,475 tokens; a group of 6+ wallets is exempt on exactly 76 launches.
- The 1h outcome `dumped` (current definition: deployer + every exempt wallet sold > 50% of what they held within the
  first hour) fired on **1,215 of 1,681** measured coins (72%). But the price an hour later was within 25% of the
  launch price for **1,125 of those (93%)**; none fell more than 50%. Sellers: deployer only 860, exempt wallets only
  163, both 192. A sample "dump": price −3.9%, the insider sold 100% of a tiny holding. **The current "dump" measures
  "an insider sold most of their own (possibly tiny) bag", not harm to buyers.** It is also measured from launch price,
  so a launch-block insider buy followed by a sell back to the curve shows ~0% drop even if buyers in between lost.
- `wash_to_trend` (1.0.1, after an earlier false-positive fix) and `fee_trap_pool` produce Monitor only; `clone_swarm`
  9 Danger; `exempt_insiders` 4 Danger, 29 Monitor (exempt wallets bought ≥ 50% / 20% of supply).

## 4. Constraints that stay

- Claims rules: never "safe" as a claim, "audited", "trustless", "guaranteed", "win rate", "rug-proof", no price
  predictions; DYOR / Not financial advice / AI-generated analysis on every verdict surface. Robinhood wording: "Built
  on Robinhood Chain" plus the non-affiliation line; never "partner" or "official".
- A coin must never read as the lowest-risk level because a check couldn't run (CA-34): missing checks are named.
- Rules are versioned; the rules version is hashed into every verdict receipt; history is never deleted, only
  superseded.
- Engine costs: the replay of 200k blocks takes about 17 minutes on one machine; live RPC spend is metered and capped.
- No personal data about the team anywhere; the team is anonymous.
