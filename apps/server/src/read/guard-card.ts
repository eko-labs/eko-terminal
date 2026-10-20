import {
  CoinCardV2Schema, GuardCardMeasurementSchema, GuardScoreInputSchema, SupplySnapshotV2Schema, LotMetricsSnapshotSchema,
  GUARD_CAPABILITIES, GUARD_COHORT_IDS, GUARD_CHECK_IDS, guardKnownBy, compareGuardCursors,
  type Address, type AvailabilityCut, type CoinCardV2, type GuardAssessmentV2,
  type GuardCoverage, type GuardCursor, type Metric, type MetricId,
  type PositionMetrics, type PositionShares, type Verdict, type EvidenceRefV2, type GuardAvailabilityManifest,
} from '@eko/shared';
import { toUntrusted } from '@eko/untrusted';
import type { LaunchRoleSnapshot } from '@eko/chain';

export interface GuardCardSources {
  manifest?: GuardAvailabilityManifest | null;
  coin: Address; name: string | null; symbol: string | null;
  cursor: GuardCursor; cut: AvailabilityCut; servedAtSec: number;
  assessment: GuardAssessmentV2 | null; legacy: Verdict | null; legacyRulesVersion: string | null;
  launch: { snapshot: LaunchRoleSnapshot; evidence: EvidenceRefV2 } | null;
  measurements: { content: unknown; evidence: EvidenceRefV2 }[];
}
/** Pure projection of captured measurements. No acquisition, scoring, or legacy
 * numeric conversions: the V1 denominators and placeholder meanings are different. */
