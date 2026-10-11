import { afterEach, describe, expect, it, vi } from 'vitest';
import * as retention from '@eko/db';
import { migrate, type ChainDb } from '@eko/db';
import { openDb } from '../../../packages/db/test/helpers/historical-db.js';
import { loadConfig } from '../src/config.js';
import { ChainDb as Database } from '@eko/db';
import { RetentionWorker } from '../src/retention-worker.js';

const base = { NODE_ENV: 'test', PGLITE_DIR: ':memory:', SESSION_SECRET: 'sample-session-placeholder'.repeat(2) };
const sample = `0x${'1'.repeat(40)}`;
const walletCollectors = JSON.stringify({ wallets: { startBlock: 1, burnToken: sample, assets: [{ token: sample, decimals: 18, maxOutflowRaw: '1' }] } });
const handles: ChainDb[] = [];
afterEach(async () => { await Promise.all(handles.splice(0).map(db => db.close())); });

describe('chain retention settings', () => {
  it('defaults to report-only settlement, one-day raw and rating history and 24-hour receipt payloads',()=>{
    const c=loadConfig(base);expect(c.RETENTION_ENABLED).toBe(true);expect(loadConfig({...base,RETENTION_ENABLED:'false'}).RETENTION_ENABLED).toBe(false);expect([c.RETENTION_DRY_RUN,c.RETENTION_SETTLE_HOURS,c.RETENTION_RAW_DAYS,c.RETENTION_RATING_DAYS,c.RETENTION_RECEIPT_HOURS]).toEqual([true,24,1,1,24]);
    expect(loadConfig({...base,RETENTION_DRY_RUN:'false'}).RETENTION_DRY_RUN).toBe(false);
    expect(c.RETENTION_RECEIPT_KEEP_CURRENT).toBe(false);
    for(const value of ['true','1'])expect(loadConfig({...base,RETENTION_RECEIPT_KEEP_CURRENT:value}).RETENTION_RECEIPT_KEEP_CURRENT).toBe(true);
    for(const value of ['false','0',''])expect(loadConfig({...base,RETENTION_RECEIPT_KEEP_CURRENT:value}).RETENTION_RECEIPT_KEEP_CURRENT).toBe(false);
    expect(()=>loadConfig({...base,RETENTION_RECEIPT_KEEP_CURRENT:'invalid'})).toThrow('RETENTION_RECEIPT_KEEP_CURRENT');
    expect([c.RETENTION_SWAP_DAYS,c.RETENTION_TRANSFER_DAYS,c.FINGERPRINT_LOOKBACK_DAYS,c.FINGERPRINT_REFRESH_DAYS]).toEqual([1,1,1,1]);
    expect(loadConfig({...base,RETENTION_SWAP_DAYS:'10',RETENTION_TRANSFER_DAYS:'2',FINGERPRINT_LOOKBACK_DAYS:'4',FINGERPRINT_REFRESH_DAYS:'3'}).RETENTION_SWAP_DAYS).toBe(10);
    for(const key of ['RETENTION_TRANSFER_DAYS','FINGERPRINT_LOOKBACK_DAYS','FINGERPRINT_REFRESH_DAYS'])expect(()=>loadConfig({...base,[key]:'0'})).toThrow(key);
    expect(()=>loadConfig({...base,RETENTION_SWAP_DAYS:'0'})).toThrow('RETENTION_SWAP_DAYS');
    expect(()=>loadConfig({...base,FINGERPRINT_LOOKBACK_DAYS:'7'})).toThrow('must fit');
    for(const key of ['RETENTION_SETTLE_HOURS','RETENTION_RAW_DAYS','RETENTION_RATING_DAYS','RETENTION_RECEIPT_HOURS'])expect(()=>loadConfig({...base,[key]:'0'})).toThrow(key);
    for(const value of ['1','8760'])expect(loadConfig({...base,RETENTION_RECEIPT_HOURS:value}).RETENTION_RECEIPT_HOURS).toBe(Number(value));
    for(const value of ['1.5','8761'])expect(()=>loadConfig({...base,RETENTION_RECEIPT_HOURS:value})).toThrow('RETENTION_RECEIPT_HOURS');
    expect(()=>loadConfig({...base,RETENTION_DRY_RUN:'false',SECURITY_COLLECTORS:walletCollectors})).toThrow('wallet outflow collectors');
    expect(loadConfig({...base,RETENTION_ENABLED:'false',RETENTION_DRY_RUN:'false',SECURITY_COLLECTORS:walletCollectors}).RETENTION_ENABLED).toBe(false);
  });
  it('keeps legacy rules optional and bounds one-day feed and pending defaults, and refused alongside the wallet outflow collectors', () => {
    const off = loadConfig(base);
    expect([off.RETENTION_QUOTE_TRANSFER_DAYS, off.RETENTION_IDLE_TOKEN_DAYS, off.RETENTION_PENDING_POOL_DAYS, off.RETENTION_FEED_DAYS,
      off.RETENTION_DANGER_QUIET_DAYS, off.RETENTION_QUIET_COIN_DAYS]).toEqual([undefined, undefined, 1, 1, undefined, undefined]);
    const on = loadConfig({ ...base, RETENTION_QUOTE_TRANSFER_DAYS: '2', RETENTION_IDLE_TOKEN_DAYS: '14', RETENTION_PENDING_POOL_DAYS: '3', RETENTION_FEED_DAYS: '3',
      RETENTION_DANGER_QUIET_DAYS: '2', RETENTION_QUIET_COIN_DAYS: '8' });
    expect([on.RETENTION_QUOTE_TRANSFER_DAYS, on.RETENTION_IDLE_TOKEN_DAYS, on.RETENTION_PENDING_POOL_DAYS, on.RETENTION_FEED_DAYS,
      on.RETENTION_DANGER_QUIET_DAYS, on.RETENTION_QUIET_COIN_DAYS]).toEqual([2, 14, 3, 3, 2, 8]);
    expect(() => loadConfig({ ...base, RETENTION_FEED_DAYS: '0' })).toThrow('RETENTION_FEED_DAYS');
    expect(() => loadConfig({ ...base, RETENTION_IDLE_TOKEN_DAYS: '0' })).toThrow('RETENTION_IDLE_TOKEN_DAYS');
    expect(loadConfig({ ...base, RETENTION_IDLE_TOKEN_DAYS: '1', RETENTION_QUIET_COIN_DAYS: '1' })).toMatchObject({ RETENTION_IDLE_TOKEN_DAYS: 1, RETENTION_QUIET_COIN_DAYS: 1 });
    expect(() => loadConfig({ ...base, RETENTION_QUIET_COIN_DAYS: '0' })).toThrow('RETENTION_QUIET_COIN_DAYS');
    expect(() => loadConfig({ ...base, RETENTION_DANGER_QUIET_DAYS: '0' })).toThrow('RETENTION_DANGER_QUIET_DAYS');
    // Both history rules compact transfers, so they are refused with the wallet outflow collectors too.
    expect(() => loadConfig({ ...base, RETENTION_DANGER_QUIET_DAYS: '2', SECURITY_COLLECTORS: walletCollectors })).toThrow('wallet outflow collectors');
    expect(() => loadConfig({ ...base, RETENTION_QUIET_COIN_DAYS: '8', SECURITY_COLLECTORS: walletCollectors })).toThrow('wallet outflow collectors');
    expect(() => loadConfig({ ...base, RETENTION_QUOTE_TRANSFER_DAYS: '0' })).toThrow('RETENTION_QUOTE_TRANSFER_DAYS');
    expect(() => loadConfig({ ...base, RETENTION_QUOTE_TRANSFER_DAYS: '2', SECURITY_COLLECTORS: walletCollectors })).toThrow('wallet outflow collectors');
    expect(loadConfig({ ...base, RETENTION_PENDING_POOL_DAYS: '3', SECURITY_COLLECTORS: walletCollectors }).RETENTION_PENDING_POOL_DAYS).toBe(3);
    expect(loadConfig({ ...base, RETENTION_FEED_DAYS: '3', SECURITY_COLLECTORS: walletCollectors }).RETENTION_FEED_DAYS).toBe(3);
  });
});

