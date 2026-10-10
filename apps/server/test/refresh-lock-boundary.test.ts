import { afterEach, expect, it } from 'vitest';
import { binary, ChainDb, migrate, migrateEngines, type SqlClient } from '@eko/db';
import { openDb } from '../../../packages/db/test/helpers/historical-db.js';
import { ReadStore, REFRESH_REST_MS } from '../src/read/store.js';
import { LIQUIDITY_PRICE_SQL, prepareLiquidityModels, writeLiquidityModels } from '../src/read/liquidity-model.js';

const handles:ChainDb[]=[],now=Date.parse('2026-10-17T12:00:00Z');
afterEach(async()=>{await Promise.all(handles.splice(0).map(db=>db.close()));});
async function fixture(count=1) {
  const db=await openDb({pgliteDir:':memory:'});handles.push(db);await migrate(db);await migrateEngines(db);
  await db.sql.query('INSERT INTO chain_blocks VALUES(1,1,$1,$1,to_timestamp($2))',[Buffer.alloc(32),now/1000]);
  await db.sql.query(`INSERT INTO tokens(address,deployer,first_block,block,launchpad,total_supply)
    SELECT decode(lpad(to_hex(n),40,'0'),'hex'),decode(lpad(to_hex(999),40,'0'),'hex'),1,1,'pons',10000 FROM generate_series(1,$1::int) n`,[count]);
  await db.sql.query(`INSERT INTO swaps(ts,block,tx_hash,log_index,venue,pool_id,coin,quote_asset,side,amount_coin,amount_quote,usd)
    SELECT to_timestamp($1),1,decode(lpad(to_hex(n),64,'0'),'hex'),0,'pons_curve',decode(lpad(to_hex(n),40,'0'),'hex'),
      decode(lpad(to_hex(n),40,'0'),'hex'),decode(repeat('00',20),'hex'),1,100,400,8 FROM generate_series(1,$2::int) n`,[now/1000,count]);
  return db;
}
const large=/\b(?:FROM|JOIN)\s+(?:swaps|coin_lifetime|tokens|pools|bars_1m|pons_events|coin_card_latest|engine_block_times|chain_blocks)\b/i;
it('reads and computes sources before the mutex and only writes prepared payloads afterward, including rank refreshes',async()=>{
  const db=await fixture(2),transactions:string[][]=[];
  const traced=new ChainDb(db.sql,fn=>db.tx(async tx=>{
    const calls:string[]=[];transactions.push(calls);let locked=false;
    const wrapped:SqlClient={query:async<T>(sql:string,params?:unknown[])=>{
      calls.push(sql);
      if(!sql.startsWith('SET ')) {
        expect(calls.slice(0,2)).toEqual(["SET LOCAL statement_timeout = '5s'","SET LOCAL lock_timeout = '2s'"]);
        if(locked){expect(sql).not.toMatch(large);expect(sql).not.toContain('prepare_read_models');}
      }
      if(sql.startsWith('SELECT read_lock_coins'))locked=true;
      if(locked && sql.startsWith('SELECT refresh_read_models'))expect(params).toHaveLength(3);
      return tx.sql.query<T>(sql,params);
    }};
    return fn(wrapped);
  }));
  const store=new ReadStore(traced,()=>now);
  await store.refreshModels();await store.refreshRanks();
  const source=transactions.findIndex(t=>t.includes(LIQUIDITY_PRICE_SQL));
  const writes=transactions.findIndex(t=>t.some(s=>s.startsWith('SELECT read_lock_coins')));
  expect(source).toBeGreaterThanOrEqual(0);expect(writes).toBeGreaterThan(source);
  // Include the SQL function and its feed trigger, which client-level tracing cannot see inside a function call.
  const definition=(await db.sql.query<{src:string}>("SELECT pg_get_functiondef('refresh_read_models(bytea[],bigint,jsonb)'::regprocedure) src")).rows[0].src;
  expect(definition).not.toMatch(large);
  expect((await db.sql.query('SELECT coin FROM read_coin_liquidity')).rows).toHaveLength(2);
});

