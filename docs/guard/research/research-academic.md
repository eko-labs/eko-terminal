I've summarised 20 papers below. Thresholds marked **[V]** were checked against the paper's full text. Anything not checked that way is marked **[unverified]**. Thresholds are given as exact numbers rather than long quotes.

**The short version:**
- **Rug pull = liquidity removal.** Published work is well grounded here: at least 99% of LP removed, or liquidity draining to about zero with no recovery.
- **Dev dump and insider sell are not settled.** Most labels look only at the outcome (price, liquidity or holder collapse) and don't check who sold. Only four papers tie the sale to the creator or linked wallets: Cernera, Xia, Fragmented Rug Pull and Meme Coin Factories.
- **No peer-reviewed study covers an EVM bonding-curve launchpad, Uniswap v3/v4 liquidity removal, or any of your four specific questions.**

---

## 1. Per paper

**Cernera, La Morgia, Mei, Sassi — USENIX Security '23** ([USENIX](https://www.usenix.org/conference/usenixsecurity23/presentation/cernera), [arXiv 2206.08202](https://arxiv.org/abs/2206.08202)) [V]
- **Data:** Ethereum and BSC from genesis to 2022-03-07. Uniswap V2 and PancakeSwap-style pools.
- **Lifetime:**
  - A token lives from its deploy block to the last block where it emits any event.
  - A pool lives from `PairCreated` to its last event.
  - "1-block tokens" have zero lifetime. "1-day tokens" live under 24 h. That is about 60% of all tokens, and 51.7% (BSC) / 37.7% (ETH) of tokens that were ever active.
- **Token spammers** are the top 1% of creator addresses by number of tokens created. They create 24.3% of BSC tokens and 20.1% of ETH tokens, about 61 and 51 tokens each on average. The cut is relative: 95% of addresses create 5 tokens or fewer, and the top 1% create more than 18.
- **1-day rug pull:**
  - Scope: 1-day tokens that have a pool (332,265 on BSC, 25,180 on ETH).
  - Rule: the pool emitted exactly one Mint and one Burn, and that Burn removes at least 99% of the minted LP tokens. They use 99% rather than 100% because of rounding dust.
  - Hit rate: 81.2% of those pools on BSC, 86.3% on ETH.
  - Serial operators: 115 BSC addresses ran more than 100 rug pulls each.
- **Profit and victims:**
  - Gain is `δB − fees`; net gain is `− T_in + T_out − fees_swap` on top of that.
  - An operation is "successful" if net gain > 0.
  - When counting victims, they drop addresses that swapped in pools they created themselves.
- **Variants they describe but do not detect:** wash trading, gradual pumping, and "hedging" (the creator gradually sells a reserve of tokens).
- **Sniper bots:**
  - BSC: average delay under 5 blocks (15 s) and swaps in at least 100 pools.
  - ETH: average delay under 3 blocks (45 s) and at least 10 pools.
  - 31% (BSC) and 60% (ETH) of these bots' swaps land in the same block as the first liquidity add.
- **Proposed detection metrics (no thresholds):** token lifetime, LP-token concentration, an address's rug-pull history, and deceptive names.
- **Validation:** I found no false-positive audit in the paper.

