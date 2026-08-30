import { concatHex, encodeFunctionData, toHex, parseAbi, padHex, zeroAddress, type Address, type Hex } from 'viem';

export const referenceRouterAbi = parseAbi([
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256)',
  'function exactInput((bytes path,address recipient,uint256 amountIn,uint256 amountOutMinimum) params) payable returns (uint256)',
  'function unwrapWETH9(uint256 amountMinimum,address recipient) payable',
  'function multicall(uint256 deadline,bytes[] data) payable returns (bytes[] results)',
]);
export const referenceQuoterAbi = parseAbi([
  'function quoteExactInput(bytes path,uint256 amountIn) returns (uint256,uint160[],uint32[],uint256)',
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256,uint160,uint32,uint256)',
]);
export const referenceTokenAbi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
]);
export interface ProbeLeg { target: Address; value: bigint; data: Hex; amountOffset: bigint; patch: boolean }
/** Shared adapter boundary for 067/040. This implementation handles native entry/exit on verified v3 paths. */
export interface ReferenceRoute {
  venue: 'uniswap_v3'; id: string; coin: Address; router: Address; quoter: Address; weth: Address;
  fee: 100 | 500 | 3000 | 10000; deadline: bigint;
  /** Optional verified multi-hop native entry, e.g. WETH → USDG → coin. */
  hops?: {tokenOut:Address;fee:100|500|3000|10000}[];
  /** Pinned code/config provenance from route verification; absent evidence forbids execution. */
  verification: { blockHash: Hex; evidenceIds: Hex[] };
  entryLimitSelectors: Hex[];
  /** Null means temporary restrictions have not been resolved, rather than no cooldown. */
  cooldown: { seconds: number; evidenceIds: Hex[] } | null;
}
export function v3Legs(route: ReferenceRoute, recipient: Address, sizeWei: bigint) {
  const swapSingle = (buy: boolean, amount: bigint, to: Address) => encodeFunctionData({ abi: referenceRouterAbi, functionName: 'exactInputSingle', args: [{
    tokenIn: buy ? route.weth : route.coin, tokenOut: buy ? route.coin : route.weth,
    fee: route.fee, recipient: to, amountIn: amount, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n,
  }] });
  const swap=(buy:boolean,amount:bigint,to:Address)=>route.hops ? encodeFunctionData({abi:referenceRouterAbi,functionName:'exactInput',args:[{
    path:routePath(route,!buy),recipient:to,amountIn:amount,amountOutMinimum:0n,
  }]}) : swapSingle(buy,amount,to);
  const sell = (amount: bigint) => encodeFunctionData({ abi: referenceRouterAbi, functionName: 'multicall', args: [route.deadline, [
    swap(false, amount, padHex('0x02', { size: 20 })),
    encodeFunctionData({ abi: referenceRouterAbi, functionName: 'unwrapWETH9', args: [0n, recipient] }),
  ]] });
  const leg = (data: Hex, target: Address, value=0n, amountOffset=0n, patch=false): ProbeLeg => ({ target, value, data, amountOffset, patch });
  return {
    buy: leg(swap(true, sizeWei, recipient), route.router, sizeWei),
    // multicall head (64), array length (32), offsets (64), bytes length (32), selector (4), amount slot (128).
    sell: leg(sell(0n), route.router, 0n, route.hops?296n:328n, true),
    quoteSell: leg(quoteData(route,0n,true),route.quoter,0n,route.hops?36n:68n,true),
    sellWithAmount: sell,
  };
}
export function routePath(route:ReferenceRoute,reverse=false):Hex {
  const tokens=[route.weth,...route.hops!.map(h=>h.tokenOut)],fees=route.hops!.map(h=>h.fee);
  if(reverse){tokens.reverse();fees.reverse();}
  return concatHex(tokens.flatMap((token,i)=>i<fees.length?[token,toHex(fees[i],{size:3})]:[token]));
}
export function quoteData(route:ReferenceRoute,amount:bigint,sell=false):Hex {
  return route.hops ? encodeFunctionData({abi:referenceQuoterAbi,functionName:'quoteExactInput',args:[routePath(route,sell),amount]}) :
    encodeFunctionData({abi:referenceQuoterAbi,functionName:'quoteExactInputSingle',args:[{tokenIn:sell?route.coin:route.weth,tokenOut:sell?route.weth:route.coin,amountIn:amount,fee:route.fee,sqrtPriceLimitX96:0n}]});
}
export const isReferenceRoute = (route: ReferenceRoute, blockHash: Hex) => route.venue === 'uniswap_v3' &&
  route.verification.blockHash.toLowerCase() === blockHash.toLowerCase() && route.verification.evidenceIds.length > 0 && route.entryLimitSelectors.every(s=>/^0x[0-9a-fA-F]{8}$/.test(s)) &&
  (route.cooldown===null || Number.isSafeInteger(route.cooldown.seconds) && route.cooldown.seconds>=0 && route.cooldown.seconds<=3600 && route.cooldown.evidenceIds.length>0) &&
  [100,500,3000,10000].includes(route.fee) && (!route.hops || route.hops.length>=1 && route.hops.length<=3 &&
    route.hops.at(-1)!.tokenOut.toLowerCase()===route.coin.toLowerCase() && route.hops.every(h=>[100,500,3000,10000].includes(h.fee)) &&
    new Set([route.weth,...route.hops.map(h=>h.tokenOut)].map(a=>a.toLowerCase())).size===route.hops.length+1) && route.coin.toLowerCase() !== route.weth.toLowerCase() &&
  [route.coin,route.router,route.quoter,route.weth].every(a => /^0x[0-9a-fA-F]{40}$/.test(a) && a !== zeroAddress);
