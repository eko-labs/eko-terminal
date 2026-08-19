import { expect, it, vi } from 'vitest';
import type { PublicClient } from 'viem';
import { batchedReads } from '../src/rpc/batched-reads.js';
const address=`0x${'11'.repeat(20)}` as const;
const input={address,abi:[{type:'function',name:'liquidity',stateMutability:'view',inputs:[],outputs:[{type:'uint128'}]}] as const,functionName:'liquidity',blockNumber:1n} as const;
it('returns identical independent pinned getters with one paid batch instead of three calls',async()=>{
  const readContract=vi.fn(async()=>10n),multicall=vi.fn(async({contracts}:{contracts:unknown[]})=>contracts.map(()=>({status:'success',result:10n})));
  const original={readContract,multicall} as unknown as PublicClient,client=batchedReads(original);
  expect(await Promise.all([original.readContract(input),original.readContract(input),original.readContract(input)])).toEqual([10n,10n,10n]);
  expect(readContract).toHaveBeenCalledTimes(3);readContract.mockClear();
  expect(await Promise.all([client.readContract(input),client.readContract(input),client.readContract(input)])).toEqual([10n,10n,10n]);
  expect(multicall).toHaveBeenCalledTimes(1);expect(readContract).not.toHaveBeenCalled();expect(multicall.mock.calls[0][0]).toMatchObject({blockNumber:1n});
});
it('preserves individual failures, isolates blocks and leaves caller/override/latest reads unbatched',async()=>{
  const readContract=vi.fn(async()=>10n),error=new Error('getter reverted');
  const multicall=vi.fn(async()=>[{status:'success',result:10n},{status:'failure',error}]);
  const client=batchedReads({readContract,multicall} as unknown as PublicClient);
  expect(await Promise.allSettled([client.readContract(input),client.readContract(input)])).toEqual([{status:'fulfilled',value:10n},{status:'rejected',reason:error}]);
  multicall.mockClear();
  await Promise.all([client.readContract(input),client.readContract({...input,blockNumber:2n}),client.readContract({...input,blockNumber:undefined}),
    client.readContract({...input,account:address}),client.readContract({...input,stateOverride:[]})]);
  expect(multicall).not.toHaveBeenCalled();expect(readContract).toHaveBeenCalledTimes(5);
});
