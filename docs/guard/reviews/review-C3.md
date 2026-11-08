# C3 — precision, sources and compliance

Neither draft is ready to be the implementation contract. Use B's existing wire levels and separation of control from coordination, A's explicit versioned evidence/coverage and receipt handling, and the corrections below. Scoring numbers remain shadow candidates; neither document establishes calibrated thresholds on 4663.

Reviewed `brief.md`, the facts/requirements, all six research files, FACTS, BACKEND §§6–7 and §23 (plus the referenced policy/receipt provisions), FRONTEND copy/security rules, both complete drafts and the supplied code. This is an offline source audit: linked external pages were not fetched. Locations below refer to draft line numbers. **P0** blocks correctness/compliance; **P1** leaves a material implementation or evaluation decision unspecified; **P2** is a source/copy correction. Replacement passages are proposed contract text, not claims that implementation or validation exists.

## 1. Source audit: unsupported or incorrectly attributed details

Broad CALIBRATE introductions cover many score and link candidates, but do not cure incorrect descriptions of a published method. Apply these corrections even where the surrounding section is CALIBRATE.

| Finding and location | What the supplied source actually establishes | Exact correction / choice |
|---|---|---|
| **P1 — B 270: “Mazorra ... 99% withdrawal.”** | `research-academic.md`, Cernera and Huynh: exactly one Mint/Burn and ≥99% **minted LP tokens** removed in a V2-specific sample. Mazorra: fully withdrawn liquidity/no recovery/inactivity, or ≥90% price drawdown with additional conditions. | Replace with: “Cernera and Huynh use ≥99% of minted LP tokens removed under specific V2 Mint/Burn and lifetime conditions [A, those papers]. EKO's inventory-value/depth test is a CALIBRATE adaptation, not their LP-token rule.” Keep B's distinction between withdrawal and migration, not this citation. |
| **P2 — B 270: material pool-death rule attributed to GMGN contract-DD.** | T 43–47 records it under **gmgn-dev-score/scoring.md**, including a nonzero token amount and dead-pool condition; R2 contract-DD is a different method. | Replace with: “GMGN's dev-score skill requires nonzero token removal, ≥0.5% of supply or $500, and a dead pool [T, gmgn-dev-score/scoring.md].” EKO's own rule must remain CALIBRATE. |
| **P1 — B 464: “82m-block genesis ... per R3 estimate.”** | R3 has no such estimate. BACKEND §4.3 records height 75,219,607 on September 28, not an October 2 height. | Delete the 82m row. Replace with: “For measured height H, one full-block request per height costs H × $6/1,000,000 and takes H/5 seconds at 5 requests/s; store the height and measurement time.” A's bounded cost table is preferable. |
| **P2 — B 538: R3's “27–41% never bought.”** | That observation is in T 66–69 and B-research 35–38, reported by GMGN's holder-analysis skill, not R3. | Replace with: “T and bundle research report GMGN's 27–41% ‘never bought’ observation on Robinhood examples; it is a sample-specific indexing warning, not a chain-wide correction factor.” |
| **P2 — B 447: R3 verifies dRPC tracing.** | Verification of `debug_traceBlockByNumber`, archive state and unavailable `trace_filter`/`trace_block` is in **FACTS §5b**. R3 describes raw access, not an executed dRPC capability test. | Replace source with “FACTS §5b, on-chain/provider checks recorded October 1.” Keep A 447's attribution. |
| **P2 — B 536: R3 lists GMGN “and its API” and ScanHood coverage.** | R3 lists GMGN UI/guide, GoPlus, Codex.io, DexScreener, Bubblemaps and raw data providers. It does not verify the claimed GMGN API endpoint or ScanHood method. FACTS names ScanHood; T describes GMGN fields. | Replace with: “R3 documents GMGN, GoPlus, Codex.io, DexScreener and Bubblemaps coverage with stated limitations. T describes GMGN fields; FACTS names ScanHood. Verify each specific endpoint and historical snapshot capability before using it.” |
| **P1 — B 182: cash-out multiple including launch cost/gas called GMGN's definition, without CALIBRATE.** | T establishes ≥1.5× cash-out/cash-in and ≤30s, but supplies no exact gas/launch-cost denominator. | Use the two explicitly separate multiples in finding 8 below. Keep A's market-only cash-in/out basis; do not call either denominator verified GMGN accounting. |
| **P1 — A 130 and B 130: persistent sniper uses 90% of “first purchases.”** | Ready, Aim, Snipe uses ≥90% of **all buys** within five blocks over ≥5 pools. It is not first-buy-per-token share. The seconds conversion is already marked CALIBRATE; the denominator change must be explicit too. | Replace with: “CALIBRATE persistent-sniper adaptation: over a trailing 2,592,000 seconds, earlyBuyCount/allBuyCount ≥0.90 and buys in at least five distinct launches. Early means the five-second first-trade window. Partial history → unknown. Validate against reviewed bot activity; this is not operator attribution.” Keep A's explicit lookback, with corrected denominator. |
| **P1 — A 130: first tradable event substitutes for Codex's first trade.** | T 8 says **token's first trade**, not launch or market-open time. | Keep B's `tFirst` anchor for the vendor-comparable tag; keep A's launch-relative metric separately. Exact window rule is in finding 6. |
| **P1 — A 107: proceeds collector's 86,400s horizon “from Factories DP2.”** | Factories DP2 is multiple **token senders to a seller**, then liquidation; it does not define a quote-proceeds sweep deadline. Academic and R2 descriptions of Factories also differ on which dump rule is the strict reported label. | Replace with: “CALIBRATE collector window: 86,400 seconds after sale, chosen to capture delayed sweeps. Factories motivates consolidation, not this proceeds deadline. Fit against reviewed sweeps and unrelated payment controls.” Do not describe DP2 as a universally validated outcome label. |
| **P2 — A 263 and B's borrowed holder cuts: ≥40/≥60 treated as GMGN bands.** | T 59 says **above** 40/60; T's largest-holder warning is **>10%**. | Add: “CALIBRATE inclusivity adaptation: EKO uses ≥ at 10/40/60; the cited GMGN comparisons use strict >. Evaluate equality fixtures and record the operator in config.” No silent borrowing of an equality boundary. |
| **P2 — A 219: 300s wash observation “retains current window.”** | Current config uses **300s per round trip**, with an **hourly** volume denominator/floor. A uses a full 300s observation and annualizes its volume pace. | Replace with: “CALIBRATE five-minute observation adaptation of the current 300s episode bound and 3,600s volume floor; current code uses an hourly denominator.” Keep B's 3,600s observation for initial continuity. |
| **P2 — B 39: all proposed names are R2's recommendation.** | R2 recommends Lower observed risk / Caution / High risk / **Insufficient data**. “Not fully checked” comes from CA-35. A's “Elevated risk” is also an EKO choice. | Replace with: “Use R2's first three display names and CA-35's ‘Not fully checked’ label.” |
| **P2 — B 555: zero clone points described as an owner constraint regardless of fit.** | F rejects serial-deployer Danger alone and wrongful history from the clone farm. It does not explicitly prohibit every independent clone/impersonation factor. | Replace with: “EKO proposes zero financial-risk points for clone likeness alone because identity resemblance does not establish present economic exposure. This design choice is separate from the owner's explicit booster-only history constraint.” Keep zero points as the proposed candidate, without inventing an owner decision. |
| **P1 — both: verified event shape allegedly resolves Pons fee semantics (A 205; B 21, 209).** | F verifies fields `fee` and `tax`; R3 says antisnipe is folded into `fee`. The existence of two fields does not prove their economic decomposition or override source code. | Replace with: “F establishes the event ABI. Reconcile actual quote debits, reserve changes and fee recipients for each pinned implementation/configuration. Until decomposition is verified, publish only observed effective total charges; component amounts remain unknown.” |

