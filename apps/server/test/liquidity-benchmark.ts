/** Offline benchmark: pnpm --filter @eko/server exec node --import tsx test/liquidity-benchmark.ts */
import assert from 'node:assert/strict';
import { ChainDb, binary, hex, migrate, migrateEngines, type SqlClient } from '@eko/db';
import { openDb } from '../../../packages/db/test/helpers/historical-db.js';
import { readPoolLiquidity, readPoolMoney } from '../src/read/pool-liquidity.js';
import { refreshLiquidityModels } from '../src/read/liquidity-model.js';

const db=await openDb({pgliteDir:':memory:'}),now=Date.parse('2026-10-17T12:00:00Z');
try {
  await migrate(db);await migrateEngines(db);
  await db.sql.query(`INSERT INTO tokens(address,deployer,name,symbol,first_block,block,graduated_block,graduated_pool,launchpad)
    SELECT decode(lpad(to_hex(n),40,'0'),'hex'),decode(lpad(to_hex(999999),40,'0'),'hex'),'Sample coin','DEMO',1,1,
    CASE WHEN n%2=0 THEN 10 END,CASE WHEN n%2=0 THEN decode(lpad(to_hex(n),64,'0'),'hex') END,CASE WHEN n%2=0 THEN 'pons' ELSE 'other' END
    FROM generate_series(1,30000) n`);
  await db.sql.query(`INSERT INTO pools(id,currency0,currency1,venue,fee,tick_spacing,created_block,block)
    SELECT decode(lpad(to_hex(n),64,'0'),'hex'),decode(lpad(to_hex(n),40,'0'),'hex'),decode(repeat('00',20),'hex'),'uniswap_v4',3000,60,1,1 FROM generate_series(1,30000) n`);
  await db.sql.query(`INSERT INTO coin_lifetime(coin,data)
    SELECT t.address,jsonb_build_object('tail',tail.rows,'lastPositivePriced',tail.rows->0,'liquidity',jsonb_build_object('0x'||encode(p.id,'hex'),
      jsonb_build_object('fullRangeDelta','1000','moneyPositions',jsonb_build_object('sample',jsonb_build_object('lower',-887200,'upper',887200,'liquidity','1000')))))
    FROM tokens t JOIN pools p ON p.currency0=t.address CROSS JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object('pool_id','0x'||encode(p.id,'hex'),'block',n+10,'log_index',0,'tx_hash','0x'||lpad(to_hex(n),64,'0'),
        'amount_coin','100','amount_quote','400','usd',8,'ts','2026-10-17T11:59:00Z') ORDER BY n DESC) rows FROM generate_series(1,60) n) tail`);
  await db.sql.query(`INSERT INTO read_coins(coin,tier,activity,first_block,pair_column,pair_block,launchpad,volume)
    SELECT address,2,to_timestamp($1),1,'new',1,launchpad,30001-row_number() OVER(ORDER BY address) FROM tokens`,[now/1000]);
  const all=(await db.sql.query<{address:Uint8Array}>('SELECT address FROM tokens ORDER BY address')).rows.map(r=>hex(r.address));
  for(let i=0;i<all.length;i+=500)await refreshLiquidityModels(db,all.slice(i,i+500),now);
  for(const table of ['tokens','pools','coin_lifetime','read_coins','read_coin_liquidity'])await db.sql.query(`ANALYZE ${table}`);
  const cutoff=new Date(now-7*86400000),select='SELECT coin,tier,volume FROM read_coins WHERE activity>$1 ORDER BY -volume,coin LIMIT 101';
  const page=(await db.sql.query<{coin:Uint8Array}>(select,[cutoff])).rows.slice(0,100).map(r=>hex(r.coin));
  const statements:{sql:string;params:unknown[]}[]=[];
  const wrap=(sql:SqlClient):SqlClient=>({query:async<T>(text:string,params?:unknown[])=>{statements.push({sql:text,params:params ?? []});return sql.query<T>(text,params);}});
  const traced=new ChainDb(wrap(db.sql),fn=>db.tx(tx=>fn(wrap(tx.sql))));
  await readPoolLiquidity(traced,page.filter((_,i)=>i%2===1));
  await readPoolMoney(traced,page.filter((_,i)=>i%2===0),now,true);
  const joined=`WITH page AS MATERIALIZED (SELECT * FROM (${select}) candidates LIMIT 100) SELECT p.*,l.usd,l.unavailable,l.curve_pct FROM page p LEFT JOIN read_coin_liquidity l ON l.coin=p.coin AND l.coin=ANY($2::bytea[]) ORDER BY -p.volume,p.coin`;
  const explain=async(sql:string,params:unknown[])=>{
    const plan=(await db.sql.query<{'QUERY PLAN':{'Execution Time':number;Plan:unknown}[]}>('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+sql,params)).rows[0]['QUERY PLAN'][0];
    return {ms:plan['Execution Time'],plan:plan.Plan};
  };
  const before:number[]=[],after:number[]=[];
  for(let i=0;i<22;i++) {
    let ms=(await explain(select,[cutoff])).ms;
    for(const s of statements)ms+=(await explain(s.sql,s.params)).ms;
    const fast=await explain(joined,[cutoff,page.map(binary)]);
    if(i>0){before.push(ms);after.push(fast.ms);}
    if(i===21) {
      const nodes=(node:unknown):Record<string,unknown>[]=>{const n=node as Record<string,unknown>;return [n,...((n.Plans ?? []) as unknown[]).flatMap(nodes)];};
      const reads=nodes(fast.plan).filter(n=>n['Relation Name']==='read_coin_liquidity' || n['Index Name']==='read_coin_liquidity_pkey');
      assert(reads.some(n=>n['Index Name']==='read_coin_liquidity_pkey'));
      assert(reads.every(n=>Number(n['Actual Rows'])<=100));
      console.info('indexed_join_plan',JSON.stringify(reads.map(n=>({node:n['Node Type'],index:n['Index Name'],rows:n['Actual Rows'],loops:n['Actual Loops']}))));
    }
  }
  const stats=(v:number[])=>{const sorted=v.toSorted((a,b)=>a-b);return {medianMs:sorted[Math.floor(sorted.length/2)],p95Ms:sorted[Math.ceil(sorted.length*0.95)-1]};};
  console.info('liquidity_benchmark',JSON.stringify({runtime:'PGlite',coins:all.length,pageSize:100,tailPerCoin:60,samples:21,before:stats(before),after:stats(after),legacyStatements:statements.length}));
} finally {await db.close();}
