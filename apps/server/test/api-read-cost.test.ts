import { afterEach, expect, it } from 'vitest';
import { binary, ChainDb, migrate, migrateEngines, type SqlClient } from '@eko/db';
import { openDb } from '../../../packages/db/test/helpers/historical-db.js';
import { ReadStore } from '../src/read/store.js';
import { FeedService } from '../src/read/feed.js';
import { RadarService } from '../src/read/radar.js';
import { sampleAddress } from './read-fixture.js';
import { BaselineRows } from './radar-row-baseline.js';

const now=Date.parse('2026-10-14T12:00:00Z'),sec=now/1000;
const coin=sampleAddress(100),sparse=sampleAddress(101);
const handles:ChainDb[]=[];
afterEach(async()=>{await Promise.all(handles.splice(0).map(db=>db.close()));});
async function fixture() {
  const db=await openDb({pgliteDir:':memory:'});handles.push(db);
  await migrate(db);await migrateEngines(db);
  await db.ensurePartitions(new Date(now-40*86400000));await db.ensurePartitions(new Date(now));
  await db.sql.query(`INSERT INTO tokens(address,deployer,name,symbol,launchpad,first_block,block,decimals,total_supply)
    SELECT unnest($1::bytea[]),$2,'Sample coin','DEMO','pons',1,1,18,1e27`,[[coin,sparse].map(binary),binary(sampleAddress(99))]);
  await db.sql.query('INSERT INTO chain_blocks(number,block,hash,parent_hash,ts) VALUES(1,1,$1,$1,$2)',[binary(`0x${'00'.repeat(32)}`),new Date(now-40*86400000)]);
  return db;
}
function traced(db:ChainDb,record:(sql:string,params:unknown[])=>void) {
  const wrap=(sql:SqlClient):SqlClient=>({query:async<T>(text:string,params?:unknown[])=>{record(text,params ?? []);return sql.query<T>(text,params);}});
  return new ChainDb(wrap(db.sql),fn=>db.tx(tx=>fn(wrap(tx.sql))));
}
const legacyMarket=`    ), market AS (
      SELECT b.coin,(array_agg(close ORDER BY minute DESC))[1] AS price,
        (array_agg(close ORDER BY minute DESC) FILTER(WHERE minute<=to_timestamp($1::double precision-3600)))[1] AS previous1h,
        (array_agg(close ORDER BY minute DESC) FILTER(WHERE minute<=to_timestamp($1::double precision-86400)))[1] AS previous24h,
        coalesce(sum(volume_usd) FILTER(WHERE minute>=to_timestamp($1::double precision-3600)),0) AS volume,
        coalesce(sum(trades) FILTER(WHERE minute>=to_timestamp($1::double precision-3600)),0) AS trades,
        coalesce(sum(volume_usd) FILTER(WHERE minute>=to_timestamp($1::double precision-86400) AND minute<to_timestamp($1::double precision-3600)),0) AS prior_volume,
        min(minute) AS first_minute FROM bars_1m b WHERE b.coin=ANY($2::bytea[]) GROUP BY b.coin
`;
it('matches whole-history market values, including sparse prices, first minute, future bars and sparks, with bounded work',async()=>{
  const db=await fixture();
  await db.sql.query(`INSERT INTO bars_1m SELECT $1,to_timestamp($2::double precision-n*60),n,n,n,n,n,1,n,n FROM generate_series(0,40000) n`,[binary(coin),sec]);
  await db.sql.query(`INSERT INTO bars_1m SELECT $1,to_timestamp($2::double precision+d),p,p,p,p,5,2,1,1 FROM (VALUES(-300000,2),(-100000,3),(-60,4),(60,5)) v(d,p)`,[binary(sparse),sec]);
  await db.sql.query('ANALYZE bars_1m');
  let sql='',params:unknown[]=[],oldSql='',oldParams:unknown[]=[];
  const store=new ReadStore(traced(db,(text,values)=>{if(text.startsWith('SELECT t.*,coalesce(v.revision')){sql=text;params=values;}}),()=>now);
  const baseline=new BaselineRows(traced(db,(text,values)=>{if(text.startsWith('WITH selected AS')){oldSql=text;oldParams=values;}}),()=>now);
  const actual=await store.rows(undefined,[coin,sparse]),expected=await baseline.rows(undefined,[coin,sparse]);
  expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
  const begin=oldSql.indexOf('    ), market AS ('),end=oldSql.indexOf('    ), span AS ');
  const legacy=oldSql.slice(0,begin)+legacyMarket+oldSql.slice(end);
  expect((await db.sql.query(oldSql,oldParams)).rows).toEqual((await db.sql.query(legacy,oldParams)).rows);
  const marketKeys=['address','price','previous1h','previous24h','volume','trades','prior_volume','first_minute','spark'];
  const market=(rows:Record<string,unknown>[])=>rows.map(r=>Object.fromEntries(marketKeys.map(k=>[k,r[k]])));
  expect(market((await db.sql.query(sql,params)).rows)).toEqual(market((await db.sql.query(legacy,oldParams)).rows));
  const explain=async(text:string,values:unknown[])=>(await db.sql.query<{ 'QUERY PLAN':{ 'Execution Time':number;Plan:unknown }[] }>('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+text,values)).rows[0]['QUERY PLAN'][0];
  const before=await explain(legacy,oldParams),after=await explain(sql,params);
  console.info('market benchmark',JSON.stringify({historyBars:40005,windowBars:1444,beforeMs:before['Execution Time'],afterMs:after['Execution Time']}));
  // Warm row reads use the maintained projection, including sparse, old and future prices, with zero bar scans/sorts.
  const nodes=(node:unknown):Record<string,unknown>[]=>{const n=node as Record<string,unknown>;return [n,...((n.Plans ?? []) as unknown[]).flatMap(nodes)];};
  expect(nodes(after.Plan).filter(n=>String(n['Relation Name']).startsWith('bars_1m_'))).toEqual([]);
  expect(nodes(after.Plan).filter(n=>n['Node Type']==='Sort')).toEqual([]);
});

it('matches complete hourly rank recomputation on minute rolls, corrections, gaps and a backwards clock',async()=>{
  const db=await fixture();let clock=now;
  const store=new ReadStore(db,()=>clock);
  for(const [c,offset,volume] of [[coin,-3600,7],[coin,-3540,11],[coin,0,13],[coin,60,17],[sparse,-3540,23]] as const)
    await db.sql.query('INSERT INTO bars_1m VALUES($1,to_timestamp($2),1,1,1,1,$3,1,1,1)',[binary(c),sec+offset,volume]);
  const same=async()=>{
    await store.refreshRanks();
    const expected=(await db.sql.query(`SELECT r.coin,CASE WHEN r.pricing_pending THEN 0 ELSE coalesce(b.volume,0) END AS volume FROM read_coins r
      LEFT JOIN (SELECT coin,sum(volume_usd) AS volume FROM bars_1m WHERE minute>=to_timestamp($1::double precision-3540) AND minute<=to_timestamp($1::double precision) GROUP BY coin) b ON b.coin=r.coin ORDER BY r.coin`,[Math.floor(clock/60000)*60])).rows;
    expect((await db.sql.query('SELECT coin,volume FROM read_coins ORDER BY coin')).rows).toEqual(expected);
  };
  await same();clock+=60000;await same();
  await db.sql.query('UPDATE bars_1m SET volume_usd=31 WHERE coin=$1 AND minute=to_timestamp($2)',[binary(coin),sec]);await same();
  clock+=3*3600000;await same();clock=now;await same();
});
it('matches unbounded Feed ordering and pagination for mixed sources, filters and tied blocks',async()=>{
  const db=await fixture(),store=new ReadStore(db,()=>now);await store.refreshModels();
  await db.sql.query(`INSERT INTO chain_blocks(number,block,hash,parent_hash,ts) SELECT n,n,decode(lpad(to_hex(n),64,'0'),'hex'),decode(lpad(to_hex(n-1),64,'0'),'hex'),to_timestamp($1::double precision-400+n) FROM generate_series(2,400) n`,[sec]);
  await db.sql.query(`INSERT INTO read_feed(id,coin,block,kind,data) SELECT 'sample:'||n,$1,n,'verdict','{}' FROM generate_series(2,300) n`,[binary(coin)]);
  await db.sql.query(`INSERT INTO swaps(ts,block,tx_hash,log_index,venue,pool_id,coin,quote_asset,trader,recipient,side,amount_coin,amount_quote,usd)
    SELECT to_timestamp($2::double precision-400+n),n,decode(lpad(to_hex(n),64,'0'),'hex'),n%3,'pons_curve',$1,$1,$1,$1,$1,1,1e18,1,CASE WHEN n%5=0 THEN 499 ELSE 500 END FROM generate_series(2,350) n`,[binary(coin),sec]);
  let sql='',params:unknown[]=[];
  const feed=new FeedService(new ReadStore(traced(db,(text,values)=>{if(text.includes(') candidates ORDER BY')){sql=text;params=values;}}),()=>now));
  const same=async(kinds?:('trade'|'verdict')[],cursor?:string)=>{
    const page=await feed.list(kinds,cursor);
    const unbounded=sql.replaceAll('ORDER BY block DESC,id DESC LIMIT 101)',')');
    expect((await db.sql.query(sql,params)).rows).toEqual((await db.sql.query(unbounded,params)).rows);
    return page;
  };
  for(const kinds of [undefined,['verdict'],['trade'],['trade','verdict']] as const) {
    const first=await same(kinds ? [...kinds] : undefined);expect(first.rows).toHaveLength(100);expect(first.cursor).not.toBeNull();
    await same(kinds ? [...kinds] : undefined,first.cursor!);
  }
  await feed.all(['trade'],coin,300);
  expect((await db.sql.query(sql,params)).rows).toEqual((await db.sql.query(sql.replaceAll('ORDER BY block DESC,id DESC LIMIT 101)',')'),params)).rows);
});
it('reconciles only rewritten buyer keys and never takes a projection table lock',async()=>{
  const db=await fixture();
  await db.sql.query(`INSERT INTO swaps(ts,block,tx_hash,log_index,venue,pool_id,coin,quote_asset,trader,side,amount_coin,amount_quote,usd)
    SELECT to_timestamp($2::double precision-100+n),n,decode(lpad(to_hex(n),64,'0'),'hex'),0,'pons_curve',$1,$1,$1,decode(lpad(to_hex(1000+n),40,'0'),'hex'),1,1e18,1,10 FROM generate_series(2,50) n`,[binary(coin),sec]);
  const statements:string[]=[];const store=new ReadStore(traced(db,text=>statements.push(text)),()=>now);await store.refreshModels();
  expect(statements.some(s=>/LOCK TABLE read_(feed|coins)/.test(s))).toBe(false);
  // An unaffected missing pair stays missing. Updating one buyer no longer repairs every buyer in the coin's history.
  await db.sql.query('DELETE FROM read_buyers WHERE coin=$1 AND trader=$2',[binary(coin),binary(sampleAddress(1002))]);
  await db.sql.query('UPDATE swaps SET trader=$2 WHERE coin=$1 AND block=50',[binary(coin),binary(sampleAddress(2000))]);
  expect((await db.sql.query('SELECT count(*)::int AS n FROM read_buyer_dirty WHERE coin=$1',[binary(coin)])).rows[0]).toEqual({n:2});
  await store.refreshModels();
  expect((await db.sql.query('SELECT buyers::int AS n FROM read_coins WHERE coin=$1',[binary(coin)])).rows[0]).toEqual({n:48});
  expect((await db.sql.query('SELECT 1 FROM read_buyers WHERE coin=$1 AND trader=$2',[binary(coin),binary(sampleAddress(1002))])).rows).toEqual([]);
  expect((await db.sql.query('SELECT 1 FROM read_buyer_dirty WHERE coin=$1',[binary(coin)])).rows).toEqual([]);
});

it('keeps pool-position sums identical to event history through updates, deletions and null amounts',async()=>{
  const db=await fixture(),pool=binary(sampleAddress(800));
  await db.sql.query(`INSERT INTO liquidity_events(block,tx_hash,log_index,ts,venue,pool_id,kind,data)
    SELECT n,decode(lpad(to_hex(n),64,'0'),'hex'),0,to_timestamp(1791979200),'uniswap_v3',$1,CASE WHEN n%3=0 THEN 'Mint' WHEN n%3=1 THEN 'Burn' ELSE 'ModifyLiquidity' END,
      jsonb_build_object('tickLower',-100*(n%5),'tickUpper',100*(n%5),'amount',CASE WHEN n%17=0 THEN NULL ELSE n::text END,'liquidityDelta',n::text)
    FROM generate_series(1,1000) n`,[pool]);
  const same=async()=>{
    const actual=(await db.sql.query(`SELECT pool_id,kind,lower_tick,upper_tick,liquidity,n,n_amount FROM read_pool_positions WHERE n>0 ORDER BY 1,2,3,4`)).rows;
    const expected=(await db.sql.query(`SELECT pool_id,kind,coalesce(data->>'tickLower','') AS lower_tick,coalesce(data->>'tickUpper','') AS upper_tick,
      coalesce(sum(amount),0) AS liquidity,count(*) AS n,count(amount) AS n_amount FROM (
      SELECT e.*,CASE WHEN kind='Mint' THEN (data->>'amount')::numeric WHEN kind='Burn' THEN -(data->>'amount')::numeric ELSE (data->>'liquidityDelta')::numeric END AS amount
      FROM liquidity_events e WHERE kind IN ('Mint','Burn','ModifyLiquidity') AND data ? 'tickLower' AND data ? 'tickUpper') s GROUP BY 1,2,3,4 ORDER BY 1,2,3,4`)).rows;
    expect(actual).toEqual(expected);
  };
  await same();
  await db.sql.query(`UPDATE liquidity_events SET pool_id=$1,kind='ModifyLiquidity',data='{"tickLower":-887200,"tickUpper":887200,"liquidityDelta":"-25"}' WHERE block%7=0`,[binary(sampleAddress(801))]);await same();
  await db.sql.query('DELETE FROM liquidity_events WHERE block>500');await same();
  await db.sql.query('TRUNCATE liquidity_events');await same();
});
it('reads only the spark window of an old coin and preserves the latest 96 trade points',async()=>{
  const db=await fixture();
  // Keep cold rows in the same UTC partition: a tiny pruned daily leaf may correctly use a sequential scan.
  await db.sql.query(`INSERT INTO swaps(ts,block,tx_hash,log_index,venue,pool_id,coin,quote_asset,trader,side,amount_coin,amount_quote,usd)
    SELECT to_timestamp($2::double precision+CASE WHEN n<=20000 THEN -43200+n/10.0 ELSE -20150+n END),n,decode(lpad(to_hex(n),64,'0'),'hex'),0,'pons_curve',$1,$1,$1,$1,1,1e18,1,n FROM generate_series(1,20150) n`,[binary(coin),sec]);
  await db.sql.query('ANALYZE swaps');let sql='',params:unknown[]=[];
  const store=new ReadStore(traced(db,(text,p)=>{if(text.includes('WITH candidates AS MATERIALIZED')){sql=text;params=p;}}),()=>now);
  const rows=await store.rows(coin);
  const points=(await db.sql.query<{points:number[]}>(`SELECT array_agg(usd ORDER BY block,log_index) AS points FROM (
    SELECT usd,block,log_index FROM swaps WHERE coin=$1 AND ts>to_timestamp($2::double precision-28800) AND ts<=to_timestamp($2::double precision)
    AND usd>0 AND amount_coin>0 ORDER BY block DESC,log_index DESC LIMIT 96) s`,[binary(coin),sec])).rows[0].points;
  expect(rows[0].row.spark8h).toEqual(points);
  const result=(await db.sql.query<{ 'QUERY PLAN':{Plan:unknown}[] }>('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+sql,params)).rows[0]['QUERY PLAN'][0];
  const nodes=(node:unknown):Record<string,unknown>[]=>{const n=node as Record<string,unknown>;return [n,...((n.Plans ?? []) as unknown[]).flatMap(nodes)];};
  const scans=nodes(result.Plan).filter(n=>String(n['Relation Name']).startsWith('swaps_'));
  expect(scans.length).toBeGreaterThan(0);
  for(const scan of scans) {
    expect(scan['Node Type']).toMatch(/Index/);expect(String(scan['Index Cond'])).toContain('ts >');
    expect(Number(scan['Actual Rows'])).toBeLessThanOrEqual(150);
  }
});

it('serves a 100-coin Radar page from a windowed 288000-bar fixture without adding cache staleness',async()=>{
  const db=await fixture();
  await db.sql.query(`INSERT INTO tokens(address,deployer,name,symbol,launchpad,first_block,block,decimals,total_supply)
    SELECT decode(lpad(to_hex(200+n),40,'0'),'hex'),$1,'Sample coin','DEMO','pons',1,1,18,1e27 FROM generate_series(1,100) n`,[binary(sampleAddress(99))]);
  await db.sql.query(`INSERT INTO bars_1m SELECT decode(lpad(to_hex(200+c),40,'0'),'hex'),to_timestamp($1::double precision-m*60),1,1,1,1,c,1,1,1
    FROM generate_series(1,100) c CROSS JOIN generate_series(0,2879) m`,[sec]);
  await db.sql.query(`INSERT INTO swaps(ts,block,tx_hash,log_index,venue,pool_id,coin,quote_asset,trader,side,amount_coin,amount_quote,usd)
    SELECT to_timestamp($1::double precision-60),2,decode(lpad(to_hex(n),64,'0'),'hex'),0,'pons_curve',coin,coin,coin,coin,1,1e18,1,10
    FROM generate_series(1,100) n CROSS JOIN LATERAL (SELECT decode(lpad(to_hex(200+n),40,'0'),'hex') coin) c`,[sec]);
  await db.sql.query('ANALYZE bars_1m');await db.sql.query('ANALYZE swaps');
  const store=new ReadStore(db,()=>now);await store.refreshRanks();store.start();
  try {
    const started=performance.now(),page=await new RadarService(store).list(),pageMs=performance.now()-started;
    expect(page.rows).toHaveLength(100);expect(page.rows[0].address).toBe(sampleAddress(300));
    expect(page.rows[0].volume1hUsd).toBe(6100);expect(page.delayedSec).toBe(0);
    console.info('Radar benchmark',JSON.stringify({coins:100,historyBars:288000,pageMs}));
  }finally{await store.close();}
});
