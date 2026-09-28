import { afterEach, expect, it } from 'vitest';
import { binary, migrate, migrateEngines, rebuildBalances, trendingAt, hex, type ChainDb } from '@eko/db';
import { openDb } from '../../../packages/db/test/helpers/historical-db.js';
import type { Address } from '@eko/shared';
import { holdingsAt } from '../src/sources.js';
import { incrementalSwaps, SWAP_PAGE_SIZE } from '../src/swap-reader.js';
import { activityRows, activitySums, partHash, revisionPart } from '../src/activity.js';
import { RULES_VERSION } from '@eko/playbooks';
import { staleRatings } from '../src/worker.js';
import { lockEngineWrites } from '../src/write-locks.js';
const coin=`0x${'1'.padStart(40,'0')}` as Address;
const epoch=Date.parse('2026-10-01T00:00:00Z');
let db:ChainDb;
afterEach(async()=>{await db?.close();});
async function fixture() {
  db=await openDb({pgliteDir:':memory:'});await migrate(db);await migrateEngines(db);await db.ensurePartitions(new Date(epoch));
  await db.sql.query(`INSERT INTO tokens(address,deployer,name,symbol,first_block,block) VALUES($1,$1,'Sample coin','DEMO',1,1)`,[binary(coin)]);
  await db.sql.query("INSERT INTO engine_block_times VALUES(1,to_timestamp($1),NULL,'activity')",[epoch/1000]);
  // More than two pages, ties at the page boundary and out-of-order timestamps.
  await db.sql.query(`INSERT INTO swaps(ts,block,tx_hash,log_index,venue,pool_id,coin,quote_asset,trader,tx_from,tx_to,side,amount_coin,amount_quote,price_quote,usd)
    SELECT to_timestamp($2::double precision+(n%17)),1+n/7,decode(lpad(to_hex(n),64,'0'),'hex'),n%7,'uniswap_v3',$1,$1,$1,$1,$1,$1,
      CASE WHEN n%2=0 THEN 1 ELSE -1 END,100,20,n::double precision,CASE WHEN n%11=0 THEN NULL ELSE 20 END
    FROM generate_series(1,4300) n`,[binary(coin),epoch/1000]);
  return db;
}
it('incremental ordered swaps equal history after append, old insert, repair, deletion and a backwards checkpoint',async()=>{
  await fixture();
  const expected=async(block:number)=>(await db.sql.query('SELECT * FROM swaps WHERE coin=$1 AND block<=$2 ORDER BY block,log_index,tx_hash,ts',[binary(coin),block])).rows;
  const raw=(rows:Awaited<ReturnType<typeof incrementalSwaps>>)=>rows.map(({traderHex:_,quoteHex:_q,poolHex:_p,txHex:_t,sec:_s,...r})=>r);
  expect(raw(await incrementalSwaps(db,coin,1000))).toEqual(await expected(1000));
  // The PK includes timestamp: a repeated order tuple at a page boundary must not be skipped.
  await db.sql.query(`INSERT INTO swaps SELECT ts+interval '4 hours',block,tx_hash,log_index,venue,pool_id,coin,quote_asset,trader,tx_from,tx_to,recipient,side,amount_coin,amount_quote,price_quote,usd,priced_block,code_version,senders_pending,pricing_pending FROM swaps ORDER BY block,log_index,tx_hash LIMIT 1 OFFSET 1999`);
  const duplicated=await incrementalSwaps(db,coin,1000);
  expect(duplicated).toHaveLength(4301);
  expect(new Set(duplicated.map(r=>`${r.ts.toISOString()}:${hex(r.tx_hash)}:${r.log_index}`)).size).toBe(4301);
  expect(raw(await incrementalSwaps(db,coin,40))).toEqual(await expected(40));
  await db.sql.query(`UPDATE swaps SET usd=30,senders_pending=true WHERE block=50`);
  expect(raw(await incrementalSwaps(db,coin,1000))).toEqual(await expected(1000));
  await db.sql.query(`INSERT INTO swaps SELECT ts+interval '1 hour',700,tx_hash,log_index,venue,pool_id,coin,quote_asset,trader,tx_from,tx_to,recipient,side,amount_coin,amount_quote,price_quote,usd,priced_block,code_version,senders_pending,pricing_pending FROM swaps WHERE block=10`);
  expect(raw(await incrementalSwaps(db,coin,1000))).toEqual(await expected(1000));
  await db.sql.query(`INSERT INTO swaps SELECT ts+interval '2 hours',20,tx_hash,log_index,venue,pool_id,coin,quote_asset,trader,tx_from,tx_to,recipient,side,amount_coin,amount_quote,price_quote,usd,priced_block,code_version,senders_pending,pricing_pending FROM swaps WHERE block=10`);
  await db.sql.query('DELETE FROM swaps WHERE block=30');
  expect(raw(await incrementalSwaps(db,coin,1000))).toEqual(await expected(1000));
  expect(SWAP_PAGE_SIZE).toBeLessThan(4300);
});
it('paged activity rows and revision sums equal the full reference across page boundaries',async()=>{
  await fixture();
  const full=await activityRows(db,1000);
  const ranged=await activityRows(db,1000,{ranges:{coins:[coin],from:[-1],to:[1000]}});
  expect(ranged).toEqual(full);
  const sum=await activitySums(db,{coins:[coin],from:[-1],to:[1000]});
  expect(sum.get(coin)!.sum).toBe(full.reduce((n,r)=>n+partHash(revisionPart(r)),0n)&((1n<<128n)-1n));
});
it('balance rollback equals transfer sums including exited, negative and self-transfer wallets and ignored deposits',async()=>{
  await fixture();
  await db.sql.query(`INSERT INTO token_transfers(ts,block,tx_hash,log_index,token,from_address,to_address,amount,kind)
    SELECT to_timestamp($2::double precision+n),n,decode(lpad(to_hex(n),64,'0'),'hex'),0,$1,
      decode(lpad(to_hex(n%5),40,'0'),'hex'),decode(lpad(to_hex((n+1)%5),40,'0'),'hex'),n*11,
      CASE WHEN n%7=0 THEN 'Deposit' ELSE 'Transfer' END FROM generate_series(1,60) n`,[binary(coin),epoch/1000]);
  await db.tx(tx=>rebuildBalances(tx));
  for(const block of [1,10,30,60]) {
    const old=(await db.sql.query(`SELECT holder,sum(amount)::text AS amount,max(block)::text AS block FROM (
      SELECT to_address AS holder,amount,block FROM token_transfers WHERE token=$1 AND block<=$2 AND kind='Transfer'
      UNION ALL SELECT from_address,-amount,block FROM token_transfers WHERE token=$1 AND block<=$2 AND kind='Transfer'
      UNION ALL SELECT holder,amount,through_block FROM transfer_baselines WHERE token=$1 AND through_block<=$2
    ) x GROUP BY holder HAVING sum(amount)>0 ORDER BY holder`,[binary(coin),block])).rows;
    expect((await holdingsAt(db,coin,block)).map(({holderHex:_,...r})=>r)).toEqual(old);
  }
});
it('locks the same coin and deployer rows on first writes, without a table lock',async()=>{
  await fixture();await db.tx(async tx=>{await lockEngineWrites(tx,[{coin,deployer:coin}]);await lockEngineWrites(tx,[{coin,deployer:coin}]);});
  expect((await db.sql.query('SELECT key FROM engine_write_locks ORDER BY key')).rows).toEqual([{key:'1-outcomes'},{key:`2-deployer:${coin}`},{key:`3-coin:${coin}`}]);
});

