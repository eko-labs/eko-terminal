import { labelTier, type LabelTier, type WalletLabel } from '@eko/shared';
import type { WalletFeatures } from './features.js';
export const FP_MODEL={version:'fp-1.0.0',threshold:0.75,bias:-3.2,
  w:{aa4337:1.6,d7702:1.2,paymaster:0.8,knownRouter:2.0,routerLoyal:0.6,shape:0.9,regular:1.3,cron:1.1,allDay:0.7,fast:1.8,fixedSize:0.9,fixedGas:0.7,orbio:1.5}} as const;
export interface FingerprintModel {version:string;threshold:number;bias:number;w:Record<keyof typeof FP_MODEL.w,number>}
export function likelyAgentScore(f:WalletFeatures,m:FingerprintModel=FP_MODEL):number {
  if(f.swaps<5)return 0;
  const on=(b:boolean)=>b?1:0;
  const x:Record<keyof typeof m.w,number>={aa4337:f.aa4337Share??0,d7702:on(f.delegated7702===true),paymaster:f.paymasterShare??0,
    knownRouter:on(f.routerKnownAgent===true),routerLoyal:on(f.routerTopShare!==null&&f.routerTopShare>0.8),shape:on(f.calldataShapeShare!==null&&f.calldataShapeShare>0.9),
    regular:on(f.intervalCv!==null&&f.intervalCv<0.35),cron:on(f.secOfMinuteEntropy!==null&&f.secOfMinuteEntropy<3),allDay:on(f.hourEntropy!==null&&f.hourEntropy>4.3),
    fast:on(f.reactionP10Blocks!==null&&f.reactionP10Blocks<=10),fixedSize:on(f.sizeRepeatShare!==null&&f.sizeRepeatShare>0.6),fixedGas:on(f.gasLimitRepeatShare!==null&&f.gasLimitRepeatShare>0.8),orbio:on(f.orbioCredit===true)};
  const z=(Object.keys(m.w) as (keyof typeof m.w)[]).reduce((sum,k)=>sum+m.w[k]*x[k],m.bias);
  return 1/(1+Math.exp(-z));
}
export interface FingerprintCrew {status:'qualified';crewId:string;confidence:number;evidence:unknown}
export function resolveFingerprintLabel(f:WalletFeatures,options:{declared?:boolean;crew?:FingerprintCrew|null;model?:FingerprintModel}={}) {
  const m=options.model??FP_MODEL,crew=options.crew;
  if(!m.version||!Number.isFinite(m.threshold)||m.threshold<0||m.threshold>1||!Number.isFinite(m.bias)||Object.values(m.w).some(w=>!Number.isFinite(w)))throw new Error('Invalid fingerprint model');
  if(crew&&(crew.status!=='qualified'||!crew.crewId||!Number.isFinite(crew.confidence)||crew.confidence<0||crew.confidence>1))throw new Error('Unqualified crew attachment');
  const score=likelyAgentScore(f,m);
  const label:WalletLabel=options.declared?'declared_agent':crew?'crew':f.swaps>=5&&score>=m.threshold?'likely_agent':'human';
  const confidence=options.declared?0.99:crew?crew.confidence:label==='likely_agent'?score:1-score;
  const tier:LabelTier|null=!options.declared&&!crew&&f.swaps<5?'low':labelTier(confidence)??null;
  return {label,confidence,tier,crewId:crew?.crewId??null,score,modelVersion:m.version,beta:true as const};
}
