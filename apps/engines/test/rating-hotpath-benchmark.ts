// Offline DB-backed throughput and actual query plans. Run before/after with the same BENCH_* shape.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
const workerModule=process.env.BENCH_WORKER_MODULE ?? '../src/worker.js';
const activityModule=process.env.BENCH_ACTIVITY_MODULE ?? '../src/activity.js';
const {EngineWorker,staleRatings}=await import(workerModule) as typeof import('../src/worker.js');
const {activityRows}=await import(activityModule) as typeof import('../src/activity.js');
import { counting } from './live-history-fixture.js';
import { growingReplayFixture, sampleAddress } from './replay-fixture.js';
const shape={coins:40,activeCoins:20,swapsPerCoin:Number(process.env.BENCH_SWAPS ?? 400),holdersPerCoin:200,hours:6,staggered:true,denseClock:true};
const db=await growingReplayFixture(shape);
try {
  // Optional historical-code runs remove only this migration's objects from this fresh in-memory fixture.
  if(process.env.BENCH_BASELINE==='1') {
    const triggers=(await db.sql.query<{tgname:string;rel:string}>(`SELECT tgname,tgrelid::regclass::text AS rel FROM pg_trigger
      WHERE tgname LIKE 'engine_rating_%' OR tgname LIKE 'engine_activity_block_changed_%'`)).rows;
    for(const row of triggers)await db.sql.query(`DROP TRIGGER ${row.tgname} ON ${row.rel}`);
    await db.sql.query('DROP VIEW engine_rating_candidate_rows');
    await db.sql.query('DROP TABLE engine_rating_candidates,engine_rating_versions,engine_activity_versions,engine_activity_block_versions');
    for(const index of ['sell_check_runs_coin_block_result','pons_exemptions_token_block','pools_currency0_created','pools_currency1_created'])await db.sql.query(`DROP INDEX ${index}`);
  }
  await db.sql.query('ANALYZE');
  let phase='cold';
  const captured=new Map<string,{sql:string;params?:unknown[]}>(),counts:Record<string,number>={};
  const instrumented=new WeakSet<object>();
  const instrument=(client:typeof db.sql)=>{
    if(instrumented.has(client))return;instrumented.add(client);
    const query=client.query.bind(client);
    client.query=(async(sql:string,params?:unknown[])=>{
      const name=sql.includes('candidate(coin)') ? 'stale' : sql.includes('WITH activity AS') ? 'activity' : sql.includes('AS block FROM (SELECT DISTINCT block') || sql.includes('SELECT greatest(') && sql.includes('LIMIT 1') ? 'boundary' : undefined;
      if(name){const key=name==='activity' && phase==='repair' ? 'activity_repair' : name;counts[name]=(counts[name] ?? 0)+1;if(!captured.has(key))captured.set(key,{sql,params});}
      return query(sql,params);
    }) as typeof client.query;
  };
  instrument(db.sql);
  const tx=db.tx.bind(db);
  db.tx=fn=>tx(inner=>{instrument(inner.sql);return fn(inner);});
  const sec=Number((await db.sql.query<{sec:number}>('SELECT extract(epoch FROM ts)::double precision AS sec FROM engine_block_times ORDER BY number DESC LIMIT 1')).rows[0].sec);
  const worker=new EngineWorker(db,{now:()=>sec+1,liveBacklogSec:900,concurrency:4});
  const started=performance.now(),evaluations=await worker.poll(),elapsedMs=performance.now()-started;
  const pollCounts={...counts},coins=Array.from({length:40},(_,i)=>sampleAddress(i+100));
  assert.equal(evaluations,98,'The frozen fixture must complete the same evaluations');
  // Exercise the pricing-repair branch with wide pending Pons cards, independently of throughput scheduling.
  await db.sql.query("UPDATE tokens SET launchpad='pons'");
  await db.sql.query(`UPDATE coin_card_latest SET data=jsonb_set(jsonb_set(data,'{verdict,level}','"pending"'),
    '{verdict,evaluatedPlaybooks}','["bundle_dump","holder_concentration","dev_dump","run_up"]')`);
  // A fresh handle gives comparable cold probes after the measured worker poll; warm probes reuse it.
  const isolated=counting(db).db,probes:Record<string,unknown>={};
  captured.delete('stale');captured.delete('activity');captured.delete('boundary');
  const probe=async(name:string,fn:()=>Promise<unknown>)=>{const before={...counts},begin=performance.now();await fn();
    const result={ms:performance.now()-begin,calls:Object.fromEntries(Object.entries(counts).map(([key,value])=>[key,value-(before[key] ?? 0)]))};
    probes[name]=result;console.log(JSON.stringify({probe:name,...result}));};
  await probe('stale_cold',()=>staleRatings(isolated,coins,100));
  await probe('stale_warm',()=>staleRatings(isolated,coins,100));
  const scope={ranges:{coins:[coins[0]],from:[-1],to:[10800]}};
  await probe('activity_cold',()=>activityRows(isolated,10800,scope));
  await probe('activity_warm',()=>activityRows(isolated,10800,scope));
  await db.sql.query('UPDATE swaps SET usd=usd+1 WHERE coin=$1 AND log_index=1',[Buffer.from(coins[0].slice(2),'hex')]);
  phase='repair';
  await probe('activity_repair',()=>activityRows(isolated,10800,scope));
  const plans:Record<string,unknown>={};
  for(const [name,{sql,params}] of captured)plans[name]={sql,plan:(await db.sql.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${sql}`,params)).rows};
  const files=[activityModule.replace(/\.js$/,'.ts'),workerModule.replace(/\.js$/,'.ts'),'../../../packages/db/drizzle/0214_rating_hotpaths.sql'];
  const sourceDigest=createHash('sha256');for(const file of files)sourceDigest.update(await readFile(new URL(file,import.meta.url)));
  const report={fixture:'growingReplayFixture',serverVersion:(await db.sql.query('SHOW server_version')).rows,sourceSha256:sourceDigest.digest('hex'),shape,evaluations,elapsedMs,evaluationsPerHour:evaluations*3600000/elapsedMs,pollCounts,probes,counts,plans};
  if(process.env.BENCH_REPORT)await writeFile(process.env.BENCH_REPORT,JSON.stringify(report,null,2));
  console.log(JSON.stringify({shape,evaluations,elapsedMs,evaluationsPerHour:evaluations*3600000/elapsedMs,counts}));
} finally {await db.close();}
