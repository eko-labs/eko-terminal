import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { expect, it } from 'vitest';
import { ChainDb, hex, migrate, migrateEngines, openDb, refreshBars } from '../src/index.js';
import { lockEngineWrites } from '../../../apps/engines/src/write-locks.js';

// PGlite serializes transactions within one backend; tuple-lock waits require CI's PostgreSQL.
const databaseUrl=process.env.EKO_TEST_POSTGRES_URL;
it.skipIf(!databaseUrl)('serializes reversed overlapping card and bar batches before either writer touches projections',async()=>{
 const admin=await openDb({databaseUrl}),schema=`card_bar_test_${randomUUID().replaceAll('-','')}`;
 const pool=new pg.Pool({connectionString:databaseUrl,max:3}),clients=await Promise.all([pool.connect(),pool.connect(),pool.connect()]);
 const [one,two,observer]=clients;
 const handle=(client:pg.PoolClient)=>new ChainDb(client,async work=>{
  await client.query('BEGIN');try{const result=await work(client);await client.query('COMMIT');return result;}
  catch(error){await client.query('ROLLBACK');throw error;}
 });
 let second:Promise<void>|undefined;
 try {
  await admin.sql.query(`CREATE SCHEMA ${schema}`);
  for(const c of clients){await c.query(`SET search_path TO ${schema},public`);await c.query("SET statement_timeout='5s'");}
  const cards=handle(one),bars=handle(two);await migrate(cards);await migrateEngines(cards);
  const coins=[Buffer.alloc(20,1),Buffer.alloc(20,2)],minute=new Date(Math.floor(Date.now()/60000)*60000);
  await one.query('INSERT INTO chain_blocks VALUES(1,1,$1,$1,$2)',[Buffer.alloc(32),minute]);
  await one.query("INSERT INTO tokens(address,deployer,first_block,block,decimals,launchpad) SELECT c,c,1,1,0,'other' FROM unnest($1::bytea[]) c",[coins]);
  await one.query("INSERT INTO coin_cards(id,coin,valid_from_block,hash,data) SELECT 'sample-'||encode(c,'hex'),c,1,'sample-hash','{}' FROM unnest($1::bytea[]) c",[coins]);
  await one.query("INSERT INTO coin_card_latest SELECT c,'sample-'||encode(c,'hex'),1,'{}' FROM unnest($1::bytea[]) c",[coins]);
  for(const coin of coins)await one.query(`INSERT INTO swaps(ts,block,tx_hash,log_index,venue,pool_id,coin,quote_asset,side,amount_coin,amount_quote,usd)
   VALUES($1,1,$2,0,'uniswap_v3',$3,$3,$3,1,10,10,10)`,[minute,Buffer.alloc(32,coin[0]),coin]);
  const keys=coins.map(coin=>({coin,minute}));await cards.tx(tx=>refreshBars(tx,keys));
  const pids=await Promise.all([one,two].map(async c=>(await c.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0].pid));
  await one.query('BEGIN');
  // The card batch writes high then low, while the bar batch arrives low then high.
  await lockEngineWrites(new ChainDb(one,fn=>fn(one)),[...coins].reverse().map(c=>({coin:hex(c),deployer:hex(c)})));
  await one.query("UPDATE coin_card_latest SET data='{\"verdict\":{\"level\":\"pending\"}}' WHERE coin=$1",[coins[1]]);
  second=bars.tx(tx=>refreshBars(tx,keys),{retry:true});void second.catch(()=>{});
  let waiting=false;
  for(const until=Date.now()+2000;Date.now()<until;) {
   waiting=(await observer.query<{waiting:boolean}>('SELECT $2=ANY(pg_blocking_pids($1)) waiting',[pids[1],pids[0]])).rows[0].waiting;
   if(waiting)break;await new Promise(resolve=>setTimeout(resolve,10));
  }
  expect(waiting).toBe(true);
  await one.query("UPDATE coin_card_latest SET data='{\"verdict\":{\"level\":\"pending\"}}' WHERE coin=$1",[coins[0]]);
  await one.query('COMMIT');await second;
  expect((await observer.query('SELECT coin FROM bars_1m')).rows).toHaveLength(2);
  expect((await observer.query('SELECT coin FROM read_row_series WHERE trades=1')).rows).toHaveLength(2);
 }finally{
  await one.query('ROLLBACK');await second?.catch(()=>{});
  for(const c of clients){await c.query('ROLLBACK');c.release();}
  await pool.end();await admin.sql.query(`DROP SCHEMA ${schema} CASCADE`);await admin.close();
 }
});
