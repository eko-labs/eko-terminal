import { referenceDigest } from './reference.js';
import { localDirectionalDepth, localSizeQuote, selectBestNetRoute, type LocalDepthRoute } from './directional-depth.js';
import { removalDepth, type ValidatedDepthPosition } from './depth-removal.js';
import type { DepthCut, DepthDirection } from './depth.js';
// TODO(spec): §7.1 does not specify the reconstruction/run envelope. This versioned
// local prediction is retained separately from observed execution and card checks.
/** Explicit opt-in calculation, not a card/check-completion or activation path. */
export function computeLocalDepthRun(input:{routes:LocalDepthRoute[];discoveryComplete:boolean;controller:string;positions:ValidatedDepthPosition[]|null;positionCoverageComplete?:boolean;
  accounts:{id:string;ekoBuyBps:bigint;ekoSellBps:bigint}[];sizesUsdE6?:bigint[]}) {
  if(!input.routes.length||!input.accounts.length)throw new Error('Depth routes/accounts required');
  const first=input.routes[0],sizes=input.sizesUsdE6??[100_000_000n,1_000_000_000n,10_000_000_000n];
  if(new Set(input.routes.map(r=>r.id)).size!==input.routes.length||new Set(input.accounts.map(a=>a.id)).size!==input.accounts.length)throw new Error('Duplicate route/account');
  if(input.routes.some(r=>r.coin!==first.coin||r.origin!==first.origin||referenceDigest(r.cursor)!==referenceDigest(first.cursor)))throw new Error('Mixed depth snapshot');
  const directionalDepth=input.routes.flatMap(r=>(['buy','sell'] as DepthDirection[]).flatMap(direction=>([2,5,10] as DepthCut[]).map(cut=>localDirectionalDepth(r,direction,cut))));
  const sizeQuotes=input.accounts.flatMap(account=>sizes.map(size=>({sizeUsdE6:size.toString(),accountClass:account.id,
    ...selectBestNetRoute(input.routes.map(r=>localSizeQuote(r,{sizeUsdE6:size,accountClass:account.id,ekoBuyBps:account.ekoBuyBps,ekoSellBps:account.ekoSellBps})))})));
  const removal=input.positions===null?null:removalDepth(input.routes,input.positions,input.controller,input.discoveryComplete,input.positionCoverageComplete===true);
  const lower=(direction:DepthDirection)=>directionalDepth.filter(d=>d.direction===direction&&d.discountPct===2&&d.bounds.lowerUsd!==null)
    .sort((a,b)=>Number(b.bounds.lowerUsd)-Number(a.bounds.lowerUsd)||Buffer.compare(Buffer.from(a.routeId),Buffer.from(b.routeId)))[0]?.bounds.lowerUsd??null;
  const buy=lower('buy'),sell=lower('sell');
  // Single-route capacity is a conservative policy floor; no synthetic split router.
  const headlineDepth2LowerUsd=buy===null||sell===null?null:Number(buy)<Number(sell)?buy:sell;
  const body={methodVersion:'directional-depth-1' as const,coin:first.coin,cursor:first.cursor,origin:first.origin,discoveryComplete:input.discoveryComplete,
    validation:'local_prediction' as const,inputDigest:referenceDigest(input),routeSnapshots:JSON.parse(JSON.stringify(input.routes,(_,v)=>typeof v==='bigint'?v.toString():v)),
    directionalDepth,headlineDepth2LowerUsd,sizeQuotes,removal,localEvaluations:directionalDepth.reduce((n,d)=>n+d.bounds.evaluations,0)+(removal?.evaluations??0),
    localSizeQuoteEvaluations:input.routes.length*input.accounts.length*sizes.length,remoteSearchCalls:0 as const};
  return {id:referenceDigest(body),...body};
}
export type LocalDepthRun=ReturnType<typeof computeLocalDepthRun>;
