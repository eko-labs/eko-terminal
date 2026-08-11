// Synthetic contracts, not chain observations or measured calibration evidence.
import v1 from './v1.json';
import { guardReceiptRevisionKey } from '../../../src/contracts/guard-receipts.js';
import { GuardAssessmentV2Schema } from '../../../src/contracts/guard-v2.js';
import { GUARD_CHECK_IDS, GUARD_CHECK_TIERS } from '../../../src/contracts/guard-ids.js';
import type { MetricId } from '../../../src/contracts/guard-ids.js';
export const address = `0x${'ab'.repeat(20)}`;
export const hash = `0x${'12'.repeat(32)}`;
export const cursor = { chainId: 4663, blockNumber: '123', blockHash: hash, transactionIndex: null, executionOrdinal: null, timestampSec: '1000', boundary: 'block_end' };
export const availability = { cursor, acquisitionSequence: '1' };
export const coverage = { scopeId: 'fixture-scope', from: cursor, through: cursor, complete: true, gaps: [], methodVersion: '2.0.0', coveredUnits: null, excludedUnits: null, topLevelNative: false, internalNative: false, firstEverEstablished: false, sourceHashes: [hash] };
export const missingCoverage = { ...coverage, complete: false, gaps: ['missing'] };
export const raw = { asset: address, decimals: 18, raw: '123456789012345678901234567890' };
export function observed(id: MetricId, value: unknown, unit = 'decimal') { return { id, unit, cursor, knownAt: availability, numerator: unit === 'pct' && value !== null ? String(value) : null, denominator: unit === 'pct' && value !== null ? '100' : null, denominatorKind: unit === 'pct' && value !== null ? 'other' : null, fromSec: null, throughSec: '1000', coverage, methodVersion: '2.0.0', evidenceIds: [hash], failureCode: null, status: 'observed', value }; }
export function unknown(id: MetricId, unit = 'decimal') { return { ...observed(id, null, unit), coverage: missingCoverage, failureCode: 'missing', status: 'unknown' }; }
export const shares = { raw: unknown('raw', 'raw'), liquid: unknown('liquid', 'raw'), locked: unknown('locked', 'raw'), supplyPct: unknown('supplyPct', 'pct'), floatPct: unknown('floatPct', 'pct') };
export const dispositions = { openingLiquid: unknown('openingLiquid', 'raw'), externalAcquisition: unknown('externalAcquisition', 'raw'), held: unknown('held', 'raw'), sold: unknown('sold', 'raw'), burned: unknown('burned', 'raw'), locked: unknown('locked', 'raw'), netTransferredOut: unknown('netTransferredOut', 'quote'), fees: unknown('transferFees', 'raw'), unexplainedResidual: unknown('unexplainedResidual', 'quote'), cexDeposits: unknown('cexDeposits', 'raw') };
export const position = { ...shares, grossBought: unknown('grossBought', 'raw'), sold: unknown('sold', 'raw'), dispositions, marketCashOutMultiple: unknown('marketCashOutMultiple', 'ratio'), allInCashOutMultiple: unknown('allInCashOutMultiple', 'ratio'), realizedLotMultiple: unknown('realizedLotMultiple', 'ratio'), basisCoveragePct: unknown('basisCoveragePct', 'pct') };
export const history = { operatorGroup: null, windowSec: 2592000, horizonSec: 3600, from: cursor, through: cursor, enumeration: missingCoverage, assessment: missingCoverage, eligibleMature: 0, assessedMature: 0, badMature: 0, badRate: unknown('badRate', 'ratio'), recentAdverse: unknown('recentAdverse', 'hash'), booster: 'disabled', outcomeIds: [] };
export const check = { id: 'reference_exit', tier: 'buy_critical', status: 'missing', coverage: missingCoverage, evidenceIds: [], failureCode: 'missing' };
export const reason = { code: 'EXIT_COST', factorId: 'execution_cost', parameters: { sizeUsd: 100, returnedUsd: '95', snapshotId: 'fixture-snapshot', costPct: '5', gasUsd: null, breakdownStatus: 'unavailable' }, evidenceIds: [hash] };
export const factor = { id: 'execution_cost', family: 'E', mechanismId: null, state: 'matched', eligiblePoints: 10, assignedPoints: 10, suppressionCode: null, metricIds: ['venueRoundTripCostPct'], evidenceIds: [hash], template: 'EXIT_COST', parameters: reason.parameters, calibration: 'shadow' };
export const assessment = { schemaVersion: 'guard-2', coin: address, chainId: 4663, cursor, availabilityCut: availability, mode: 'shadow', rulesVersion: '2.0.0', identityVersion: '2.0.0', measurementVersion: '2.0.0', outcomeVersion: '2.0.0', codeHash: hash, parametersHash: hash, serviceRegistryHash: hash, profileHash: hash, calibrationManifestHash: hash, referenceSizesUsd: [100, 1000], benchmarkHorizonSec: 3600, level: 'incomplete', observedLevel: 'lower', levelFloorReason: null, completeness: { buyCriticalComplete: false, lowerTierComplete: false, missing: [...GUARD_CHECK_IDS] }, checks: GUARD_CHECK_IDS.map((id) => ({ ...check, id, tier: GUARD_CHECK_TIERS[id] })), factors: [factor], baseScore: 10, historyPoints: 0, score: 10, scoreIsLowerBound: true, familyPoints: { E: 10, O: 0, Ff: 0, C: 0, I: 0 }, decisiveIds: [], reasons: [reason], history, snapshotHash: hash, decisionHash: hash, evidenceRoot: hash, receipt: { status: 'recorded', id: 'fixture-receipt', payloadHash: hash }, supersedes: null };
export const feeComponents = { total: observed('feeTotal', '5', 'pct'), ordinary: unknown('feeOrdinary', 'pct'), creator: unknown('feeCreator', 'pct'), temporary: unknown('feeTemporary', 'pct'), hook: unknown('feeHook', 'pct'), eko: observed('feeEko', '0', 'pct'), gas: unknown('feeGas', 'usd') };
export const quote = { sizeUsd: 100, accountClass: 'eoa', routeId: null, entry: unknown('entry', 'status'), input: unknown('input', 'raw'), tokensReceived: unknown('tokensReceived', 'raw'), returned: unknown('returned', 'raw'), venueCostPct: unknown('venueRoundTripCostPct', 'pct'), allInCostPct: unknown('allInRoundTripCostPct', 'pct'), gasUsd: unknown('gasUsd', 'usd'), feeBreakdown: unknown('feeBreakdown', 'compound'), sellability: unknown('sellability', 'status'), maxTxUsd: unknown('maxTxUsd', 'usd'), maxWalletSupplyPct: unknown('maxWalletSupplyPct', 'pct') };
const sales = { soldUnits: unknown('sold', 'raw'), openingLiquid: unknown('openingLiquid', 'raw'), externalAcquisition: unknown('externalAcquisition', 'raw'), openingFloat: unknown('openingFloat', 'raw'), openingSupply: unknown('openingSupply', 'raw'), openingRealReserve: unknown('openingRealReserve', 'quote'), soldShare: unknown('soldShare', 'ratio'), soldFloatPct: unknown('soldFloatPct', 'pct'), soldSupplyPct: unknown('soldSupplyPct', 'pct'), grossSaleReceipts: unknown('grossSaleReceipts', 'quote'), netSaleReceipts: unknown('netSaleReceipts', 'quote'), netTradingCashOut: unknown('netTradingCashOut', 'quote'), pressure: unknown('pressure', 'pct'), buyerLossPct: unknown('buyerLossPct', 'pct'), contributionPp: unknown('contributionPp', 'pp'), cohortCostCoveragePct: unknown('cohortCostCoveragePct', 'pct'), cohortPositionCoveragePct: unknown('cohortPositionCoveragePct', 'pct') };
const interval = { from: cursor, through: cursor, sideId: hash, attribution: 'unknown', coverage: missingCoverage, evidenceIds: [hash] };
export const episode = { id: hash, ...interval, ...sales, status: 'indeterminate', transactionIds: [hash], originSold: unknown('originSold', 'raw'), intervention: 'unavailable', interventionStatus: 'unavailable' };
export const campaign = { id: hash, ...interval, ...sales, windowSec: 3600, episodeIds: [hash], transactionIds: [hash] };
export const outcome = { id: hash, coin: address, kind: 'collapse', status: 'censored', horizonSec: 3600, entryCursor: cursor, maturityCursor: null, knownAt: availability, attribution: 'unknown', controller: unknown('currentController', 'address'), sizeUsd: 100, accountClass: 'eoa', returnPct: unknown('returnPct', 'pct'), peakLiquidationValue: unknown('peakLiquidationValue', 'quote'), troughLiquidationValue: unknown('troughLiquidationValue', 'quote'), horizonLiquidationValue: unknown('horizonLiquidationValue', 'quote'), drawdownPct: unknown('drawdownPct', 'pct'), buyerLossPct: unknown('buyerLossPct', 'pct'), contributionPp: unknown('contributionPp', 'pp'), removalValueUsd: unknown('removalValueUsd', 'usd'), removedInventoryPct: unknown('removedInventoryPct', 'pct'), lostDepthPct: unknown('lostDepthPct', 'pct'), successorStatus: 'unknown', cohortCostCoveragePct: unknown('cohortCostCoveragePct', 'pct'), cohortPositionCoveragePct: unknown('cohortPositionCoveragePct', 'pct'), coverage: missingCoverage, evidenceIds: [hash], supersedes: null };
export const power = { capability: 'mint', reachable: unknown('powers', 'boolean'), authority: unknown('currentController', 'address'), boundCode: 'unknown', bound: unknown('controlBound'), delaySec: unknown('controlDelay', 'seconds'), earliestExecution: unknown('controlDelay', 'seconds'), implementationHash: null, configurationHash: null, evidenceIds: [hash] };
export const card = {
  schemaVersion: 'coin-card-2',
  identity: { chainId: 4663, address, name: { text: 'Sample Token', truncated: false, flags: [] }, symbol: { text: 'SAMPLE', truncated: false, flags: [] }, factoryDeployer: unknown('factoryDeployer', 'address'), outerSigner: unknown('outerSigner', 'address'), principal: unknown('principal', 'address'), creationPayer: unknown('creationPayer', 'address'), createdAt: unknown('createdAt', 'seconds'), marketOpen: unknown('marketOpen', 'seconds'), firstTrade: unknown('firstTrade', 'seconds'), graduation: unknown('graduation', 'seconds'), launchpad: 'other', stage: 'unknown', quoteAsset: unknown('quoteAsset', 'address'), pools: [], service: { status: 'unresolved', address: unknown('principal', 'address'), codeHash: null, implementation: unknown('principal', 'address'), effectiveCursor: cursor, registryVersion: '2.0.0', launches: unknown('serviceLaunchCount', 'count'), principals: unknown('servicePrincipalCount', 'count'), distinctPairsPct: unknown('distinctPrincipalFeePairsPct', 'pct'), degree: unknown('hubDegree', 'count'), degreeCoverage: missingCoverage, evidenceIds: [] }, operatorGroup: null, feeRecipients: [], exemptions: [], clone: unknown('clone', 'compound') },
  tradeability: { quotes: [100, 1000].flatMap((sizeUsd) => ['eoa', 'smart_account'].map((accountClass) => ({ ...quote, sizeUsd, accountClass }))), buyTaxPct: unknown('buyTaxPct', 'pct'), sellTaxPct: unknown('sellTaxPct', 'pct'), antiSnipe: unknown('antiSnipe', 'compound'), hooks: [], existingPositionExits: [] },
  liquidity: { directionalDepth: [], headlineDepth2Usd: unknown('depth2', 'usd'), realReserves: unknown('realReserves', 'compound'), positions: [], removableDepthShare: unknown('removableDepthShare', 'pct'), lpStatus: unknown('lpStatus', 'status') },
  supply: { minted: unknown('minted', 'raw'), total: unknown('total', 'raw'), sinks: unknown('sinks', 'raw'), locked: unknown('locked', 'raw'), curveInventory: unknown('curveInventory', 'raw'), poolInventory: unknown('poolInventory', 'raw'), circulating: unknown('circulating', 'raw'), holderFloat: unknown('holderFloat', 'raw'), burnedPct: unknown('burnedPct', 'pct'), fdvUsd: unknown('fdvUsd', 'usd'), circulatingCapUsd: unknown('circulatingCapUsd', 'usd'), curveProgressPct: unknown('curveProgressPct', 'pct'), holders: unknown('holders', 'count'), rawTop10: [], controlTop10: [], top10RawPct: unknown('topAddress10', 'pct'), top10ControlPct: unknown('topControl10', 'pct') },
  holdings: { principal: position, operator: position, cohorts: [], principalOriginOverhang: unknown('principalOriginOverhang', 'compound'), earlyOriginOverhang: unknown('earlyOriginOverhang', 'compound'), coordinatedLargest: unknown('largestCoordinatedHeld', 'compound'), coordinatedUnion: unknown('unionCoordinatedHeld', 'compound'), candidates: [], unresolvedFloatPct: unknown('unresolvedFloatPct', 'pct'), fundingCoverage: missingCoverage, history },
  control: { powers: [power], currentController: unknown('currentController', 'address'), releasableByHorizon: unknown('releasableByHorizon', 'raw'), queuedChanges: [] },
  selling: { episodes: [episode], campaigns: [campaign], pressure: unknown('pressure', 'pct'), buyerOriginEstimate: unknown('buyerOriginEstimate', 'quote'), creatorFees: unknown('creatorFees', 'quote'), outcomes: [outcome], lastHarmfulEvent: unknown('lastHarmfulEvent', 'hash'), recoveryAsOf: unknown('recoveryAsOf', 'seconds'), oldSideLiquidOverhang: unknown('oldSideLiquidOverhang', 'compound'), takeoverEvidenceStatus: unknown('takeoverEvidenceStatus', 'status') },
  flow: { windowSec: 3600, buyUsd: unknown('buyUsd', 'usd'), grossVolumeUsd: unknown('grossVolumeUsd', 'usd'), netNewQuote: unknown('netNewQuote', 'quote'), agentPct: unknown('agentPct', 'pct'), declaredAgentPct: unknown('declaredAgentPct', 'pct'), likelyAgentPct: unknown('likelyAgentPct', 'pct'), crewPct: unknown('crewPct', 'pct'), unclassifiedPct: unknown('unclassifiedPct', 'pct'), rawActors: unknown('rawActors', 'count'), economicActors: unknown('economicActors', 'count'), classifiedVolumes: { marketMaking: unknown('classifiedVolumes', 'usd'), arbitrage: unknown('classifiedVolumes', 'usd'), buyback: unknown('classifiedVolumes', 'usd'), unclassified: unknown('classifiedVolumes', 'usd'), coverage: missingCoverage }, purchasedHolderGrowth: unknown('purchasedHolderGrowth', 'count'), airdroppedHolderGrowth: unknown('airdroppedHolderGrowth', 'count'), cyclingPct: unknown('cyclingPct', 'pct'), beta: true },
  text: { fields: [], instruction: unknown('instruction', 'status'), scanCoverage: missingCoverage }, verdict: assessment, legacy: null, freshness: { cursor, servedAt: '1001', snapshotAgeSec: 1, launchAgeSec: unknown('launchAgeSec', 'seconds'), oldestRequiredSectionAgeSec: null }, evidence: [{ id: hash, kind: 'state', cursor, knownAt: availability, payloadHash: hash, objectRef: hash, supersedes: null }],
};
const signal = { schemaVersion: 'signal-2', composite: 50, readings: { momentum: 50, liquidity: 50, holders: 50, narrative: 50, risk: 50 }, weights: { momentum: 0.3, liquidity: 0.25, holders: 0.2, narrative: 0.15, risk: 0.1 }, beta: true, asOfBlock: '123', lowData: ['risk'], guardReceiptId: 'fixture-receipt', inputMethodVersions: { momentum: '1.0.0', liquidity: '1.0.0', holders: '1.0.0', narrative: '1.0.0', risk: '2.0.0' } };
export const guardSamples: Record<string, unknown> = {
  Decimal: '-0.123', UnsignedDecimal: '0.123', RawAmount: raw, Rational: { numerator: '-1', denominator: '3' }, GuardCursor: cursor, AvailabilityCut: availability, GuardCoverage: coverage, GuardLevelV2: 'incomplete', GuardAssessmentCheck: check, GuardFactor: factor, GuardReasonV2: reason, ReceiptRefV2: assessment.receipt, EvidenceRefV2: card.evidence[0], GuardAssessmentV2: assessment, CoinCardV2: card, HistoryCoverage: history, QuoteMeasurement: quote, PositionMetrics: position, PositionShares: shares, SaleEpisode: episode, CampaignMeasurement: campaign, OutcomeV2: outcome, FeeComponents: feeComponents, CoinSignalV2: signal,
  GuardExtendedVerdict: { ...v1.Verdict, schemaVersion: 'verdict-1+guard-2', level: 'pending', coin: address, guardV2: assessment }, NegotiatedGuardVerdict: { version: 2, verdict: assessment }, NegotiatedCoinCard: { version: 2, card },
};

