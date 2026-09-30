import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { MarketWindow } from '../src/market.js';
import { EngineWorker } from '../src/worker.js';
import { growingReplayFixture } from './replay-fixture.js';
const shape={coins:300,activeCoins:200,swapsPerCoin:3000,holdersPerCoin:2200,hours:12,staggered:true,denseClock:true,fractional:true};
const db=await growingReplayFixture(shape);
try {
  let rankSqlCalls=0,historicalExactReads=0;
  const last=new WeakMap<MarketWindow,{block:number;sec:number}>(),ranked=MarketWindow.prototype.ranked;
  MarketWindow.prototype.ranked=function(block,sec){const prior=last.get(this);if(prior && (block<prior.block || sec<prior.sec))historicalExactReads++;else last.set(this,{block,sec});return ranked.call(this,block,sec);};
  const query=db.sql.query.bind(db.sql);
  db.sql.query=((...args:Parameters<typeof query>)=>{if(/GROUP BY coin ORDER BY sum\(usd\) DESC,coin/.test(args[0]))rankSqlCalls++;return query(...args);}) as typeof db.sql.query;
  const start=performance.now();let headerRequests=0,total=0;const points:number[]=[];
  const worker=new EngineWorker(db,{marketWindow:process.env.BENCH_MARKET!=='live',replayCache:process.env.BENCH_CACHE!=='off',onPlanned:plan=>{total=plan.tasks;console.log(JSON.stringify({event:'benchmark_planned',shape,...plan}));},onProgress:n=>{points.push(performance.now());if(n%2000===0)console.log(JSON.stringify({event:'benchmark_progress',evaluations:n,...worker.telemetry()}));},readBlock:async()=>{headerRequests++;throw new Error('Timestamped fixtures must not request archive headers');}});
  const evaluations=await worker.replay(1,shape.hours*1800),elapsedSec=(performance.now()-start)/1000;
  const tenth=Math.floor(evaluations/10);
  const rate=(a:number,b:number)=>(b-a)*1000/(points[b-1]-points[a-1]);
  console.log(JSON.stringify({shape,planned:total,evaluations,...worker.telemetry(),elapsedSec,evaluationsPerSec:evaluations/elapsedSec,first10PctPerSec:rate(1,tenth),last10PctPerSec:rate(evaluations-tenth,evaluations),headerRequests,referenceSqlCalls:rankSqlCalls,sqlRankCalls:rankSqlCalls,historicalExactReads,...worker.summary()}));
  assert.equal(rankSqlCalls,0,'Replay must never fall back to SQL float ranks');
} finally {await db.close();}
