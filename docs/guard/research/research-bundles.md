I couldn't find a single agreed definition, and almost nobody publishes exact criteria. Below I've kept what each source documents itself ([D]) apart from third-party descriptions ([3P]), things I saw in a live API response ([O]), my own inferences ([I]) and things I couldn't find ([?]). Every number in the rule comes from a cited source; where sources don't agree I give the documented reference points instead of picking one.

## 1. Per source

**TrenchBot / TrenchRadar (Solana, pump.fun)**
- **Signals [D]:** a bundle is a coordinated "mass snipe": several wallets buying in separate transactions inside the same slot (about 0.4 s). The scanner re-displays pump.fun's own same-slot warnings and shows, per slot, the number of wallets, SOL spent and tokens still held. https://docs.trench.bot/bundle-tools/bundle-scanner-guide.md
- **Two metrics [D]:** "Total bundled %" (can exceed 100% when a dev sells and re-buys) and "Current held %". They tell users to rely on current held. Same URL.
- **Thresholds [D]:** no numbers. Ignore 2-wallet bundles at low %; look for 3+ wallets holding meaningful supply. False positives are usually at most 1–2% per bundle. Example of a real bundle: 24 wallets in the same 0.4 s holding 76%. Same URL.
- **False positives [D]:** unrelated wallets can land in the same slot via BullX multi-wallet buys, fast copy-trading bots, or plain demand on busy tokens. Same URL.
- **Why bubble maps miss bundles [D]:** devs fund one main wallet from a CEX or mixer, then fan out from it. Bubblemaps only links holders, and that funder never holds the token. Same URL.
- **Bundle Risk Index [D]:** four scores with maximums of temporal 40, funding 50, wallet composition 25 and behavioural 20. "Hybrid Strong" means timing AND funding evidence; "Temporal only" means timing could be coincidence.
  - Funding traced up to 100 days back, across many hops.
  - Red flags: more than 60% new wallets; top 20 holders above 80%.
  - Listed false positives: several users withdrawing from the same CEX, popular wallet services or bots, coincidental timing.
  - https://docs.trench.bot/bundle-tools/clusters-guide.md

**Axiom**
- **[D]** "Bundle %" is the share of supply held in bundle wallets. No detection criteria are published. https://docs.axiom.trade/axiom/finding-tokens/pulse
- **[3P, affiliate site]** Four or more buy transactions in one block mark a possible bundle. A wallet is dropped if its next transaction isn't also bundled. Bundles count at any time, not just at launch. The map ("Atlas") is built by InsightX. https://axiompro.app/token-scanner/
- **[3P]** Axiom's % is supply held; GMGN's is volume share. https://x.com/_LMCrypto/status/1979162938867954118
- **[D]** Axiom has a built-in multi-wallet feature, which is a legitimate cause of multi-wallet same-block buys. https://docs.axiom.trade/multi-wallet.md

**GMGN** (supports a `robinhood` chain)
- **[D] Definitions:**
  - Bundler: one account combining several wallets' transactions into one bundle in the same block.
  - "Dev team": the creator plus the bundled buyers.
  - Suspected insiders: share creation time, funding source and transfer time.
  - https://docs.gmgn.ai/index/featured-icon-definition
- **[D] GMGN's own glossary:** a bundler is a wallet that bought in the creation block, and may be the dev's alts, a paid service, or someone else's bot. https://github.com/GMGNAI/gmgn-skills/blob/main/skills/gmgn-dev-score/references/glossary.md
- **[D] API fields:**
  - `bundler_trader_amount_rate` is the share of volume from bundle trading (volume, not supply).
  - `native_transfer` is the first native-coin transfer into a wallet; wallets sharing its address are likely the same operator.
  - https://github.com/GMGNAI/gmgn-skills/blob/main/skills/gmgn-token/SKILL.md
