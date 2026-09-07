import { provisionHistory } from './helpers/historical-db.js';
import { afterEach, expect, it } from 'vitest';
import { openDb, migrate, migrateEngines, type ChainDb, sealRawPartition } from '../src/index.js';
let db:ChainDb;
afterEach(async()=>{await db?.close();});
it('seals a day once with exact lifetime and buyer sufficient statistics',async()=>{
 db=await openDb({pgliteDir:':memory:'});await migrate(db);await migrateEngines(db);
 const ts=new Date('2026-10-01T00:00:00Z'),coin=Buffer.alloc(20,1),trader=Buffer.alloc(20,2),pool=Buffer.alloc(20,3),hash=Buffer.alloc(32,4);
 await provisionHistory(db,ts);await db.ensurePartitions(ts);
 await db.insert('chain_blocks',{number:1,block:1,ts,hash,parent_hash:hash});
 await db.insert('tokens',{address:coin,deployer:trader,first_block:1,block:1,decimals:0});
 await db.insert('swaps',{ts,block:1,tx_hash:hash,log_index:0,coin,pool_id:pool,quote_asset:pool,side:1,amount_coin:'10',amount_quote:'5',price_quote:0.5,usd:3,venue:'uniswap_v3',trader});
 const first=await sealRawPartition(db,'swaps','swaps_d2026_10_01');expect(Number(first.rows)).toBe(1);
 expect((await db.sql.query<{data:{count:number}}>('SELECT data FROM coin_lifetime')).rows[0].data.count).toBe(1);
 expect(await sealRawPartition(db,'swaps','swaps_d2026_10_01')).toEqual(first);
});
it('creates UTC daily bounds with configurable lookahead, caches repeated calls and preserves monthly bars',async()=>{
 db=await openDb({pgliteDir:':memory:'});await migrate(db);
 const date=new Date('2027-01-30T23:59:59Z');await db.ensurePartitions(date,{daysAhead:2,now:date});
 const leaves=async()=>(await db.sql.query<{name:string;bound:string}>(`SELECT c.relname AS name,pg_get_expr(c.relpartbound,c.oid) AS bound FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid WHERE i.inhparent='swaps'::regclass AND c.relname LIKE 'swaps_d2027_%' ORDER BY name`)).rows;
 expect((await leaves()).map(r=>r.name)).toEqual(Array.from({length:4},(_,i)=>`swaps_d${new Date(Date.parse('2027-01-29')+i*86400000).toISOString().slice(0,10).replaceAll('-','_')}`));
 for(const leaf of await leaves()){
  const bounds=[...leaf.bound.matchAll(/'([^']+)'/g)].map(m=>new Date(m[1]!).toISOString());
  expect(bounds[0]).toBe(`${leaf.name.slice(7).replaceAll('_','-')}T00:00:00.000Z`);expect(Date.parse(bounds[1]!)-Date.parse(bounds[0]!)).toBe(86400000);
 }
 const query=db.sql.query.bind(db.sql);let queries=0;db.sql.query=(async(sql:string,params?:unknown[])=>{queries++;return query(sql,params);}) as typeof db.sql.query;
 await db.ensurePartitions(date,{daysAhead:2,now:date});expect(queries).toBe(0);
 await db.ensurePartitions(date,{daysAhead:4,now:date});expect((await leaves()).map(r=>r.name)).toContain('swaps_d2027_02_03');
 expect((await db.sql.query("SELECT to_regclass('bars_1m_2027_01') AS p")).rows[0].p).toBe('bars_1m_2027_01');
 await expect(db.ensurePartitions(date,{daysAhead:-1})).rejects.toThrow('DAYS_AHEAD');
});
it('reads DAYS_AHEAD and permits calls while legacy monthly partitions cover the day',async()=>{
 db=await openDb({pgliteDir:':memory:'});await migrate(db);
 const saved=process.env.DAYS_AHEAD;process.env.DAYS_AHEAD='1';
 try{await db.ensurePartitions(new Date('2028-01-01'),{now:new Date('2028-01-01')});}finally{if(saved===undefined)delete process.env.DAYS_AHEAD;else process.env.DAYS_AHEAD=saved;}
 expect((await db.sql.query("SELECT relname FROM pg_class WHERE relname IN ('swaps_d2028_01_01','swaps_d2028_01_02','swaps_d2028_01_03') AND relkind='r'")).rows).toHaveLength(2);
 await db.sql.query("CREATE TABLE swaps_2026_08 PARTITION OF swaps FOR VALUES FROM ('2026-08-01T00:00:00Z') TO ('2026-09-01T00:00:00Z')");
 await db.ensurePartitions(new Date('2026-08-02'));expect((await db.sql.query("SELECT to_regclass('swaps_d2026_08_02') AS p")).rows[0].p).toBeNull();
});
it('guards empty monthly drops in chain migration 0210',async()=>{
 const {readFile}=await import('node:fs/promises');db=await openDb({pgliteDir:':memory:'});await migrate(db);
 await db.sql.query("CREATE TABLE swaps_2026_05 PARTITION OF swaps FOR VALUES FROM ('2026-05-01T00:00:00Z') TO ('2026-06-01T00:00:00Z')");
 await db.sql.query("CREATE TABLE token_transfers_2026_06 PARTITION OF token_transfers FOR VALUES FROM ('2026-06-01T00:00:00Z') TO ('2026-07-01T00:00:00Z')");
 await db.insert('token_transfers',{ts:new Date('2026-06-01'),block:1,tx_hash:Buffer.alloc(32),log_index:0,token:Buffer.alloc(20),from_address:Buffer.alloc(20),to_address:Buffer.alloc(20,1),amount:'1'});
 const sql=await readFile(new URL('../drizzle/0210_daily_raw_history.sql',import.meta.url),'utf8');await db.sql.query(sql.split('-- statement-breakpoint')[0]!);
 expect((await db.sql.query("SELECT to_regclass('swaps_2026_05') AS p")).rows[0].p).toBeNull();
 expect((await db.sql.query("SELECT to_regclass('token_transfers_2026_06') AS p")).rows[0].p).not.toBeNull();
 expect((await db.sql.query("SELECT id FROM eko_indexer_migrations WHERE id='0210_daily_raw_history'")).rows).toHaveLength(1);
});
it('folds ordered buys, sells, attribution, per-pool prices, early actors, launch hour and graduation exactly like addLifetimeSwaps',async()=>{
 const {addLifetimeSwaps,emptyLifetime}=await import('../src/lifetime.js');
 db=await openDb({pgliteDir:':memory:'});await migrate(db);
 const hex=(n:number)=>`0x${n.toString(16).padStart(40,'0')}`;
 const id={deployer:hex(1),firstBlock:1,createdSec:Date.parse('2026-10-01')/1000,pools:new Set([hex(99)]),firstBlocks:35,cohortSec:60};
 const rows=Array.from({length:160},(_,i)=>({block:String(i+1),ts:new Date((id.createdSec+i*30)*1000).toISOString(),tx_hash:`0x${i.toString(16).padStart(64,'0')}`,log_index:i%3,
  trader:i%7===0?null:hex(i%4+1),recipient:i%9===0?hex(99):null,senders_pending:i%11===0,side:i%3===0?-1:1,amount_coin:String(i%4+1),amount_quote:'3',price_quote:0.5,
  usd:i%5===0?null:i%13===0?0:i+0.5,venue:i<40?'pons_curve':'uniswap_v3',pool_id:hex(i%2+50),quote_asset:hex(0)}));
 const seed=emptyLifetime();seed.graduation={block:42,atSec:id.createdSec+41*30,first:rows[41]!,before:rows[40],count:0,missing:0,volume:0,missingVolume:0,unknown:0,actors:{}};
 addLifetimeSwaps(seed,rows.slice(0,10),id);
 const expected=structuredClone(seed);addLifetimeSwaps(expected,rows.slice(10),id);
 const actual=(await db.sql.query<{data:unknown}>(`SELECT raw_history_lifetime(r,$2::jsonb,$3::jsonb ORDER BY (r->>'block')::bigint) AS data FROM jsonb_array_elements($1::jsonb)r`,[JSON.stringify(rows.slice(10)),JSON.stringify(seed),JSON.stringify({...id,pools:[...id.pools]})])).rows[0].data;
 expect(actual).toEqual(JSON.parse(JSON.stringify(expected)));
});

