import { labelTier, type Flow, type FlowEvent, type WalletLabel, type LabelTier } from '@eko/shared';
import type { Address } from 'viem';
import type { QualifiedCrewAttachment } from '../registry-labels.js';
export type CrewInput = {status:'unavailable'} | {status:'available';member:QualifiedCrewAttachment|null};
export interface FlowLabel {label:WalletLabel;confidence:number;tier?:LabelTier|null;crewId?:string;unclassified?:boolean}
export interface FlowSwap {id:string;coin:Address;block:number;sec:number;side:'buy'|'sell';usd:number|null;wallet:Address|null;senderPending:boolean;pricePending:boolean}
export interface ClassifiedSwap extends FlowSwap {label:FlowLabel|null;crew:CrewInput}
export function resolveFlowLabel(label:FlowLabel|null,crew:CrewInput):FlowLabel|null {
  if(!label||label.unclassified)return null;
  if(crew.status==='available'&&crew.member&&crew.member.status!=='qualified')throw new Error('Unqualified crew input');
  const member=crew.status==='available'?crew.member:null;
  if(label.label==='declared_agent')return {...label,crewId:member?.crewId??(crew.status==='unavailable'?label.crewId:undefined)};
  if(member)return {label:'crew',confidence:member.confidence,tier:labelTier(member.confidence)??null,crewId:member.crewId};
  // Without a qualified membership cut, likely/human shares cannot bypass crew precedence.
  if(crew.status==='unavailable'||label.label==='crew')return null;
  return label;
}
export function flowMarker(s:ClassifiedSwap,modelVersion:string):FlowEvent|null {
  if(s.senderPending||s.pricePending||s.usd==null||!Number.isFinite(s.usd)||s.usd<0||!s.wallet)return null;
  const label=resolveFlowLabel(s.label,s.crew);if(!label)return null;
  return {coin:s.coin,block:s.block,ts:s.sec,side:s.side,sizeUsd:s.usd,wallet:s.wallet,label:label.label,confidence:label.confidence,crewId:label.crewId,beta:true,modelVersion};
}
const windows={'5m':300,'1h':3600,'24h':86400} as const;
/** Same actor/qualified crew, disjoint round trips; each swap contributes at most once. */
export function measureFlow(swaps:ClassifiedSwap[],window:Flow['window'],block:number,sec:number,modelVersion:string,duration:number=windows[window]) {
  // TODO(spec): Window endpoints are unspecified; use (asOf-duration, asOf], with a block cut as well.
  const selected=swaps.filter(s=>s.block<=block&&s.sec>sec-duration&&s.sec<=sec).sort((a,b)=>a.sec-b.sec||a.block-b.block||a.id.localeCompare(b.id));
  let buy=0,declared=0,likely=0,crew=0,human=0,confident=0,gross=0,wash=0;
  const missing=new Set<string>(),groups=new Map<string,ClassifiedSwap[]>();
  for(const s of selected) {
    const priced=!s.pricePending&&s.usd!=null&&Number.isFinite(s.usd)&&s.usd>=0;
    if(!priced){missing.add('price');continue;}
    const usd=s.usd!;gross+=usd;if(s.side==='buy')buy+=usd;
    if(s.senderPending||!s.wallet){missing.add('sender');continue;}
    const label=resolveFlowLabel(s.label,s.crew);
    if(s.crew.status==='unavailable')missing.add('crew_membership');
    if(!label){missing.add('labels');continue;}
    if(s.side==='buy') {
      if(label.label==='declared_agent')declared+=usd;
      else if(label.label==='likely_agent')likely+=usd;
      else if(label.label==='crew')crew+=usd;
      else human+=usd;
      if(['high','medium'].includes((label.tier===undefined?labelTier(label.confidence):label.tier)??''))confident+=usd;
    }
    const key=label.crewId?`crew:${label.crewId}`:`wallet:${s.wallet.toLowerCase()}`;const group=groups.get(key)??[];group.push(s);groups.set(key,group);
  }
  for(const group of groups.values()) {
    let queue:ClassifiedSwap[]=[];
    for(const s of group) {
      queue=queue.filter(t=>s.sec-t.sec<=300);queue.push(s);
      const buys=queue.filter(t=>t.side==='buy').reduce((n,t)=>n+t.usd!,0),sells=queue.filter(t=>t.side==='sell').reduce((n,t)=>n+t.usd!,0);
      // TODO(spec): |net| < 10% has no denominator specified; use gross USD of the round trip.
      if(buys>0&&sells>0&&Math.abs(buys-sells)/(buys+sells)<0.1){wash+=buys+sells;queue=[];}
    }
  }
  if(buy===0)missing.add('buy_volume');
  const gaps=missing.size>0;
  const pct=(n:number)=>buy>0?100*n/buy:0;
  const confidence=buy>0&&!missing.has('price')?confident/buy:0;
  const data:Flow={window,agentPct:pct(declared+likely),declaredAgentPct:pct(declared),likelyAgentPct:pct(likely),crewPct:pct(crew),humanPct:pct(human),washEstPct:gross>0?100*wash/gross:0,beta:true,confidence,modelVersion,
    meta:{confidence,asOfBlock:block,unavailable:gaps,missing:gaps?['agentPct','crewPct','humanPct','washEstPct','declaredAgentPct','likelyAgentPct']:[],flags:[...missing]}};
  return {data,buyUsd:buy,grossUsd:gross,declaredUsd:declared,likelyUsd:likely,crewUsd:crew,humanUsd:human};
}
