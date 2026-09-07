import { readFile } from 'node:fs/promises';
import { afterEach, expect, it } from 'vitest';
import { migrate, migrateEngines, runRetention, type ChainDb } from '../src/index.js';
import { openDb } from './helpers/historical-db.js';
import { sealOctober } from '../src/raw-repartition.js';

let db:ChainDb;
const coin=Buffer.alloc(20,1),hash=Buffer.alloc(32,1);
afterEach(async()=>{await db?.close();});
async function monthlyFixture() {
 db=await openDb({pgliteDir:':memory:'});await migrate(db);await migrateEngines(db);
 const leaves=(await db.sql.query<{name:string}>(`SELECT c.relname AS name FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid
  WHERE inhparent IN('swaps'::regclass,'token_transfers'::regclass) AND c.relname LIKE '%_d2026_10_%'`)).rows;
 for(const {name}of leaves)await db.sql.query(`DROP TABLE ${name}`);
 for(const t of ['swaps','token_transfers'])await db.sql.query(`CREATE TABLE ${t}_2026_10 PARTITION OF ${t} FOR VALUES FROM ('2026-10-01T00:00:00Z') TO ('2026-11-01T00:00:00Z')`);
 await db.insert('tokens',{address:coin,deployer:coin,first_block:1,block:1,decimals:0});
 for(const [day,block] of [[1,1],[8,800],[12,1200],[14,4800],[15,4900],[15,5000]]) {
  const ts=new Date(`2026-10-${String(day).padStart(2,'0')}T00:00:00Z`);
  await db.insert('chain_blocks',{number:block,block,ts,hash:Buffer.alloc(32,day),parent_hash:hash});
  await insert('swaps',ts,block);await insert('token_transfers',ts,block);
 }
 // Pending source repairs below the reorg tail must come from leaf partial indexes, even after flags clear in the source.
 await db.sql.query('UPDATE swaps SET senders_pending=true WHERE block=800');
 await db.sql.query('UPDATE swaps SET pricing_pending=true WHERE block=1200');
 await db.sql.query(`CREATE TABLE repartition_trigger_calls(name text PRIMARY KEY,n integer NOT NULL DEFAULT 0)`);
 await db.sql.query(`CREATE FUNCTION count_repartition_parent_calls() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  INSERT INTO repartition_trigger_calls VALUES(TG_TABLE_NAME,1) ON CONFLICT(name) DO UPDATE SET n=repartition_trigger_calls.n+1; RETURN NULL; END $$`);
 for(const t of ['swaps','token_transfers'])await db.sql.query(`CREATE TRIGGER repartition_parent_calls AFTER INSERT OR UPDATE OR DELETE ON ${t} FOR EACH STATEMENT EXECUTE FUNCTION count_repartition_parent_calls()`);
}
async function insert(t:string,ts:Date,block:number,logIndex=0) {
 const common={ts,block,tx_hash:Buffer.alloc(32,block%255),log_index:logIndex};
 if(t==='swaps')await db.insert('swaps',{...common,coin,pool_id:coin,quote_asset:coin,side:1,amount_coin:'10',amount_quote:'5',price_quote:0.5,usd:3,venue:'uniswap_v3'});
 else await db.insert('token_transfers',{...common,token:coin,from_address:Buffer.alloc(20),to_address:coin,amount:'10'});
}
const call=async(step:string,t:string,...params:unknown[])=>db.sql.query(`SELECT raw_history_repartition_${step}($1${params.map((_,i)=>`,$${i+2}`).join('')}) AS result`,[t,...params]);
const contents=async(t:string,cutoff?:Date)=>(await db.sql.query(`SELECT to_jsonb(s) AS data FROM ${t} s ${cutoff?'WHERE ts >= $1':''} ORDER BY ts,tx_hash,log_index`,cutoff?[cutoff]:[])).rows;
const triggerCalls=async()=>(await db.sql.query('SELECT * FROM repartition_trigger_calls ORDER BY name')).rows;
async function helpers() {
 const script=await readFile(new URL('../../../scripts/raw-history-repartition.sql',import.meta.url),'utf8');
 for(const sql of script.split('-- statement-breakpoint'))await db.sql.query(sql);
 // The runbook builds this concurrently on the attached source, outside any helper transaction.
 await db.sql.query('CREATE INDEX CONCURRENTLY token_transfers_2026_10_repartition_block ON token_transfers_2026_10(block,ts)');
}

