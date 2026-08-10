import { z } from 'zod';
import { AddressSchema } from './common.js';
import { GUARD_CHECK_IDS, GUARD_CHECK_TIERS, GUARD_FACTOR_IDS, GUARD_FACTOR_FAMILIES, GUARD_DECISIVE_IDS, GUARD_FAILURE_CODES, GUARD_SUPPRESSION_CODES, GUARD_COHORT_IDS, GUARD_CAPABILITIES, GUARD_METRIC_IDS } from './guard-ids.js';

const object = z.strictObject;
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const points = z.number().int().min(0).max(100);
const chainId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,191}$/);
const version = z.string().regex(/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/);
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const uint = z.string().regex(/^(0|[1-9]\d*)$/);
const signedInteger = z.string().regex(/^(0|-?[1-9]\d*)$/);
const decimal = z.string().regex(/^(?:0|-?[1-9]\d*)(?:\.\d*[1-9])?$|^-0\.\d*[1-9]$/);
const unsignedDecimal = decimal.refine((v) => !v.startsWith('-'), 'Unsigned quantity required');
const positiveDecimal = unsignedDecimal.refine((v) => /[1-9]/.test(v), 'Positive denominator required');
const failure = z.enum(GUARD_FAILURE_CODES);
const metricId = z.enum(GUARD_METRIC_IDS);
const checkId = z.enum(GUARD_CHECK_IDS);
const factorId = z.enum(GUARD_FACTOR_IDS);
const family = z.enum(['E', 'O', 'Ff', 'C', 'I']);
const accountClass = z.enum(['eoa', 'smart_account']);
const action = z.enum(['buy', 'approve', 'transfer', 'send', 'bypass_checks', 'change_policy']);
const capability = z.enum(GUARD_CAPABILITIES);
const controlStatus = z.enum(['verified', 'candidate', 'unknown', 'not_applicable']);
const attribution = z.enum(['operator', 'non_operator', 'origin_unresolved', 'unknown']);
const boundCode = z.enum(['absent', 'bounded', 'unrestricted', 'unknown']);
const retryCode = z.enum(['refresh', 'coverage_available', 'cooldown_elapsed', 'profile_supported', 'calibration_accepted', 'none']);
const lpStatus = z.enum(['burned', 'locked', 'removable', 'pons_locked']);
const untrusted = object({ text: z.string(), truncated: z.boolean(), flags: z.array(z.enum(['agent_bait', 'link', 'impersonation'])) });
const rawAmount = object({ asset: AddressSchema, decimals: z.number().int().min(0).max(255), raw: uint });
const rational = object({ numerator: signedInteger, denominator: uint.refine((v) => v !== '0', 'Positive denominator required') });
const rationalBounds = object({ lower: rational, upper: rational }).refine((v) => BigInt(v.lower.numerator) * BigInt(v.upper.denominator) <= BigInt(v.upper.numerator) * BigInt(v.lower.denominator), 'Ordered error bounds required');
const cursor = object({ chainId, blockNumber: uint, blockHash: hash, transactionIndex: count.nullable(), executionOrdinal: count.nullable(), timestampSec: uint, boundary: z.enum(['block_end', 'before_tx', 'after_tx']) }).superRefine((v, ctx) => {
  if (v.boundary === 'block_end' ? v.transactionIndex !== null || v.executionOrdinal !== null : v.transactionIndex === null || v.executionOrdinal === null) ctx.addIssue({ code: 'custom', message: 'Boundary and transaction cursor disagree' });
});
const availability = object({ cursor, acquisitionSequence: uint });
const coverage = object({ scopeId: id, from: cursor.nullable(), through: cursor.nullable(), complete: z.boolean(), gaps: z.array(failure), methodVersion: version, coveredUnits: rawAmount.nullable(), excludedUnits: rawAmount.nullable(), topLevelNative: z.boolean(), internalNative: z.boolean(), firstEverEstablished: z.boolean(), sourceHashes: z.array(hash) }).superRefine((v, ctx) => {
  if (v.complete && v.gaps.length) ctx.addIssue({ code: 'custom', path: ['gaps'], message: 'Completed coverage cannot have gaps' });
  if (v.from && v.through && (v.from.chainId !== v.through.chainId || BigInt(v.from.blockNumber) > BigInt(v.through.blockNumber))) ctx.addIssue({ code: 'custom', message: 'Invalid coverage interval' });
});
const quantity = z.union([rawAmount, decimal]);
const unit = z.enum(['raw', 'decimal', 'usd', 'quote', 'pct', 'pp', 'ratio', 'seconds', 'count', 'address', 'hash', 'boolean', 'status', 'compound']);

