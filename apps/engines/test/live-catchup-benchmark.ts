// Offline live catch-up benchmark: one live poll over a lagging, timestamped PGlite fixture, with and without
// backlog coalescing. Reports evaluations, wall time and when the newest launch got its first card.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { binary } from '@eko/db';
import { EngineWorker, type LivePlan } from '../src/worker.js';
import { growingReplayFixture, sampleAddress } from './replay-fixture.js';

const shape={coins:40,activeCoins:20,swapsPerCoin:Number(process.env.BENCH_SWAPS ?? 400),holdersPerCoin:200,hours:Number(process.env.BENCH_HOURS ?? 6),staggered:true,denseClock:true};
async function run(backlog:number|undefined) {
  const db=await growingReplayFixture(shape);
  try {
    const head=(await db.sql.query<{number:string;sec:number}>('SELECT number,extract(epoch FROM ts)::double precision AS sec FROM engine_block_times ORDER BY number DESC LIMIT 1')).rows[0];
    // A launch indexed at head while the engine is hours behind: this is the row that showed "Scanning…".
    const launch=sampleAddress(9999);
    await db.insertMany('tokens',[{address:binary(launch),deployer:binary(sampleAddress(99999)),name:'Sample coin',symbol:'DEMO',launchpad:'other',decimals:0,total_supply:'1000000000',supply_block:head.number,first_block:head.number,block:head.number}]);
    let firstCardMs:number|undefined,plannedMs:number|undefined,evaluations=0,plan:LivePlan|undefined;
    await db.bus.subscribe(message=>{if(message.topic==='card_updated' && message.ids.coin===launch && firstCardMs===undefined)firstCardMs=performance.now()-start;});
    const worker=new EngineWorker(db,{now:()=>Number(head.sec)+1,liveBacklogSec:backlog,onLivePlanned:p=>{plan=p;plannedMs=performance.now()-start;},onProgress:()=>{evaluations++;}});
    const start=performance.now();
    const completed=await worker.poll();
    const elapsedSec=(performance.now()-start)/1000;
    assert.ok(firstCardMs!==undefined,'The new launch must receive a card in the poll');
    // Poll timings come last: the worker telemetry carries process-lifetime figures under the same names.
    return {mode:backlog===undefined ? 'full catch-up' : `coalesced (${backlog} s)`,plan,completed,evaluations,...worker.telemetry(),elapsedSec,evaluationsPerSec:completed/elapsedSec,planningSec:plannedMs!/1000,newLaunchFirstCardSec:firstCardMs/1000};
  } finally {await db.close();}
}
const results=[];
for(const backlog of [undefined,900])results.push(await run(backlog));
for(const result of results)console.log(JSON.stringify({shape,...result}));
const [full,coalesced]=results;
assert.ok(coalesced.completed<full.completed,'Coalescing must evaluate fewer checkpoints than full catch-up');
