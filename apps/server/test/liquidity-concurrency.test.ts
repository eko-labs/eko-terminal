import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { expect, it } from 'vitest';
import { ChainDb, migrate, migrateEngines, openDb, hex } from '@eko/db';
import { prepareLiquidityModels, writeLiquidityModels, refreshLiquidityModels } from '../src/read/liquidity-model.js';

// Independent PostgreSQL backends are required to observe tuple-lock waits and detect real deadlocks.
const databaseUrl=process.env.EKO_TEST_POSTGRES_URL;
it.skipIf(!databaseUrl)('serializes overlapping model and liquidity refreshes, including reversed standalone liquidity batches',async()=>{
  const admin=await openDb({databaseUrl}),schema=`liquidity_test_${randomUUID().replaceAll('-','')}`;
  const pool=new pg.Pool({connectionString:databaseUrl,max:3});
  const clients=await Promise.all([pool.connect(),pool.connect(),pool.connect()]);
  const [one,two,observer]=clients;
  const handle=(client:pg.PoolClient)=>new ChainDb(client,async work=>{
    await client.query('BEGIN');
    try{const result=await work(client);await client.query('COMMIT');return result;}
    catch(error){await client.query('ROLLBACK');throw error;}
  });
  try {
    await admin.sql.query(`CREATE SCHEMA ${schema}`);
    for(const c of clients)await c.query(`SET search_path TO ${schema},public`);
    const db=handle(one);await migrate(db);await migrateEngines(db);
    const coins=[1,2,3].map(n=>Buffer.alloc(20,n)),now=Date.now();
    await one.query('INSERT INTO chain_blocks VALUES(1,1,$1,$1,now())',[Buffer.alloc(32)]);
    await one.query("INSERT INTO tokens(address,deployer,first_block,block,launchpad) SELECT c,c,1,1,'other' FROM unnest($1::bytea[]) c",[coins]);
    await one.query("INSERT INTO coin_cards(id,coin,valid_from_block,hash,data) SELECT 'sample-'||encode(c,'hex'),c,1,'sample-hash','{}' FROM unnest($1::bytea[]) c",[coins]);
    const pids=await Promise.all([one,two].map(async c=>(await c.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0].pid));
    for(const standalone of [false,true]) {
      for(const c of [one,two]){await c.query("SET statement_timeout='5s'");await c.query('BEGIN');}
      const prepare=async(client:pg.PoolClient,keys:Buffer[])=>({
        models:(await client.query<{data:unknown}>('SELECT prepare_read_models($1::bytea[],0) data',[keys])).rows[0].data,
        liquidity:await prepareLiquidityModels(new ChainDb(client,fn=>fn(client)),keys.map(hex),now),
      });
      const firstPayload=await prepare(one,[coins[0],coins[1]]),secondPayload=standalone ? null : await prepare(two,[coins[2],coins[1],coins[0]]);
      // Hold the lowest mutex before launching the reversed overlap. The observer must see an actual wait.
      await one.query('SELECT read_lock_coins($1::bytea[])',[[coins[0],coins[1]]]);
      const second=(async()=>{
        if(standalone)await refreshLiquidityModels(new ChainDb(two,fn=>fn(two)),[coins[2],coins[1],coins[0]].map(hex),now);
        else {
          await two.query('SELECT read_lock_coins($1::bytea[])',[[coins[2],coins[1],coins[0]]]);
          await two.query('SELECT refresh_read_models($1::bytea[],0,$2::jsonb)',[[coins[2],coins[1],coins[0]],JSON.stringify(secondPayload!.models)]);
          await writeLiquidityModels(new ChainDb(two,fn=>fn(two)),secondPayload!.liquidity);
        }
        await two.query('COMMIT');
      })();
      void second.catch(()=>{});
      let waiting=false;
      for(const until=Date.now()+2000;Date.now()<until;) {
        waiting=(await observer.query<{waiting:boolean}>('SELECT $2=ANY(pg_blocking_pids($1)) waiting',[pids[1],pids[0]])).rows[0].waiting;
        if(waiting)break;
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      expect(waiting).toBe(true);
      await one.query('SELECT refresh_read_models($1::bytea[],0,$2::jsonb)',[[coins[1],coins[0]],JSON.stringify(firstPayload.models)]);
      await writeLiquidityModels(new ChainDb(one,fn=>fn(one)),firstPayload.liquidity);
      await one.query('COMMIT');await second;
      expect((await observer.query('SELECT coin FROM read_coin_liquidity')).rows).toHaveLength(3);
    }
    await one.query('BEGIN');await two.query('BEGIN');
    const models=(await one.query<{data:unknown}>('SELECT prepare_read_models($1::bytea[],0) data',[coins])).rows[0].data;
    const liquidity=await prepareLiquidityModels(new ChainDb(one,fn=>fn(one)),coins.map(hex),now);
    await one.query('SELECT read_lock_coins($1::bytea[])',[coins]);
    // Contended source writes skip synchronous projection and enqueue work without waiting for mutexes.
    await two.query("SET LOCAL lock_timeout='200ms'");
    await two.query("INSERT INTO coin_card_latest SELECT c,'sample-'||encode(c,'hex'),1,'{}' FROM unnest($1::bytea[]) c",[[...coins].reverse()]);
    await one.query('SELECT refresh_read_models($1::bytea[],0,$2::jsonb)',[coins,JSON.stringify(models)]);
    await writeLiquidityModels(new ChainDb(one,fn=>fn(one)),liquidity);
    await one.query('COMMIT');await two.query('COMMIT');
    // With the mutex available, a card edit immediately updates the compact projection used by engines.
    await two.query("UPDATE coin_card_latest SET data='{\"verdict\":{\"level\":\"clear\"}}'");
    expect((await observer.query('SELECT tier FROM read_coins ORDER BY coin')).rows).toEqual([{tier:0},{tier:0},{tier:0}]);
    expect((await observer.query('SELECT coin FROM read_dirty')).rows).toHaveLength(3);
  } finally {
    for(const c of clients){await c.query('ROLLBACK');c.release();}
    await pool.end();await admin.sql.query(`DROP SCHEMA ${schema} CASCADE`);await admin.close();
  }
});
