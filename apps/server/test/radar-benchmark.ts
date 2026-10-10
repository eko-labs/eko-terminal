/** Offline: pnpm --filter @eko/server exec node --import tsx test/radar-benchmark.ts
 * RADAR_REUSE=1 reuses the task-local fixture after a completed seed. No production credentials needed.
 */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { seedReadFixture } from './read-fixture.js';
import { BaselineRows } from './radar-row-baseline.js';
import { backfillRadarSeries } from '../../../scripts/backfill-radar-series.js';

const now=Date.parse('2026-10-17T12:00:00Z');
const built=await buildApp(loadConfig({NODE_ENV:'test',PGLITE_DIR:'../../.data/radar-profile-fixture',SESSION_SECRET:'test-placeholder'.repeat(3),LEGACY_API:'false',RUN_WORKER:'false',MARKET_DATA_SOURCE:'onchain'}),{startBackground:false});
try {
  const db=built.ctx.dbh.chain,store=built.ctx.reads.store;store.now=()=>now;
  if(process.env.RADAR_REUSE!=='1') {
    const card=await seedReadFixture(db,now);
    card.verdict.playbooks=[{id:'tax_trap',level:'info',confidence:.8,evidence:[]},{id:'wash_to_trend',level:'monitor',confidence:.7,evidence:[]},{id:'run_up',level:'danger',confidence:.9,evidence:[]}];
    card.verdict.evaluatedPlaybooks=['tax_trap','wash_to_trend','run_up'];
    const initial=Number((await db.sql.query<{n:string}>('SELECT count(*) n FROM tokens')).rows[0].n);
    await db.sql.query(`INSERT INTO tokens(address,deployer,name,symbol,first_block,block,total_supply,decimals,launchpad)
      SELECT decode(lpad(to_hex(100000+n),40,'0'),'hex'),decode(lpad(to_hex(999999),40,'0'),'hex'),'Sample coin','DEMO',1,1,1000,0,'other'
      FROM generate_series(1,$1::int) n ON CONFLICT DO NOTHING`,[30000-initial]);
    const source=(await db.sql.query<{card_id:string}>('SELECT card_id FROM coin_card_latest LIMIT 1')).rows[0].card_id;
    await db.sql.query('ALTER TABLE coin_card_latest DISABLE TRIGGER read_card_change');
    await db.sql.query(`INSERT INTO coin_card_latest(coin,card_id,as_of_block,data)
      SELECT address,$1,1,jsonb_set(jsonb_set($2::jsonb,'{identity,address}',to_jsonb('0x'||encode(address,'hex'))),'{verdict,coin}',to_jsonb('0x'||encode(address,'hex'))) FROM tokens
      ON CONFLICT(coin) DO UPDATE SET data=excluded.data`,[source,JSON.stringify(card)]);
    await db.sql.query('ALTER TABLE coin_card_latest ENABLE TRIGGER read_card_change');
    // Seed all 30,000 coins, one bar per minute for eight hours: 14.4 million source rows.
    // Projection backfill is measured separately from fixture construction.
    await db.sql.query('ALTER TABLE bars_1m DISABLE TRIGGER USER');
    await db.sql.query('DELETE FROM bars_1m');
    for(let offset=0;offset<30000;offset+=250) {
      await db.sql.query(`INSERT INTO bars_1m(coin,minute,open,high,low,close,volume_usd,trades,first_block,last_block)
        SELECT address,to_timestamp($1::double precision-m*60),1,2,.5,1+(m%37)::double precision/100+(n%13)::double precision/1000,
          10+(n%100)+m%11,1+m%9,1,1
        FROM (SELECT address,row_number() OVER(ORDER BY address) n FROM tokens ORDER BY address LIMIT 250 OFFSET $2) t CROSS JOIN generate_series(0,479) m`,[now/1000,offset]);
      if(offset%2500===0)console.info('fixture_coins',offset+250);
    }
    await db.sql.query('ALTER TABLE bars_1m ENABLE TRIGGER USER');
    await db.sql.query(`INSERT INTO read_coins(coin,tier,activity,first_block,pair_column,pair_block,launchpad,volume)
      SELECT address,2,to_timestamp($1),1,'new',1,launchpad,1000000-row_number() OVER(ORDER BY address) FROM tokens
      ON CONFLICT(coin) DO UPDATE SET activity=excluded.activity,volume=excluded.volume`,[now/1000]);
    await db.sql.query('INSERT INTO read_coin_liquidity(coin,usd,unavailable) SELECT address,0,true FROM tokens ON CONFLICT DO NOTHING');
    console.info('fixture_backfill_started');
    await backfillRadarSeries(db,100,now/1000,n=>{if(n%5000===0)console.info('fixture_backfilled',n);});
    await db.sql.query('DELETE FROM read_dirty');
    await db.sql.query('UPDATE read_rank_clock SET window_sec=$1',[now/1000]);
    for(const table of ['tokens','coin_card_latest','bars_1m','read_coins','read_coin_liquidity','read_row_series','read_row_cards'])await db.sql.query(`ANALYZE ${table}`);
    console.info('fixture_ready');
  }
  assert.equal(Number((await db.sql.query<{n:string}>('SELECT count(*) n FROM bars_1m')).rows[0].n),14400000);
  const original=db.sql.query.bind(db.sql),statements:{sql:string;params:unknown[];ms:number;bytes:number}[]=[];
  db.sql.query=async<T>(sql:string,params?:unknown[])=>{
    const start=performance.now(),result=await original<T>(sql,params);
    statements.push({sql,params:params ?? [],ms:performance.now()-start,bytes:0});return result;
  };
  await store.refreshSummaries();
  store.start(3_600_000);
  // Freeze fixture maintenance while measuring the readers. No builds or gates run concurrently.
  store.refreshModels=async()=>{};
  const current=store.rows;
  const times={before:[] as number[],after:[] as number[]},details={before:[] as number[],after:[] as number[]};
  const captured={before:[] as typeof statements,after:[] as typeof statements};
  let expected:string|undefined;
  for(let i=0;i<26;i++)for(const phase of (i%2?['after','before']:['before','after']) as ('before'|'after')[]) {
    store.rows=phase==='before'?BaselineRows.prototype.rows:current;
    statements.length=0;
    const started=performance.now(),response=await built.app.inject('/v2/radar'),elapsed=performance.now()-started;
    assert.equal(response.statusCode,200);assert.equal(response.json().rows.length,100);
    if(expected===undefined)expected=response.body;else assert.equal(response.body,expected,'Handler JSON bytes changed');
    const statement=statements.find(s=>s.sql.startsWith('WITH selected AS') || s.sql.startsWith('SELECT t.*,coalesce(v.revision'));
    assert(statement);
    if(i>0){times[phase].push(elapsed);details[phase].push(statement.ms);}
    captured[phase]=[...statements];
  }
  store.rows=current;
  const nodes=(node:Record<string,unknown>):Record<string,unknown>[]=>[node,...((node.Plans ?? []) as Record<string,unknown>[]).flatMap(nodes)];
  const plans:unknown[]=[];
  for(const phase of ['before','after'] as const) {
    const q=captured[phase].find(s=>s.sql.startsWith('WITH selected AS') || s.sql.startsWith('SELECT t.*,coalesce(v.revision'))!;
    q.bytes=Buffer.byteLength(JSON.stringify((await original(q.sql,q.params)).rows));
    const plan=(await original<{'QUERY PLAN':{Plan:Record<string,unknown>;'Execution Time':number}[]}>('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+q.sql,q.params)).rows[0]['QUERY PLAN'][0];
    plans.push({phase,bytes:q.bytes,...plan});
    console.info('row_plan',JSON.stringify({phase,ms:plan['Execution Time'],bytes:q.bytes,nodes:nodes(plan.Plan).map(n=>({node:n['Node Type'],relation:n['Relation Name'],subplan:n['Subplan Name'],rows:n['Actual Rows'],loops:n['Actual Loops'],ms:n['Actual Total Time'],sort:n['Sort Method'],sortSpace:n['Sort Space Used']}))}));
  }
  assert(!captured.after.some(s=>s.sql.includes('FROM bars_1m') || s.sql.includes('coin_card_latest') || s.sql.includes('jsonb_agg')));
  const stats=(values:number[])=>{const sorted=values.toSorted((a,b)=>a-b);return {p50Ms:sorted[Math.floor(sorted.length/2)],p95Ms:sorted[Math.ceil(sorted.length*.95)-1]};};
  const files={reader:'../src/read/store.ts',cache:'../src/read/row-cache.ts',baseline:'./radar-row-baseline.ts',migration:'../../../packages/db/drizzle/0223_radar_row_projection.sql'};
  const sourceHashes=Object.fromEntries(await Promise.all(Object.entries(files).map(async([name,path])=>[name,createHash('sha256').update(await readFile(new URL(path,import.meta.url))).digest('hex')])));
  const report={sourceHashes,analysis:{
    dominantWork:'Before: indexed day aggregation and per-coin spark bucketing/sorts. After: indexed projection lookups only.',
    matches:'This checkout has no SQL jsonb_agg of matches. Full card JSON was returned and parsed for every row, now cached by revision.',
    clock:'Bar insert/update/delete triggers rebuild affected series. Background minute expiry uses stored day arrays without reading bars.',
    limitation:'Local PGlite PostgreSQL 18, not production latency. Native PostgreSQL startup was blocked by sandbox shared memory permissions.'},scope:'Full /v2/radar via Fastify inject, alternating baseline row method and current reader on the same fixture',runtime:'PGlite',version:(await original<{v:string}>('SELECT version() v')).rows[0].v,
    coins:30000,bars:14400000,minutesPerCoin:480,playbookMatchesPerCard:3,page:100,samples:25,warmupsPerVersion:1,
    handler:{before:stats(times.before),after:stats(times.after)},statement:{before:stats(details.before),after:stats(details.after)},
    payloadBytes:Buffer.byteLength(expected!),byteEqual:true,statements:{before:captured.before.length,after:captured.after.length},cache:{entries:store.rowCache.size,bytes:store.rowCache.byteSize,maxEntries:store.rowCache.maxEntries,maxBytes:store.rowCache.maxBytes},plans};
  await writeFile(new URL('./radar-benchmark-result.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
  console.info('radar_benchmark',JSON.stringify({...report,plans:undefined}));
} finally {await built.close();}