The following source-backed starting references are present in the supplied files: Codex's 5s, four wallets/$5/0.05%/launchpad-before-graduation, creator-transfer/creation-tx/first-ever-funder insider rules and exclusions; Padre's two-hour funding freshness; GMGN's 1.5×/30s diagnostic and continuous severity formula; GMGN's 2% float cannot-assess precedent; three-wallet cluster guidance; Token Sniffer's 5/30% fee tests; BACKEND's $100/$1k/$10k sizes, preset floors/cost ceilings, 3,600/86,400/604,800s outcomes, 300s receipt batching and 30-day trace retention. These references do **not** validate EKO's altered denominators, predictive cutoffs, inclusivity, authority weights or causal labels.

Both drafts mark score bands, points, aggregation, history windows/boosts, monetary materiality, harm thresholds, service/hub screens, solver budgets, sampling/gates and RPC caps as CALIBRATE. Preserve those markings and adjacent reasons. Add registry entries for every adapted definition, including all amendments below. “Calibrate using §9” is insufficient when the applicable metric, truth label or comparison method is itself undefined.

## 2. Contract and migration blockers

### 1. P0 — Neither draft provides a compatible complete API shape

**A 354–402, 413; B 398–408, 415–419.** A replaces the wire levels, omits current `Verdict.coin`, `playbooks`, `receipt`, `asOfBlock`, and changes reason types. B keeps the level union but still replaces strings with structured reasons and numbers with decimal strings. Both want null issuer/metric fields where `CoinCardSchema` requires an address, numbers and booleans. “Additive” and “existing clients can parse” are therefore unsupported as written. B also calls the verdict union `PlaybookLevel`; current playbook levels include `info`, whereas Verdict excludes it and adds `pending`.

**Keep B's wire values, A's explicit evidence/status types. Insert:**

> Current `Verdict.level` remains `clear | monitor | danger | pending`; `PlaybookMatch.level` retains its separate existing union including `info`. Display labels do not change these values. Preserve every existing required Verdict field and string `reasons`; add optional `guardV2: GuardAssessmentV2` for structured factors, checks, raw metrics and versions. Set `schemaVersion` explicitly for the extended response. Never encode a new factor as an invented legacy PlaybookId.
>
> Breaking CoinCard changes—nullable deployer, nullable/tri-state fields, decimal-string quantities and new denominator semantics—ship as an explicit `CoinCardV2` on `/v2/coins/:address` and `/v2/coins/:address/verdict`, with equivalent negotiated MCP and WebSocket schemas. `/v1` keeps its documented shapes and availability masks; no dummy deployer address is invented for an unknown issuer. V1 metrics retain their original meaning. V2 consumers use only V2 measurements for decisions. Dual-read/dual-write, negotiated schemas and proof retrieval are tested before cutover.

Specify the complete runtime CoinCardV2 schema in Task 026, not just a metric dictionary. Keep old legacy assessments labeled legacy; mapping a **new** V2 result to existing wire values is different from asserting that an old Clear passed V2 checks.

### 2. P0 — CA-31…CA-36 are not fully carried through

**A 229, 417, Tasks 039/044; B §7, Tasks 036/038.** A explicitly removes/renames `flow.humanPct` and changes overlap priority; that cannot be additive to FACTS. B leaves flow, freshness, holder-count and progress definitions unfinished. Neither provides the CA-32 Feed / CA-33 blocked-reason adaptation or precise CA-36 counting behavior.

**Insert:**

> Preserve optional CA-31 `signal`, `spark8h`, `change24hPct`, `declaredAgentPct` and `likelyAgentPct`; omission keeps the documented UI behavior. New V2 flow calls the residual `unclassifiedPct`; V1 `humanPct` is not redefined. Flow shares use covered buy USD, disjoint label priority declared → likely → crew → unclassified, and record numerator, denominator and coverage. No label share is supplied from a placeholder.
>
> CA-32 Feed strings still come from typed fields; token names, agent names and clone references remain Untrusted. Add an optional `guardFactorId`/`guardReasonCode` for V2 Feed and CA-33 blocked RuleSignal events; preserve the existing `blockedBy` union and user-origin entry signals. No parser extracts structured data from reason text.
>
> CA-34 field availability is projected from V2 check/metric states into V1 section masks. CA-35 row/list `unavailable` remains explicit; missing keys cannot participate in sorting. `verdictPending` is true only before the first persisted verdict. CA-36 totals are server-computed across all live coins under the active rules: `clear/monitor/pending/danger` are mutually exclusive primary levels; High-with-gaps counts as danger and separately as incomplete coverage. `evaluatedToday` counts distinct coins evaluated in [UTC day start, next day start), not recalculation rows. A missing totals source is unavailable, never client-page counts or zeros.

A 825's blanket prohibition on ranking by Guard also changes FACTS's existing verdict-based Radar ordering. Preserve existing non-Signal ranking with unavailable-key handling, or explicitly propose/version its replacement. The hard contract is that **Signal never ranks Radar**.

### 3. P0 — Signal changes exceed an adapter unless its inputs are preserved

**A 52, 197, 417; B 60, 419.** Existing Risk uses per-Monitor deductions, powers and removable LP; B replaces it with one band mapping without specifying whether power/LP deductions remain. A proposes an “unavailable risk reading,” but `CoinSignal` requires five numeric readings. Both also alter depth/concentration/freshness inputs that affect Liquidity and Holders while claiming to preserve non-risk readings.

**Keep B's neutral/lowData representation and separate version; replace the adapter wording:**

