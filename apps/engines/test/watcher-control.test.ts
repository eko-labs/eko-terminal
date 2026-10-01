import { afterEach, expect, it, vi } from 'vitest';
import { watcherRefreshControl } from '../src/watcher/control.js';
import { refreshFingerprints } from '../src/watcher/store.js';
import { refreshFlows, refreshCoinFlow, refreshCensus } from '../src/watcher/flow-store.js';
import type { ChainDb } from '@eko/db';
afterEach(()=>vi.unstubAllEnvs());
it('defaults on, accepts emergency off values and logs only once when paused',()=>{
  const env:NodeJS.ProcessEnv={},log=vi.fn(),enabled=watcherRefreshControl(()=>env,log);
  expect(enabled()).toBe(true);
  env.ENGINE_WATCHER_REFRESH_ENABLED='false';expect(enabled()).toBe(false);expect(enabled()).toBe(false);
  env.ENGINE_WATCHER_REFRESH_ENABLED='0';expect(enabled()).toBe(false);expect(log).toHaveBeenCalledExactlyOnceWith('watcher_refresh_paused');
  env.ENGINE_WATCHER_REFRESH_ENABLED='true';expect(enabled()).toBe(true);
  env.ENGINE_WATCHER_REFRESH_ENABLED='typo';expect(enabled).toThrow('Invalid ENGINE_WATCHER_REFRESH_ENABLED');
});
it('paused fingerprint, flow and Census refreshes do no database work',async()=>{
  vi.stubEnv('ENGINE_WATCHER_REFRESH_ENABLED','false');
  const query=vi.fn(()=>{throw new Error('Unexpected database read');}),db={sql:{query}} as unknown as ChainDb;
  expect(await refreshFingerprints(db,1)).toEqual({wallets:0,runs:0,labels:0});
  expect(await refreshFlows(db,1)).toEqual({coins:0});
  expect(await refreshCoinFlow(db,`0x${'ab'.repeat(20)}`,1)).toMatchObject({swaps:0});
  expect(await refreshCensus(db,{finalized:{status:'available',block:1}})).toEqual({status:'unavailable'});
  expect(query).not.toHaveBeenCalled();
});