- **[D] GMGN's holder-analysis skill** (guidance for AI agents, not their backend):
  - "Linked funding" warns above 10% of float and is danger above 25%.
  - Any group funded within 60 s is escalated whatever its size, because scripted batch funding is treated as structural.
  - It records indexing gaps on robinhood: 27–41% of holders show as "never bought" because buys aren't indexed, and the token contract itself can appear as a holder.
  - https://github.com/GMGNAI/gmgn-skills/blob/main/skills/gmgn-holder-analysis/SKILL.md
- **[D]** Its risk-warning workflow treats `bundler_rate` above 0.3 as heavy bundling. https://github.com/GMGNAI/gmgn-skills/blob/main/docs/workflow-risk-warning.md

**BullX**
- **[D]** "Insider" means the wallet received tokens without buying them. "Sniper" means it bought very early. Bubblemaps is embedded in the terminal. The docs have no bundle definition. https://bullx.gitbook.io/bullx-neo-docs/trading-terminal/analytics.md

**Photon, Padre/Terminal, Solsniffer: [?]**
- No public definitions found. Padre's docs redirect to the app, and Solsniffer's docs page says "Coming soon" (https://solsniffer.gitbook.io/llms.txt).

**RugCheck "insider networks"**
- **[O]** Live reports carry `graphInsidersDetected` and `insiderNetworks[]` (fields: size, type, tokenAmount, currentHolding, activeAccounts). In about 20 tokens sampled, the type was always `transfer`.
- **[O]** `/insiders/graph` returns nodes with token holdings, including zero-holding intermediary wallets, plus links between them. https://api.rugcheck.xyz/v1/tokens/{mint}/report
- **[?]** Whether links are token transfers or SOL transfers, and any thresholds. No official methodology found.

**Bubblemaps**
- **Links [D]:** a link is any on-chain transfer between two holders, of any token and sometimes cross-chain. Only the top 250 holders are shown. Contracts and exchanges are hidden by default. https://wiki.bubblemaps.io/bubblemaps-v2/how-does-it-work.md
- **"Supernodes" [D]:** very high-volume addresses such as hot wallets. Links between two Supernodes aren't drawn. Same URL.
- **"Magic Nodes" [D]:** non-holder intermediaries — an external address that paid gas to several holders, or a deposit address several holders sent to. https://wiki.bubblemaps.io/bubblemaps-v2/magic-nodes.md
- **"Time Nodes" [D]:** an exchange is split into separate nodes per time window, so wallets using the same exchange at the same moment get linked. Window size [?]. https://wiki.bubblemaps.io/bubblemaps-v2/time-nodes.md
- **Score [D]:** top 250 holders excluding CEXs, DEXs and contracts. More and larger clusters lower the score. Formula [?]. https://wiki.bubblemaps.io/bubblemaps-v2/bubblemaps-score.md
- **Blog [D]:** a bundle is timing at launch (same block or snipe window); a cluster is shared funding, transfers or recycled wallets over time. The blog treats a bundle holding 10%+ as a major red flag. https://blog.bubblemaps.io/whats-the-difference-between-bundle-cluster-2/
- **Insider Score [3P]:** methodology unpublished; the article notes market makers, airdrop farming and bots can look the same on-chain. https://www.cryptotimes.io/2026/09/16/bubblemaps-adds-pre-screened-token-feed-insider-score-in-app-swap-in-platform-overhaul/

**InsightX** (powers Axiom's Atlas map)
- **Bundlers [D]:** coordinated multi-wallet swaps in one transaction or a very tight block window. Bundler, insider and sniper metrics are Solana-only. https://docs.insightx.network/reference/dex-metrics-bundlers.md
- **Clusters [D]:** available on sol, eth, base and bsc; wallets linked by shared funding or transaction patterns. A `funding_address` tag is called a strong sign of common ownership. https://docs.insightx.network/reference/dex-metrics-clusters.md
- **Snipers [D]:** buys within the first 3 blocks after the first DEX event. https://docs.insightx.network/reference/dex-metrics-snipers.md
- **Behavioural nodes [D]:** include "Coordinated Fundings" (funded in similar timeframes). https://docs.insightx.network/docs/behavioural-nodes.md

**Mobula**
- **[D]** Bundler signals: same transaction, common funder, same block, similar amounts, tokens later consolidated to one wallet.
- **[D]** A cluster of 3+ wallets matching these gets all members tagged. Snipers are buys within blocks 0–3.
- **[?]** Formula for the % and any false-positive handling. https://docs.mobula.io/almanac/detecting-snipers-bundlers

**SolBundler** (a vendor that sells bundling, so read as a vendor claim)
- **[D]** It measures block-0 buyers and excludes bonding-curve and pool accounts. Under about 5% is common on organic launches; above 15% across several wallets is likely coordinated. https://solbundler.app/solana-bundle-checker

**Open-source on GitHub**
- I found no maintained pump.fun bundle checker that publishes its criteria. The repos are mostly bundlers selling evasion: staggered buys, anti-bubble-map funding, and claims to pass Bubblemaps and all major scanners.
  - https://github.com/Infinitybundler/pump-fun-bundler
  - https://github.com/keidev-sol/Pumpfun-Bubblemap-Bypass-Bundler

## 2. Research and airdrop Sybil detection

- **MELT/MemeTrans (arXiv 2602.13480):** three linking rules, merged where groups overlap:
  - Buys in the same transaction (on Solana that requires every wallet's key).
  - A shared funding address, with CEXs excluded.
  - A shared Jito bundle ID.
  - Finding: 36.5% of supply at migration sat in bundled accounts. No false-positive validation. https://arxiv.org/html/2602.13480v2
- **Meme Coin Factories (arXiv 2609.10246):**
  - Builds funder clusters at 1, 2 and 3 hops.
  - Removes anything Arkham labels as a service (exchanges, bridges, contracts).
  - Checks that a cluster stays connected after deleting its single most important address.
  - Coordinated dumps: several wallets send to one dumper, in one transaction or within 24 h.
  - https://arxiv.org/html/2609.10246v1
- **Coordinated sniper cohorts (arXiv 2607.02795; single-author preprint):** pairs of wallets appearing together among the first 10 buyers in at least 3 launches, grouped with union-find. The author says outright this does not show common ownership. https://arxiv.org/pdf/2607.02795
- **Midsummer Meme's Dream (arXiv 2507.01963):**
  - A bundle buy above 30% of supply counts as an anomaly.
  - 18.81% of high-return tokens used bundle buys, averaging 15.70% of supply.
  - Fresh wallets holding over 30% is flagged.
  - https://arxiv.org/pdf/2507.01963
- **Arbitrum airdrop:**
  - Removed bridges, CEXs, contracts and CEX deposit addresses (data from Nansen).
  - Graph 1 has an edge per transfer of ETH value. Graph 2 links each wallet to its first funder and its last sweep destination.
  - Large subgraphs are broken up with Louvain community detection.
  - Example patterns: a transfer cluster of more than 20 addresses, a shared funding source, similar activity.
  - https://github.com/ArbitrumFoundation/sybil-detection
  - https://docs.arbitrum.foundation/concepts/sybil-account
- **Hop airdrop:**
  - Reports needed at least 10 eligible addresses. Methods with a non-negligible chance of removing real users were rejected. https://github.com/hop-protocol/hop-airdrop/blob/master/README.md
  - The code groups connected components over transfers after removing exchanges, deposit addresses, contracts and a list of high-connection hub addresses. https://github.com/hop-protocol/hop-airdrop/blob/master/src/getGroups.ts
- **Optimism airdrop 1:**
  - Sybil farms had tens to hundreds of addresses; they were held to stricter activity requirements.
  - CEX and on-ramp addresses were filtered out.
  - The later 17k-address filter is deliberately unpublished.
  - https://github.com/ethereum-optimism/community-hub/blob/main/pages/op-token/airdrops/airdrop-1.mdx
- **Trusta Labs:**
  - Removes hub addresses, then builds a general transfer graph and a "first gas provision" graph.
  - Uses Louvain and K-core to find dense groups. Patterns: star fan-out, star fan-in, tree, chain.
  - A second pass drops addresses whose behaviour doesn't match the rest of the cluster, to cut false positives.
  - Their example: a 170-address cluster all first funded by Binance was only flagged because the wallets also did identical actions on the same dates.
  - https://github.com/TrustaLabs/Airdrop-Sybil-Identification
- **Victor, Financial Cryptography 2020:**
  - Reuse of an exchange deposit address was the most effective heuristic; 17.9% of active wallets could be clustered.
  - A deposit address is one that forwards what it receives to an exchange; parameters were amount difference ≤ 0.01 ETH within 3,200 blocks.
  - Known exchanges and miners are excluded. Clusters over 1,000 addresses are ignored as implausible.
  - Airdrop rule: two recipients forwarding to the same address means at least 3 addresses under one owner.
  - https://www.ifca.ai/fc20/preproceedings/31.pdf
- **Nansen:**
  - High confidence: first funder, shared Safe signers, or the same CEX deposit address.
  - Medium: coordinated balance movements.
  - Excluded as evidence: a single CEX withdrawal, a single deployer, an ENS name alone.
  - Stop expanding at CEXs or protocols. A smart account is attributed to whoever funds it.
  - https://github.com/nansen-ai/nansen-cli/blob/HEAD/skills/nansen-wallet-clustering/REFERENCE.md
  - https://docs.nansen.ai/guides/templates/complex-use-cases/use-case-3-identifying-related-wallets-at-scale
- **LayerZero [3P]:** about 2M addresses were flagged at first, then stricter criteria brought it to 803,093 to reduce false positives. Criteria not public. https://cointelegraph.com/news/layerzero-concludes-sybil-self-reporting-phase

## 3. EVM and Orbit specifics

- **Same transaction does not mean same owner on EVM.**
  - ERC-4337 lets operations from unrelated smart-account users share one transaction. https://eips.ethereum.org/EIPS/eip-4337
  - EIP-7702 adds batching for one user and sponsorship, where one account pays for another; one transaction can carry several wallets' authorizations. https://eips.ethereum.org/EIPS/eip-7702
  - Banana Gun groups different users' snipes into one first-in-block bundle. https://twitter.com/bananagun/status/1679245100587597828
  - [I] On EVM one signer can send purchased tokens to N addresses without their keys. That proves one payer, not that the recipients collude — unlike Solana co-signing.
- **Timing on Arbitrum chains:**
  - Default block time is 250 ms; the mempool is private. https://docs.arbitrum.io/how-arbitrum-works/timeboost/gentle-introduction
  - Robinhood Chain is reported at 100 ms blocks [3P]. https://www.kucoin.com/news/flash/robinhood-chain-hits-10m-daily-transactions-block-times-drop-to-100ms
  - Under first-come-first-served ordering, priority tips are ignored. Tips only set order if the chain enables Arbitrum's optional priority-fee auction (PGA). https://docs.arbitrum.io/how-arbitrum-works/deep-dives/gas-and-fees
- **Robinhood Chain case [3P]:**
  - 53 launches, mostly on Pons V2. Bundles of 70–200 wallets took 70%+ of supply within about a second.
  - 45 launches were linked because one token's collection wallet paid the next token's funding wallet; in one case the funding batch was signed 16 s after the money arrived.
  - 4 were linked by a shared funding private key, and 4 by a shared collector wallet.
  - https://www.crowdfundinsider.com/2026/09/313755-robinhood-chain-memecoins-to-18-43m-rug-pull-ring-analysis/

## 4. Strongest signals

1. **One payer buying for several recipients in one transaction** (excluding 4337 bundles with different senders, and known relayers). Sources: MELT, GMGN, InsightX.
2. **Shared direct first funder that isn't a service**, especially a batch funding transaction or funding within a short window (GMGN uses 60 s). Sources: Arbitrum, Trusta, Nansen (high), InsightX, the Robinhood case.
3. **Shared sweep/collector address or shared CEX deposit address.** Sources: Arbitrum sweep edges, Victor, Nansen (high), Mobula, Factories, the Robinhood case.
4. **Direct token transfers between holders, or tokens received without buying.** Sources: Bubblemaps, RugCheck, BullX, GMGN.
5. **Link to the deployer, or the same funder or collector reappearing across launches.** Sources: GMGN dev-team definition, InsightX insiders, the Robinhood case, Bubblemaps blog.

## 5. Weak signals to avoid on their own

- **Same block or slot alone.** Unrelated wallets land together (TrenchBot, Banana Gun, ERC-4337), co-occurrence isn't ownership (cohort paper), and timing is easy to defeat with staggered buys (bundler repos).
- **A CEX hot wallet as the funder.** Nansen excludes it, Bubblemaps hides it, and MELT and Arbitrum remove it. Only usable split into time windows (Bubblemaps Time Nodes) plus a behavioural match (Trusta).
- **Shared routers, launchpad, bot contracts, paymasters or bridges.** Hop and Trusta remove hubs like these.
- **Fresh wallets, similar buy sizes, gas fingerprints.**
  - Use these only to strengthen a link that already exists (TrenchBot's composition score, Mobula).
  - [I] On a chain whose mainnet is only months old, most wallets are young.
  - [I] Trading terminals have preset buy amounts, so equal sizes are common by chance.
  - [I] With tips ignored, gas settings mostly reveal which bot software was used.
- **Two-wallet groups at low %** (TrenchBot).
- **Mixing a volume-based % (GMGN) with a supply-held % (Axiom, TrenchBot).** They measure different things.

## 6. Recommended rule shape

1. **Define the buyer correctly.** Buyer = the address receiving tokens from the curve; payer = the transaction sender or 4337 operation sender. Exclude the curve, pool, launchpad and token contract from holders (SolBundler, GMGN). Split 4337 transactions by sender (ERC-4337). [I]
2. **Hard links** (any one merges wallets, via union-find):
   - Same payer buying for several recipients.
   - Shared 1-hop first funder that isn't a service.
   - Shared collector or deposit address.
   - Token transfers between the wallets.
   - Link to the deployer.
   - Evidence is sections 1–2. Allow 2–3 hop funding only as medium confidence, with the delete-one-address robustness check and stopping at services (Factories, Nansen).
3. **Exclusions:** labelled CEX, bridge, router, EntryPoint, paymaster and relayer addresses, plus hubs detected by how many wallets they touch (Arbitrum, Hop, Trusta, Bubblemaps Supernodes). [?] No source publishes a hub-degree cutoff; Victor ignored clusters over 1,000.
4. **Soft links** (need two, or one plus launch timing): same-exchange funding in the same time window, similar funding or buy amounts, fresh wallets. This mirrors TrenchBot's "Hybrid Strong" versus "Temporal only".
5. **Launch window as a time span, not one block.** [I] With 100–250 ms blocks, the Robinhood case's "within a second" spans many blocks. Timing should generate candidates, not prove links.
6. **When to flag:** at least 3 wallets (TrenchBot, Mobula; Victor's minimum is 3). Report both bought % and held % of total supply (TrenchBot, Axiom).
   - There is no agreed supply threshold. Documented reference points: about 5% organic baseline (vendor), 10% (Bubblemaps), 15% (vendor), 30% (Midsummer paper; GMGN agent guidance).
   - Calibrate on your own chain's labelled launches.
7. **Confidence labels:**
   - High = hard link.
   - Medium = multi-hop or two soft signals.
   - Timing-only = label it "same-block buyers", not a bundle.

## Unknowns

- RugCheck's link semantics and thresholds.
- Definitions for Photon, Padre and Solsniffer.
- Bubblemaps' time-window size, how Magic Nodes are chosen, and the score formula.
- Axiom's own criteria (only the affiliate description exists).
- Hub-degree cutoffs.
- Any published precision or recall for a memecoin bundle detector.