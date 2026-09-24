import { expect,it,vi } from 'vitest';
import { PartitionLockTimeoutError,type ChainDb } from '@eko/db';
import { startPartitionMaintenance } from '../src/partitions.js';
import { lockContention } from '../src/log-head.js';
it('periodically provisions today with no overlapping passes and drains on stop',async()=>{
 vi.useFakeTimers();
 let finish:()=>void=()=>{};
 const ensure=vi.fn(()=>new Promise<void>(resolve=>{finish=resolve;}));
 try {
  const stop=startPartitionMaintenance({ensurePartitions:ensure} as unknown as ChainDb,vi.fn());
  expect(ensure).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(600_000);expect(ensure).toHaveBeenCalledOnce();
  finish();await vi.advanceTimersByTimeAsync(600_000);expect(ensure).toHaveBeenCalledTimes(2);
  const stopped=stop();finish();await stopped;
  await vi.advanceTimersByTimeAsync(600_000);expect(ensure).toHaveBeenCalledTimes(2);
  expect(lockContention(new PartitionLockTimeoutError())).toBe(true);
 }finally{vi.useRealTimers();}
});
