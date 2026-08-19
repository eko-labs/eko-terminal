import { afterEach, expect, it, vi } from 'vitest';
import { openDb, type SqlClient } from '@eko/db';
import { RpcMeter, rpcPauseRetryAt } from '../src/rpc/metered.js';
import { createSqlUsageStore } from '../src/rpc/usage.js';
import type { RpcRequest } from '../src/rpc/routes.js';

const cleanups: (()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanups.splice(0).reverse())await close();});
async function setup() {
  const db=await openDb({pgliteDir:':memory:'});
  cleanups.push(()=>db.close());
  const store=createSqlUsageStore(db);
  let now=Date.UTC(2026,9,17), available=false;
  const sleepers: {at:number;resolve:()=>void}[]=[];
  const sleep=(ms:number)=>{if(ms<100){now+=ms;return Promise.resolve();}return new Promise<void>(resolve=>sleepers.push({at:now+ms,resolve}));};
  const logs=vi.fn();
  const meters:RpcMeter[]=[];
  const create=(role:string,wait=false,ownStore=store)=>{
    const meter=new RpcMeter({APP_ROLE:role,RPC_HTTP_URL:'https://paid.invalid',RPC_PAID_MAX_RPM:'10000000',
      RPC_PAID_DAILY_SOFT_LIMIT:'5',RPC_PAID_INDEXER_RESERVE:'3',RPC_PAID_DAILY_BUDGET:'10'},
    {store:ownStore,now:()=>now,sleep,log:logs,pauseOnOutage:wait});
    meters.push(meter);return meter;
  };
  cleanups.push(async()=>{await Promise.all(meters.map(m=>m.close()));});
  const paid=vi.fn(async (r:RpcRequest)=>{if(!available)throw Object.assign(new Error('payment required'),{status:402});return r.method==='eth_blockNumber'?'0x10':'result';});
  const send={paid,public:vi.fn(async()=> 'public result')};
  const call=(meter:RpcMeter,wait=true)=>meter.request({method:'eth_call'},send,'archive',wait);
  const advance=(ms:number)=>{now+=ms;for(const s of sleepers.splice(0)){if(s.at<=now)s.resolve();else sleepers.push(s);}};
  return {db,store,logs,create,paid,send,call,advance,now:()=>now,available:()=>{available=true;}};
}

it.each([[402,'provider_balance_exceeded'],[429,'provider_quota_exceeded']] as const)(
  'shares a worker HTTP %s pause with all roles, refunds usage, and leaves public reads available',async(status,reason)=>{
    const h=await setup();
    const worker=h.create('worker');
    h.paid.mockImplementation(async()=>{throw Object.assign(new Error('refused'),{status});});
    await expect(h.call(worker)).rejects.toMatchObject({code:reason,nextRetryAt:h.now()+10_000});
    const roles=['api','mcp','engines','indexer','receipts','enrich','cli'];
    for(const role of roles) {
      const error=await h.call(h.create(role)).catch(e=>e);
      expect(error).toMatchObject({code:reason});expect(rpcPauseRetryAt(new Error('wrapped',{cause:error}))).toBe(h.now()+10_000);
    }
    expect(h.paid).toHaveBeenCalledTimes(1);
    expect((await worker.usage())).toMatchObject({paidCalls:0,nonIndexerCalls:0,sessionUnits:0,budgetLeft:10});
    expect(await h.store.today('2026-10-17')).toEqual([]);
    await worker.request({method:'eth_call'},h.send,'public');expect(h.send.public).toHaveBeenCalledTimes(1);
    // Each meter flushes its local blocked counts independently, without per-call database writes.
    for(const role of ['api','worker']) {const m=h.create(role);await h.call(m).catch(()=>{});await m.summary();}
    expect((await h.db.sql.query('SELECT total,non_indexer FROM rpc_paid_daily')).rows).toEqual([{total:0,non_indexer:0}]);
    expect(h.logs.mock.calls.filter(([event,fields])=>event==='rpc_paused'&&fields.role==='worker')).toHaveLength(1);
    expect((await worker.summary()).refusedToday).toBeGreaterThanOrEqual(3);
  });

it('elects one prober, resumes waiting engines/indexer and fail-fast roles, and counts only accepted requests',async()=>{
  const h=await setup(), worker=h.create('worker'), api=h.create('api'), indexer=h.create('indexer',true), engines=h.create('engines',true);
  await h.call(worker).catch(()=>{});
  let done=0;
  const pending=[h.call(indexer).then(()=>{done++;}),h.call(engines).then(()=>{done++;})];
  await h.call(api).catch(()=>{});
  await vi.waitFor(()=>expect(indexer.pause).not.toBeNull());
  expect(h.paid).toHaveBeenCalledTimes(1);expect(done).toBe(0);
  h.available();h.advance(11_000);
  await vi.waitFor(()=>expect(h.paid.mock.calls.filter(([r])=>r.method==='eth_blockNumber')).toHaveLength(1));
  // Followers poll the shared row (at most three seconds), then retry retained work.
  h.advance(3000);
  await vi.waitFor(()=>expect(done).toBe(2));await Promise.all(pending);
  await h.call(worker);await h.call(api);
  await api.usage();
  expect((await worker.usage())).toMatchObject({paidCalls:5,refusedToday:2});
  expect(await h.store.providerPause!.read(h.now(),true)).toBeNull();
});