it.each(['swaps','token_transfers'])('atomic cutover of %s rolls back detach, catch-up and prior attaches on failure; retries preserve inserts, repairs and reorgs without parent trigger side effects',async t=>{
 await monthlyFixture();
 await sealOctober(db,new Date('2026-10-15T00:00:00Z'),7,3);
 await sealOctober(db,new Date('2026-10-16T00:00:00Z'),7,3); // Persisted cutoff wins across retries.
 await helpers();
 await call('plan',t);await call('plan',t);
 const cutoff=new Date(t==='swaps'?'2026-10-08':'2026-10-12');
 const original=await contents(`${t}_2026_10`,cutoff),beforeCopy=await triggerCalls();
 if(t==='swaps') {
  // A failed index build rolls the whole day's create/load back without disturbing live reads.
  await insert(t,new Date('2026-10-08'),800,1);
  await db.sql.query('UPDATE swaps SET senders_pending=true WHERE block=800');
  await db.sql.query('CREATE UNIQUE INDEX operator_failure_idx ON ONLY swaps(ts,block)');
  await expect(call('copy',t,cutoff)).rejects.toMatchObject({code:'23505'});
  expect((await db.sql.query("SELECT to_regclass('swaps_d2026_10_08') AS p")).rows[0].p).toBeNull();
  await db.sql.query('DROP INDEX operator_failure_idx');
 }
 const beforeCopies=await triggerCalls();
 const days=(await db.sql.query<{day:Date}>('SELECT day FROM raw_history_repartition_days WHERE name=$1 ORDER BY day',[t])).rows;
 for(const {day}of days){await call('copy',t,day);await call('copy',t,day);}
 expect(await triggerCalls()).toEqual(beforeCopies);
 expect((await db.sql.query('SELECT high_block FROM raw_history_repartition_days WHERE name=$1 AND day=$2',[t,new Date('2026-10-15')])).rows).toEqual([{high_block:5000}]);
 expect((await db.sql.query('SELECT max(day) >= (date_trunc(\'day\',now())+interval \'3 days\') AS covered FROM raw_history_repartition_days WHERE name=$1',[t])).rows).toEqual([{covered:true}]);
 // Copy has not removed the source from parent reads or routed writes elsewhere.
 expect((await contents(t,cutoff)).length).toBe(original.length+(t==='swaps'?1:0));
 expect((await db.sql.query('SELECT 1 FROM pg_inherits WHERE inhparent=$1::regclass AND inhrelid=$2::regclass',[t,`${t}_2026_10`])).rows).toHaveLength(1);
 await expect(call('drop',t)).rejects.toThrow('Attach every planned day first');
 await expect(call('finish',t)).rejects.toThrow('Drop source first');
 // New block delta, reorg deletion across midnight, replacement at the same PK, and a late new event within the tail.
 await insert(t,new Date('2026-10-15T01:00:00Z'),6000);
 await db.sql.query(`DELETE FROM ${t} WHERE block=4800`);
 await db.sql.query(`UPDATE ${t} SET ${t==='swaps'?'amount_coin':'amount'}=77 WHERE block=4900`);
 await insert(t,new Date('2026-10-14T23:59:00Z'),4850,1);
 if(t==='swaps') {
  await db.sql.query('UPDATE swaps SET trader=$1,tx_from=$1,senders_pending=false,usd=42 WHERE block=800',[coin]);
  await db.sql.query('UPDATE swaps SET pricing_pending=false,price_quote=2,usd=20,priced_block=6000 WHERE block=1200');
 }
 const expected=await contents(`${t}_2026_10`,cutoff),liveBeforeFailure=await contents(t),beforeCutover=await triggerCalls();
 const firstLeaf=`${t}_d${cutoff.toISOString().slice(0,10).replaceAll('-','_')}`;
 const firstBefore=await contents(firstLeaf);
 const indexes=async()=>(await db.sql.query(`SELECT i.indexrelid::text AS id FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid WHERE c.relname LIKE $1 ORDER BY id`,[`${t}_d%`])).rows;
 const copiedIndexes=await indexes();
 // This fails after earlier days have been repaired and attached inside the transaction.
 await db.sql.query(`ALTER TABLE ${t}_d2026_10_15 ADD CONSTRAINT injected_cutover_failure CHECK(block<6000)`);
 await expect(call('cutover',t)).rejects.toMatchObject({code:'23514'});
 expect((await db.sql.query('SELECT 1 FROM pg_inherits WHERE inhparent=$1::regclass AND inhrelid=$2::regclass',[t,`${t}_2026_10`])).rows).toHaveLength(1);
 expect((await db.sql.query('SELECT 1 FROM pg_inherits WHERE inhparent=$1::regclass AND inhrelid=$2::regclass',[t,firstLeaf])).rows).toHaveLength(0);
 expect(await contents(firstLeaf)).toEqual(firstBefore);
 expect(await contents(t)).toEqual(liveBeforeFailure);
 expect(await triggerCalls()).toEqual(beforeCutover);
 await db.sql.query(`ALTER TABLE ${t}_d2026_10_15 DROP CONSTRAINT injected_cutover_failure`);
 await call('cutover',t);await call('cutover',t);
 expect(await contents(t)).toEqual(expected);
 expect(await triggerCalls()).toEqual(beforeCutover); // No parent INSERT/UPDATE/DELETE statement trigger runs for maintenance.
 expect(beforeCutover.length).toBeGreaterThan(0);expect(beforeCopy).toEqual([]);
 // No index creation is deferred to the blocking ATTACH transaction.
 expect(await indexes()).toEqual(copiedIndexes);
 // ATTACH reused every prebuilt parent index, leaving none invalid.
 expect((await db.sql.query('SELECT indexrelid FROM pg_index WHERE indrelid=$1::regclass AND NOT indisvalid',[t])).rows).toEqual([]);
 await call('drop',t);await call('drop',t);
 await db.sql.query("SET eko.days_ahead='366'");
 await expect(call('finish',t)).rejects.toThrow('Run ensurePartitions for today plus DAYS_AHEAD first');
 expect((await db.sql.query('SELECT through_block FROM raw_history_watermarks WHERE name=$1',[t])).rows).toEqual([{through_block:-1}]);
 await db.sql.query("SET eko.days_ahead='3'");
 await call('finish',t);await call('finish',t);
 expect((await db.sql.query('SELECT through_block FROM raw_history_watermarks WHERE name=$1',[t])).rows).toEqual([{through_block:t==='swaps'?1:800}]);
 expect((await db.sql.query('SELECT to_regclass($1) AS relation',[`${t}_2026_10`])).rows).toEqual([{relation:null}]);
});

