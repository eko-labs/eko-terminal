import { afterEach, expect, it, vi } from 'vitest';
import { openDb } from '@eko/db';
import { RpcMeter } from '../src/rpc/metered.js';
import { createSqlUsageStore } from '../src/rpc/usage.js';
import { withRpcOrigin } from '../src/rpc/origin.js';
const dbs: Awaited<ReturnType<typeof openDb>>[]=[];
afterEach(async()=>{for(const db of dbs.splice(0))await db.close();});
async function setup() {
  const db=await openDb({pgliteDir:':memory:'});dbs.push(db);
  const store=createSqlUsageStore(db);let now=Date.UTC(2026,9,17);
  const lines:{event:string;[key:string]:unknown}[]=[];
  const create=(role:string)=>new RpcMeter({APP_ROLE:role,RPC_HTTP_URL:'https://paid.invalid',RPC_PAID_DAILY_SOFT_LIMIT:'5',
    RPC_PAID_INDEXER_RESERVE:'3',RPC_PAID_DAILY_BUDGET:'10',RPC_PAID_MAX_RPM:'1000000'},
    {store,now:()=>now,sleep:async ms=>{now+=ms;},log:(event,fields)=>lines.push({event,...fields})});
  const engine=create('engines'),worker=create('worker'),indexer=create('indexer');
  const send={paid:vi.fn(async()=> '0x01'),public:vi.fn(async()=> '0x01')};
  const call=(meter:RpcMeter,work:'routine'|'first_rating'|'crash'='routine')=>withRpcOrigin(`test.${work}`,()=>meter.request({method:'eth_call',params:[{},'0x1']},send,'archive'),work);
  return {db,store,engine,worker,indexer,lines,send,call,advance:(ms:number)=>{now+=ms;},close:()=>Promise.all([engine.close(),worker.close(),indexer.close()])};
}
it('enforces one atomic soft threshold across roles, admits first/crash and keeps the indexer reserve',async()=>{
  const h=await setup();
  try {
    await Promise.all(Array.from({length:5},(_,i)=>h.call(i%2?h.engine:h.worker)));
    await expect(h.call(h.engine)).rejects.toMatchObject({code:'rpc_paid_deferred'});
    await expect(h.call(h.worker)).rejects.toMatchObject({code:'rpc_paid_deferred'});
    await h.call(h.engine,'first_rating');await h.call(h.worker,'crash');
    await expect(h.call(h.worker,'crash')).rejects.toMatchObject({code:'rpc_paid_deferred'});
    await Promise.all(Array.from({length:3},()=>h.call(h.indexer)));
    await expect(h.call(h.indexer)).rejects.toMatchObject({code:'rpc_budget_exhausted'});
    expect(h.send.paid).toHaveBeenCalledTimes(10);
    expect((await h.db.sql.query('SELECT total,non_indexer FROM rpc_paid_daily')).rows).toEqual([{total:10,non_indexer:7}]);
  } finally {await h.close();}
});
it('counts call attempts independently of weighted leases and resumes next UTC day',async()=>{
  const h=await setup();
  try {
    h.worker.config.weights.eth_call=5;
    await Promise.all(Array.from({length:8},()=>h.call(h.worker,'crash').catch(()=>undefined)));
    expect(h.send.paid).toHaveBeenCalledTimes(7);
    expect((await h.worker.usage()).today[0]).toMatchObject({calls:7,units:35});
    h.advance(86400000);await h.call(h.worker);
    expect(h.send.paid).toHaveBeenCalledTimes(8);
  }finally{await h.close();}
});
it('labels concurrent origins separately and reports degradation once per minute',async()=>{
  const h=await setup();
  try {
    await Promise.all([withRpcOrigin('test.alpha',()=>h.engine.request({method:'eth_call',params:[{},'0x1']},h.send,'archive')),withRpcOrigin('test.beta',()=>h.worker.request({method:'eth_call',params:[{},'0x1']},h.send,'archive'))]);
    await h.call(h.engine);await h.call(h.engine);await h.call(h.engine);
    await h.worker.paidWorkAllowed();await h.worker.paidWorkAllowed();await h.worker.summary();
    expect(h.lines.filter(l=>l.event==='rpc_paid_ceiling_degraded' && l.role==='worker')).toHaveLength(1);
    expect((h.lines.find(l=>l.event==='rpc_usage')!.lastMinute as {origin:string;calls:number}[])).toEqual([{provider:'paid',method:'eth_call',origin:'test.beta',calls:1,units:1}]);
    h.advance(60000);await h.worker.summary();
    expect(h.lines.filter(l=>l.event==='rpc_paid_ceiling_degraded' && l.role==='worker')).toHaveLength(2);
  }finally{await h.close();}
});
it('seeds historical paid spend instead of granting a fresh budget on rollout/restart',async()=>{
  const h=await setup();
  try {
    await h.store.reserve('2026-10-17','paid','eth_call',5,100);
    // Five weighted units are one paid call, not five calls.
    expect(await h.engine.paidWorkAllowed()).toBe(true);
    await h.call(h.engine);await h.call(h.engine);await h.call(h.engine);await h.call(h.engine);
    expect(await h.worker.paidWorkAllowed()).toBe(false);
    const restarted=new RpcMeter(h.worker.env,{store:h.store,now:()=>Date.UTC(2026,9,17),log:()=>{}});
    expect(await restarted.paidWorkAllowed()).toBe(false);await restarted.close();
  }finally{await h.close();}
});