// Packet 027 persistence envelopes; synthetic availability and raw content references.
const persistenceSource = { chainId:4663,coin:address,manifestId:hash,sourceItemId:'fixture-log',sourceRevision:hash,cursor,knownAt:availability,acquiredAt:'2026-10-02T00:00:00Z',methodVersion:'2.0.0',dependencyIds:[] };
Object.assign(guardSamples, {
  GuardBusTopic: 'guard.evidence.created', GuardBusEvent: { topic:'guard.evidence.created',ids:{id:hash} },
  GuardAvailabilityManifest: { id:hash,sourceId:'fixture-source',sourceRevision:hash,replayMode:'production',cut:availability,watermark:cursor,acquiredAt:'2026-10-02T00:00:00Z' },
  GuardStoredEvidence: { ...persistenceSource,evidence:card.evidence[0] },
  GuardStoredCoverage: { ...persistenceSource,coverage },
  GuardStoredRole: { ...persistenceSource,role:'launch_principal',address:null,status:'missing',evidenceIds:[],payloadHash:hash,objectRef:hash },
  GuardVerdictRevisionInput: { assessment,deterministicInput: {},manifestId:hash,sourceRevision:hash,context:{routeId:null,sizeUsd:null,accountClass:null},dependencyIds:[],recordedAt:'2026-10-02T00:00:00Z',runId:'fixture-run' },
  GuardRevisionEvent: { kind:'orphaned',targetId:hash,replacementId:null,causeId:hash,knownAt:availability,recordedAt:'2026-10-02T00:00:00Z' },
  GuardReorg: { chainId:4663,fromBlock:'123',causeId:hash,knownAt:availability,recordedAt:'2026-10-02T00:00:00Z' },
});