describe('retention worker', () => {
  it.each([false,true])('forwards keep-current=%s and runs backlogged passes, then waits ten minutes',async receiptKeepCurrent=>{
    vi.useFakeTimers();
    const result={quoteRows:0,idleTokens:0,idleRows:0,pendingRows:0,feedRows:0,dangerCoins:0,quietCoins:0,historyTransfers:0,historyLiquidity:0,historyPons:0,historySwaps:0,trendingSnapshots:0,skippedRules:[],finished:false};
    const run=vi.spyOn(retention,'runRetention').mockResolvedValueOnce(result).mockResolvedValue({...result,finished:true});
    const worker=new RetentionWorker({} as ChainDb,{ratingDays:7,receiptHours:48,receiptKeepCurrent,dryRun:false},vi.fn());
    try {
      worker.start();await worker.tick();expect(run).toHaveBeenCalledTimes(1);
      expect(run).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({ratingDays:7,receiptHours:48,receiptKeepCurrent}));
      await vi.advanceTimersByTimeAsync(99);expect(run).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);expect(run).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(599999);expect(run).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);expect(run).toHaveBeenCalledTimes(3);
      await worker.stop();await vi.advanceTimersByTimeAsync(600000);expect(run).toHaveBeenCalledTimes(3);
    } finally {await worker.stop();run.mockRestore();vi.useRealTimers();}
  });
  it.each(['dry-run','failure'])('waits the normal interval for %s and never overlaps passes',async kind=>{
    vi.useFakeTimers();
    let complete!:(value:retention.RetentionResult)=>void;
    const run=vi.spyOn(retention,'runRetention').mockImplementation(()=>new Promise(resolve=>{complete=resolve;}));
    const worker=new RetentionWorker({} as ChainDb,{ratingDays:7},vi.fn());
    try {
      worker.start();const pending=worker.tick();
      expect(worker.tick()).toBe(pending);
      await vi.advanceTimersByTimeAsync(600000);expect(run).toHaveBeenCalledTimes(1);
      if(kind==='failure')run.mockRejectedValue(new Error('fixture failure'));
      complete({finished:false,dryRun:true} as retention.RetentionResult);await pending;
      await vi.advanceTimersByTimeAsync(100);expect(run).toHaveBeenCalledTimes(1);
      if(kind==='failure') {await vi.advanceTimersByTimeAsync(599900);expect(run).toHaveBeenCalledTimes(2);await vi.advanceTimersByTimeAsync(100);expect(run).toHaveBeenCalledTimes(2);}
    } finally {await worker.stop();run.mockRestore();vi.useRealTimers();}
  });
  it('keeps existing pass fields and emits skipped rules and real rating counts',async()=>{
    const sql={query:async <T>(query:string)=>{if(query.startsWith('SELECT run_id,block FROM wallet_fingerprint_dependencies'))throw Object.assign(new Error('fixture timeout'),{code:'57014'});return {rows:[] as T[]};}};
    const db=new Database(sql,work=>work(sql)),report=vi.fn();
    await new RetentionWorker(db,{ratingDays:7,dryRun:false},report).tick();
    expect(report).toHaveBeenCalledWith(expect.objectContaining({quoteRows:0,feedRows:0,finished:false,skippedRules:['wallet_fingerprint_dependencies'],ratingRows:{receipt_publications:0,receipt_items:0,wallet_fingerprint_dependencies:0,guard_shadow_runs:0,coin_cards:0,playbook_matches:0,verdicts:0}}));
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ruleStats:expect.objectContaining({receipt_publications:expect.objectContaining({examined:0,eligible:0})})}));
  });
  it('does nothing unless configured, and reports each bounded pass without row data', async () => {
    const db = await openDb({ pgliteDir: ':memory:' }); handles.push(db); await migrate(db);
    const idle = vi.fn(), off = new RetentionWorker(db, {}, idle, 60_000);
    off.start(); await off.stop();
    expect(off.enabled).toBe(false); expect(idle).not.toHaveBeenCalled();
    const disabled = new RetentionWorker(db, { enabled:false, rawDays:7 }, idle);
    disabled.start(); await disabled.tick(); await disabled.stop();
    expect(disabled.enabled).toBe(false); expect(idle).not.toHaveBeenCalled();
    const report = vi.fn(), on = new RetentionWorker(db, { quoteDays: 2, pendingPoolDays: 3, feedDays: 3 }, report, 60_000);
    on.start(); await on.tick(); await on.stop();
    expect(report).toHaveBeenCalledWith({ quoteRows: 0, idleTokens: 0, idleRows: 0, pendingRows: 0, feedRows: 0, dangerCoins: 0, quietCoins: 0,
      historyTransfers: 0, historyLiquidity: 0, historyPons: 0, historySwaps: 0, trendingSnapshots: 0, finished: true, skippedRules:[], dryRun:true,tables:[], ruleStats:expect.any(Object) });
    expect(new RetentionWorker(db, { quietCoinDays: 8 }, vi.fn(), 60_000).enabled).toBe(true);
    expect(new RetentionWorker(db, { feedDays: 3 }, vi.fn(), 60_000).enabled).toBe(true);
    const failing = vi.fn(), broken = new RetentionWorker({ sql: { query: async () => { throw new Error('fixture failure with row data'); } } } as unknown as ChainDb,
      { quoteDays: 2 }, failing, 60_000);
    await broken.tick();
    expect(failing).toHaveBeenCalledWith({ failed: true, code:null, errorConstructor:'TypeError', phase:'quote_transfers' });
  });
});


