import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { canonicalize, PublicReceiptPayloadSchema, type ProviderId } from '@eko/shared';
import { migrate, migrateEngines, ReceiptOutbox, ReceiptCommitJournal } from '@eko/db';
import { buildSwarmNaiveView, PERSONA_SET_V1, swarmSnapshotHash, type SwarmFunnelInput } from '@eko/engines';
import { loadConfig } from '../src/config.js';
import { openDb, runMigrations, type DbHandle } from '../src/db/client.js';
import { InferenceBudget, reserveSwarmBudget } from '../src/ai/budget.js';
import { ProviderRegistry } from '../src/ai/registry.js';
import { ChatCompletionsProvider } from '../src/ai/providers/chat.js';
import { ProviderError, type InferenceRequest, type InferenceResult } from '../src/ai/types.js';
import { loadSwarmConfig, SwarmWorker, type SwarmConfig, type SwarmModels, type SwarmRegistry } from '../src/ai/swarm-worker.js';

let handle: DbHandle, sequence = 0;
const baseTime = Date.parse('2026-10-03T12:00:00Z');
const modelFamily = {openrouter:{model:'fixture/luna-v1',maxUsd:0.01},ppq:{provider:'openai' as const,model:'fixture/luna-v1',maxUsd:0.01}};
const models: SwarmModels = {version:'fixture-models-1',verified:true,luna:modelFamily,
  sol:{...modelFamily,openrouter:{...modelFamily.openrouter,model:'fixture/sol-v1'}},
  opus:{...modelFamily,openrouter:{...modelFamily.openrouter,model:'fixture/opus-v1'}}};
function fixture() {
  const n = ++sequence, now = baseTime+n*86400000;
  const input: SwarmFunnelInput = {coin:`0x${n.toString(16).padStart(40,'0')}`,asOfBlock:100,verdict:'clear',depthUsdPct2:2500,
    isClone:false,distinctBuyers:10,unavailableFields:[],naiveView:buildSwarmNaiveView({name:'Fixture coin',symbol:'FIX',tokenText:'Fixture data',
      change5mPct:2,change1hPct:3,volumeUsd:4000,holders:20,top10Pct:30,liquidityUsd:5000,ageSec:60,trendingRank:null,socialPresence:false})};
  let conf: SwarmConfig = {enabled:true,aiDailyUsd:33,dailyUsd:33,perCoinUsd:5,models}, head = 100;
  const registry: SwarmRegistry = {isConfigured:()=>true,route:id=>({route:id==='openrouter'?'direct':'gateway',via:null,model:null}),
    infer:vi.fn(async (_id: ProviderId, request: InferenceRequest): Promise<InferenceResult> => output(input,request,'ape'))};
  const worker = () => new SwarmWorker(handle.chain,registry,()=>conf,{evidence:'fixture',headBlock:async()=>head,now:()=>now,random:()=>1});
  return {input,now,registry,worker,setConfig:(next:Partial<SwarmConfig>)=>{conf={...conf,...next};},setHead:(n:number)=>{head=n;}};
}
function output(input: SwarmFunnelInput, req: InferenceRequest, action: 'ape'|'wait'|'mixed'): InferenceResult {
  const personaPart = req.user.split('\n').find(line=>line.startsWith('{"persona_set_hash"'))!;
  const ids = (JSON.parse(personaPart) as {personas:{id:string}[]}).personas.map(p=>p.id);
  return {model:req.model,inputTokens:100,outputTokens:100,latencyMs:1,costUsd:0.005,output:{
    snapshot_hash:swarmSnapshotHash(input.coin,input.naiveView),as_of_block:input.asOfBlock,
    votes:ids.map(id=>{const ape=action==='ape' || action==='mixed' && PERSONA_SET_V1.personas.findIndex(p=>p.id===id)<5;
      return {persona_id:id,action:ape?'ape':'wait',size_bucket:ape?'s':'none',exit:{tp_pct:25,sl_pct:15,max_hold_min:60},confidence:0.5};})}};
}
async function logs(coin:string) { return (await handle.chain.sql.query<{outcome:string;error:string;provider:string;est_cost_usd:number}>('SELECT * FROM inference_runs WHERE coin=$1 ORDER BY id',[coin])).rows; }
async function forecast(job:string) { return (await handle.chain.sql.query<{id:string;data:{count:number}}>('SELECT * FROM forecasts WHERE job_id=$1',[job])).rows[0]; }
beforeAll(async()=>{handle=await openDb({pgliteDir:':memory:'});await runMigrations(handle);await migrate(handle.chain);await migrateEngines(handle.chain);});
afterAll(async()=>{await handle?.close();});