// Packet 030's unknown partial snapshot is still explicit and versioned.
const supplyFields = ['minted', 'total', 'sinks', 'locked', 'curveInventory', 'poolInventory', 'circulating', 'holderFloat',
  'burnedPct', 'holders', 'top10RawPct', 'rawTop10'];
guardSamples.SupplySnapshotV2 = {
  schemaVersion: 'supply-2', methodVersion: '2.0.0', capSemanticsVersion: '2.0.0', coin: address, cursor, knownAt: availability,
  supply: Object.fromEntries(Object.entries(card.supply).filter(([key]) => supplyFields.includes(key))),
  holdings: [], floatState: 'unknown', check: { ...check, id: 'supply_float' }, issues: ['incomplete_transfers'],
};

// Packet 031 snapshots preserve lot lineage without claiming sale responsibility.
guardSamples.GuardLot = {
  id: hash, owner: address, origin: address, originAlternatives: [address], acquiredAt: cursor, units: raw, state: 'liquid',
  basis: null, basisPayer: null, evidenceIds: [hash],
};
guardSamples.LotMetricsSnapshot = {
  schemaVersion: 'lot-metrics-2', methodVersion: '2.0.0', coin: address, cursor, knownAt: availability,
  lots: [], cohorts: [], sales: [], principalOriginOverhang: shares, episodes: [], campaigns: [],
  issues: ['incomplete_source', 'unknown_basis'],
};

