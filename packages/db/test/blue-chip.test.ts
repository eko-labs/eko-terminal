import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { binary, migrate, migrateEngines, } from '../src/index.js';
import { openDb } from './helpers/historical-db.js';
describe('Blue chip engine migration',()=>{
  it('supports additional listing sources and keeps danger observations across rating changes',async()=>{
    const db=await openDb({pgliteDir:':memory:'});
    try{
      await migrate(db);await migrateEngines(db);
      const coin=binary(`0x${'11'.repeat(20)}`);
      for(const source of ['coingecko','sample-source'])await db.sql.query('INSERT INTO coin_listings(coin,source,external_id) VALUES($1,$2,$3)',[coin,source,'sample']);
      expect((await db.sql.query('SELECT source FROM coin_listings ORDER BY source')).rows).toHaveLength(2);
      await db.sql.query("INSERT INTO verdicts VALUES('sample-danger',$1,1,'sample','sample','{\"level\":\"danger\"}')",[coin]);
      await db.sql.query("INSERT INTO verdicts VALUES('sample-clear',$1,2,'sample','sample','{\"level\":\"clear\"}')",[coin]);
      expect((await db.sql.query('SELECT coin FROM read_blue_chip_danger WHERE coin=$1',[coin])).rows).toHaveLength(1);
      await migrateEngines(db);expect((await db.sql.query('SELECT coin FROM read_blue_chip_danger')).rows).toHaveLength(1);
    }finally{await db.close();}
  });
  it('contains no comment semicolons and is registered in the engine ledger',async()=>{
    const sql=await readFile(new URL('../drizzle/0200_blue_chip.sql',import.meta.url),'utf8');
    for(const line of sql.split('\n').filter(l=>l.trim().startsWith('--')))expect(line).not.toContain(';');
    expect(await readFile(new URL('../src/engines-migrate.ts',import.meta.url),'utf8')).toContain("'0200_blue_chip'");
  });
});
