import type { Abi, PublicClient } from 'viem';
import { rpcScope, withRpcOrigin } from './origin.js';
/** Caller-independent, pinned getters only. Simulations, account reads with overrides and latest reads bypass batching. */
const getters=new Set(['token','factory','pairToken','graduated','readyToGraduate','getReserves','sellableTokens',
  'realQuoteReserve','feeBps','creatorTaxBps','currentSnipeTaxBps','decimals','locker','positionManager','memeHook',
  'poolManager','lockedPositions','ownerOf','getApproved','getPositionLiquidity','getPoolAndPositionInfo',
  'liquidity','slot0','token0','balanceOf','allowance','extsload','name','symbol']);
type Input=Parameters<PublicClient['readContract']>[0];
export function batchedReads(client:PublicClient):PublicClient {
  const pending=new Map<string,{input:Input;resolve:(value:unknown)=>void;reject:(error:unknown)=>void}[]>();
  const readContract=(input:Input):Promise<unknown>=>{
    const definition=input.abi.find(item=>item && typeof item==='object' && 'type' in item && item.type==='function' && 'name' in item && item.name===input.functionName) as {stateMutability?:unknown}|undefined;
    if(!input.address || !definition || !['view','pure'].includes(String(definition.stateMutability)) || input.blockNumber==null || !getters.has(input.functionName) || input.account || input.stateOverride || input.authorizationList
      || input.factory || input.factoryData) return client.readContract(input);
    const block=input.blockNumber,key=`${block}:${rpcScope()?.work ?? 'routine'}`;
    return new Promise((resolve,reject)=>{
      const group=pending.get(key);
      if(group){group.push({input,resolve,reject});return;}
      const items=[{input,resolve,reject}];pending.set(key,items);
      const origin=rpcScope()?.origin ?? 'server.getters';
      queueMicrotask(()=>{
        pending.delete(key);
        void withRpcOrigin(`${origin}.batch`,async()=>{
          try {
            if(items.length===1){items[0].resolve(await client.readContract(items[0].input));return;}
            const results=await client.multicall({allowFailure:true,blockNumber:block,
              contracts:items.map(({input:read})=>({address:read.address!,abi:read.abi as Abi,functionName:read.functionName,args:read.args}))});
            if(results.length!==items.length)throw new Error('Incomplete getter batch');
            results.forEach((result,i)=>result.status==='success' ? items[i].resolve(result.result) : items[i].reject(result.error));
          }catch(error){for(const item of items)item.reject(error);}
        });
      });
    });
  };
  return {...client,readContract:readContract as PublicClient['readContract']};
}