// Packet 032's normalized inputs are fixtures, not measured or released harmful history.
const historyGroup = { id: hash, kind: 'control', memberIds: [address], edgeIds: [hash], graphVersion: '2.0.0', supersedes: [] };
const historyAttribution = { operatorGroupId: hash, principal: address, actor: address, kind: 'authenticated_principal',
  effectiveFrom: cursor, effectiveThrough: null, knownAt: availability, evidenceIds: [hash], loop: null };
guardSamples.GuardHistoryAttribution = historyAttribution;
guardSamples.GuardHistorySource = { operator: { group: historyGroup, principal: address, effectiveFrom: cursor,
  effectiveThrough: null, knownAt: availability, serviceStatus: 'not_service', serviceAddresses: [], evidenceIds: [hash] },
  enumeration: { coverage: missingCoverage, knownAt: availability }, launches: [], assessments: [], outcomes: [] };
guardSamples.GuardHistoryInput = { coin: address, cursor, availabilityCut: availability, baseScore: 0, factors: [],
  mode: 'shadow', booster: 'disabled', source: null };
guardSamples.GuardHistoryResult = { history, check: { ...check, id: 'operator_history', tier: 'lower_tier' },
  candidatePoints: 0, historyPoints: 0, score: 0, reason: null, gaps: ['enumeration_missing', 'operator_unresolved'] };