> Preserve Signal v1 inputs and computation for stored/history consumers. Signal v2 keeps the five weights 30/25/20/15/10 and beta status. Its Risk mapping is an explicitly changed definition: complete High → 0; incomplete non-High → 50 with `lowData: ['risk']`; otherwise `max(0,100 − 25×isCaution − 10×confirmedPowerCount − 15×isRemovableLP)`, where confirmedPowerCount counts tax-raise, blacklist and mint capabilities once each. Required unknown controls produce lowData rather than false booleans. This is a proposed adapter contract, not the original §7.7 formula.
>
> Either feed unchanged legacy measurement definitions into the other readings or declare and test each changed V2 input definition under Signal v2. Record `signalVersion`, input measurement versions and the guard receipt used. Refresh remains at most every 15 seconds. A current High verdict overlays Signal and suppresses Hot; incomplete coverage cannot acquire Hot eligibility from a neutral reading. Signal never feeds Guard or permission.

### 4. P0 — Policy presets and idempotency need exact semantics

**A §1, 415; B 45–58, Task 039.** Both tables say Safe denies Caution, but existing presets fill only unset fields: an explicitly null optional block threshold can override that default. A says null disables Elevated gating, contradicting an unconditional Safe row. A's “revalidate idempotent allow” conflicts with BACKEND §9.6 replay-as-is unless execution revalidation is a separate action.

**Insert:**

> Apply presets only to unset optional fields. Mandatory High and pending/missing-current-data buy denials apply regardless of mode or `blockPlaybookLevel`. For complete Caution, deny iff the effective `blockPlaybookLevel === 'monitor'`; Safe defaults to that value, while explicit null disables only this optional gate. Actual-size quote, depth/cost, caps, kill and asset-list checks still apply. Sells bypass only buyer-risk gates, not kill, explicit blocked assets or execution validity.
>
> Repeating the same ref/order replays a final preflight result unchanged, as §9.6 specifies. That stored allow is not an executable permit. Quote/order preparation performs a fresh current-state gate and binds exact account, chain, token, side, raw amount, route, calldata/value, slippage, policy version and guard receipt; expiration or relevant state change requires re-quoting/revalidation. `needs_approval` continues to re-evaluate every check. A changed orderHash on the same ref remains `order_mismatch`.

Keep the advisory/enforced distinction in both drafts. Do not make optional account modules or a prepared attestation executor sound installed.

### 5. P1 — Receipt retention/hash/version text needs one normative envelope

**A 407, 421–423; B 423–427.** Keep A's 30-day full trace / permanent digest distinction; B's “historical proof forever” must not promise all full traces forever. A's snapshot versus receipt-envelope hash needs an explicit exclusion of recursive receipt fields. Existing database uniqueness `(coin,as_of_block,rules_version)` cannot support multiple identity/measurement versions, same-block event cursors or shadow/active snapshots as proposed.

**Insert:**

> `payloadHash = keccak256(UTF8(JCS(versionedPublicPayload)))`. The payload contains the actual recording time, evaluation mode, full raw measurements/statuses, immutable source hashes, cursor, all method/config/registry versions and decision; it excludes receipt hash, Merkle proof/root, batch ID and anchoring transaction fields. `snapshotHash` hashes the separately specified deterministic input object, excluding wall-clock recording time and receipt metadata. Use the existing leaf exactly: `keccak256(keccak256(abi.encode(uint8(kind),bytes32(itemId),bytes32(payloadHash))))`, with kind 0 for verdict and `itemId = keccak256(UTF8(Receipt.id))`. Canonicalization remains `jcs-rfc8785/v1`; batch IDs come from the committed registry event.
>
> Raw public payloads, proofs, summaries and digests persist forever. Full simulation traces persist 2,592,000 seconds; after expiry the response names the missing full trace. Historical verification recomputes the original stored payload under its declared schema, never a newly formatted response. A correction/reorg appends a new item/event; it does not delete or mutate the original item or grade.
>
> Add V2 storage uniqueness over chain, token, blockHash, evaluation cursor, mode, all method/config/registry versions and known-time cut. Recompute the same key idempotently; different evidence revisions use explicit supersession. Keep legacy uniqueness and rows intact.

Freeze a concrete V1/V2 proof fixture shared by browser, TS committer and Foundry tests, as BACKEND §13 requires. Define whether fresh same-input recordings create a new item or reuse one; do not leave receipt-ID generation implicit.

## 3. Measurement, attribution and completeness

### 6. P1 — Time boundaries and executable snapshot placement differ

**A 68/130 versus B 130/157.** A uses half-open five seconds; B explicitly includes the endpoint. With whole-second timestamps, inclusive `[t,t+5]` includes a sixth timestamp bucket. B's `knownAtSec` fields cannot prevent same-second later evidence leaking into an earlier decision. Both ask for immediately pre-sale state, but archive reads at a block normally expose end-of-block state, not that transaction prefix.

**Keep A's cursor discipline; insert:**

> Engineering window convention: a W-second launch/first-trade interval is `[start,start+W)`; trailing windows are `(T−W,T]`, also bounded by the evaluation cursor. The Codex-comparable early metric starts at the first actual trade; the separately named launch acquisition metric starts at TokenLaunched. Record this endpoint interpretation as an EKO method choice because the supplied Codex excerpt does not specify inclusivity.
>
> `knownAt` and `observedThrough` are full chain cursors, not seconds alone. Persisted executable market snapshots occur at transaction boundaries. To obtain pre-transaction state inside a historical block, fork from its parent and replay the exact transaction prefix; record prefix identity and replay fidelity. Log/trace cursors locate evidence but do not imply a buyer could enter halfway through an atomic transaction. Delay checkpoints select the earliest block/transaction-boundary state at or after the delay, tie by chain order, with the chosen side of the transaction boundary explicit.

Define trade/trace interleaving through an adapter execution ordinal. Do not compare an arbitrary tracePath string with logIndex and assume that reproduces execution order.

### 7. P0 — Principal-origin tokens do not establish operator responsibility

**A 126, 152, 237/247; B 126 versus 266 and 512.** A makes intentional creator transfers affiliated insiders and lets their sales support operator harm without sufficient continuing-control evidence. B defines operator side to include principal-origin lots, then correctly says an independent gift recipient does not enter history. The two statements conflict. F requires harm caused by the deployer's own side, not every future recipient of its tokens.

**Keep B's independent-recipient exclusion. Insert:**

> Maintain `tokenOrigin` separately from `sellerControl`. A sale of principal-origin lots by an unlinked recipient is origin-linked selling, with operator responsibility unresolved. It may expose current buyers but never boosts operator history. Operator-attributed selling requires authenticated sale control or a reviewed recent material funding-and-proceeds loop establishing that the seller acted on the operator side. Gift, airdrop, payment, custody and transfer provenance alone cannot satisfy that requirement. Preserve the origin evidence and uncertainty without joining the recipient into the operator group.