it('keeps a two-day outage out of the soft limit and doubles one shared retry schedule',async()=>{
  const h=await setup(), worker=h.create('worker');
  await h.call(worker).catch(()=>{});
  for(let day=0;day<2;day++) {
    for(let n=0;n<100;n++)await h.call(worker).catch(()=>{});
    expect((await worker.usage()).paidCalls).toBe(0);
    h.advance(86_400_000);
    await vi.waitFor(()=>expect(h.paid).toHaveBeenCalledTimes(day+2));
    await vi.waitFor(async()=>expect((await h.store.providerPause!.read(h.now(),true))?.nextRetryAt).toBe(h.now()+20_000*2**day));
    expect((await worker.usage())).toMatchObject({paidCalls:0,budgetLeft:10});
  }
  h.available();h.advance(41_000);
  await vi.waitFor(async()=>expect(await h.store.providerPause!.read(h.now(),true)).toBeNull());
  await h.call(worker);
  expect((await worker.usage())).toMatchObject({paidCalls:2,budgetLeft:8});
});

it('refunds the original UTC day exactly once, including weighted units and the non-indexer ceiling',async()=>{
  const h=await setup(), day='2026-10-17';
  const p={role:'worker',urgent:false,softLimit:5,ceiling:10,reserve:3};
  await h.store.paidPolicy!(day,p,true);await h.store.reserve(day,'paid','eth_call',7,100);
  const refund={requestId:'sample-request',day,role:'worker',method:'eth_call',units:7,policy:true,leased:false};
  h.advance(86_400_000);
  await Promise.all([h.store.refundPaid!(refund),h.store.refundPaid!(refund)]);
  expect(await h.store.today(day)).toEqual([]);
  expect((await h.db.sql.query('SELECT units,calls FROM rpc_usage')).rows).toEqual([{units:0,calls:0},{units:0,calls:0}]);
  expect(await h.store.refusedToday!(day)).toBe(1);
  expect(await h.store.paidPolicy!(day,p,false)).toMatchObject({allowed:true,total:0,nonIndexer:0});
});

it('fences stale probe completions and permits lease takeover after a crashed prober',async()=>{
  const h=await setup(), control=h.store.providerPause!;
  await control.refuse('provider_balance_exceeded',h.now());h.advance(10_000);
  expect(await control.claim('probe-first','indexer',h.now(),10_000)).toBe(true);
  expect(await control.claim('probe-second','worker',h.now()+1000,10_000)).toBe(false);
  h.advance(10_000);
  expect(await control.claim('probe-second','worker',h.now(),10_000)).toBe(true);
  await control.finish('probe-first',h.now(),null,300_000);
  expect(await control.read(h.now(),true)).not.toBeNull();
  await control.finish('probe-second',h.now(),null,300_000);
  expect(await control.read(h.now(),true)).toBeNull();
});

it('bounds cross-process cache staleness to three seconds and refreshes immediately on a refusal',async()=>{
  const h=await setup();
  // A distinct SQL handle models another process with an independent pause cache.
  const queries:string[]=[];
  const sql:SqlClient={query:async<T>(query:string,params?:unknown[])=>{queries.push(query);return h.db.sql.query<T>(query,params);}};
  const other=createSqlUsageStore({sql,tx:h.db.tx.bind(h.db)});
  expect(await other.providerPause!.read(h.now())).toBeNull();
  const reads=()=>queries.filter(query=>query==='SELECT pause FROM rpc_provider_pause WHERE id=1').length;
  await other.providerPause!.read(h.now());expect(reads()).toBe(1);
  await h.call(h.create('worker')).catch(()=>{});
  h.advance(3001);
  const api=h.create('api',false,other);
  await expect(h.call(api)).rejects.toMatchObject({code:'provider_balance_exceeded'});
  expect(h.paid).toHaveBeenCalledTimes(1);expect(reads()).toBe(2);
  await expect(h.call(api)).rejects.toMatchObject({code:'provider_balance_exceeded'});
  expect(reads()).toBe(2);
});

it('refunds standalone weighted leases without counting unused credits as paid spend',async()=>{
  const h=await setup(), meter=h.create('');meter.config.weights.eth_call=7;
  await expect(h.call(meter)).rejects.toMatchObject({code:'provider_balance_exceeded'});
  expect(await h.store.today('2026-10-17')).toEqual([]);
  expect((await meter.usage())).toMatchObject({sessionUnits:0,budgetLeft:10,refusedToday:1});
  await meter.close();
  expect((await h.db.sql.query("SELECT units FROM rpc_usage WHERE provider='paid' AND method='__total__'")).rows).toEqual([{units:0}]);
});
