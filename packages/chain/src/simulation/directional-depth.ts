import type { GuardCursor } from '@eko/shared';
import type { Address, Hex } from 'viem';
import { referenceDigest } from './reference.js';
import { ponsBuy, ponsSell, type PonsChargeTerm, type PonsCurveState } from './pons-math.js';
import { solveDirectionalDepth, ceilDiv, rawForUsd, usdE6, decimalUsd, type Rational, type DepthBounds, type DepthCut, type DepthDirection, type RationalWire } from './depth.js';
import { validV3Depth, v3LocalSwap, v3Marginal, v3MaximumInput, type V3DepthState } from './depth-v3.js';
interface LocalRouteBase {
  id:string; poolId:string; coin:Address; cursor:GuardCursor; origin:'fixture'|'measured';
  /** Micro USD per quote raw unit, selected by the pinned §2.5 USD-quality adapter. */
  quoteUsd:Rational;
  verification:{reviewed:boolean;stateHash:Hex;profileHash:Hex;evidenceIds:Hex[]};
}
export type LocalDepthRoute = LocalRouteBase & (
  {venue:'pons_curve';state:PonsCurveState;buyTerms:PonsChargeTerm[];sellTerms:PonsChargeTerm[]} |
  {venue:'uniswap_v3';state:V3DepthState}
);
/** State and fee bindings are immutable inputs from reconstruction/profile review. */
export const localRouteStateHash=(r:LocalDepthRoute)=>referenceDigest(r.venue==='pons_curve'?{state:r.state,buyTerms:r.buyTerms,sellTerms:r.sellTerms}:{state:r.state});
export function supportsLocalDepth(r:LocalDepthRoute):boolean {
  if(!r.verification.reviewed||!r.verification.evidenceIds.length||r.verification.stateHash!==localRouteStateHash(r)||r.quoteUsd.numerator<=0n||r.quoteUsd.denominator<=0n)return false;
  if(r.venue==='uniswap_v3')return validV3Depth(r.state);
  const s=r.state;
  if(s.tokens<=0n||s.realQuote<0n||s.virtualQuote<=0n||s.reservedTokens<0n||s.reservedTokens>s.tokens)return false;
  return [...r.buyTerms,...r.sellTerms].every(t=>t.bps>=0n&&t.bps<=10000n&&t.fixedWei>=0n);
}
export function initialMarginal(r:LocalDepthRoute):Rational {
  return r.venue==='pons_curve'?{numerator:r.state.realQuote+r.state.virtualQuote,denominator:r.state.tokens}:v3Marginal(r.state);
}
export function inputUsd(r:LocalDepthRoute,direction:DepthDirection,p=initialMarginal(r)):Rational {
  return direction==='buy'?r.quoteUsd:{numerator:p.numerator*r.quoteUsd.numerator,denominator:p.denominator*r.quoteUsd.denominator};
}
function maximum(r:LocalDepthRoute,buy:boolean):bigint|undefined {
  if(r.venue==='uniswap_v3')return v3MaximumInput(r.state,buy);
  const s=r.state,q=s.realQuote+s.virtualQuote;
  if(buy)return s.reservedTokens===0n?undefined:ceilDiv((s.tokens-s.reservedTokens)*q,s.reservedTokens);
  // floor(x*q/(t+x)) <= realQuote, with strict integer inequality.
  return s.realQuote===0n?0n:s.virtualQuote<=1n?undefined:ceilDiv((s.realQuote+1n)*s.tokens,s.virtualQuote-1n)-1n;
}
function swap(r:LocalDepthRoute,raw:bigint,buy:boolean,fees:boolean) {
  if(raw===0n)return {capacity:true,spent:0n,output:0n,fees:0n,route:r};
  if(r.venue==='uniswap_v3'){
    const q=v3LocalSwap(r.state,raw,buy,fees);return {...q,route:{...r,state:q.state} as LocalDepthRoute};
  }
  if(buy){const q=ponsBuy(r.state,raw,fees?r.buyTerms:[]);return {capacity:true,spent:q.spent,output:q.tokens,fees:q.fees.total,route:{...r,state:q.state} as LocalDepthRoute};}
  const q=ponsSell(r.state,raw,fees?r.sellTerms:[]);
  return q.capacity?{capacity:true,spent:raw,output:q.returned,fees:q.fees.total,route:{...r,state:q.state} as LocalDepthRoute}:{capacity:false,spent:0n,output:0n,fees:0n,route:r};
}
export interface LocalDirectionalDepth {cursor:GuardCursor;evidenceIds:Hex[];routeId:string;poolId:string;direction:DepthDirection;discountPct:DepthCut;bounds:DepthBounds}
/** Marginal post-trade price; average output discount is never used by this solver. */
export function localDirectionalDepth(r:LocalDepthRoute,direction:DepthDirection,cut:DepthCut,valuation=initialMarginal(r)):LocalDirectionalDepth {
  const buy=direction==='buy',supported=supportsLocalDepth(r),initial=initialMarginal(r);
  const bounds=solveDirectionalDepth({inputUsd:inputUsd(r,direction,valuation),maximumInput:supported?maximum(r,buy):undefined,monotonicityProved:supported,
    accepts:raw=>{
      const q=swap(r,raw,buy,false);if(!q.capacity||q.spent!==raw)return false;
      const post=initialMarginal(q.route);
      return buy?post.numerator*initial.denominator*100n<=initial.numerator*post.denominator*BigInt(100+cut):
        post.numerator*initial.denominator*100n>=initial.numerator*post.denominator*BigInt(100-cut);
    }});
  return {cursor:r.cursor,evidenceIds:r.verification.evidenceIds,routeId:r.id,poolId:r.poolId,direction,discountPct:cut,bounds};
}
export interface LocalSizeQuote {
  routeId:string;sizeUsd:string;accountClass:string;mode:'round_trip'|'sell_only';validation:'local_prediction';
  status:'ok'|'entry_limited'|'capacity_limited'|'unsupported';requested:string;spent:string;refund:string;tokens:string;returned:string;
  returnedUsdE6:string;netUsdE6:RationalWire;buyFees:string;sellFees:string;ekoFees:string;venueRoundTripCostPct:string|null;
}
/** Separate fee-inclusive execution from marginal depth. Every size is a fresh state. */
export function localSizeQuote(r:LocalDepthRoute,input:{sizeUsdE6:bigint;accountClass:string;ekoBuyBps:bigint;ekoSellBps:bigint;heldTokens?:bigint}):LocalSizeQuote {
  const {sizeUsdE6,ekoBuyBps,ekoSellBps,heldTokens}=input;
  if(sizeUsdE6<=0n||heldTokens!==undefined&&heldTokens<=0n||[ekoBuyBps,ekoSellBps].some(n=>n<0n||n>10000n))throw new Error('Invalid quote input');
  const requested=heldTokens??rawForUsd(sizeUsdE6,r.quoteUsd);
  const out:LocalSizeQuote={routeId:r.id,sizeUsd:decimalUsd(sizeUsdE6),accountClass:input.accountClass,mode:heldTokens===undefined?'round_trip':'sell_only',validation:'local_prediction',status:'unsupported',requested:requested.toString(),spent:'0',refund:'0',tokens:'0',returned:'0',returnedUsdE6:'0',netUsdE6:{numerator:'0',denominator:'1'},buyFees:'0',sellFees:'0',ekoFees:'0',venueRoundTripCostPct:null};
  if(!supportsLocalDepth(r))return out;
  try {
    let route=r,tokens=heldTokens??0n,spent=0n,ekoBuy=0n;
    if(heldTokens===undefined){
      ekoBuy=requested*ekoBuyBps/10000n;
      const buy=swap(r,requested-ekoBuy,true,true);
      if(!buy.capacity||buy.output===0n){out.status='entry_limited';return out;}
      if(buy.spent!==requested-ekoBuy&&ekoBuy>0n)return out; // No reviewed partial-refund app-fee model.
      route=buy.route;tokens=buy.output;spent=buy.spent+ekoBuy;out.refund=(requested-spent).toString();out.buyFees=buy.fees.toString();
    }
    out.spent=spent.toString();out.tokens=tokens.toString();
    const sell=swap(route,tokens,false,true);
    if(!sell.capacity){out.status='capacity_limited';return out;}
    const ekoSell=sell.output*ekoSellBps/10000n,returned=sell.output-ekoSell;
    out.status='ok';out.returned=returned.toString();out.returnedUsdE6=usdE6(returned,r.quoteUsd).toString();out.netUsdE6={numerator:(returned*r.quoteUsd.numerator).toString(),denominator:r.quoteUsd.denominator.toString()};out.sellFees=sell.fees.toString();out.ekoFees=(ekoBuy+ekoSell).toString();
    if(spent>0n){const n=(spent-returned)*100_000_000n/spent;out.venueRoundTripCostPct=`${n<0n?'-':''}${decimalUsd(n<0n?-n:n)}`;}
    return out;
  }catch{return {...out,status:'unsupported'};}
}
/** Byte ordering (no locale collation); all exact ties are retained. */
export function selectBestNetRoute(quotes:LocalSizeQuote[]) {
  if(quotes.some(q=>q.sizeUsd!==quotes[0].sizeUsd||q.accountClass!==quotes[0].accountClass||q.mode!==quotes[0].mode))throw new Error('Mixed quote selection');
  const compare=(a:LocalSizeQuote,b:LocalSizeQuote)=>{
    const x=BigInt(a.netUsdE6.numerator)*BigInt(b.netUsdE6.denominator),y=BigInt(b.netUsdE6.numerator)*BigInt(a.netUsdE6.denominator);
    return x>y?-1:x<y?1:0;
  };
  const ok=quotes.filter(q=>q.status==='ok').sort((a,b)=>compare(a,b)||Buffer.compare(Buffer.from(a.routeId),Buffer.from(b.routeId)));
  const best=ok[0]??null;
  return {quotes,best,ties:best?ok.filter(q=>compare(q,best)===0).map(q=>q.routeId):[],unsupportedRoutes:quotes.filter(q=>q.status==='unsupported').map(q=>q.routeId)};
}