Identical Safe signer sets are not sufficient by themselves (A 103): thresholds, modules and effective permissions must also authorize control of each account. Use B's demonstrated-permission requirement. Conversely, funding alone can establish coordination without establishing control.

### 8. P1 — Cash multiples, sold share and cost basis need explicit denominators

**A 164/179 versus B 170/182.** B's addition of gas/launch costs changes the 1.5× diagnostic; A treats allocations as zero purchase cost but must not turn unknown acquisition basis into zero. Both entering-lot denominators can double-count a transferred lot returning to a set or confuse cumulative gross recycling with unique issued supply.

**Insert:**

> `marketCashOutMultiple = netSaleQuoteReceipts / actualBuyQuoteDebits`, lifetime through cursor, same quote asset; actualBuyQuoteDebits includes trading charges, excludes gas and launch/LP funding. This is a CALIBRATE accounting convention motivated by T, not a fully documented GMGN denominator. Validate against reconciled quote transfers. Separately, `allInCashOutMultiple = netSaleQuoteReceipts / (actualBuyQuoteDebits + attributableGas + attributableLaunchContribution)` where every component shares a stated valuation basis. Zero or unknown denominator → null, never infinity. Unknown basis and verified zero purchase expenditure are distinct statuses.
>
> `soldShare = soldUnits / (openingLiquidUnits + externalAcquisitionUnits)` for the same stated interval and wallet union. Internal transfers are not acquisitions; every outside buy/receipt is an acquisition event, including rebuy, and conservation is checked. This turnover-aware share is distinct from unique-issued-lot share and `soldUnits/S_at_episode_start`. Direct allocations have provenance but no invented recipient purchase basis. Origin attribution reversing under FIFO versus proportional treatment makes operator-history eligibility indeterminate pending review.

Keep A's explicit trailing/lifetime labels, B's gift-basis uncertainty and the separate creator-fee/LP proceeds ledgers.

### 9. P1 — Circulating supply differs; custody and locked holdings can contaminate scoring

**A 140/162–169/264 versus B 144/147/175.** Both define the same external float once exclusions reconcile, but B includes unsold curve inventory in circulating supply. A's published held numerators say current balances, while its scoring requires liquid exposure. B allows unknown custodian balances to be omitted from top-ten without a deterministic gap rule.

**Keep A's circulating definition and both total/float displays. Insert:**

> `S` is current totalSupply, `D` verified sink balance still included in S, `K` non-market locked/unvested units, `U` unsold/reserved curve units and `P` market inventory. These disjoint raw-unit buckets give `C=S−D−K−U` and `F=C−P`. Pool inventory remains circulating even if its LP position is locked. A live burn-intent wallet is not a sink. Store minted M and true supply-reducing burns separately; `burnedPct=100×(M−S+D)/M` only with complete mint/burn reconciliation.
>
> Every scored held numerator uses only presently liquid external units, excluding its locked portion, under the same cursor and denominator. Display raw/locked/liquid balances separately. Unknown custodian balances remain in F and in the raw address top-ten; beneficial-group top-ten is incomplete when custody cannot be resolved. Zero/negative or unreconciled F → unavailable. The 2% stable-float screen is a CALIBRATE extension of GMGN's burn/DEX float definition to EKO's curve/lock exclusions.

For ownership thresholds, retain B's float-based candidate table. A's ≥70% S decisive threshold is not comparable to B's ≥50% F; keep both measurements but do not convert candidate point tables without a new calibration run. Include the retained-address tie-break and fewer-than-ten case.

### 10. P0 — Attributed dump can miss real buyers or overstate attribution

**A 181–189; B 254–266.** A explicitly excludes buyers entering during the episode, although F describes buyers entering between early insider buys and sells. A omits both buys and sells in its intervention but renders the difference as contribution “from those sales.” B's AND of 1% float and $500 excludes material harm in smaller launches. Its new pre-episode $100 entrant can enter after actual buyers were already hurt. B requires positive Ebuyer even though that additional accounting estimate is not a validated buyer-loss oracle.

**Keep A's sale-episode/real-buyer cohort idea, B's bounded disjoint intervals and control/origin distinction; amend:**

> CALIBRATE episode candidate: consecutive attributed-side sells with gaps ≤60 seconds and maximum duration 300 seconds, split deterministically at the cap; also report disjoint-episode aggregation over trailing 3,600 seconds. Materiality starts at sold liquid units ≥1% of pre-episode F **or** positive net trading cash-out ≥$500; zero/unknown terms cannot satisfy their branch. Validate these candidates against reviewed size/depth cohorts, including small launches and the $10 example.
>
> Evaluate covered unrelated buyers holding purchased lots immediately before the episode and buyers acquiring lots during it, with separate cohorts and actual acquisition costs. Compute realized proceeds plus executable remaining-lot value at closure; report cost-basis/position coverage and both quote-unit and USD loss. Do not substitute a new synthetic buyer for all affected real buyers. The standardized $100/$1k probe is a supplementary size sensitivity.
>
> CALIBRATE harmful-disposition label starts at ≥30% net loss and ≥10 percentage-point replay improvement for a covered cohort, plus positive operator net trading cash-out and high-control attribution. Publish coverage and method. A sell-only intervention omits the identified sells; a net-trading intervention omits buys and sells and is named separately. Preserve other transactions' original limits, deadlines, balances and order; an invalid remaining action makes that intervention indeterminate. Ebuyer and mechanical pressure are diagnostics, not mandatory truth labels until separately validated. Threshold fitting cannot redefine truth on the frozen test.

This is an amended hybrid hypothesis, not a sourced universal dump definition. The selected causal test must be frozen and independently reviewed. No recipe above authorizes guessing missing buyer costs or operator control.

### 11. P1 — B's reserve-origin accounting is not yet conserved

**B 190–194.** Buckets use net recipient proceeds, but an actual market reserve decrease may include paid sell fees. `operatorNetBuyInputs` is undefined; current-versus-historical operator classification, zero reserves, fee treatment and repeated subtraction of previous buy inputs are unspecified. Log-price pressure uses transcendentals without numeric precision and calls aggregate impact mechanical even where reference-route price may not move.

**Keep as optional research metrics, not prerequisites for labels. Insert:**