it.each(['57014','55P03'])('rolls back %s timeouts, retains dirty revisions and retries smaller batches on a later tick',async code=>{
  const db=await fixture(26),initial=(await db.sql.query('SELECT coin,revision FROM read_dirty ORDER BY coin')).rows;
  let clock=now,inject=true,locks=0;
  const widths:number[]=[],probeSizes:number[]=[];
  const wrapped=(sql:SqlClient):SqlClient=>({query:async<T>(text:string,params?:unknown[])=>{
    if(text.startsWith('SELECT coin,revision FROM read_dirty'))widths.push(Number(params![1]));
    if(text===LIQUIDITY_PRICE_SQL) {
      probeSizes.push((JSON.parse(String(params![0])) as unknown[]).length);
      if(inject && code==='57014'){inject=false;throw Object.assign(new Error('statement timeout fixture'),{code});}
    }
    if(text.startsWith('SELECT read_lock_coins')) {
      locks++;
      if(inject && code==='55P03'){inject=false;throw Object.assign(new Error('lock timeout fixture'),{code});}
    }
    return sql.query<T>(text,params);
  }});
  const traced=new ChainDb(wrapped(db.sql),fn=>db.tx(tx=>fn(wrapped(tx.sql))));
  const store=new ReadStore(traced,()=>clock,{liquidityProbeKeys:8});
  await store.refreshModels();
  expect((await db.sql.query('SELECT coin,revision FROM read_dirty ORDER BY coin')).rows).toEqual(initial);
  expect((await db.sql.query('SELECT coin FROM read_coin_liquidity')).rows).toHaveLength(0);
  if(code==='57014')expect(locks).toBe(0);
  // Failed keys rest while unrelated work can proceed.
  await store.refreshModels();expect((await db.sql.query('SELECT coin FROM read_coin_liquidity')).rows).toHaveLength(1);
  clock+=REFRESH_REST_MS;probeSizes.length=0;
  await store.refreshModels();
  expect((await db.sql.query('SELECT coin FROM read_dirty')).rows).toHaveLength(0);
  expect((await db.sql.query('SELECT coin FROM read_coin_liquidity')).rows).toHaveLength(26);
  expect(widths[0]).toBe(25);expect(widths.slice(1).every(n=>n===12)).toBe(true);
  expect(probeSizes.length).toBeGreaterThan(0);expect(probeSizes.every(n=>n<=4)).toBe(true);
});

it('rejects a prepared payload superseded before its mutex is acquired',async()=>{
  const db=await fixture(),key=binary('0x0000000000000000000000000000000000000001');
  const prepared=(await db.sql.query<{p:unknown}>('SELECT prepare_read_models($1::bytea[],$2::bigint) p',[[key],now/1000])).rows[0].p;
  const liquidity=await prepareLiquidityModels(db,['0x0000000000000000000000000000000000000001'],now);
  await db.sql.query("UPDATE tokens SET symbol='UPDATED' WHERE address=$1",[key]);
  const result=await db.tx(tx=>tx.sql.query<{coins:Uint8Array[]}>('SELECT refresh_read_models($1::bytea[],$2::bigint,$3::jsonb) coins',[[key],now/1000,JSON.stringify(prepared)]));
  expect(result.rows[0].coins).toEqual([]);
  await db.tx(async tx=>{await tx.sql.query('SELECT read_lock_coins($1::bytea[])',[[key]]);await writeLiquidityModels(tx,liquidity);});
  expect((await db.sql.query('SELECT coin FROM read_coin_liquidity')).rows).toHaveLength(0);
  expect((await db.sql.query('SELECT coin FROM read_dirty')).rows).toHaveLength(1);
});

it('preserves a newer minute rank when an older prepared payload reaches the writer later',async()=>{
  const db=await fixture(),key=binary('0x0000000000000000000000000000000000000001');
  await db.sql.query('SELECT refresh_read_models($1::bytea[],$2::bigint)',[[key],now/1000]);
  const prepared=(await db.sql.query<{p:unknown}>('SELECT prepare_read_models($1::bytea[],$2::bigint) p',[[key],now/1000])).rows[0].p;
  await db.sql.query('UPDATE read_rank_clock SET window_sec=$1',[now/1000+60]);
  await db.sql.query('UPDATE read_coins SET volume=999 WHERE coin=$1',[key]);
  await db.sql.query('SELECT refresh_read_models($1::bytea[],$2::bigint,$3::jsonb)',[[key],now/1000,JSON.stringify(prepared)]);
  expect((await db.sql.query<{volume:number}>('SELECT volume FROM read_coins WHERE coin=$1',[key])).rows[0].volume).toBe(999);
});
