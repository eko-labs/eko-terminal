import { afterEach, expect, it } from 'vitest';
import { binary, hex, migrate, migrateEngines, ChainDb, type SqlClient } from '@eko/db';
import { RULES_VERSION } from '@eko/playbooks';
import { openDb } from '../../../packages/db/test/helpers/historical-db.js';
import { activityRows } from '../src/activity.js';
import { staleRatings } from '../src/worker.js';
import { sampleAddress } from './replay-fixture.js';
const coin=sampleAddress(1),other=sampleAddress(2),epoch=Date.parse('2026-10-01T00:00:00Z')/1000;
let db:ChainDb;
afterEach(async()=>{await db?.close();});
async function fixture() {
  db=await openDb({pgliteDir:':memory:'});await migrate(db);await migrateEngines(db);await db.ensurePartitions(new Date(epoch*1000));
  await db.sql.query(`INSERT INTO tokens(address,deployer,name,symbol,launchpad,first_block,block)
    VALUES($1,$1,'Sample coin','DEMO','pons',1,1),($2,$2,'Other coin','OTHER','other',1,1)`,[binary(coin),binary(other)]);
  await db.sql.query(`INSERT INTO engine_block_times SELECT n,to_timestamp($1::double precision+n),NULL,'activity' FROM generate_series(1,600) n`,[epoch]);
  await db.sql.query(`INSERT INTO swaps(ts,block,tx_hash,log_index,venue,pool_id,coin,quote_asset,trader,tx_from,tx_to,side,amount_coin,amount_quote,price_quote,usd)
    SELECT to_timestamp($2::double precision+n),n,decode(lpad(to_hex(n),64,'0'),'hex'),0,'pons_curve',$1,$1,$1,$1,$1,$1,1,100,20,1,20
    FROM generate_series(1,600) n`,[binary(coin),epoch]);
}
const read=(from=-1,to=600)=>activityRows(db,to,{ranges:{coins:[coin],from:[from],to:[to]}});
const reference=async(from=-1,to=600)=>(await activityRows(db,to)).filter(row=>hex(row.coin)===coin && Number(row.block)>from);
it('never imports a newer cached prefix into an older repeatable-read snapshot',async()=>{
  // Two concurrent readers can finish out of snapshot order; model their visible source generations explicitly.
  let snapshot='2';
  const sql:SqlClient={query:async<T,>(text:string)=>({rows:(text.includes('FROM engine_activity_versions') ? [{revision:snapshot}]
    : text.includes('SELECT greatest(') ? [{block:'10'}] : text.includes('WITH activity AS') ? [{coin:binary(coin),block:'10',kind:'swap',
      ts:new Date(epoch*1000),low:Number(snapshot),high:Number(snapshot),price:Number(snapshot),revision:snapshot}] : []) as T[]})};
  db=new ChainDb(sql,fn=>fn(sql));
  expect((await read())[0].price).toBe(2);
  snapshot='1';expect((await read())[0].price).toBe(1);
  snapshot='2';expect((await read())[0].price).toBe(2);
});
it('reuses unchanged aggregates and re-reads only exact dirty blocks, including old edits and deletes without the optional feed',async()=>{
  await fixture();expect(await read()).toEqual(await reference());
  const query=db.sql.query.bind(db.sql),tx=db.tx.bind(db);let aggregated=0,ranges:number[][]=[];
  db.tx=fn=>tx(inner=>{
    const sql=inner.sql.query.bind(inner.sql);
    inner.sql.query=(async(text:string,params?:unknown[])=>{
      if(text.includes('WITH activity AS')){aggregated++;ranges.push(params![1] as number[]);}
      return sql(text,params);
    }) as typeof inner.sql.query;
    return fn(inner);
  });
  expect(await read()).toEqual(await reference());expect(aggregated).toBe(0);
  await query('UPDATE swaps SET usd=NULL,senders_pending=true WHERE block=10');
  await query('DELETE FROM swaps WHERE block=20');
  expect(await read()).toEqual(await reference());expect(ranges).toEqual([[9,19]]);
  aggregated=0;ranges=[];
  await query(`INSERT INTO swaps SELECT ts+interval '1 hour',700,tx_hash,log_index,venue,pool_id,coin,quote_asset,trader,tx_from,tx_to,recipient,side,amount_coin,amount_quote,price_quote,usd,priced_block,code_version,senders_pending,pricing_pending FROM swaps WHERE block=1`);
  expect(await read(-1,700)).toEqual(await reference(-1,700));expect(aggregated).toBe(1);
  expect(await read(15,40)).toEqual(await reference(15,40));
});
it('fills gaps between disjoint cached ranges and preserves multiple pair rows at one block',async()=>{
  await fixture();
  expect(await read(10,20)).toEqual(await reference(10,20));
  expect(await read(400,500)).toEqual(await reference(400,500));
  expect(await read(5,550)).toEqual(await reference(5,550));
  await db.sql.query(`INSERT INTO pools(id,venue,currency0,currency1,fee,tick_spacing,created_block,block)
    VALUES($1,'uniswap_v3',$3,$4,3000,60,30,30),($2,'uniswap_v3',$3,$4,3000,60,30,30)`,
  [binary(sampleAddress(50)),binary(sampleAddress(51)),binary(coin),binary(other)]);
  expect(await read()).toEqual(await reference());
  expect((await read()).filter(row=>row.kind==='pair')).toHaveLength(2);
  await db.sql.query('DELETE FROM pools WHERE id=$1',[binary(sampleAddress(50))]);
  expect(await read()).toEqual(await reference());
});
it('invalidates Pons rows when clocks arrive/change and invalidates raw rows on sealing and unsealing',async()=>{
  await fixture();await read();
  await db.sql.query(`INSERT INTO pons_events VALUES(700,decode(repeat('ab',32),'hex'),0,$1,$1,'sample','{}','indexer-v1')`,[binary(coin)]);
  expect(await read(-1,700)).toEqual(await reference(-1,700));
  await db.sql.query(`INSERT INTO engine_block_times VALUES(700,to_timestamp($1),NULL,'activity')`,[epoch+700]);
  expect(await read(-1,700)).toEqual(await reference(-1,700));
  await db.sql.query(`UPDATE engine_block_times SET ts=ts+interval '1 second' WHERE number=700`);
  expect(await read(-1,700)).toEqual(await reference(-1,700));
  await db.sql.query(`INSERT INTO raw_history_seals(name,partition_name,start_ts,end_ts,sealed,rows,through_block)
    VALUES('swaps','fixture-day',to_timestamp($1),to_timestamp($1+86400),true,600,600)`,[epoch]);
  expect(await read(-1,700)).toEqual(await reference(-1,700));
  await db.sql.query(`DELETE FROM raw_history_seals WHERE partition_name='fixture-day'`);
  expect(await read(-1,700)).toEqual(await reference(-1,700));
  await db.sql.query(`INSERT INTO raw_history_seals(name,partition_name,start_ts,end_ts,sealed,rows,through_block)
    VALUES('swaps','fixture-day',to_timestamp($1),to_timestamp($1+86400),false,600,600)`,[epoch]);
  await db.sql.query(`INSERT INTO raw_history_seal_days(name,partition_name,day,end_ts,last_coin)
    VALUES('swaps','fixture-day',to_timestamp($1),to_timestamp($1+86400),NULL)`,[epoch]);
  await db.sql.query(`UPDATE raw_history_seal_days SET last_coin=$1`,[binary(coin)]);
  expect(await read(-1,700)).toEqual(await reference(-1,700));
  const version=(await db.sql.query('SELECT revision FROM engine_activity_versions WHERE coin=$1',[binary(coin)])).rows;
  await db.sql.query('UPDATE raw_history_seal_days SET rows=1');
  expect((await db.sql.query('SELECT revision FROM engine_activity_versions WHERE coin=$1',[binary(coin)])).rows).toEqual(version);
  await db.sql.query('UPDATE raw_history_seal_days SET last_coin=NULL');
  expect(await read(-1,700)).toEqual(await reference(-1,700));
});
it('invalidates cached candidate decisions on pricing, sell results, card/run edits and token changes',async()=>{
  await fixture();
  await db.sql.query(`INSERT INTO coin_cards(id,coin,valid_from_block,hash,data,rules_version)
    VALUES('sample-card',$1,1,'sample','{"verdict":{"level":"pending","evaluatedPlaybooks":["bundle_dump","holder_concentration","dev_dump","run_up"]}}',$2)`,[binary(coin),RULES_VERSION]);
  await db.sql.query('INSERT INTO coin_card_latest SELECT coin,id,valid_from_block,data FROM coin_cards');
  await db.sql.query(`INSERT INTO engine_runs(coin,block,sec,rules_version,created_at) VALUES($1,1,$2,$3,'2026-10-16')`,[binary(coin),epoch,RULES_VERSION]);
  const check=()=>staleRatings(db,[coin],10,new Map(),'2026-10-01');
  expect(await check()).toEqual([{coin,card:'sample-card'}]);
  await db.sql.query('UPDATE swaps SET usd=NULL WHERE block=10');
  expect(await check()).toEqual([]);expect(await check()).toEqual([]);
  await db.sql.query('UPDATE swaps SET usd=20 WHERE block=10');
  expect(await check()).toEqual([{coin,card:'sample-card'}]);
  await db.sql.query(`UPDATE tokens SET launchpad='other' WHERE address=$1`,[binary(coin)]);
  expect(await check()).toEqual([]);
  await db.sql.query(`INSERT INTO sell_check_runs(coin,block,checked_at,status,requests,data) VALUES($1,20,now(),'sellable',1,'{}')`,[binary(coin)]);
  expect(await check()).toEqual([{coin,card:'sample-card'}]);
  await db.sql.query('DELETE FROM sell_check_runs');expect(await check()).toEqual([]);
  await db.sql.query(`UPDATE engine_runs SET created_at='2020-01-01'`);
  expect(await check()).toEqual([{coin,card:'sample-card'}]);
  await db.sql.query(`UPDATE coin_card_latest SET data='{"verdict":{"level":"clear","evaluatedPlaybooks":["bundle_dump","holder_concentration","dev_dump","run_up"]}}'`);
  expect(await check()).toEqual([]);
  await db.sql.query('DELETE FROM coin_card_latest');expect(await check()).toEqual([]);
});