> At each event, update buckets by the actual real reserve delta reconciled against protocol settlement, including separately attributed fee outflows. If gross quote leaves the reserve but only net quote reaches a seller, remove the gross outflow proportionally and classify recipient/fee portions separately. Require nonnegative buckets and exact sum to reconciled real reserves; zero or unknown prior reserve makes a proportional ratio unavailable. Define the reported interval once and subtract verified operator buy debits in that interval once. Classification is pinned to the evaluated identity/known-time cut. Describe the output as a proportional reserve-origin estimate; no lower-bound or “conservative” claim is established by the research.
>
> Mechanical pressure is a dimensionless fraction, displayed as `100×impactSide`; it requires strictly positive prices in the same quote asset on one pinned reference route. CALIBRATE its numeric method and aggregation against exact adapter replays before scoring. Report direct route pressure separately from later cross-route arbitrage and actual buyer losses. Unsupported math/replay returns unknown.

Remove the unsupported “conservative” assertion. Record the chosen decimal library/precision/error tolerance in the implementation contract rather than leaving `exp`/`ln` to binary floats.

### 12. P1 — Round-trip and depth definitions must be identical across card, score and policy

**A 195–201; B 202–207/300.** A includes gas but divides by trading input Q, calling this the existing definition; BACKEND §6.2 excludes gas. B has two cost formulas but the score doesn't say which. A measures average execution discount; B measures marginal-price movement. These are substantially different depth numbers, not interchangeable adapters. Route selection and terminal-fee/tier assumptions also differ by metric.

**Keep B's two cost fields and marginal-price depth. Insert:**

> Let Q be actual quote spent after refunds, R net quote returned after protocol and applicable EKO fees, Gi/Go entry/exit network fees converted under the declared pricing method. `venueRoundTripCostPct=100×(Q−R)/Q`; `allInRoundTripCostPct=100×(Q+Gi+Go−R)/(Q+Gi)`. Q>0 is required; all USD terms use explicit conversion times. Guard candidate execution cuts use venueRoundTripCostPct; actual order policy names which cost field it limits. Gas is always shown separately; all-in loss cannot be hidden by venue-only cost. No component is counted twice.
>
> Reference card/Guard quotes use a declared neutral non-exempt account and explicit fee schedule, tier, stage and config hash. Bound execution quotes use the real account and current entitlement. Route selection at each size maximizes verified net sell/round-trip proceeds as applicable; exact ties resolve by normalized route ID. Unsupported routes do not count as zero-capacity supported routes.
>
> Directional depth d is maximum input moving the **post-trade marginal price** by at most d% of pre-trade marginal price, using market-only math. Buy notional is quote input; sell notional is input tokens × pre-trade marginal quote price. Compute buy/sell 2/5/10% separately, with a fee-inclusive quote alongside. Policy headline depth is min(buyDepth2,sellDepth2). Average execution-discount depth is a separately named optional metric, not the same field.

Solver bounds must identify the inequality they prove. When error tolerance/budget fails, return conservative bounds; for a nonlinear/tax/hook route, do not assume monotonicity without adapter proof. At zero full depth, removableDepthShare is undefined; present no-exit evidence separately. A's former LP “quote liquidity” needs a concrete valuation method before use; prefer B's lost sell-depth share, including all reachable alternate routes.

### 13. P0 — Missing-history and unknown-principal rules can either deadlock release or excuse missing checks

**A 23/280/288/294; B 335–337.** A can require 30-day history and all applicable uncalibrated families to permit Lower, although history is booster-only and the source path may not exist. B calls an unidentifiable principal a completed investigation, but this is not permission to mark required attribution not applicable. B doesn't define “significant holder,” “relevant path,” or how enough native-transfer coverage is established.

**Keep B's optional history, A's concrete candidate universe. Insert:**

> Missing optional history or first-ever funding means no booster and an explicit history gap, not pending by itself. Required recent ownership/coordination inputs remain required. CALIBRATE candidate universe starts with every recipient buying in `[t0,t0+300)` and every current liquid holder of ≥1% S; expand funders/collectors only through qualified non-service paths, at most three hops. Report the candidate set, inspected intervals and omitted liquid balance; validate coverage against dispersed-ring negatives/positives.
>
> An unresolved required principal/control path is incomplete even after an adapter attempted it; “not identifiable” is a failure/unsupported status, not a negative ownership finding. Creator history may be optional on a secondary pool, but current holdings, controls, recent selling and relevant coordination coverage must still be complete. First-ever funding/freshness can remain descriptive unknowns when required recent funding is complete.
>
> Required checks are enumerated by supported venue/profile and released rules configuration. Optional/shadow diagnostics cannot silently block every active verdict; required uncalibrated checks block candidate Lower release. Every active High-or-pending refusal identifies the active rule/check version. Shadow values cannot cause orders to be refused before promotion.

This preserves CA-34 and avoids manufacturing lower risk from failed data access. Do not leave policy coverage as a prose list without exact check IDs and predicates.

### 14. P1 — History denominator and maturity must be closed, not selectively enriched

**A 284–288 versus B 341–347.** A excludes censored/unmapped launches from its weighted fraction, enabling selectively investigated harmful launches to inflate the booster. B demands complete relevant enumeration/assessment, but uses one-hour outcomes while A uses 24-hour outcomes. Both need a time interval and identity-change policy that does not retrospectively replace earlier receipts.

**Keep B's no-boost-on-incomplete-denominator rule; choose A's 24-hour maturity and decay as the starting candidate:**

> CALIBRATE history uses launches with t0 in `(T−2,592,000,T]`, whose 86,400-second outcome is mature and known by the full evaluation cursor. Enumerate all qualifying launches for the supported indexed universe before computing weighted adverse share; an unresolved/missing eligible mature launch disables the booster and appears in coverage. Immature launches are separately counted. Use A's starting half-life, sample floor and bounded formula only after this condition passes. Age is T−t0; one launch contributes once. Later control discovery may support a newly computed verdict at T, but cannot rewrite the historical input graph or receipt.

Retain A's explicit current L/O/A prerequisite and B's complete-denominator safeguard. One-hour-versus-24-hour choice is CALIBRATE and needs delayed-bleed sensitivity; neither is settled by the research.

### 15. P1 — Outcome definitions still have unspecified probes and coverage

**A 238–243; B 272–288.** A's “executable quote liquidity” and $100 “unit sell price” lack an exact token quantity. B's collapse refers to “a fixed-delay cohort” without choosing a delay, and survival refers to undefined checkpoints. B's withdrawal requires operator control as part of the event definition, obscuring a third-party withdrawal even though buyer exposure is real.

**Insert:**

