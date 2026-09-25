import { FP_MODEL } from '../src/watcher/score.js';
import type { CensusEvaluationInput } from '../src/watcher/evaluate.js';
import type { WalletFeatures } from '../src/watcher/features.js';
export const evaluationTime=Date.parse('2026-10-03T12:00:00Z');
export const evaluationAddress=(n:number)=>`0x${n.toString(16).padStart(40,'0')}` as `0x${string}`;
export function evaluationFeatures(agent:boolean):WalletFeatures {
  return {swaps:20,aa4337Share:agent?1:0,delegated7702:agent,paymasterShare:agent?1:0,
    routerTopShare:agent?1:0,routerKnownAgent:agent,calldataShapeShare:agent?1:0,intervalCv:agent?0:1,
    secOfMinuteEntropy:agent?0:5,hourEntropy:agent?4.5:1,reactionP10Blocks:agent?1:50,
    sizeRepeatShare:agent?1:0,gasLimitRepeatShare:agent?1:0,orbioCredit:agent,txEntropy:1,missing:[]};
}
/** Synthetic classifier observations, never live precision evidence. */
export function censusEvaluationFixture():CensusEvaluationInput {
  return {kind:'census-wallet-labels-v1',model:structuredClone(FP_MODEL),trainingWallets:[evaluationAddress(9999)],rows:[
    {source:'declared',wallet:evaluationAddress(1),heldOut:true,declared:true,features:evaluationFeatures(true)},
    ...Array.from({length:500},(_,n)=>({source:'reviewed' as const,wallet:evaluationAddress(n+2),heldOut:true as const,
      features:evaluationFeatures(n<200),reviews:[{reviewer:'reviewer-one',label:n<200?'agent' as const:'human' as const},
        {reviewer:'reviewer-two',label:n<200?'agent' as const:'human' as const}] as [{reviewer:string;label:'agent'|'human'},{reviewer:string;label:'agent'|'human'}]})),
  ]};
}