it('runs raw partitions at start and hourly while other retention rules keep their cadence',async()=>{
 vi.useFakeTimers();
 const result={quoteRows:0,idleTokens:0,idleRows:0,pendingRows:0,feedRows:0,dangerCoins:0,quietCoins:0,historyTransfers:0,historyLiquidity:0,historyPons:0,historySwaps:0,trendingSnapshots:0,skippedRules:[],finished:true};
 const run=vi.spyOn(retention,'runRetention').mockResolvedValue(result);
 const worker=new RetentionWorker({} as ChainDb,{swapDays:7,transferDays:3,ratingDays:7,dryRun:false},vi.fn());
 try{
  worker.start();await worker.tick();expect(run.mock.calls[0]?.[1].rawPartitions).toBe(true);
  await vi.advanceTimersByTimeAsync(3_599_999);expect(run.mock.calls.filter(c=>c[1].rawPartitions)).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);expect(run.mock.calls.filter(c=>c[1].rawPartitions)).toHaveLength(2);
  expect(run).toHaveBeenCalledTimes(7);
  await worker.stop();worker.start();await worker.tick();expect(run.mock.calls.at(-1)?.[1].rawPartitions).toBe(true);
 }finally{await worker.stop();run.mockRestore();vi.useRealTimers();}
});

 it('reports only code, original constructor and failing rule on a fatal pass error',async()=>{
   class DatabaseFailure extends Error { readonly code='23503'; readonly detail='private row data'; }
   const error=new DatabaseFailure('private SQL and parameters');
   const sql={query:async <T>(query:string)=>{
     if(query.startsWith('SELECT run_id,block FROM wallet_fingerprint_dependencies'))throw error;
     return {rows:[] as T[]};
   }};
   const report=vi.fn();
   await new RetentionWorker(new Database(sql,work=>work(sql)),{ratingDays:1,dryRun:false},report).tick();
   expect(report).toHaveBeenCalledWith({failed:true,code:'23503',errorConstructor:'DatabaseFailure',phase:'wallet_fingerprint_dependencies'});
   expect(JSON.stringify(report.mock.calls)).not.toContain('private');
 });