> Store liquidity-withdrawal facts for any proven authorized remover; operator responsibility is a separate field and only own-side events enter history. CALIBRATE the B withdrawal candidate (99% inventory value, 90% token-wide sell 2% depth, 600s absent successor) using pinned pre-removal valuation and complete supported successor discovery. Unknown route discovery is unassessed, not verified no successor. Display “Liquidity withdrawn,” not a person-level accusation.
>
> Define collapse on the primary 60-second-entry $100 benchmark position, with fixed purchased quantity, quote-unit net liquidation values at the declared checkpoints. Peak is the maximum observed executable value after entry; trough is the minimum later value, ties by earliest cursor. `drawdownPct=100×(peak−trough)/peak` requires positive peak and complete route coverage. Recovery and horizon values are separately stored; the earlier event is not erased. ≥90% is a CALIBRATE outcome adaptation, not Mazorra's complete inactivity rule.
>
> Survival at 3,600/86,400/604,800s requires complete applicable event checks and scheduled valid benchmark exits at both reference sizes; no executable entry, unknown required checkpoint or unresolved route is censored/incomplete. Survival does not imply no buyer loss. For the initial historical runner, checkpoints are every 60 seconds and relevant sell/control/graduation transactions, plus the exact horizon boundary; test checkpoint sensitivity before changing this method.

Keep A's simultaneous labels/statuses and B's withdrawal/migration safeguards. Do not mix “no operator sale episode” with “no operator selling”: one small sale does not satisfy a harmful episode but still invalidates the literal no-selling claim.

### 16. P1 — Wash, recycling, clone and remaining card fields need complete windows

**A 217/219/229; B 222–230.** Prefer B's disjoint cycling episodes, but define the volume denominator and expiration behavior. B's curve ratio has no reserveStart/reserveEnd interval. A retains a clone 0.8 dominant-pair observation without fully restating its denominator. B lists progress, flow and freshness without implementing definitions comparable to A's §3.7.

**Insert:**

> Cycling evaluation window is `(T−3,600,T]`; require complete observation of that window. Start an episode at the next buy, expire if time since start exceeds 300s, and restart at the next buy. Close at the first sell-inclusive state with abs(net token units)/gross bought units ≤0.10. Score only actors with at least two wholly contained completed episodes. Numerator is buy-plus-sell gross USD of qualifying disjoint episodes; denominator is all market buy-plus-sell gross USD in the same window. Zero denominator → unavailable; missing USD makes the exact share unavailable. Retain classified arbitrage/settlement exclusions and show their amounts.
>
> CALIBRATE curve recycling interval is `(max(t0,T−21,600),T]`; gross quote volume and fee-excluded real reserve change use identical endpoints/asset units. Ratio at net growth ≤0 is unavailable, with raw inputs displayed. Validate window choice against ordinary curve activity; it is not supplied by current config's age threshold.
>
> Clone comparator's dominant-pair share is (leading buyer gross buy USD + leading seller gross sell USD)/all gross trade USD in the stated 3,600s window, each side counted once. Tie by address; missing/zero volume → unknown. This observation and the 0.8 candidate add zero clone points. Current trend-onset fallback is not a measured onset.

Keep A's exact progress, flow, holder-count and freshness definitions after the schema separation in findings 1–2. Replace its generic `ageSec` wording with separate `launchAgeSec`, `snapshotAgeSec` and existing `CoinCard.freshness.ageSec` (oldest required section age when served). B's 30-second coin-staleness precedent is not proof that every cached verdict/check remains valid for 30 seconds.

## 4. Claims and untrusted content

### 17. P0 — Escaping is not the full Untrusted boundary

**A 221/331/346/385–405; B 230/368/384/405.** A's free string reason parameters, capability/bound/retry strings and “instruction to {action}” can admit revert text, metadata or model prose. Neither shows a typed allowlist per template. B's “execution boundary refuses any order derived from untrusted instructions” is not an existing preflight implementation: supplied preflight has no instruction-provenance input.

**Keep B's wrapper and add:**

> Reason parameters are runtime-validated per template: trusted finite enums, validated chain-scoped addresses/route IDs, fixed-point amounts and coverage/status codes only. `{action}` is one of a finite detector action enum, never copied token text. `{capability}`, `{restrictionType}`, `{boundOrDelay}`, `{checkName}` and retry text come from first-party enum templates. Token names/symbols/descriptions, revert strings, social text and model-written prose remain `Untrusted` objects, including nested evidence. No raw value is copied into a reason string, title, metadata, notification subject, shell command or trusted tool field.
>
> Render Untrusted only through the existing inert text component: strip controls/bidi/zero-width characters; no HTML, Markdown, linkification or arbitrary href; explicit Copy text only. Links derive from validated internal routes and `/config` allowlists. OG images use sanitized text; document/meta titles and share intent text use neutral trusted text. Retain BACKEND §9.5 and FRONTEND §9 red-team fixtures, including repeated detector calls and model prose.
>
> Metadata scanning detects and explains instruction-like text. It does not prove the provenance of an agent's order. The harness instructs agents to ignore Untrusted instructions; only a specified authenticated order-provenance mechanism may support an automatic “derived from untrusted text” refusal. Do not claim that mechanism exists from today's preflight code.

Token-supplied error text must never fill “Not fully checked ... retry” directly. Add adversarial escaping/schema tests to the reason and evidence handlers, not just the UI.

### 18. P1 — Buyer-facing reason templates overstate or misdescribe findings

Apply these exact replacements; keep A's stable reason-code approach with typed parameters:

| Draft location | Replacement template |
|---|---|
| A 329, “fee-exempt” | “{count} launch wallets are exempt from the temporary buy anti-snipe tax; {affiliatedCount} have independent affiliation evidence.” Exemption does not remove ordinary fees/creator tax. |
| A 326, “points ... from those sales” | “Operator-controlled wallets sold {soldPct}% of {denominatorName} for {netQuote}; covered buyers lost {lossPct}%. The {interventionType} replay improved their return by {contributionPp} percentage points.” Match the intervention actually run. |
| B 375, “holders control” | “The ten largest external addresses hold {rawPct}% of holder float; the ten largest verified control groups hold {groupPct}%.” Neither sentence claims the top ten are one controller. |
| B 377, “Four ... launch block” | “{recipientCount} recipients bought in the same launchpad-pool block before graduation: {buyUsd} total and {boughtPct}% of outstanding supply. Shared control is {controlStatus}.” Codex's tag is not limited to launch block and a qualifying group may contain five or more recipients. |
| B 376, “still hold” | “First-trade-window buyers acquired {grossBoughtPct}% of outstanding supply and currently hold {heldPct}% of holder float.” “Still” falsely implies all current units came from their early buy. Add a separately named early-lot overhang row if traced. |
| B 379, “outside sellers caused” | “Non-operator sellers sold {amount} over {windowSec} seconds; measured sell pressure was {impactPct}%. Operator attribution is {attributionStatus}.” Only supported controlled replay can make a causal buyer-loss statement. |
| B 372, fixed $100 line | “A {sizeUsd} buy-then-sell returned {returnedUsd} at {snapshotId}: {costPct}% venue round-trip cost; gas {gasUsd}. Fee breakdown: {breakdownStatus}.” Always show the size that generated the highest reference risk and unknown decomposition. |
| Both history lines | “{badCount} of {matureCount} completely assessed launches in the covered {historyWindowSec}-second window had operator-attributed harm; the qualified current {exposureType} receives {historyPoints} points.” Also show the decay-weighted fraction if A's booster is used. |