// Packet 033 pure scoring envelopes, still shadow and synthetic.
const scoreObservation = { id: 'execution_cost', primary: observed('venueRoundTripCostPct', '5', 'pct'), secondary: null,
  qualification: null, participants: null, windowSec: null, controlKind: null, reason, mechanism: null };
const scoreInput = { coin: address, cursor, availabilityCut: availability, mode: 'shadow', observations: [scoreObservation], checks: [],
  decisive: [], informational: [], historySource: null, shadowBooster: false, codeHash: hash, serviceRegistryHash: hash,
  profileHash: hash, calibrationManifestHash: hash };
const compatibility = { version: '2.0.0', default: 'compatible', proofRequired: true, prohibitedSameMechanism: [],
  allocation: 'maximize sum of family maxima; tie ascending E,Ff,O,C,I,factorId' };
const allocation = { compatibility, compatibilityHash: hash, selectedIds: ['execution_cost'] };
Object.assign(guardSamples, { GuardScoreObservation: scoreObservation, GuardScoreInput: scoreInput, GuardCompatibility: compatibility,
  GuardScoreResult: { assessment, deterministicInput: {}, allocation }, GuardShadowRun: { id: hash, legacyVerdictId: 'fixture-verdict', manifestId: null,
    sourceRevision: hash, deterministicInput: {}, input: scoreInput, assessment, allocation, recordedAt: '2026-10-02T00:00:00.000Z' } });

