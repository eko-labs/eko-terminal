import { writeFileSync } from 'node:fs';
import { expect,it } from 'vitest';
import { openDb,migrate,migrateEngines,sealRawPartition } from '../src/index.js';

it('seals the 100,000-row database fixture within the 15-minute production-day throughput budget',async()=>{
 const db=await openDb({pgliteDir:':memory:'});
 try {
  await migrate(db);await migrateEngines(db);
  const day=new Date().toISOString().slice(0,10),leaf=`swaps_d${day.replaceAll('-','_')}`;
  await db.sql.query(`INSERT INTO chain_blocks(number,block,ts,hash,parent_hash) VALUES(1,1,$1,decode(repeat('00',32),'hex'),decode(repeat('00',32),'hex'))`,[new Date(day)]);
  await db.sql.query(`INSERT INTO tokens(address,deployer,first_block,block,decimals)
   SELECT decode(lpad(to_hex(n),40,'0'),'hex'),decode(lpad(to_hex(1000),40,'0'),'hex'),1,1,0 FROM generate_series(1,354)n`);
  // Direct fixture-leaf writes avoid unrelated ingestion statement triggers. Parent indexes are real.
  await db.sql.query(`INSERT INTO ${leaf}(ts,block,tx_hash,log_index,coin,pool_id,quote_asset,trader,side,amount_coin,amount_quote,price_quote,usd,venue)
   SELECT $1::timestamptz+n*interval '0.5 second',n+1,decode(lpad(to_hex(n),64,'0'),'hex'),0,
   decode(lpad(to_hex((n-1)/283+1),40,'0'),'hex'),decode(lpad(to_hex(1000),40,'0'),'hex'),decode(repeat('00',20),'hex'),
   CASE WHEN n%7=0 THEN NULL ELSE decode(lpad(to_hex(1001+n%20),40,'0'),'hex') END,
   CASE WHEN n%3=0 THEN -1 ELSE 1 END,10,5,0.5,CASE WHEN n%11=0 THEN NULL ELSE 3 END,'uniswap_v3'
   FROM generate_series(1,100000)n`,[new Date(day)]);
  await db.sql.query(`ANALYZE ${leaf}`);
  const started=performance.now();
  const seal=await sealRawPartition(db,'swaps',leaf);
  const seconds=(performance.now()-started)/1000,projected=seconds*17;
  const report={event:'raw_seal_benchmark',database:'PGlite',rows:100000,coins:354,seconds,rowsPerSecond:100000/seconds,productionDaySeconds:projected};
  console.log(JSON.stringify(report));
  if(process.env.RAW_SEAL_BENCH_REPORT)writeFileSync(process.env.RAW_SEAL_BENCH_REPORT,JSON.stringify(report));
  expect(Number(seal.rows)).toBe(100000);
  expect((await db.sql.query<{n:number}>("SELECT sum((data->>'count')::int)::int AS n FROM coin_lifetime")).rows[0].n).toBe(100000);
  expect(projected).toBeLessThan(900);
 }finally{await db.close();}
},120000);
