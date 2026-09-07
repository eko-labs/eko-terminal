import { afterEach, expect, it } from 'vitest';
import { ChainDb, migrate, } from '../src/client.js';
import { openDb } from './helpers/historical-db.js';
import { migrateEngines } from '../src/engines-migrate.js';
import { runRetention } from '../src/retention.js';
import { sealRawPartition } from '../src/raw-partitions.js';
let db:ChainDb;
afterEach(async()=>{await db?.close();db=undefined!;});
async function fixture() {
 db=await openDb({pgliteDir:':memory:'});await migrate(db);await migrateEngines(db);
 const ts=new Date('2026-09-01T00:00:00Z');await db.ensurePartitions(ts);
 await db.insert('token_transfers',{ts,block:1,tx_hash:Buffer.alloc(32,1),log_index:0,token:Buffer.alloc(20,1),from_address:Buffer.alloc(20),to_address:Buffer.alloc(20,2),amount:'10'});
 return db;
}
const options={quoteTokens:[],swapDays:7,transferDays:3,dryRun:false,now:()=>Date.parse('2026-09-20T00:00:00Z')};
it('excludes a second owner through the existing mutex, without changing data',async()=>{
 const queries:string[]=[];
 const sql={query:async(text:string)=>{queries.push(text);return {rows:[{acquired:false}]};}};
 const handle=new ChainDb(sql as never,async work=>work(sql as never));
 const result=await runRetention(handle,options);
 expect(result.skippedRules).toEqual(['raw_partitions']);
 expect(queries).toEqual(['SELECT pg_try_advisory_lock(4663,208) AS acquired']);
});
it('dry run does not fence, seal, detach, drop or set a cursor',async()=>{
 await fixture();const before=await db.sql.query('SELECT * FROM raw_history_watermarks ORDER BY name');
 const result=await runRetention(db,{...options,dryRun:true});expect(result.tables?.length).toBeGreaterThan(0);
 expect(await db.sql.query('SELECT * FROM raw_history_watermarks ORDER BY name')).toEqual(before);
 expect((await db.sql.query('SELECT * FROM raw_history_seals')).rows).toHaveLength(0);
 expect((await db.sql.query('SELECT * FROM token_transfers')).rows).toHaveLength(1);
});
it('seals before detach/drop, advances the watermark last, uses bounded maintenance statements and bounded DDL',async()=>{
 await fixture();const events:string[]=[],transact=db.tx.bind(db);
 db.tx=work=>transact(async tx=>{
  const query=tx.sql.query.bind(tx.sql);
  tx.sql.query=(async(sql:string,params?:unknown[])=>{events.push(sql);return query(sql,params);}) as typeof tx.sql.query;
  return work(tx);
 });
 const result=await runRetention(db,options);
 const baseline=events.findIndex(q=>q.startsWith('INSERT INTO transfer_baselines'));
 const marked=events.findIndex((q,i)=>i>baseline && q.startsWith('UPDATE raw_history_seals SET sealed=true'));
 const detach=events.findIndex(q=>q==='ALTER TABLE token_transfers DETACH PARTITION token_transfers_d2026_09_01');
 const drop=events.findIndex(q=>q==='DROP TABLE IF EXISTS token_transfers_d2026_09_01');
 const watermark=events.findIndex((q,i)=>i>drop && q.startsWith('UPDATE raw_history_watermarks'));
 expect(marked).toBeGreaterThanOrEqual(0);expect(detach).toBeGreaterThan(marked);expect(drop).toBeGreaterThan(detach);expect(watermark).toBeGreaterThan(drop);
 expect(events).toContain("SET LOCAL statement_timeout='300000ms'");expect(events).not.toContain('SET LOCAL statement_timeout=0');expect(events).toContain("SET LOCAL lock_timeout='5s'");
 expect(result.partitions?.find(p=>p.partition==='token_transfers_d2026_09_01')?.rows).toBe(1);
 expect((await db.sql.query("SELECT through_block FROM raw_history_watermarks WHERE name='token_transfers'")).rows).toEqual([{through_block:1}]);
});
it('a lock conflict retains the sealed partition and retries without adding its balances twice',async()=>{
 await fixture();const transact=db.tx.bind(db);let blocked=true;
 db.tx=work=>transact(async tx=>{
  const query=tx.sql.query.bind(tx.sql);
  tx.sql.query=(async(sql:string,params?:unknown[])=>{
   if(blocked && sql==='ALTER TABLE token_transfers DETACH PARTITION token_transfers_d2026_09_01')throw Object.assign(new Error('lock'),{code:'55P03'});
   return query(sql,params);
  }) as typeof tx.sql.query;return work(tx);
 });
 expect((await runRetention(db,options)).skippedRules).toContain('token_transfers_d2026_09_01');
 expect((await db.sql.query("SELECT through_block FROM raw_history_watermarks WHERE name='token_transfers'")).rows).toEqual([{through_block:-1}]);
 blocked=false;await runRetention(db,options);
 expect((await db.sql.query('SELECT amount FROM transfer_baselines WHERE holder=$1',[Buffer.alloc(20,2)])).rows).toEqual([{amount:'10'}]);
});
it('range fences reject late inserts and mutations after seal, before detach and the block watermark',async()=>{
 await fixture();await sealRawPartition(db,'token_transfers','token_transfers_d2026_09_01');
 await expect(db.insert('token_transfers',{ts:new Date('2026-09-01T01:00:00Z'),block:2,tx_hash:Buffer.alloc(32,3),log_index:0,token:Buffer.alloc(20,1),from_address:Buffer.alloc(20),to_address:Buffer.alloc(20,2),amount:'1'})).rejects.toThrow('compacted raw history');
 await expect(db.sql.query('UPDATE token_transfers SET amount=11 WHERE block=1')).rejects.toThrow('sealed raw history');
 expect((await db.sql.query('SELECT amount FROM token_transfers')).rows).toEqual([{amount:'10'}]);
});
it('recovers a crash after detach and after drop, before watermark advance',async()=>{
 await fixture();await sealRawPartition(db,'token_transfers','token_transfers_d2026_09_01');
 await db.sql.query('ALTER TABLE token_transfers DETACH PARTITION token_transfers_d2026_09_01');
 await runRetention(db,options);
 expect((await db.sql.query("SELECT to_regclass('token_transfers_d2026_09_01') AS p")).rows).toEqual([{p:null}]);
 await db.sql.query("UPDATE raw_history_watermarks SET through_block=-1 WHERE name='token_transfers'");
 await runRetention(db,options);
 expect((await db.sql.query("SELECT through_block FROM raw_history_watermarks WHERE name='token_transfers'")).rows).toEqual([{through_block:1}]);
});

