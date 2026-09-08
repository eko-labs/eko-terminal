import { afterAll, beforeAll, expect, it } from 'vitest';
import { binary, migrate, migrateEngines, type ChainDb } from '../src/index.js';
import { openDb } from './helpers/historical-db.js';
import { rawCandidates, quietCoins } from '../src/retention.js';
import { snapshotTrending } from '../src/trending.js';
let db:ChainDb;
const coin=(n:number)=>binary(`0x${n.toString(16).padStart(40,'0')}`);
beforeAll(async()=>{
  db=await openDb({pgliteDir:':memory:'});await migrate(db);await migrateEngines(db);
  await db.sql.query(`INSERT INTO chain_blocks(number,block,hash,parent_hash,ts)
    SELECT n,n,decode(lpad(to_hex(n),64,'0'),'hex'),decode(lpad(to_hex(n-1),64,'0'),'hex'),
      '2026-10-01'::timestamptz+n*interval '1 second' FROM generate_series(1,10000) n`);
  await db.sql.query("INSERT INTO engine_block_times SELECT number,ts,hash,'head' FROM chain_blocks");
  for(let n=1;n<=5;n++)await db.insert('tokens',{address:coin(n),first_block:n,block:n,deployer:n===5 ? null : coin(10)});
});
afterAll(async()=>{await db?.close();});
it('uses ordered block and timestamp index scans without sorting raw history or scanning clock predecessors',async()=>{
  await db.sql.query('SET enable_seqscan=off');
  try {
    for(const [table,key] of [['token_transfers','token'],['swaps','coin']]) {
      const plan=JSON.stringify((await db.sql.query(`EXPLAIN SELECT ${key},block FROM ${table}
        WHERE block>=1 AND block<=1000 ORDER BY block LIMIT 1 FOR UPDATE`)).rows);
      expect(plan).toContain('Index Scan');expect(plan).toContain('block');expect(plan).not.toMatch(/->\s+(?:Incremental )?Sort\s+\(/);
    }
    const plan=JSON.stringify((await db.sql.query(`EXPLAIN SELECT number FROM engine_block_times
      WHERE ts<='2026-10-01T01:00:00Z' AND number<=10000 ORDER BY ts DESC,number DESC LIMIT 1`)).rows);
    expect(plan).toContain('engine_block_times_ts');expect(plan).not.toMatch(/->\s+(?:Incremental )?Sort\s+\(/);
  } finally {await db.sql.query('RESET enable_seqscan');}
});
it('advances bounded identity pages even when every candidate is retained',async()=>{
  const first=await rawCandidates(db,100n,[],null,false,2);
  expect(first.map(r=>Buffer.from(r.address))).toEqual([coin(1),coin(2)]);expect(first.every(r=>!r.eligible)).toBe(true);
  const next=await rawCandidates(db,100n,[],first.at(-1)!.address,false,2);
  expect(next.map(r=>Buffer.from(r.address))).toEqual([coin(3),coin(4)]);
  const settled=await quietCoins(db,'settled',100n,null,[],[],null,2);
  expect(settled).toHaveLength(2);expect(settled.every(r=>!r.eligible)).toBe(true);
  const more=await quietCoins(db,'settled',100n,null,[],[],settled.at(-1)!.address,2);
  expect(more.map(r=>Buffer.from(r.address))).toEqual([coin(3),coin(4)]);
});
it('drains the pending launch queue, retains existing snapshots and queues late historical launches',async()=>{
  for(let attempt=0;attempt<5;attempt++)await snapshotTrending(db,100n,1);
  expect((await db.sql.query('SELECT * FROM trending_snapshots')).rows).toHaveLength(5);
  expect((await db.sql.query('SELECT * FROM trending_snapshot_queue')).rows).toHaveLength(0);
  await db.insert('tokens',{address:coin(6),first_block:6,block:6});
  expect((await snapshotTrending(db,100n,1)).saved).toBe(1);
  expect((await db.sql.query('SELECT * FROM trending_snapshots WHERE created_block=6')).rows).toHaveLength(1);
});
