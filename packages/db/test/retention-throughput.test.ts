import { describe, expect, it } from 'vitest';
import { canonicalize, createGuardReceiptCodec } from '@eko/shared';
import { concat, encodeAbiParameters, keccak256, stringToHex } from 'viem';
import { binary, ReceiptOutbox, ChainDb, migrate, migrateEngines, runRetention, type SqlClient } from '../src/index.js';
import { receiptSelection, ratingRetention } from '../src/rating-retention.js';
import { retentionCursors, retentionDb } from '../src/retention-control.js';
import { openDb } from './helpers/historical-db.js';

const coin=`0x${'ab'.repeat(20)}` as const, other=`0x${'cd'.repeat(20)}` as const;
const old=new Date('2026-10-01T00:00:00Z'),now=Date.parse('2026-10-17T00:00:00Z');
const codec=createGuardReceiptCodec({concat,encodeAbiParameters,keccak256,stringToHex});
function publication(id:string,address:string=coin,recordedAt=old,kind:'verdict'|'forecast'='verdict',producer='engines') {
  const data={schemaVersion:'public-receipt-1',canonicalization:'jcs-rfc8785/v1',receiptId:id,revisionId:id,kind,chainId:4663,coin:address,
    recordedAt:recordedAt.toISOString(),modelIds:[],personaSetVersion:null,cardSchemaVersion:'fixture-card',rulesVersion:'1.0.0',outputSchemaVersion:'verdict-1',
    snapshotHash:codec.hash({fixture:true}),deterministicInput:{fixture:true},decision:{level:'clear'},
    window:{kind:'snapshot',blockNumber:1,blockHash:`0x${'ab'.repeat(32)}`},supersedes:null,reorgOf:null};
  return {id,producer,kind,chain_id:4663,revision_id:id,payload_hash:codec.hash(data),canonical_payload:canonicalize(data),data,recorded_at:recordedAt};
}
async function insert(db:ChainDb,rows:ReturnType<typeof publication>[]) {
  await db.sql.query(`INSERT INTO receipt_publications(id,producer,kind,chain_id,revision_id,payload_hash,canonical_payload,data,recorded_at)
    SELECT id,producer,kind,chain_id,revision_id,payload_hash,canonical_payload,data,recorded_at
    FROM jsonb_populate_recordset(NULL::receipt_publications,$1::jsonb)`,[JSON.stringify(rows)]);
}
describe('retention batch plans and throughput',()=>{
  it('strips thousands in one pass using bounded indexed candidates, including a coin’s only verdict',async()=>{
    const db=await openDb({pgliteDir:':memory:'});
    try {
      await migrate(db);await migrateEngines(db);
      const backlog=Array.from({length:2048},(_,n)=>publication(`sample-${n.toString().padStart(4,'0')}`));
      await insert(db,[...backlog,publication('sample-latest'),publication('sample-recent',coin,new Date(now)),
        publication('sample-other',other),publication('sample-forecast',other,old,'forecast'),publication('sample-producer',other,old,'verdict','other')]);
      await db.sql.query("INSERT INTO coin_cards VALUES('sample-card',$1,1,'fixture','{}','1.0.0')",[binary(coin)]);
      await db.sql.query("INSERT INTO coin_card_latest VALUES($1,'sample-card',1,$2)",[binary(coin),{verdict:{receipt:{id:'sample-0000'}}}]);
      await db.sql.query('ANALYZE receipt_publications');
      const plan=await retentionDb(db).sql.query(`EXPLAIN ${receiptSelection.replace('SELECT p.*','SELECT p.id')} AND p.id=ANY($2::text[])`,[new Date(now-7*86400000),backlog.slice(0,64).map(r=>r.id)]);
      const text=JSON.stringify(plan.rows);
      expect(text).toContain('receipt_publications_pkey');expect(text).toContain('Index Cond:');expect(text).not.toContain('Seq Scan');
      const started=performance.now();
      const result=await runRetention(db,{quoteTokens:[],ratingDays:7,dryRun:false,pauseMs:0,now:()=>now+performance.now()-started});
      console.info('receipt stripping fixture',{rows:result.ratingRows?.receipt_publications,elapsedMs:Math.round(performance.now()-started)});
      expect(result.ratingRows?.receipt_publications).toBe(2050);
      expect(result.ruleStats?.receipt_publications).toMatchObject({examined:2050,eligible:2050});
      expect(result.skippedRules).toEqual([]);
      const kept=(await db.sql.query<{id:string}>('SELECT id FROM receipt_publications WHERE data IS NOT NULL ORDER BY id')).rows.map(r=>r.id);
      expect(kept).toEqual(['sample-forecast','sample-producer','sample-recent']);
      expect((await db.sql.query("SELECT canonical_payload,summary->>'coin' AS coin FROM receipt_publications WHERE id='sample-0001'")).rows).toEqual([{canonical_payload:null,coin}]);
    }finally{await db.close();}
  });
  it('walks retained windows using IDs and fetches payloads only for eligible publications',async()=>{
    const db=await openDb({pgliteDir:':memory:'});
    try {
      await migrate(db);await migrateEngines(db);
      const retained=Array.from({length:128},(_,n)=>({...publication(`sample-${n.toString().padStart(4,'0')}`,`0x${(n+1).toString(16).padStart(40,'0')}`),canonical_payload:'{}'}));
      const eligible=['sample-superseded-a','sample-superseded-b'];
      await insert(db,[...eligible.map(id=>publication(id,retained[0]!.data.coin)),...retained]);
      await db.sql.query(`INSERT INTO coin_cards SELECT id,decode(substring(data->>'coin' FROM 3),'hex'),1,'fixture','{}','1.0.0'
        FROM receipt_publications WHERE id=ANY($1::text[])`,[retained.map(r=>r.id)]);
      await db.sql.query(`INSERT INTO coin_card_latest SELECT coin,id,1,jsonb_build_object('verdict',jsonb_build_object('receipt',jsonb_build_object('id',id))) FROM coin_cards`);
      const payloadReads:unknown[][]=[],selections:string[][]=[];
      const wrap=(sql:SqlClient):SqlClient=>({query:async <T>(text:string,params?:unknown[])=>{
        if(text.startsWith('SELECT p.* FROM receipt_publications')) {
          expect(selections.length).toBe(3);
          payloadReads.push(params!);
        }
        if(text.startsWith('SELECT p.id FROM receipt_publications') && !text.includes('FOR UPDATE'))selections.push(params![1] as string[]);
        return sql.query<T>(text,params);
      }});
      const traced=new ChainDb(wrap(db.sql),work=>db.tx(tx=>work(wrap(tx.sql))));
      const result=await runRetention(traced,{quoteTokens:[],ratingDays:7,receiptKeepCurrent:true,dryRun:false,pauseMs:0,now:()=>now});
      expect(selections.map(ids=>ids.length)).toEqual([64,64,2]);
      expect(payloadReads).toHaveLength(1);
      expect((payloadReads[0]![0] as string[]).sort()).toEqual(eligible);
      expect(result.ratingRows?.receipt_publications).toBe(2);
      expect(result.ruleStats?.receipt_publications).toMatchObject({rows:2,examined:130,eligible:2});
      expect(result.tables?.find(r=>r.table==='receipt_publications')).toMatchObject({rows:2,examined:130,eligible:2});
      expect((await db.sql.query('SELECT count(*)::integer AS n FROM receipt_publications WHERE data IS NOT NULL')).rows).toEqual([{n:128}]);
    }finally{await db.close();}
  });
  it.each([
    {hours:23,current:false,receiptKeepCurrent:false,stripped:false},
    {hours:25,current:false,receiptKeepCurrent:false,stripped:true},
    {hours:23,current:true,receiptKeepCurrent:false,stripped:false},
    {hours:25,current:true,receiptKeepCurrent:false,stripped:true},
    {hours:25,current:true,receiptKeepCurrent:true,stripped:false},
  ])(
    'at $hours hours with current card receipt=$current, keep current=$receiptKeepCurrent, stripped=$stripped',async({hours,current,receiptKeepCurrent,stripped})=>{
      const db=await openDb({pgliteDir:':memory:'});
      try {
        await migrate(db);await migrateEngines(db);
        const row=publication('sample-boundary',coin,new Date(now-hours*3600000));
        await insert(db,[row]);
        await new ReceiptOutbox(db).enqueue(row.id);
        if(current) {
          await db.sql.query("INSERT INTO coin_cards VALUES('sample-card',$1,1,'fixture','{}','1.0.0')",[binary(coin)]);
          await db.sql.query("INSERT INTO coin_card_latest VALUES($1,'sample-card',1,$2)",[binary(coin),{verdict:{receipt:{id:row.id}}}]);
        }
        const result=await runRetention(db,{quoteTokens:[],ratingDays:7,receiptHours:24,receiptKeepCurrent,dryRun:false,pauseMs:0,now:()=>now});
        expect(result.ratingRows?.receipt_publications).toBe(stripped ? 1 : 0);
        expect(result.ratingRows?.receipt_items).toBe(stripped ? 1 : 0);
        for(const table of ['receipt_publications','receipt_items']) {
          const stored=(await db.sql.query(`SELECT data,canonical_payload FROM ${table} WHERE id=$1`,[row.id])).rows;
          expect(stored).toEqual([{data:stripped ? null : row.data,canonical_payload:stripped ? null : row.canonical_payload}]);
        }
        expect(result.ruleStats?.receipt_publications).toMatchObject({examined:hours<24 ? 0 : 1,eligible:stripped ? 1 : 0});
        if(stripped)expect((await db.sql.query('SELECT summary FROM receipt_publications WHERE id=$1',[row.id])).rows).toEqual([
          {summary:expect.objectContaining({coin,receiptId:row.id,recordedAt:row.data.recordedAt,level:'clear'})}]);
      }finally{await db.close();}
    });
  it.each([false,true])('holds an ineligible end cursor for an hour, then resumes (switch to default=%s)',async switchToDefault=>{
    const db=await openDb({pgliteDir:':memory:'});
    try {
      await migrate(db);await migrateEngines(db);
      await insert(db,[publication('sample-held')]);
      await db.sql.query("INSERT INTO coin_cards VALUES('sample-card',$1,1,'fixture','{}','1.0.0')",[binary(coin)]);
      await db.sql.query("INSERT INTO coin_card_latest VALUES($1,'sample-card',1,$2)",[binary(coin),{verdict:{receipt:{id:'sample-held'}}}]);
      let clock=now,windowReads=0;
      const wrap=(sql:SqlClient):SqlClient=>({query:async <T>(text:string,params?:unknown[])=>{
        if(text.startsWith('SELECT id,recorded_at FROM receipt_publications'))windowReads++;
        return sql.query<T>(text,params);
      }});
      const traced=new ChainDb(wrap(db.sql),work=>db.tx(tx=>work(wrap(tx.sql))));
      const options={quoteTokens:[],ratingDays:7,receiptHours:24,receiptKeepCurrent:true,dryRun:false,pauseMs:0,now:()=>clock};
      expect((await runRetention(traced,options)).ruleStats?.receipt_publications).toMatchObject({examined:1,eligible:0});
      expect(windowReads).toBe(2);
      expect(retentionCursors(traced).get('receipt_publications')).toEqual([old,'sample-held',now+3_600_000]);
      clock+=3_600_000-1;
      expect((await runRetention(traced,options)).ruleStats?.receipt_publications).toMatchObject({examined:0,eligible:0});
      expect(windowReads).toBe(2);
      if(switchToDefault)options.receiptKeepCurrent=false;
      else {
        clock++;
        await db.sql.query("UPDATE coin_card_latest SET data='{}'");
      }
      expect((await runRetention(traced,options)).ruleStats?.receipt_publications).toMatchObject({rows:1,examined:1,eligible:1});
      expect(windowReads).toBe(4);
      expect(retentionCursors(traced).has('receipt_publications')).toBe(false);
    }finally{await db.close();}
  });
  it.each([false,true])('rechecks a newly current receipt under lock with keep-current=%s',async receiptKeepCurrent=>{
    const db=await openDb({pgliteDir:':memory:'});
    try {
      await migrate(db);await migrateEngines(db);await insert(db,[publication('sample-race')]);
      await db.sql.query("INSERT INTO coin_cards VALUES('sample-card',$1,1,'fixture','{}','1.0.0')",[binary(coin)]);
      const wrap=(sql:SqlClient):SqlClient=>({query:async <T>(text:string,params?:unknown[])=>{
        const result=await sql.query<T>(text,params);
        if(text.startsWith('SELECT p.* FROM receipt_publications'))await sql.query("INSERT INTO coin_card_latest VALUES($1,'sample-card',1,$2)",[binary(coin),{verdict:{receipt:{id:'sample-race'}}}]);
        return result;
      }});
      const traced=new ChainDb(wrap(db.sql),work=>db.tx(tx=>work(wrap(tx.sql))));
      const result=await runRetention(traced,{quoteTokens:[],ratingDays:7,receiptKeepCurrent,dryRun:false,pauseMs:0,now:()=>now});
      expect(result.ratingRows?.receipt_publications).toBe(receiptKeepCurrent ? 0 : 1);
      expect((await db.sql.query('SELECT data IS NULL AS stripped FROM receipt_publications')).rows).toEqual([{stripped:!receiptKeepCurrent}]);
    }finally{await db.close();}
  });
  it('refuses corrupt payloads before stripping',async()=>{
    const db=await openDb({pgliteDir:':memory:'});
    try {
      await migrate(db);await migrateEngines(db);
      await insert(db,[{...publication('sample-corrupt'),canonical_payload:'{}'},publication('sample-newest')]);
      await expect(runRetention(db,{quoteTokens:[],ratingDays:7,dryRun:false,pauseMs:0,now:()=>now})).rejects.toThrow('integrity failure');
      expect((await db.sql.query('SELECT id FROM receipt_publications WHERE data IS NULL')).rows).toEqual([]);
    }finally{await db.close();}
  });
  it('bounds fingerprint eligibility and both sides of its delete by the primary-key window',async()=>{
    const db=await openDb({pgliteDir:':memory:'});
    try {
      await migrate(db);await migrateEngines(db);
      await db.sql.query("INSERT INTO engine_block_times VALUES(1,$1,NULL,'head')",[old]);
      await db.sql.query(`INSERT INTO wallet_fingerprint_runs SELECT 'sample-run-'||lpad(n::text,5,'0'),$1,1,$2,'fixture-model',n::text,'{}',0.5 FROM generate_series(1,20000) n`,[binary(coin),binary(`0x${'ab'.repeat(32)}`)]);
      await db.sql.query(`INSERT INTO wallet_fingerprint_dependencies SELECT id,1,block_hash FROM wallet_fingerprint_runs`);
      await db.sql.query('ANALYZE wallet_fingerprint_dependencies');
      const plans:string[]=[];
      const wrap=(sql:SqlClient):SqlClient=>({query:async <T>(text:string,params?:unknown[])=>{
        if(text.startsWith('SELECT x.run_id,x.block FROM wallet_fingerprint_dependencies') || text.includes('gone AS (DELETE FROM wallet_fingerprint_dependencies')) {
          const plan=JSON.stringify((await sql.query(`EXPLAIN ${text}`,params)).rows);plans.push(plan);
          expect(plan).not.toContain('Seq Scan on wallet_fingerprint_dependencies');
          expect(plan).toContain('wallet_fingerprint_dependencies_pkey');
          expect(plan).toContain('Index Cond:');expect(plan).toContain('>=');expect(plan).toContain('<=');
        }
        return sql.query<T>(text,params);
      }});
      const traced=new ChainDb(wrap(db.sql),work=>db.tx(tx=>work(wrap(tx.sql))));
      const result=await runRetention(db,{quoteTokens:[],dryRun:true});
      await ratingRetention(retentionDb(traced),{quoteTokens:[],dryRun:false,pauseMs:0},result,now,async(name,work)=>{
        if(name!=='wallet_fingerprint_dependencies')return;
        let batches=0;await work(()=>batches++===0,32);
      },new Map());
      expect(plans).toHaveLength(2);expect(result.ratingRows?.wallet_fingerprint_dependencies).toBe(32);
      expect((await db.sql.query('SELECT count(*)::integer AS n FROM wallet_fingerprint_dependencies')).rows).toEqual([{n:19968}]);
    }finally{await db.close();}
  });
});