export function projectCoinCardV2(input: GuardCardSources): CoinCardV2 {
  const { cursor, cut } = input;
  const coverage: GuardCoverage = { scopeId: 'card-unavailable', from: null, through: cursor,
    complete: false, gaps: ['missing'], methodVersion: '2.0.0', coveredUnits: null, excludedUnits: null,
    topLevelNative: false, internalNative: false, firstEverEstablished: false, sourceHashes: [] };
  const unknown = <T>(id: MetricId, unit: Metric<T>['unit'] = 'decimal'): Metric<T> => ({
    id, unit, cursor, knownAt: cut, numerator: null, denominator: null, denominatorKind: null,
    fromSec: null, throughSec: cursor.timestampSec, coverage, methodVersion: '2.0.0', evidenceIds: [],
    failureCode: 'missing', status: 'unknown', value: null,
  });
  const shares = (): PositionShares => ({ raw: unknown('raw','raw'), liquid: unknown('liquid','raw'), locked: unknown('locked','raw'), supplyPct: unknown('supplyPct','pct'), floatPct: unknown('floatPct','pct') });
  const position = (): PositionMetrics => ({ ...shares(), grossBought: unknown('grossBought','raw'), sold: unknown('sold','raw'),
    dispositions: { openingLiquid: unknown('openingLiquid','raw'), externalAcquisition: unknown('externalAcquisition','raw'), held: unknown('held','raw'), sold: unknown('sold','raw'), burned: unknown('burned','raw'), locked: unknown('locked','raw'), netTransferredOut: unknown('netTransferredOut','quote'), fees: unknown('transferFees','raw'), unexplainedResidual: unknown('unexplainedResidual','quote'), cexDeposits: unknown('cexDeposits','raw') },
    marketCashOutMultiple: unknown('marketCashOutMultiple','ratio'), allInCashOutMultiple: unknown('allInCashOutMultiple','ratio'), realizedLotMultiple: unknown('realizedLotMultiple','ratio'), basisCoveragePct: unknown('basisCoveragePct','pct') });
  const history = input.assessment?.history ?? { operatorGroup: null, windowSec: 2592000 as const, horizonSec: 3600 as const, from: cursor, through: cursor, enumeration: coverage, assessment: coverage, eligibleMature: 0, assessedMature: 0, badMature: 0, badRate: unknown<string>('badRate','ratio'), recentAdverse: unknown<`0x${string}`>('recentAdverse','hash'), booster: 'disabled' as const, outcomeIds: [] };
  const card: CoinCardV2 = {
    schemaVersion: 'coin-card-2',
    identity: { chainId: cursor.chainId, address: input.coin, name: toUntrusted(input.name,120), symbol: toUntrusted(input.symbol,32), factoryDeployer: unknown('factoryDeployer','address'), outerSigner: unknown('outerSigner','address'), principal: unknown('principal','address'), creationPayer: unknown('creationPayer','address'), createdAt: unknown('createdAt','seconds'), marketOpen: unknown('marketOpen','seconds'), firstTrade: unknown('firstTrade','seconds'), graduation: unknown('graduation','seconds'), launchpad: 'other', stage: 'unknown', quoteAsset: unknown('quoteAsset','address'), pools: [], service: { status: 'unresolved', address: unknown('principal','address'), codeHash: null, implementation: unknown('principal','address'), effectiveCursor: cursor, registryVersion: '2.0.0', launches: unknown('serviceLaunchCount','count'), principals: unknown('servicePrincipalCount','count'), distinctPairsPct: unknown('distinctPrincipalFeePairsPct','pct'), degree: unknown('hubDegree','count'), degreeCoverage: coverage, evidenceIds: [] }, operatorGroup: history.operatorGroup, feeRecipients: [], exemptions: [], clone: unknown('clone','compound') },
    tradeability: { quotes: ([100,1000] as const).flatMap(sizeUsd => (['eoa','smart_account'] as const).map(accountClass => ({ sizeUsd, accountClass, routeId: null, entry: unknown('entry','status'), input: unknown('input','raw'), tokensReceived: unknown('tokensReceived','raw'), returned: unknown('returned','raw'), venueCostPct: unknown('venueRoundTripCostPct','pct'), allInCostPct: unknown('allInRoundTripCostPct','pct'), gasUsd: unknown('gasUsd','usd'), feeBreakdown: unknown('feeBreakdown','compound'), sellability: unknown('sellability','status'), maxTxUsd: unknown('maxTxUsd','usd'), maxWalletSupplyPct: unknown('maxWalletSupplyPct','pct') }))), buyTaxPct: unknown('buyTaxPct','pct'), sellTaxPct: unknown('sellTaxPct','pct'), antiSnipe: unknown('antiSnipe','compound'), hooks: [], existingPositionExits: [] },
    liquidity: { directionalDepth: [], headlineDepth2Usd: unknown('depth2','usd'), realReserves: unknown('realReserves','compound'), positions: [], removableDepthShare: unknown('removableDepthShare','pct'), lpStatus: unknown('lpStatus','status') },
    supply: { minted: unknown('minted','raw'), total: unknown('total','raw'), sinks: unknown('sinks','raw'), locked: unknown('locked','raw'), curveInventory: unknown('curveInventory','raw'), poolInventory: unknown('poolInventory','raw'), circulating: unknown('circulating','raw'), holderFloat: unknown('holderFloat','raw'), burnedPct: unknown('burnedPct','pct'), fdvUsd: unknown('fdvUsd','usd'), circulatingCapUsd: unknown('circulatingCapUsd','usd'), curveProgressPct: unknown('curveProgressPct','pct'), holders: unknown('holders','count'), rawTop10: [], controlTop10: [], top10RawPct: unknown('topAddress10','pct'), top10ControlPct: unknown('topControl10','pct') },
    holdings: { principal: position(), operator: position(), cohorts: GUARD_COHORT_IDS.map(cohortId => ({ ...position(), cohortId, window: 'lifetime', memberIds: [], fromSec: null, throughSec: cursor.timestampSec, membershipHash: null })), principalOriginOverhang: unknown('principalOriginOverhang','compound'), earlyOriginOverhang: unknown('earlyOriginOverhang','compound'), coordinatedLargest: unknown('largestCoordinatedHeld','compound'), coordinatedUnion: unknown('unionCoordinatedHeld','compound'), candidates: [], unresolvedFloatPct: unknown('unresolvedFloatPct','pct'), fundingCoverage: coverage, history },
    control: { powers: GUARD_CAPABILITIES.map(capability => ({ capability, reachable: unknown('powers','boolean'), authority: unknown('currentController','address'), boundCode: 'unknown', bound: unknown('controlBound'), delaySec: unknown('controlDelay','seconds'), earliestExecution: unknown('earliestExecution','seconds'), implementationHash: null, configurationHash: null, evidenceIds: [] })), currentController: unknown('currentController','address'), releasableByHorizon: unknown('releasableByHorizon','raw'), queuedChanges: [] },
    selling: { episodes: [], campaigns: [], pressure: unknown('pressure','pct'), buyerOriginEstimate: unknown('buyerOriginEstimate','quote'), creatorFees: unknown('creatorFees','quote'), outcomes: [], lastHarmfulEvent: unknown('lastHarmfulEvent','hash'), recoveryAsOf: unknown('recoveryAsOf','seconds'), oldSideLiquidOverhang: unknown('oldSideLiquidOverhang','compound'), takeoverEvidenceStatus: unknown('takeoverEvidenceStatus','status') },
    flow: { windowSec: 3600, buyUsd: unknown('buyUsd','usd'), grossVolumeUsd: unknown('grossVolumeUsd','usd'), netNewQuote: unknown('netNewQuote','quote'), agentPct: unknown('agentPct','pct'), declaredAgentPct: unknown('declaredAgentPct','pct'), likelyAgentPct: unknown('likelyAgentPct','pct'), crewPct: unknown('crewPct','pct'), unclassifiedPct: unknown('unclassifiedPct','pct'), rawActors: unknown('rawActors','count'), economicActors: unknown('economicActors','count'), classifiedVolumes: { marketMaking: unknown('marketMaking','usd'), arbitrage: unknown('arbitrage','usd'), buyback: unknown('buyback','usd'), unclassified: unknown('unclassifiedVolume','usd'), coverage }, purchasedHolderGrowth: unknown('purchasedHolderGrowth','count'), airdroppedHolderGrowth: unknown('airdroppedHolderGrowth','count'), cyclingPct: unknown('cyclingPct','pct'), beta: true },
    factorMeasurements: [], jobs: input.assessment?.checks.filter(c=>c.status!=='complete' && c.status!=='not_applicable').map(c=>({kind:c.id,status:c.status as 'missing'|'failed'|'unsupported'|'stale',retryCode:c.status==='unsupported'?'profile_supported':'coverage_available',evidenceIds:c.evidenceIds})) ?? GUARD_CHECK_IDS.map(kind=>({kind,status:'missing',retryCode:'coverage_available',evidenceIds:[]})), source: input.manifest?{manifestId:input.manifest.id,sourceRevision:input.manifest.sourceRevision,watermark:input.manifest.watermark,cut:input.manifest.cut}:null,
    text: { fields: [], instruction: unknown('instruction','status'), scanCoverage: coverage }, collectionCoverage: Object.fromEntries(['pools','feeRecipients','exemptions','hooks','existingPositionExits','directionalDepth','positions','rawTop10','controlTop10','cohorts','candidates','queuedChanges','episodes','campaigns','outcomes','textFields'].map(key=>[key,coverage])), verdict: input.assessment, legacy: input.legacy && input.legacyRulesVersion && /^1\.0\.\d+$/.test(input.legacyRulesVersion) ? { schemaVersion: 'verdict-1', rulesVersion: input.legacyRulesVersion, receiptId: input.legacy.receipt.id, level: input.legacy.level, asOfBlock: String(input.legacy.asOfBlock), label:'Legacy assessment',supersededBy:input.assessment?.mode==='active'?input.assessment.receipt.id:null,shadowAssessmentReceiptId:input.assessment?.mode==='shadow'?input.assessment.receipt.id:null } : null,
    freshness: { cursor, servedAt: String(input.servedAtSec), snapshotAgeSec: Math.max(0,input.servedAtSec-Number(cursor.timestampSec)), launchAgeSec: unknown('launchAgeSec','seconds'), oldestRequiredSectionAgeSec: null }, evidence: [],
  };
  const admit = (m: { cursor: GuardCursor; knownAt: AvailabilityCut }) => guardKnownBy(m.knownAt,cut) && compareGuardCursors(m.cursor,cursor) === 0;
  for (const source of input.measurements) {
    if (!admit(source.evidence)) continue;
    const visit=(v:unknown):boolean=>{
      if(!v || typeof v!=='object')return true;
      if('knownAt' in v && 'cursor' in v) {
        const m=v as {knownAt:AvailabilityCut;cursor:GuardCursor};
        if(!guardKnownBy(m.knownAt,cut) || compareGuardCursors(m.cursor,cursor)>0)return false;
      }
      return Object.values(v).every(visit);
    };
    const supply = SupplySnapshotV2Schema.safeParse(source.content), lots = LotMetricsSnapshotSchema.safeParse(source.content);
    for(const parsed of [supply,lots])if(parsed.success && (parsed.data.coin!==input.coin || !visit(parsed.data)))throw new Error('Snapshot exceeds card context');
    if (supply.success && supply.data.coin === input.coin && admit(supply.data)) {
      Object.assign(card.supply,supply.data.supply);
      card.collectionCoverage!.rawTop10=supply.data.supply.top10RawPct.coverage;
    }
    if (lots.success && lots.data.coin === input.coin && admit(lots.data)) {
      const s=lots.data, principal=s.cohorts.find(c=>c.id==='principal');
      if(principal) card.holdings.principal=principal.metrics;
      // launch_linked is a candidate cohort, never an operator union.
      for(const [from,to] of [['launch_linked','insider_candidate'],['exempt','exempt'],['early','early']] as const) {
        const c=s.cohorts.find(c=>c.id===from), row=card.holdings.cohorts.find(c=>c.cohortId===to)!;
        if(c) Object.assign(row,c.metrics,{memberIds:c.members,membershipHash:c.membershipHash});
      }
      card.holdings.principalOriginOverhang={...unknown('principalOriginOverhang','compound'), evidenceIds:[source.evidence.id],value:s.principalOriginOverhang,status:'observed',failureCode:null};
      card.selling.episodes=s.episodes; card.selling.campaigns=s.campaigns;
    }
    const scored=GuardScoreInputSchema.safeParse(source.content);
    if(scored.success && scored.data.coin===input.coin && compareGuardCursors(scored.data.cursor,cursor)===0 && guardKnownBy(scored.data.availabilityCut,cut)) {
      for(const o of scored.data.observations) {
        if([o.primary,o.secondary,o.qualification].some(m=>m && !admit(m)))continue;
        card.factorMeasurements!.push({factorId:o.id,primary:o.primary,secondary:o.secondary,qualification:o.qualification});
        if(o.id==='top10_float' && o.primary?.unit==='pct')card.supply.top10RawPct=o.primary;
        if(o.id==='cycling' && o.windowSec===3600 && o.primary?.unit==='pct')card.flow.cyclingPct=o.primary;
        if(o.id==='current_sell_pressure' && o.secondary?.unit==='pct')card.selling.pressure=o.secondary;
      }
      if(scored.data.historySource)card.selling.outcomes=scored.data.historySource.outcomes.filter(o=>guardKnownBy(o.outcome.knownAt,cut)).map(o=>o.outcome);
    }
    const projected=GuardCardMeasurementSchema.safeParse(source.content);
    if(projected.success && projected.data.coin===input.coin && admit(projected.data)) {
      // A captured group is accepted only with no future nested metrics or text.
      if(!visit(projected.data))throw new Error('Card measurement exceeds availability cut');
      for(const group of ['identity','tradeability','liquidity','supply','holdings','control','selling','flow','text'] as const) {
        if(projected.data[group])Object.assign(card[group],projected.data[group]);
      }
      if(projected.data.collectionCoverage)Object.assign(card.collectionCoverage!,projected.data.collectionCoverage);
      card.text.fields=card.text.fields.map(f=>({...f,text:toUntrusted(f.text.text,4000)}));
    }
    if(supply.success || lots.success || projected.success || scored.success) card.evidence.push(source.evidence);
  }
  if(input.launch && guardKnownBy(input.launch.evidence.knownAt,cut)) {
    const {snapshot:s,evidence:e}=input.launch;
    if(s.coin!==input.coin || compareGuardCursors(s.cursor,cursor)>0)throw new Error('Launch exceeds card context');
    card.evidence.push(e); card.identity.launchpad=s.launchpad;
    card.identity.name=toUntrusted(s.name,120);card.identity.symbol=toUntrusted(s.symbol,32);
    for(const j of s.jobs)card.jobs!.push({kind:j.kind,status:j.status,retryCode:'coverage_available',evidenceIds:[e.id]});
    const observed=<T>(id:MetricId,value:T,unit:Metric<T>['unit'],at=cursor):Metric<T>=>({...unknown(id,unit),cursor:at,knownAt:e.knownAt,status:'observed',value,failureCode:null,evidenceIds:[e.id],coverage:{...coverage,scopeId:'launch-roles',from:at,through:at,complete:true,gaps:[],sourceHashes:[e.payloadHash]}});
    for(const [field,role] of [['factoryDeployer','factory_deployer'],['outerSigner','outer_signer'],['principal','launch_principal'],['creationPayer','creation_payer']] as const) {
      const rows=s.roles.filter(r=>r.role===role && r.status==='verified' && r.address!==null);
      if(rows.length===1)card.identity[field]=observed(field,rows[0].address!,'address',rows[0].cursor);
    }
    for(const role of ['fee_recipient','exempt'] as const) for(const r of s.roles.filter(r=>r.role===role)) {
      const row={role,address:r.address && r.status==='verified'?observed('principal',r.address,'address',r.cursor):unknown<Address>('principal','address'),effectiveCursor:r.cursor,evidenceIds:[e.id]};
      (role==='exempt'?card.identity.exemptions:card.identity.feeRecipients).push(row);
    }
    for(const [field,value] of [['createdAt',s.createdAtSec],['firstTrade',s.firstTradeSec]] as const) if(value!==null)card.identity[field]=observed(field,value,'seconds');
    if(s.quoteAsset)card.identity.quoteAsset=observed('quoteAsset',s.quoteAsset,'address');
    if(s.service && guardKnownBy(s.service.knownAt,cut)) {
      const service=s.service;
      card.identity.service={...card.identity.service,status:service.status,address:observed('principal',service.address,'address'),codeHash:service.codeHash,implementation:service.implementation?observed('principal',service.implementation,'address'):unknown('principal','address'),effectiveCursor:service.effectiveCursor,registryVersion:service.registryVersion,evidenceIds:[e.id]};
      const countMetric=(id:MetricId,value:number,complete:boolean):Metric<number>=>complete?observed(id,value,'count'):value>0?{...unknown<number>(id,'count'),status:'lower_bound',value}:unknown<number>(id,'count');
      card.identity.service.launches=countMetric('serviceLaunchCount',service.launches,service.launchCoverageComplete);
      card.identity.service.principals=countMetric('servicePrincipalCount',service.principals,service.principalCoverageComplete);
      if(service.pairDenominator>0) {
        const n=BigInt(service.pairs)*100n,d=BigInt(service.pairDenominator),scale=10n**18n;
        let scaled=n*scale/d;const remainder=n*scale%d;
        if(remainder*2n>d || (remainder*2n===d && scaled%2n===1n))scaled++;
        const value=`${scaled/scale}.${(scaled%scale).toString().padStart(18,'0')}`.replace(/\.?0+$/,'');
        const ratio={...unknown<string>('distinctPrincipalFeePairsPct','pct'),numerator:String(service.pairs),denominator:String(service.pairDenominator),denominatorKind:'other' as const,evidenceIds:[e.id]};
        // Incomplete numerator AND denominator enumeration is not a ratio lower bound.
        card.identity.service.distinctPairsPct=service.pairCoverageComplete?{...ratio,status:'observed',value,failureCode:null,coverage:{...coverage,complete:true,gaps:[],sourceHashes:[e.payloadHash]}}:ratio;
      }
      if(service.degree!==null && service.degreeStatus!=='unknown') {
        const complete=service.degreeCoverage?.complete===true;
        card.identity.service.degree=countMetric('hubDegree',service.degree,complete);
        card.identity.service.degreeCoverage={...coverage,from:null,through:cursor,complete,gaps:complete?[]:['missing'],sourceHashes:service.degreeCoverage?.evidenceIds ?? []};
        card.identity.service.degree.coverage=card.identity.service.degreeCoverage;
      }
    }
  }
  if(card.identity.principal.value!==null)for(const source of input.measurements) {
    const supply=SupplySnapshotV2Schema.safeParse(source.content);
    if(!supply.success || supply.data.coin!==input.coin || !admit(supply.data))continue;
    const h=supply.data.holdings.find(h=>h.address===card.identity.principal.value);
    if(h && card.holdings.principal.raw.status==='unknown')Object.assign(card.holdings.principal,{raw:h.raw,liquid:h.liquid,locked:h.locked,supplyPct:h.supplyPct,floatPct:h.floatPct});
  }
  card.evidence=card.evidence.map(e=>({...e,...(e.text?{text:toUntrusted(e.text.text,4000)}:{})}));
  return CoinCardV2Schema.parse(card);
}
