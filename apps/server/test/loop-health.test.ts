import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { ChainDb } from '@eko/db';
import { rpcRoleHealth, RpcGuardError, createSqlUsageStore } from '@eko/chain';
import * as retention from '@eko/db';
import { LoopHeartbeat, loopHealth } from '../src/loop-health.js';
import { healthRoutes } from '../src/http/v1/health.js';
import { loadConfig } from '../src/config.js';
import { RetentionWorker } from '../src/retention-worker.js';
import { PricingRepairWorker } from '../src/pricing-repair.js';
import { CoinOnboardingWorker } from '../src/coin-onboarding.js';
import { ReadStore } from '../src/read/store.js';

const usage = async () => ({ day: '2026-10-17', today: [], refusedToday: 0, paidOpen: false, budgetLeft: 0, sessionUnits: 0 });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('keeps liveness healthy with unstarted or stale loops while loop readiness follows three periods', async () => {
  let now = 1000;
  const loops = Object.fromEntries(['retention', 'partitions', 'refresher', 'pricingRepair', 'onboarding'].map((name, i) => [name, new LoopHeartbeat((i + 1) * 1000, () => now)]));
  const probe = vi.fn(async () => {});
  const app = Fastify();
  await healthRoutes(app, usage, loadConfig({ NODE_ENV: 'test' }), probe, () => loopHealth(loops));
  const check = async (statusCode: number) => {
    const live = await app.inject('/health');
    const ready = await app.inject('/health/loops');
    expect(live.statusCode).toBe(200);
    expect(ready.statusCode).toBe(statusCode);
    expect(live.json()).toEqual(ready.json());
    expect(live.json().ok).toBe(true);
    expect(live.headers['cache-control']).toBe('no-store');
    expect(ready.headers['cache-control']).toBe('no-store');
    return ready.json();
  };
  try {
    expect((await check(503)).loops.retention).toEqual({ name: 'retention', periodSec: 1, lastCycleAt: null, stale: true });
    for (const heartbeat of Object.values(loops)) { heartbeat.start(); heartbeat.complete(); }
    expect((await check(200)).loops.retention).toEqual({ name: 'retention', periodSec: 1, lastCycleAt: 1000, stale: false });
    now = 4000;
    await check(200);
    now++;
    const dead = await check(503);
    expect(dead.loops.retention.stale).toBe(true);
    expect(dead.loops.partitions.stale).toBe(false);
    loops.retention.start(); // Repeated starts cannot hide missing completions.
    await check(503);
    loops.retention.complete();
    await check(200);
    expect(probe).toHaveBeenCalledTimes(12);
  } finally { await app.close(); }
});

it('both health endpoints reject database failure with the same bounded body and recover on reconnect', async () => {
  const probe = vi.fn(async () => {}).mockRejectedValue(new Error('fixture connection details'));
  const app = Fastify();
  const rpc = vi.fn(usage);
  await healthRoutes(app, rpc, loadConfig({ NODE_ENV: 'test' }), probe);
  try {
    const live = await app.inject('/health');
    const ready = await app.inject('/health/loops');
    expect(live.statusCode).toBe(503);
    expect(ready.statusCode).toBe(503);
    expect(live.json()).toEqual({ ok: false, loops: {}, rpc: null });
    expect(ready.json()).toEqual(live.json());
    expect(live.body).not.toContain('fixture connection details');
    probe.mockResolvedValue();
    expect((await app.inject('/health')).statusCode).toBe(200);
    expect((await app.inject('/health/loops')).statusCode).toBe(200);
    rpc.mockRejectedValue(new Error('fixture usage failure'));
    for (const path of ['/health', '/health/loops']) {
      const response = await app.inject(path);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true, loops: {}, rpc: null });
    }
  } finally { await app.close(); }
});

it('retention and hourly partitions record separate completed passes; a hung pass cannot heartbeat', async () => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  const result = { quoteRows: 0, idleTokens: 0, idleRows: 0, pendingRows: 0, feedRows: 0, dangerCoins: 0, quietCoins: 0, historyTransfers: 0, historyLiquidity: 0, historyPons: 0, historySwaps: 0, trendingSnapshots: 0, skippedRules: [], finished: true };
  const run = vi.spyOn(retention, 'runRetention').mockResolvedValue(result);
  const worker = new RetentionWorker({} as ChainDb, { swapDays: 7 }, vi.fn(), 1000);
  worker.start(); await worker.tick();
  expect(worker.heartbeat.snapshot().lastCycleAt).toBe(1000);
  expect(worker.partitionHeartbeat.snapshot().lastCycleAt).toBe(1000);
  let release!: () => void;
  run.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(result); }));
  await vi.advanceTimersByTimeAsync(4001);
  expect(worker.heartbeat.snapshot().ok).toBe(false);
  expect(worker.partitionHeartbeat.snapshot().ok).toBe(true);
  release(); await worker.tick(); await worker.stop();
  expect(worker.heartbeat.snapshot().lastCycleAt).toBe(5001);
  expect(worker.partitionHeartbeat.snapshot().lastCycleAt).toBe(1000);
});