it('deploy-before-surgery: monthly October serves provisioning, ingestion, pricing repair and live reads; hourly rule ignores monthly partitions even with pending seals',async()=>{
 await monthlyFixture();
 const before=await contents('swaps'),transfers=await contents('token_transfers');
 const query=db.sql.query.bind(db.sql),commands:string[]=[];
 db.sql.query=(async(sql:string,params?:unknown[])=>{commands.push(sql);return query(sql,params);}) as typeof db.sql.query;
 await db.ensurePartitions(new Date('2026-10-18'),{daysAhead:4});
 expect(commands.filter(s=>/CREATE TABLE.*(?:swaps|token_transfers)_d2026_10/.test(s))).toEqual([]);
 expect((await db.sql.query("SELECT name FROM raw_history_seals")).rows).toEqual([]);
 expect((await db.sql.query("SELECT to_regclass('raw_history_repartition_days') AS p")).rows[0].p).toBeNull();
 await insert('swaps',new Date('2026-10-15T02:00:00Z'),6000);
 await db.sql.query('UPDATE swaps SET pricing_pending=false,usd=20 WHERE block=1200');
 expect((await db.sql.query('SELECT count(*)::int AS n FROM raw_history_live_swaps')).rows[0].n).toBe(before.length+1);
 expect((await db.sql.query('SELECT count(*)::int AS n FROM raw_history_live_transfers')).rows[0].n).toBe(transfers.length);
 // Remove unrelated empty daily siblings so both worker calls model production's monthly-only raw state.
 const daily=(await db.sql.query<{name:string}>(`SELECT c.relname AS name FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid
  WHERE inhparent IN('swaps'::regclass,'token_transfers'::regclass) AND c.relname ~ '_d[0-9]{4}_[0-9]{2}_[0-9]{2}$'`)).rows;
 for(const {name}of daily)await db.sql.query(`DROP TABLE ${name}`);
 const unsealed=await runRetention(db,{quoteTokens:[],swapDays:7,transferDays:3,rawPartitions:true,now:()=>Date.parse('2026-12-01')});
 expect(unsealed.partitions ?? []).toEqual([]);
 expect((await db.sql.query('SELECT * FROM raw_history_seals')).rows).toEqual([]);
 expect((await db.sql.query("SELECT to_regclass('raw_history_repartition_days') AS p")).rows[0].p).toBeNull();
 // Simulate both an unstarted seal and an already committed monthly seal: neither is an hourly worker candidate.
 await db.sql.query(`INSERT INTO raw_history_seals(name,partition_name,start_ts,end_ts,rows,through_block,sealed)
  VALUES('swaps','swaps_2026_10','2026-10-01','2026-10-08',0,-1,false),
  ('token_transfers','token_transfers_2026_10','2026-10-01','2026-10-12',1,800,true)`);
 const prior=await contents('swaps'),priorSeals=(await db.sql.query('SELECT * FROM raw_history_seals ORDER BY name')).rows;
 const start=commands.length;
 const result=await runRetention(db,{quoteTokens:[],swapDays:7,transferDays:3,rawPartitions:true,now:()=>Date.parse('2026-12-01')});
 expect(result.partitions ?? []).toEqual([]);expect(result.historySwaps).toBe(0);expect(result.historyTransfers).toBe(0);
 expect(commands.slice(start).filter(s=>/ALTER TABLE.*(?:DETACH|ATTACH)|DROP TABLE|raw_seal_rows/.test(s))).toEqual([]);
 expect(await contents('swaps')).toEqual(prior);expect(await contents('token_transfers')).toEqual(transfers);
 expect((await db.sql.query('SELECT * FROM raw_history_seals ORDER BY name')).rows).toEqual(priorSeals);
 for(const t of ['swaps','token_transfers'])expect((await db.sql.query('SELECT 1 FROM pg_inherits WHERE inhparent=$1::regclass AND inhrelid=$2::regclass',[t,`${t}_2026_10`])).rows).toHaveLength(1);
});
