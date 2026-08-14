import { describe, expect, it } from 'vitest';
import { depthProvesFloor, solveDirectionalDepth } from '../src/simulation/depth.js';
import { localDirectionalDepth, localSizeQuote, selectBestNetRoute } from '../src/simulation/directional-depth.js';
import { Q96, v3LocalSwap, v3MaximumInput } from '../src/simulation/depth-v3.js';
import { removalDepth, type ValidatedDepthPosition } from '../src/simulation/depth-removal.js';
import { computeLocalDepthRun } from '../src/simulation/depth-run.js';
import { ponsLocalRoundTrip } from '../src/simulation/pons-math.js';
import { route, repin, unit } from './directional-depth-fixtures.js';
import { hash } from './reference-fixtures.js';
const p={numerator:1n,denominator:1n};
const quoteInput={sizeUsdE6:1_000_000_000n,accountClass:'standard-eoa',ekoBuyBps:0n,ekoSellBps:0n};
describe('48 total local evaluations, conservative directional bounds',()=>{
 it('includes bracketing in the budget and refines a near-cap threshold to <=1%',()=>{
  let calls=0;const b=solveDirectionalDepth({inputUsd:p,monotonicityProved:true,accepts:n=>{calls++;return n<=999_900_000_000n;}});
  expect(b.status).toBe('bounded');expect(b.reason).toBe('refined');expect(calls).toBe(b.evaluations);expect(calls).toBeLessThanOrEqual(48);
  expect(Number(b.relativeWidthPct)).toBeLessThanOrEqual(1);expect(BigInt(b.lowerInput!)).toBeLessThanOrEqual(999_900_000_000n);expect(BigInt(b.upperInput!)).toBeGreaterThan(999_900_000_000n);
  expect(b.remoteSearchCalls).toBe(0);
 });
 it('retains the $1m lower bound with no invented upper bound',()=>{
  const b=solveDirectionalDepth({inputUsd:p,monotonicityProved:true,accepts:()=>true});
  expect(b).toMatchObject({status:'lower_bound',reason:'search_cap',lowerUsd:'1000000',upperUsd:null,remoteSearchCalls:0});expect(b.evaluations).toBe(21);
  expect(depthProvesFloor(b,50_000_000_000n)).toBe(true);expect(depthProvesFloor(b,1_000_001_000_000n)).toBe(false);
 });
 it('keeps only proved bounds after exhaustion, including refinement exhaustion',()=>{
  const b=solveDirectionalDepth({inputUsd:p,monotonicityProved:true,evaluationBudget:3,accepts:n=>n<10_000_000_000n});
  expect(b).toMatchObject({evaluations:3,status:'lower_bound',reason:'evaluation_cap',lowerUsd:'4',upperUsd:null});
  expect(depthProvesFloor(b,4_000_000n)).toBe(true);expect(depthProvesFloor(b,5_000_000n)).toBe(false);
  const refine=solveDirectionalDepth({inputUsd:p,monotonicityProved:true,evaluationBudget:22,accepts:n=>n<999_900_000_000n});
  expect(refine.reason).toBe('evaluation_cap');expect(refine.upperInput).not.toBeNull();expect(refine.status).toBe('lower_bound');
 });
 it('rejects missing monotonic proof without evaluating and records raw precision/zero',()=>{
  const b=solveDirectionalDepth({inputUsd:p,monotonicityProved:false,accepts:()=>{throw new Error('must not evaluate');}});
  expect(b.status).toBe('unsupported');expect(b.evaluations).toBe(0);expect(depthProvesFloor(b,0n)).toBe(false);
  const zero=solveDirectionalDepth({inputUsd:p,monotonicityProved:true,maximumInput:0n,accepts:()=>false});expect(zero).toMatchObject({status:'exact',lowerUsd:'0',upperUsd:'0',evaluations:0});
  const lattice=solveDirectionalDepth({inputUsd:{numerator:2_000_000n,denominator:1n},monotonicityProved:true,accepts:n=>n<=3n});
  expect(lattice).toMatchObject({status:'exact',lowerInput:'3',upperInput:'3',lowerUsd:'6'});
  expect(()=>solveDirectionalDepth({inputUsd:p,monotonicityProved:true,evaluationBudget:49,accepts:()=>true})).toThrow('domain');
 });
});
describe('fee-free marginal depth, isolated fee-inclusive size execution',()=>{
 it.each([2,5,10] as const)('matches the constant-product inversion at %s%%, independently of fees',cut=>{
  const r=route();for(const direction of ['buy','sell'] as const){
   const b=localDirectionalDepth(r,direction,cut).bounds;
   const expected=200_000*(direction==='buy'?Math.sqrt(1+cut/100)-1:1/Math.sqrt(1-cut/100)-1);
   expect(Number(b.lowerUsd)).toBeLessThanOrEqual(expected);expect(Number(b.upperUsd)).toBeGreaterThanOrEqual(expected);expect(Number(b.relativeWidthPct)).toBeLessThanOrEqual(1);
   if(r.venue==='pons_curve')r.buyTerms=r.sellTerms=[{kind:'hook',base:'gross',bps:2000n,fixedWei:0n}];repin(r);
   expect(localDirectionalDepth(r,direction,cut).bounds).toEqual(b);
  }
 });
 it.each([true,false])('matches exact concentrated-liquidity interval inversion, coin0=%s',coinIsToken0=>{
  const r=route('uniswap_v3');if(r.venue!=='uniswap_v3')throw new Error('fixture');r.state.coinIsToken0=coinIsToken0;repin(r);
  for(const direction of ['buy','sell'] as const)for(const cut of [2,5,10] as const){
   const b=localDirectionalDepth(r,direction,cut).bounds;
   const expected=100_000*(direction==='buy'?Math.sqrt(1+cut/100)-1:1/Math.sqrt(1-cut/100)-1);
   expect(Number(b.lowerUsd)).toBeLessThanOrEqual(expected);expect(Number(b.upperUsd)).toBeGreaterThanOrEqual(expected);
  }
 });
 it('crosses an exact initialized boundary, conserving per-interval inputs/fees and immutable state',()=>{
  const r=route('uniswap_v3');if(r.venue!=='uniswap_v3')throw new Error('fixture');const boundary=Q96*1005n/1000n,l=100_000n*unit;
  r.state.ranges=[{lower:Q96/2n,upper:boundary,liquidity:l},{lower:boundary,upper:Q96*2n,liquidity:2n*l}];repin(r);
  const b=localDirectionalDepth(r,'buy',2).bounds,expected=100_000*0.005+200_000*(Math.sqrt(1.02)-1.005);
  expect(Number(b.lowerUsd)).toBeLessThanOrEqual(expected);expect(Number(b.upperUsd)).toBeGreaterThanOrEqual(expected);
  const swap=v3LocalSwap(r.state,2000n*unit,true,true);
  expect(swap.state.sqrtPriceX96).toBeGreaterThan(boundary);expect(swap.spent).toBe(2000n*unit);expect(swap.fees).toBeGreaterThan(0n);
  expect(r.state.sqrtPriceX96).toBe(Q96);expect(v3LocalSwap(r.state,v3MaximumInput(r.state,true)+1n,true,false).capacity).toBe(false);
 });
 it('keeps unknown/nonmonotone hooks and incomplete tick maps unsupported',()=>{
  const r=route('uniswap_v3');if(r.venue!=='uniswap_v3')throw new Error('fixture');
  for(const hook of ['unknown','nonmonotone'] as const){r.state.hook=hook;repin(r);expect(localDirectionalDepth(r,'sell',2).bounds).toMatchObject({status:'unsupported',evaluations:0});expect(localSizeQuote(r,quoteInput).status).toBe('unsupported');}
  r.state.hook='none';r.state.complete=false;repin(r);expect(localDirectionalDepth(r,'buy',2).bounds.status).toBe('unsupported');
 });
 it('quotes every actual size directly with fees and keeps sell-only separate',()=>{
  const r=route();if(r.venue!=='pons_curve')throw new Error('fixture');const before=structuredClone(r);
  for(const size of [100n,1000n,1337n,10000n]){
   const q=localSizeQuote(r,{...quoteInput,sizeUsdE6:size*1_000_000n}),exact=ponsLocalRoundTrip(r.state,size*unit,r.buyTerms,r.sellTerms);
   if(!exact.sell.capacity)throw new Error('fixture');expect(q.tokens).toBe(exact.buy.tokens.toString());expect(q.returned).toBe(exact.sell.returned.toString());expect(q.validation).toBe('local_prediction');
  }
  expect(r).toEqual(before);
  const held=localSizeQuote(r,{...quoteInput,heldTokens:100n*unit});expect(held.mode).toBe('sell_only');expect(held.spent).toBe('0');expect(held.venueRoundTripCostPct).toBeNull();
  const taxed=localSizeQuote(r,{...quoteInput,ekoBuyBps:100n,ekoSellBps:100n});expect(BigInt(taxed.returned)).toBeLessThan(BigInt(localSizeQuote(r,quoteInput).returned));expect(BigInt(taxed.ekoFees)).toBeGreaterThan(0n);
 });
 it('retains partial final-buy refunds and sells the valid acquired reserve-boundary position',()=>{
  const r=route();if(r.venue!=='pons_curve')throw new Error('fixture');r.state.reservedTokens=r.state.tokens*999n/1000n;repin(r);
  const q=localSizeQuote(r,quoteInput);expect(q.status).toBe('ok');expect(BigInt(q.refund)).toBeGreaterThan(0n);expect(BigInt(q.spent)+BigInt(q.refund)).toBe(BigInt(q.requested));expect(BigInt(q.returned)).toBeGreaterThan(0n);
 });
 it('chooses best net proceeds independently per size and preserves byte-ordered exact ties',()=>{
  const a=route(),b=route();a.id='route-z';b.id='route-a';
  const quotes=[a,b].map(r=>localSizeQuote(r,quoteInput));expect(selectBestNetRoute(quotes)).toMatchObject({best:{routeId:'route-a'},ties:['route-a','route-z']});
  if(a.venue==='pons_curve')a.sellTerms=[];repin(a);expect(selectBestNetRoute([localSizeQuote(a,quoteInput),localSizeQuote(b,quoteInput)]).best?.routeId).toBe('route-z');
  // Distinct rational proceeds below the display precision are not ties.
  const tiny={...quotes[0],netUsdE6:{numerator:'1',denominator:'3'}};
  expect(selectBestNetRoute([tiny,{...quotes[1],netUsdE6:{numerator:'1',denominator:'2'}}]).ties).toEqual(['route-a']);
  expect(()=>selectBestNetRoute([quotes[0],{...quotes[1],accountClass:'other'}])).toThrow('Mixed');
 });
 it('records no-exit zero and model pin mismatch without inventing a quote',()=>{
  const r=route();if(r.venue!=='pons_curve')throw new Error('fixture');r.state.realQuote=0n;repin(r);expect(localDirectionalDepth(r,'sell',2).bounds.lowerUsd).toBe('0');
  r.state.realQuote=1n;expect(localDirectionalDepth(r,'buy',2).bounds.status).toBe('unsupported');
 });
});
describe('validated removal and run provenance',()=>{
 function position(r:ReturnType<typeof route>):ValidatedDepthPosition {
  if(r.venue!=='uniswap_v3')throw new Error('fixture');const t=r.state.ranges[0];return {id:'position-1',poolId:r.poolId,cursor:r.cursor,controller:'demo-controller',custody:'removable',validated:true,routeStateHash:r.verification.stateHash,origin:r.origin,evidenceIds:[hash('position')],lower:t.lower,upper:t.upper,liquidity:t.liquidity/2n};
 }
 it('subtracts only validated per-pool positions and sums independent notional capacity',()=>{
  const a=route('uniswap_v3'),b=route('uniswap_v3');b.id='secondary';b.poolId='secondary';const p=position(a);
  const removed=removalDepth([a,b],[p],'demo-controller',true,true);expect(removed.status).toBe('bounded');expect(Number(removed.lowerShare)).toBeLessThanOrEqual(0.25);expect(Number(removed.upperShare)).toBeGreaterThanOrEqual(0.25);expect(Number(removed.upperShare)-Number(removed.lowerShare)).toBeLessThan(0.02);
  expect(removalDepth([a,b],[{...p,custody:'locked'}],'demo-controller',true,true).lowerShare).toBe('0');expect(a.verification.stateHash).toBe(p.routeStateHash);
  expect(removalDepth([a],[{...p,validated:false}],'demo-controller',true,true).status).toBe('unknown');
  expect(removalDepth([a],[{...p,routeStateHash:hash('changed')}],'demo-controller',true,true).status).toBe('unknown');
  expect(removalDepth([a,a],[p],'demo-controller',true,true).reason).toBe('duplicate_pool');
  expect(removalDepth([a],[p],'demo-controller',false,true).status).toBe('unknown');
  expect(removalDepth([a],[p],'demo-controller',true,false).reason).toBe('position_coverage');
 });
 it('distinguishes zero full depth from a ratio and supports total reachable removal',()=>{
  const a=route('uniswap_v3');if(a.venue!=='uniswap_v3')throw new Error('fixture');const p=position(a);p.liquidity*=2n;
  const gone=removalDepth([a],[p],'demo-controller',true,true);expect(gone.lowerShare).toBe('1');expect(gone.upperShare).toBe('1');
  a.state.ranges[0].liquidity=0n;repin(a);const zero=removalDepth([a],[],'demo-controller',true,true);expect(zero).toMatchObject({status:'unknown',reason:'zero_full_depth',noExit:true,lowerShare:null});
 });
 it('returns all six cuts, independent size bands, domains and local request counts',()=>{
  const r=route(),run=computeLocalDepthRun({routes:[r],discoveryComplete:true,controller:'demo-controller',positions:null,accounts:[{id:'standard-eoa',ekoBuyBps:0n,ekoSellBps:0n}]});
  expect(run.directionalDepth).toHaveLength(6);expect(run.sizeQuotes).toHaveLength(3);expect(run.origin).toBe('fixture');expect(run.validation).toBe('local_prediction');expect(run.remoteSearchCalls).toBe(0);
  expect(run.localEvaluations).toBe(run.directionalDepth.reduce((n,d)=>n+d.bounds.evaluations,0));expect(run.localSizeQuoteEvaluations).toBe(3);
  expect(run.directionalDepth.every(d=>d.bounds.evaluations<=48&&d.bounds.domain.capUsd==='1000000')).toBe(true);
  expect(()=>computeLocalDepthRun({routes:[r,{...r,id:'other',origin:'measured'}],discoveryComplete:true,controller:'demo-controller',positions:null,accounts:[{id:'standard-eoa',ekoBuyBps:0n,ekoSellBps:0n}]})).toThrow('Mixed');
 });
});