/** Guard §§3.1/7.1: unknown is null; bounded evidence is never an exact observation. */
export function createGuardMetric<T extends z.ZodType>(value: T) {
  const base = { id: metricId, unit, cursor, knownAt: availability, numerator: quantity.nullable(), denominator: quantity.nullable(), denominatorKind: z.enum(['S', 'C', 'F', 'quote_cost', 'gross_volume', 'other']).nullable(), fromSec: uint.nullable(), throughSec: uint, coverage, methodVersion: version, evidenceIds: z.array(hash), failureCode: failure.nullable(), errorBounds: rationalBounds.optional() };
  return z.discriminatedUnion('status', [
    object({ ...base, status: z.literal('observed'), value }),
    object({ ...base, status: z.literal('lower_bound'), value }),
    object({ ...base, status: z.literal('upper_bound'), value }),
    object({ ...base, status: z.literal('unknown'), value: z.null() }),
    object({ ...base, status: z.literal('not_applicable'), value: z.null() }),
  ]).superRefine((v, ctx) => {
    const available = v.status === 'observed' || v.status === 'lower_bound' || v.status === 'upper_bound';
    const amount = (q: z.infer<typeof quantity>) => typeof q === 'string' ? q : q.raw;
    if (available && (v.denominatorKind !== null || v.unit === 'ratio' || v.unit === 'pct') && (v.numerator === null || v.denominator === null || !positiveDecimal.safeParse(amount(v.denominator)).success)) ctx.addIssue({ code: 'custom', path: ['denominator'], message: 'Ratio requires exact numerator and positive denominator' });
    if (available && v.denominator !== null && !positiveDecimal.safeParse(amount(v.denominator)).success) ctx.addIssue({ code: 'custom', path: ['denominator'], message: 'Positive denominator required' });
    if (available && v.numerator !== null && v.denominator !== null && typeof v.numerator === 'object' && typeof v.denominator === 'object' && (v.numerator.asset !== v.denominator.asset || v.numerator.decimals !== v.denominator.decimals)) ctx.addIssue({ code: 'custom', message: 'Raw ratio assets/decimals must agree' });
    const metricValue: unknown = (v as { value?: unknown }).value;
    const zero = metricValue === false || metricValue === 0 || metricValue === '0' || (typeof metricValue === 'object' && metricValue !== null && 'raw' in metricValue && metricValue.raw === '0');
    if (available && zero && !v.coverage.complete) ctx.addIssue({ code: 'custom', path: ['coverage'], message: 'Known zero requires complete coverage' });
    if (v.status === 'observed' && v.failureCode !== null) ctx.addIssue({ code: 'custom', path: ['failureCode'], message: 'Observed metric cannot carry failure' });
    if (v.status === 'unknown' && v.failureCode === null) ctx.addIssue({ code: 'custom', path: ['failureCode'], message: 'Unknown metric requires named failure' });
    if (available && metricValue === null) ctx.addIssue({ code: 'custom', path: ['value'], message: 'Available metric requires value' });
    if (v.fromSec !== null && BigInt(v.fromSec) > BigInt(v.throughSec)) ctx.addIssue({ code: 'custom', message: 'Invalid metric interval' });
    if (v.cursor.chainId !== v.knownAt.cursor.chainId || BigInt(v.cursor.blockNumber) > BigInt(v.knownAt.cursor.blockNumber)) ctx.addIssue({ code: 'custom', message: 'Metric cannot be known before its state' });
  });
}
const metric = createGuardMetric;
const dm = metric(decimal), um = metric(unsignedDecimal), rm = metric(rawAmount), am = metric(AddressSchema), cm = metric(count), tm = metric(uint), hm = metric(hash);
const assetBalances = object({ amounts: z.array(rawAmount) });
const quoteAmounts = object({ asset: AddressSchema, decimals: count.max(255), amount: decimal });
const shares = object({ raw: rm, liquid: rm, locked: rm, supplyPct: um, floatPct: um });
const dispositions = object({ openingLiquid: rm, externalAcquisition: rm, held: rm, sold: rm, burned: rm, locked: rm, netTransferredOut: metric(quoteAmounts), fees: rm, unexplainedResidual: metric(quoteAmounts), cexDeposits: rm });
const positionMetrics = object({ ...shares.shape, grossBought: rm, sold: rm, dispositions, marketCashOutMultiple: um, allInCashOutMultiple: um, realizedLotMultiple: um, basisCoveragePct: um });
const cohort = object({ ...positionMetrics.shape, cohortId: z.enum(GUARD_COHORT_IDS), window: z.enum(['first_trade_5s', 'launch_5s', 'launch_60s', 'launch_300s', 'lifetime', 'trailing_30d']), memberIds: z.array(AddressSchema), fromSec: uint.nullable(), throughSec: uint, membershipHash: hash.nullable() });
const group = object({ id: hash, kind: z.enum(['control', 'coordination', 'origin']), memberIds: z.array(AddressSchema), edgeIds: z.array(hash), graphVersion: version, supersedes: z.array(hash) });
const role = object({ address: am, role: z.enum(['factory_deployer', 'outer_signer', 'launch_principal', 'creation_payer', 'buy_payer', 'buy_recipient', 'sell_source', 'proceeds_recipient', 'fee_recipient', 'treasury', 'custodian', 'locker', 'exempt']), effectiveCursor: cursor, evidenceIds: z.array(hash) });
const pool = object({ id, venue: z.enum(['uniswap_v3', 'uniswap_v4', 'pons_curve', 'other']), address: AddressSchema.nullable(), poolId: hash.nullable(), quote: AddressSchema, feeBps: um, hooks: am, coverage });
const service = object({ status: z.enum(['confirmed', 'candidate', 'unresolved', 'not_applicable']), address: am, codeHash: hash.nullable(), implementation: am, effectiveCursor: cursor, registryVersion: version, launches: cm, principals: cm, distinctPairsPct: um, degree: cm, degreeCoverage: coverage, evidenceIds: z.array(hash) });
const collision = object({ tokenId: object({ chainId, address: AddressSchema }), normalizationVersion: version, nameMatches: z.boolean(), symbolMatches: z.boolean(), trustedAuthenticity: controlStatus, trendOnset: tm, trendRank: cm, dominantPairShare: um });
const feeComponents = object({ total: dm, ordinary: dm, creator: dm, temporary: dm, hook: dm, eko: dm, gas: dm });
const antiSnipe = object({ effectiveTaxPct: um, startsAt: tm, endsAt: tm, decayMethod: z.enum(['linear', 'step', 'none', 'unsupported']), exemptions: z.array(role), evidenceIds: z.array(hash) });
const power = object({ capability, reachable: metric(z.boolean()), authority: am, boundCode, bound: dm, delaySec: tm, earliestExecution: tm, implementationHash: hash.nullable(), configurationHash: hash.nullable(), evidenceIds: z.array(hash) });
const hook = object({ address: am, implementationHash: hash.nullable(), powers: z.array(power), quoteSimGapPct: um, asymmetricFeePp: dm, coverage });
const quote = object({ sizeUsd: z.union([z.literal(100), z.literal(1000), z.literal(10000)]), accountClass, routeId: id.nullable(), entry: metric(z.enum(['executable', 'entry_limited'])), input: rm, tokensReceived: rm, returned: rm, venueCostPct: dm, allInCostPct: dm, gasUsd: um, feeBreakdown: metric(feeComponents), sellability: metric(z.enum(['executable', 'token_restricted', 'capacity_absent'])), maxTxUsd: um, maxWalletSupplyPct: um });
const positionExit = object({ accountClass, owner: AddressSchema, routeId: id.nullable(), quantity: rm, netProceeds: metric(quoteAmounts), discountPct: dm, sellability: metric(z.enum(['executable', 'token_restricted', 'capacity_absent'])) });
const solver = object({ method: z.enum(['exact', 'bracket_refine', 'unsupported']), evaluations: count.max(48), monotonicityProved: z.boolean(), lowerUsd: unsignedDecimal.nullable(), upperUsd: unsignedDecimal.nullable(), relativeWidthPct: unsignedDecimal.nullable(), errorBounds: rationalBounds.nullable(), domain: object({ startUsd: unsignedDecimal, capUsd: unsignedDecimal, maximumInput: uint.nullable(), inputUsd: object({ numerator: uint, denominator: uint.refine(v=>v!=='0') }), precisionUsd: positiveDecimal }).optional(), termination: z.enum(['refined', 'venue_maximum', 'search_cap', 'evaluation_cap', 'raw_precision', 'unsupported']).optional(), lowerInput: uint.nullable().optional(), upperInput: uint.nullable().optional(), remoteSearchCalls: z.literal(0).optional() });
const directionalDepth = object({ routeId: id, direction: z.enum(['buy', 'sell']), discountPct: z.union([z.literal(2), z.literal(5), z.literal(10)]), usd: um, solverBounds: solver });
const position = object({ poolId: id, controller: am, custody: z.enum(['burned', 'locked', 'removable', 'pons_locked', 'unknown']), lock: rm, release: rm, releaseAt: tm, reserves: metric(assetBalances), removalCoverage: coverage, evidenceIds: z.array(hash) });
const candidate = object({ id: hash, memberIds: z.array(AddressSchema), edgeIds: z.array(hash), evidenceClass: z.enum(['authenticated_control', 'private_payer', 'recent_material_funder', 'collector', 'closed_loop', 'bounded_path', 'medium_path', 'consolidation', 'soft_cohort']), status: controlStatus, held: metric(shares), upperFloatPct: um, fundingRatio: um, collectionRatio: um, coverage, evidenceIds: z.array(hash) });
const queuedChange = object({ id: hash, capability, authority: am, earliestExecution: tm, units: rm, bound: dm, evidenceIds: z.array(hash) });
// TODO(spec): 035 requires no-verdict cards; §7.1's pseudocode makes verdict
// mandatory. Null preserves indexed partial facts without inventing an assessment.
// TODO(spec): §7.1 describes compound fields but not their wire names. These closed
// records use §§3.2–5.2 names; consumer packets must preserve/version this candidate.
const interval = { from: cursor, through: cursor, sideId: hash, attribution, coverage, evidenceIds: z.array(hash) };
const sales = { soldUnits: rm, openingLiquid: rm, externalAcquisition: rm, openingFloat: rm, openingSupply: rm, openingRealReserve: metric(quoteAmounts), soldShare: um, soldFloatPct: um, soldSupplyPct: um, grossSaleReceipts: metric(quoteAmounts), netSaleReceipts: metric(quoteAmounts), netTradingCashOut: metric(quoteAmounts), pressure: um, buyerLossPct: dm, contributionPp: dm, cohortCostCoveragePct: um, cohortPositionCoveragePct: um };
const saleEpisode = object({ id: hash, ...interval, ...sales, status: z.enum(['open', 'closed', 'indeterminate']), transactionIds: z.array(hash), originSold: rm, intervention: z.enum(['sell_only', 'net_trading', 'unavailable']), interventionStatus: z.enum(['valid', 'invalid', 'unavailable']) });
const campaign = object({ id: hash, ...interval, ...sales, windowSec: z.union([z.literal(300), z.literal(3600), z.literal(86400)]), episodeIds: z.array(hash), transactionIds: z.array(hash) });
const outcome = object({ id: hash, coin: AddressSchema, kind: z.enum(['dump', 'harmful_disposition', 'rug', 'restriction', 'collapse', 'survived']), status: z.enum(['provisional', 'confirmed_under_policy', 'indeterminate', 'censored']), horizonSec: z.union([z.literal(3600), z.literal(86400), z.literal(604800)]), entryCursor: cursor, maturityCursor: cursor.nullable(), knownAt: availability, attribution, controller: am, sizeUsd: z.union([z.literal(100), z.literal(1000)]), accountClass, returnPct: dm, peakLiquidationValue: metric(quoteAmounts), troughLiquidationValue: metric(quoteAmounts), horizonLiquidationValue: metric(quoteAmounts), drawdownPct: um, buyerLossPct: dm, contributionPp: dm, removalValueUsd: um, removedInventoryPct: um, lostDepthPct: um, successorStatus: z.enum(['reachable', 'absent', 'unknown', 'not_applicable']), cohortCostCoveragePct: um, cohortPositionCoveragePct: um, coverage, evidenceIds: z.array(hash), supersedes: id.nullable() });
const history = object({ operatorGroup: group.nullable(), windowSec: z.literal(2592000), horizonSec: z.literal(3600), from: cursor, through: cursor, enumeration: coverage, assessment: coverage, eligibleMature: count, assessedMature: count, badMature: count, badRate: um, recentAdverse: hm, booster: z.enum(['shadow', 'released', 'disabled']), outcomeIds: z.array(hash) }).superRefine((v, ctx) => {
  if (v.badMature > v.assessedMature || v.assessedMature > v.eligibleMature) ctx.addIssue({ code: 'custom', message: 'History counts must nest' });
  if (v.assessment.complete && v.assessedMature !== v.eligibleMature) ctx.addIssue({ code: 'custom', message: 'Complete history assesses every eligible launch' });
});
const reasonParameters = {
  EXIT_COST: object({ sizeUsd: z.union([z.literal(100), z.literal(1000), z.literal(10000)]), returnedUsd: decimal.nullable(), snapshotId: id, costPct: decimal, gasUsd: unsignedDecimal.nullable(), breakdownStatus: z.enum(['complete', 'unavailable', 'partial']) }),
  DEPTH: object({ buyDepthUsd: unsignedDecimal.nullable(), sellDepthUsd: unsignedDecimal.nullable(), routeId: id }),
  ENTRY_LIMIT: object({ sizeUsd: unsignedDecimal, accountClass, limitCode: z.enum(['max_tx', 'max_wallet', 'account_class', 'entry_unavailable']) }),
  SELL_RESTRICTION: object({ accountClass, sizeUsd: unsignedDecimal }),
  CONTROL: object({ authorityRole: z.enum(['principal', 'operator', 'controller', 'unknown']), capability, codeHash: hash, boundCode, executionTime: uint.nullable() }),
  GROUP_HELD: object({ groupType: z.enum(['principal', 'operator', 'coordination', 'insider_candidate', 'exempt', 'early', 'persistent', 'fresh', 'origin']), liquidUnits: rawAmount, supplyPct: unsignedDecimal, floatPct: unsignedDecimal, linkClass: z.enum(['control', 'coordination', 'origin', 'candidate', 'unknown']) }),
  TOP_HOLDERS: object({ holderCount: count.max(10), rawPct: unsignedDecimal, groupPct: unsignedDecimal.nullable() }),
  EARLY_BUYERS: object({ grossBoughtPct: unsignedDecimal, heldPct: unsignedDecimal }),
  SAME_BLOCK: object({ recipientCount: count, buyUsd: unsignedDecimal, boughtPct: unsignedDecimal, controlStatus }),
  ORIGIN_SALE: object({ sellerAddress: AddressSchema, controlStatus, soldUnits: rawAmount, basisCoveragePct: unsignedDecimal }),
  SELL_PRESSURE: object({ sellerClass: attribution, soldPct: unsignedDecimal, windowSec: z.union([z.literal(300), z.literal(3600), z.literal(86400)]), pressurePct: unsignedDecimal, attributionStatus: attribution }),
  ATTRIBUTED_DUMP: object({ soldPct: unsignedDecimal, denominatorName: z.enum(['opening_float', 'opening_supply', 'opening_liquid_plus_acquired']), netQuote: quoteAmounts, lossPct: decimal, interventionType: z.enum(['sell_only', 'net_trading']), contributionPp: decimal }),
  EXEMPTIONS: object({ count, affiliatedCount: count }),
  CYCLING: object({ sharePct: unsignedDecimal, volumeUsd: unsignedDecimal, classificationStatus: z.enum(['reviewed', 'candidate', 'unknown']) }),
  CLONE: object({ tokenId: object({ chainId, address: AddressSchema }) }),
  HISTORY: object({ badCount: count, matureCount: count, historyWindowSec: z.literal(2592000), exposureType: z.enum(['execution', 'ownership', 'control']), historyPoints: z.union([z.literal(0), z.literal(10), z.literal(15)]) }),
  TEXT_INSTRUCTION: object({ actionEnum: action }),
  INCOMPLETE: object({ checkNames: z.array(checkId).min(1), coverageCode: failure, retryCode }),
  POLICY_DENIAL: object({ denialCode: z.enum(['high', 'incomplete', 'elevated', 'depth_limit', 'cost_limit', 'execution_gap', 'killed', 'blocklist', 'exposure_limit', 'daily_loss_limit', 'access_denied']), trustedPolicyExplanation: z.enum(['guard_level', 'required_checks', 'owner_limit', 'execution_validity', 'kill_switch', 'asset_list', 'access_control']) }),
} as const;
function reasonVariant<K extends keyof typeof reasonParameters>(code: K) { return object({ code: z.literal(code), factorId: factorId.nullable(), parameters: reasonParameters[code], evidenceIds: z.array(hash) }); }
const reason = z.discriminatedUnion('code', [reasonVariant('EXIT_COST'), reasonVariant('DEPTH'), reasonVariant('ENTRY_LIMIT'), reasonVariant('SELL_RESTRICTION'), reasonVariant('CONTROL'), reasonVariant('GROUP_HELD'), reasonVariant('TOP_HOLDERS'), reasonVariant('EARLY_BUYERS'), reasonVariant('SAME_BLOCK'), reasonVariant('ORIGIN_SALE'), reasonVariant('SELL_PRESSURE'), reasonVariant('ATTRIBUTED_DUMP'), reasonVariant('EXEMPTIONS'), reasonVariant('CYCLING'), reasonVariant('CLONE'), reasonVariant('HISTORY'), reasonVariant('TEXT_INSTRUCTION'), reasonVariant('INCOMPLETE'), reasonVariant('POLICY_DENIAL')]);
function factorVariant<K extends keyof typeof reasonParameters>(template: K) { return object({ id: factorId, family, mechanismId: hash.nullable(), state: z.enum(['matched', 'not_matched', 'unknown', 'not_applicable']), eligiblePoints: points, assignedPoints: points, suppressionCode: z.enum(GUARD_SUPPRESSION_CODES).nullable(), metricIds: z.array(metricId), evidenceIds: z.array(hash), template: z.literal(template), parameters: reasonParameters[template], calibration: z.enum(['shadow', 'released']) }); }
const factor = z.discriminatedUnion('template', [factorVariant('EXIT_COST'), factorVariant('DEPTH'), factorVariant('ENTRY_LIMIT'), factorVariant('SELL_RESTRICTION'), factorVariant('CONTROL'), factorVariant('GROUP_HELD'), factorVariant('TOP_HOLDERS'), factorVariant('EARLY_BUYERS'), factorVariant('SAME_BLOCK'), factorVariant('ORIGIN_SALE'), factorVariant('SELL_PRESSURE'), factorVariant('ATTRIBUTED_DUMP'), factorVariant('EXEMPTIONS'), factorVariant('CYCLING'), factorVariant('CLONE'), factorVariant('HISTORY'), factorVariant('TEXT_INSTRUCTION'), factorVariant('INCOMPLETE'), factorVariant('POLICY_DENIAL')]).superRefine((v, ctx) => {
  if (v.family !== GUARD_FACTOR_FAMILIES[v.id]) ctx.addIssue({ code: 'custom', path: ['family'], message: 'Factor family disagrees with registry' });
  if (v.assignedPoints > v.eligiblePoints || (v.state !== 'matched' && (v.eligiblePoints !== 0 || v.assignedPoints !== 0))) ctx.addIssue({ code: 'custom', message: 'Invalid factor assignment' });
});
const check = object({ id: checkId, tier: z.enum(['buy_critical', 'lower_tier', 'optional']), status: z.enum(['complete', 'not_applicable', 'missing', 'stale', 'failed', 'unsupported']), coverage, evidenceIds: z.array(hash), failureCode: failure.nullable() }).superRefine((v, ctx) => {
  if (v.tier !== GUARD_CHECK_TIERS[v.id]) ctx.addIssue({ code: 'custom', path: ['tier'], message: 'Check tier disagrees with manifest' });
  const resolved = v.status === 'complete' || v.status === 'not_applicable';
  if (resolved ? !v.coverage.complete || v.failureCode !== null : v.failureCode === null) ctx.addIssue({ code: 'custom', message: 'Check status requires coverage/failure' });
  if (v.status === 'not_applicable' && !v.evidenceIds.length) ctx.addIssue({ code: 'custom', message: 'NA requires proven rationale evidence' });
});
const receipt = z.discriminatedUnion('status', [object({ status: z.literal('recorded'), id, payloadHash: hash }), object({ status: z.literal('anchored'), id, payloadHash: hash, root: hash, batchId: count, proof: z.array(hash), txHash: hash })]);
const evidence = object({ id: hash, kind: z.enum(['tx', 'log', 'trace', 'sim', 'address', 'code', 'stat', 'text', 'state', 'review']), cursor, knownAt: availability, payloadHash: hash, objectRef: hash, supersedes: hash.nullable(), text: untrusted.optional() });
const guardLevel = z.enum(['lower', 'elevated', 'high', 'incomplete']);
const observedLevel = z.enum(['lower', 'elevated', 'high']);
const assessment = object({
  schemaVersion: z.literal('guard-2'), coin: AddressSchema, chainId, cursor, availabilityCut: availability, mode: z.enum(['shadow', 'candidate', 'active']), rulesVersion: version, identityVersion: version, measurementVersion: version, outcomeVersion: version, codeHash: hash, parametersHash: hash, serviceRegistryHash: hash, profileHash: hash, calibrationManifestHash: hash,
  referenceSizesUsd: z.tuple([z.literal(100), z.literal(1000)]), benchmarkHorizonSec: z.literal(3600), level: guardLevel, observedLevel, levelFloorReason: z.literal('lower_tier_gap').nullable(), completeness: object({ buyCriticalComplete: z.boolean(), lowerTierComplete: z.boolean(), missing: z.array(checkId) }), checks: z.array(check), factors: z.array(factor), baseScore: points, historyPoints: z.union([z.literal(0), z.literal(10), z.literal(15)]), score: points, scoreIsLowerBound: z.boolean(), familyPoints: object({ E: points, O: points, Ff: points, C: points, I: points }), decisiveIds: z.array(z.enum(GUARD_DECISIVE_IDS)), reasons: z.array(reason), history, snapshotHash: hash, decisionHash: hash, evidenceRoot: hash, receipt, supersedes: id.nullable(),
}).superRefine((v, ctx) => {
  if (v.chainId !== v.cursor.chainId || v.chainId !== v.availabilityCut.cursor.chainId) ctx.addIssue({ code: 'custom', message: 'Assessment chain mismatch' });
  const ids = v.checks.map((c) => c.id);
  if (new Set(ids).size !== ids.length || GUARD_CHECK_IDS.some((c) => !ids.includes(c))) ctx.addIssue({ code: 'custom', path: ['checks'], message: 'Full unique check manifest required' });
  const gaps = v.checks.filter((c) => c.status !== 'complete' && c.status !== 'not_applicable');
  if (new Set(v.completeness.missing).size !== gaps.length || gaps.some((c) => !v.completeness.missing.includes(c.id))) ctx.addIssue({ code: 'custom', message: 'Completeness must name every gap exactly once' });
  const critical = !gaps.some((c) => c.tier === 'buy_critical'), lower = !gaps.some((c) => c.tier === 'lower_tier');
  if (v.completeness.buyCriticalComplete !== critical || v.completeness.lowerTierComplete !== lower) ctx.addIssue({ code: 'custom', message: 'Completeness disagrees with checks' });
  const computedObserved = v.decisiveIds.length || v.score >= 60 ? 'high' : v.score >= 30 ? 'elevated' : 'lower';
  if (v.observedLevel !== computedObserved || v.score !== Math.min(100, v.baseScore + v.historyPoints) || v.baseScore !== Math.min(100, Object.values(v.familyPoints).reduce((a, b) => a + b, 0))) ctx.addIssue({ code: 'custom', message: 'Assessment arithmetic/observed level disagrees' });
  if (new Set(v.decisiveIds).size !== v.decisiveIds.length) ctx.addIssue({ code: 'custom', message: 'Duplicate decisive ID' });
  const expected = v.observedLevel === 'high' ? 'high' : !critical ? 'incomplete' : !lower ? 'elevated' : v.observedLevel;
  if (v.level !== expected || v.levelFloorReason !== (critical && !lower && v.observedLevel === 'lower' ? 'lower_tier_gap' : null)) ctx.addIssue({ code: 'custom', path: ['level'], message: 'Invalid tier overlay' });
  if (v.mode === 'active' && v.factors.some((f) => f.assignedPoints > 0 && f.calibration !== 'released')) ctx.addIssue({ code: 'custom', message: 'Shadow factors cannot affect active assessment' });
  if (new Set(v.factors.map((f) => f.id)).size !== v.factors.length) ctx.addIssue({ code: 'custom', message: 'Duplicate factor ID' });
});
const reading = z.number().min(0).max(100);
const readings = object({ momentum: reading, liquidity: reading, holders: reading, narrative: reading, risk: reading });
const signal = object({ schemaVersion: z.literal('signal-2'), composite: z.number().min(0).max(100), readings, weights: object({ momentum: z.literal(0.3), liquidity: z.literal(0.25), holders: z.literal(0.2), narrative: z.literal(0.15), risk: z.literal(0.1) }), beta: z.literal(true), asOfBlock: uint, lowData: z.array(z.enum(['momentum', 'liquidity', 'holders', 'narrative', 'risk'])), guardReceiptId: id, inputMethodVersions: object({ momentum: version, liquidity: version, holders: version, narrative: version, risk: version }) });
const legacy = object({ schemaVersion: z.literal('verdict-1'), rulesVersion: z.string().regex(/^1\.0\.\d+$/), receiptId: id, level: z.enum(['clear', 'monitor', 'danger', 'pending']), asOfBlock: uint, label: z.literal('Legacy assessment').optional(), supersededBy: id.nullable().optional(), shadowAssessmentReceiptId: id.nullable().optional() });
const classifiedVolumes = object({ marketMaking: um, arbitrage: um, buyback: um, unclassified: um, coverage });
const untrustedEvidence = object({ field: z.enum(['name', 'symbol', 'description', 'social']), text: untrusted, payloadHash: hash, knownAt: availability, coverage });
const bar = object({ ts: z.number(), o: z.number(), h: z.number(), l: z.number(), c: z.number(), vUsd: z.number() });
const card = object({
  schemaVersion: z.literal('coin-card-2'),
  identity: object({ chainId, address: AddressSchema, name: untrusted, symbol: untrusted, factoryDeployer: am, outerSigner: am, principal: am, creationPayer: am, createdAt: tm, marketOpen: tm, firstTrade: tm, graduation: tm, launchpad: z.enum(['pons', 'occupy', 'flap', 'klik', 'other']), stage: z.enum(['curve', 'graduated', 'unknown']), quoteAsset: am, pools: z.array(pool), service, operatorGroup: group.nullable(), feeRecipients: z.array(role), exemptions: z.array(role), clone: metric(collision) }),
  tradeability: object({ quotes: z.array(quote), buyTaxPct: um, sellTaxPct: um, antiSnipe: metric(antiSnipe), hooks: z.array(hook), existingPositionExits: z.array(positionExit) }),
  liquidity: object({ directionalDepth: z.array(directionalDepth), headlineDepth2Usd: um, realReserves: metric(assetBalances), positions: z.array(position), removableDepthShare: um, lpStatus: metric(lpStatus) }),
  supply: object({ minted: rm, total: rm, sinks: rm, locked: rm, curveInventory: rm, poolInventory: rm, circulating: rm, holderFloat: rm, burnedPct: um, fdvUsd: um, circulatingCapUsd: um, curveProgressPct: um, holders: cm, rawTop10: z.array(object({ address: AddressSchema, groupId: hash.nullable(), units: rm })), controlTop10: z.array(object({ address: AddressSchema, groupId: hash.nullable(), units: rm })), top10RawPct: um, top10ControlPct: um }),
  holdings: object({ principal: positionMetrics, operator: positionMetrics, cohorts: z.array(cohort), principalOriginOverhang: metric(shares), earlyOriginOverhang: metric(shares), coordinatedLargest: metric(shares), coordinatedUnion: metric(shares), candidates: z.array(candidate), unresolvedFloatPct: um, fundingCoverage: coverage, history }),
  control: object({ powers: z.array(power), currentController: am, releasableByHorizon: rm, queuedChanges: z.array(queuedChange) }),
  selling: object({ episodes: z.array(saleEpisode), campaigns: z.array(campaign), pressure: um, buyerOriginEstimate: metric(quoteAmounts), creatorFees: metric(quoteAmounts), outcomes: z.array(outcome), lastHarmfulEvent: hm, recoveryAsOf: tm, oldSideLiquidOverhang: metric(shares), takeoverEvidenceStatus: metric(z.enum(['verified', 'candidate', 'unknown', 'absent'])) }),
  flow: object({ windowSec: z.union([z.literal(300), z.literal(3600), z.literal(86400)]), buyUsd: um, grossVolumeUsd: um, netNewQuote: metric(quoteAmounts), agentPct: um, declaredAgentPct: um, likelyAgentPct: um, crewPct: um, unclassifiedPct: um, rawActors: cm, economicActors: cm, classifiedVolumes, purchasedHolderGrowth: cm, airdroppedHolderGrowth: cm, cyclingPct: um, beta: z.literal(true) }),
  text: object({ fields: z.array(untrustedEvidence), instruction: metric(action), scanCoverage: coverage }),
  collectionCoverage: z.partialRecord(z.enum(['pools', 'feeRecipients', 'exemptions', 'hooks', 'existingPositionExits', 'directionalDepth', 'positions', 'rawTop10', 'controlTop10', 'cohorts', 'candidates', 'queuedChanges', 'episodes', 'campaigns', 'outcomes', 'textFields']), coverage).optional(),
  factorMeasurements: z.array(object({ factorId, primary: dm.nullable(), secondary: dm.nullable(), qualification: metric(z.boolean()).nullable() })).optional(),
  jobs: z.array(object({ kind: z.enum([...GUARD_CHECK_IDS, 'launch_evidence', 'trace_principal', 'service_review', 'creation_payer', 'fee_configuration']), status: z.enum(['missing', 'stale', 'failed', 'unsupported']), retryCode, evidenceIds: z.array(hash) })).optional(),
  source: object({ manifestId: hash, sourceRevision: hash, watermark: cursor, cut: availability }).nullable().optional(),
  verdict: assessment.nullable(), legacy: legacy.nullable(), signal: signal.optional(), spark8h: z.array(bar).optional(), change24hPct: dm.optional(), freshness: object({ cursor, servedAt: uint, snapshotAgeSec: count, launchAgeSec: um, oldestRequiredSectionAgeSec: count.nullable() }), evidence: z.array(evidence),
}).superRefine((v, ctx) => {
  if ((v.verdict !== null && (v.identity.address !== v.verdict.coin || v.identity.chainId !== v.verdict.chainId)) || v.freshness.cursor.chainId !== v.identity.chainId) ctx.addIssue({ code: 'custom', message: 'Card identity mismatch' });
  for (const size of [100, 1000]) for (const cls of ['eoa', 'smart_account']) if (!v.tradeability.quotes.some((q) => q.sizeUsd === size && q.accountClass === cls)) ctx.addIssue({ code: 'custom', path: ['tradeability', 'quotes'], message: 'Explicit reference size/class row required, unknown if unsupported' });
  const keys = v.tradeability.quotes.map((q) => `${q.sizeUsd}:${q.accountClass}`);
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: 'custom', message: 'Duplicate quote size/class' });
});

