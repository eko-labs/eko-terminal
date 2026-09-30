import {afterEach,describe,it,expect,vi} from 'vitest';
import {binary,migrate,migrateEngines,type ChainDb} from '@eko/db';
import { openDb } from '../../../packages/db/test/helpers/historical-db.js';
import {V3ReferenceSimulation,referenceDigest,type ReferenceResult} from '@eko/chain';
import type {createMeteredClients} from '@eko/chain';
import {encodeAbiParameters,toHex} from 'viem';
import {cursor,route,input,deep,matches,probeOutput} from '../../../packages/chain/test/reference-fixtures.js';
import {runV3References,persistReferenceResult,expireSimulationTraces,simulationTrace,loadReferenceInputs} from '../src/reference-simulation.js';
import {loadSources} from '../src/sources.js';
import {EngineWorker} from '../src/worker.js';
import {assembleCard,evaluatedPlaybooks} from '../src/card.js';
import {evaluatePlaybooks} from '@eko/playbooks';
import type {CoinCard} from '@eko/shared';
const handles:ChainDb[]=[];
afterEach(async()=>{for(const db of handles.splice(0))await db.close();});
async function setup() {
  const db=await openDb({pgliteDir:':memory:'});handles.push(db);await migrate(db);await migrateEngines(db);
  await db.ensurePartitions(new Date(1000000));
  await db.insert('chain_blocks',{number:'100',block:'100',hash:binary(cursor.blockHash),parent_hash:binary(referenceDigest('parent')),ts:new Date(1000000)});
  await db.insert('tokens',{address:binary(route.coin),deployer:binary(route.router),curve:null,name:'Fixture token',symbol:'FIX',launchpad:'other',decimals:18,total_supply:'1000000',supply_block:'100',first_block:'100',block:'100'});
  return db;
}
async function result(sizeUsd:100|1000|10000=100,blocked=false):Promise<ReferenceResult> {
  const archive={request:vi.fn(async({method}:{method:string})=>method==='eth_getBlockByNumber'?{hash:cursor.blockHash,timestamp:toHex(BigInt(cursor.timestampSec))}:
    method==='eth_getCode'?'0x':method==='eth_call'?encodeAbiParameters([{type:'uint256'}],[1000n]):{output:probeOutput(1000n,990n,blocked?0n:990n,true,!blocked)})};
  return new V3ReferenceSimulation({archive} as unknown as Pick<ReturnType<typeof createMeteredClients>,'archive'>,{confirm:async()=>deep(blocked?{sellOk:false,returned:'0'}:{})})
    .run({...input,sizeUsd,matches:matches(sizeUsd)});
}
describe('normalizer reference persistence and consumer refresh (fixture evidence only)',()=>{
  it('persists 3 independent pinned USD sizes with rational conversion',async()=>{
    const db=await setup();const run=vi.fn(async args=>({...await result(args.sizeUsd),requestedWei:args.sizeWei.toString()}));
    const results=await runV3References(db,{run},{cursor,route,matches:[],ethUsd:{numerator:2000n,denominator:1n,blockHash:cursor.blockHash,evidenceIds:['fixture-price']}});
    expect(run.mock.calls.map(([r])=>r.sizeWei)).toEqual([5n*10n**16n,5n*10n**17n,5n*10n**18n]);
    expect(results.map(r=>r.sizeUsd)).toEqual([100,1000,10000]);
    expect((await db.sql.query('SELECT id FROM sim_runs')).rows).toHaveLength(3);
    await expect(runV3References(db,{run},{cursor,route,matches:[],ethUsd:{numerator:0n,denominator:1n,blockHash:cursor.blockHash,evidenceIds:[]}})).rejects.toThrow('price unavailable');
  });
  it('keeps normalized results/digests forever and expires raw trace without resurrection',async()=>{
    const db=await setup(),r=await result();await persistReferenceResult(db,r);await persistReferenceResult(db,r);
    expect(await simulationTrace(db,r.id)).toMatchObject({status:'available',digest:r.traceDigest});
    const stored=(await db.sql.query<{data:ReferenceResult}>('SELECT data FROM sim_runs')).rows[0].data;
    expect(stored.deep.every(e=>!('trace' in e))).toBe(true);
    await db.sql.query("UPDATE sim_runs SET trace_expires_at=now()-interval '1 second'");
    expect(await simulationTrace(db,r.id)).toMatchObject({status:'expired',trace:null});
    await new EngineWorker(db).poll();
    expect((await db.sql.query<{trace:unknown}>('SELECT trace FROM sim_runs')).rows[0].trace).toBeNull();
    await expireSimulationTraces(db);await persistReferenceResult(db,r);
    expect((await db.sql.query<{trace:unknown;data:unknown;trace_digest:string}>('SELECT trace,data,trace_digest FROM sim_runs')).rows[0]).toMatchObject({trace:null,data:{status:'ok'},trace_digest:r.traceDigest});
    await expect(persistReferenceResult(db,{...r,trace:['tampered']})).rejects.toThrow('digest mismatch');
  });
  it('feeds real values to live sources/cards but excludes replay, Pons and other forks',async()=>{
    const db=await setup();for(const size of [100,1000,10000] as const)await persistReferenceResult(db,await result(size));
    const s=(await loadSources(db,route.coin,100))!;
    expect(s.simulations).toHaveLength(3);expect(s.taxes).toMatchObject({buyPct:0,sellPct:0,mutable:null});expect(evaluatedPlaybooks(s)).toContain('honeypot');
    await new EngineWorker(db).processBlock(100);
    const card=(await db.sql.query<{data:CoinCard}>('SELECT data FROM coin_card_latest')).rows[0].data;
    expect(card.tradeability.exitCostPct).toEqual({usd100:1,usd1k:1,usd10k:1});
    expect(card.meta?.tradeability?.unavailable).toBe(false);expect(card.verdict.level).toBe('pending');
    expect((await loadSources(db,route.coin,100,undefined,undefined,undefined,true))!.simulations).toBeUndefined();
    const pons={...s,launchpad:'pons' as const,simulations:undefined,referenceResults:undefined};await loadReferenceInputs(db,pons);expect(pons.simulations).toBeUndefined();
    await db.sql.query('UPDATE sim_runs SET block_hash=$1',[binary(referenceDigest('other-fork'))]);
    expect((await loadSources(db,route.coin,100))!.simulations).toHaveLength(0);
  });
  it('keeps missing fork evidence unavailable and never evaluates a completed honeypot check',async()=>{
    const db=await setup(),r=await result();await persistReferenceResult(db,{...r,complete:false,status:'fork_evidence_missing'});
    const s=(await loadSources(db,route.coin,100))!;
    expect(evaluatedPlaybooks(s)).not.toContain('honeypot');
    await new EngineWorker(db).processBlock(100);
    expect((await db.sql.query<{data:CoinCard}>('SELECT data FROM coin_card_latest')).rows[0].data.meta?.tradeability?.unavailable).toBe(true);
  });
  it('passes confirmed blocked exit evidence into the existing Danger rule',async()=>{
    const db=await setup();for(const size of [100,1000] as const)await persistReferenceResult(db,await result(size,true));
    const s=(await loadSources(db,route.coin,100))!;
    expect(evaluatePlaybooks(s).find(m=>m.id==='honeypot')?.level).toBe('danger');
  });
  it('acquires references before live card assembly and never starts acquisition during replay',async()=>{
    const db=await setup(),acquire=vi.fn(async()=>{for(const size of [100,1000,10000] as const)await persistReferenceResult(db,await result(size));});
    const worker=new EngineWorker(db,{referenceSimulation:acquire});await worker.processBlock(100);
    expect(acquire).toHaveBeenCalledWith(route.coin,100);
    const count=acquire.mock.calls.length;await worker.replay(100,100);expect(acquire).toHaveBeenCalledTimes(count);
  });
});
