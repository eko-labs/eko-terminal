import type { GuardCursor } from '@eko/shared';
import type { Hex } from 'viem';
import { referenceDigest } from './reference.js';
import { localDirectionalDepth, localRouteStateHash, supportsLocalDepth, initialMarginal, type LocalDepthRoute } from './directional-depth.js';
import { decimalUsd, type DepthBounds } from './depth.js';
export interface ValidatedDepthPosition {
  id:string;poolId:string;controller:string;cursor:GuardCursor;custody:'removable'|'locked'|'burned'|'unknown';validated:boolean;
  routeStateHash:Hex;origin:'fixture'|'measured';evidenceIds:Hex[];
  lower:bigint;upper:bigint;liquidity:bigint;
}
/** Independent single-pool reachable routes only. Do not count the same pool twice.
 * LP units are subtracted only from their own pool's aligned tick intervals. */
export function removalDepth(routes:LocalDepthRoute[],positions:ValidatedDepthPosition[],controller:string,discoveryComplete:boolean,positionCoverageComplete:boolean) {
  const unknown=(reason:string)=>({status:'unknown' as const,reason,lowerShare:null,upperShare:null,noExit:false,full:[] as DepthBounds[],without:[] as DepthBounds[],evaluations:0,remoteSearchCalls:0 as const});
  if(!routes.length)return unknown('route_coverage');
  if(!positionCoverageComplete)return unknown('position_coverage');
  if(routes.some(r=>r.coin!==routes[0].coin||r.origin!==routes[0].origin||referenceDigest(r.cursor)!==referenceDigest(routes[0].cursor)))return unknown('mixed_snapshot');
  if(!discoveryComplete||routes.some(r=>!supportsLocalDepth(r)))return unknown('route_coverage');
  if(new Set(routes.map(r=>r.poolId)).size!==routes.length)return unknown('duplicate_pool');
  if(new Set(positions.map(p=>p.id)).size!==positions.length)return unknown('duplicate_position');
  const snapshots=routes.map(r=>({...r,state:r.venue==='uniswap_v3'?{...r.state,ranges:r.state.ranges.map(x=>({...x}))}:{...r.state}} as LocalDepthRoute));
  for(const p of positions){
    const i=routes.findIndex(r=>r.poolId===p.poolId),r=routes[i],copy=snapshots[i];
    if(!p.validated||!p.evidenceIds.length||!r||p.origin!==r.origin||p.routeStateHash!==localRouteStateHash(r)||referenceDigest(p.cursor)!==referenceDigest(r.cursor)||p.liquidity<0n||p.lower>=p.upper||p.custody==='unknown')return unknown('position_input');
    if(r.venue!=='uniswap_v3'||copy.venue!=='uniswap_v3')return unknown('position_venue');
    const original=r.state.ranges.filter(t=>t.lower>=p.lower&&t.upper<=p.upper);
    const selected=copy.state.ranges.filter(t=>t.lower>=p.lower&&t.upper<=p.upper);
    if(!selected.length||selected[0].lower!==p.lower||selected.at(-1)!.upper!==p.upper||original.some(t=>t.liquidity<p.liquidity))return unknown('position_ranges');
    if(p.controller!==controller||p.custody!=='removable')continue;
    if(selected.some(t=>t.liquidity<p.liquidity))return unknown('position_liquidity');
    for(const t of selected)t.liquidity-=p.liquidity;
  }
  const full=routes.map(r=>localDirectionalDepth(r,'sell',2).bounds);
  const without=snapshots.map((r,i)=>{
    r.verification={...r.verification,stateHash:localRouteStateHash(r)};
    return localDirectionalDepth(r,'sell',2,initialMarginal(routes[i])).bounds;
  });
  const e6=(s:string)=>{const [a,b='']=s.split('.');return BigInt(a)*1_000_000n+BigInt(b.padEnd(6,'0'));};
  const total=(bs:DepthBounds[],upper:boolean):bigint|null=>bs.some(b=>(upper?b.upperUsd:b.lowerUsd)===null)?null:bs.reduce((n,b)=>n+e6((upper?b.upperUsd:b.lowerUsd)!),0n);
  const fLo=total(full,false)!,fHi=total(full,true),wLo=total(without,false)!,wHi=total(without,true);
  const evaluations=[...full,...without].reduce((n,b)=>n+b.evaluations,0);
  if(fHi===0n)return {...unknown('zero_full_depth'),noExit:true,full,without,evaluations};
  if(fLo===0n||fHi===null||wHi===null)return {...unknown('depth_bounds'),full,without,evaluations};
  const lo=wHi>=fLo?0n:(fLo-wHi)*1_000_000n/fLo;
  const hi=wLo>=fHi?0n:((fHi-wLo)*1_000_000n+fHi-1n)/fHi;
  return {status:'bounded' as const,reason:'validated_positions',lowerShare:decimalUsd(lo),upperShare:decimalUsd(hi),noExit:false,full,without,evaluations,remoteSearchCalls:0 as const};
}
export const depthPositionHash=(p:ValidatedDepthPosition)=>referenceDigest(p);