it('never provisions before data starts, including with empty older leaves, or outside wall-clock retention for a stale repair date',async()=>{
 db=await openDb({pgliteDir:':memory:'});await migrate(db);
 for(const table of ['swaps','token_transfers']) {
  const parts=(await db.sql.query<{name:string}>(`SELECT c.relname AS name FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid WHERE i.inhparent=$1::regclass`,[table])).rows;
  for(const {name}of parts)await db.sql.query(`DROP TABLE ${name}`);
  await db.sql.query(`CREATE TABLE ${table}_d2026_10_01 PARTITION OF ${table} FOR VALUES FROM ('2026-10-01T00:00:00Z') TO ('2026-10-02T00:00:00Z')`);
  await db.sql.query(`CREATE TABLE ${table}_2026_09 PARTITION OF ${table} FOR VALUES FROM ('2026-09-01T00:00:00Z') TO ('2026-10-01T00:00:00Z')`);
  if(table==='swaps')await db.sql.query(`INSERT INTO swaps_d2026_10_01(ts,block,tx_hash,log_index,coin,pool_id,quote_asset,side,amount_coin,amount_quote,price_quote,venue)
    VALUES('2026-10-01T00:00:00Z',1,decode(repeat('00',32),'hex'),0,decode(repeat('01',20),'hex'),decode(repeat('02',20),'hex'),decode(repeat('03',20),'hex'),1,10,5,0.5,'uniswap_v3')`);
  else await db.sql.query(`INSERT INTO token_transfers_d2026_10_01(ts,block,tx_hash,log_index,token,from_address,to_address,amount)
    VALUES('2026-10-01T00:00:00Z',1,decode(repeat('00',32),'hex'),0,decode(repeat('01',20),'hex'),decode(repeat('02',20),'hex'),decode(repeat('03',20),'hex'),10)`);
 }
 const names=async(table:string)=>(await db.sql.query<{name:string}>(`SELECT c.relname AS name FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid WHERE i.inhparent=$1::regclass AND c.relname LIKE '%_d%' ORDER BY c.relname`,[table])).rows.map(r=>r.name);
 await db.ensurePartitions(new Date('2026-10-07'),{now:new Date('2026-10-07'),daysAhead:3});
 expect(await names('swaps')).toEqual([1,6,7,8,9,10].map(i=>`swaps_d2026_10_${String(i).padStart(2,'0')}`));
 expect(await names('token_transfers')).toEqual([1,6,7,8,9,10].map(i=>`token_transfers_d2026_10_${String(i).padStart(2,'0')}`));
 await db.ensurePartitions(new Date('2026-09-07'),{now:new Date('2026-10-20'),daysAhead:1});
 expect((await names('swaps')).filter(n=>![1,6,7,8,9,10].map(i=>`swaps_d2026_10_${String(i).padStart(2,'0')}`).includes(n))).toEqual([19,20,21].map(i=>`swaps_d2026_10_${i}`));

});

