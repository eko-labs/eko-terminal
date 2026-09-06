import { afterAll, beforeAll, expect, it } from 'vitest';
import { binary, maintainedBalance, migrate, openDb } from '../src/index.js';
let db:Awaited<ReturnType<typeof openDb>>;
const token=`0x${'11'.repeat(20)}`,holder=`0x${'22'.repeat(20)}`,hash=binary(`0x${'33'.repeat(32)}`);
beforeAll(async()=>{db=await openDb({pgliteDir:':memory:'});await migrate(db);
  await db.sql.query('INSERT INTO chain_blocks VALUES(1,1,$1,$1,now())',[hash]);
  await db.sql.query('INSERT INTO balances VALUES($1,$2,12345678901234567890,1)',[binary(token),binary(holder)]);
});
afterAll(async()=>{await db.close();});
it('falls back when a maintained value is only a transfer delta',async()=>{
  expect(await maintainedBalance(db,token,holder,1n)).toBeNull();
});
it('requires canonical launch/mint coverage and an ingested requested block',async()=>{
  await db.sql.query('INSERT INTO token_balance_origins VALUES($1,1,$2)',[binary(token),hash]);
  expect(await maintainedBalance(db,token,holder,1n)).toBeNull();
  await db.sql.query("INSERT INTO ingest_cursors VALUES('head_logs',2,NULL)");
  expect(await maintainedBalance(db,token,holder,1n)).toBe(12345678901234567890n);
  expect(await maintainedBalance(db,token,holder,2n)).toBe(12345678901234567890n);
  expect(await maintainedBalance(db,token,holder,3n)).toBeNull();
});
it('does not reuse an ahead-of-block balance or invent a missing holder zero',async()=>{
  expect(await maintainedBalance(db,token,holder,0n)).toBeNull();
  expect(await maintainedBalance(db,token,token,1n)).toBeNull();
  await db.sql.query('UPDATE balances SET last_block=2');
  expect(await maintainedBalance(db,token,holder,1n)).toBeNull();
});
it('invalidates orphaned launch coverage',async()=>{
  await db.sql.query('UPDATE chain_blocks SET hash=$1',[binary(`0x${'44'.repeat(32)}`)]);
  expect(await maintainedBalance(db,token,holder,2n)).toBeNull();
});