When fewer than ten holders exist, say “largest {holderCount}” rather than asserting ten. A's sorted reasons must expose the complete list even when a tile shows only three. B needs the same explicit $100-before-$1k exact-tie rule and fee-breakdown fallback.

### 19. P1 — Snapshot risk must not sound like a prediction or authorization

**A §1; B 30/36 and §9.** Neither draft makes an affirmative banned safety/audit/return claim; occurrences of the banned words are mostly prohibitions, negations, legacy policy names or source descriptions. Do not flag the policy enum `safe` or the Safe product name as buyer certification. B's “intended for the next 3,600 seconds” can nevertheless imply a forward-valid risk guarantee, and both expose known lower risk beside incomplete checks without specifying prominence.

**Use B's Caution name and CA-35 label. Insert exact public copy:**

> Lower observed risk: Required applicable checks completed at this snapshot; measured factors fall below the released Caution threshold. This is not a buy recommendation and losses remain possible.
>
> Caution: Completed checks show material buyer exposure. Read the factors and order-size costs.
>
> High risk: A confirmed severe exit fact or the released high-risk threshold applies. EKO refuses buys.
>
> Not fully checked: Required checks are unresolved. EKO refuses buys; missing checks and observed exposures are listed.
>
> Buyer risk at this snapshot, for the stated sizes and routes. Evaluated against a 3,600-second buyer-outcome benchmark; this is not a forecast or a future-valid assessment. DYOR · Not financial advice · AI-generated analysis.

For incomplete non-High results, do not show a green/lowest-risk secondary chip; say “Observed factors only; assessment incomplete.” High-with-gaps must keep both High and the gaps visible. Lower meaning cannot use “measured universe” until cohort/version is identified.

Test copy across web, Radar/Feed, MCP, bots, OG cards, widget/badge, research and agent packs, not just `src/copy`. Required DYOR/NFA/AI lines remain on every verdict surface, with Built on/non-affiliation where specified. No source/vendor phrase authorizes “good to buy,” price forecasts, claims of returns, partnership or safety certification. Legacy safety-like Clear copy must remain visibly historical, not current certification.

## 5. Calibration, timing and cost

### 20. P0 — B's primary harm aggregation cannot be paired with a single prediction

**B 488–502/564.** A token can be High at 5s and Lower at 300s. B pools delay/size outcomes into “half eligible agents hurt,” then says each entrant has its own verdict. It never defines which verdict predicts that pooled label. This makes precision/recall irreproducible, and loss at $1k can be masked by $100 results.

**Keep A's primary 60s entrant and per-size gates; insert:**

> Primary evaluation units are `(token, entryDelaySec=60, sizeUsd)` at $100 and $1,000 separately. Use the verdict known at that entrant's exact cursor and its predeclared 3,600-second exit policy. Compute precision/recall per size; cluster all paths from the same token/operator for intervals. Other delays/horizons are sensitivity slices. Any token-level aggregation is a separately named analysis with an explicitly defined prediction aggregator and cannot replace primary gates. Entry failure, censoring and verified no-exit remain separate statuses.

A and B also differ on fixed hold versus stop/target exits. Keep B's fixed 3,600s hold as the primary research policy; keep stop/target as a secondary policy with its exact checkpoint rule. Predeclare both before fitting.

### 21. P0 — B's paper-position model needs an accuracy gate; exits cannot wait for success

**A 479/481; B 490–496.** B discards synthetic entry reserve changes but requires only a sensitivity report; thin-curve losses can be materially distorted. Its “first executable observed state then” can postpone a scheduled failed exit until conditions improve. Gas-net proceeds floored at zero also suppress costs for uneconomic sells.

**Keep A's replay-validity gate and insert:**

> Attempt exit at the first scheduled state at/after the fixed exit time; inability to execute is an observed exit failure, not permission to advance until a successful quote appears. Any retry policy has explicit intervals and a fixed deadline; store the first failure and all attempts. Transport/state gaps are censored, not token restriction.
>
> The paper-position approximation cannot qualify buyer-harm release gates until matched against persistent-entry-impact replay and eligible real buyers under a frozen error criterion. CALIBRATE starting criterion: ≤1% relative error in positive net proceeds and no hurt/not-hurt reversals in at least 30 diverse matched cases per supported venue and size; expand for thin markets and restrictions. Invalid persistent replay paths remain indeterminate. Report approximation coverage and sensitivity, not just average error.
>
> Net cash proceeds may be negative after sell gas; preserve that value for cash return. A nonnegative position-mark field is separate. Use the same definition for actual, paper and counterfactual returns.

These are candidate validation targets, not published research thresholds. Do not promise that 30 cases establish complete restriction coverage.

### 22. P1 — Split, sampling and per-rule gates are underdetermined

**A 489/501–516; B 530/546/560–570.** A's initial seven-day cohort cannot accommodate its own seven-day purges around 60/20/20 splits; it correctly allows later data, but the packet must budget that extension. B has no exact time boundaries, purge, parameter grid, tie-break or bootstrap definition; “meeting hold-out gates” in its parameter-selection row invites fitting to hold-out. Both overlapping sampling strata need actual inclusion probabilities after deduplication. A's 80% factual-factor accuracy is too permissive for deterministic reasons.

**Keep A's explicit validation/test selection and interval method, B's prospective collection. Insert:**

> Before labels are inspected, freeze calendar cutoffs for development, validation and later test, full source/known-time coverage, operator/component grouping and 604,800s label-overlap purges. Extend forward observation if the bounded historical cohort cannot supply nonempty mature splits; do not relax the purge. Repeated groups crossing cutoffs are assigned to the group-held-out analysis with earlier examples excluded from fitting. Candidate choice uses validation only, A's declared finite grid and deterministic tie-break; final test is evaluated once per frozen candidate.
>
> Freeze strata membership precedence and draw independently recorded probability samples; record each token's union inclusion probability under the actual deduplication/top-up design. Report incident challenge results separately from population-weighted estimates. If selection probabilities for purposive controls are not known, do not include them in population-rate estimates.
>
> Use A's seeded 2,000 operator/component bootstrap resamples at 95%, keeping all paths per unit together and respecting sampling weights; unresolved related groups are conservatively grouped or sensitivity-reported. Wilson is only for a declared unweighted independent binary sample. Require held-out denominators per primary size, not combined development/test counts. Every numerical release target remains CALIBRATE.
>
> Deterministic factual templates require zero known denominator, arithmetic, identity-role and provenance errors in accepted fixtures. Reviewed attribution requires the stated ≥95% precision gate. Agent-instruction classification requires ≥95% reviewed precision including quotations/negation, as in A. A factual 80% factor gate cannot authorize publishing incorrect deterministic holdings/fee facts. Evaluate heuristic exposure-to-loss performance separately, with per-factor ablation and overall band gates.

