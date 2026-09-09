import { provisionHistory } from './helpers/historical-db.js';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { expect, it } from 'vitest';
import { ChainDb, migrate, openDb } from '../src/client.js';
import { migrateEngines } from '../src/engines-migrate.js';

// PGlite has one backend and cannot exercise lock waits/deadlock detection. Use an isolated schema on test Postgres.
const databaseUrl=process.env.EKO_TEST_POSTGRES_URL;
it.skipIf(!databaseUrl)('two concurrent refreshes with overlapping, reversed coin sets serialize without deadlocking',async()=>{
  const admin=await openDb({databaseUrl});
  const schema=`retention_test_${randomUUID().replaceAll('-','')}`;
  const pool=new pg.Pool({connectionString:databaseUrl,max:3});
  const clients=await Promise.all([pool.connect(),pool.connect(),pool.connect()]);
  const [one,two,observer]=clients;
  try {
    await admin.sql.query(`CREATE SCHEMA ${schema}`);
    for(const client of clients)await client.query(`SET search_path TO ${schema},public`);
    const db=new ChainDb(one,async work=>{
      await one.query('BEGIN');
      try {const result=await work(one);await one.query('COMMIT');return result;}
      catch(error) {await one.query('ROLLBACK');throw error;}
    });
    await migrate(db);await migrateEngines(db);
    const coins=[1,2,3].map(n=>Buffer.alloc(20,n));
    await one.query(`INSERT INTO chain_blocks(number,block,hash,parent_hash,ts) VALUES(1,1,$1,$1,now())`,[Buffer.alloc(32)]);
    for(const coin of coins)await one.query('INSERT INTO tokens(address,deployer,first_block,block,curve) VALUES($1,$1,1,1,$1)',[coin]);
    // Force an interleaving at first-created mutex keys. Reversed acquisition would make a real lock cycle.
    await one.query(`CREATE FUNCTION pause_mutex_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_sleep(0.05);RETURN NEW;END $$`);
    await one.query('CREATE TRIGGER pause_mutex_insert AFTER INSERT ON read_projection_locks FOR EACH ROW EXECUTE FUNCTION pause_mutex_insert()');
    for(const client of [one,two]) {
      await client.query("SET statement_timeout='5s'");
      await client.query('BEGIN');
    }
    const pids=await Promise.all([one,two].map(async client=>(await client.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid));
    const first=one.query('SELECT refresh_read_models($1::bytea[],0)',[[coins[0],coins[1]]]);
    void first.catch(()=>{});
    const second=two.query('SELECT refresh_read_models($1::bytea[],0)',[[coins[2],coins[1],coins[0]]]);
    void second.catch(()=>{}); // Keep the original rejection for the awaited assertion below.
    // Observe an actual cross-backend wait before letting the first refresh proceed. No timing-only assertion.
    const until=Date.now()+2000;
    let waiting:{one:boolean;two:boolean}|undefined;
    while(Date.now()<until) {
      const state=(await observer.query<{one:boolean;two:boolean}>(
        'SELECT cardinality(pg_blocking_pids($1))>0 AS one,cardinality(pg_blocking_pids($2))>0 AS two',pids)).rows[0]!;
      if(state.one || state.two) {waiting=state;break;}
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    expect(waiting).toBeDefined();
    if(waiting!.one) {
      await second;await two.query('COMMIT');await first;await one.query('COMMIT');
    } else {
      await first;await one.query('COMMIT');await second;await two.query('COMMIT');
    }
    expect((await observer.query('SELECT coin FROM read_coins ORDER BY coin')).rows).toHaveLength(3);
    expect((await observer.query('SELECT id FROM read_feed')).rows).toHaveLength(3);
  } finally {
    for(const client of clients) {await client.query('ROLLBACK');client.release();}
    await pool.end();await admin.sql.query(`DROP SCHEMA ${schema} CASCADE`);await admin.close();
  }
});

it.skipIf(!databaseUrl)('manual raw mutex excludes the worker without blocking new inserts; bar locks isolate coins',async()=>{
  const {runRetention}=await import('../src/retention.js');
  const {refreshBars}=await import('../src/market.js');
  const admin=await openDb({databaseUrl});
  const schema=`backlog_test_${randomUUID().replaceAll('-','')}`;
  const pool=new pg.Pool({connectionString:databaseUrl,max:2});
  const clients=await Promise.all([pool.connect(),pool.connect()]);
  const handles=clients.map(client=>new ChainDb(client,async work=>{
    await client.query('BEGIN');
    try {const result=await work(client);await client.query('COMMIT');return result;}
    catch(error) {await client.query('ROLLBACK');throw error;}
  }));
  let release:()=>void=()=>{},held:Promise<void>|undefined;
  try {
    await admin.sql.query(`CREATE SCHEMA ${schema}`);
    for(const client of clients)await client.query(`SET search_path TO ${schema},public`);
    await migrate(handles[0]!);await migrateEngines(handles[0]!);
    const current=new Date(),minute=new Date(Math.floor(current.getTime()/60000)*60000),old=new Date(current.getTime()-20*86400000);
    const coin=Buffer.alloc(20,1),other=Buffer.alloc(20,2),hash=Buffer.alloc(32,1);
    await provisionHistory(handles[0]!,old);
    await handles[0]!.ensurePartitions(old);
    await clients[0]!.query('INSERT INTO chain_blocks VALUES(1,1,$1,$1,$2)',[hash,old]);
    await clients[0]!.query('SELECT pg_advisory_lock(4663,208)');
    const result=await runRetention(handles[1]!,{quoteTokens:[],swapDays:7,transferDays:3,dryRun:false});
    expect(result.skippedRules).toEqual(['raw_partitions']);
    await handles[1]!.tx(async tx=>{
      await tx.sql.query("SET LOCAL statement_timeout='2s'");
      await tx.insert('token_transfers',{ts:current,block:2,tx_hash:hash,log_index:0,token:coin,from_address:coin,to_address:other,amount:'1'});
    });
    await clients[0]!.query('SELECT pg_advisory_unlock(4663,208)');
    // Ensure partition DDL is already done on both connections before holding the bar mutex.
    await handles[1]!.ensurePartitions(current);
    let ready:()=>void=()=>{};
    const acquired=new Promise<void>(resolve=>{ready=resolve;});
    const finish=new Promise<void>(resolve=>{release=resolve;});
    held=handles[0]!.tx(async tx=>{await refreshBars(tx,[{coin,minute}]);ready();await finish;});
    await Promise.race([acquired,held]);
    await handles[1]!.tx(async tx=>{
      await tx.sql.query("SET LOCAL lock_timeout='200ms'");
      await refreshBars(tx,[{coin:other,minute}]);
    });
    await expect(handles[1]!.tx(async tx=>{
      await tx.sql.query("SET LOCAL lock_timeout='200ms'");
      await refreshBars(tx,[{coin,minute}]);
    })).rejects.toMatchObject({code:'55P03'});
    release();await held;
  } finally {
    release();await held?.catch(()=>{});
    for(const client of clients) {await client.query('ROLLBACK');await client.query('SELECT pg_advisory_unlock_all()');client.release();}
    await pool.end();await admin.sql.query(`DROP SCHEMA ${schema} CASCADE`);await admin.close();
  }
});

it.skipIf(!databaseUrl)('partition DDL times out in two seconds and seal statements honor RAW_SEAL_STATEMENT_SEC on independent backends',async()=>{
  const {PartitionLockTimeoutError}=await import('../src/client.js');
  const {sealRawPartition}=await import('../src/raw-partitions.js');
  const admin=await openDb({databaseUrl}),schema=`bounded_seal_${randomUUID().replaceAll('-','')}`;
  const pool=new pg.Pool({connectionString:databaseUrl,max:2});
  const clients=await Promise.all([pool.connect(),pool.connect()]);
  const handles=clients.map(client=>new ChainDb(client,async work=>{
    await client.query('BEGIN');try{const result=await work(client);await client.query('COMMIT');return result;}
    catch(error){await client.query('ROLLBACK');throw error;}
  }));
  const saved=process.env.RAW_SEAL_STATEMENT_SEC;
  try {
    await admin.sql.query(`CREATE SCHEMA ${schema}`);
    for(const client of clients)await client.query(`SET search_path TO ${schema},public`);
    await migrate(handles[0]!);await migrateEngines(handles[0]!);
    await clients[0]!.query('BEGIN');await clients[0]!.query('LOCK TABLE swaps IN ACCESS SHARE MODE');
    const pid=(await clients[1]!.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    const began=performance.now();
    await expect(handles[1]!.ensurePartitions(new Date(),{daysAhead:5})).rejects.toBeInstanceOf(PartitionLockTimeoutError);
    expect(performance.now()-began).toBeLessThan(5000);
    expect((await clients[0]!.query('SELECT state FROM pg_stat_activity WHERE pid=$1',[pid])).rows[0].state).toBe('idle');
    await clients[0]!.query('ROLLBACK');
    // Inject a slow statement after the seal installs its local deadline, before any fence can commit.
    process.env.RAW_SEAL_STATEMENT_SEC='0.025';
    const query=clients[1]!.query.bind(clients[1]!);
    clients[1]!.query=(async(sql:string,params?:unknown[])=>{
      if(sql.startsWith('SELECT * FROM raw_history_seals') && params?.[0]==='swaps')await query('SELECT pg_sleep(0.2)');
      return query(sql,params);
    }) as typeof clients[number]['query'];
    const leaf=`swaps_d${new Date().toISOString().slice(0,10).replaceAll('-','_')}`;
    await expect(sealRawPartition(handles[1]!,'swaps',leaf)).rejects.toMatchObject({code:'57014'});
    expect((await clients[0]!.query('SELECT * FROM raw_history_seals')).rows).toHaveLength(0);
    // Exercise the whole pass with a real server-side statement cancellation, not a mocked rejection.
    const {runRetention}=await import('../src/retention.js');
    const old=new Date(Date.now()-4*86400000),transferLeaf=`token_transfers_d${old.toISOString().slice(0,10).replaceAll('-','_')}`;
    await provisionHistory(handles[0]!,old,0);
    await clients[0]!.query(`INSERT INTO token_transfers(ts,block,tx_hash,log_index,token,from_address,to_address,amount)
      VALUES($1,1,$2,0,$3,$3,$4,1)`,[old,Buffer.alloc(32,1),Buffer.alloc(20,1),Buffer.alloc(20,2)]);
    process.env.RAW_SEAL_STATEMENT_SEC='0.1';
    const result=await runRetention(handles[1]!,{quoteTokens:[],swapDays:1,transferDays:1,ratingDays:1,feedDays:1,dryRun:false,pauseMs:0});
    expect(result.finished).toBe(false);
    expect(result.partitionSkips?.some(p=>p.partition.startsWith('swaps_') && p.code==='57014')).toBe(true);
    expect((await clients[0]!.query('SELECT sealed,dropped FROM raw_history_seals WHERE partition_name=$1',[transferLeaf])).rows).toEqual([{sealed:true,dropped:true}]);
    expect((await clients[0]!.query('SELECT to_regclass($1) AS p',[transferLeaf])).rows).toEqual([{p:null}]);
    expect(result.ruleStats?.verdicts?.skipped).toBe(0);expect(result.ruleStats?.read_feed?.skipped).toBe(0);
  }finally{
    if(saved===undefined)delete process.env.RAW_SEAL_STATEMENT_SEC;else process.env.RAW_SEAL_STATEMENT_SEC=saved;
    for(const client of clients){await client.query('ROLLBACK');client.release();}
    await pool.end();await admin.sql.query(`DROP SCHEMA ${schema} CASCADE`);await admin.close();
  }
});