it('pricing, onboarding and projection timers report completion rather than entry into a hung cycle', async () => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  const db = {} as ChainDb;
  const pricing = new PricingRepairWorker(db, vi.fn());
  const onboarding = new CoinOnboardingWorker(db, {} as never, vi.fn());
  const reads = new ReadStore(db);
  let release!: () => void;
  const hung = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(pricing as unknown as { pass(): Promise<void> }, 'pass').mockResolvedValueOnce().mockReturnValue(hung);
  vi.spyOn(onboarding as unknown as { pass(): Promise<void> }, 'pass').mockResolvedValueOnce().mockReturnValue(hung);
  vi.spyOn(reads, 'refreshModels').mockResolvedValueOnce().mockReturnValue(hung);
  vi.spyOn(reads, 'refreshRanks').mockResolvedValue();
  vi.spyOn(reads, 'refreshSummaries').mockResolvedValue();
  pricing.start(); onboarding.start(); reads.start();
  await vi.advanceTimersByTimeAsync(250);
  expect(pricing.heartbeat.snapshot().lastCycleAt).toBe(1000);
  expect(onboarding.heartbeat.snapshot().lastCycleAt).toBe(1000);
  expect(reads.heartbeat.snapshot().lastCycleAt).toBe(1250);
  await vi.advanceTimersByTimeAsync(120_001);
  for (const heartbeat of [pricing.heartbeat, onboarding.heartbeat, reads.heartbeat]) expect(heartbeat.snapshot().ok).toBe(false);
  release(); await pricing.stop(); await onboarding.stop(); await reads.close();
});

 it('reports cross-process RPC pauses on v1 readiness while database liveness stays 200', async () => {
  const db = await retention.openDb({pgliteDir: ':memory:'});
  const app = Fastify();
  try {
    const update = await rpcRoleHealth(db, 'engines');
    await app.register(async v1 => healthRoutes(v1, usage, loadConfig({NODE_ENV:'test'}), () => db.sql.query('SELECT 1'), undefined, db), {prefix:'/v1'});
    const pause = {state:'PAUSED' as const, reason:'provider_balance_exceeded' as const, provider:'paid' as const, since:1000, nextRetryAt:11000};
    await update(pause);
    const ready = await app.inject('/v1/health/loops');
    expect(ready.statusCode).toBe(503);expect((await app.inject('/v1/health')).statusCode).toBe(200);
    expect(ready.json().loops.engines).toEqual({...pause, stale:false});
    await db.sql.query('UPDATE rpc_role_health SET updated_at=0');
    expect((await app.inject('/v1/health/loops')).json().loops.engines.stale).toBe(true);
    await update(null);expect((await app.inject('/v1/health/loops')).statusCode).toBe(200);
  } finally {await app.close();await db.close();}
});


it('reports the shared provider pause even before an indexer or engines role starts',async()=>{
  const db=await retention.openDb({pgliteDir:':memory:'}),app=Fastify();
  try {
    const control=createSqlUsageStore(db).providerPause!;
    const pause=await control.refuse('provider_quota_exceeded',1000);
    await app.register(async v1=>healthRoutes(v1,usage,loadConfig({NODE_ENV:'test'}),()=>db.sql.query('SELECT 1'),undefined,db),{prefix:'/v1'});
    const ready=await app.inject('/v1/health/loops');
    expect(ready.statusCode).toBe(503);expect(ready.json().loops.provider).toEqual(pause);
    expect((await app.inject('/v1/health')).statusCode).toBe(200);
    expect(await control.claim('sample-probe','indexer',11000,1000)).toBe(true);
    await control.finish('sample-probe',11000,null,300000);
    expect((await app.inject('/v1/health/loops')).statusCode).toBe(200);
  }finally{await app.close();await db.close();}
});

it('parks worker passes until the provider retry time without emitting per-pass failures',async()=>{
  let now=1000;
  const log=vi.fn(),db={} as ChainDb;
  const workers=[new PricingRepairWorker(db,log,()=>now),new CoinOnboardingWorker(db,{} as never,log,{now:()=>now})];
  for(const worker of workers) {
    const pass=vi.spyOn(worker as unknown as {pass():Promise<void>},'pass')
      .mockRejectedValueOnce(new RpcGuardError('provider_balance_exceeded','provider_balance_exceeded',true,61000))
      .mockResolvedValue();
    await worker.tick();
    for(let i=0;i<20;i++)await worker.tick();
    expect(pass).toHaveBeenCalledTimes(1);
    now=61000;await worker.tick();expect(pass).toHaveBeenCalledTimes(2);now=1000;
    await worker.stop();
  }
  expect(log).not.toHaveBeenCalled();
});
