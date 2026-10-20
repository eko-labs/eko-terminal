import { CoinCardSchema, projectGuardAssessmentToV1, type CoinCard, type CoinCardV2, type GuardTotals, type GuardAssessmentV2, type Verdict } from '@eko/shared';

/** V1 transport only; caller must explicitly select a released V2 result. Existing
 * stored cards/proof payloads are never rewritten. Numeric meanings stay V1. */
export function projectGuardCardToV1(v2:CoinCardV2,legacy:CoinCard|null):CoinCard|null {
  if(!legacy || legacy.identity.address!==v2.identity.address || (v2.verdict && !Number.isSafeInteger(Number(v2.verdict.cursor.blockNumber))) || v2.identity.principal.value===null || v2.identity.factoryDeployer.value===null || !v2.verdict)return null;
  const card=CoinCardSchema.parse(legacy);
  card.verdict=projectGuardAssessmentToV1(v2.verdict,{receipt:{id:v2.verdict.receipt.id,hash:v2.verdict.receipt.payloadHash,status:v2.verdict.receipt.status==='anchored'?'committed':'pending',...(v2.verdict.receipt.status==='anchored'?{batchId:v2.verdict.receipt.batchId,txHash:v2.verdict.receipt.txHash}:{})},asOfBlock:Number(v2.verdict.cursor.blockNumber),playbooks:legacy.playbooks,evaluatedPlaybooks:legacy.verdict.evaluatedPlaybooks,beta:legacy.verdict.beta});
  card.meta={...card.meta};
  const mask=(section:keyof NonNullable<CoinCard['meta']>,fields:string[])=>{
    const prev=card.meta![section];
    card.meta![section]={confidence:prev?.confidence ?? 0,asOfBlock:prev?.asOfBlock ?? card.freshness.block,...prev,missing:[...new Set([...(prev?.missing ?? []),...fields])],unavailable:prev?.unavailable || fields.length>0};
  };
  const missing=(m:{status:string})=>m.status!=='observed';
  mask('tradeability',[
    ...(v2.tradeability.quotes.some(q=>missing(q.venueCostPct))?['exitCostPct']:[]),
    ...(missing(v2.tradeability.buyTaxPct)?['buyTaxPct']:[]),...(missing(v2.tradeability.sellTaxPct)?['sellTaxPct']:[]),
    ...(v2.tradeability.quotes.some(q=>missing(q.sellability))?['honeypot']:[]),
  ]);
  mask('liquidity',missing(v2.liquidity.headlineDepth2Usd)?['depthUsd']:[]);
  const controlFields={tax_raise:'canChangeTax',blacklist:'canBlacklist',sell_pause:'canPause',mint:'canMint',transfer_upgrade:'upgradeable',unlock:'unlock',liquidity_remove:'liquidityRemove',hook:'hook'} as const;
  mask('control',v2.control.powers.filter(p=>missing(p.reachable)).map(p=>controlFields[p.capability]));
  // V2 unclassified/float/group values never replace V1 humanPct/top10Pct/devPct.
  mask('flow',missing(v2.flow.agentPct)?['agentPct','crewPct','humanPct','washEstPct']:[]);
  return CoinCardSchema.parse(card);
}
export interface GuardTotalEntry {coin:string;assessment:GuardAssessmentV2|null;legacy:Verdict|null}
/** Complete live-source set, never a page; no-verdict and coverage are separate. */
export function projectGuardTotals(input:{activeVersion:'verdict-1'|'guard-2';sourceAvailable:boolean;entries:GuardTotalEntry[];evaluations:{coin:string;sec:number}[];nowSec:number}):GuardTotals {
  if(!input.sourceAvailable)return {status:'unavailable',activeVersion:input.activeVersion,failureCode:'missing'};
  const entries=[...new Map(input.entries.map(e=>[e.coin,e])).values()];
  let lower=0,elevated=0,high=0,incomplete=0,noVerdict=0,incompleteCoverage=0;
  for(const e of entries) {
    const level=input.activeVersion==='guard-2'?e.assessment?.level:e.legacy?.level;
    switch(level){case 'lower':case 'clear':lower++;break;case 'elevated':case 'monitor':elevated++;break;case 'high':case 'danger':high++;break;case 'incomplete':case 'pending':incomplete++;break;default:noVerdict++;}
    if(input.activeVersion==='guard-2'?e.assessment && (!e.assessment.completeness.buyCriticalComplete || !e.assessment.completeness.lowerTierComplete):level==='pending')incompleteCoverage++;
  }
  const day=Math.floor(input.nowSec/86400)*86400,live=new Set(entries.map(e=>e.coin));
  const evaluatedToday=new Set(input.evaluations.filter(e=>e.sec>=day && e.sec<day+86400 && live.has(e.coin)).map(e=>e.coin)).size;
  return {status:'observed',activeVersion:input.activeVersion,coins:entries.length,lower,elevated,high,incomplete,noVerdict,incompleteCoverage,evaluatedToday,clear:lower,monitor:elevated,danger:high,pending:incomplete+noVerdict};
}