**Cernera et al., "Ready, Aim, Snipe!" — WWW '23 Companion** ([ACM](https://dl.acm.org/doi/10.1145/3543873.3587612), [author PDF](https://massimolamorgia.com/assets/pdf/Sniper_bots___CAAW_23.pdf)) [V]
- Buy = swap ETH/BNB → token. Sell = swap token → ETH/BNB. Only native-coin pools are counted.
- A sniper is an address where at least 90% of its buys happen within 5 blocks of the pool's first liquidity add, across at least 5 distinct pools.
- An operation succeeds if `T_out − T_in − fees > 0`.
- A journal follow-up exists (ACM TOIT 2025, [ACM](https://dl.acm.org/doi/full/10.1145/3736763)). Its thresholds are **[unverified]** because the page returned 403.

**Xia et al., "Trade or Trick?" — POMACS 5(3) Art. 39, Dec 2021** ([ACM](https://dl.acm.org/doi/10.1145/3491051), [arXiv 2109.00229](https://arxiv.org/abs/2109.00229)) [V]
- **Data:** Uniswap V2, 5 May – 6 Dec 2020.
- **Ground-truth seeds:**
  - Official tokens: CoinMarketCap and Etherscan rankings, manually verified (2,397).
  - Scam tokens: a name or symbol identical to an official token (4,017), plus Etherscan scam/phishing tags (31).
- **Guilt-by-association:** every other token made by a scam token's creator or a scam pool's creator/first minter becomes a candidate. Shared "Contract Deployer" addresses are excluded. A manual spot check of 78 tokens found no false positives.
- **Rug pull:** described only qualitatively ("withdraw everything"), with no threshold. Observed: more than 86% of scam pools remove liquidity within 1 day of the first mint, 37% within 1 hour.
- **Collusion addresses, 4 rules:**
  1. A liquidity adder that received ETH/stablecoins from known scam addresses before adding.
  2. A liquidity remover that sent proceeds to scam addresses after removing.
  3. A buyer funded by scam addresses before buying.
  4. A seller that forwarded proceeds to scam addresses after selling.
- The rules are applied iteratively and found 41,118 collusion addresses.
- Caveat: the "scam" label is mostly counterfeit or impersonation, not based on behaviour.

**Mazorra, Adan, Daza, "Do Not Rug on Me" — Mathematics 10(6):949, 2022** ([DOI](https://doi.org/10.3390/math10060949), [arXiv 2201.07220](https://arxiv.org/abs/2201.07220)) [V]
- **Taxonomy:**
  - Simple rug pull: the creator calls `removeLiquidity`.
  - Sell rug pull: the creator puts a fraction f < S of supply in the pool, keeps S − f, then swaps it out.
  - Trap-door: mintable supply, honeypot logic in transferFrom/approve, or composability exploits.
- **Formulas:**
  - Maximum drop `MD = |X_l − X_h| / X_h`, where X_h is the global maximum and X_l is the minimum after it.
  - Recovery `RC = (X_S − X_l) / (X_h − X_l)`.
  - Both are computed on the price and liquidity series.
- **Inclusion:** a WETH pool and more than 5 Sync events. Data runs to 2021-09-03.
- **Inactive:** no Transfer or Sync event for more than 30 days before 2021-09-13 (86.4% of tokens).
- **Malicious label:**
  - (a) Inactive, liquidity fully withdrawn at some point (78.2% of inactive tokens), and never recovered (only 0.4% did). 24,870 tokens.
  - (b) Inactive, no LP Burn event ever (this is how sell rug pulls are caught), price MD of at least 90%, and no recovery. 2,087 more tokens.
  - Total: 26,957 malicious.
  - The 0.4% and 1.9% figures are observed shares, not RC cut-offs.
- **Non-malicious label:** 631 tokens, chosen by external audit (CertiK, Quantstamp, Hacken), not by on-chain rules.
- **Their own caveats:**
  - Scams can't be told apart from abandoned projects without off-chain data.
  - Liquidity MD = 1 does not imply malice; the LP may have moved to another pool or simply retired.
- 93% of rug pulls happen in the first 24 h after the pool is created.

**Huynh et al., "Serial Scammers and Attack of the Clones" — WWW '25** ([ACM](https://dl.acm.org/doi/10.1145/3696410.3714919), [arXiv 2412.10993](https://arxiv.org/abs/2412.10993)) [V]
- **One-day Simple Rug Pull** (formalises Cernera):
  - The pool's first and last events fall within one day.
  - The low-value token is paired only in this pool.
  - Exactly one Mint and one Burn, burning at least 99% of the LP.
  - ETH/BNB pools only.
- **Scammer addresses:** token creator, pool creator, liquidity provider and liquidity remover. CEX, DEX, bot, bridge and mixer addresses are excluded.
- **Results:** 161,329 scam pools on Uniswap (45% of pools) and 470,712 on PancakeSwap (28%).
- **Scam star:** a centre plus at least 5 satellites.
  - OUT-star: each satellite received at least 100% of its first scam's cost from the centre, in its largest incoming transfer.
  - IN-star: each satellite sent at least 90% of its last scam's revenue back to the centre.
- **Chain and major-flow patterns** use the same 100% funding / 90% revenue rule.
- **Scam cluster:** a connected component where edges are direct ETH/BNB transfers or a shared scam pool. Contract similarity is about 74% within clusters and under 30% across clusters.
- **Cluster-aware profit:** subtracts wash-trading by cluster members. In one example, a naive +7.25 ETH profit drops to about 0.
- **Caveat:** longer-lived rug pulls get mixed up with low-performing tokens whose owners simply pulled liquidity without ill intent.

**Lin et al., CRPWarner — IEEE TSE** ([arXiv 2403.01425](https://arxiv.org/abs/2403.01425)) [V]
- 93 incidents from PeckShield, SlowMist and RugDoc.
- **Transaction-related types:** "Dumping Cryptocurrency" (34 events, the largest loss at about $58.6M), "Withdrawing Liquidity" (18), "Abandoning after funding" (5).
- **Contract-related types:** hidden mint, limiting sell orders, leaking tokens.
- **No numeric thresholds** for any transaction-related type.

**Sun et al., SoK on DeFi rug pulls — PACMSE (ISSTA) 2025** ([ACM](https://dl.acm.org/doi/abs/10.1145/3728900), [arXiv 2403.16082](https://arxiv.org/abs/2403.16082)) [V]
- Categories: simple, sell, smart-contract trap-doors, LP manipulation (including fake LP lock, and "hedging" = selling reserved tokens at the peak), counterfeit, and combinations.
- 34 root causes; existing datasets cover only 7 of them.
- No thresholds.

**Agarwal et al., "DeFi Deception" — FC '23 short paper** ([PDF](https://fc23.ifca.ai/preproceedings/76.pdf)) [V]
- Uses Mackenzie's split:
  - "Slow" rug pull: premine supply, then slowly sell it off.
  - "Fast" rug pull: a quick liquidity hit on a DEX.
- 101 cases from forum threads. No thresholds.

**Zhou et al., "Stop Pulling my Rug" — ICSE-SEIP '24** ([ACM](https://dl.acm.org/doi/10.1145/3639477.3639722)) [unverified beyond abstract]
- 201 incidents (Jan 2022 – May 2023); contract-level risk detection.

**Tran et al., "How To Cook The Fragmented Rug Pull?" — preprint, Nov 2025** ([arXiv 2511.15463](https://arxiv.org/abs/2511.15463)) [V]
- **Baseline detector:**
  - The deployer keeps the LP (not burned or time-locked).
  - Some transaction has `Impact = v_i / V_i > θ`, where v_i is the base-token value received and V_i is the pool's base value before the trade.
  - The seller is in the owner set (deployer or LP creator).
  - θ = 0.9, tested from 0.7 to 0.95.
- **Fragmented rug pull (FRP):**
  - Pool lifetime of 100 days or less.
  - LP retained.
  - Every sell is at or below θ, or comes from non-owner wallets.
- **Results:** 105,434 of 303,614 pools flagged. Owner participation fell from 65% to 24% (about 33% overall). More than 70% of exits use multiple wallets.
- **Caveats:**
  - "Inflated selling" is loosely defined.
  - They credit θ = 0.9 to Mazorra and Cernera, but those papers' 90% and 99% measure different things.

**Chen et al., "From Hype to Collapse" (SolRugDetector) — preprint, May 2026** ([arXiv 2603.24625](https://arxiv.org/abs/2603.24625)) [V]
- **Data:** Solana; Orca, Raydium and Meteora, Jan–Jun 2025. pump.fun-only tokens that never reached a pool are excluded.
- **Activity filter:** trailing-24 h average below 5 tx/hour.
- **Rug types:**
  - Liquidity Withdrawal: the mint authority or initial pool deployer makes a *profitable* liquidity removal, followed by inactivity.
  - Pump-and-Dump: holder count and pool token balance fall monotonically, and holder count drops by more than τ_down = 0.73. **No creator attribution is required.**
  - Freeze authority: the creator keeps freeze authority and has run at least one `FreezeAccount` against a user.
- **Audit:** 382 sampled tokens, 1 false positive (0.26%; 95% upper bound 1.45%). That one false positive was a token revived by a community takeover. Separately, 9 of 100 negatives were slow rugs that played out over 3–7 days.

**Hu et al., MELT (formerly MemeTrans) — preprint, May 2026** ([arXiv 2602.13480](https://arxiv.org/abs/2602.13480)) [V]
- **Data:** 41,470 pump.fun coins that migrated (Dec 2024 – Mar 2025).
- **Roles:**
  - Developer = the creating account.
  - Insiders = the developer plus coordinated accounts.
- **Why classic rug rules don't apply:** on a launchpad, the pool belongs to the launchpad protocol, so the creator cannot pull liquidity. The threat is insiders unwinding their position after migration.
- **Transaction types:** swap, wash trade (buy and sell in one transaction), transfer, mint. Transfers are 4.9% of pre-migration transactions.
- **Bundles**, unioned across three signals:
  1. Accounts co-signing buys or sells in the same transaction.
  2. A shared funding address, with CEX funders excluded.
  3. The same Jito bundle ID.
- Bundled accounts hold 36.5% of total supply at migration.
- **Labels:**
  - `min_price_ratio` = lowest price in the 20 min after migration ÷ migration price.
  - High risk: ratio below 0.3, or flagged "manipulated" by manual review. Coins with a ratio of 0.5 or more were manually reviewed; 37.5% of those were flagged.
  - Low risk: ratio at least 0.7 and not manipulated.
- The paper *assumes* an early drop comes from insiders rather than organic selling; it does not check this per wallet.

**Szwajcok et al., "Meme Coin Factories" — preprint, Sep 2026** ([arXiv 2609.10246](https://arxiv.org/abs/2609.10246)) [V]
- **Data:** 15.2M pump.fun coins, 2024–2026. Graduation at about 85 SOL; 1.02% of coins graduate.
- **Creator and funder:**
  - Creator = the fee payer of the coin's first transaction.
  - Funder = the first address to send the creator any SOL or tokens.
  - Clusters follow funders up to 3 hops, dropping Arkham-labelled service addresses.
  - The top 1% of clusters create 52.99–58.57% of all coins.
- **Coordinated dump:**
  - DP1: several wallets transfer tokens to one "dumper", which sells everything, all inside one transaction.
  - DP2: the dumper receives from at least 2 senders within 24 h and then sells at least the amount received.
- **Market-manipulation-as-a-service:** at least 8 GitHub repos create fresh wallets; 4 mix fresh wallets with creator wallets.

**Mongardini & Mei, "A Midsummer Meme's Dream" — preprint, Jan 2026** ([arXiv 2507.01963](https://arxiv.org/abs/2507.01963)) [V]
- **Concentration warning flags**, each at more than 30% of supply (the top-holder cut-off is attributed to GoPlus/CertiK):
  - top holders
  - bundle buys
  - "fresh" addresses (defined only as having no prior history)
  - airdrops
- **Rug pull:** a single-day price drop above 99% plus a sustained volume drop above 99%. They attribute this to Mazorra, which is incorrect.
- **Pump-and-dump:**
  - Pump: more than +50% price and more than +500% volume, within 24 h.
  - Dump: more than −30% after the peak, with volume falling below 50% of pump-phase volume.
  - An earlier 10% / 400% setting produced too many false positives.

**Rug labels based on TVL and idle time**
- **Yaremus et al., TON** ([arXiv 2509.01168](https://arxiv.org/abs/2509.01168)) [V]: "Idle" = no trades in the first hour; "TVL" = more than 99% drop from peak within the first hour.
- **Li et al., "Catching the Rug"**, Solana / pump.fun ([arXiv 2608.20271](https://arxiv.org/abs/2608.20271)) [V]: TVL down 99%, or idle for more than 80% of the token's lifetime. Features come from the first 5 minutes; the label is set at 1 hour. Its `bundle_*` features are not defined.
- **TM-RugPull** (poster; [arXiv 2602.21529](https://arxiv.org/abs/2602.21529)) [V]: a rug pull only if, over 72 h, liquidity is near zero, there is no on-chain activity and price/volume are negligible. Labels are manual.
- **SolRPDS**, CODASPY '25 ([arXiv 2504.07132](https://arxiv.org/abs/2504.07132)) [V]: "inactive" means the last swap came after a liquidity removal; there is no numeric threshold.
- **MemeChain** ([arXiv 2601.22185](https://arxiv.org/abs/2601.22185)) [V]: a "one-day meme coin" stops all trading within 24 h.

**Not usable**
- [arXiv 2608.01609](https://arxiv.org/abs/2608.01609): its labels are partly random. The paper says positive samples are "randomly generated at a rate of 15%" when no source applies.
- [arXiv 2603.13830](https://arxiv.org/abs/2603.13830): covers only 7 BSC tokens.
- [arXiv 2607.02795](https://arxiv.org/abs/2607.02795): single-author with corrections. It defines a "cohort" as wallets that appear together among the first 10 buyers in at least 3 launches.

---

## 2. Consensus definitions

- **Liquidity-removal rug pull:**
  - The LP holder removes at least 99% of LP.
  - Or TVL drops at least 99% from its peak.
  - Or liquidity hits MD ≈ 1 with no recovery and then goes inactive.
- **Time windows used:** 1 h, 24 h, 1 day, 72 h, 30-day inactivity, and a 100-day pool lifetime.
- **Sell rug pull / dev dump:** recognised by name everywhere: Mazorra's "sell rug", CRPWarner's "dumping", the SoK's "sell rug" and "hedging", and the slow rug pull. Only Mazorra gives an operational threshold, and it is outcome-only (price MD at least 90%, inactive, no LP burn).
- **Serial creators:**
  - Guilt-by-association on the creator address (Xia, Cernera).
  - Clustering by funder and shared pool: 1–3 hops, service addresses excluded, 100% funding / 90% revenue (Serial Scammers, Meme Coin Factories).
  - Any count cut-off is relative (Cernera's top 1%), not absolute.
- **Bundles:** the same transaction co-signed by several wallets, a shared funder, or the same Jito bundle. In memecoin studies, more than 30% of supply is the only threshold used.
- **Snipers:** buying within 3–5 blocks of the first liquidity add, repeated across many pools (5 / 10 / 100 pools depending on the paper).

## 3. Gaps the research doesn't settle

1. **Do transfers or burns count as selling?**
   - Every paper defines a sell as a swap from token to base asset.
   - A transfer only counts when a linked wallet then sells: Meme Coin Factories DP1/DP2, Xia's forwarding of proceeds. MELT keeps transfers as a separate type.
   - No paper treats token burns as sells.
   - Watch the naming: in Uniswap V2, a `Burn` event means removing liquidity, not burning tokens.
   - Transfers to centralised exchanges are not addressed anywhere.
2. **Minimum position before a sale counts:** none of the 20 papers I reviewed defines one. The nearest are FRP's single-trade impact (`v/V > 0.9` of pool base reserves), Cernera's 99% LP share, and DP2's "sells at least what was received".
3. **Circulating vs total supply:** most papers measure against total supply (MELT, Midsummer, the "Memecoin Fragility" paper — whose text says circulating while its formula uses total). No paper defines circulating supply for a bonding curve, where tokens held by the curve aren't really circulating.
4. **Community sell-offs where the creator holds nothing:**
   - These would be flagged by every outcome-only label: SolRugDetector's pump-and-dump, MELT, the TVL/idle papers, Midsummer, TM-RugPull.
   - The problem is acknowledged, not solved:
     - Mazorra: scams can't be separated from abandoned projects.
     - Serial Scammers: longer-lived rug pulls look like low-performing tokens.
     - SolRugDetector: its one false positive was a community revival.
     - Midsummer: the 10%/400% thresholds gave too many false positives.
   - No paper measures false-positive rates for outcome-only labels against creator-attributed ones.
5. **Your venue is not covered:**
   - There is no peer-reviewed study of an EVM L2 bonding-curve launchpad.
   - The Mint/Burn LP-token rule is Uniswap V2-specific and does not handle v3/v4 positions.
   - SolRugDetector notes a one-sided concentrated-liquidity trick on Raydium, which is relevant to v3/v4.
   - Two Elsevier papers on Uniswap V3 rug detection ([1](https://www.sciencedirect.com/science/article/pii/S2096720925000636), [2](https://www.sciencedirect.com/science/article/pii/S2096720925000028)) returned 403 and are **[unverified]**.
6. **Thresholds get mis-cited:** Midsummer and the FRP paper both misstate Mazorra's and Cernera's rules. Cite the original papers, not secondary summaries.
7. **"Fresh wallet" has no age or transaction-count threshold anywhere.** Funding-trace depth ranges from 1 to 3 hops, and all papers exclude service addresses first.

The full texts I extracted (as .txt files) are in this session's scratchpad.