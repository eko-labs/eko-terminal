import { decodeFunctionResult, encodeFunctionData, parseAbi, toHex, type Address, type Hex } from 'viem';
import { loadRegistry } from '../registry.js';
const abi = parseAbi(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)']);
/** Only caller-independent getters belong here; simulations and state overrides must keep their own caller. */
export async function batchGetters(rpc: {request(input:{method:string;params:readonly unknown[]}):Promise<unknown>},
  calls: readonly {to:Address;data:Hex}[], block: bigint): Promise<Hex[]> {
  if (!calls.length) return [];
  const data=encodeFunctionData({abi,functionName:'aggregate3',args:[calls.map(c=>({target:c.to,allowFailure:false,callData:c.data}))]});
  const raw=await rpc.request({method:'eth_call',params:[{to:loadRegistry().requireAddress('multicall3'),data},toHex(block)]});
  const results=decodeFunctionResult({abi,functionName:'aggregate3',data:raw as Hex});
  if(results.length!==calls.length || results.some(r=>!r.success))throw new Error('Getter batch failed');
  return results.map(r=>r.returnData);
}
