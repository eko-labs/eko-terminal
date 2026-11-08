I found exact, public definitions for most of what you asked, and several sources already cover Robinhood Chain and Pons. Two tools you didn't list turned out to be the most rigorous: **Codex** (a data API) and **GMGN's own open-source agent repo** (`GMGNAI/gmgn-skills`). That repo has live notes on robinhood/PONS tokens. Several sources you named publish little or nothing.

Tags: **[D]** documented or quoted, **[I]** inferred from UI, blogs or live API output, **[U]** unknown.

## Per tool

**Codex (EVM and Solana) — the most rigorous definitions found**
- **Snipers [D]:** "Wallets that bought within the first 5 seconds of the token's first trade. There is no minimum buy size." Same rule on EVM and Solana. The creator counts as a sniper if it bought inside that window. ([source](https://docs.codex.io/recipes/discover-tokens#snipers-bundlers-and-insiders))
- **Bundlers [D]:** four or more wallets buying in the same block on the same pool.
  - Each buy is worth at least $5, and the buys together add up to at least 0.05% of supply.
  - Only buys on the launchpad's own pool before graduation count. (same page)
- **Insiders [D]:** any one of three rules.
  - The wallet bought in the token's creation transaction and is not the creator.
  - It received the token directly from the creator.
  - Its first-ever funding came from the creator, and it then received the token.
  - Excluded: normal trades and swaps (including routers and aggregators), exchanges, liquidity pools, lockers, burn addresses, wide airdrops, and the creator's own wallet. (same page)
- **How percentages work [D]:**
  - Held % is current balance ÷ total supply.
  - Only wallets that still hold count, so the numbers fall over time.
  - Labels are per token. `devAddress` is empty when the creator is unknown.
  - Coverage: launchpad tokens, plus EVM tokens with a known creator created since Oct 8, 2025. ([tokenWalletStats](https://docs.codex.io/api-reference/queries/tokenwalletstats))
- **Overall verdict [D]:**
  - HIGH_RISK is a score of 70 or more; CAUTION is 40–69.
  - A 15-point bonus applies when three or more reason families fire together.
  - A null result means unknown, never safe. ([token-risk](https://docs.codex.io/concepts/token-risk))
- **Rug codes have no public thresholds [U]:** `PROOF_RUG_OCCURRED`, `LIQ_RUG_CLIFF`, `LIQ_DRAINING`, `HOLD_DEV_HEAVY`, `HOLD_INSIDER_DUMPED` ([enum](https://docs.codex.io/api-reference/enums/riskreasoncode)).
- There is no "dev sold" metric.

**GMGN — docs plus its official repo (repo thresholds are the agent skills' defaults, not necessarily the GMGN UI's)**
- **Docs [D]:**
  - DEV = "Token creator".
  - Insider = wallets that "did not buy tokens after trading opened, but hold tokens".
  - Suspected Insider = holders sharing "the same creation time, funding source and transfer time".
  - Sniper = bought "within the first few blocks after trading opened".
  - DEV team = "Creator and bundled buyers".
  - Top 10 counts as safe below 30%.
  - Icon thresholds: "Liquidity is less than $4K" and "Initial Pool Liquidity > $300K".
  - Sources: [insiders/snipers](https://docs.gmgn.ai/index/insider-traders-snipers-first-70-buyers), [icons](https://docs.gmgn.ai/index/featured-icon-definition), [CA checks](https://docs.gmgn.ai/index/ca-security-checks)
- **Dev sell trigger [D/I]:** fires when the "token creator sells part of his holdings in a single transaction" and "Dev actual selling ratio ≥ Dev sell ratio you set". So it is per transaction, and the ratio appears to be a share of the dev's own bag [I]. ([dev sell](https://docs.gmgn.ai/index/auto-trading-dev-sell))
- **Dev status field [D]:** `creator_token_status` is `creator_hold`, a value containing `sell`, or `creator_close`.
  - `creator_close` can happen with no sell or transfer-out anywhere in the activity feed.
  - Confirmed live on robinhood/PONS: the dev burned 10.7M tokens, and about 5.7% of supply left his wallet by no traceable route. ([fields.md](https://github.com/GMGNAI/gmgn-skills/blob/main/skills/gmgn-dev-score/references/fields.md))
- **"Dump" definition [D]:** the dev pulled out at least 1.5× what he put in **and** his first sell came within 30s of launch.
  - Severity is continuous: `clamp((mult−1)/3) × clamp((120−firstSellSec)/120)`.
  - A liquidity removal counts only if it moves a non-zero token amount, is at least 0.5% of supply or $500, and the pool is dead afterwards.
  - "Fee claim + add liquidity" is explicitly not selling.
  - A launchpad/factory contract is excluded when it has more than 20,000 launches and either no graduations or an all-time-high market cap under $1M. ([scoring.md](https://github.com/GMGNAI/gmgn-skills/blob/main/skills/gmgn-dev-score/references/scoring.md))
- **Cross-wallet exits [D]:**
  - Checks transfers out of at least 1% of supply to a non-burn address.
  - If the recipient later sold, that counts as a dev dump.
  - If the recipient never sold, it is unsold overhang, not a dump — "can equally be a lock contract, a CEX deposit address, or a pool".
  - If the recipient is also the dev's funder, that is "one operator". (fields.md)
- **Bundler rate [D]:** share of supply bought in the creation block. The skills disclose it but never score it, because "a paid bundler service, a third-party sniper bot and the dev's own alts all produce the same number". (fields.md)
- **Holder analysis [D]:**
  - Percentages are of tradeable float, defined as 1 − burn − DEX.
  - "Cannot assess" if the float is under 2%.
  - Red if rat traders >5%, the largest wallet >10%, or a dev sock puppet is found.
  - Caution if two or more of: dev >1%, airdropped >20%, risk wallets >35%, linked wallets >15%, contract self-holds >10%.
  - Top 10: red above 60%, yellow above 40%.
  - Dev holdings count only from a balance of 1 token, to avoid dust. ([holder SKILL.md](https://github.com/GMGNAI/gmgn-skills/blob/main/skills/gmgn-holder-analysis/SKILL.md))
- **Linked funding [D]:**
  - A cluster needs three or more wallets with the same funder **and** either funding within a 6h span or amounts within 15% of their mean. This is chosen explicitly so CEX hot wallets don't create false clusters.
  - Funding is also grouped in a 300s sliding window; 60s or less counts as "tight". ([analyze.py](https://github.com/GMGNAI/gmgn-skills/blob/main/skills/gmgn-holder-analysis/analyze.py))
- **Buy gate [D]:** a buy fails on two or more of these warnings: creator holds >5%, bundler wallets / holders >5%, fresh-wallet rate >30%, rat traders >15%, top 10 >50%. ([thresholds.md](https://github.com/GMGNAI/gmgn-skills/blob/main/skills/gmgn-token-buy/references/thresholds.md))
- **Contradiction inside GMGN [D]:** [gmgn-token SKILL.md](https://github.com/GMGNAI/gmgn-skills/blob/main/skills/gmgn-token/SKILL.md) rates `creator_hold` as danger and `creator_close` as safe. The dev-score skill treats holding as a positive.
- **Robinhood-specific notes [D] (holder SKILL.md):**
  - Buys are not indexed on robinhood, which inflates "never-bought" share to 27–41%. They now require a cost basis instead.
  - The token's own contract appeared as a 15% holder.
  - The `dev` tag is missing on bankr tokens; pons_v2/longxyz tokens return the creator normally.

**RugCheck (Solana)**
- I found no official open-source rules. GitHub repos named "rugcheck" are third-party wrappers. I collected the rule strings from the live API [D] ([swagger](https://api.rugcheck.xyz/swagger/index.html), `/v1/tokens/{mint}/report`):
  - "Top 10 holders high ownership": top 10 hold more than 70% (danger).
  - "High holder concentration": top 10 hold more than 50% (warn).
  - "High ownership": top users hold more than 80% (danger).
  - "Single holder ownership" (danger, reports the %).
  - "High holder correlation": top users hold similar amounts (warn).
  - Also: "Creator history of rugged tokens", "Large Amount of LP Unlocked", "Low Liquidity".
- Reports also carry `insiderNetworks` (type "transfer"), `topHolders[].insider`, and `knownAccounts` types such as AMM, used for exclusion [I].
- **"Rugged" [U]:** described as "no liquidity remains" ([Solana Tracker](https://docs.solanatracker.io/data-api/risk)). The live rug ticker shows events with only $0–$64 of liquidity pulled, so there is no visible USD floor [I].

**Solana Tracker [D]** ([risk docs](https://docs.solanatracker.io/data-api/risk))

| Factor | Warn | Danger |
|---|---|---|
| Dev holding | >1% (1,000 pts), >5% (2,500) | >10% (4,000) … >50% (10,000) |
| Snipers | >10% | >20% / 30% / 50% |
| Insiders | >10% | >20% / 30% / 50% |
| Bundlers by wallet count | ≥1, ≥100 | ≥500, ≥1,000 |
| Bundlers by share | >5% | >15% / 30% / 50% |
| Top 10 | — | >15% |
| Rugged | — | 20,000 pts |
| Price drop | >50% in 24h | — |

The normalization to a 1–10 score is not published [U].

**Mobula [D]** ([almanac](https://docs.mobula.io/almanac/detecting-snipers-bundlers))
- Sniper: bought within 0–3 blocks of launch.
- Bundler: a cluster of three or more wallets sharing same-tx or same-block buys, a common funder, or similar amounts.
- Dev = deployer.
- Healthy: top 10 under 30% (excluding LPs); dev under 5% or locked/burned.
- Yellow flag: "Dev slowly selling (<10% sold)".
- Red flags: dev transferring to fresh wallets; top 10 >50%.
- Its dev-history endpoint reads the deployer from Mobula's registry and suggests using transfer-out rows to detect rugs ([dev history](https://docs.mobula.io/guides/how-to-track-token-dev-history)).

**Padre (docs now redirect; read from archive) [D]**
- Top 10 "excludes pool addresses and bonding curves".
- Dev holding = % of total supply.
- Fresh wallet = funded within the last 2 hours. ([archive](http://web.archive.org/web/20260226231218/https://docs.padre.gg/app-guide/trenches))
- Insider = "traded the token in block 0 (bundle) or received it from another insider". ([glossary archive](https://web.archive.org/web/2026/https://docs.padre.gg/padre-v2/glossary))

**BullX [D]:** insider = received tokens without buying; sniper panel = first 70 buyers; "Dev Tokens" = deployer's holding ([analytics](https://bullx.gitbook.io/bullx-neo-docs/trading-terminal/analytics)).

**Axiom and Photon [U]:** filter names only, no formulas ([Axiom](https://docs.axiom.trade/axiom/finding-tokens/pulse), [Photon](https://pies-organization.gitbook.io/photon-trading/photon-on-sol/memescope)). Claims about Axiom bundle rules come from unofficial sites only.

**TrenchBot [D]** ([bundles](https://docs.trench.bot/bundle-tools/bundle-scanner-guide), [clusters](https://docs.trench.bot/bundle-tools/clusters-guide))
- Bundle = several wallets buying in the same ~0.4s slot.
- Judge by current held %, not bundled %.
- Known false positives: BullX multi-wallet buys and copy-trade bots. Ignore 2-wallet, low-% bundles.
- Cluster score weights: temporal 0–40, funding 0–50, composition 0–25, behavioral 0–20.

**Bubblemaps [D]:** a link is an on-chain transfer between holders; contracts and exchanges are hidden by default; high-volume "supernodes" draw no links; covers the top 250 holders ([wiki](https://wiki.bubblemaps.io/bubblemaps-v2/how-does-it-work)).

**GoPlus [D]** ([response details](https://docs.gopluslabs.io/reference/response-details))
- Fields: `creator_address` / `creator_balance` / `creator_percent` (1 = 100%), and `holders` (top 10 with `is_locked`, `tag`, `is_contract`).
- No thresholds.
- The docs' definition of `creator_address` says "owner", which is ambiguous.
- Its live supported-chains list includes "Robinhood", id 4663 [I] ([API](https://api.gopluslabs.io/api/v1/supported_chains)).

**Token Sniffer [D]:** creator wallet, owner wallet and "all other wallets" each <5% of token supply; ≥95% of liquidity locked or burned; creator holds <5% of the LP; buy/sell fee <5%; extreme fee <30% ([API response](https://tokensniffer.readme.io/reference/response)).

**honeypot.is [D]:** `holderAnalysis` covers holders analyzed (not total holders); `siphoned` = tokens moved without consent; `highTaxWallets` = paying ≥50% tax ([docs](https://docs.honeypot.is/ishoneypot)).

**Little or no public detail:** QuillCheck (only "tax exceeds 60%" — [docs](https://quillainetwork.gitbook.io/quillai-network/agent-swarm/quillcheck/understanding-quillcheck-report)), DEXTools (six parameters averaged, no holder or dev rules — [glossary](https://info.dextools.io/crypto-glossary/dextscore/)), Birdeye (fields only — [docs](https://data.birdeye.so/docs/use-cases/risk-and-integrity/rug-checker)), DexScreener ([FAQ](https://docs.dexscreener.com/)). De.Fi and Solsniffer got a quick search only and showed no published formula.

**pump.fun [D]:** `create` takes a separate `user` (signer and payer) and a `creator` argument, and the creator argument receives creator fees ([coin creation](https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/COIN_CREATION.md)). So signer ≠ dev in general. By contrast, Bitquery's sniffer uses the signer as `DevAddress` and flags any single holder above 5% (excluding the curve) and top 10 at or above 70% ([guide](https://docs.bitquery.io/docs/usecases/pumpfun-token-sniffer/)).

## Rug / outcome labels
- **Solidus Labs (pump.fun):** a token with at least 5 trades whose liquidity fell below $1,000 counts as collapsed. On Raydium, a "soft rug" is the deployer withdrawing at least 90% of liquidity. ([report](https://www.soliduslabs.com/reports/solana-rug-pulls-pump-dumps-crypto-compliance))
- **Cernera et al., USENIX Security '23:** a pool with exactly one Mint and one Burn where at least 99% of the LP tokens are burned ([arXiv](https://arxiv.org/abs/2206.08202)).
- **Mazorra et al. 2022:** no Transfer or Sync events for more than 30 days, **and** either liquidity fully withdrawn with no recovery or a maximum price drop of at least 90% with no recovery ([arXiv](https://arxiv.org/abs/2201.07220)). A search summary claimed a 72h window; the paper itself does not say that.
- GMGN's "liquidity <$4K" and Solana Tracker's ">50% drop in 24h" are softer signals than these.

## Common patterns
- **Who is the dev:** usually the creator field from the launchpad's own record. Some tools use the transaction signer, which breaks when a launch service deploys for many users. GMGN handles that with a factory gate.
- **What "sold" means:** swaps by the dev. Transfers out are handled separately, either as cross-wallet checks or as an "insider = received without buying" rule.
- **Denominators:** mostly total supply. GMGN's skill uses tradeable float. Pools, bonding curves, burn addresses, lockers and CEX wallets are excluded.
- **Minimum sizes:** few tools publish them. The ones that do: Codex ($5 per buy, 0.05% of supply), GMGN (1 token; 1% of supply for transfers; 0.5% of supply or $500 for liquidity removal), TrenchBot (ignore 2-wallet, low-% bundles).
- **Shared caution:** missing data is never treated as safe (Codex, GMGN).

## Definitions worth adopting
1. **Codex insider rules plus its exclusions.** Add one extension for Pons: treat wallets the launcher exempted from the anti-sniper tax as insiders by definition. That is a provable link to the creator, which is my reasoning rather than anything a tool publishes.
2. **Codex bundler rule and time-based sniper window** (5s, not N blocks). Block-count windows from Solana or Ethereum won't transfer to a chain with different block times.
3. **GMGN's dump definition:** cash out ≥1.5× cash in and first sell ≤30s, with continuous severity. Pair it with its exit accounting: unexplained exit, transfers of ≥1% of supply where the recipient then sold, and the liquidity-removal guards.
4. **GMGN's float-based concentration and coherent-funder clustering:** at least 3 wallets with the same funder, plus either a ≤6h funding span or amounts within 15%.
5. **Outcome labels:** Mazorra (inactivity plus no recovery) or Solidus (liquidity <$1,000 after ≥5 trades), with the bonding-curve reserve standing in for pool liquidity.

Working files from this research are in `<local path removed> That includes the GMGN repo files, Codex docs, and the RugCheck rule strings in `rc_risks.json`.