describe('105 Swarm worker, synthetic providers and database only',()=>{
  it('requires enabled inference, approved global budget and verified operator model inputs',async()=>{
    expect(loadSwarmConfig({})).toMatchObject({enabled:false,aiDailyUsd:0,dailyUsd:0,models:null});
    expect(loadSwarmConfig({SWARM_ENABLED:'true',SWARM_MODELS:JSON.stringify({...models,verified:false})}).models).toBeNull();
    expect(loadSwarmConfig({SWARM_DAILY_BUDGET_USD:'99'}).dailyUsd).toBe(33);
    for (const change of [{enabled:false},{aiDailyUsd:0},{dailyUsd:0},{perCoinUsd:0},{models:null}]) {
      const f=fixture();f.setConfig(change);await f.worker().enqueue(f.input);await f.worker().drain();
      expect(f.registry.infer).not.toHaveBeenCalled();expect((await logs(f.input.coin)).map(r=>r.outcome)).toContain('skipped_disabled');
    }
    const f=fixture();const live=new SwarmWorker(handle.chain,f.registry,()=>({enabled:true,aiDailyUsd:33,dailyUsd:33,perCoinUsd:5,models}),{evidence:'live',headBlock:async()=>100});
    await live.enqueue(f.input);await live.drain();expect(f.registry.infer).not.toHaveBeenCalled();
  });
  it('stops after ten decisive votes, caches by content/version/model and persists an immutable pending receipt',async()=>{
    const f=fixture(), w=f.worker(), id=(await w.enqueue(f.input))!;await w.drain();
    expect(f.registry.infer).toHaveBeenCalledTimes(1);expect((await forecast(id))!.data.count).toBe(10);
    const row=(await forecast(id))!, outbox=new ReceiptOutbox(handle.chain);
    expect(await w.outcomeWindow(row.id)).toEqual({status:'pending'});
    expect(await outbox.get(row.id)).toBeNull();await outbox.recover();
    const receipt=(await outbox.get(row.id))!;
    const payload = PublicReceiptPayloadSchema.parse(receipt.payload);
    expect(payload.window).toEqual({kind:'forecast',startsAt:'commit_block',durationSec:900});
    expect(payload.modelIds).toEqual(['fixture/luna-v1']);expect(payload.personaSetVersion).toBe('v1');
    expect(receipt.receipt.status).toBe('recorded');
    await expect(handle.chain.sql.query('UPDATE forecasts SET data=$1 WHERE id=$2',['{}',row.id])).rejects.toThrow('append-only');
    await expect(handle.chain.sql.query('DELETE FROM persona_votes WHERE job_id=$1',[id])).rejects.toThrow('append-only');
    const restart=f.worker(), cached=(await restart.enqueue({...f.input,asOfBlock:101}))!;f.setHead(101);await restart.drain();
    expect(f.registry.infer).toHaveBeenCalledTimes(1);expect((await forecast(cached))!.data.count).toBe(10);
    expect((await logs(f.input.coin)).map(r=>r.outcome)).toContain('skipped_cache');
    const spent=await new InferenceBudget(handle.db,33,100).spentToday(f.now);expect(spent).toBe(0.01);
    const journal=new ReceiptCommitJournal(handle.chain);expect(await journal.acquire()).toBe(true);
    const batch=(await journal.batch(f.now+300001))!;
    await journal.saveAttempt({tx_hash:`0x${'11'.repeat(32)}`,batch_id:batch.id,registry:`0x${'22'.repeat(20)}`,committer:`0x${'33'.repeat(20)}`,nonce:'0',raw_transaction:'0x00'});
    await journal.anchor(batch,{batchId:1,txHash:`0x${'11'.repeat(32)}`,registry:`0x${'22'.repeat(20)}`,committer:`0x${'33'.repeat(20)}`,
      root:batch.root,leafCount:batch.items.length,blockNumber:'123',blockHash:`0x${'44'.repeat(32)}`,logIndex:0});
    expect(await restart.outcomeWindow(row.id)).toMatchObject({status:'anchored',startBlock:'123',durationSec:900});
    await journal.anchorEvent((await journal.unfinalized())[0]!.id,'orphaned');
    expect(await restart.outcomeWindow(row.id)).toEqual({status:'pending'});await journal.release();
    // Preserved raw bytes, even after anchoring and orphaning.
    expect((await outbox.get(row.id))!.canonicalPayload).toBe(receipt.canonicalPayload);
  });
  it('samples uncertain behaviour in ten-vote rounds to the hard fifty-vote ceiling with Sol/Opus single calls',async()=>{
    const f=fixture();vi.mocked(f.registry.infer).mockImplementation(async(_id,req)=>output(f.input,req,'mixed'));
    const id=(await f.worker().enqueue(f.input))!;await f.worker().drain();expect((await forecast(id))!.data.count).toBe(50);
    const calls=vi.mocked(f.registry.infer).mock.calls;expect(calls).toHaveLength(17);
    expect(calls.every(c=>c[1].maxOutputTokens===600 && c[2]?.retry===false)).toBe(true);
    for (const call of calls.filter(c=>/sol|opus/.test(c[1].model))) expect((call[1].user.match(/"id":/g)??[])).toHaveLength(1);
    expect((await handle.chain.sql.query('SELECT * FROM persona_votes WHERE job_id=$1',[id])).rows).toHaveLength(50);
  });
  it('stops ambiguous initial sampling when the 90% interval narrows below 0.1',async()=>{
    const f=fixture();let calls=0;
    vi.mocked(f.registry.infer).mockImplementation(async(_id,req)=>output(f.input,req,calls++===0?'mixed':'wait'));
    const id=(await f.worker().enqueue(f.input))!;await f.worker().drain();
    const row=(await handle.chain.sql.query<{data:{count:number;halfWidth:number}}>('SELECT data FROM forecasts WHERE job_id=$1',[id])).rows[0]!;
    expect(row.data.count).toBe(40);expect(row.data.halfWidth).toBeLessThan(0.1);
  });
  it('uses single-persona Luna calibration without counting extra samples',async()=>{
    const f=fixture(), w=new SwarmWorker(handle.chain,f.registry,()=>({enabled:true,aiDailyUsd:33,dailyUsd:33,perCoinUsd:5,models}),
      {evidence:'fixture',headBlock:async()=>100,now:()=>f.now,random:()=>0});
    const id=(await w.enqueue(f.input))!;await w.drain();expect(f.registry.infer).toHaveBeenCalledTimes(2);expect((await forecast(id))!.data.count).toBe(10);
  });
  it('falls back exactly once for retryable primary errors and charges both independent reservations',async()=>{
    for (const code of ['quota','timeout','network','overloaded'] as const) {
      const f=fixture();vi.mocked(f.registry.infer).mockImplementation(async(id,req)=>{if(id==='openrouter')throw new ProviderError(code,'fixture outage');return output(f.input,req,'ape');});
      const id=(await f.worker().enqueue(f.input))!;await f.worker().drain();expect(vi.mocked(f.registry.infer).mock.calls.map(c=>c[0])).toEqual(['openrouter','openai']);
      expect(await forecast(id)).toBeDefined();expect((await logs(f.input.coin)).map(r=>r.outcome)).toEqual(['started','error','started','ok']);
      expect(await new InferenceBudget(handle.db,33,100).spentToday(f.now)).toBe(0.02);
    }
  });
  it('keeps rules-only scans available on both-provider outage and never retries invalid votes',async()=>{
    const f=fixture();vi.mocked(f.registry.infer).mockRejectedValue(new ProviderError('network','fixture outage'));
    const id=(await f.worker().enqueue(f.input))!;await f.worker().drain();expect(f.registry.infer).toHaveBeenCalledTimes(2);expect(await forecast(id)).toBeUndefined();
    expect(f.input.verdict).toBe('clear'); // Worker has no Guard/Radar/rules mutation interface.
    for (const alter of [()=>({free_text:'fixture invalid'}),(r:InferenceResult)=>({...r.output as object,as_of_block:101}),
      (r:InferenceResult)=>({...r.output as {votes:object[]},votes:[{persona_id:'sniper',action:'ape',size_bucket:'none',exit:{tp_pct:1,sl_pct:1,max_hold_min:1},confidence:0.5}]})]) {
      const x=fixture();vi.mocked(x.registry.infer).mockImplementation(async(_id,req)=>{const r=output(x.input,req,'ape');return {...r,output:alter(r)};});
      const job=(await x.worker().enqueue(x.input))!;await x.worker().drain();expect(x.registry.infer).toHaveBeenCalledTimes(1);
      expect(await forecast(job)).toBeUndefined();expect((await logs(x.input.coin)).map(r=>r.outcome)).toContain('rejected');
    }
  });
  it('rejects token/cost overruns and stale output, and rechecks the kill switch between batches',async()=>{
    for (const kind of ['tokens','cost','stale','kill'] as const) {
      const f=fixture();vi.mocked(f.registry.infer).mockImplementation(async(_id,req)=>{
        const r=output(f.input,req,'mixed');if(kind==='tokens')r.outputTokens=601;if(kind==='cost')r.costUsd=0.05;
        if(kind==='stale')f.setHead(701);if(kind==='kill')f.setConfig({enabled:false});return r;
      });
      const id=(await f.worker().enqueue(f.input))!;await f.worker().drain();expect(await forecast(id)).toBeUndefined();expect(f.registry.infer).toHaveBeenCalledTimes(1);
    }
  });
  it('serializes budget races, respects independent daily/per-coin/global caps and keeps reservations after worker restart',async()=>{
    for (const cap of ['dailyUsd','perCoinUsd','aiDailyUsd'] as const) {
      const f=fixture(), id=(await f.worker().enqueue(f.input))!;
      await handle.chain.sql.query("UPDATE swarm_jobs SET state='running',started_at=clock_timestamp() WHERE id=$1",[id]);
      const request={jobId:id,coin:f.input.coin,maxUsd:0.01,now:f.now,aiDailyUsd:1,dailyUsd:1,perCoinUsd:1,[cap]:0.01};
      const results=await Promise.all([reserveSwarmBudget(handle.chain,{...request,id:`race-a-${id}`}),reserveSwarmBudget(handle.chain,{...request,id:`race-b-${id}`})]);
      expect(results.sort()).toEqual([false,true]);
      await handle.chain.sql.query("UPDATE swarm_jobs SET state='queued' WHERE id=$1",[id]);f.setConfig({[cap]:0.01});await f.worker().drain();expect(f.registry.infer).not.toHaveBeenCalled();
      expect((await logs(f.input.coin)).map(r=>r.outcome)).toContain('skipped_budget');
      expect(await new InferenceBudget(handle.db,0.01,100).check('fixture-other',f.now)).toMatchObject({ok:false});
    }
  });
  it('fails interrupted work closed while retaining the possible billed cost and preventing duplicate queue claims',async()=>{
    const f=fixture(), id=(await f.worker().enqueue(f.input))!;
    await handle.chain.sql.query("UPDATE swarm_jobs SET state='running',started_at=clock_timestamp()-interval '10 minutes' WHERE id=$1",[id]);
    expect(await reserveSwarmBudget(handle.chain,{id:`interrupted-${id}`,jobId:id,coin:f.input.coin,maxUsd:0.01,now:f.now,aiDailyUsd:1,dailyUsd:1,perCoinUsd:1})).toBe(true);
    await handle.chain.sql.query("UPDATE swarm_jobs SET started_at=clock_timestamp()-interval '10 minutes' WHERE id=$1",[id]);
    expect(await f.worker().recoverInterrupted()).toBe(1);expect(await f.worker().drain()).toBe(0);
    expect(await new InferenceBudget(handle.db,1,100).spentToday(f.now)).toBe(0.01);expect(await forecast(id)).toBeUndefined();
    const next=fixture(), nextId=(await next.worker().enqueue(next.input))!;
    await Promise.all([next.worker().drain(),next.worker().drain()]);expect(next.registry.infer).toHaveBeenCalledTimes(1);expect(await forecast(nextId)).toBeDefined();
  });
  it('invalidates configuration/version cache, excludes Danger and bounds queue admission',async()=>{
    const f=fixture();expect(await f.worker().enqueue({...f.input,verdict:'danger'})).toBeNull();expect(f.registry.infer).not.toHaveBeenCalled();
    await f.worker().enqueue(f.input);f.setConfig({models:{...models,version:'fixture-models-2'}});await f.worker().drain();expect(f.registry.infer).not.toHaveBeenCalled();
    await f.worker().enqueue(f.input);await f.worker().drain();expect(f.registry.infer).toHaveBeenCalledTimes(1);
    const b=fixture(), bounded=new SwarmWorker(handle.chain,b.registry,()=>loadSwarmConfig({}),{evidence:'fixture',headBlock:async()=>100,maxQueued:1});
    await bounded.enqueue(b.input);expect(await bounded.enqueue({...b.input,asOfBlock:101})).toBeNull();await bounded.drain();
  });
  it('honours the existing registry circuit breaker and sends the 600-token cap to Chat Completions',async()=>{
    const cfg=loadConfig({NODE_ENV:'test',SESSION_SECRET:'fixture-session-placeholder'.repeat(2),OPENROUTER_API_KEY:'fixture-key-placeholder',GATEWAY_API_KEY:'fixture-gateway-placeholder'});
    const registry=new ProviderRegistry(cfg);registry.simulateOutage('openrouter',60000);
    const f=fixture(), calls:InferenceRequest[]=[];registry.get('openai')!.infer=async req=>{calls.push(req);return output(f.input,req,'ape');};
    const w=new SwarmWorker(handle.chain,registry,()=>({enabled:true,aiDailyUsd:33,dailyUsd:33,perCoinUsd:5,models}),{evidence:'fixture',headBlock:async()=>100,now:()=>f.now,random:()=>1});
    const id=(await w.enqueue(f.input))!;await w.drain();expect(calls).toHaveLength(1);expect(await forecast(id)).toBeDefined();
    let body:Record<string,unknown>={};vi.stubGlobal('fetch',vi.fn(async(_url,init)=>{body=JSON.parse(init.body);return new Response(JSON.stringify({choices:[{message:{content:'{}'}}],usage:{completion_tokens:1}}));}));
    try {await new ChatCompletionsProvider('openrouter','Fixture router','https://example.invalid/chat','fixture-placeholder','fixture/model','json_schema',
      {extraBody:{provider:{require_parameters:true}}}).infer({...calls[0]!,maxOutputTokens:600});
      expect(body.max_tokens).toBe(600);expect(body.provider).toEqual({require_parameters:true});
    } finally {vi.unstubAllGlobals();}
    expect(canonicalize(models)).toContain('"verified":true');
  });
});