Keep A's explicit Lower upper-confidence bound and High-only recall floor; keep B's separate all-token pending/refusal and complete-case prediction reports. The final rule set must state one consistent target table, not inherit incompatible recall definitions from both drafts. B's text-scanning threshold is not ready merely because a hit is reproducible; preserve the non-execution boundary regardless of calibration status.

### 23. P1 — Confirmation delay is not proven finality

**A 245/451 “existing ... finality boundary”; B 437.** BACKEND §4.2 describes soft finality and possible pre-L1-posting reorgs but does not specify the numerical outcome-finality rule A invokes. B's 30 seconds is explicitly CALIBRATE, but cannot establish irreversible finality.

**Keep B's honest observed/not-finalized distinction. Insert:**

> CALIBRATE confirmation lag begins at 30 seconds beyond the outcome's required final cursor, with canonical hash rechecks. It is an operational reorg filter, not protocol finality. Store `confirmationStatus` separately from any verified L1 batch/finality evidence. History consumes only the declared confirmation-policy status; until chain-specific finality is verified, copy says observed/confirmed under policy, not finalized. A reorg appends invalidation and supersession for every dependent outcome, graph, cache and receipt.

Specify how horizon maturity changes when a horizon ends within a transaction, and retain original known-time cuts after backfill.

### 24. P1 — Data-cost arithmetic is mostly usable, but scope and approval limits differ

**A §8; B §8.** The 864,000/day, $5.184/day, $155.52/30 days, $311.04 blocks+traces, public 48h/day and 36.7h replay extrapolations follow F's assumptions. They are not total implementation/backfill costs. A's 44-day discovery selectively fills historical booster windows; B's 30-day backfill does not provide a full preceding 30 days for early historical entrants. FACTS §5b's fallback says seven-day backfill plus candidates; broader work is a proposed change, not already approved merely by writing a design.

**Keep A's symbolic/lower-bound arithmetic and historical warm-up, B's 250,000-call checkpoint. Insert:**

> Propose 30-day filtered-log enumeration and selective 24-hour outcomes; for earlier historical entrants, either obtain the entire preceding operator window and its outcome follow-up or omit the history boost. Keep a separately bounded seven-day first replay pilot consistent with FACTS §5b. Broader backfill/resource caps require an explicit recorded decision before paid jobs run. The design review does not authorize a subscription or higher cap.
>
> At each pilot checkpoint report request units/retries, distinct blocks/transactions, address pages/hops, simulation calls, elapsed compute and unresolved coverage. RPC cost is requestUnits×$6/1,000,000 under confirmed billing. Explorer/indexed-provider pricing, storage/compute and the independent human-review workload are separate unknown cost lines. Public-rate estimates do not imply archive/tracing availability on the free endpoint. Stop at caps with checkpoints and pending coverage; never change required-data semantics to meet budget.

Use calendar-month evaluation as A specifies, with exact UTC [start,end) report intervals, rather than B's drifting 2,592,000-second “monthly” scheduler. Fixed second windows for history remain separate from a calendar cadence.

## 6. Which draft to keep where they differ

| Area | Keep | Required amendment |
|---|---|---|
| Public/wire levels | B `clear/monitor/danger/pending`; B Caution; CA-35 Not fully checked | Typed versioned payloads and no current legacy Clear certification; candidate 30/60 remains CALIBRATE. Do not select a cutoff because a source uses a similar number. |
| Clock / evidence | A full cursors, known-at joins and source hashes | First-trade vendor tag separate from launch window; no subtransaction executable snapshot fiction. |
| Launch services / EVM roles | B control-versus-coordination and independent authenticated callers | Service discovery counts from either draft are CALIBRATE; choose one registry entry and require reviewed provenance. |
| Insider and transferred lots | B gift/control distinction | Remove principal-origin lots from automatic operator responsibility. Exemption remains a separate privilege. |
| Circulation / custody | A excludes unsold curve; B explicit liquid holdings and gift-basis gaps | Raw custodian concentration remains visible; do not silently exclude it from numerator. |
| Ownership factors | B float-based candidates | Keep %S comparators, separate early-lot overhang, exact inequalities and point-table version. A's decisive 70% S is a different candidate. |
| Costs / depth | B separate venue/all-in costs and marginal directional depth | Score field, fee/account context, solver units/bounds and route selection must be named. |
| Harm / intervention | A actual-buyer cost basis, amended with during-episode entrants; B bounded disjoint episodes | Separate sell-only/net-trading intervention; OR materiality is a candidate; bucket estimate is optional. |
| History | B optional history and complete enumeration; A explicit bounded decay candidate | 24h maturity as proposed starting value, no selective denominator, no service/bot inheritance. |
| Scoring overlap | B explicit mechanism suppression | Pin mechanism IDs and tie order; do not invent causal IDs solely to suppress whichever combination is inconvenient. All candidate points suppressed or retained remain receipted. |
| Missing checks | A structured statuses; B history optional | Exact venue manifest/candidate universe and shadow-versus-active semantics; unknown principal is not exoneration. |
| Reason codes / rich card | A typed-template approach and complete raw groups | Apply all replacement templates and Untrusted constraints above; B's card field list alone is not a schema. |
| Receipts | B unchanged envelope/leaf; A trace retention and snapshot hashes | Explicit payload hashing, nonrecursive receipt fields, full uniqueness key and shared proof fixtures. |
| Benchmark / release | B fixed hold/prospective data; A per-size 60s primary gates and deterministic selection | Validity gate for paper replay, weighted sampling/purged splits, per-factor and text gates. |
| Cost / build packets | A explicit evidence/data packet separation; B checkpoint and reviewers dependency | Build schemas and proof/consumer adapters before active cutover; observation/calibration jobs need independent elapsed time and review work. |

The amended draft must provide the exact final metric/check registry, CoinCardV2 schemas, migration responses, Signal v2 definition, prediction/label pairing and release gate table before Task 026 is handed to an engineer. Preserve the six required archetypes as fixtures but correct B 359: F's separate −3.9% sample is not the measured outcome of the owner's hypothetical $10-at-$500k case. Label all chosen prices, proceeds and losses as fixture values; never attach invented measurements or full addresses to the abbreviated real cases.

No production score, causal label, operator history, receipt rewrite, paid subscription or live release is established by this review. Acceptance evidence must name the source revision, dataset/cursor coverage, method/config versions and exact completed checks.
