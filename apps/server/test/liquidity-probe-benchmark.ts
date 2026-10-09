/** Offline before/after proof: pnpm --filter @eko/server exec node --import tsx test/liquidity-probe-benchmark.ts */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { migrate, migrateEngines } from '@eko/db';
import { openDb } from '../../../packages/db/test/helpers/historical-db.js';
import { backfillPoolPrices } from '../../../scripts/backfill-pool-prices.js';
import { LIQUIDITY_PRICE_SQL, prepareLiquidityModels } from '../src/read/liquidity-model.js';
import { HEADER_COUNTS_SQL, GUARD_HEADER_TODAY_SQL, HEADER_HOURS_SQL } from '../src/read/header-totals.js';
import { OLD_LIQUIDITY_PRICE_SQL, OLD_HEADER_COUNTS_SQL } from './header-price-baseline.js';

const db=await openDb({pgliteDir:':memory:'}),now=Date.parse('2026-10-17T12:00:00Z');
type Plan={ [key:string]:unknown; Plans?:Plan[] };
const walk=(n:Plan):Plan[]=>[n,...(n.Plans ?? []).flatMap(walk)];
async function measure(sql:string,params:unknown[]) {
  const samples:number[]=[],plans:Plan[]=[];
  for(let i=0;i<4;i++) {
    const e=(await db.sql.query<{'QUERY PLAN':{Plan:Plan;'Execution Time':number}[]}>('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+sql,params)).rows[0]['QUERY PLAN'][0];
    if(i>0)samples.push(e['Execution Time']);
    plans.push(e.Plan);
  }
  return {medianMs:[...samples].sort((a,b)=>a-b)[1],samplesMs:samples,plan:plans.at(-1)!};
}
try {
  await migrate(db);await migrateEngines(db);await db.ensurePartitions(new Date(now));
  await db.sql.query(`INSERT INTO tokens(address,deployer,name,symbol,first_block,block,launchpad)
    SELECT decode(lpad(to_hex(n),40,'0'),'hex'),decode(lpad(to_hex(999999),40,'0'),'hex'),'Sample coin','DEMO',1,1,'other' FROM generate_series(1,30000) n`);
  // All 30,000 coins have 1-4 pools, not just the hot subset. Older pools become inactive on hot coins.
  for(let first=1;first<=30000;first+=500)await db.sql.query(`INSERT INTO swaps(ts,block,tx_hash,log_index,venue,pool_id,coin,quote_asset,side,amount_coin,amount_quote,usd)
    SELECT to_timestamp($1::double precision),p,decode(lpad(to_hex(c*10000+p),64,'0'),'hex'),0,'uniswap_v4',
      decode(lpad(to_hex(c*10+p),64,'0'),'hex'),decode(lpad(to_hex(c),40,'0'),'hex'),decode(repeat('00',20),'hex'),1,100,400,8
    FROM generate_series($2::int,$3::int) c CROSS JOIN LATERAL generate_series(0,(c-1)%4) p`,[now/1000,first,first+499]);
  await db.sql.query(`INSERT INTO swaps(ts,block,tx_hash,log_index,venue,pool_id,coin,quote_asset,side,amount_coin,amount_quote,usd)
    SELECT to_timestamp($1::double precision),b,decode(lpad(to_hex(c*10000+b),64,'0'),'hex'),0,'uniswap_v4',
      decode(lpad(to_hex(c*10),64,'0'),'hex'),decode(lpad(to_hex(c),40,'0'),'hex'),decode(repeat('00',20),'hex'),1,100,400,8
    FROM generate_series(1,100) c CROSS JOIN generate_series(10,1009) b`,[now/1000]);
  await db.sql.query(`INSERT INTO read_coins(coin,tier,activity,first_block,pair_column,pair_block)
    SELECT decode(lpad(to_hex(c),40,'0'),'hex'),c%4,to_timestamp($1::double precision),1,'new',1 FROM generate_series(1,30000) c WHERE c%5<>0`,[now/1000]);
  await db.sql.query(`INSERT INTO coin_cards(id,coin,valid_from_block,hash,data) SELECT 'sample-card',address,1,'sample-hash','{}' FROM tokens ORDER BY address LIMIT 1`);
  // Suppress source projection refreshes only during fixture seeding, retaining the new presence trigger.
  await db.sql.query('ALTER TABLE coin_card_latest DISABLE TRIGGER read_card_change');
  await db.sql.query(`INSERT INTO coin_card_latest SELECT decode(lpad(to_hex(c),40,'0'),'hex'),'sample-card',1,'{"verdict":{"level":"pending"}}'::jsonb
    FROM generate_series(1,30000) c WHERE c%3<>0`);
  await db.sql.query('ALTER TABLE coin_card_latest ENABLE TRIGGER read_card_change');
  await db.sql.query(`INSERT INTO engine_runs(coin,block,sec,created_at)
    SELECT decode(lpad(to_hex(c),40,'0'),'hex'),b,$1::bigint,to_timestamp($1::double precision-((c+b)%24)*3600)
    FROM generate_series(1,30000) c CROSS JOIN generate_series(1,2) b`,[now/1000]);
  await db.sql.query(`INSERT INTO verdicts(id,coin,valid_from_block,rules_version,signature,data)
    SELECT 'sample-'||c,decode(lpad(to_hex(c),40,'0'),'hex'),1,'1.0.0','sample-signature','{"level":"danger"}' FROM generate_series(1,30000) c WHERE c%4=3`);
  for(const table of ['tokens','swaps','coin_pool_prices','read_coins','read_coin_verdicts','coin_card_latest','engine_runs','verdicts'])await db.sql.query(`ANALYZE ${table}`);
  const keys=Array.from({length:40},(_,i)=>i+1).flatMap(c=>Array.from({length:1+(c-1)%4},(_,p)=>({coin:`0x${c.toString(16).padStart(40,'0')}`,pool:`0x${(c*10+p).toString(16).padStart(64,'0')}`})));
  assert.equal(keys.length,100);
  const params=[JSON.stringify(keys)],cutoff=new Date(now-7*86400000);
  const before=await measure(OLD_LIQUIDITY_PRICE_SQL,params),after=await measure(LIQUIDITY_PRICE_SQL,params);
  assert.deepEqual((await db.sql.query(LIQUIDITY_PRICE_SQL,params)).rows,(await db.sql.query(OLD_LIQUIDITY_PRICE_SQL,params)).rows);
  const nodes=walk(after.plan),raw=nodes.filter(n=>String(n['Relation Name']).startsWith('swaps'));
  assert(raw.every(n=>Number(n['Actual Loops'])===0),'warm primary-key reads must never execute the raw fallback');
  assert(nodes.some(n=>n['Index Name']==='coin_pool_prices_pkey'));
  const headerBefore=await measure(OLD_HEADER_COUNTS_SQL,[cutoff]),headerAfter=await measure(HEADER_COUNTS_SQL,[cutoff]);
  const today=await measure(GUARD_HEADER_TODAY_SQL,[now/1000-12*3600,now/1000+12*3600,cutoff]);
  const hours=await measure(HEADER_HOURS_SQL,[now/1000-23*3600,cutoff]);
  assert.equal((await db.sql.query(HEADER_HOURS_SQL,[now/1000-23*3600,cutoff])).rows.length,24);
  assert(!walk(headerAfter.plan).some(n=>['swaps','tokens','token_transfers'].includes(String(n['Relation Name']))));
  assert(headerAfter.medianMs<300,'maintained Guard totals must stay below 300 ms on the fixture');
  assert(walk(hours.plan).some(n=>n['Index Name']==='engine_runs_created_at'));
  // Exercise the genuine historical fill, not an all-conflicts replay, using the shipped batch helper.
  await db.sql.query('DELETE FROM coin_pool_prices');
  const fallback=await measure(LIQUIDITY_PRICE_SQL,[JSON.stringify([keys[2]])]);
  assert(walk(fallback.plan).some(n=>n['Node Type']==='Limit' && n['Actual Rows']===200));
  const backfill=await backfillPoolPrices(db);
  assert.deepEqual((await db.sql.query(LIQUIDITY_PRICE_SQL,params)).rows,(await db.sql.query(OLD_LIQUIDITY_PRICE_SQL,params)).rows);
  // Preserve the production batching check from the original benchmark: 200 pool keys, two statements.
  const batchKeys=Array.from({length:80},(_,i)=>i+1).flatMap(c=>Array.from({length:1+(c-1)%4},(_,p)=>({coin:`0x${c.toString(16).padStart(40,'0')}`,pool:`0x${(c*10+p).toString(16).padStart(64,'0')}`})));
  await db.sql.query(`INSERT INTO pools(id,currency0,currency1,venue,fee,tick_spacing,created_block,block)
    SELECT decode(substring(v->>'pool' FROM 3),'hex'),decode(substring(v->>'coin' FROM 3),'hex'),decode(repeat('00',20),'hex'),'uniswap_v4',3000,60,1,1 FROM jsonb_array_elements($1::jsonb) v`,[JSON.stringify(batchKeys)]);
  const query=db.sql.query.bind(db.sql),sizes:number[]=[];
  db.sql.query=async<T>(sql:string,params?:unknown[])=>{if(sql===LIQUIDITY_PRICE_SQL)sizes.push((JSON.parse(String(params![0])) as unknown[]).length);return query<T>(sql,params);};
  await prepareLiquidityModels(db,[...new Set(batchKeys.map(k=>k.coin as `0x${string}`))],now);
  db.sql.query=query;
  assert.deepEqual(sizes,[100,100]);
  const compact=(m:Awaited<ReturnType<typeof measure>>)=>({medianMs:m.medianMs,samplesMs:m.samplesMs,
    nodes:walk(m.plan).filter(n=>Number(n['Actual Loops'])>0).map(n=>({node:n['Node Type'],relation:n['Relation Name'],index:n['Index Name'],
      condition:n['Index Cond'],rows:n['Actual Rows'],loops:n['Actual Loops'],removed:n['Rows Removed by Filter']}))});
  const report={runtime:'PGlite (offline, one process, warm medians of three EXPLAIN ANALYZE runs)',coins:30000,pools:75000,swaps:175000,engineRuns:60000,keys:100,defaultStatements:sizes,
    liquidity:{before:compact(before),after:compact(after),coldFallback:compact(fallback)},
    header:{before:compact(headerBefore),after:compact(headerAfter),today:compact(today),hours:compact(hours)},backfill,
    extrapolated67000Ms:backfill.elapsedMs*67000/backfill.coins};
  await writeFile(new URL('./liquidity-probe-benchmark-result.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
  console.info(JSON.stringify({liquidityMs:[before.medianMs,after.medianMs],headerMs:[headerBefore.medianMs,headerAfter.medianMs],todayMs:today.medianMs,hoursMs:hours.medianMs,backfill,extrapolated67000Ms:report.extrapolated67000Ms}));
} finally {await db.close();}