it.each(['57014','55P03'])('skips a swaps seal with %s after a long raw phase and still drops transfers and runs every later rule',async code=>{
 await fixture();
 const ts=new Date('2026-09-01T00:00:00Z');
 await db.insert('swaps',{ts,block:1,tx_hash:Buffer.alloc(32,3),log_index:0,coin:Buffer.alloc(20,1),pool_id:Buffer.alloc(20,2),quote_asset:Buffer.alloc(20,3),side:1,amount_coin:'1',amount_quote:'1',price_quote:1,usd:1,venue:'uniswap_v3'});
 const {vi}=await import('vitest');const realNow=Date.now;let elapsed=0;
 const clock=vi.spyOn(Date,'now').mockImplementation(()=>realNow()+elapsed);
 const transact=db.tx.bind(db);let forced=false,transfersDropped=false;
 db.tx=work=>transact(async tx=>{
  const query=tx.sql.query.bind(tx.sql);
  tx.sql.query=(async(sql:string,params?:unknown[])=>{
   if(!forced && sql.startsWith('CREATE TEMP TABLE raw_seal_rows') && sql.includes('swaps_d2026_09_01')) {
    forced=true;elapsed=343_000;
    // A database error aborts the transaction, rather than merely rejecting a JavaScript promise.
    return query(`DO $$ BEGIN RAISE EXCEPTION 'fixture statement failure' USING ERRCODE='${code}'; END $$`);
   }
   // A nested seal's finally used to run before transfers and could mask the original code.
   if(forced && !transfersDropped && sql==='SELECT pg_advisory_unlock(4663,208)')
    throw Object.assign(new Error('fixture cleanup failure'),{code:'25P02'});
   const result=await query(sql,params);
   if(sql==='DROP TABLE IF EXISTS token_transfers_d2026_09_01')transfersDropped=true;
   return result;
  }) as typeof tx.sql.query;return work(tx);
 });
 try {
  const result=await runRetention(db,{...options,ratingDays:1,pendingPoolDays:1,feedDays:1,pauseMs:0});
  expect(forced).toBe(true);
  expect(result.finished).toBe(false);
  expect(result.skippedRules).toEqual(['swaps_d2026_09_01']);
  expect(result.partitionSkips).toContainEqual({partition:'swaps_d2026_09_01',code});
  expect((await db.sql.query("SELECT sealed,dropped FROM raw_history_seals WHERE partition_name='token_transfers_d2026_09_01'")).rows).toEqual([{sealed:true,dropped:true}]);
  expect((await db.sql.query("SELECT to_regclass('token_transfers_d2026_09_01') AS p")).rows).toEqual([{p:null}]);
  expect((await db.sql.query("SELECT to_regclass('swaps_d2026_09_01') AS p")).rows[0]?.p).toBe('swaps_d2026_09_01');
  for(const rule of ['watcher_swap_evidence','receipt_publications','wallet_fingerprint_dependencies','guard_shadow_runs','coin_cards','playbook_matches','verdicts','pending_pool_events','read_feed'])
   expect(result.ruleStats?.[rule]?.skipped).toBe(0);
 } finally {clock.mockRestore();}
});

it('preserves a seal timeout if session-lock cleanup also fails',async()=>{
 const {rawMaintenance}=await import('../src/raw-partitions.js');
 const timeout=Object.assign(new Error('fixture timeout'),{code:'57014'});
 const sql={query:async <T>(text:string)=>{
  if(text.startsWith('SELECT pg_advisory_unlock'))throw Object.assign(new Error('fixture cleanup failure'),{code:'25P02'});
  return {rows:[{acquired:true}] as T[]};
 }};
 await expect(rawMaintenance(new ChainDb(sql,work=>work(sql)),async()=>{throw timeout;})).rejects.toBe(timeout);
});
