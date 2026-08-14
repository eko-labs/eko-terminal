import { address, hash, cursor } from './reference-fixtures.js';
import { localRouteStateHash, type LocalDepthRoute } from '../src/simulation/directional-depth.js';
import { Q96 } from '../src/simulation/depth-v3.js';
export const unit=10n**18n;
export function route(venue:'pons_curve'|'uniswap_v3'='pons_curve'):LocalDepthRoute {
  const base={id:`fixture-${venue}`,poolId:`pool-${venue}`,coin:address(10),cursor,origin:'fixture' as const,
    quoteUsd:{numerator:1_000_000n,denominator:unit},verification:{reviewed:true,stateHash:hash('pending'),profileHash:hash('profile'),evidenceIds:[hash('state')]}};
  const r:LocalDepthRoute=venue==='pons_curve'?{...base,venue,state:{tokens:10_000_000n*unit,realQuote:100_000n*unit,virtualQuote:100_000n*unit,reservedTokens:unit},
    buyTerms:[{kind:'ordinary',base:'gross',bps:100n,fixedWei:0n}],sellTerms:[{kind:'creator',base:'gross',bps:400n,fixedWei:0n}]}:
    {...base,venue,state:{sqrtPriceX96:Q96,coinIsToken0:true,feePips:3000n,complete:true,hook:'none',ranges:[{lower:Q96/2n,upper:Q96*2n,liquidity:100_000n*unit}]}};
  return repin(r);
}
export function repin(r:LocalDepthRoute):LocalDepthRoute {r.verification={...r.verification,stateHash:localRouteStateHash(r)};return r;}
