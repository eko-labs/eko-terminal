/** Guard 2.0 §3.4. Pure integer search; no RPC or transport is accepted here. */
export type DepthDirection = 'buy' | 'sell';
export type DepthCut = 2 | 5 | 10;
export interface Rational { numerator: bigint; denominator: bigint }
export const ceilDiv = (n:bigint,d:bigint) => (n+d-1n)/d;
export const usdE6 = (raw:bigint,p:Rational,up=false) => up ? ceilDiv(raw*p.numerator,p.denominator) : raw*p.numerator/p.denominator;
export const rawForUsd = (usd:bigint,p:Rational) => ceilDiv(usd*p.denominator,p.numerator);
export function decimalUsd(n:bigint):string {
  const whole=n/1_000_000n,fraction=(n%1_000_000n).toString().padStart(6,'0').replace(/0+$/,'');
  return `${whole}${fraction?`.${fraction}`:''}`;
}
export interface DepthBounds {
  status:'bounded'|'exact'|'lower_bound'|'unsupported';
  method:'bracket_refine'|'exact'|'unsupported';
  reason:'refined'|'venue_maximum'|'search_cap'|'evaluation_cap'|'raw_precision'|'unsupported';
  lowerInput:string|null; upperInput:string|null; lowerUsd:string|null; upperUsd:string|null;
  relativeWidthPct:string|null; evaluations:number; remoteSearchCalls:0; monotonicityProved:boolean;
  domain:{startUsd:'1'; capUsd:'1000000'; maximumInput:string|null; inputUsd:RationalWire; precisionUsd:'0.000001'};
}
export interface RationalWire { numerator:string; denominator:string }
/** maxInput must be a proved executable venue maximum, never a coverage boundary. */
export function solveDirectionalDepth(input:{inputUsd:Rational; maximumInput?:bigint; monotonicityProved:boolean;
  accepts:(raw:bigint)=>boolean; evaluationBudget?:number}):DepthBounds {
  const p=input.inputUsd,max=input.maximumInput,budget=input.evaluationBudget??48;
  if(p.numerator<=0n || p.denominator<=0n || max!==undefined && max<0n || !Number.isInteger(budget) || budget<1 || budget>48)throw new Error('Invalid depth domain');
  const domain:DepthBounds['domain']={startUsd:'1',capUsd:'1000000',maximumInput:max?.toString()??null,inputUsd:{numerator:p.numerator.toString(),denominator:p.denominator.toString()},precisionUsd:'0.000001'};
  let lo=0n,hi:bigint|null=null,evaluations=0;
  const result=(status:DepthBounds['status'],reason:DepthBounds['reason']):DepthBounds=>({status,reason,method:status==='unsupported'?'unsupported':status==='exact'&&evaluations===0?'exact':'bracket_refine',
    lowerInput:status==='unsupported'?null:lo.toString(),upperInput:hi?.toString()??null,lowerUsd:status==='unsupported'?null:decimalUsd(usdE6(lo,p)),upperUsd:hi===null?null:decimalUsd(usdE6(hi,p,true)),
    relativeWidthPct:hi!==null&&lo>0n?decimalUsd((hi-lo)*100_000_000n/lo):null,evaluations,remoteSearchCalls:0,monotonicityProved:input.monotonicityProved,domain});
  if(!input.monotonicityProved)return result('unsupported','unsupported');
  if(max===0n){hi=0n;return result('exact','venue_maximum');}
  const cap=1_000_000_000_000n*p.denominator/p.numerator;
  if(cap===0n)return result('lower_bound','raw_precision');
  const end=max!==undefined&&max<cap?max:cap;
  let next=rawForUsd(1_000_000n,p);if(next>end)next=end;
  while(evaluations<budget){
    const ok=input.accepts(next);evaluations++;
    if(!ok){hi=next;break;}
    lo=next;
    if(next===end){if(max!==undefined&&max<=cap){hi=lo;return result('exact','venue_maximum');}return result('lower_bound','search_cap');}
    next=next*2n>end?end:next*2n;
  }
  if(hi===null)return result('lower_bound','evaluation_cap');
  while((hi-lo)*100n>lo && hi-lo>1n && evaluations<budget){
    const mid:bigint=(hi+lo)/2n;const ok=input.accepts(mid);evaluations++;
    if(ok)lo=mid;else hi=mid;
  }
  // On the raw lattice, an adjacent failing input proves the exact maximum.
  if(hi-lo===1n){hi=lo;return result('exact','raw_precision');}
  if((hi-lo)*100n<=lo)return result('bounded','refined');
  return result('lower_bound','evaluation_cap');
}
/** Proved lower bounds can pass floors, but an unknown or an upper bound cannot. */
export function depthProvesFloor(bound:DepthBounds,floorUsdE6:bigint):boolean {
  if(floorUsdE6<0n)throw new Error('Negative policy floor');
  if(bound.status==='unsupported'||bound.lowerInput===null||!bound.monotonicityProved)return false;
  const p=bound.domain.inputUsd;
  return BigInt(bound.lowerInput)*BigInt(p.numerator)>=floorUsdE6*BigInt(p.denominator);
}