const { receipt: _receipt, ...receiptDecision } = assessment;
guardSamples.GuardReceiptPayload = { schemaVersion: 'guard-receipt-2', canonicalization: 'jcs-rfc8785/v1', receiptId: 'fixture-receipt', revisionId: hash, revisionKey: guardReceiptRevisionKey(GuardAssessmentV2Schema.parse(assessment), hash, hash, {routeId:null,sizeUsd:null,accountClass:null}), kind: 'verdict', recordedAt: '2026-10-02T00:00:00.000Z', deterministicInput: {}, decision: receiptDecision };
guardSamples.GuardReceiptRevisionKey = guardReceiptRevisionKey(GuardAssessmentV2Schema.parse(assessment), hash, hash, {routeId:null,sizeUsd:null,accountClass:null});

Object.assign(guardSamples, {
  GuardReadRequest:{address,version:2},
  GuardEvidenceResponse:{reference:card.evidence[0],payload:{text:'Captured evidence',truncated:false,flags:[]},dependencyIds:[hash]},
  GuardTotals:{status:'observed',activeVersion:'verdict-1',coins:1,lower:0,elevated:0,high:0,incomplete:1,noVerdict:0,incompleteCoverage:1,evaluatedToday:1,clear:0,monitor:0,danger:0,pending:1},
  CoinSummaryV2:{address,name:card.identity.name,symbol:card.identity.symbol,level:'incomplete',verdictPending:false,incompleteCoverage:true,mode:'shadow'},
  GuardListResponse:{version:2,rows:[],cursor:null,totals:{status:'unavailable',activeVersion:'verdict-1',failureCode:'missing'}},
  GuardScanResponse:{version:2,status:'pending',cards:[{...card,verdict:null}],candidates:[]},
  GuardWsClient:{op:'sub',version:2,ch:[`coin:${address}`]},
  GuardWsEvent:{t:'ev',version:2,ch:`coin:${address}`,seq:1,ts:1001,kind:'card',data:card},
  GuardCardMeasurement:{schemaVersion:'guard-card-measurements-2',coin:address,cursor,knownAt:availability,control:{currentController:unknown('currentController','address')}},
});