it('cached hourly clone ranking equals the original SQL through ties, missing identity, repairs and metadata changes',async()=>{
  await fixture();
  await db.sql.query(`INSERT INTO tokens(address,deployer,name,symbol,first_block,block)
    SELECT decode(lpad(to_hex(n),40,'0'),'hex'),$1,CASE WHEN n%11=0 THEN NULL ELSE 'Sample coin' END,'DEMO',1,1 FROM generate_series(2,75) n`,[binary(coin)]);
  await db.sql.query(`INSERT INTO swaps(ts,block,tx_hash,log_index,venue,pool_id,coin,quote_asset,trader,tx_from,tx_to,side,amount_coin,amount_quote,price_quote,usd)
    SELECT to_timestamp($2::double precision+1),1,decode(lpad(to_hex(n+10000),64,'0'),'hex'),0,'uniswap_v3',$1,
      decode(lpad(to_hex(n),40,'0'),'hex'),$1,$1,$1,$1,1,100,20,1,20 FROM generate_series(2,75) n`,[binary(coin),epoch/1000]);
  const reference=async()=> (await db.sql.query<{coin:Uint8Array;name:string;symbol:string;created:Date;started:Date;volume:number}>(`
    SELECT a.coin,t.name,t.symbol,b.ts AS created,a.started,a.volume FROM (
      SELECT coin,min(ts) AS started,sum(usd) AS volume FROM swaps WHERE block<=1000 AND ts>to_timestamp($1) AND ts<=to_timestamp($2) AND usd>0 GROUP BY coin
    ) a JOIN tokens t ON t.address=a.coin JOIN engine_block_times b ON b.number=t.first_block
    WHERE t.name IS NOT NULL AND t.symbol IS NOT NULL ORDER BY a.volume DESC,a.coin LIMIT 50`,[epoch/1000-3600,epoch/1000+10000])).rows.map(r=>({...r,coin:hex(r.coin)}));
  const read=()=>trendingAt(db,1000,epoch/1000-3600,epoch/1000+10000);
  expect(await read()).toEqual(await reference());expect(await read()).toEqual(await reference());
  await db.sql.query(`INSERT INTO swaps SELECT ts+interval '5 hours',20000,tx_hash,log_index,venue,pool_id,coin,quote_asset,trader,tx_from,tx_to,recipient,side,amount_coin,amount_quote,price_quote,usd,priced_block,code_version,senders_pending,pricing_pending FROM swaps WHERE block=10`);
  const expectedAfterAppend=await reference();
  const query=db.sql.query.bind(db.sql);let aggregates=0;
  db.sql.query=((sql:string,...params:unknown[])=>{if(sql.includes('SELECT coin,min(ts) AS started,sum(usd)'))aggregates++;return (query as (...args:unknown[])=>unknown)(sql,...params);}) as typeof db.sql.query;
  try {expect(await read()).toEqual(expectedAfterAppend);expect(aggregates).toBe(0);}finally{db.sql.query=query;}

  await db.sql.query("UPDATE tokens SET name='Changed sample' WHERE address=$1",[binary(coin)]);
  expect(await read()).toEqual(await reference());
  await db.sql.query('UPDATE swaps SET usd=100 WHERE coin=$1 AND block=2',[binary(coin)]);
  expect(await read()).toEqual(await reference());
  await db.sql.query('DELETE FROM swaps WHERE coin=$1 AND block=3',[binary(coin)]);
  expect(await read()).toEqual(await reference());
});