export { decimal as DecimalSchema, unsignedDecimal as UnsignedDecimalSchema, rawAmount as RawAmountSchema, rational as RationalSchema, cursor as GuardCursorSchema, availability as AvailabilityCutSchema, coverage as GuardCoverageSchema, guardLevel as GuardLevelV2Schema, check as GuardAssessmentCheckSchema, factor as GuardFactorSchema, reason as GuardReasonV2Schema, receipt as ReceiptRefV2Schema, evidence as EvidenceRefV2Schema, assessment as GuardAssessmentV2Schema, card as CoinCardV2Schema, history as HistoryCoverageSchema, directionalDepth as DirectionalDepthMeasurementSchema, quote as QuoteMeasurementSchema, positionMetrics as PositionMetricsSchema, shares as PositionSharesSchema, saleEpisode as SaleEpisodeSchema, campaign as CampaignMeasurementSchema, outcome as OutcomeV2Schema, feeComponents as FeeComponentsSchema, signal as CoinSignalV2Schema };
export type GuardLevelV2 = z.infer<typeof guardLevel>;
export type ObservedLevel = z.infer<typeof observedLevel>;
export type GuardFamily = z.infer<typeof family>;
export type Decimal = z.infer<typeof decimal>;
export type RawAmount = z.infer<typeof rawAmount>;
export type Rational = z.infer<typeof rational>;
export type GuardCursor = z.infer<typeof cursor>;
export type AvailabilityCut = z.infer<typeof availability>;
export type GuardCoverage = z.infer<typeof coverage>;
export type Metric<T> = Omit<z.infer<ReturnType<typeof createGuardMetric>>, 'value' | 'status'> & ({ [S in 'observed' | 'lower_bound' | 'upper_bound']: { status: S; value: T } }['observed' | 'lower_bound' | 'upper_bound'] | { [S in 'unknown' | 'not_applicable']: { status: S; value: null } }['unknown' | 'not_applicable']);
export type GuardAssessmentCheck = z.infer<typeof check>;
export type GuardFactor = z.infer<typeof factor>;
export type GuardReasonV2 = z.infer<typeof reason>;
export type GuardAssessmentV2 = z.infer<typeof assessment>;
export type CoinCardV2 = z.infer<typeof card>;
export type QuoteMeasurement = z.infer<typeof quote>;
export type PositionMetrics = z.infer<typeof positionMetrics>;
export type PositionShares = z.infer<typeof shares>;
export type HistoryCoverage = z.infer<typeof history>;
export type SaleEpisode = z.infer<typeof saleEpisode>;
export type CampaignMeasurement = z.infer<typeof campaign>;
export type OutcomeV2 = z.infer<typeof outcome>;
export type ReceiptRefV2 = z.infer<typeof receipt>;
export type EvidenceRefV2 = z.infer<typeof evidence>;
export type FeeComponents = z.infer<typeof feeComponents>;
export type CoinSignalV2 = z.infer<typeof signal>;
export type TypedReasonParameters = GuardReasonV2['parameters'];
export type PowerAssessment = z.infer<typeof power>;
export type DirectionalDepthMeasurement = z.infer<typeof directionalDepth>;
export type PositionAssessment = z.infer<typeof position>;
export type CohortPositionMetrics = z.infer<typeof cohort>;
export type ServiceResolution = z.infer<typeof service>;
export type RoleAssignment = z.infer<typeof role>;
export type CoordinationCandidate = z.infer<typeof candidate>;
