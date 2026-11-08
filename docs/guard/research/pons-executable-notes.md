# Pons v2 executable notes (lead, Oct 2, 2026)

These are verified facts for the exit simulation (guard 040), pool custody (042), Pons calldata (072) and the guard's
exemption handling, written in our own words.
- **Source:** the public `ponsdotdev/pons-labs` repository. Its files carry `SPDX-License-Identifier: MIT` headers,
  though the repository has no LICENSE file.
- **Deployed code:** checked against the curve deployed on Robinhood Chain (chain 4663), with reads through the public
  RPC.
- **Where they disagree:** the deployed code wins.

## Deployed curve

**Sample:** curve `0x13a97f4acc05f71222f8dd0f2ad3d482ba916039` for token
`0x3cc9a9e81e9d694251438ad5abeea9a692d88f28`, launched at block 78,402,958. Its bytecode is 10,229 bytes.

These selectors are present in the deployed bytecode:

| Function | Selector |
|---|---|
| `buy(uint256 quoteIn, uint256 minTokensOut, address recipient)`, payable | `0x59a87bc1` |
| `sell(uint256 tokensIn, uint256 minQuoteOut, address recipient)` | `0xd04c6983` |
| `currentSnipeTaxBps(address token)` | `0xd7e1ef39` |
| `creatorTaxBps()` | `0xc1bb8901` |
| `feeBps()` | `0x24a9d853` |
| `getReserves()` | `0x0902f1ac` |
| `sellableTokens()` | `0x808bcddc` |
| `realQuoteReserve()` | `0x4f1f58fd` |
| `graduationThreshold()` | `0x8b0bc501` |
| `readyToGraduate()` | `0xc68360a5` |

Live reads on that sample, at head on Oct 2:
- `feeBps` = 100 (the 1% Pons fee)
- `creatorTaxBps` = 200
- `graduationThreshold` = 4.2 ETH
- `sellableTokens` ≈ 7.14e26
- `readyToGraduate` = false
- `currentSnipeTaxBps` = 0

**Mismatch:** the published curve file has no anti-snipe code, yet the deployed curve exposes `currentSnipeTaxBps`. So
the published source is not exactly what's deployed, and simulation results must be confirmed by forked execution
against deployed code.

## Trading rules (from the published source; confirm on a fork)

**Reserves**
- The quote reserve used for pricing is `phantomQuote + trackedQuote − pendingFees − pendingCreatorTax`. It includes
  virtual liquidity.
- The token reserve is `trackedTokens`.
- `realQuoteReserve` excludes the virtual part.

**Buy**
1. For a native launch, the quote paid must equal `msg.value`.
2. `fee = floor(spent × feeBps / 10,000)` and `tax = floor(spent × creatorTaxBps / 10,000)`, both taken from the
   quote leg.
3. `tokensOut = floor((spent − fee − tax) × tokenReserve / (quoteReserve + (spent − fee − tax)))`. That is a
   constant-product formula with no extra fee.
4. A buy larger than `sellableTokens` is clamped to it. The quote it actually spends is grossed back up so fee and tax
   still come from the input, and the difference is refunded to the sender.
5. Slippage is checked on price, not quantity: `spent × minTokensOut ≤ received × tokensOut`.
6. The tokens go to `recipient`, the curve emits `CurveBuy(buyer, recipient, spent, tokensOut, fee, tax)`, and then
   automatic graduation is attempted.

**Sell**
1. Requires an ERC-20 approval. It's closed once graduated or `readyToGraduate`.
2. `gross = floor(tokensIn × quoteReserve / (tokenReserve + tokensIn))`.
3. Fee and tax are floored from `gross`, and `quoteOut = gross − fee − tax`, sent to `recipient`.
4. The curve emits `CurveSell(seller, recipient, tokensIn, quoteOut, fee, tax)`.

