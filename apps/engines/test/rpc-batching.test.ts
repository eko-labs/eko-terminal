import { expect, it, vi } from 'vitest';
import { readPonsProfile, type PonsProfileClient } from '@eko/chain';
import { ReplayMetrics } from '../src/metrics.js';
const address=`0x${'11'.repeat(20)}` as const;
it('keeps optional Multicall3 through worker instrumentation: identical profile, three calls become one',async()=>{
  const readContract=vi.fn(async({functionName}:Parameters<PonsProfileClient['readContract']>[0])=>functionName==='creatorTaxBps'?100n:functionName==='feeBps'?50n:0n);
  const getCode=vi.fn(async()=> '0x6000' as const);
  const legacy: PonsProfileClient={readContract,getCode};
  const before=await readPonsProfile(new ReplayMetrics().profile(legacy),address,address,1n);
  expect(readContract).toHaveBeenCalledTimes(3);readContract.mockClear();getCode.mockClear();
  const readGetters=vi.fn(async()=>[100n,50n,0n] as const),metrics=new ReplayMetrics();
  const after=await readPonsProfile(metrics.profile({...legacy,readGetters}),address,address,1n);
  expect(after).toEqual(before);expect(readContract).not.toHaveBeenCalled();expect(readGetters).toHaveBeenCalledTimes(1);
  expect(metrics.rpcCalls).toEqual({pons_getters_batch:1,eth_getCode:1});
});
it('preserves batch failures rather than silently falling back to three calls',async()=>{
  const readContract=vi.fn(),getCode=vi.fn(async()=> '0x6000' as const),readGetters=vi.fn(async()=>{throw new Error('getter reverted');});
  await expect(readPonsProfile(new ReplayMetrics().profile({readContract,getCode,readGetters}),address,address,1n)).rejects.toThrow('getter reverted');
  expect(readContract).not.toHaveBeenCalled();
});
