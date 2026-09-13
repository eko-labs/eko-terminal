import { GUARD_CHECK_IDS, GUARD_CHECK_TIERS, GUARD_FACTOR_IDS, GUARD_FACTOR_FAMILIES } from '@eko/shared';

// Guard 2.0, 2026-10-02: candidate contracts only. Never consumed by V1 rules.
export const GUARD_CANDIDATE_VERSION = '2.0.0' as const;
export const GUARD_SOURCE_REVISION = 'guard-2.0/2026-10-02' as const;
export const GUARD_GATE_IDS = ['contracts', 'measurement_fidelity', 'high_precision', 'harm_recall', 'lower_harm', 'attribution', 'restrictions', 'instruction', 'factor_promotion', 'operations', 'parity', 'live_shadow', 'maintenance'] as const;
type GateId = typeof GUARD_GATE_IDS[number];
type Value = null | boolean | number | string | readonly Value[] | { readonly [key: string]: Value };
export interface GuardParameter {
  readonly id: string;
  readonly value: Value;
  readonly formula: string | null;
  readonly unit: string;
  readonly operator: string;
  readonly reason: string;
  readonly source: string;
  readonly methodVersion: '2.0.0';
  readonly method: string;
  readonly truth: string;
  readonly comparator: string | null;
  readonly fitGrid: Value;
  readonly gate: readonly GateId[];
  readonly status: 'shadow' | 'released';
  readonly acceptanceArtifact: string | null;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
const methods = {
  score: ['Paired buyer outcomes, finite-grid weights, family-max/allocation ablations on purged validation', ['contracts', 'factor_promotion', 'high_precision', 'harm_recall', 'lower_harm']],
  graph: ['Authenticated role/control reviews; dust, service, fragmented and delayed-flow negatives', ['contracts', 'attribution', 'factor_promotion']],
  accounting: ['Conserved hand calculations, exact adapter deltas, FIFO/proportional reversal audit', ['contracts', 'measurement_fidelity']],
  execution: ['Matched local/fork/actual execution with account, size, fee, route, lock and cooldown boundaries', ['contracts', 'measurement_fidelity', 'restrictions', 'factor_promotion']],
  harm: ['Freeze real-buyer outcome truth before score fitting; review loss/basis and OR materiality branches', ['contracts', 'measurement_fidelity', 'attribution', 'factor_promotion']],
  context: ['MM/arbitrage, organic audience, negation/truncation and source/flow reconciliation controls', ['contracts', 'factor_promotion']],
  history: ['Complete one-hour denominator, 24h/7d sensitivity and operator-held-out ablation', ['contracts', 'attribution', 'factor_promotion']],
  benchmark: ['Frozen paired size/class trajectories, exact sampling probabilities and weighted clustered intervals', ['contracts', 'measurement_fidelity', 'high_precision', 'harm_recall', 'lower_harm']],
  ops: ['Metered pilot, reorg/staleness/spend/coverage and deterministic-resume measurement', ['contracts', 'operations']],
} as const;
type Method = keyof typeof methods;
function p(id: string, value: Value, unit: string, operator: string, source: string, reason: string, method: Method, formula: string | null = null, fitGrid: Value = null, comparator: string | null = null): GuardParameter {
  return { id, value, formula, unit, operator, source, reason, methodVersion: GUARD_CANDIDATE_VERSION, method: methods[method][0], truth: ({ score: 'Paired real buyer severe-harm outcomes, with current exposure truth separate', graph: 'Independent authenticated roles/control review, not timing or exemption consensus', accounting: 'Exact conserved raw quantities and matched adapter state deltas', execution: 'Pinned independent fork and actual fills per venue/size/class', harm: 'Covered real buyer cost/positions and valid intervention, reviewed responsibility separate', context: 'Reviewed text/identity/activity classes and conserved flow', history: 'Every eligible mature own-side launch outcome in frozen supported universe', benchmark: 'Frozen paired real/persistent buyer outcomes and exact inclusion probabilities', ops: 'Actual request units, latency, canonical rechecks, memory and resume logs' } as const)[method], comparator, fitGrid, gate: methods[method][1], status: 'shadow', acceptanceArtifact: null };
}
export const GUARD_PARAMETERS = freeze([
  p('level_bands', [30, 60], 'points', 'elevated >= lower && < high; high >= high', 'Guard §1; draft B', 'Independent moderate exposures combine; bands are unvalidated', 'score', null, { lower: [25, 30, 35], high: [55, 60, 65] }),
  p('buyer_horizon', 3600, 'seconds', 'first completed boundary >= entry + horizon', 'Guard §1; BE §7.5', 'Retain one-hour buyer benchmark without future-validity claim', 'benchmark'),
  p('preset_depth', [50000, 10000, 2000], 'USD', 'depth >= floor (Safe/Balanced/Degen)', 'Guard §1; BE §9.6', 'Retain owner policy defaults; measure refusal and quote/fill error', 'execution'),
  p('preset_cost', [5, 10, 25], 'percent', 'venue cost <= ceiling (Safe/Balanced/Degen)', 'Guard §1; BE §9.6', 'Retained limits concern venue cost, gas separately', 'execution'),
  p('service_candidate', [20, 86400, 10, 80], 'launches/seconds/principals/percent', 'launches >=20 in 86400s AND principals >=10 AND distinct pairs >=80%', 'Guard §2.2; F; EKO adaptation', 'Avoid combining shared tooling before vendor-scale cutoff', 'graph'),
  p('hub_screen', [500, 86400], 'counterparties/seconds', 'distinct counterparties >=500 over 86400s', 'Guard §2.2; B; BE §5.4 adaptation', 'Quarantine expansion while retaining economic endpoints and degree uncertainty', 'graph'),
  p('recent_funder', [21600, 60, 90, 3], 'seconds/seconds/percent/wallets', 'funding before buy within 21600s; batch span <=60s; conserved >=90%; participants >=3', 'Guard §2.3; F/B EVM adaptation', 'Reject dust, shared services and post-purchase funding', 'graph', null, { batchSec: [10, 30, 60, 120], fundingSec: [3600, 21600, 86400], materialPct: [50, 90] }),
  p('collector', [90, 86400, 3600], 'percent/seconds/seconds', 'net proceeds >=90% to non-service collector within 86400s; show 3600s slice', 'Guard §2.3; EKO hypothesis, not Factories DP2', 'Capture delayed sweeps without equating collection to control', 'graph', null, [3600, 86400]),
  p('closed_loop', 90, 'percent', 'qualified funder AND matching collector or authenticated authority; conserved value >=90%; debit consumed once', 'Guard §2.3; F/B adaptation', 'Require reviewed sale control before history attribution', 'graph'),
  p('bounded_paths', [3, 86400, 604800, 90], 'hops/seconds/seconds/percent', 'non-service hops <=3; funding <=86400s; recycle <=604800s; conserved >=90%', 'Guard §2.3; B adaptation', 'Avoid old common-funder unions while retaining qualified endpoints', 'graph', null, { recycleSec: [86400, 604800] }),
  p('medium_path', 50, 'percent', 'material flow >=50% AND independent repeated purchase/sweep pattern', 'Guard §2.3; EKO adaptation', 'Preserve sub-90% leads without scoring control/history', 'graph'),
  p('consolidation', [2, 86400, 3], 'senders/seconds/wallets', 'senders >=2; sold units >=received units; elapsed <=86400s; participants >=3', 'Guard §2.3; A Factories motivation, EKO adaptation', 'Separate disposition/origin from common control', 'graph'),
  p('group_minimum', 3, 'economic wallets', 'participants >=3; two authenticated controlled accounts still count operator exposure', 'Guard §2.3; B adaptation', 'Exclude single dyad coordination without dropping proved control', 'graph'),
  p('launch_bundle_window', 300, 'seconds', 't0 <= acquisition < t0+300', 'Guard §2.3; R1 adaptation', 'Catch staggered acquisitions; later holdings remain eligible', 'graph'),
  p('broad_distribution', [100, 0.1], 'recipients/percent S', 'recipients >=100 AND each <=0.1% S', 'Guard §2.4; T Codex wide-distribution exclusion, EKO cuts', 'Suppress automatic insider label only, preserve lineage', 'graph'),
  p('early_windows', [5, 60, 300], 'seconds', 'tFirst <= buy < tFirst+5; t0 <= buy < t0+W', 'Guard §2.4; T anchor, EKO half-open seconds/windows', 'Avoid sixth bucket and reveal delayed activity', 'graph'),
  p('persistent_sniper', [2592000, 90, 5], 'seconds/percent/launches', 'early buys / all buys >=90% over 2592000s AND launches >=5', 'Guard §2.4; A Ready Aim Snipe, EKO seconds/anchor/lookback', 'Require full buy recurrence; timing alone does not prove a bot', 'graph', null, null, 'T first-trade five-second tag fixed'),
  p('supply_convention', null, 'raw token units', 'disjoint buckets; every ratio denominator >0', 'Guard §2.5; BE §6.4; T GMGN/Padre adaptation', 'Do not double-count burns, custody or LP inventory', 'accounting', 'C=S-D-K-U; F=C-P; burnedPct=100*(M-S+D)/M'),
  p('stable_float', 2, 'percent S', '100*F/S <2 => scored float unavailable; F=0 => ratio null', 'Guard §2.5; T GMGN cannot-assess reference, EKO curve/lock adaptation', 'Small float needs age/exit exposure validation', 'accounting'),
  p('usd_quality', [60, 2], 'seconds/percent', 'price age <=60s AND spread <=2%', 'Guard §3.1; EKO adaptation', 'Stale or manipulated conversion invalidates USD cuts', 'execution', 'select lowest spread, then greatest verified sell depth, then route ID'),
  p('position_accounting', null, 'raw units', 'exact conserved equality after internal cancellation', 'Guard §3.2; F/T/A adaptation', 'Distinguish turnover, origin, holdings and recipient expenditure', 'accounting', 'opening+acquired=held+sold+burned+locked+netTransferredOut+fees; soldShare=sold/(openingLiquid+externalAcquisition); percentages=100*n/d with d>0'),
  p('cash_multiples', null, 'ratio', 'denominator >0 and complete valuation', 'Guard §3.2; EKO denominator adaptation, not GMGN accounting', 'No gifted basis or infinity; gas and launch costs separate', 'accounting', 'market=netSaleReceipts/buyQuoteDebits; allIn=netSaleReceipts/(buyQuoteDebits+verifiedGas+launchContribution); realized=netSaleReceipts/soldLotCost', null, 'T GMGN 1.5x and first sell <=30s diagnostics only'),
  p('cash_severity_context', [3, 120], 'ratio/seconds', 'clamp01; diagnostic only, zero points', 'Guard §3.2; T vendor continuous severity', 'Display vendor context without treating tiny profit as harm', 'accounting', 'clamp01((multiple-1)/3)*clamp01((120-firstSellSec)/120)'),
  p('sale_episodes', [60, 300, 300, 3600, 86400], 'seconds', 'gap <=60 AND duration <300; close gap >60 or duration >=300; trailing (T-W,T]', 'Guard §3.3; EKO method', 'Bound episodes; cumulative windows retain slow bleed', 'harm'),
  p('mechanical_pressure', 36, 'fractional decimal digits', 'positive same-quote price ratios; error-bound comparisons => unknown', 'Guard §3.3; EKO method', 'Pin round-half-even precision and distinguish pressure from motive', 'accounting', '100*(1-exp(-sum(a_i*max(0,ln(Pbefore_i/Pafter_i)))))'),
  p('reserve_origin', null, 'quote units', 'buckets >=0 AND sum = real reserves; prior reserve denominator >0', 'Guard §3.3; draft B/A motivation, EKO optional estimator', 'Reconcile real money, fees and mixing, not virtual reserves or victim loss', 'accounting', 'outgoing gross reserve removed proportionally; receipts=sum(netAttributedReceipt*buyerBucketBefore/realReserveBefore); estimate=max(0,receipts-verifiedOperatorBuyDebitsInInterval)'),
  p('depth_solver', [1, 1000000, 1, 48], 'USD/USD/percent/evaluations', 'double bracket then refine width <=1%; total evaluations <=48; monotonicity proved', 'Guard §3.4; BE §6.1 adaptation', 'Twenty doublings plus refinement exceed old 24 budget; report bounds if capped', 'execution'),
  p('two_account_confirmation', 2, 'nonprivileged identities', 'distinct tested identities >=2 per supported class; expand on selective failure', 'Guard §3.4; EKO method', 'Catch selective restrictions and privilege leakage', 'execution'),
  p('confiscation', 5, 'percent no-tax output', 'returned quote <5% of independently valid no-tax sell output', 'Guard §3.4; BE 95% principle adaptation', 'Distinguish token confiscation from fees/capacity/temporary restrictions', 'execution'),
  p('control_horizon', 3600, 'seconds', 'earliest executable change <=T+3600', 'Guard §3.4; EKO scenario', 'Impending release exposure separate from current float', 'execution'),
  p('hook_diagnostics', [2, 5], 'percent/pp', 'quote/sim gap >=2%; asymmetric fee difference >=5pp; diagnostic only', 'Guard §3.4; C thresholds, EKO validation', 'Bits/unknown causes cannot establish decisive facts', 'execution', 'gap=100*abs(quoteOut-simOut)/quoteOut with quoteOut>0'),
  p('cycling', [3600, 300, 10, 2, 10000, 50, 80], 'seconds/seconds/percent/episodes/USD/percent/percent', 'full trailing 3600s; expire >300s; abs(net)/grossBought <=10%; episodes >=2; volume >=10000; share >=50/80%', 'Guard §3.5; C hourly/episode convention, EKO adaptations', 'Exclude neutral arbitrage and settlement; MM controls precede points', 'context', '100*qualified buy+sell gross USD / all market buy+sell gross USD (positive denominator)'),
  p('curve_recycling', [21600, 5, 3, 60], 'seconds/ratio/groups/percent', 'age >=21600s AND volume/growth >=5 AND top3 share >=60%; growth >0', 'Guard §3.5; C config, EKO diagnostic', 'Normal curve activity is not scam or history escalation; zero points', 'context', 'same-quote gross volume/fee-excluded real reserve growth over (max(t0,T-21600),T]'),
  p('trend_context', [50, 3600, 600, 3600, 0.8], 'rank/seconds/seconds/seconds/ratio', 'rank <=50 preceding hour; original age >=600s; onset <= launch < onset+3600; dominance >=0.8 diagnostic', 'Guard §3.5; C retained, EKO context', 'No subtype without stored onset; clones have zero financial points', 'context', 'dominant buyer gross buy + seller gross sell / all gross trade USD (each side once)'),
  p('instruction_predicate', 4000, 'Unicode characters per field', 'explicit agent target AND imperative action in same sentence; scan <=4000', 'Guard §3.5; C bound, EKO target/action adaptation', 'Review quotations, negation, truncation and unavailable fetches', 'context', 'target in agent|assistant|bot|model role; action in buy|approve|transfer|send|bypass_checks|change_policy'),
  p('card_context', [10000000000, 604800], 'USD/seconds', 'price*C >10000000000 AND age <604800 => diagnostic cap hidden', 'Guard §3.5; BE/C accounting adaptations', 'Conserved timer/reserve/holder metrics; anomaly is not risk factor', 'accounting', 'curveProgress=100*netRealQuoteReserve/graduationThreshold; holders=positive external liquid addresses; launchAge=T-t0; snapshotAge=servedAt-T; requiredAge=oldest required section age'),
  p('flow_accounting', [300, 3600, 86400], 'seconds', 'disjoint label priority; zero volume => null shares', 'Guard §3.5; BE windows, EKO conventions', 'Unknown labels remain unclassified; no Signal/flow feedback into Guard', 'accounting', 'declaredAgent -> likelyAgent -> qualifiedCrew -> unclassified; agentPct=declared+likely; netNewQuote=externalBuyInflow-sellOutflow with fees separate; holder growth=unique first-positive addresses by provenance'),
  p('confirmation_lag', 30, 'seconds', 'canonical watermark >= horizon boundary +30', 'Guard §4.1; EKO operational reorg filter', 'Filter reorg tails; separate from L1 finality', 'ops'),
  p('harm_materiality', [1, 500, 10], 'percent F/USD/percent reserve', 'sold liquid >=1% openingF OR positive net trading cash-out >=500 OR gross sale receipts >=10% pre-campaign reserve', 'Guard §4.2; F/review correction, EKO candidate', 'Scale small-reserve harm without calling tiny ordinary profit harmful', 'harm'),
  p('harm_cohorts', [30, 10, 90, 90], 'loss percent/contribution pp/cost percent/position percent', 'mean net loss >=30%; cash-out >0; sell-only improvement >=10pp; cost and position coverage >=90%', 'Guard §4.2; EKO real-buyer cohort candidate', 'Prevent cherry-picked victims and synthetic-buyer attribution', 'harm'),
  p('withdrawal_label', [500, 99, 90, 600], 'USD/percent inventory/percent depth/seconds', 'pre-value >=500; inventory removed >=99%; token-wide depth lost >=90%; no reachable successor for >=600s', 'Guard §4.3; A Cernera/Huynh LP motivation, EKO inventory/depth adaptation', 'Migration/rebalancing is not removal; responsibility separate', 'harm', 'pre-value=realQuote+tokenInventory*pinnedMarginalPrice', null, 'T GMGN nonzero removal with >=0.5%S or $500, not contract drawdown'),
  p('collapse_label', [60, 100, 90, 60], 'entry seconds/USD/percent/checkpoint seconds', 'primary 60s $100 quantity; drawdown >=90%; peak >0; earliest cursor tie', 'Guard §4.3; A Mazorra drawdown motivation, EKO recovery/horizon adaptation', 'Do not import 30-day death test or blame operator for collapse', 'harm', '100*(peak-trough)/peak'),
  p('family_allocation', 100, 'points', 'one award per prohibited duplicate mechanism; maximize family-max sum; cap <=100', 'Guard §5.2; draft B, EKO allocation choice', 'Keep independent exposures; M E40/Ff40 plus N E20 must total60', 'score', 'base=min(100,E+O+Ff+C+I); tie ascending (E,Ff,O,C,I,factorId)', ['family_max', 'maximum_compatible_assignment']),
  p('history_booster', [2592000, 3600, 3, 50, 80, 604800, 30, 10, 15], 'seconds/seconds/launches/percent/percent/seconds/points/points/points', 'bad>=3; rate>=50/80%; recent<=604800s; base>=30; positive current E/O/C; complete eligible denominator', 'Guard §5.2; draft B integer booster, EKO gate', 'Strengthen present exposure only; exclude current launch/bots/collapse/clones', 'history', 'badRate=badMature/allAssessedMature; boost=10 or15; score=min(100,base+boost); no denominator =>unknown and boost0'),
  p('candidate_coverage', [300, 1, 95, 15, 30, 50, 3], 'seconds/percent S/percent F/coordination percent/percent/percent/hops', 'all launch recipients [t0,t0+300), principal descendants, holders>=1%S, rolling later buys; coverage>=95%F; all possible>=15%F components assessed; unresolved cannot cross next15/30/50 boundary; hops<=3', 'Guard §5.3; EKO candidate coverage', 'Defeat fragmented 200x0.2% holders; queue largest unresolved then newest then address', 'graph', 'worstCaseUnion=min(F,qualifiedUnion+unresolvedLiquid)'),
  p('signal_adapter', [0, 50, 100, 25, 10, 15], 'reading/points', 'High =>0; any tier gap/control unknown =>50 lowData; otherwise floor0; no Hot with gaps', 'Guard §7.2; BE/C five readings, EKO adapter', 'Keep five readings and power/LP inputs without treating neutral placeholder as measurement', 'context', 'max(0,100-25*isElevated-10*confirmedPowerCount-15*isRemovableLP)'),
  p('free_limiter', 3, 'request starts/second', 'starts <=3; adjust after measured latency/errors', 'Guard §8.2; F measured5–6 starts/s, EKO reserve', 'Keep below measured free ceiling, paid throughput separate', 'ops'),
  p('incremental_caps', [1, 10, 250000], 'USD/day/USD initial/request units', 'enrichment <=1/day; initial <=10; checkpoint at250000; paid jobs require recorded owner approval', 'Guard §8.2; EKO proposed owner resource policy', 'Meter candidate/local work before whole-chain approach', 'ops'),
  p('calibration_frame', [14, 7, 4, 7, 21, 3900, 604800, 30, 51], 'days/seconds', 'development [D,D+7d); fit [D,D+4d); validation [D+4d,D+7d); test [D+7d,D+14d); through D+21d; purge3900s; seven-day fitting purge604800s', 'Guard §8.3; C2 selective frame, EKO schedule', 'Freeze availability/groups/truths; no seven-day label leakage', 'benchmark'),
  p('throughput', 170, 'cached evaluations/second', '>=170 on frozen200k; evaluator RPC=0; bounded memory and deterministic resume', 'Guard §8.4; C2 replay reference, EKO target', 'Returning missing quickly is not completing coverage', 'ops'),
  p('benchmark_trajectories', [5, 30, 60, 300, 100, 1000, 3600, 300, 86400, -30, 50, 60, 300], 'seconds/USD/percent', 'entry first block >=delay; primary delay60, exit3600; sensitivities exit300/86400, stop<=-30%, take>=50%; checkpoints60; retry through300s never replaces failure', 'Guard §9.1; BE sizes, EKO paired benchmark', 'Reproducible exposure, never optimized on held-out strategy', 'benchmark'),
  p('severely_hurt', -30, 'return percent', 'return <=-30 OR verified scheduled exit inability', 'Guard §9.1; EKO buyer-loss candidate', 'Separate current exit/cost/capability from future harm', 'benchmark', '100*(netExitQuoteUsd-allInEntryUsd)/allInEntryUsd; denominator>0', [-10, -30, -50, -90]),
  p('sample_design', [600, 100, 75, 75, 100, 250], 'distinct tokens/stratum quotas', 'disjoint priority strata; n_h=min(target_h,N_h); vacancies remainder then priority; freeze before labels', 'Guard §9.3; draft B workload, EKO probability adaptation', 'Exact inclusion probabilities avoid purposive prevalence and silent top-up', 'benchmark', 'pi_i=n_h/N_h; whole frame<600 => census'),
  p('parity_workload', 100, 'matched tool snapshots', 'matched >=100 exact token/chain/time/size/route', 'Guard §9.3; EKO workload', 'Expose denominator and role omissions; supported fields only', 'benchmark'),
  p('bootstrap', [2000, 95], 'resamples/confidence percent', '2000 weighted operator/component resamples; CI95%; conservative unresolved grouping', 'Guard §9.4; EKO policy start', 'Respect correlated paths and sample weights, no weighted Wilson', 'benchmark'),
  p('high_gate', [90, 85, 100], 'precision percent/lower CI percent/coins', 'weighted precision >=90%; lower95CI>=85%; known-outcome High>=100 per primary size/class untouched test', 'Guard §9.4; BE90% precision, EKO CI/count', 'Bound false High refusals; report factual precision separately', 'benchmark'),
  p('recall_gate', [85, 75, 50, 100], 'recall percent/lower CI percent/High-only percent/coins', 'Elevated-or-High recall>=85%; lowerCI>=75%; High-only>=50%; hurt>=100 per cohort; incomplete not success', 'Guard §9.4; EKO policy starts', 'Avoid selecting only easy positives', 'benchmark'),
  p('lower_gate', [10, 15, 100], 'harm percent/upper CI percent/coins', 'harm<=10%; upper95CI<=15%; fully checked Lower>=100 per cohort; no critical missed restriction', 'Guard §9.4; EKO policy starts', 'No Lower deployment without measured coverage sample', 'benchmark'),
  p('attribution_gate', [95, 90, 100, 30], 'precision percent/lower CI percent/assertions/components', 'precision>=95%; lowerCI>=90%; reviewed held-out positives>=100 across>=30 components', 'Guard §9.4; EKO policy starts', 'False operator blame requires independent high-precision review', 'graph'),
  p('restriction_gate', [100, 95], 'fixture detection percent/real recall percent', 'supported reproduced fixtures detection=100%; reviewed real restriction recall>=95%', 'Guard §9.4; EKO policy starts', 'Unsupported coverage remains omission', 'execution'),
  p('instruction_gate', 95, 'reviewed precision percent', 'precision>=95%; policy/execution influence=0; I points alone below Elevated', 'Guard §§3.5/9.4; EKO policy starts', 'Negated/quoted instructions cannot promote a detector', 'context'),
  p('measurement_gate', [1, 30], 'error percent/cases', 'quote/fill error<=1%; no harm reversal; diverse cases>=30 per supported venue/size/class', 'Guard §§9.1/9.4; EKO fidelity start', 'Validate paper paths against persistent/actual execution', 'execution'),
  p('parity_gate', 0, 'critical omission errors', 'critical denominator/role omissions=0; unanswerable fraction <= comparator on supported fields', 'Guard §9.3; EKO parity start', 'Freeze feasible response-time/coverage target from pilot before test', 'benchmark'),
  p('live_shadow_gate', [604800, 5000], 'seconds/launches', 'elapsed>=604800 AND launches>=5000 plus all late follow-up horizons/confirmation', 'Guard §9.4; EKO weekly workload', 'Shadow cannot influence orders or active badge', 'ops'),
  p('maintenance_sample', 200, 'newly stratified coins/month', 'sample>=200 in UTC calendar month plus controls; expand on interval/regime changes', 'Guard §9.5; EKO drift workload', 'No optimizer auto-promotion; new frozen evidence per change', 'ops'),
] satisfies GuardParameter[]);
const tiers = {
  execution_cost: { unit: 'venue cost percent', operator: '>=', cuts: [5, 10, 25, 50], points: [10, 20, 40, 60], inputs: 'worst valid independent $100/$1k quote; tie $100 then class' },
  thin_depth: { unit: 'USD', operator: '<', cuts: [10000, 2000, 500], points: [10, 20, 40], inputs: 'minimum buy/sell 2% marginal depth' },
  operator_hold: { unit: 'percent F', operator: '>=', cuts: [5, 10, 20], points: [20, 35, 50], inputs: 'present liquid authenticated operator units/F' },
  coordinated_hold: { unit: 'percent F', operator: '>=', cuts: [15, 30, 50], points: [20, 35, 50], inputs: 'largest qualified component with >=3 participants' },
  coordinated_union: { unit: 'percent F', operator: '>=', cuts: [15, 30, 50], points: [20, 35, 50], inputs: 'deduplicated union of qualified >=3-wallet components' },
  top10_float: { unit: 'percent F', operator: '>=', cuts: [40, 60, 80], points: [20, 35, 50], inputs: 'max valid raw/control top10/F; GMGN strict >40/60 adapted to >=, 80 EKO' },
  launch_linked_hold: { unit: 'percent F', operator: '>=', cuts: [10, 20, 30], points: [20, 35, 50], inputs: 'liquid candidate union/F with distribution exclusions' },
  principal_origin_hold: { unit: 'percent F', operator: '>=', cuts: [10, 20, 30], points: [20, 35, 50], inputs: 'traced liquid principal-origin lots/F; separate gift/distribution gate' },
  early_origin_hold: { unit: 'percent F', operator: '>=', cuts: [20, 50], points: [10, 20], inputs: 'first-trade-five-second liquid overhang; timing-only cap20' },
  persistent_sniper_hold: { unit: 'percent F', operator: '>=', cuts: [30], points: [35], inputs: 'complete recurrence-qualified union/F, not operator attribution' },
  authenticated_dominance: { unit: 'percent F', operator: '>=', cuts: [70], points: [60], inputs: 'one authenticated control group/F; organic control negatives' },
  horizon_release: { unit: 'percent F+release', operator: '>=', cuts: [5, 10, 20], points: [20, 35, 50], inputs: 'operator releasable within3600/(F+release); current F unchanged' },
  current_sell_pressure: { unit: 'percent F/pressure percent', operator: '>= AND >=', cuts: [[5, 10], [15, 30]], points: [20, 40], inputs: 'sold/openingF AND measured pressure in trailing300s' },
  campaign_pressure: { unit: 'percent F/pressure percent', operator: '>= AND >=', cuts: [[5, 10], [15, 30]], points: [20, 40], inputs: 'same quantities/pressure, full trailing3600/86400 coverage' },
  harmful_selling: { unit: 'qualified event/seconds', operator: 'closed within <=3600', cuts: [3600], points: [40], inputs: 'complete §4.2 non-operator/origin-unresolved harmful campaign' },
  operator_dump: { unit: 'qualified event/seconds', operator: 'closed within <=3600', cuts: [3600], points: [60], inputs: 'complete §4.2 authenticated own-side harmful dump' },
  mutable_control: { unit: 'tax ceiling percent/mint dilution percent S', operator: '<=5; >5 AND <=30/20; >30/20', cuts: [[5, 30], [5, 20]], points: [0, 20, 35], inputs: 'reachable bounded tax or liquid mint change within3600' },
  arbitrary_control: { unit: 'verified capability', operator: 'reachable within <=3600', cuts: [3600], points: [60], inputs: 'unrestricted liquid mint, arbitrary blacklist/sell pause, transfer-code upgrade tested' },
  removable_depth: { unit: 'percent token-wide sell2 depth', operator: '>=', cuts: [50], points: [35], inputs: 'operator withdrawal capability across supported reachable routes' },
  exercised_control: { unit: 'execution loss percent', operator: '>=', cuts: [25], points: [40], inputs: 'independently reproduced effective control/hook loss; no duplicate cost/restriction' },
  cycling: { unit: 'percent hourly gross USD', operator: '>=', cuts: [50, 80], points: [5, 10], inputs: 'reviewed high-confidence estimate, volume>=10000, buyer exposure' },
  agent_instruction: { unit: 'reviewed predicate', operator: 'target AND imperative action', cuts: [], points: [10], inputs: 'qualified §3.5 reviewed instruction, inert Untrusted boundary' },
} as const;
export const GUARD_FACTORS = freeze(GUARD_FACTOR_IDS.map((id) => ({
  id, family: GUARD_FACTOR_FAMILIES[id], ...tiers[id], status: 'shadow' as const,
  parameter: p(`factor.${id}`, { cuts: tiers[id].cuts, points: tiers[id].points }, tiers[id].unit, tiers[id].operator, `Guard §5.1; draft B with EKO corrections${id === 'top10_float' ? '; T GMGN inclusivity adaptation' : ''}`, 'Separate current buyer exposures; family maxima limit overlap; choose greatest matching tier', 'score', tiers[id].inputs, { weights: 'base and +/-20%, nearest integer half upward' }),
  gate: [...methods.score[1], ...(GUARD_FACTOR_FAMILIES[id] === 'O' || id === 'operator_dump' ? ['attribution' as const] : []), ...(id === 'agent_instruction' ? ['instruction' as const] : []), ...(GUARD_FACTOR_FAMILIES[id] === 'E' || GUARD_FACTOR_FAMILIES[id] === 'C' ? ['measurement_fidelity' as const] : [])],
  acceptanceArtifact: null,
})));
export const GUARD_INFORMATIONAL = freeze({ clone: 0, launch_count: 0, exemption: 0, freshness: 0, fixed_fee_income: 0, hook_permission_bits: 0, curve_recycling: 0, cash_severity_context: 0 });
export const GUARD_CHECKS = freeze(GUARD_CHECK_IDS.map((id) => ({ id, tier: GUARD_CHECK_TIERS[id], status: 'shadow' as const, source: 'Guard §5.3', methodVersion: GUARD_CANDIDATE_VERSION, gate: ['contracts', 'measurement_fidelity', ...(GUARD_CHECK_TIERS[id] === 'lower_tier' ? ['attribution'] : [])], acceptanceArtifact: null, completion: {
  reference_exit: 'Both $100/$1k and EOA/smart-account valid pinned analysis or proved entry limit; >=1 executable reference entry; no unexplained probe/cooldown failure',
  effective_fees: 'Effective total charges and applicable schedule/recipients reconciled; component breakdown may remain unknown',
  controls_hooks: 'Effective implementation, reachable authorities/bounds and horizon changes assessed; absent or bounded supported findings',
  supply_float: 'S/D/K/U/P/C/F reconciled, complete relevant transfers/liquid balances, positive stable F and known custody',
  recent_funding: 'Successful external/internal native and relevant quote intervals covered; eligible candidates/non-service paths assessed',
  coordination_coverage: 'Origin/direct actor/lot universe assessed; >=95%F; unresolved bound cannot cross next15/30/50%; all connected possible>=15%F assessed',
  launcher_service: 'Principal/service ambiguity resolved or evidenced history inapplicability for secondary non-launch listing; unsupported is missing',
  operator_history: 'Resolved operator complete supported-universe30d enumeration/all mature outcomes or proved no eligible history; booster release separate',
}[id] })));
// TODO(spec): the spec requires explicit duplicate compatibility but leaves the
// concrete matrix unspecified. Suppress only these proved config/episode keys.
export const GUARD_COMPATIBILITY = freeze({ version: GUARD_CANDIDATE_VERSION, default: 'compatible', proofRequired: true, prohibitedSameMechanism: [
  { key: 'implementation_capability_effective_config', factors: ['execution_cost', 'mutable_control', 'exercised_control'] },
  { key: 'episode_action', factors: ['current_sell_pressure', 'campaign_pressure', 'harmful_selling', 'operator_dump'] },
], allocation: 'maximize sum of family maxima; tie ascending E,Ff,O,C,I,factorId' });
export const GUARD_DECISIVE = freeze([
  { id: 'sell_block', formula: 'reproduced token-caused block for valid acquired position', gate: ['contracts', 'measurement_fidelity', 'restrictions'] },
  { id: 'confiscatory_return', formula: 'returned <5% independently valid no-tax output', gate: ['contracts', 'measurement_fidelity', 'restrictions'] },
  { id: 'no_sell_capacity', formula: 'complete supported routes prove no executable $100 sell', gate: ['contracts', 'measurement_fidelity', 'restrictions'] },
  { id: 'liquidity_withdrawn', formula: 'qualified token-wide withdrawal; depth still absent', gate: ['contracts', 'measurement_fidelity', 'attribution'] },
  { id: 'severe_cost', formula: 'venue loss >=50% at executable reference size; identify cause', gate: ['contracts', 'measurement_fidelity', 'factor_promotion'] },
].map((v) => ({ ...v, status: 'shadow' as const, acceptanceArtifact: null, source: 'Guard §5.1' })));
export const GUARD_RELEASE_GATES = freeze(GUARD_GATE_IDS.map((id) => ({ id, source: 'Guard §9.4', status: 'unpassed' as const, artifact: null, requirement: {
  contracts: 'Zero accepted arithmetic/denominator/role/provenance errors; 38 C1 scenarios; two-tier/null/Safe/High, legacy proofs/shapes, Untrusted, no-lookahead',
  measurement_fidelity: '<=1% matched execution error, no harm reversal; >=30 diverse cases per supported venue/size/class',
  high_precision: 'Weighted>=90%,95% lowerCI>=85%,>=100 distinct known-outcome High per primary size/class untouched test',
  harm_recall: 'Elevated-or-High>=85%,lowerCI>=75%,High-only>=50%,>=100 hurt test coins per primary cohort; Incomplete not success',
  lower_harm: '<=10% severe harm,95% upperCI<=15%,>=100 fully checked known-outcome Lower per primary cohort; no missed critical restriction; bands distinguishable/ordered',
  attribution: 'Precision>=95%,lowerCI>=90%,>=100 held-out positives across>=30 independent components; each launch once, separate edge/outcome/history ablations',
  restrictions: '100% supported reproduced fixture detection and>=95% reviewed supported real recall; unknown omission reported',
  instruction: 'Reviewed precision>=95% including quotation/negation; zero policy/execution influence; points alone below Elevated',
  factor_promotion: 'Factual invariant/review and heuristic ablation improves recall/exposure without breaking whole-band/attribution gates',
  operations: 'Frozen200k>=170/s,zero evaluator RPC,bounded memory/resume; preflight p95<150ms; approved cap; separate queue/completion latency, false refusals/censoring; pilot targets frozen before test',
  parity: 'Zero critical denominator/role omissions; no worse supported-field unanswerable fraction; pilot response-time/coverage target frozen',
  live_shadow: '>=604800s AND >=5000 launches plus late horizon/confirmation follow-up; frozen hashes/revisions/logs; no active influence',
  maintenance: 'Calendar UTC month>=200 stratified coins plus controls; version/hash/new held-out evidence on any semantic change',
}[id] })));
export const CONFIG_GUARD_V2 = freeze({ sourceRevision: GUARD_SOURCE_REVISION, rulesVersion: GUARD_CANDIDATE_VERSION, identityVersion: GUARD_CANDIDATE_VERSION, measurementVersion: GUARD_CANDIDATE_VERSION, outcomeVersion: GUARD_CANDIDATE_VERSION, mode: 'shadow', lowerEnabled: false, boosterEnabled: false, parameters: GUARD_PARAMETERS, factors: GUARD_FACTORS, checks: GUARD_CHECKS, decisive: GUARD_DECISIVE, informational: GUARD_INFORMATIONAL, compatibility: GUARD_COMPATIBILITY, gates: GUARD_RELEASE_GATES });