it('pages stale cards in global activity order, preserving skips and duplicate candidate semantics',async()=>{
  await fixture();
  await db.sql.query(`INSERT INTO tokens(address,deployer,name,symbol,first_block,block,launchpad)
    SELECT decode(lpad(to_hex(n),40,'0'),'hex'),$1,'Sample coin','DEMO',1,1,'other' FROM generate_series(2,270) n`,[binary(coin)]);
  await db.sql.query(`INSERT INTO coin_cards(id,coin,valid_from_block,hash,data,rules_version)
    SELECT 'card:'||encode(address,'hex'),address,1,'sample-hash','{"verdict":{"level":"pending"}}'::jsonb,$1 FROM tokens`,[RULES_VERSION]);
  await db.sql.query(`INSERT INTO coin_card_latest SELECT coin,id,valid_from_block,data FROM coin_cards`);
  await db.sql.query(`INSERT INTO engine_runs(coin,block,sec,price,signal,rules_version,created_at)
    SELECT address,1,1,NULL,NULL,$1,'2020-01-01' FROM tokens`,[RULES_VERSION]);
  await db.sql.query(`UPDATE read_coins SET activity=to_timestamp($1::double precision+(get_byte(coin,19)%20))`,[epoch/1000]);
  const candidates=(await db.sql.query<{address:Uint8Array}>('SELECT address FROM tokens')).rows.map(r=>hex(r.address) as Address);
  const skip=new Map([[coin,`card:${coin.slice(2)}`]]);
  const expected=(await db.sql.query<{coin:Uint8Array;card:string}>(`SELECT l.coin,l.card_id AS card FROM coin_card_latest l JOIN read_coins r ON r.coin=l.coin
    WHERE l.coin<>$1 ORDER BY r.activity DESC NULLS LAST,l.coin LIMIT 200`,[binary(coin)])).rows.map(r=>({...r,coin:hex(r.coin)}));
  expect(await staleRatings(db,[...candidates,...candidates],200,skip,'2027-01-01','2027-01-01')).toEqual(expected);
});
