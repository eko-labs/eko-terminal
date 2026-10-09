import { afterEach,expect,it,vi } from 'vitest';
import { ChainClients } from '../src/exec/chain.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { ReadStore } from '../src/read/store.js';
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});
it('API-only startup and periodic health do not probe either chain',async()=>{
 vi.useFakeTimers({toFake:['setInterval','clearInterval']});
 const probes=vi.spyOn(ChainClients.prototype,'checkHealth').mockResolvedValue([]);
 const app=await buildApp(loadConfig({APP_ROLE:'api',NODE_ENV:'test',PGLITE_DIR:':memory:',SESSION_SECRET:'role-test-placeholder'.repeat(3),LEGACY_API:'true',RUN_WORKER:'false',LIVE_TRADING_ENABLED:'false',MARKET_DATA_SOURCE:'onchain'}));
 try {
  expect(probes).not.toHaveBeenCalled();await vi.advanceTimersByTimeAsync(21000);
  const health=(await app.app.inject('/v1/health')).json();expect(probes).not.toHaveBeenCalled();expect(health.rpc.today).toEqual([]);expect(health.rpc.sessionUnits).toBe(0);
 } finally {await app.close();}
},30000);
it('the worker serves no live streams, so engine bus events never refresh read models there',async()=>{
 // Each live upsert refreshed the whole read-model backlog inline in the worker, under the locks card writes need.
 const app=await buildApp(loadConfig({APP_ROLE:'worker',NODE_ENV:'test',PGLITE_DIR:':memory:',SESSION_SECRET:'role-test-placeholder'.repeat(3),LEGACY_API:'true',RUN_WORKER:'true',LIVE_TRADING_ENABLED:'false',MARKET_DATA_SOURCE:'onchain'}),{startBackground:false});
 try {
  const refresh=vi.spyOn(ReadStore.prototype,'refreshModels');
  const coin=`0x${'ab'.repeat(20)}`;
  (app.ctx.dbh.chain.bus as unknown as {publish(m:unknown):void}).publish({topic:'flow_updated',ids:{coin}});
  await new Promise(resolve=>setTimeout(resolve,100));
  expect(refresh).not.toHaveBeenCalled();
  const bootHealth = await app.app.inject('/v1/health');
  expect(bootHealth.statusCode).toBe(200);
  const bootLoops = await app.app.inject('/v1/health/loops');
  expect(bootLoops.statusCode).toBe(503);
  expect(bootLoops.json()).toEqual(bootHealth.json());
  expect(bootHealth.json().loops).not.toHaveProperty('refresher'); // API owns projections.
  expect(bootHealth.json().loops.pricingRepair.lastCycleAt).toBeNull();
  const loops = [app.ctx.pricingRepair.heartbeat, app.ctx.coinOnboarding.heartbeat];
  if (app.ctx.retentionWorker.enabled) loops.push(app.ctx.retentionWorker.heartbeat);
  if (app.ctx.retentionWorker.partitionsEnabled) loops.push(app.ctx.retentionWorker.partitionHeartbeat);
  for (const heartbeat of loops) { heartbeat.start(); heartbeat.complete(); }
  expect((await app.app.inject('/v1/health')).statusCode).toBe(200);
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 90_001);
  const live = await app.app.inject('/v1/health');
  expect(live.statusCode).toBe(200);
  const stalled = await app.app.inject('/v1/health/loops');
  expect(stalled.json()).toEqual(live.json());
  expect(stalled.statusCode).toBe(503);
  expect(stalled.json().ok).toBe(true);
  expect(stalled.json().loops.pricingRepair.stale).toBe(true);
  expect(stalled.json().loops.onboarding.stale).toBe(true);
 } finally {await app.close();}
},30000);
