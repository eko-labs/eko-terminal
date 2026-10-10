/** Offline real-shaped read benchmark and EXPLAIN ANALYZE capture; no listening socket or chain client. */
import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { seedReadFixture, sampleAddress } from './read-fixture.js';
const now=Date.now(),sec=Math.floor(now/1000);
const built=await buildApp(loadConfig({NODE_ENV:'test',PGLITE_DIR:':memory:',SESSION_SECRET:'benchmark-placeholder'.repeat(3),LEGACY_API:'false',RUN_WORKER:'false',MARKET_DATA_SOURCE:'onchain'}),{startBackground:false});
const db=built.ctx.dbh.chain;
try {
 const card=await seedReadFixture(db,now-8*3600000);built.ctx.reads.store.now=()=>now;
 for(const table of ['tokens','coin_card_latest','swaps','bars_1m','verdict_events','playbook_matches','pools','read_feed'])await db.sql.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
 await db.sql.query(`INSERT INTO chain_blocks(number,block,hash,parent_hash,ts) SELECT n,n,decode(lpad(to_hex(n),64,'0'),'hex'),decode(lpad(to_hex(n-1),64,'0'),'hex'),to_timestamp($1-86400+n*0.432) FROM generate_series(1,200000) n ON CONFLICT DO NOTHING`,[sec]);
 await db.sql.query("INSERT INTO engine_block_times(number,ts,hash,source) SELECT number,ts,hash,'head' FROM chain_blocks ON CONFLICT DO NOTHING");
 await db.sql.query(`INSERT INTO tokens(address,deployer,curve,name,symbol,launchpad,first_block,block,decimals,total_supply,supply_block,graduated_block)
 SELECT decode(lpad(to_hex(c+10000),40,'0'),'hex'),decode(lpad(to_hex(c+20000),40,'0'),'hex'),decode(lpad(to_hex(c+30000),40,'0'),'hex'),'Sample coin','LONGSAMPLESYMBOL','pons',1,1,18,1e27,1,CASE WHEN c%7=0 THEN 150000+c ELSE NULL END FROM generate_series(1,2474) c`);
 await db.sql.query(`INSERT INTO tokens(address,name,symbol,launchpad,first_block,block) SELECT decode(lpad(to_hex(c+40000),40,'0'),'hex'),'Pool identity','POOL','other',1,1 FROM generate_series(1,2683) c`);
 await db.sql.query(`INSERT INTO coin_cards(id,coin,valid_from_block,hash,data,rules_version)
 SELECT 'bench-card:'||c,address,1,'benchmark',jsonb_set(jsonb_set(jsonb_set(jsonb_set($1::jsonb,'{identity,address}',to_jsonb('0x'||encode(address,'hex'))),'{verdict,coin}',to_jsonb('0x'||encode(address,'hex'))),'{verdict,level}',to_jsonb(CASE WHEN c<=280 THEN 'danger' WHEN c<=676 THEN 'monitor' ELSE 'pending' END)),'{identity,curvePct}',to_jsonb(CASE WHEN c%5=0 THEN 80 ELSE 20 END)), '1.0.2'
 FROM generate_series(1,2474) c JOIN tokens ON address=decode(lpad(to_hex(c+10000),40,'0'),'hex')`,[card]);
 await db.sql.query('INSERT INTO coin_card_latest SELECT coin,id,valid_from_block,data FROM coin_cards WHERE id LIKE \'bench-card:%\'');
 await db.sql.query(`INSERT INTO swaps(ts,block,tx_hash,log_index,venue,pool_id,coin,quote_asset,trader,tx_from,tx_to,side,amount_coin,amount_quote,price_quote,usd,priced_block)
 SELECT to_timestamp($1-86400+n*0.216),ceil(n/2.0),decode(lpad(to_hex(n+1000000),64,'0'),'hex'),0,'pons_curve',coin,coin,decode(repeat('00',20),'hex'),actor,actor,coin,CASE WHEN n%2=0 THEN 1 ELSE -1 END,1e18,1,1,10,ceil(n/2.0)
 FROM generate_series(1,400000) n CROSS JOIN LATERAL(SELECT decode(lpad(to_hex(n%2474+10001),40,'0'),'hex') coin,decode(lpad(to_hex(n%200+50000),40,'0'),'hex') actor) a`,[sec]);
 await db.sql.query(`INSERT INTO bars_1m SELECT coin,date_trunc('minute',ts),1,1,1,1,sum(usd),count(*),min(block),max(block) FROM swaps WHERE coin BETWEEN decode(lpad(to_hex(10001),40,'0'),'hex') AND decode(lpad(to_hex(12474),40,'0'),'hex') GROUP BY coin,date_trunc('minute',ts)`);
 await db.sql.query(`INSERT INTO engine_runs SELECT coin,n,$1-86400+n*0.72,1,'{}','1.0.2' FROM generate_series(1,120000) n CROSS JOIN LATERAL(SELECT decode(lpad(to_hex(n%2474+10001),40,'0'),'hex') coin) a`,[sec]);
 await db.sql.query(`INSERT INTO verdicts SELECT 'bench-verdict:'||n,coin,n,'1.0.2','benchmark',jsonb_set($1::jsonb,'{coin}',to_jsonb('0x'||encode(coin,'hex'))) FROM generate_series(1,120000) n CROSS JOIN LATERAL(SELECT decode(lpad(to_hex(n%2474+10001),40,'0'),'hex') coin) a`,[card.verdict]);
 await db.sql.query(`INSERT INTO playbook_matches SELECT decode(lpad(to_hex(n%2474+10001),40,'0'),'hex'),n*10,'1.0.2',CASE WHEN n%2=0 THEN 'wash_to_trend' ELSE 'agent_bait' END,jsonb_build_object('id',CASE WHEN n%2=0 THEN 'wash_to_trend' ELSE 'agent_bait' END,'level','monitor','confidence',0.85) FROM generate_series(1,12000) n`);
 await db.sql.query(`INSERT INTO verdict_events SELECT 'bench-event:'||n,'bench-verdict:'||n,'created',n,'{}' FROM generate_series(1,120000) n`);
 // Seed projections in sets, as when the migration upgrades an existing replay database.
 await db.sql.query('TRUNCATE read_feed,read_first_verdict,read_coins,read_buyers');
 const migration=await readFile(new URL('../../../packages/db/drizzle/0113_v1_reads.sql',import.meta.url),'utf8');
 for(const segment of migration.split('-- statement-breakpoint')) {
  if(segment.includes('CREATE FUNCTION'))continue;
  for(const statement of segment.replace(/^--.*$/gm,'').split(';').map(s=>s.trim()))if(/^(SELECT refresh_read_coin|INSERT INTO read_(?:feed|first_verdict|coins|buyers)\b|UPDATE read_coins)/.test(statement))await db.sql.query(statement);
 }
 await db.sql.query('UPDATE read_feed f SET first_block=t.first_block,symbol=t.symbol FROM tokens t WHERE t.address=f.coin');
 for(const table of ['tokens','coin_card_latest','swaps','bars_1m','verdict_events','playbook_matches','pools','read_feed'])await db.sql.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
 await db.sql.query('VACUUM ANALYZE');
 const plans:{route:string;sql:string;plan:unknown}[]=[],timings:{route:string;coldMs:number;p95Ms:number;maxMs:number}[]=[];
 let route='',capture=false;
 const query=db.sql.query.bind(db.sql);
 db.sql.query=async function<T>(sql:string,params?:unknown[]) {
  if(capture && /^\s*(SELECT|WITH)/i.test(sql))plans.push({route,sql,plan:(await query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${sql}`,params)).rows});
  return query<T>(sql,params);
 };
 const coin=sampleAddress(10001),routes=['/v1/radar','/v1/pairs?stage=new','/v1/pairs?stage=near_grad','/v1/pairs?stage=migrated','/v1/feed','/v1/feed?kinds=verdict','/v1/feed?kinds=new_pair','/v1/feed?kinds=playbook,wash','/v1/feed?kinds=burn',`/v1/coins/${coin}`,`/v1/coins/${coin}/verdict`,`/v1/coins/${coin}/flow`,`/v1/coins/${coin}/candles?tf=5m&from=${sec-21600}&to=${sec}`,`/v1/coins/${coin}/markers?from=${sec-21600}&to=${sec}`,`/v1/scan?q=${coin}`,'/v1/scan?q=$POOL'];
 for(route of routes) {
  const values:number[]=[];
  for(let i=0;i<6;i++){const start=performance.now(),response=await built.app.inject(route);if(response.statusCode!==200)throw new Error(`${route}: ${response.body}`);values.push(performance.now()-start);}
  timings.push({route,coldMs:+values[0].toFixed(2),p95Ms:+[...values.slice(1)].sort((a,b)=>a-b)[4].toFixed(2),maxMs:+Math.max(...values).toFixed(2)});
  capture=true;await built.app.inject(route);capture=false;
 }
 for(const base of ['/v1/radar','/v1/pairs?stage=new','/v1/feed','/v1/feed?kinds=verdict']) {
  const first=(await built.app.inject(base)).json();if(!first.cursor)continue;
  route=base+(base.includes('?') ? '&' : '?')+'cursor='+first.cursor;
  const start=performance.now();await built.app.inject(route);const ms=performance.now()-start;
  timings.push({route:base+' (next page)',coldMs:+ms.toFixed(2),p95Ms:+ms.toFixed(2),maxMs:+ms.toFixed(2)});
  capture=true;await built.app.inject(route);capture=false;
 }
 const rollback=new Error('rollback query-plan audit');
 try {await db.tx(async tx=>{
  for(const [sql,params] of [
   ['SELECT window_sec FROM read_rank_clock WHERE singleton=true FOR UPDATE',[]],
   ['UPDATE read_coins SET volume=0 WHERE volume<>0',[]],
   [`UPDATE read_coins r SET volume=b.volume FROM (SELECT coin,sum(volume_usd) AS volume FROM bars_1m WHERE minute>=to_timestamp($1::double precision-3540) AND minute<=to_timestamp($1::double precision) GROUP BY coin) b WHERE r.coin=b.coin`,[Math.floor(sec/60)*60]],
   ['UPDATE read_rank_clock SET window_sec=$1 WHERE singleton=true',[Math.floor(sec/60)*60]],
  ] as [string,unknown[]][])plans.push({route:'/v1/radar (minute refresh)',sql,plan:(await tx.sql.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${sql}`,params)).rows});
  throw rollback;
 });}catch(error){if(error!==rollback)throw error;}
 const report={shape:{carded:2475,identityOnly:2683,engineRuns:120001,swaps:400001,verdictEvents:120001,playbookMatches:12000,blockClocks:200001},timings,plans};
 await writeFile('/private/tmp/eko-read-query-plans.json',JSON.stringify(report,null,2));
 console.log(JSON.stringify({shape:report.shape,timings},null,2));
 if(timings.some(t=>t.maxMs>=300))process.exitCode=1;
} finally {await built.close();}