**Graduation**
- `readyToGraduate` is true when `sellableTokens` reaches 0.
- The factory's `graduate` stops trading, sweeps fees, and hands the tracked reserves to a Uniswap v4 pool.
- Tokens or quote force-sent to the curve stay on the curve; they are not added to the pool.

## Deployed per-launch snipe terms (curve getters, Oct 2, 2026)

The deployed curve (not the published source) exposes the launch snapshot directly. All four selectors are in the
dispatcher of the sample curve and of a second, graduated coin's curve:

| Getter | Selector | Sample curve | Second curve |
|---|---|---|---|
| `launchedAt()` | `0xbf56b371` | 1790961398 | 1790653061 |
| `snipeTaxStartBps()` | `0x50e25ac2` | 9900 | 9900 |
| `snipeTaxSeconds()` | `0x6783774b` | 3 | 3 |
| `snipeTaxExempt(address)` | `0xd44bdfe7` | — | deployer → true |

- The factory's current `snipeTaxSeconds()` is also 3. Live launches use a **3-second** window, not the published
  default of 15.
- `decayEndSec` for a fork route is `launchedAt + snipeTaxSeconds`, read from the curve itself.
- Exemption is checkable per address with `snipeTaxExempt`. The complete list still comes from the factory's launch
  records and events.

## Anti-snipe tax and exemptions (factory, published source)

- Each launch snapshots its anti-snipe terms when it's created: by default 99% (`snipeTaxStartBps` 9,900) in the
  launch second, decaying exponentially to zero over `snipeTaxSeconds` (default 15 s). The tax is charged on a buy's
  quote leg.
- The launcher and the creator-fee recipient are exempt automatically.
- The launch overload with a list of exemption wallets is described by Pons as "the sanctioned pathway for organized
  teams that bundle their opening buys across several wallets". Declared wallets buy untaxed during the window.
- **Consequence for the guard:** wallets beyond the launcher and fee recipient are, by Pons's own design, declared
  team wallets. Their early buys are declared team concentration. Exemption still proves nothing about later selling,
  and a wallet that only holds or burns is not dumping.
- Launches can also be made for someone else (`launchTokenFor`, a `launchForwarder`). The factory's `deployer` field can
  therefore be a launch service rather than the creator (this matches the shared-launch-contract finding in
  facts-and-requirements §3).

## Lead fork validation (Oct 2, 2026)

Anvil forked the chain at block 78412898 through the paid archive endpoint, with about a hundred lazy reads. The test made a
buy of 0.04 ETH on the sample curve, then sold everything back:

| Leg | Predicted by the formulas above | Observed | Exact match |
|---|---|---|---|
| Buy, tokens received | 22,573,888,759,599,720,722,263,271 | 22,573,888,759,599,720,722,263,271 | yes |
| Sell, `CurveSell.quoteOut` | 37,636,000,000,000,001 wei | 37,636,000,000,000,001 wei | yes |

- `fee` = 387,999,999,999,999 and `tax` = 775,999,999,999,999 on the sell. These match floor(gross × 100 / 10,000)
  and floor(gross × 200 / 10,000).
- **Round-trip cost at about $100:** 5.91%. That is the 1% fee and the 2% creator tax on each leg, plus curve price
  impact.

**Never use Anvil's default accounts on this chain.** The well-known default account `0xf39F…2266` has an EIP-7702
delegation installed on Robinhood Chain (code `0xef0100…`, almost certainly a sweeper). The sell's ETH was paid, as
`CurveSell` shows, but never stayed in that account. Fork checks must use freshly generated keys that have no code at
the pinned block. They should also assert that the recipient's balance delta equals the event's `quoteOut`.

## What still needs a fork

- The deployed rounding, the snipe-tax application, and the refund path have to match the formulas above.
- Each check is a buy-then-sell on a fork at a pinned block, at $100 and $1,000, run as both an ordinary account and a
  smart account.
- The comparison is the actual token and ETH deltas against these formulas.
- Fork reads must go through the metered fork gateway (task 138).
