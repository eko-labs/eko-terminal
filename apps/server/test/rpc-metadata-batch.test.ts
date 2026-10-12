import { expect, it, vi } from 'vitest';
import type { PublicClient } from 'viem';
import { chainTokenMeta } from '../src/pricing-repair.js';
const token=`0x${'11'.repeat(20)}`;
it('returns identical metadata while three calls become one batch',async()=>{
  const readContract=vi.fn(async({functionName}:{functionName:string})=>functionName==='decimals'?18:functionName==='symbol'?'DEMO':'Sample');
  const before=await chainTokenMeta(()=>({readContract}) as unknown as PublicClient)(token);
  expect(readContract).toHaveBeenCalledTimes(3);readContract.mockClear();
  const multicall=vi.fn(async()=>[18,'DEMO','Sample'].map(result=>({status:'success',result})));
  expect(await chainTokenMeta(()=>({readContract,multicall}) as unknown as PublicClient)(token)).toEqual(before);
  expect(multicall).toHaveBeenCalledTimes(1);expect(readContract).not.toHaveBeenCalled();
});
it('keeps failed getters null without dropping successful values',async()=>{
  const multicall=vi.fn(async()=>[{status:'success',result:18},{status:'failure',error:new Error('revert')},{status:'success',result:'Sample'}]);
  expect(await chainTokenMeta(()=>({multicall}) as unknown as PublicClient)(token)).toEqual({decimals:18,symbol:null,name:'Sample'});
});
