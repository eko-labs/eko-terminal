# EKO Guard 2.0

Implementation reference · 2 October 2026 · Robinhood Chain, chain ID 4663

This document replaces both drafts and the conflicting Guard definitions in the supplied spec. It specifies work to build; it does not claim that the measurements, calibration or release gates have already passed. The lead decisions in the merge request bind this document. Existing custody, fee, access and release requirements remain unless explicitly changed here.

## Sources and parameter discipline

Only the supplied files were consulted. External links below identify primary references recorded in those files; they were not fetched again. Measurements in F describe the October 1–2 sample, not future performance. Vendor documentation defines a comparator, not validated EKO accuracy. Incident reporting supplies leads, not established responsibility.

| Key | Source and scope |
|---|---|
| F | [Facts and requirements](research/facts-and-requirements.md): owner constraints, verified Pons ABI, measured RPC limits and replay. |
| BE / FE / CF | [Backend](../eko/04-BACKEND.md), [Frontend](../eko/03-FRONTEND.md), [contract facts](../eko/FACTS.md). CF §5b records the October 1 provider capability checks; BE §§6, 9, 13, 23 define execution, policy, receipts and consumers. |
| C | [Rules](../../packages/playbooks/src/rules.ts), [configuration](../../packages/playbooks/config/v1.yaml), [sources](../../apps/engines/src/sources.ts), [outcomes](../../apps/engines/src/outcomes.ts), [card](../../apps/engines/src/card.ts), [shared schemas](../../packages/shared/src/contracts/coin.ts), [preflight](../../packages/policy/src/preflight.ts), [Signal](../../packages/signal/src/index.ts). Evidence of current implementation, including its gaps. |
| T | [Tool research](research/research-tools.md). Primary definitions: [Codex wallet tags](https://docs.codex.io/recipes/discover-tokens#snipers-bundlers-and-insiders), [wallet statistics](https://docs.codex.io/api-reference/queries/tokenwalletstats), [GMGN dev scoring](https://github.com/GMGNAI/gmgn-skills/blob/main/skills/gmgn-dev-score/references/scoring.md), [holder analysis](https://github.com/GMGNAI/gmgn-skills/blob/main/skills/gmgn-holder-analysis/SKILL.md), [GoPlus field semantics](https://docs.gopluslabs.io/reference/response-details). |
| B | [Bundle research](research/research-bundles.md). [TrenchBot](https://docs.trench.bot/bundle-tools/bundle-scanner-guide.md), [Nansen clustering](https://github.com/nansen-ai/nansen-cli/blob/HEAD/skills/nansen-wallet-clustering/REFERENCE.md), [ERC-4337](https://eips.ethereum.org/EIPS/eip-4337), [EIP-7702](https://eips.ethereum.org/EIPS/eip-7702). |
| A | [Academic research](research/research-academic.md). [Cernera](https://arxiv.org/abs/2206.08202), [Ready, Aim, Snipe](https://dl.acm.org/doi/10.1145/3543873.3587612), [Mazorra](https://arxiv.org/abs/2201.07220), [Huynh](https://arxiv.org/abs/2412.10993), [MELT](https://arxiv.org/html/2602.13480v2), [Meme Coin Factories](https://arxiv.org/html/2609.10246v1). The latter two remain preprints. |
| R1 / R2 / R3 | [Current meta](research/research-current-meta.md), [scoring/evaluation](research/research-scoring-evaluation.md), [Robinhood coverage](research/research-robinhood-chain.md). R3 records [Pons source](https://github.com/ponsdotdev/pons-labs), [curve implementation](https://raw.githubusercontent.com/ponsdotdev/pons-labs/main/contractsV2/src/v2/PonsV2BondingCurve.sol), and [53-launch reporting](https://www.crowdfundinsider.com/2026/09/313755-robinhood-chain-memecoins-to-18-43m-rug-pull-ring-analysis/). |

**CALIBRATE** marks every EKO heuristic or unsourced measurement adaptation below. Its starting value/formula, reason and method are normative for shadow implementation. §9's parameter registry and gates determine promotion. Protocol arithmetic, serialization, schema invariants and binding owner policy are engineering contracts, verified by tests; they are not empirical predictions. Every CALIBRATE row must become a registry entry with units, exact comparison operators, source, rationale, method version and acceptance artifact. A global label does not excuse an incorrectly attributed source.

Resolved research conflicts: exemptions do not establish insiders [F]; unrestricted transfer/funder unions do not establish control [B, adapted for EVM]; collapse does not establish operator harm [A, F]; Codex score bands/bonus in T remain unverified under R2 and are not imported; Pons event fields establish ABI, not fee decomposition [F, R3]; historical Pons parameters are not universal constants.

## 1. Purpose, levels and policy

The Guard describes buyer risk at a recorded snapshot, route, size and account class. It is not a buy call, price forecast or scam label. Entries come from the agent's own rules and the independent Signal. Unrelated bots can expose buyers without making the launcher responsible. [F §1]

| Machine level | Public label | Meaning |
|---|---|---|
| `lower` | Lower observed risk | All applicable checks in both tiers completed; released score <30; no decisive current fact. Losses remain possible. |
| `elevated` | Elevated risk | Released score ≥30 and <60, or the lower-tier completeness floor applies. Read the reasons and order-size costs. |
| `high` | High risk | A confirmed severe current fact or released score ≥60. EKO denies buys in every mode. |
| `incomplete` | Not fully checked | Buy-critical checks unresolved and no established High. EKO denies buys and names the gaps. |

The 30/60 boundaries are **CALIBRATE** starting candidates from draft B: moderate independent exposures should combine into higher risk. Fit weights and bands on the paired buyer outcomes in §9, never vendor consensus. The assessment is evaluated against a **CALIBRATE 3,600-second** buyer-outcome horizon, chosen for the existing one-hour outcome convention [BE §7.5]. This is a benchmark horizon, not a future-valid assessment.

Completeness is separate from level. High with gaps remains High. If only lower-tier checks are missing, publish `max(observedLevel,elevated)` and **“Not fully checked: <names>”** with equal prominence. Example: score 20 and funding missing gives Elevated, with `observedLevel=lower`, `levelFloorReason=lower_tier_gap`; never show a secondary lowest-risk chip. A missing buy-critical check gives Incomplete unless observed High is already established. “Scanning…” exists only before the first persisted verdict; a failed refresh retains the prior record with stale status, not Scanning.

| Buy state | Safe | Balanced | Degen |
|---|---|---|---|
| Lower, both tiers complete | Continue through policy limits | Same | Same |
| Elevated, including lower-tier gaps | Deny | Continue within limits; include gaps/warnings | Same |
| High, with or without gaps | Deny unconditionally | Deny unconditionally | Deny unconditionally |
| Incomplete, missing/stale buy-critical checks, no verdict, or simulation unavailable | Deny | Deny | Deny |

These are binding lead policy decisions. Safe's Elevated denial cannot be disabled by an explicit null legacy threshold. Balanced/Degen may opt to deny Elevated. Apply other preset fields only when unset. Legacy `blockPlaybookLevel='monitor'` is an additional Elevated refusal; `danger` or null never weakens mandatory gates. Record `guardPolicyVersion=2` in settings and policy receipts because this changes old explicit-null behavior. High denial is never approval-overridable. Existing kill, asset lists, access/sanctions checks, context handling, exposure/daily-loss caps and approval ordering remain. [C preflight; BE §§9.6–9.7, 12.2]

Actual-order depth and cost remain separate from the headline. Retain existing preset depth floors $50,000/$10,000/$2,000 and round-trip ceilings 5/10/25% [BE §9.6]. **CALIBRATE retained policy defaults:** their suitability is not established; measure quote/fill error and refusal rates, while owner-selected limits remain policy. `maxRoundTripCostPct` limits `venueRoundTripCostPct` (§3.4); show all-in cost and network fee separately. Require an actual-size quote, never interpolation. Use the existing maximum quote age of 15 seconds, refresh after 5 seconds, and reject a served verdict older than 30 seconds [FE trading/freshness]. Relevant route, balance, fee, control or profile change invalidates a dependent quote/check immediately inside those ceilings. Capture the request clock for execution revalidation; these ceilings do not make a missing check complete. A Lower headline with 9.75% cost can fail Safe's 5% ceiling; explain that denial directly.

Sells bypass buyer-level/completeness gates. Use a sell-only simulation of the existing position; do not require a new buy to reduce exposure. Kill, explicit blocklists, execution validity and route availability still apply. An unsupported sell route refuses calldata and explains the execution gap; it does not recommend holding.

Every verdict surface carries: **“Buyer risk at this snapshot. Not a buy recommendation.”** and **“DYOR · Not financial advice · AI-generated analysis.”** Show snapshot, relevant size/account class and gaps. Where chain branding appears, use **“Built on Robinhood Chain”** with **“Not affiliated with, endorsed by, or officially connected with Robinhood Markets, Inc.”** No safety certification, return claim, price prediction, affiliation claim or personal identifiers. External-agent preflight is advisory; no installed on-chain enforcement is implied. [F §4; CF §6; FE §§8–9]

## 2. Identities and supply

### 2.1 Clock, cursors and state

Keys are `(chainId,address)`. Store raw token/quote integers with asset and decimals. Compare using bigint/rationals, not `Number(raw)`. A cursor contains block number/hash, transaction index, adapter execution ordinal, log/trace reference and timestamp seconds. An adapter supplies a merged execution ordinal; lexical trace-path ordering is not execution order. Ties use chain order, then address bytes for equal rankings. [F §2; BE §3; C corrections]

Use half-open acquisition windows `[start,start+W)` and trailing windows `(T−W,T]`, bounded by the cursor. `t0` is TokenLaunched, `tp` is verified market-open, `tFirst` is first actual buy/sell trade, `tg` is verified graduation; preserve all four. Pons opening atomic with launch gives `tp=t0`. First pool swap is only a fallback graduation observation, explicitly unknown migration time. Five-second endpoint convention is an EKO method choice, not asserted Codex wording.

Production assessments use completed block-end states. Historical transaction-boundary probes replay the exact prefix from a parent-block checkpoint; log cursors locate evidence, not executable entry halfway through a transaction. Never combine prefix logs with later block-end state. Delay checkpoints choose the earliest completed block boundary at/after the delay; record the chosen cursor and actual delay. Episode before/after states are explicit transaction boundaries. Unsupported prefix reconstruction is unknown.

`evaluationTimeSec=cursor.timestampSec`. Timer queues close episodes, expire links, update taxes/locks and mature horizons even without trades. Wall-clock recording/serving/request times are captured separately. `knownAt` includes full cursor plus acquisition sequence/time for external evidence; same-second later evidence cannot enter earlier decisions. Rebuilt-engine retrospective replay and historic production replay have separate availability manifests. One-second timestamps do not establish subsecond reaction times. [F measured 10 blocks/s; BE §4.2; R3 §5]

### 2.2 Roles, services and operator control

| Role | Resolution |
|---|---|
| `factoryDeployer` | Exact TokenLaunched immediate factory caller [F]. |
| `outerSigner` | Transaction from. Not universally buyer, principal or owner. |
| `launchPrincipal` | Authenticated account authorizing the launch subtree: adapter-specific signer, successful UserOperation sender, decoded authority, or direct EOA factory caller; otherwise null. |
| `creationPayer` | Actual launch-cost debit account; sponsorship is separate. |
| `buyPayer`, `buyRecipient`, `sellSource`, `proceedsRecipient` | Verified economic debits/credits, event recipients and routed call subtree, not router/Swap.sender substitution. |
| `feeRecipient`, treasury, custodian, locker | Verified configuration/permissions with effective cursor; no exemption-only inference. |
| `operatorGroup` | Accepted control component, a pseudonymous economic group, never a natural-person identity. |

Split ERC-4337 by authenticated operation and call subtree. EIP-7702 `0xef0100` indicates delegation; shared implementation and sponsor do not prove control. Safe control needs effective threshold, owners, modules and permission paths authorizing both accounts; matching one signer or signer sets alone is insufficient. Ambiguous roles remain null with missing status. Simple direct Pons roles can be implemented from existing senders/events now; complex attribution waits for acquired traces. [B §3; C sources]

Version the service registry by chain/address/codehash/implementation/time. **CALIBRATE service candidate:** ≥20 launches in 86,400 seconds, ≥10 authenticated principals and ≥80% distinct principal/fee-recipient pairs; reason: observed shared tooling is wrongly aggregated before a 20,000-launch vendor cutoff. Validate against traced tools and prolific single operators. Candidate status stops history aggregation at the infrastructure node until reviewed; failure to qualify never proves one operator. Confirm services through independent callers and per-user configuration.

F identifies `0x0e16…` as shared tooling (108 launches, 108 distinct exemption sets). The abbreviations are explanatory only, not registry keys; obtain full indexed identifiers before seeding. `0x61e6…` remains operator/service unresolved despite delegation, high nonce and repeated buys. `0x037d…` has direct self-buy evidence but its other exempt wallets need independent links. Do not invent complete addresses or numbers of people from exemption sets.

Exclude infrastructure from control expansion: CEX hot wallets/deposits, bridges, mixers, pools/curves, routers/aggregators, EntryPoints, paymasters, relayers, public distributors, custodial omnibus accounts and shared launch/bot services. Keep private payer, recipient and batch economic exposure. Bots, liquid treasuries and service-held sellable inventory remain visible holdings. **CALIBRATE hub screen:** ≥500 distinct counterparties over 86,400 seconds creates review status, not deletion or exoneration. Store degree-coverage interval; candidate-only graphs cannot prove degree below 500. Decode private funding batches even through a quarantined hub. Validate on public services and private fan-out camouflage. [B; BE §5.4]

### 2.3 Control, coordination and origin graphs

Separate observed connections, accepted coordination, accepted control and token-lot origin. A transfer never automatically merges owners. Funding alone can qualify coordination; operator history requires authenticated sale control or a reviewed recent material funding→purchase→sale→collection loop connecting that seller to the principal's side. Gifts, payments, airdrops, custody and origin alone cannot establish responsibility. [F §1; B; A Xia/Huynh, adapted]

The following qualifications are **CALIBRATE** adaptations. Start strict to avoid shared-service/dust attribution; validate each edge class with §9's control precision gate and delayed/staggered stress cases.

| Evidence class | Starting qualification and use |
|---|---|
| Authenticated control | Verified effective authority controls both accounts; persists while permissions remain valid. Direct operator attribution, including two-wallet groups. |
| One private economic payer | Same authenticated acquisition subtree buys for several recipients; separate customers/UserOps/gifts. Strong payment coordination, not key ownership. |
| Recent material funder | Incoming funding in the 21,600 seconds before first relevant token buy; batch span ≤60 seconds; conserved funding ≥90% of covered buy inputs plus gas. Three economic participants for group scoring. Fund after purchase cannot explain it. |
| Collector | ≥90% of net sale proceeds reaches one non-service collector within 86,400 seconds. Show 3,600-second fast slice. Deadline is an EKO hypothesis for delayed sweeps, not Factories DP2. Collector alone establishes coordinated collection, not operator control. |
| Closed funding/collection loop | Qualified recent funder and matching collector or authenticated authority tie seller to principal; high-control label only after review/method gate. One transfer's value is consumed once, never reused across launches without replenishment. |
| Bounded paths/recycling | At most three non-service hops. Funding path fits 86,400 seconds; collector→next-funder recycling fits 604,800 seconds and ≥90% conserved value, with qualified endpoints. Medium lead until the closed loop/control evidence qualifies. Three-year common funding never qualifies. |
| Medium amount/path candidate | ≥50% material flow plus independently repeated purchase/sweep pattern; retain raw 80/89% ratios. No automatic control/history or scored group. Examine 86,400-second funding sensitivity rather than treating a six-hour miss as independence. |
| Consolidation | ≥2 senders forward lots to one seller, which sells at least received units in the same transaction or within 86,400 seconds. Three distinct economic participants; report who purchased. Proven coordinated disposition/origin, not automatic common control or launch bundle. Factories motivates the pattern; its strict reported label differs across supplied summaries. |
| Soft cohort | Same block/timing, equal amounts, freshness, gas/software, CEX/bridge payout or repeated early co-buying alone: candidate only, never owner union. No numeric softness score establishes keys. |

All asset materiality comparisons need consistent quote/native valuation; missing conversion leaves the ratio unknown. Same-account ETH/WETH wrapping is not a funder. Trace successful top-level/internal value flows and debit available amounts chronologically. Endpoints remain economically visible when a service stops expansion.

Accepted components use immutable sorted member/edge hashes plus graph version; retain merges/splits/supersession. Funding-path components get delete-highest-degree/unresolved-hub diagnostics. Star payment can remain coordination without passing a robustness test; it cannot become control without separate proof. Recompute affected components for expirations/reorgs; union-find alone cannot handle splits.

Group minimum is three distinct participating economic wallets, with acquisition/disposition roles recorded. Two proven controlled accounts still count fully in operator exposure. **CALIBRATE launch bundle window:** `[t0,t0+300)` for qualified coordinated acquisitions, chosen to catch staggered batches [R1]; later qualified accumulations also score current holdings at any age. Largest component and union of all qualified components are separate O-family metrics; neither hides ten disjoint 9% groups.

### 2.4 Insiders, snipers, exemptions and freshness

Adopt Codex's token-specific insider candidates: non-creator bought in creation transaction, received directly from creator outside ordinary trading, or first-ever funded by creator then received tokens, with documented exclusions [T]. On EVM creation-tx membership requires the launch acquisition subtree, not unrelated operations. Publish “launch-linked recipient” until control is proved. Keep a separately named recent-launcher-funding candidate under §2.3; do not mislabel it as Codex first-ever funding. Pools/routers/lockers/sinks/exchanges and broad distribution legs are excluded from the candidate label, not erased from supply accounting.

**CALIBRATE broad distribution screen:** ≥100 recipients in one distribution and each ≤0.1% S suppresses automatic insider candidate only. Reason: Codex excludes wide airdrops without numbers. Review donated/dispersed bags; preserve lineage, holdings and later sales. Exemption is a temporary buy antisnipe privilege, never an insider/control link; deduplicate repeated SnipeTaxExempted events. Ordinary fees still apply. [F §§1.6, 2]

Codex-comparable early buyers buy in `[tFirst,tFirst+5)` with no minimum size, including creator [T]. Separately report launch-relative `[t0,t0+5)`, `[t0,t0+60)`, `[t0,t0+300)` acquisitions. **CALIBRATE endpoint/window adaptation:** half-open seconds avoid a sixth bucket; wider windows catch delayed activity, checked against organic/staggered launches. Early once does not prove a bot. At age ≤5 seconds the entire distributed float may be early by construction.

Codex same-block comparator: ≥4 recipients, each buy ≥$5, combined ≥0.05% S, same launchpad pool block before graduation [T]. It need not be the creation block. Label it a candidate, not accepted bundle/control; missing USD makes comparator unknown.

**CALIBRATE persistent sniper:** trailing 2,592,000 seconds, earlyBuyCount/allBuyCount ≥0.90 across ≥5 distinct launches; early uses the first-trade five-second window. Ready, Aim, Snipe uses all buys within five blocks of first liquidity across five pools [A]; seconds/anchor/lookback are explicit EKO adaptations. Complete buy-enumeration needed; partial recurrence unknown. Validate on reviewed bots; never operator attribution.

Fresh funded wallet: first proven chain-4663 funding within 7,200 seconds before token buy, Padre comparator [T]. It needs complete earlier successful native/internal/relevant-token funding coverage; nonce/account creation/current balance do not prove age. Bounded history is “first observed in covered interval,” not fresh or first-ever. Optional freshness/history unknowns do not prove independence or add points.

### 2.5 Supply and liquid balances

**CALIBRATE measurement convention**, adapted from BE §6.4, GMGN float and Padre curve/pool exclusions [T]: reconcile at one cursor; validate launch/burn/lock/graduation fixtures and compare total/float prediction. Buckets are disjoint.

| Symbol | Raw units |
|---|---|
| M | Cumulative minted units, only with complete mint semantics/history. |
| S | Current on-chain totalSupply. Actual supply-reducing burns are already absent. |
| D | Verified irrecoverable sink balances still included in S. Live burn-intent, self-held or treasury wallets are not sinks by name. |
| K | Provably locked/unvested non-market units now; exclude only unavailable portion. Revocable/released holdings remain liquid. |
| U | Unsold/reserved curve inventory unavailable to external holders. After verified graduation U=0; locked excess goes to K. |
| P | Market token inventory, including tradable reserves whose LP custody is locked. V4 requires per-PoolId settlement/inventory, never whole PoolManager balances. |
| C | Circulating units `S−D−K−U`; price×C is circulating cap, price×S FDV. Version this definition. |
| Ffloat | External liquid holder float `C−P`. Use this as F below. |

Exclude overlap in order: true burns already absent → sink → non-market hard lock → curve → pool → external float. Do not count LP locker custody and underlying inventory twice. Unknown contracts/custodians remain in F and raw address top-ten; unresolved beneficiaries make control-group concentration incomplete. Negative/unreconciled quantities are failed checks, never clipped. Rebase/fee tokens need supported adapters. Current supply samples cannot substitute for earlier historical supply.

F=0 makes ratios null. **CALIBRATE stable-float screen:** F/S<2% makes scored float concentration unavailable, extending GMGN's cannot-assess reference to curves/locks. Validate by launch age and exact exit exposure. This is a buy-critical float gap; partial total-supply observations remain visible. Every scored holder numerator is presently transferable/sellable external units; show total, locked and liquid separately. Percentage `100×n/d`, d>0; gross bought may exceed 100% from turnover, held never can. Burns percentage `100×(M−S+D)/M` requires complete M/burn reconciliation; never subtract burns twice.

## 3. Measurements

### 3.1 Common measurement and coverage rules

Every metric carries status, unit, numerator/denominator, window, full cursor/knownAt, method and evidence. Statuses: `observed`, `lower_bound`, `upper_bound`, `unknown`, `not_applicable`; unknown/NA require null. Separate failure codes: missing/stale/failed/unsupported/unreconciled/uncalibrated. Available zero requires completed coverage. A bound can prove an inequality only in its stated direction; it cannot complete an exact ownership check by assumption.

**CALIBRATE USD-quality screen:** reference price at most 60 seconds old, bid/ask spread ≤2%; choose lowest spread, then greatest verified sell depth, then route ID. Reason: stale/manipulated USD invalidates dollar cuts; compare historical conversions against matched executable reference quotes. Do not assume USDG or stock/custom pairs equal a dollar. Persist event-time conversions; missing USD leaves quote metrics, not dollar thresholds. Network fees include execution and L1 data fees at the historical snapshot, not today's gas price.

### 3.2 Holder, lot and cash metrics

**CALIBRATE accounting conventions** in this table use exact units to distinguish transfers, turnover and expenditure. Validate conserved hand-calculated fixtures and compare FIFO/proportional outcomes before predictive fitting [F; T; A]. Cohorts are deduplicated wallet/lot unions with immutable membership. Acquisition windows use §2.4; lifetime is `[t0,T]` bounded by cursor.

| Metric IDs / group | Definition |
|---|---|
| `principalHolding`, `operatorHolding` | Principal alone / accepted control group. Raw, locked, liquid units; liquid/S and liquid/F. Unknown principal is null, not zero. |
| `cohortBought`, `cohortHeld` | Insider candidate, exemption, sniper, persistent sniper, qualified cluster: gross buy-delivered units in named window / S and F at window end; current liquid balances / current S and F. Bought includes repeat purchases; no clamp. |
| `largestCoordinatedHeld`, `unionCoordinatedHeld` | Largest qualified component / union of all qualified components, excluding overlap. Different groups are not claimed one owner. |
| `principalOriginOverhang`, `earlyOriginOverhang` | Current liquid traced lots in original/descendant wallets; burns/locks excluded. Preserve origin without owner union. Suppress automatic origin scoring for broad distributions until its specific gate passes. |
| `principalSold`, `operatorSold`, `originSold` | Actual tokens debited into confirmed token→quote swaps; originSold includes only attributed lot fraction, independent of control. No transfer/burn/CEX deposit is a proven sale. |
| `soldShare`, `soldFloatPct`, `soldSupplyPct` | `soldUnits/(openingLiquidUnits+externalAcquisitionUnits)` in stated interval; internal transfers cancel, rebuy is a new external acquisition event. Separately sold/F and sold/S at campaign start. Zero denominator unknown. |
| `dispositions` | Opening+acquired = held+sold+burned+locked+net transferred out+fees, after internal cancellation; disclose unexplained residual and CEX deposits with unknown onward disposition. |
| `topAddress10`, `topControl10` | Largest min(10, count) raw external liquid addresses / F; accepted control units plus unmatched addresses / F. Sort balance descending then address/group hash. Unresolved custody stays raw and creates group uncertainty. |
| `freshHeld`, `freshCount` | Proven fresh balance/F and proven fresh holder count/external holder count; unknown-age mass/count separately. No first-ever coverage → unknown. |
| `marketCashOutMultiple` | Lifetime net sale quote receipts / actual buy quote debits, including trading charges, excluding gas/launch/LP funding. Same quote asset; zero/unknown denominator → null. |
| `allInCashOutMultiple`, `realizedLotMultiple` | Add verified gas/launch contribution to market denominator / use sold-lot cost respectively, only with complete stated valuation. No invented gift/allocated recipient basis or infinity. |
| `creatorFees`, `lpReceipts` | Verified creator fee receipts, LP principal/fee claims and protocol buyback flows separately; none is a token sale by itself. |

FIFO consumes lots by acquisition cursor then origin address. Transfers preserve origin and economic basis but do not invent a gifted recipient's cash cost. Router transient custody is routing. Fee-on-transfer preserves debit/delivered/fee units. Mixed sales cap attribution at actual debit; report unknown origin. If FIFO versus proportional allocation reverses own-side attribution, report lower/upper units and withhold confident history pending adjudication. An optional FIFO-attributed unique acquisition estimate is non-scoring; fungible units after market mixing are not uniquely identifiable.

GMGN's 1.5× cash-out and first-sell ≤30 seconds [T] are diagnostics, not harmful-history labels. **CALIBRATE denominator adaptation:** the market-only multiple above is EKO's explicit convention, not fully documented GMGN accounting; reconcile quote deltas. Vendor continuous severity `clamp01((multiple−1)/3)×clamp01((120−firstSellSec)/120)` is optional display context with pinned arithmetic, no points. The $10 profit example must remain negative.

### 3.3 Current selling, campaigns and extraction

Build raw metrics now from resolved swaps/transfers/exemptions; use direct principal attribution only where authenticated. Exempt/early cohorts remain separately measured. Unknown funding cannot erase observed sales. Exit/mechanical impact and causal labels require later verified state adapters.

**CALIBRATE episode method:** chronological same-side sells with gap ≤60 seconds and duration <300 seconds; split before a sell at ≥300 seconds from episode start, even if gaps remain short. Close on gap >60 or timer reaching 300. Open episodes report provisional metrics at T. Aggregate disjoint episodes/trades over trailing 300/3,600/86,400 seconds, each trade once; slow 61/301-second campaigns do not disappear. Reason: bounded episodes are implementable and cumulative windows capture bleed; test cadence and organic/MM controls.

**CALIBRATE mechanical pressure:** re-execute valid economic sell legs at their exact pre-transaction state on a pinned route. For each strictly positive same-quote price ratio, pressure fraction is `1−exp(−Σ a_i×max(0,ln(Pbefore_i/Pafter_i)))`, a_i=proven side/origin fraction. Display ×100. Use pinned arbitrary-precision decimal implementation, 36 fractional digits, round-half-even; store rational error bounds and treat comparisons within the numerical error bound as unknown. Starting precision is chosen below threshold-relevant error; compare with exact adapter replay and increase precision if boundaries differ. Direct route pressure, actual drawdown and later arbitrage are separate, never a motive claim. Unsupported reconstruction yields unknown pressure while swaps/proceeds stay visible.

Material harmful-disposition and operator-dump rules are in §4.2. Real buyer valuation/counterfactual work is queued offline; current pressure does not wait for it. A current swap quantity and proceeds can be known before control or responsibility is known.

Optional **CALIBRATE proportional reserve-origin estimate**, motivated by draft B/A funding accounting: partition reconciled real quote reserve into operator, outside-buyer and pre-existing/other buckets. For positive incoming reserve delta add its attributed net reserve contribution, recording separate fee transfers. For outgoing gross reserve delta remove proportionally from all buckets; separately classify net seller receipt and fee outflow. Zero prior reserve ratio unknown. Require nonnegative buckets summing exactly to real reserves. Virtual reserves are not money. Migration carries actual buckets only where settlement reconciles; other LP additions enter provider buckets. Pin identity classification to the availability cut.

`buyerOriginReceipts=Σ(netAttributedSaleReceipt×buyerBucketBefore/realReserveBefore)`; interval estimate `max(0,buyerOriginReceipts−verifiedOperatorBuyDebitsInInterval)`, subtracting each debit once. Mixed-origin receipt uses sold-lot fraction. Report gross receipts/offset and interval. Validate conservation and mixing sensitivity on Pons first. Unsupported pool settlement/fees makes estimate unknown. It is neither established conservative bound, victim loss nor mandatory dump input.

### 3.4 Executable exits, depth, fees and controls

| Metric | Exact contract |
|---|---|
| `venueRoundTripCostPct` | For actual spent quote Q after refunds and returned quote R after protocol/applicable EKO fees: `100×(Q−R)/Q`, Q>0. Guard scoring uses this field. |
| `allInRoundTripCostPct` | `100×(Q+Gi+Go−R)/(Q+Gi)` with separately priced entry/exit execution+L1 fees. Negative net cash proceeds/cost remain signed; nonnegative position mark is a different field. |
| `existingPositionExit` | Sell-only quantity q from real held position; net proceeds and discount versus q×pre-sell marginal price. Never a fabricated round trip. |
| `depthBuy{2,5,10}`, `depthSell{2,5,10}` | Maximum market-only input moving post-trade marginal price by ≤2/5/10% of initial marginal price. Buy notional=quote input; sell=input tokens×initial marginal price. Fees separate. `depth2=min(buy2,sell2)`. |
| `removableDepthShare` | `1−sellDepth2WithoutControllerPositions/sellDepth2Full`, recomputing all supported reachable routes at fixed pre-removal valuation. Full depth zero → unknown ratio plus separate no-exit finding. |
| `taxes`, `powers`, `hooks`, `limits` | Direction/recipient/size-specific effective charges; authority/controller, bound, revocability, delay/earliest execution; route max transaction/wallet; code/implementation/config and direct state-change evidence. Tri-state, never default false. |

Reference sizes $100/$1k and supplementary $10k come from BE §6.2/FE §3.5. Each size/account class executes independently on isolated state. Neutral reference account is non-exempt, standard tier, with declared phase/fee config; use CF §5 fee schedule (0% launch week; thereafter standard Uniswap 50bps unless configured; Pons curve 0bps until reviewed fee router). Actual-order account uses its verified entitlement. No hard-coded universal Pons fee, creator payout or antisnipe duration.

Select route separately per size/class by highest verified round-trip or sell proceeds; exact tie route ID bytes. Unsupported routes do not prove zero market capacity. Display both size bands/entry states; compact headline chooses worst valid band, $100 before $1k on ties, account class ID on further ties, and names cause. A known $1k entry cap is `entry_limited`, completes that tested limit, blocks that order size and is not 0% cost or honeypot. If all reference entries fail, publish Incomplete with `reference_entry_unavailable`; no lowest-risk headline. Unsupported required class/size probe is buy-critical missing.

**CALIBRATE local depth solver:** use exact inversion where available; otherwise bracket $1→$1m by doubling, then binary refine to ≤1% notional interval width; budget 48 evaluations total, including bracketing. Reason: 24 cannot cover ~20 doublings plus refinements. Prove monotonicity/venue maximum; when cap/precision fails report directionally proved bound, never exact. A proved lower depth bound may satisfy a smaller policy floor. Local computations only, no repeated remote quote search. Validate versus exact ticks/curve math and execution. Average execution-discount depth is optional under a different key; do not replace ±marginal policy depth. [BE §6.1, adapted]

Pinned Pons getters plus quote debits, reserve delta and recipient payouts establish effective total charges. F verifies `fee`/`tax` ABI; it does not settle R3's folded-antisnipe claim. Until reconciled, total charge can be observed with decomposition unknown. Unknown decomposition alone is not missing effective-tax check when effective total and authority/schedule are established. Getter alone is not immutability. Pin proxy/implementation/hook/locker, actual launch schedule and decay end; replay after verified cooldown for persistent restriction. Temporary severe cost can be High now with retry condition, without adverse history.

Probes cover fresh deterministic EOAs and the supported smart-account/contract path; include two distinct deterministic nonprivileged identities for persistent wallet-selective restriction confirmation. **CALIBRATE two-account confirmation:** catches privilege leakage; expand on selective failures. Isolate forks or serialize reset leases; never override away token security, recipient storage/cooldown or checks. Record permitted balance/probe-code overrides, original allowances/limits and fidelity. Class cannot buy → entry limit; valid acquired position cannot sell → exit restriction for that class. Untested relevant class is incomplete for its orders. EOA success cannot certify an agent's contract path.

Token-enforced sell failure needs reproduced valid capacity/allowance/gas/state and temporary restrictions resolved; independently reproduce on another fork/provider before outcome labeling. **CALIBRATE confiscation** is returned quote <5% of valid independent no-tax post-buy sell output, adapting BE's 95% principle; thin liquidity/fixed fees/antisnipe are cost findings, not automatically honeypot. Unknown cooldown/provider error is unknown. Unsupported route prevents no-exit proof. Verified no executable $100 sell capacity requires complete supported route discovery.

Controls require reachable permissions and a forked state change, not selector/no-op eth_call/zero owner alone. Store queued mint/tax/upgrade/unlock earliest execution within **CALIBRATE 3,600-second** scenario horizon; show `releasableByHorizonUnits` separately from current F. Reason: impending releases change exposure; test current versus horizon supply on vesting/timelock negatives. Hook quote/sim gap `100×abs(quoteOut−simOut)/quoteOut` (positive denominator), sell/buy effective-fee difference in pp; 2%/5pp from C are **CALIBRATE diagnostics**, validated on matched state/account routes, not decisive bits. Unknown hook is buy-critical unsupported. Verified Pons curve has no creator LP pull; known locked graduation custody is locked, not burned [R3], subject to pinned profile. Other removable pools still matter.

### 3.5 Cycling, identity, text and card context

**CALIBRATE cycling convention**, retained from C's one-hour volume and 300-second episode safeguards: full `(T−3600,T]` observed window. Per economic actor/control group, start at next buy; expire after >300 seconds; close at first sell-inclusive state where abs(netTokens)/grossBought≤0.10. Require ≥2 wholly contained disjoint completed episodes. Numerator=buy+sell gross USD of qualified episodes; denominator=all market buy+sell gross USD in same window, ≥$10k for a scored candidate. Zero/missing-priced denominator unknown. Exclude proved cross-market neutral arbitrage and classified settlement; separately show MM, buyback and unclassified volume. Ordinary flipping is not deceptive intent. Single actor/control grouping prevents trade duplication. Validate against real MM/arbitrage controls before any I5/10 points at ≥50/80%.

**CALIBRATE curve recycling diagnostic:** `(max(t0,T−21600),T]`, same-quote gross volume / fee-excluded positive real reserve growth, starting ratio ≥5 with top three qualified groups ≥60% gross volume and age ≥21600 seconds. Zero/negative growth gives unknown ratio plus raw amounts. Reason: current config convenience, not empirical scam rule; reconcile reserves and normal curve activity. No slow-graduation/history escalation. Zero points independent of cycling.

Identity collision: nonempty NFKC/casefold/confusable-normalized equal name/symbol; implementation reuse is expected for factories. Zero financial points is this design's choice, not a blanket owner ban. Trusted authenticity uses `(chain,address)` registry. **CALIBRATE trend subtype** retains top 50 preceding-hour gross USD ranks, older age ≥600 seconds, launch within `[onset,onset+3600)`; omit subtype if real stored trend onset absent. Dominant buyer gross buy+seller gross sell / all gross trade USD over 3600 seconds, each side once; 0.8 diagnostic, missing/zero unknown. Reason: retain useful copy context without old automatic Danger; test missing onset and clone farms.

Text source contract is finite: stored token name/symbol and descriptions/social payloads actually supplied by existing ingestion, not every external post. **CALIBRATE instruction predicate:** explicit agent target (`agent`, `assistant`, `bot` or model role instruction) plus imperative prohibited action enum `buy|approve|transfer|send|bypass_checks|change_policy` in the same sentence. Starting scan bound 4,000 Unicode characters per field from C; record truncation/missing fetch and text hash. Pattern/version and quoted/negated cases are reviewed; classifiers run acquisition/shadow jobs, not in evaluator. Reason: avoid the current positive-word/action false positives; §9 ≥95% reviewed precision. Text coverage failure is optional diagnostic, cannot make all coins buy-critical incomplete. The inert Untrusted boundary always applies; today's preflight cannot prove an order was derived from metadata.

Context metrics (non-Guard): curve progress `100×netRealQuoteReserve/graduationThreshold` under pinned fee convention (cap bar only); holder count=positive external liquid addresses; launch age=T−t0, snapshot age=servedAt−snapshot time; freshness age=oldest required section age, unavailable sections named. **CALIBRATE accounting adaptations** from BE/C: reconcile fixture balances/reserves and timer behavior. Supply anomaly price×C>$10bn at age<604800 seconds remains a diagnostic from BE, not a risk factor; hide anomalous cap with evidence, not other metrics.

Flow windows 300/3600/86400 seconds [BE]: covered buy USD shares with disjoint label priority declared agent→likely agent→qualified crew→unclassified. `agentPct=declared+likely`; missing actor/label gets unclassified with explicit coverage, never proven human/organic. Zero volume shares null. Versioned Watcher confidence/coverage accompanies beta; no flow/Signal feedback into Guard. Show gross volume, net new external quote capital (external buy inflow−sell outflow, fees separately), raw/economic actor counts, purchased versus airdropped holder growth, classified MM/arbitrage/buyback and unclassified amounts. Acquisition/airdrop holder-growth decomposition uses first positive external balance's provenance, then unique addresses, unknowns separate; validate conservation and overlapping labels under **CALIBRATE** conventions.

## 4. Outcome labels

### 4.1 Records, horizons and no lookahead

Labels are independent simultaneous facts, with responsibility separate. Store `(token,eventId,horizon,outcomeVersion,identityVersion,availabilityCut)` and revision, not one priority label. Display ordering: restriction, withdrawal, dump, collapse, survived. F's 1,215/1,681 old bag-sale labels (72%) and 93% near launch price are failure evidence, not ground truth.

Horizon seconds are 3600/86400/604800 [BE §7.5]. An outcome requires watermark through the first completed boundary at/after horizon, complete required events/checkpoints and confirmation lag. **CALIBRATE confirmation lag=30 seconds** with canonical hash rechecks; reason: operational reorg filter; fit observed reorg tails and verify L1 evidence separately. It is not protocol finality. Status `provisional|confirmed_under_policy|indeterminate|censored`; archive shortage is censored, unresolved responsibility is indeterminate. No-data never survived. Reorg appends orphan/supersession for all dependent records.

History at T uses only mature confirmed outcomes and effective control evidence known by T. Later collector, registry classification or merge cannot rewrite a past predictor/receipt. Retrospective review is explicitly separate. A closed current episode can be a flow fact before an entire outcome horizon matures.

### 4.2 Harmful disposition and operator-attributed dump

**CALIBRATE joint candidate**, correcting both drafts' small-sale and synthetic-buyer errors [F; reviews]: use §3.3 bounded episodes and trailing 3600/86400-second campaign aggregates. Materiality is sold liquid units ≥1% opening F **or** positive net trading cash-out ≥$500 **or** gross sale receipts ≥10% pre-campaign real quote reserve. Unknown inputs cannot satisfy their branch. Reason: scale to float/reserves while keeping tiny ordinary profit negative; fit on size/depth and slow campaigns, retain subthreshold facts.

Covered real outside buyers include purchased lots held immediately before campaign and lots acquired during it, in separate cohorts. Outside means outside confirmed selling side, not human. Cost includes actual acquisition charges and attributable gas; loss uses realized net cash proceeds plus independently executable remaining-lot liquidation at close, gas once per evaluated liquidation. Value each wallet on the same state, not an invented sequential mass liquidation. Report cost-weighted mean, median, quantiles, hurt count/cost, known-basis and executable-position coverage; unpriced/gifted lots unknown.

For automated harmful label require ≥30% cost-weighted mean net loss in at least one covered cohort, positive responsible-side net trading cash-out, and ≥10pp cohort-return improvement in a valid **sell-only** counterfactual (§9.2). **CALIBRATE cohort sufficiency:** ≥90% acquired quote cost and ≥90% token positions identified/valued for that named cohort; start to prevent cherry-picked victims, fit against full real-buyer hand reviews. Report severe individual losses even when average/sufficiency fails. A separately named net-trading intervention removes buys+sells; never describe it as sales-only contribution. Standard pre-sale $100/$1k probes are separate sensitivities, not replacement victims. Mechanical pressure and reserve-origin estimate are optional diagnostics, not extra required conjuncts.

`harmful_disposition` records observed actor/origin and buyer harm. `operator_attributed_dump` additionally requires high-confidence own-side sale control/closed loop, complete conservation/replay and applicable attribution gate. Outsider harmful selling does not enter launcher history. Independent gift recipient selling remains origin-linked, responsibility unresolved. Invalid counterfactual makes automated attribution unavailable; raw pressure/harmed buyers remain and an adjudicated alternative method is separately versioned. Automated history accepts only complete calibrated outcomes; unresolved/manual judgments cannot silently substitute.

### 4.3 Liquidity withdrawn, restriction, collapse and survival

| Label | Definition and method |
|---|---|
| Liquidity withdrawn (`rug` internal class) | Any proven authorized remover; responsibility separate. **CALIBRATE** ≥$500 pre-event position value, ≥99% affected market real inventory value removed and ≥90% token-wide sell 2 depth lost, no equivalent buyer-reachable successor for 600 seconds. Pre-removal inventory value=real quote + token inventory×pinned marginal quote price, converted then. Validate migration/rebalancing/removal and $500 sensitivity. Complete supported route discovery required; unknown successor is unassessed. Verified curve/nonwithdrawable profile NA; secondary removable pools assessed. |
| Imposed exit restriction | §3.4 reproduced token-enforced failure/confiscation, wallet/size/route class pinned, independent reproduction and temporary restrictions resolved. Controller responsibility only with authenticated control/exercised configuration. Immutable restriction can be current High with issuer unresolved. |
| Collapse | **CALIBRATE** primary 60-second-entry $100 purchased quantity: max executable quote-unit net liquidation value after entry, then minimum later value; earliest cursor ties. `drawdownPct=100×(peak−trough)/peak≥90`, peak>0. Checkpoints every 60 seconds, relevant sell/control/graduation boundaries and horizon. Recovery/horizon value separately; earlier collapse not erased. Missing route/entry censored. Literal “without observed operator/launch-linked selling” needs full relevant swaps/transfers/actors and zero such sales during decline, not merely no qualifying dump. No collapse enters operator bad history. |
| Survived horizon | Complete applicable event/control checks and executable benchmark exits at both reference sizes at scheduled checkpoints through horizon, no qualified restriction/withdrawal/dump/collapse. Entry failure/unknown checkpoint censored. It permits ordinary buyer loss; no quality assurance. |

Cernera/Huynh's ≥99% concerns minted V2 LP tokens under one-Mint/one-Burn/lifetime conditions [A], not EKO's inventory/depth adaptation. Mazorra's ≥90% drawdown also requires inactivity/no recovery in that study; EKO does not import a 30-day death test. GMGN dev-score's pool-death comparator is nonzero token removal with ≥0.5% S or $500 [T], not contract-DD. These are references, not validated v3/v4 labels.

## 5. Risk families, completeness and examples

### 5.1 Shadow factor table

All weights/cuts in this table are **CALIBRATE**, starting from B's 30/60 family approach with reviewed corrections. Reasons: executable drag, liquid ownership, current pressure and reachable powers are distinct buyer exposures; capped maxima reduce overlapping evidence. §9 validates factual measurements first, then each heuristic's ablation and whole-level gates. Inclusive ≥ unless shown <. Pick greatest matching tier.

| Family | Factor ID and precise inputs | Points |
|---|---|---|
| E execution | `execution_cost`: worst valid $100/$1k venue cost ≥5/10/25/50% | 10/20/40/60 |
| E | `thin_depth`: min directional depth 2 <$10k/$2k/$500 | 10/20/40 |
| O ownership | `operator_hold`: liquid operator/F ≥5/10/20% | 20/35/50 |
| O | `coordinated_hold`, `coordinated_union`: largest component / deduplicated union of qualified ≥3-wallet components /F ≥15/30/50% | 20/35/50 each; same-family max |
| O | `top10_float`: max valid raw/control top 10 /F ≥40/60/80% | 20/35/50 |
| O | `launch_linked_hold`, `principal_origin_hold`: candidate union / traced liquid principal-origin lots /F ≥10/20/30% | 20/35/50; origin factor separate gate for gifts/distributions |
| O | `early_origin_hold`: first-trade-five-second liquid origin overhang/F ≥20/50% | 10/20, timing-only cap |
| O | `persistent_sniper_hold`: qualified persistent-sniper liquid union/F ≥30% | 35; no operator inference |
| O | `authenticated_dominance`: one authenticated control group liquid/F ≥70% | 60; severe candidate, organic concentrated controls required |
| O | `horizon_release`: operator-controlled releasable units within 3600s divided by F+those release units ≥5/10/20% | 20/35/50, separate scenario, current F unchanged |
| Ff flow | `current_sell_pressure`: sold/openingF ≥5/15% AND measured pressure ≥10/30%, trailing 300 seconds | 20/40 |
| Ff | `campaign_pressure`: same quantities/pressure over trailing 3600/86400 seconds | 20/40; exposes slow campaigns; full-window coverage |
| Ff | `harmful_selling`: complete §4.2 non-operator/origin-unresolved harmful campaign closed within previous 3600 seconds | 40 |
| Ff | `operator_dump`: qualified own-side §4.2 dump closed within previous 3600 seconds | 60 |
| C control | `mutable_control`: reachable bounded change within horizon; verified permitted sell tax ceiling ≤5 / >5 and ≤30 / >30%, or bounded liquid mint dilution ≤5 / >5 and ≤20 / >20% of current S | 0/20/35; quantitative hypothesis, not method names |
| C | `arbitrary_control`: reachable unrestricted liquid mint, arbitrary holder blacklist/sell pause, transfer-code upgrade within horizon | 60; capability tested, not necessarily exercised |
| C | `removable_depth`: operator can withdraw ≥50% token-wide current sell 2 depth | 35 |
| C | `exercised_control`: independently reproduced ≥25% execution loss from effective exercised control/hook anomaly, not duplicate cost or decisive restriction | 40 |
| I integrity | `cycling`: reviewed high-confidence coordinated estimate ≥50/80% of ≥$10k complete hourly gross USD, relevant buyer exposure | 5/10; otherwise information only |
| I | `agent_instruction`: qualified reviewed predicate from §3.5 | 10 |
| I | Clone likeness, launch count, exemption, freshness, fixed fee income, hook permission bits alone | 0 |

Top 10 ≥40/60 adapts GMGN's strict >40/60 [T]; inclusivity and ≥80 are explicit EKO candidates. Treasury/custody liquid risk is not erased by role. Timing-only early audience is not one bag; organic first-five-second saturation cannot get O50 merely for timing. Campaign pressure has no causal operator claim. Severe capability points and horizon scenarios are shadow until their own controls/vesting gates pass.

Decisive current High facts: reproduced token-caused sell block for valid acquired position; confiscatory return <5% valid no-tax output; complete supported route discovery establishes no executable $100 sell capacity; qualified token-wide liquidity withdrawal with depth still absent. Also **CALIBRATE severe-cost dispatch** ≥50% venue round-trip loss for an executable reference size, consistent with E60; identify tax/capacity cause, not honeypot by cost alone. Provider error, unknown route, selectors, history/clone count are never decisive. Existing confirmed factual hard refusals persist; new heuristic dispatch waits for §9.

### 5.2 Combination, history and dispatch

Within each family take max, then `base=min(100,E+O+Ff+C+I)`. Suppress only configured proven duplicate mechanisms, not every effect sharing an old transaction. Present cost and realized sell pressure are distinct; remaining bag versus sold lots is distinct. Duplicate current fee capability/discrepancy versus measured cost uses stable key `(implementation,capability,effectiveConfigEvent)`; duplicate pressure/dump evidence uses episode/action IDs. Unknown hook cause never gets invented key.

For conflicting eligible assignments under the registry compatibility matrix, enumerate the small fixed assignments, one award per prohibited duplicate mechanism, maximize sum of family maxima; tie by ordered `(E,Ff,O,C,I,factorId)` assignment serialization ascending. Store eligible/suppressed choices and matrix/hash. **CALIBRATE allocation choice:** retain independent exposures without greedy loss; ablate versus plain maxima. Mandatory fixture: mechanism M E40/Ff40, independent N E20 → Ff40+E20=60, not 40. No manual suppression to fit outcomes.

**CALIBRATE B history booster:** trailing `(T−2592000,T]` indexed-launch universe, mature 3600-second own-side outcomes known by full cursor. Complete enumeration and assessment of every eligible mature launch required. Current launch excluded; adverse types=own-side dump, qualified own-side removal, controller-linked restriction, one count per launch. Collapse/bots/clone/fees/wash/legacy Guard levels never adverse. `badRate=badMature/allAssessedMature`; no denominator unknown. At least three bad launches, rate ≥50% and one adverse event known in previous 604800 seconds →10 points; rate ≥80% →15. Only if base≥30 and at least one current E/O/C factor positive. `score=min(100,base+boost)`. Reason: sparse/stale history should only strengthen present exposure; test 24-hour/7-day delayed-bleed sensitivity and operator-held-out ablation. Keep integer steps, not decay, to avoid new attribution/selection complexity. Incomplete denominator disables booster, names history gap. Fully enumerated young operator with no mature launches is complete/no eligible history, not artificially missing. Lower release nevertheless requires the history coverage investigation under the binding tier decision.

New history/outcome logic is buildable early as pure inputs/fixtures; current 5.6h and old labels cannot populate a complete 30-day study. Booster stays shadow/disabled for first calibration unless separately accepted. A complete history check can validly report “no booster released”; this differs from missing enumeration/outcomes. Do not let unavailable history add points.

### 5.3 Required check manifest

Statuses `complete|not_applicable|missing|stale|failed|unsupported`; each has exact failure code/coverage/evidence. NA needs proved adapter rationale, never attempted-but-unresolved. Active configuration names released checks; experiments/text/buckets never silently become required checks. An unreleased candidate engine cannot publish active Lower. Uncalibrated required candidate checks block candidate Lower promotion, not unrelated active orders.

| Check ID | Tier | Completion predicate |
|---|---|---|
| `reference_exit` | Buy-critical | Both $100/$1k and supported EOA/smart-account classes have valid pinned buy→sell analysis or proven entry limit; ≥1 reference entry executable; no unexplained probe/cooldown failure. Actual account/size separately required for its order. |
| `effective_fees` | Buy-critical | Current effective total fees/taxes/recipient schedule measured and charges reconciled; fee config applicable, no unknown effective amount. Breakdown may be unknown with total proved. |
| `controls_hooks` | Buy-critical | Effective implementation/upgrade/mint/blacklist/pause/tax/hook and reachable authority/limits assessed, including horizon changes; verified absent or bounded findings. Unsupported relevant hook missing. |
| `supply_float` | Buy-critical | S/D/K/U/P/C/F reconciled with complete relevant transfers and current ordinary liquid holder balances, positive stable F under §2.5, route custody known. |
| `recent_funding` | Lower-tier | Successful external/internal native plus relevant quote funding intervals for eligible candidates covered, gaps and non-service paths assessed under §8. First-ever/freshness optional. |
| `coordination_coverage` | Lower-tier | Candidate universe/current origin and direct actor/lot accounting assessed; ≥95%F covered and unresolved candidate upper bound cannot cross next 15/30/50% coordination boundary from current union. Every connected candidate capable of ≥15%F assessed. |
| `launcher_service` | Lower-tier | Per-launch principal or proved inapplicability of creator history for non-launch secondary listing, service wiring/ambiguous path resolved. Unsupported investigation is missing, not NA. |
| `operator_history` | Lower-tier | Supported-universe 30-day enumeration and all eligible mature outcomes assessed for resolved operator, or positively no eligible history; optional booster release status recorded. Unknown operator/history is missing. |

**CALIBRATE candidate coverage:** all recipients acquiring in `[t0,t0+300)`, all principal-origin descendants, all current liquid holders ≥1% S, plus rolling later-acquisition pool; expand to cover ≥95% F and all potentially ≥15%F components. Queue largest unresolved held mass first, then newest acquisition, then address. Report omitted/excluded mass/count and worst-case unresolved joint group (`known qualified union + unresolved liquid balance`, capped at F), without claiming independence. Reason: defeat 200×0.2% fragmented holders; validate dispersion/service controls and budget/time-to-completion. A 1% screen is queue priority, never proof about smaller wallets. Multi-hop fetch stops at three; coverage failures remain lower-tier gaps under lead decision.

Dispatch: compute valid released facts/score → observed level (`high` if decisive/score≥60, `elevated` if ≥30, else `lower`) → if high publish high regardless of gaps → else buy-critical gap publish incomplete → else lower-tier gap publish at least elevated → else publish observed. No numeric missing-data penalty. Candidate/shadow outputs are labeled, cannot affect active orders. Retain raw known lower score internally without low-risk public coloring. `completeness` lists all gaps even for High. Order checks may be stricter or account-specific; they do not change historic verdicts.

### 5.4 Worked archetypes

Real counts below come only from F/R3; all new costs/holdings/losses are synthetic fixtures assuming released factors and complete critical checks, unless stated. Apply the tier overlay after arithmetic.

| Archetype | Fixture calculation | Published result and attribution |
|---|---|---|
| Clone farm `0x69bb…` | F:172 launches, no own buys/sells, 0 dumps in 44 measured old outcomes. Fixture top 10 45%→O20; cost 3%, depth$20k→E0; clone 0/history 0. | Score 20: Lower only with both tiers complete; today's funding/history gaps→Elevated · Not fully checked. Old 81 Danger/clone flags never bad history. |
| Shared tool `0x0e16…` | F:108 launches/108 exemption sets. Fixture per-user qualified group 32%→O35; independent depth$1.5k→E20. | Score 55 Elevated; no aggregate service history. Unresolved user principal is lower-tier gap, not proof of risk or a person count. |
| Dev buys and harms buyers repeatedly | Fixture current own-side qualified dump Ff60, separate liquid bag 12%→O35; complete prior 4/5 adverse, recent→boost 15. | Score 100 High, every mode denies. F's repeated self-buys alone do not establish this fixture's dumps. |
| Legitimate creator, heavy bot selling | Persistent sniper union 32%→O35; verified outsider current pressure 15%F/35%→Ff40. No own-side harm/history. | Score 75 High buyer risk, creator bad count 0. Once bots sell out O disappears; Ff40 remains only while current/campaign window qualifies. |
| $10 insider profit at $500k cap | Fixture sold below 1%F, receipts$20/profit$10, reserve fraction<10%, actual buyer loss negligible; E/O/Ff/C/I0. | Score 0 Lower if complete; gaps floor Elevated. F's separate −3.9% sample is not measured performance of this hypothetical. |
| Reported 53-launch ring | R3 alleges 70–200 wallets/≥70% initial capture. Fixture verified current coordinated 55%F→O50, independent depth$1.8k→E20. | Score 70 High; reporting alone does not qualify control/history or 53 bad labels. Categories 45/4/4 may overlap. |
| Organic opening audience | At age 4s 100 independent buyers own all F; early-origin 100%→O20; raw top 10=20%, cost 5%→E10. | Score 30 Elevated, no artificial O50 or operator claim. Exact 5% boundary fixture. |
| Critical outage versus funding outage | Observed score 20. Unknown reference exit→critical gap; alternative case exit valid but funding/history unknown. | First Incomplete, all buys denied. Second Elevated with names, Safe denies; Balanced/Degen continue within limits. |
| Severe fixed fees / dormant arbitrary power | Separate fixtures cost 60%→E60; confirmed reachable unrestricted mint→C60. | Each High after its gate; first is severe cost, second capability. Neither automatically an attributed honeypot outcome. |

Required boundary fixtures also cover all 18 legitimate and 20 evasion cases in [C1](reviews/review-C1.md), with explicit input metrics/order/status; they test mechanics, not empirical accuracy. High, threshold equality, no false own-side harm and missing tiers are assertions, not impressions.

## 6. Reasons, evidence and coin card

Use one registry of first-party reason templates. Tile shows at most three lines [BE §7.6]; detail exposes all scored, suppressed, informational and missing findings. Sort decisive first, assigned points descending, family order E/Ff/O/C/I, then factor ID. Same-size ties $100 before $1k. Each line links validated metric/event/state evidence at the evaluated cursor. Unknown breakdown renders “breakdown unavailable,” never invented amounts.

| Code | One-line template |
|---|---|
| `EXIT_COST` | A {sizeUsd} buy-then-sell returned {returnedUsd} at {snapshotId}: {costPct}% venue round-trip cost; gas {gasUsd}. Fee breakdown: {breakdownStatus}. |
| `DEPTH` | Buy/sell 2% marginal-price depth is {buyDepthUsd}/{sellDepthUsd} on {routeId}; fees and gas are additional. |
| `ENTRY_LIMIT` | Entry at {sizeUsd} is limited for {accountClass}; {limitCode}. |
| `SELL_RESTRICTION` | A valid purchased position could not be sold by {accountClass} at {sizeUsd} on the tested valid routes. |
| `CONTROL` | {authorityRole} can {capability} under implementation {codeHash}; {boundCode}, earliest execution {executionTime}. |
| `GROUP_HELD` | {groupType} holds {liquidUnits}: {supplyPct}% of outstanding supply and {floatPct}% of holder float; {linkClass}. |
| `TOP_HOLDERS` | The largest {holderCount} external addresses hold {rawPct}% of holder float; verified control grouping gives {groupPct}%. |
| `EARLY_BUYERS` | First-trade-window buyers acquired {grossBoughtPct}% of outstanding supply and currently hold {heldPct}% of holder float. |
| `SAME_BLOCK` | {recipientCount} recipients bought in the same launchpad-pool block before graduation: {buyUsd} total and {boughtPct}% of supply. Shared control is {controlStatus}. |
| `ORIGIN_SALE` | Launch-origin tokens were sold by {sellerAddress}; seller control is {controlStatus}; {soldUnits} attributed units, {basisCoveragePct}% basis coverage. |
| `SELL_PRESSURE` | {sellerClass} sold {soldPct}% of opening float over {windowSec} seconds; measured sell pressure {pressurePct}%; attribution {attributionStatus}. |
| `ATTRIBUTED_DUMP` | Operator-controlled wallets sold {soldPct}% of {denominatorName} for {netQuote}; covered buyers lost {lossPct}%. The {interventionType} replay improved return by {contributionPp} percentage points. |
| `EXEMPTIONS` | {count} launch wallets are exempt from temporary buy anti-snipe tax; {affiliatedCount} have independent affiliation evidence. |
| `CYCLING` | Estimated repeated cycling is {sharePct}% of {volumeUsd} covered gross volume in 3,600 seconds; {classificationStatus}. |
| `CLONE` | Same normalized name/ticker as {tokenId}; this establishes neither authenticity nor shared control. |
| `HISTORY` | {badCount} of {matureCount} completely assessed launches in the covered {historyWindowSec}-second window had operator-attributed harm; current {exposureType} receives {historyPoints} points. |
| `TEXT_INSTRUCTION` | Untrusted token text contains an agent-targeted {actionEnum} instruction; it cannot change trusted policy. |
| `INCOMPLETE` | Not fully checked: {checkNames}. {coverageCode}; retry condition {retryCode}. |
| `POLICY_DENIAL` | {denialCode}: {trustedPolicyExplanation}; measured at the requested account, route and size. |

Runtime-validate each template's parameter keys/types. Only first-party finite capability/action/status/check/retry enums, validated chain addresses/route IDs, snapshot IDs and fixed-point quantities fill trusted slots. No arbitrary strings/model prose/revert text can enter a trusted reason, title, notification, meta title, tool argument or shell command. Names/symbols/descriptions/social text and nested evidence text remain `Untrusted`. Render inert text through existing boundary: strip controls/bidi/zero-width, no HTML/Markdown/linkification/arbitrary href; explicit Copy text only. Links derive from internal validated IDs and `/config` allowlists. OG text sanitized; share intent/meta titles neutral trusted copy. Metadata detection is not proof of order provenance; no claimed automatic “derived from metadata” preflight refusal exists. [BE §9.5; FE §9; C preflight]

Required rich-card groups are the typed §7 schema, not merely reason strings. Always show unknown rows with status and coverage. Include route/class/size table; all supply buckets/denominators; raw and grouped holders; principal/operator dispositions and costs; insider/sniper/exempt/qualified/medium-candidate bags; origin descendants; current pressure and campaigns; control/fee/unlock scenarios; service/funding/history graphs; cycling versus classified activity; identity collisions and trusted registry; quote/source freshness and retry jobs. Retain $10k as supplementary asynchronous measurement, not mandatory reference probe.

Recovery fields: `lastHarmfulEvent`, `recoveryAsOf`, `oldSideLiquidOverhang`, `currentController`, `takeoverEvidenceStatus`. A takeover annotation requires evidence, supplies no automatic score reduction and does not rewrite the old incident. At 48h a reconstructed recovered market can be Lower only with present checks complete; residual old-side liquid bags still score. Promotion timestamps with source hashes are untrusted external leads, not control proof. Matched-tool parity is a §9 test, never inferred from card length.

## 7. Contracts, migration, versions and receipts

### 7.1 Complete versioned API boundary

Use canonical `lower|elevated|high|incomplete` in **GuardAssessmentV2** and the V2 API. Preserve the complete existing V1 `Verdict` required fields: `coin`, old `level`, string `reasons`, genuine legacy `playbooks`, `receipt`, `schemaVersion`, `asOfBlock`; preserve optional `evaluatedPlaybooks`/`beta`. `PlaybookMatch.level` remains its separate union including `info`. New factors never masquerade as legacy PlaybookIds. V1 extended response may add optional `guardV2`; clients negotiate schemas explicitly. Old proof payloads/levels remain immutable and display “Legacy assessment · rules 1.0.x.”

A **new** V2 result projects `lower→clear`, `elevated→monitor`, `high→danger`, `incomplete→pending` for V1 transport only. This does not assert old Clear passed V2 checks. Project structured templates to legacy string reasons; supply only genuinely evaluated legacy matches (possibly empty), never fabricate matches to enforce High. V1-aware policy reads mandatory V2 level through adapter, not `playbooks`. Existing V1 numeric/boolean placeholders keep section/field masks and original metric semantics; V2 values never reinterpret those fields.

Breaking card changes have explicit `/v2/coins/:address` and `/v2/coins/:address/verdict`, plus negotiated MCP/WS V2 payloads and V2 list/scan adapters. V1 unknown-issuer card remains unavailable under its existing schema/error behavior; V2 partial card has null principal/deployer and named gaps. Do not invent an address to satisfy V1. Raw decimal strings/nulls are V2-only breaking fields. Additive V1 extension uses `schemaVersion='verdict-1+guard-2'`; original stored `verdict-1` payload never reconstructed from new responses.

The following is the normative shape. Task 026 implements strict runtime schemas for every field, typed finite metric/check registries and compound values; objects reject undeclared trusted keys. Addresses, hashes, cursors, unions and enum parameters are validated. `Metric` value presence is discriminated by status, not an unchecked optional dictionary.

```ts
type GuardLevelV2 = 'lower' | 'elevated' | 'high' | 'incomplete';
type ObservedLevel = 'lower' | 'elevated' | 'high';
type Family = 'E' | 'O' | 'Ff' | 'C' | 'I';
type Decimal = string; // canonical non-exponent decimal, no -0/trailing zeros
type RawAmount = { asset: Address; decimals: number; raw: string }; // unsigned
interface Cursor {
  chainId: number; blockNumber: string; blockHash: Hash;
  transactionIndex: number | null; executionOrdinal: number | null;
  timestampSec: string; boundary: 'block_end' | 'before_tx' | 'after_tx';
}
interface AvailabilityCut { cursor: Cursor; acquisitionSequence: string }
interface Coverage {
  scopeId: string; from: Cursor | null; through: Cursor | null;
  complete: boolean; gaps: FailureCode[]; methodVersion: string;
  coveredUnits: RawAmount | null; excludedUnits: RawAmount | null;
  topLevelNative: boolean; internalNative: boolean;
  firstEverEstablished: boolean; sourceHashes: Hash[];
}
type Metric<T> = {
  id: MetricId; unit: Unit; cursor: Cursor; knownAt: AvailabilityCut;
  numerator: RawAmount | Decimal | null; denominator: RawAmount | Decimal | null;
  denominatorKind: 'S' | 'C' | 'F' | 'quote_cost' | 'gross_volume' | 'other' | null;
  fromSec: string | null; throughSec: string; coverage: Coverage;
  methodVersion: string; evidenceIds: Hash[]; failureCode: FailureCode | null;
} & ({ status: 'observed' | 'lower_bound' | 'upper_bound'; value: T }
   | { status: 'unknown' | 'not_applicable'; value: null });
interface GuardAssessmentCheck {
  id: CheckId; tier: 'buy_critical' | 'lower_tier' | 'optional';
  status: 'complete' | 'not_applicable' | 'missing' | 'stale' | 'failed' | 'unsupported';
  coverage: Coverage; evidenceIds: Hash[]; failureCode: FailureCode | null;
}
interface GuardFactor {
  id: FactorId; family: Family; mechanismId: Hash | null;
  state: 'matched' | 'not_matched' | 'unknown' | 'not_applicable';
  eligiblePoints: number; assignedPoints: number; suppressionCode: SuppressionCode | null;
  metricIds: MetricId[]; evidenceIds: Hash[]; template: ReasonCode;
  parameters: TypedReasonParameters; calibration: 'shadow' | 'released';
}
interface GuardAssessmentV2 {
  schemaVersion: 'guard-2'; coin: Address; chainId: number; cursor: Cursor;
  availabilityCut: AvailabilityCut; mode: 'shadow' | 'candidate' | 'active';
  rulesVersion: string; identityVersion: string; measurementVersion: string;
  outcomeVersion: string; codeHash: Hash; parametersHash: Hash;
  serviceRegistryHash: Hash; profileHash: Hash; calibrationManifestHash: Hash;
  referenceSizesUsd: [100, 1000]; benchmarkHorizonSec: 3600;
  level: GuardLevelV2; observedLevel: ObservedLevel; levelFloorReason: 'lower_tier_gap' | null;
  completeness: { buyCriticalComplete: boolean; lowerTierComplete: boolean; missing: CheckId[] };
  checks: GuardAssessmentCheck[]; factors: GuardFactor[];
  baseScore: number; historyPoints: number; score: number; scoreIsLowerBound: boolean;
  familyPoints: Record<Family, number>; decisiveIds: DecisiveId[];
  reasons: GuardReasonV2[]; history: HistoryCoverage;
  snapshotHash: Hash; decisionHash: Hash; evidenceRoot: Hash;
  receipt: ReceiptRefV2; supersedes: string | null;
}
interface GuardReasonV2 {
  code: ReasonCode; factorId: FactorId | null; parameters: TypedReasonParameters;
  evidenceIds: Hash[]; // per-template strict union, not free strings
}
interface QuoteMeasurement {
  sizeUsd: 100 | 1000 | 10000; accountClass: 'eoa' | 'smart_account';
  routeId: RouteId | null; entry: Metric<'executable' | 'entry_limited'>;
  input: Metric<RawAmount>; tokensReceived: Metric<RawAmount>; returned: Metric<RawAmount>;
  venueCostPct: Metric<Decimal>; allInCostPct: Metric<Decimal>;
  gasUsd: Metric<Decimal>; feeBreakdown: Metric<FeeComponents>;
  sellability: Metric<'executable' | 'token_restricted' | 'capacity_absent'>;
  maxTxUsd: Metric<Decimal>; maxWalletSupplyPct: Metric<Decimal>;
}
interface CoinCardV2 {
  schemaVersion: 'coin-card-2';
  identity: {
    chainId: number; address: Address; name: Untrusted; symbol: Untrusted;
    factoryDeployer: Metric<Address>; outerSigner: Metric<Address>;
    principal: Metric<Address>; creationPayer: Metric<Address>;
    createdAt: Metric<string>; marketOpen: Metric<string>; firstTrade: Metric<string>;
    graduation: Metric<string>; launchpad: LaunchpadId; stage: 'curve' | 'graduated' | 'unknown';
    quoteAsset: Metric<Address>; pools: PoolRefV2[]; service: ServiceResolution;
    operatorGroup: IdentityGroup | null; feeRecipients: RoleAssignment[];
    exemptions: RoleAssignment[]; clone: Metric<IdentityCollision>;
  };
  tradeability: {
    quotes: QuoteMeasurement[]; // required entries for both sizes x supported classes, unknown explicit
    buyTaxPct: Metric<Decimal>; sellTaxPct: Metric<Decimal>;
    antiSnipe: Metric<AntiSnipeSchedule>; hooks: HookAssessment[];
    existingPositionExits: PositionExitMeasurement[];
  };
  liquidity: {
    directionalDepth: DirectionalDepthMeasurement[]; headlineDepth2Usd: Metric<Decimal>;
    realReserves: Metric<AssetBalances>; positions: PositionAssessment[];
    removableDepthShare: Metric<Decimal>; lpStatus: Metric<LpStatus>;
  };
  supply: {
    minted: Metric<RawAmount>; total: Metric<RawAmount>; sinks: Metric<RawAmount>;
    locked: Metric<RawAmount>; curveInventory: Metric<RawAmount>; poolInventory: Metric<RawAmount>;
    circulating: Metric<RawAmount>; holderFloat: Metric<RawAmount>; burnedPct: Metric<Decimal>;
    fdvUsd: Metric<Decimal>; circulatingCapUsd: Metric<Decimal>; curveProgressPct: Metric<Decimal>;
    holders: Metric<number>; rawTop10: HolderUnit[]; controlTop10: HolderUnit[];
    top10RawPct: Metric<Decimal>; top10ControlPct: Metric<Decimal>;
  };
  holdings: {
    principal: PositionMetrics; operator: PositionMetrics;
    cohorts: CohortPositionMetrics[]; // insider_candidate/exempt/early/persistent/coordination/fresh
    principalOriginOverhang: Metric<PositionShares>; earlyOriginOverhang: Metric<PositionShares>;
    coordinatedLargest: Metric<PositionShares>; coordinatedUnion: Metric<PositionShares>;
    candidates: CoordinationCandidate[]; unresolvedFloatPct: Metric<Decimal>;
    fundingCoverage: Coverage; history: HistoryCoverage;
  };
  control: {
    powers: PowerAssessment[]; currentController: Metric<Address>;
    releasableByHorizon: Metric<RawAmount>; queuedChanges: QueuedChange[];
  };
  selling: {
    episodes: SaleEpisode[]; campaigns: CampaignMeasurement[];
    pressure: Metric<Decimal>; buyerOriginEstimate: Metric<QuoteAmounts>;
    creatorFees: Metric<QuoteAmounts>; outcomes: OutcomeV2[];
    lastHarmfulEvent: Metric<Hash>; recoveryAsOf: Metric<string>;
    oldSideLiquidOverhang: Metric<PositionShares>; takeoverEvidenceStatus: Metric<TakeoverStatus>;
  };
  flow: {
    windowSec: 300 | 3600 | 86400; buyUsd: Metric<Decimal>; grossVolumeUsd: Metric<Decimal>;
    netNewQuote: Metric<QuoteAmounts>; agentPct: Metric<Decimal>; declaredAgentPct: Metric<Decimal>;
    likelyAgentPct: Metric<Decimal>; crewPct: Metric<Decimal>; unclassifiedPct: Metric<Decimal>;
    rawActors: Metric<number>; economicActors: Metric<number>; classifiedVolumes: ClassifiedVolumes;
    purchasedHolderGrowth: Metric<number>; airdroppedHolderGrowth: Metric<number>;
    cyclingPct: Metric<Decimal>; beta: true;
  };
  text: { fields: UntrustedEvidence[]; instruction: Metric<ActionEnum>; scanCoverage: Coverage };
  verdict: GuardAssessmentV2; legacy: LegacyAssessmentRef | null;
  signal?: CoinSignalV2; spark8h?: Bar[]; change24hPct?: Metric<Decimal>;
  freshness: { cursor: Cursor; servedAt: string; snapshotAgeSec: number;
    launchAgeSec: Metric<Decimal>; oldestRequiredSectionAgeSec: number | null };
  evidence: EvidenceRefV2[];
}
```

Compound types have closed fields: `PositionShares={raw,liquid,locked,supplyPct,floatPct}`; `PositionMetrics` adds gross bought, sold, dispositions, market/all-in/realized multiples and basis coverage from §3.2; `CohortPositionMetrics` adds finite cohort ID/window/member IDs. `PowerAssessment` holds capability enum, tri-state Metric, authority/bound/delay/code evidence; `DirectionalDepthMeasurement` holds route/direction/2| 5| 10 discount/Metric USD/solver bounds. `PositionAssessment` holds PoolId, controller, custody, lock/release, reserves and removal coverage. `SaleEpisode/Campaign/OutcomeV2/HistoryCoverage` carry exactly §§3.3–5.2 quantities, intervals, responsibility/maturity/coverage and evidence, with statuses rather than untyped JSON. `ReceiptRefV2` is discriminated `recorded|anchored`, recorded has id/payloadHash only; anchored adds real root/batch/proof/tx. `EvidenceRefV2` has validated ID/kind/cursor/knownAt/payloadHash/internal object reference/supersedes. `FeeComponents` distinguishes total/ordinary/creator/temporary/hook/EKO/gas statuses, never all available by implication.

Registry IDs are every metric named in §§2–4 and card fields above (compound cohort/window keys validated), all §5 factor/decisive/check IDs and §6 reason codes. No arbitrary metric may affect scoring. Source/method/parameters/calibration changes are semantic-versioned; raw unsigned quantities and signed cash decimals have distinct validators. Ratios retain exact numerator/denominator; display decimal scale is 18, round-half-even, with scoring unrounded. Derived analytical decimals use the 36-digit method of §3.3 with error bounds. Empty arrays mean positively no applicable records only with coverage; otherwise unknown aggregate metrics expose absence.

### 7.2 Consumers, Signal and rollout

| Consumer contract | Required migration |
|---|---|
| CA-31 optional signal/spark 8h/change 24h/agent split | Preserve omission behavior; absent hides, never placeholder. V1 flow.humanPct keeps old meaning; V2 residual is unclassifiedPct with explicit method version. |
| CA-32 Feed / CA-33 RuleSignal | Typed `guardFactorId`/`guardReasonCode` optional fields; existing blockedBy union and user-origin signals preserved. Typed fields generate strings; never parse reason prose. Names/model/clone text remain Untrusted. |
| CA-34 masks / CA-35 lists | Project V2 missing states to V1 section/field availability. `unavailable` explicit, unavailable keys excluded from sorting. `verdictPending` true only before first record. |
| CA-36 totals | Server active-version totals across all live coins, primary lower/elevated/high/incomplete mutually exclusive; V1 aliases clear/monitor/danger/pending. High-with-gaps counts High plus separate incompleteCoverage count. Distinct evaluatedToday coins in UTC `[dayStart,nextDayStart)`, not rows. No source→unavailable, never page-local count/zero. |
| Radar/Pair/Alert/BagReport/WS/MCP/scan/badge/bots/OG/research/packs | Negotiate V2 fields and common copy. Preserve existing non-Signal verdict-based ranking with unavailable handling; Signal never ranks Radar. V1 legacy read/proof tests required. |

Signal v1/history uses original inputs/computation unchanged. Signal v2 keeps five numeric readings, beta, weights 30/25/20/15/10 [BE §7.7; C Signal], refresh at most once/15 seconds. **CALIBRATE adapter definition:** Risk=0 for High; otherwise if any tier gap/unknown required control, numeric 50 with lowData risk, rendered unavailable; else `max(0,100−25×isElevated−10×confirmedPowerCount−15×isRemovableLP)` counting tax-raise, blacklist, mint once each. Reason: band deduction once without losing existing power/LP inputs; verify schema, missing/high overlays and matched version fixtures. High overlays whole Signal/suppresses Hot; any completeness gap prevents Hot. Five numeric readings remain for compatibility; neutral 50 is not measured neutrality. Other four readings receive unchanged legacy measurement definitions or neutral/lowData when unavailable, not silently new float/depth/freshness values. Receipt input method versions and exact Guard receipt. No Signal→Guard/policy edge.

Start rules/identity/measurement/outcome at2.0.0, Signal separately 2; config, service/profile/calibration manifests hashed. Logical/threshold change bumps rules; denominator/measurement changes method; graph qualification identity; outcome label/maturity outcome. Cache key includes chain/token/full state cursor, availability cut, route/size/account, mode, all semantic/code/config/registry/profile/calibration hashes. A new source revision invalidates relevant dependents. Pure evaluator reads captured input only, no Date.now, RPC/API, current gas/vendor/registry or randomness.

Additive storage: chain observations/native ranges/role provenance owned by indexer; normalizer measurements/probes/profile/card state; playbooks factors/verdicts/outcomes/history and bounded episode queues; receipts service items/batches; review/evaluation artifacts evals-owned. Respect BE §3.2 single-writer tables and §21 bus IDs; new `guard.*` events are shared typed extensions, do not silently rename existing events. Expose chain/source watermark and revisions. Move legacy `code_templates` writes and per-exempt SQL out of loadSources. Schema additions for lots/checkpoints belong to their packets, not a single universal migration.

Early consumer/policy packets use fixture and real partial V2 cards with existing data; scores stay shadow. Structural mandatory refusal fixes can be feature-switched together after compatibility tests; do not label heuristics active before §9. At score release use one active manifest for API/cache/web/bots/policy, independently switch Signal only after its adapter checks. Preserve old receipts, genuine legacy labels and policy replay. Rollback selects previous released V2 config or critical-incomplete fallback; never resurrect rejected serial/exemption attribution as a supposed tested V2 result.

### 7.3 Receipt envelope and historical verification

`snapshotHash=keccak256(UTF8(JCS(deterministicInput)))`: full raw source references/metrics/status/coverage, cursor/availability, roles/lots, requested context and semantic hashes; excludes wall recording/serving time and recursive receipt metadata. `decisionHash` hashes snapshotHash plus factors/assignments/completeness/score/level/reason parameters. `payloadHash=keccak256(UTF8(JCS(versionedPublicPayload)))` includes those objects/hashes, actual recordedAt, mode and supersession; excludes receipt hash/proof/root/batch/anchor tx. Canonicalization `jcs-rfc8785/v1`. [BE §13]

Deduplicate identical derived keys: chain/token/blockHash/full cursor/mode/all versions/hashes/availability/sourceRevision. Same-key recomputation reuses receipt/id/recordedAt, adds an execution-run record only; new evidence/decision revision appends new item with supersedes. Allocate immutable receipt ID before canonical payload serialization. Orphans append status events, never mutate original payload/grade. Original payload verification is independent of newly formatted responses.

Existing leaf exactly `keccak256(keccak256(abi.encode(uint8(kind),bytes32(itemId),bytes32(payloadHash))))`, kind 0 verdict,1 forecast,2 harness-private unchanged; `itemId=keccak256(UTF8(Receipt.id))`. Five-minute/300-second batching; batch ID only from committed registry event. Recorded/unanchored never invents root/tx; V1 receipt reference preserves its existing pending-anchor shape. Shared V1/V2 fixtures load in browser verifier, TS committer and Foundry tests; no new registry contract needed. Anchoring proves inclusion, not truth/risk assurance. [BE §13]

Public payloads/proofs/normalized summaries/digests persist forever; full simulation traces 2,592,000 seconds [BE §6.2]. Expiry response names absent full trace; digest alone cannot regenerate it. Retain normalized replay inputs/checkpoints, pinned code/config/dataset/review/calibration artifacts for reproducibility. Large objects content-addressed with internal retrieval proofs, not mutable arbitrary URLs. No unrelated account credentials/private data/personal identifiers in public payloads.

## 8. Data requirements, achievable coverage and cost

### 8.1 Today and first-release acquisition

F:200,000 blocks≈5.6h;2,475 Pons launches;113,430 curve trades;≈405,000 swaps;2,683 non-Pons tokens with unknown deployer. Live sender enrichment only Pons, native transfers unindexed. Current card explicitly lacks simulation/depth/control coverage; placeholder zeros are masked structure, never observations. `evaluatedPlaybooks` is not check completion. Old 268 serial-driven Danger results are not calibration labels.

| Input | Cheapest sufficient work | Until available |
|---|---|---|
| Basic bags/dispositions | Existing token Transfer/swaps/exemptions; validate direct Pons recipients/senders, reconcile current supply | Actual known facts now, complex actor/origin/float gaps named |
| Exit/taxes/profile | Verified local Pons math, pinned code/config and sampled deterministic forks; anomaly/actual-order forks asynchronously | Critical-incomplete until validated observations exist |
| Complex principal/service | Cache input/receipts/block traces once, decode per operation, no per-token repeat trace | Lower-tier unresolved role, no service history |
| Native funding | Verified address-indexed external/internal successful transfer source with interval paging | Lower-tier missing; Balanced/Degen can use Elevated within limits |
| Quote funding | Address/topic-filtered ERC-20 Transfer plus settlement/wrap reconciliation | Quote coverage separate from native gas/internal coverage |
| Graduation/v4/locks | Observed migration fixtures, per-PoolId tick/settlement/custody adapter, alternate routes | Unsupported current float/exit is buy-critical, quote-only if execution unavailable |
| History | Metadata launch enumeration, complete selective prior operator outcomes | No booster; lower-tier gap unless no eligible history positively proved |

First-release native adapter requires **verified address-indexed history covering both successful external and internal native transfers**. Blockscout is a candidate, not a known usable complete feed; supplied spec records Cloudflare/API-key constraint. Capability-test interval start/end, pagination termination, missing pages, failed/reverted frames, timestamps/order/amounts and known funding-only transactions. Indexed provider price and 4663 endpoint coverage are unknown. Address pages locate transactions; cached supported traces confirm material paths. Swap-only tracing cannot discover funding-only transactions. First-ever pagination to genesis/proved creation boundary is optional and separately metered.

Without usable indexed history, a **shared union-of-interval block-trace diagnostic pilot only** can collect partial data. It cannot promise live funding completion. CF §5b verifies dRPC archive, debug_traceCall overrides, eth_getBlockReceipts, debug_traceBlockByNumber(callTracer),100k log ranges; trace_filter/trace_block unavailable. Capability-test whether block trace includes successful top-level and internal value; otherwise additional transaction/receipt status required. Full transactions alone miss internals and failed transfers must be filtered. Public historical/debug availability is not established; archive work uses verified paid/local path. Never scan the same interval once per wallet.

Candidate funding starts six hours pre-buy, 24h material-path sensitivity; post-sale collection through cursor up to24h, seven-day recycle context only selectively. No future sweep in live graph. Queue sellability first, aggregate holder/early/late candidates second, historical boost last. Shared address/range/block cache and metered hop limits. Funder/collector degree jobs count in same budget. Lack of source/cap creates lower-tier gap, not zero links. No complete native/coordination coverage is promised at these caps.

Local Pons math yields cheap effective reference checks only after matched fork/profile gates. Reuse immutable template/config validation and reconstruct touched state locally; new hook/config/anomaly invalidates. Do not remote-probe every launch×delay×size×class. Actual order-size/account verification stays required; quote miss queues worker and returns named denial. Neutral local math cannot certify arbitrary account-specific code.

### 8.2 Budget arithmetic and pilot limits

At F's measured 10 blocks/s:864,000/day;6,048,000/week;25,920,000/30 days. Price nominal requestUnits×$6/1,000,000 [F]; confirm dashboard units/method/batch subrequests and count retries/Anvil upstream archive calls. Public sustains≈5–6 starts/s;12/s throttled/non-JSON. **CALIBRATE shared free limiter** start 3 request starts/s, reserve below measured ceiling, adjust on pilot latency/error data. Paid throughput separately measured.

| Work | Nominal units | Paid marginal cost | Comparison at5 starts/s |
|---|---:|---:|---:|
| One-day trace OR full-block method | 864,000 | $5.184 | 48h |
| One-day full blocks AND traces | 1,728,000 | $10.368 | 96h |
| Six-hour shared native trace interval | 216,000 | $1.296 | 12h |
| Thirty-day one-method scan | 25,920,000 | $155.52 | 60 days |
| Thirty-day blocks+traces | 51,840,000 | $311.04 | 120 days |
| 100,000 selected block traces | 100,000 | $0.60 | 5h33m20s |
| First enrichment checkpoint | 250,000 | $1.50 | 13h53m20s |
| 21-day logs, one query group at100k spans | 182 | $0.001092 | 36.4s lower bound |
| Same at2k spans | 9,072 | $0.054432 | 30m14.4s lower bound |
| 600 tokens×8 paths×entry+fixed exit | 9,600 valuations | $0.0576 if one RPC each | 32m floor only |

No unsupported 82m genesis height estimate. At measured height H, one-method genesis cost=H×$0.000006, time=H/5 seconds; attach measurement time if ever used. Log costs are lower bounds per actual topic/address group, not total backfill price: sum ceil(range/span)×batches plus splits/retries/receipts/config/actors/funding/fork calls. Eight illustrative 21-day groups cost$0.008736 at100k or$0.435456 at2k before those additions.

**CALIBRATE proposed incremental caps:** $1/day Guard enrichment plus$10 initial backfill/calibration,250k-unit checkpoint, separate from F's≈$0.50/day baseline. Reason: measure candidate/local paths before any whole-chain approach; owner must record approval before paid jobs/subscriptions run (§11). Until then existing capped data and local fixtures only. At$1 nominal 166,666 units buy<4.63h of chain block traces/day with nothing else; dense candidates' overlapping six-hour intervals approach whole-day coverage. Thus complete RPC-only live funding is infeasible under this cap. Actual trace weighting/latency may worsen it.

At observed density extrapolated 10,692 launches/day,4 checkpoints×2 sizes×2 classes=171,072 probe jobs/day, already $1.026432 even at one upstream call/job; real forks need more. This is a stress projection, not forecast. Local verified math/template tests, on-demand/anomaly jobs and explicit gaps are necessary. The same sample implies≈1.75m swaps/day, not a reason to retain all 30 days in memory. Report API pages/subscription, RPC confirmations/traces, compute/storage and 1,200 human reviews separately; indexer page requests do not inherit RPC price.

F's17m/200k replay extrapolates 8.568h/week or36.72h/30 days, excluding new work. No throughput/calibration completion promise. At cap stop new optional/enrichment/backfill requests, retain cursors and named coverage; keep existing critical ingest within baseline budget. Never relax completeness to hit spend.

### 8.3 Calibration history and exact calendar frame

1. Use existing 200k pilot for arithmetic, acquisition/resume/cost and boundary state fixtures. It supplies no seven-day accuracy. Capability/coverage pilot precedes funding graph production work.
2. Freeze a14-day launch cohort `[D,D+14d)`, development `[D,D+7d)`, locked test `[D+7d,D+14d)`, observations through `D+21d` for seven-day outcomes. Use archive only if coverage is verified; otherwise prospective 14+7 days. D is chosen before labels are inspected. `d=86400 seconds` here, UTC cutoffs.
3. Within development use fitting `[D,D+4d)` and validation `[D+4d,D+7d)` with 3900-second purge before both validation/test boundaries (max 300 entry delay+3600 primary exit). Group repeated operators/accepted or suspected components crossing boundary into held-out grouping; remove their earlier examples from fitting. Record actual remaining sample. Seven-day outcomes are sensitivity only; fitting them needs separate 604800-second purges and an expanded nonempty frame, not the same short cohort.
4. Cheaply enumerate all indexed launch metadata over the frame and proposed 30-day context; fully reconstruct only 600 sampled tokens, matched markets and incident/negative controls from each creation, plus follow-up. Read boundary state once and apply validated events incrementally. Enrich sampled non-Pons sender paths on demand. Bound first historical pilot to seven days of selected-token reconstruction consistent with CF §5b, then expand only under approved budget and measured coverage.
5. Funding warm-up starts D−1d for 24h paths; seven-day recycling candidates need selective source history toD−7d. First-ever age remains optional. No indexed native source→recent clusters unresolved, shadow available execution/concentration, no guessed links.
6. Baseline calibration keeps booster disabled unless its separate complete study passes. For full 30-day history at earliest D, enumerate toD−30d and assess every selected operator's eligible launch known by each feature cursor. Cohort+follow-up spans 51 calendar days of availability, not a30-day backfill. History gaps keep Lower-tier missing even when baseline execution factors can promote; cannot claim a fully checked Lower cohort from a disabled/unknown history source.

Persist range/source/availability manifests, adaptive log batching, selected boundary headers (logs already timestamped), storage/memory/wall-time/cost and checkpoint ownership. Avoid full-engine every-block replay; no empty-block timestamp fetch loops. New cross-chain support needs distinct venue/account/depth/float adapters and its own calibration; 4663 cuts are not calibrated Solana/Base/Hyperliquid/HyperEVM facts. [R1]

### 8.4 Incremental computation and performance

Update touched token supply/reserves/holder order indexes/FIFO lots/cohort sums/config, wallet/group cash/episode/cycling deques and expirations. Keep reverse wallet→token dependencies; recompute only affected graph components on merge/split/reorg. Chain-time timer queue handles no-trade expiry, maturity/probe checkpoints and checkpoint resume. No full holder ranking, historical liquidity scan or per-exempt history SQL each verdict. Counterfactual/real-buyer valuation is queued selected work, not synchronous rule input acquisition. Store immutable normalized observations then evaluate/cache/receipt.

`evaluateGuard` pure cached arithmetic only, zero RPC/SQL/API/search/forks. The supplied [C2 feasibility review](reviews/review-C2.md#5-engine-throughput-and-what-must-be-incremental) records a replay reference of approximately 170 evaluations/s, implying approximately 5.88ms average cached budget; target on same frozen 200k data/source revision, not current proof of expanded performance. **CALIBRATE throughput target** ≥170/s, bounded memory on large-holder/hot tokens, deterministic resume. Head p95≤1s, fast scan≤5s and cached preflight<150ms are existing BE targets; report full required-check completion/queue latency separately from returning an incomplete result quickly. Narrow measured live schedule or keep unsupported observations missing if gates fail; no false completion. Actual quote path uses BE's separate latency budget, measured with upstream spend.

## 9. Calibration and evaluation

### 9.1 Buyer benchmark and paired target

**CALIBRATE benchmark starts:** entry delays 5/30/60/300 seconds after launch, independent $100/$1k ordinary EOA and supported contract-class trajectories; first completed block state at/after delay, exact account/route/config/cursor recorded. Sizes come from BE; delays test early and later participation without imaginary creation-tx access. Primary entrant is 60 seconds, each size separately; primary fixed exit 3600 seconds after entry. Alternative fixed 300/86400-second exits and−30% stop/+50% take-profit checked every 60 seconds plus relevant sell/control/graduation boundaries, mandatory 3600 exit, are sensitivities. Reason: simple reproducible buyer exposure; validate delay/exit sensitivity, never optimize strategy on test.

At exit time attempt the first scheduled completed state at/after deadline. Do not advance until conditions improve. First token-caused exit failure counts and remains; optional retry sensitivity every 60 seconds through 300-second retry deadline records all attempts, never replaces primary failure. Data/provider gaps censored; entry failure is entry_unavailable, not 100% invested loss. Actual no-exit proceeds zero only when proved; signed cash proceeds after gas can be negative.

`returnPct=100×(netExitQuoteUsd−allInEntryUsd)/allInEntryUsd` with positive entry cost. Report quote-unit return to separate external quote USD movement; never put unrelated quote volatility into operator adverse history. **CALIBRATE severely hurt:** return≤−30% or verified inability to exit at valid scheduled checkpoint. Reason: substantial economic harm; review loss−10/−50/−90% sensitivities, current irreversible cost and exitability separately from future loss. Predictor is released/candidate verdict using evidence available at the matching entry cursor. A later verdict or other size's success cannot mask that entrant.

Paper approximation clones observed entry state, computes acquired quantity including entry impact, discards synthetic reserve change and later values quantity on observed states. Retain purchase-dependent wallet state for delayed restriction tests; balance override alone insufficient. Persistent-entry-impact replay and eligible real-buyer FIFO outcomes are independent checks. Invalid later transaction under retained synthetic impact is indeterminate, not silently skipped.

**CALIBRATE fidelity gate:** positive net proceeds relative error≤1%, no hurt/not-hurt reversals in≥30 diverse matched supported cases per venue/size/account class; expand thin/cooldown/restriction cases. Arithmetic/actor/denominator/returned-amount errors have zero tolerance. Paper paths do not qualify band gates before this passes. If persistent replay invalid and no matched real path, no release truth for that path; report missing coverage. One-next-observed-block execution stress includes latency sensitivity without subsecond fill claims.

Optional half-agents token aggregation may be reported only with explicit prediction aggregate; it cannot replace primary paired units `(token,60,size,class)`. Confidence/splits cluster repeated paths by token/operator, not eight independent coins.

### 9.2 Intervention and outcome truth

Replay sale interval from exact pre-campaign state; remove only identified economic sells and inherent transfers for **sell-only** test; preserve all other traders' original exact-input amounts, limits, deadlines, time, fee config, migrations, balances and exogenous quote prices. Separately labeled net-trading test removes buys+sells. Do not remove an inconvenient later invalid transaction. Mandatory remaining failure, negative balance, unsupported hook/route/feedback or unpriced basis makes intervention indeterminate.

`contributionPp=counterfactualCohortReturn−actualCohortReturn` under the same cost/proceeds definitions. Fixed external order-flow counterfactual is mechanical, not proof of intent or actual behavioral causality. Conservation/replay fidelity and sufficient real-buyer coverage in §4.2 must pass before own-side harm. Human alternative adjudication has method/version and independent precision report; it cannot fill absent machine evidence as if the same method passed.

Negative controls include burns/locks/creator fee claims, unsold gifts/CEX deposits, independently selling gift recipients, shared launches/UserOps/sponsors, CEX/common old/dust gas funding, arbitrage/MM, tiny profit, healthy organic early audiences, normal graduation, outsiders' declines and community recovery. Include the full C1 L01–L18/E01–E20 fixtures and correlation counterexample; record detection time, attribution versus observable exposure and unassessed paths.

### 9.3 Human set, sampling and comparator questions

**CALIBRATE initial 600 distinct-token probability sample**, chosen for workload/base-rate/rare-mechanism review; two independent chain-literate reviewers plus adjudicator, 1,200 judgments before disputes. Construct disjoint eligibility strata by priority: verified sizable operator/linked sales; restrictions/thin/removable/hook; non-operator sniping/coordination; legacy clone/exempt/serial Danger; remainder. Population frame includes all enumerated tokens, no exclusion by current verdict. Freeze member lists/query/version/seed before labels.

Draw uniformly without replacement inside the five disjoint strata: 100 sale cases, 75 restriction/thin/removal/hook cases, 75 non-operator sniping/coordination cases, 100 legacy-trigger cases and 250 remainder cases. This is a stratified probability sample, not a uniform whole-chain sample. Before drawing, set `n_h=min(target_h,N_h)`; redistribute vacancies first to available remainder capacity, then to the other strata in the priority order above until total 600. Freeze final counts before labels. If the whole frame has fewer than 600 tokens, take all and report the smaller frame. Each token has inclusion probability `n_h/N_h`; weighting recovers population estimates. No duplicate can occur across disjoint strata. Any later expansion uses a new declared probability design rather than silent top-up. Purposive hard-negative/incident extras are separate challenge data with unknown population probability, never mixed into prevalence estimates. Reason for the adapted allocation: preserve B's workload and difficult cases while making probabilities exact; validate stratum assignment and weighted estimates on synthetic population fixtures.

Review facts/roles, coverage, buyer harm, current risk mechanism, seller control/origin, withdrawal/migration, outcome maturity and reason support. Hide points/new/legacy levels, alleged incident labels and other reviewer's answer until first submission. Evidence IDs required, unresolved valid; preserve original labels/adjudication, reviewer pseudonymous IDs and label versions. Rule author cannot be sole independent sign-off. No invented human judgments in an engineer coding packet.

At least 100 matched tool snapshots, **CALIBRATE workload** to expose denominator/role gaps: exact token/chain/time/size/route and supply conventions, gross versus held, before versus after graduation. R3 documents GMGN/GoPlus/Codex/DexScreener/Bubblemaps coverage with limits; T GMGN fields, CF ScanHood. Verify exact endpoint/historical capability, no claim from generic support. GoPlus v4/Pons execution unverified; Axiom/RugCheck/TrenchBot do not have established 4663 parity here. T/B's 27–41% never-bought warning is sample-specific indexing evidence, not chain correction factor.

Blinded reviewers answer: who holds original/descendant bags; who sells now; what this account/size can exit; how independent the audience is established/unknown; which capital paths recycle; changes within horizon; old failure/current recovery; identity/promotion provenance; source freshness/excluded mass. Compare EKO, each available comparator and raw receipts for errors, unanswerable fraction and time. **CALIBRATE parity gate:** zero critical denominator/role omission errors, EKO unanswerable fraction no worse on supported matched fields; set response-time/coverage target from pilot before held-out run. No universal superiority claim.

53-launch incident remains separately held-out challenge: obtain verified full address/tx manifest before reconstruction, never extrapolate abbreviated addresses or private keys. Reproduce funder→batch→sales→collector→next-funder, current held versus initial capture, actual cash receipts. Categories 45/4/4 may overlap; reported $18.43m is an allegation, not independently reconciled extracted cash. Missing manifest/archive coverage→unreproduced, not labeled positive. F's four actor cases/tiny-profit synthetic remain explicit controls, not fabricated incident members.

### 9.4 Parameters, splits and release gates

Every unsourced parameter has registry fields `id,value/formula,unit,operator,reason,source/method,truth/comparator,fitGrid,gate,status`. This table fixes the method for all candidates above:

| Parameter group | Calibration method |
|---|---|
| Score/points/compatibility | Finite grid bands lower 25/30/35 and high 55/60/65, factor weights base/±20% rounded to integer nearest (half upward), family-max and allocation ablations. Validate independent mechanisms/current versus future exposure. |
| Funding/service/hub/airdrop/coverage | Review authenticated roles, material sweeps versus dust/services; coordination 10/30/60/120s, recent funding 1/6/24h, collection 1/24h, recycle 1/7d, dominance 50/90% leads; strict control precision and fragmented-holder missed-mass tests. Screens produce candidates/unknown, not guilt. |
| Early/persistent/fresh/origin | Keep vendor-comparable 5s and 2h tags fixed; adapted origin/persistent definitions require full recurrence and transfer conservation. Organic audience/gift/broad distribution negatives. |
| Supply/FIFO/reserve-origin/pressure | Hand reconciliation, exact venue deltas, FIFO/proportional reversal audit, fixed-point error bounds; method approval before predictive fitting. Bucket estimator stays optional until conservation. |
| Exit/depth/USD/profile/horizon | Matched local/fork/actual execution≤1% gate; boundaries 5/10/25/50, entry caps, gas/L1, unknown cooldown, alternate routes, virtual reserves, locks and queued actions. No monotonic solver without proof. |
| Pressure/dump/harm/withdrawal | Reviewed real-buyer losses/basis, size/reserve scaling, 60/300s episodes and 1h/24h campaigns; materiality OR branches,−30%/10pp and coverage 90% fitted on development only. Outcome truth freeze precedes score fit. |
| Cycling/clone/text/context | MM/arbitrage/negation/truncation tests, actual volume/onset/role/flow reconciliation; clone 0 by design. Instruction target+action classifier needs≥95% precision before I points. |
| History | B integer booster/window/completeness, one-hour primary versus 24h/7d delayed bleed; operator-held-out ablation, no selective outcomes or unrelated bots/services. Booster independently accepted, not required enabled for baseline. |
| Benchmark/sample/bootstrap/ops | Delay/size/horizon/cash sensitivity, actual draw probabilities, clustered interval stability; stale/reorg/spend/time-to-completeness. Resource limits are owner policy; never fit missing-data semantics away. |

Freeze §8.3 dates, group assignments, availability and primary truths before test inspection. Within development use fitting then purged validation; select only on validation, simplest fewest enabled heuristic factors meeting gates, then highest High precision, then High-only recall, then minimum absolute deviation from starting parameters, then parameters hash ascending. Held-out test once per frozen candidate. Failure→shadow or revised development plus a new untouched test cohort, no retuning on the same test. Seven-day fitting demands expanded purged cohorts; seven-day sensitivity can be reported without influencing selection.

All numerical release targets below are **CALIBRATE** policy starts, except existing BE 90% precision/p95 contracts as cited; they are not achieved claims. Reason: false High refusals and false own-side blame warrant strong precision, Lower needs bounded residual harm, recall prevents selective easy wins. Seed 2,000 operator/component bootstrap resamples at 95%, respecting inclusion weights and all correlated token paths; fallback unresolved token groups conservatively combined/sensitivity-reported. Verify stability around decision bounds. Wilson 95% only for declared unweighted independent binary audit, never weighted correlated entries.

| Gate | Starting acceptance |
|---|---|
| Deterministic facts/contracts | Zero known arithmetic/denominator/role/provenance errors in accepted fixtures; all 38 C1 scenarios, two-tier/null/Safe/High invariants, legacy proof/shape, Untrusted and no-lookahead checks pass. |
| Measurement fidelity | §9.1≤1%/no harm reversal, ≥30 diverse supported cases per venue/size/class; unsupported cases explicit. |
| High future severe-harm precision | Weighted≥90%,95% lower CI≥85%; ≥100 distinct known-outcome High predictions in untouched test **per primary size/account cohort**, not combined development count. Factual blocked-exit/current-cost/capability precision reported separately; no false prediction claim for a capability alone. |
| Severe-harm recall | Elevated-or-High≥85%, lower CI≥75%; High-only≥50%; ≥100 hurt distinct test coins per primary size/account cohort. Incomplete not counted prediction success; separately operational blocked/refusal results. |
| Lower severe-harm rate | ≤10%,95% upper CI≤15%, ≥100 fully checked known-outcome Lower test coins per primary size/account cohort; no critical restriction missed Lower. Adjacent complete bands monotonically ordered and distinguishable under intervals before meaningful separation claimed. No Lower deployment when its coverage sample cannot exist. This does not block a narrower accepted release of confirmed High facts and Elevated with named gaps; its manifest must disable Lower and unaccepted heuristics. |
| Attribution/control/history | Reviewed precision≥95%, lower CI≥90%, ≥100 reviewed held-out positive assertions across≥30 independent components including services/bots/dust/gifts. Edge/outcome/history ablations separately; count each launch once. |
| Critical restrictions | 100% detection on supported reproduced restriction/seizure fixtures and≥95% recall on reviewed real supported restrictions; unknown coverage recorded as omission. |
| Instruction classifier | ≥95% reviewed precision including quoted/negated cases; zero policy/execution influence in adversarial tests; points alone cannot reach Elevated/High. |
| Per-factor promotion | Factual condition passes invariant/review gate; heuristic ablation improves recall/exposure discrimination without breaking whole-band/attribution gates. No 80% factual-accuracy permission. |
| Operational readiness | Same frozen 200k cached≥170/s target, zero RPC evaluator, bounded memory/resume; preflight p95 <150 ms; spend≤approved cap. Report scan/enrichment/probe/attribution queue latency and p95 alert/time-to-critical/lower-completion by age/venue, total false-refusal/censoring; freeze feasible coverage/latency operating target from pilot before test, never count fast missing result as completed scan. |

Report all enumerated tokens/entries, known outcomes, entry failure, provider censoring, missing tier causes, exposure/current-cost precision and precision/recall conditional on assessed data. Report policy allow/deny outcomes per mode separately; missing funding floor Elevated is neither detected harm nor complete evidence. High severity on one class/size is visible; validate that triggering slice, not a pooled average.

Live frozen shadow minimum 604800 seconds **and** 5,000 launches, whichever longer (**CALIBRATE** weekly workload/reason); follow late launches through their required horizons and confirmation. Record source revision, dataset/config/label hashes, commands, complete gate outputs and cost/checkpoints. It cannot affect orders/published active badge. Unsupported or failed heuristics stay shadow; active manifest contains only accepted factors and supported checks. Production release follows existing authorized repository process; preparing a switch is not deployment.

### 9.5 Monthly review

Use calendar UTC months `[monthStart,nextMonthStart)`, evaluate after required outcome follow-up. **CALIBRATE maintenance sample 200** newly stratified coins plus incident/negative controls, chosen for manageable drift workload; expand if intervals/regime changes demand. New hooks/services, aged wallets, staggered buys, dispersal, delayed collectors and slow campaigns reviewed. Any parameter/method/config change gets version/hash and development/validation/new held-out evidence; no online optimizer auto-promotes. Failing coverage makes corresponding gap visible; a deteriorating heuristic returns to shadow, no unsupported lowest-risk fallback. Keep old artifacts and append reason for each change.

## 10. Ordered build packets

This folder contains reference snapshots, not the application repository. Execute packets in the actual TypeScript/pnpm workspace, following its conventions/table ownership and release process. A coding session ends with a bounded tested diff or concrete unavailable result; human review, paid source approval, long jobs and elapsed follow-up are separate completion signals. Earlier packets can consume unknown inputs and synthetic valid fixtures without pretending missing data exists. Every report names changed files, exact commands/exit codes, remaining issue/reproduction and source/candidate revision; data packets also calls/cost/coverage/checkpoint. No deploy, commit or paid subscription is implied by this design.

Task files and dependencies are the normative implementation plan. §11 decisions do not block existing-data/pure/shadow/UI work. Optional reserve-origin research is not a release dependency.

| Packet | Dependencies |
|---|---|
| [026 · Guard contracts, levels and parameter registry](../tasks/026-contracts.md) | — |
| [027 · Versioned evidence and coverage storage](../tasks/027-evidence-storage.md) | 026 |
| [028 · Mandatory buyer-level policy adapter](../tasks/028-policy-levels.md) | 026, 027 |
| [029 · Existing-data launch roles and partial identity](../tasks/029-launch-roles.md) | 026, 027 |
| [030 · Pons supply and address holding reconciliation](../tasks/030-supply-basics.md) | 027, 029 |
| [031 · Swap, transfer and attributed cohort metrics](../tasks/031-lot-metrics.md) | 029, 030 |
| [032 · Pure attributed history booster](../tasks/032-history-booster.md) | 026, 029, 031 |
| [033 · Pure family scoring, tiers and shadow reasons](../tasks/033-shadow-scoring.md) | 026, 028, 030, 031, 032 |
| [034 · Raw-hash receipts and proof compatibility](../tasks/034-receipt-compatibility.md) | 027, 033 |
| [035 · V2 coin card projection and evidence reasons](../tasks/035-card-api.md) | 026, 029, 030, 031, 033, 034 |
| [036 · Web levels, completeness and metric rows](../tasks/036-web-levels.md) | 028, 035 |
| [037 · Lists, Feed, bots and shared copy adapters](../tasks/037-compact-consumers.md) | 035, 036 |
| [038 · Separately versioned Signal input adapter](../tasks/038-signal-adapter.md) | 026, 035 |
| [039 · Pinned Pons effective control and fee profiles](../tasks/039-control-profiles.md) | 027, 029, 035 |
| [040 · Isolated Pons reference exit execution](../tasks/040-exit-simulation.md) | 030, 031, 039 |
| [041 · Local directional depth and route bounds](../tasks/041-directional-depth.md) | 039, 040 |
| [042 · Observed graduation and per-pool custody adapter](../tasks/042-graduation-inventory.md) | 030, 039, 040, 041 |
| [043 · Trace binding, delegation and services](../tasks/043-trace-principals.md) | 027, 029, 031 |
| [044 · Native and quote funding acquisition capability](../tasks/044-funding-capability.md) | 027, 031, 043 |
| [045 · Existing-window acquisition and coverage pilot](../tasks/045-coverage-pilot.md) | 040, 043, 044 |
| [046 · Qualified control and coordination graph functions](../tasks/046-qualified-graphs.md) | 031, 043, 044, 045 |
| [047 · Group holder metrics and aggregate coverage](../tasks/047-grouped-coverage.md) | 030, 031, 046 |
| [048 · Resumable logs-first selective backfill runner](../tasks/048-selective-backfill.md) | 027, 045, 047 |
| [049 · Sale campaign state and mechanical replay](../tasks/049-campaign-replay.md) | 031, 040, 041, 042, 046 |
| [050 · Optional proportional reserve-origin research](../tasks/050-reserve-origin.md) | 031, 042, 049 |
| [051 · Maturity queue and independent outcome labels](../tasks/051-outcome-labels.md) | 040, 042, 049 |
| [052 · Actual-account quote and execution revalidation](../tasks/052-actual-order-binding.md) | 028, 034, 040, 041, 042 |
| [053 · Incremental queues and frozen-window throughput](../tasks/053-incremental-performance.md) | 033, 047, 049, 051, 052 |
| [054 · Fixed-delay buyer benchmark runner](../tasks/054-buyer-benchmark.md) | 040, 041, 042, 048, 049, 051 |
| [055 · Immutable independent review API](../tasks/055-review-api.md) | 027, 035, 051, 054 |
| [056 · Finite blinded evidence review page](../tasks/056-review-page.md) | 035, 049, 054, 055 |
| [057 · Probability sample and matched-source importer](../tasks/057-sampling-and-incidents.md) | 048, 054, 055, 056 |
| [058 · Freeze cohort and start bounded data run](../tasks/058-acquisition-run.md) | 045, 048, 054, 057 |
| [059 · Independent labels and adjudication import](../tasks/059-label-completion.md) | 055, 056, 057, 058 |
| [060 · Development fitting and frozen candidate](../tasks/060-development-fit.md) | 053, 054, 058, 059 |
| [061 · Locked evaluation and acceptance report](../tasks/061-locked-test.md) | 060 |
| [062 · Frozen live shadow runner and report](../tasks/062-live-shadow.md) | 061 |
| [063 · Concrete cutover and rollback preparation](../tasks/063-cutover.md) | 037, 038, 052, 061, 062 |
| [064 · Calendar-month evaluation job and runbook](../tasks/064-monthly-evaluation.md) | 063 |

## 11. Owner decisions

Only resource and independent-human choices remain. See [owner-decisions.md](owner-decisions.md).

1. Recommend approve a metered$1/day incremental Guard RPC cap and$10 initial pilot/backfill cap,250k-call checkpoint, separate from baseline; indexed native source subscription requires its own verified coverage/price decision. Until recorded, no new paid jobs or subscriptions; local/current data work proceeds, funding/history remain named lower-tier gaps.
2. Recommend assign two independent chain-literate reviewers plus an adjudicator and an accountable release sign-off role. Until assigned, build blinded workflow/synthetic fixtures and shadow jobs, but no invented independent labels or release-gate completion.

Names, High denial, Safe Elevated denial, tier behavior and booster-only attribution are already binding. Thresholds/methods are specified candidates to calibrate, not owner preference questions. No launch date can substitute for acceptance evidence.
