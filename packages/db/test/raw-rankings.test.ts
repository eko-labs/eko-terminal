import { afterEach, expect, it } from 'vitest';
import { ChainDb, type SqlClient, migrate, migrateEngines } from '../src/index.js';
import { sealRankings, sealRawPartition, type RawSeal } from '../src/raw-partitions.js';
import { openDb } from './helpers/historical-db.js';
let db:ChainDb;
afterEach(async()=>{await db?.close();});
const day=new Date('2026-10-12T00:00:00Z');
const seal:RawSeal={name:'swaps',partition_name:'swaps_d2026_10_12',start_ts:day,end_ts:new Date(+day+86400000),rows:'0',through_block:'-1',sealed:false,dropped:false};
async function fixture() {
  db=await openDb({pgliteDir:':memory:'});await migrate(db);await migrateEngines(db);await db.ensurePartitions(day);
  await db.sql.query(`INSERT INTO chain_blocks(number,block,ts,hash,parent_hash)
    SELECT n,n,$1::timestamptz+(n-2)*interval '90 seconds',decode(lpad(to_hex(n),64,'0'),'hex'),decode(repeat('00',32),'hex') FROM generate_series(1,76)n`,[day]);
  await db.sql.query("INSERT INTO engine_block_times SELECT number,ts,hash,'head' FROM chain_blocks");
  await db.sql.query(`INSERT INTO tokens(address,first_block,block,name,symbol,decimals)
    SELECT decode(lpad(to_hex(n),40,'0'),'hex'),1,1,CASE WHEN n<56 THEN 'Coin '||n END,'C'||n,0 FROM generate_series(1,56)n`);
  await db.sql.query('INSERT INTO trending_snapshot_queue SELECT number FROM chain_blocks ON CONFLICT DO NOTHING');
  // Several coins tie around rank 50; fractional USD exposes regrouped floating-point sums.
  // The first/last partial minutes, the exact lower/upper boundaries and future blocks all matter.
  await db.sql.query(`INSERT INTO swaps(ts,block,tx_hash,log_index,coin,pool_id,quote_asset,side,amount_coin,amount_quote,price_quote,usd,venue)
    SELECT $1::timestamptz+n*interval '37 seconds',CASE WHEN n%17=0 THEN 90 ELSE greatest(1,n/3) END,
      decode(lpad(to_hex(n*100+c),64,'0'),'hex'),0,decode(lpad(to_hex(c),40,'0'),'hex'),decode(repeat('aa',20),'hex'),decode(repeat('bb',20),'hex'),1,1,1,1,
      CASE WHEN n%11=0 THEN NULL WHEN n%13=0 THEN 0 ELSE (CASE c%4 WHEN 0 THEN 0.1 WHEN 1 THEN 0.2 WHEN 2 THEN 1000000.01 ELSE 0.00001 END) END,'uniswap_v3'
    FROM generate_series(0,290)n CROSS JOIN generate_series(1,56)c`,[new Date(+day-3600000)]);
}
async function oldSnapshots() {
  return (await db.sql.query<{created_block:string;data:unknown}>(`SELECT q.created_block,coalesce(jsonb_agg(x.data ORDER BY x.volume DESC,x.coin) FILTER(WHERE x.coin IS NOT NULL),'[]') AS data
    FROM (SELECT q.created_block,coalesce(e.ts,c.ts) AS ts FROM trending_snapshot_queue q
      LEFT JOIN engine_block_times e ON e.number=q.created_block LEFT JOIN chain_blocks c ON c.number=q.created_block WHERE coalesce(e.ts,c.ts)<$1::timestamptz+interval '1 hour')q
    LEFT JOIN LATERAL(
      SELECT v.coin,v.volume,jsonb_build_object('coin','0x'||encode(v.coin,'hex'),'name',t.name,'symbol',t.symbol,
        'created',to_char(e.ts AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'started',to_char(v.started AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'volume',v.volume::text) AS data
      FROM (SELECT coin,min(ts) AS started,sum(usd) AS volume FROM raw_history_live_swaps WHERE block<=q.created_block AND ts>q.ts-interval '1 hour' AND ts<=q.ts+interval '1 second' AND usd>0 GROUP BY coin)v
      JOIN tokens t ON t.address=v.coin JOIN engine_block_times e ON e.number=t.first_block WHERE t.name IS NOT NULL AND t.symbol IS NOT NULL ORDER BY v.volume DESC,v.coin LIMIT 50
    )x ON true GROUP BY q.created_block ORDER BY q.created_block`,[seal.end_ts])).rows;
}
it('matches every field, order and volume text of the original ranking over overlapping hours',async()=>{
  await fixture();const expected=await oldSnapshots();
  await sealRankings(db,seal);
  expect((await db.sql.query('SELECT created_block,data FROM trending_snapshots ORDER BY created_block')).rows).toEqual(expected);
  expect((await db.sql.query('SELECT * FROM trending_snapshot_queue')).rows).toEqual([]);
});
it('commits bounded snapshots with queue deletions and resumes before any coin batch is folded',async()=>{
  await fixture();const expected=await oldSnapshots();let batches=0,liveScans=0;
  await db.sql.query('UPDATE tokens SET deployer=address WHERE address=$1',[Buffer.from('1'.padStart(40,'0'),'hex')]);
  await db.sql.query('DELETE FROM engine_block_times WHERE number=1');
  const wrap=(sql:SqlClient):SqlClient=>({query:async <T>(text:string,params?:unknown[])=>{
    if(text.startsWith('CREATE TEMP TABLE raw_seal_ranking_rows'))liveScans++;
    if(text.startsWith('INSERT INTO trending_snapshots') && ++batches===2)throw Object.assign(new Error('fixture timeout'),{code:'57014'});
    return sql.query<T>(text,params);
  }});
  const handle=new ChainDb(wrap(db.sql),work=>db.tx(tx=>work(wrap(tx.sql))));
  await expect(sealRawPartition(handle,'swaps',seal.partition_name)).rejects.toMatchObject({code:'57014'});
  expect((await db.sql.query('SELECT * FROM trending_snapshots')).rows).toHaveLength(32);
  expect((await db.sql.query('SELECT * FROM trending_snapshot_queue')).rows).toHaveLength(44);
  expect((await db.sql.query('SELECT coins FROM raw_history_seal_days')).rows.every(r=>Number(r.coins)===0)).toBe(true);
  expect((await db.sql.query('SELECT * FROM coin_lifetime')).rows).toHaveLength(0);
  // Retry only the unfinished queue; committed data is immutable and the full live day still exists.
  await sealRankings(handle,seal);
  expect(liveScans).toBe(2);
  expect((await db.sql.query('SELECT created_block,data FROM trending_snapshots ORDER BY created_block')).rows).toEqual(expected);
  expect((await db.sql.query('SELECT * FROM trending_snapshot_queue')).rows).toHaveLength(0);
  expect((await db.sql.query("SELECT relname FROM pg_class WHERE relnamespace=pg_my_temp_schema() AND relname LIKE 'raw_seal_ranking%'")).rows).toHaveLength(0);
});
