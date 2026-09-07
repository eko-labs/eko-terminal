import { expect, it } from 'vitest';
import { openDb, ChainDb, type SqlClient } from '../src/client.js';
import { sealRankings, type RawSeal } from '../src/raw-partitions.js';

// Opt-in throughput probe: narrow source rows isolate the ranking SQL from unrelated coin folds.
it.skipIf(process.env.EKO_RANKINGS_SCALE !== '1')('buckets 1.83M swaps for 6,350 launches within each statement budget',async()=>{
 const db=await openDb({pgliteDir:':memory:'});
 const seal:RawSeal={name:'swaps',partition_name:'swaps_d2026_10_12',start_ts:new Date('2026-10-12'),end_ts:new Date('2026-10-13'),rows:'0',through_block:'-1',sealed:false,dropped:false};
 try {
  for(const statement of 'CREATE TABLE trending_snapshot_queue(created_block bigint PRIMARY KEY);CREATE TABLE trending_snapshots(created_block bigint PRIMARY KEY,data jsonb);CREATE TABLE engine_block_times(number bigint PRIMARY KEY,ts timestamptz);CREATE TABLE chain_blocks(number bigint PRIMARY KEY,ts timestamptz);CREATE TABLE tokens(address bytea PRIMARY KEY,name text,symbol text,first_block bigint)'.split(';'))await db.sql.query(statement);
  await db.sql.query(`CREATE TABLE raw_history_live_swaps AS SELECT decode(lpad(to_hex(n%128),40,'0'),'hex') AS coin,
   '2026-10-12T00:00:00Z'::timestamptz+(n*86400.0/1830000)*interval '1 second' AS ts,n::bigint AS block,(n%1000+1)::double precision/10 AS usd FROM generate_series(1,1830000)n`);
  for(const statement of `INSERT INTO engine_block_times SELECT n,'2026-10-12T00:00:00Z'::timestamptz+(n*86400.0/1830000)*interval '1 second' FROM (SELECT (n*1830000.0/6350)::bigint AS n FROM generate_series(0,6349)n)k;
   INSERT INTO trending_snapshot_queue SELECT number FROM engine_block_times;
   INSERT INTO tokens SELECT decode(lpad(to_hex(n),40,'0'),'hex'),'Coin '||n,'C'||n,0 FROM generate_series(0,127)n`.split(';'))await db.sql.query(statement);
  expect((await db.sql.query<{n:number}>("SELECT count(*)::int AS n FROM trending_snapshot_queue q JOIN engine_block_times e ON e.number=q.created_block WHERE e.ts<$1::timestamptz+interval '1 hour'",[seal.end_ts])).rows[0]!.n).toBe(6350);
  let maxMs=0,batches=0;const started=performance.now();
  const wrap=(sql:SqlClient):SqlClient=>({query:async <T>(text:string,params?:unknown[])=>{
   const at=performance.now();const result=await sql.query<T>(text,params);const elapsed=performance.now()-at;maxMs=Math.max(maxMs,elapsed);
   if(text.startsWith('INSERT INTO trending_snapshots'))batches++;
   if(elapsed>10000 || text.startsWith('INSERT INTO trending_snapshots') && batches%25===0)process.stdout.write(JSON.stringify({event:'rankings_scale_progress',phase:text.startsWith('INSERT INTO trending_snapshots')?'snapshots':'inputs',batches,seconds:Math.round((performance.now()-started)/1000),statementSeconds:elapsed/1000})+'\n');
   return result;
  }});
  await sealRankings(new ChainDb(wrap(db.sql),work=>db.tx(tx=>work(wrap(tx.sql)))),seal);
  const size=(await db.sql.query('SELECT count(*)::int AS rows,sum(pg_column_size(data))::text AS data_bytes FROM trending_snapshots')).rows[0]!;
  console.info('rankings scale result',{...size,batches,seconds:(performance.now()-started)/1000,maxStatementSeconds:maxMs/1000});
  expect(size.rows).toBe(6350);expect(maxMs).toBeLessThan(300_000);
  expect((await db.sql.query('SELECT * FROM trending_snapshot_queue')).rows).toHaveLength(0);
 } finally {await db.close();}
},900_000);
