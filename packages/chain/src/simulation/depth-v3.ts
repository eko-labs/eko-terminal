import { ceilDiv } from './depth.js';
export const Q96=1n<<96n;
/** Reconstructed constant-L tick intervals for ONE pool, including zero-L gaps.
 * Endpoints are exact pinned TickMath sqrt ratios, not interpolated prices.
 * Complete means every reachable interval through the venue extrema is present. */
export interface V3DepthState { sqrtPriceX96:bigint; coinIsToken0:boolean; feePips:bigint;
  ranges:{lower:bigint;upper:bigint;liquidity:bigint}[]; complete:boolean; hook:'none'|'unknown'|'nonmonotone' }
export function validV3Depth(s:V3DepthState):boolean {
  return s.complete && s.hook==='none' && s.feePips>=0n && s.feePips<1_000_000n && s.ranges.length>0 &&
    s.ranges.every((r,i)=>r.lower>0n&&r.upper>r.lower&&r.liquidity>=0n&&(i===0||s.ranges[i-1].upper===r.lower)) &&
    s.sqrtPriceX96>=s.ranges[0].lower&&s.sqrtPriceX96<=s.ranges.at(-1)!.upper;
}
export function v3Marginal(s:V3DepthState) {
  const a=s.sqrtPriceX96*s.sqrtPriceX96,b=Q96*Q96;
  return s.coinIsToken0?{numerator:a,denominator:b}:{numerator:b,denominator:a};
}
const delta0=(a:bigint,b:bigint,l:bigint,up:boolean)=>up?ceilDiv(l*Q96*(b-a),b*a):l*Q96*(b-a)/(b*a);
const delta1=(a:bigint,b:bigint,l:bigint,up:boolean)=>up?ceilDiv(l*(b-a),Q96):l*(b-a)/Q96;
/** Same input/output rounding and per-step fee order as a v3 exact-input swap.
 * Each call starts from the original immutable snapshot. */
export function v3LocalSwap(s:V3DepthState,raw:bigint,buy:boolean,fees:boolean) {
  if(!validV3Depth(s)||raw<0n)throw new Error('Unsupported v3 depth state');
  const down=buy?!s.coinIsToken0:s.coinIsToken0,fee=fees?s.feePips:0n;
  let sqrt=s.sqrtPriceX96,left=raw,output=0n,charges=0n;
  const ranges=down?[...s.ranges].reverse():s.ranges;
  for(const r of ranges){
    if(left===0n)break;
    if(down?r.lower>=sqrt:r.upper<=sqrt)continue;
    const target=down?r.lower:r.upper,l=r.liquidity;
    if(l===0n){sqrt=target;continue;}
    const required=down?delta0(target,sqrt,l,true):delta1(sqrt,target,l,true);
    const net=left*(1_000_000n-fee)/1_000_000n;
    let used:bigint,next:bigint,stepFee:bigint;
    if(net>=required){used=required;next=target;stepFee=ceilDiv(used*fee,1_000_000n-fee);}
    else {
      next=down?ceilDiv(l*Q96*sqrt,l*Q96+net*sqrt):sqrt+net*Q96/l;
      used=down?delta0(next,sqrt,l,true):delta1(sqrt,next,l,true);
      stepFee=left-used;
    }
    output+=down?delta1(next,sqrt,l,false):delta0(sqrt,next,l,false);
    left-=used+stepFee;charges+=stepFee;sqrt=next;
  }
  return {capacity:left===0n,spent:raw-left,output,fees:charges,state:{...s,sqrtPriceX96:sqrt}};
}
export function v3MaximumInput(s:V3DepthState,buy:boolean):bigint {
  const down=buy?!s.coinIsToken0:s.coinIsToken0,p=s.sqrtPriceX96;
  return s.ranges.reduce((sum,r)=>{
    if(down){const upper=r.upper<p?r.upper:p;return upper>r.lower?sum+delta0(r.lower,upper,r.liquidity,true):sum;}
    const lower=r.lower>p?r.lower:p;return lower<r.upper?sum+delta1(lower,r.upper,r.liquidity,true):sum;
  },0n);
}