guardSamples.GuardWsServer={t:'hello',version:2,serverTime:1001,mode:'shadow'};

// Packet 037 synthetic compact-consumer contracts; no chain/calibration claims.
Object.assign(guardSamples, {
  GuardFactorId: 'execution_cost', GuardReasonCode: 'EXIT_COST',
  GuardSignalFields: {guardFactorId:'execution_cost',guardReasonCode:'EXIT_COST'},
  GuardConsumerRequest: {version:2,assessment},
  GuardSurfaceRequest: {surface:'radar',coin:address,verdict:{version:2,assessment}},
  RuleSignal: {id:'sample-signal',coin:address,source:{kind:'rule',id:'sample-rule',name:{text:'Sample rule',truncated:false,flags:[]}},side:'buy',ts:1000000,block:123,reason:{text:'Rule condition matched',truncated:false,flags:[]},usdSize:100,status:'blocked',blockedBy:'honeypot',guardFactorId:'execution_cost',guardReasonCode:'EXIT_COST'},
});

// Packet 041: conservative marginal depth, not a measured production observation.
Object.assign(guardSamples, {
  DirectionalDepthMeasurement: {routeId:'fixture-route',direction:'sell',discountPct:2,
    usd:{...observed('depthSell2','1000','usd'),status:'lower_bound'},
    solverBounds:{method:'bracket_refine',evaluations:30,monotonicityProved:true,lowerUsd:'1000',upperUsd:'1005',relativeWidthPct:'0.5',errorBounds:null,
      domain:{startUsd:'1',capUsd:'1000000',maximumInput:null,inputUsd:{numerator:'1000000',denominator:'1000000000000000000'},precisionUsd:'0.000001'},
      termination:'refined',lowerInput:'1000000000000000000000',upperInput:'1005000000000000000000',remoteSearchCalls:0}},
});