it('resumes a cancelled multi-day seal after its committed coin batch and hides exactly that batch from live readers',async()=>{
 db=await openDb({pgliteDir:':memory:'});await migrate(db);await migrateEngines(db);
 await db.sql.query("CREATE TABLE swaps_2026_08 PARTITION OF swaps FOR VALUES FROM ('2026-08-01T00:00:00Z') TO ('2026-09-01T00:00:00Z')");
 for(const day of [1,2])for(const n of [1,2,3]) {
  const ts=new Date(`2026-08-0${day}`),coin=Buffer.alloc(20,n),hash=Buffer.alloc(32,day*10+n);
  await db.sql.query(`INSERT INTO swaps_2026_08(ts,block,tx_hash,log_index,coin,pool_id,quote_asset,side,amount_coin,amount_quote,price_quote,usd,venue)
   VALUES($1,$2,$3,0,$4,$4,$4,1,10,5,0.5,3,'uniswap_v3')`,[ts,day*10+n,hash,coin]);
 }
 const batches:{day:string;coins:number;rows:number}[]=[];
 await expect(sealRawPartition(db,'swaps','swaps_2026_08',{coinBatchSize:1,tsBefore:new Date('2026-08-03'),onProgress:p=>{batches.push(p);throw new Error('cancel between batches');}})).rejects.toThrow('cancel between batches');
 expect((await db.sql.query('SELECT sum((data->>\'count\')::int)::int AS n FROM coin_lifetime')).rows[0].n).toBe(1);
 expect((await db.sql.query('SELECT count(*)::int AS n FROM raw_history_live_swaps')).rows[0].n).toBe(5);
 const first=(await db.sql.query('SELECT * FROM raw_history_seal_days')).rows[0];expect(first.coins).toBe(1);
 const seal=await sealRawPartition(db,'swaps','swaps_2026_08',{coinBatchSize:1,tsBefore:new Date('2026-08-03'),onProgress:p=>batches.push(p)});
 expect(Number(seal.rows)).toBe(6);expect(batches.map(p=>`${p.day}:${p.coins}`)).toEqual(['2026-08-01:1','2026-08-01:2','2026-08-01:3','2026-08-02:1','2026-08-02:2','2026-08-02:3']);
 expect((await db.sql.query('SELECT (data->>\'count\')::int AS n FROM coin_lifetime ORDER BY coin')).rows).toEqual([{n:2},{n:2},{n:2}]);
 expect((await db.sql.query('SELECT count(*)::int AS n FROM raw_history_live_swaps')).rows[0].n).toBe(0);
});

it('sets the configured statement deadline at the start of every seal transaction',async()=>{
 const {rawSealStatementMs}=await import('../src/raw-partitions.js');
 const saved=process.env.RAW_SEAL_STATEMENT_SEC;process.env.RAW_SEAL_STATEMENT_SEC='0.025';
 try {
  expect(rawSealStatementMs()).toBe(25);
  db=await openDb({pgliteDir:':memory:'});await migrate(db);await migrateEngines(db);
  const tx=db.tx.bind(db),first:string[]=[];
  db.tx=work=>tx(async handle=>{
    const query=handle.sql.query.bind(handle.sql);let began=false;
    handle.sql.query=(async(sql:string,params?:unknown[])=>{if(!began){first.push(sql);began=true;}return query(sql,params);}) as typeof handle.sql.query;
    return work(handle);
  });
  const leaf=`swaps_d${new Date().toISOString().slice(0,10).replaceAll('-','_')}`;
  await sealRawPartition(db,'swaps',leaf);
  expect(first.length).toBeGreaterThan(3);expect(first.every(sql=>sql==="SET LOCAL statement_timeout='25ms'")).toBe(true);
  process.env.RAW_SEAL_STATEMENT_SEC='0';expect(rawSealStatementMs).toThrow('RAW_SEAL_STATEMENT_SEC');
 }finally{if(saved===undefined)delete process.env.RAW_SEAL_STATEMENT_SEC;else process.env.RAW_SEAL_STATEMENT_SEC=saved;}
});
