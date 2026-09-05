import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { migrate, migrateEngines, type ChainDb } from '../src/index.js';
import { openDb } from './helpers/historical-db.js';

async function report(db:ChainDb) {
  const sql=await readFile(new URL('../../../scripts/blue-chip-report.sql',import.meta.url),'utf8');
  const results=[];
  for(const statement of sql.replace(/^--.*$/gm,'').split(';').map(s=>s.trim()).filter(Boolean)) {
    const result=await db.sql.query(statement);if(statement.startsWith('SELECT') || statement.startsWith('WITH'))results.push(result.rows);
  }
  return results;
}
describe('Blue chip operator report',()=>{
  it('returns 48 zero counts with an empty model',async()=>{
    const db=await openDb({pgliteDir:':memory:'});
    try {
      await migrate(db);await migrateEngines(db);const [coverage,grid,largest]=await report(db);
      expect(Number(coverage[0].listed_coins)).toBe(0);expect(grid).toHaveLength(48);
      expect(grid.every(r=>Number(r.rule_b_members)===0)).toBe(true);expect(largest).toEqual([]);
    } finally {await db.close();}
  });
  it('counts single-rule failures, missing data and stale cards and orders the top 15 on a 22000-coin model',async()=>{
    const db=await openDb({pgliteDir:':memory:'});
    try {
      await migrate(db);await migrateEngines(db);
      await db.sql.query(`INSERT INTO tokens(address,deployer,first_block,block)
        SELECT decode(lpad(to_hex(n),40,'0'),'hex'),decode(repeat('ff',20),'hex'),1,1 FROM generate_series(1,22000) n`);
      await db.sql.query(`INSERT INTO read_coins(coin,tier,activity,first_block,pair_column,pair_block)
        SELECT address,0,now(),1,'new',1 FROM tokens`);
      await db.sql.query(`INSERT INTO coin_cards(id,coin,valid_from_block,hash,data)
        SELECT encode(address,'hex'),address,1,'sample',jsonb_build_object('identity',jsonb_build_object('name',jsonb_build_object('text','Sample coin'),
        'symbol',jsonb_build_object('text','SAMPLE')),'verdict',jsonb_build_object('level',CASE WHEN address=decode(lpad(to_hex(2),40,'0'),'hex') THEN 'monitor' ELSE 'clear' END)) FROM tokens`);
      await db.sql.query('INSERT INTO coin_card_latest SELECT coin,id,1,data FROM coin_cards');
      await db.sql.query(`INSERT INTO read_blue_chip SELECT address,CASE WHEN n=8 THEN 0 ELSE 1 END,
        now()-CASE WHEN n=5 THEN interval '12 hours' ELSE interval '8 days' END,n<>4,
        CASE WHEN n=6 THEN 9999 WHEN n=9 THEN NULL ELSE 100000+n END,CASE WHEN n=7 THEN 99 WHEN n=9 THEN NULL ELSE 1000 END
        FROM tokens CROSS JOIN LATERAL(SELECT ('x'||right(encode(address,'hex'),8))::bit(32)::int AS n) a WHERE n<>10`);
      await db.sql.query("INSERT INTO read_blue_chip_danger VALUES(decode(lpad(to_hex(3),40,'0'),'hex'))");
      const started=performance.now();const [coverage,grid,largest]=await report(db);
      expect(performance.now()-started).toBeLessThan(10000);
      expect(Number(coverage[0].coins_with_read_blue_chip_row)).toBe(21999);
      expect(Number(coverage[0].coins_with_both_measurements)).toBe(21998);
      expect(grid).toHaveLength(48);const loose=grid[0];expect(Number(loose.rule_b_members)).toBe(21991);
      for(const key of ['clear','never_danger','real_pool','age','liquidity','holders','latest_measurements'])expect(Number(loose[`fail_only_${key}`])).toBe(1);
      expect(largest).toHaveLength(15);expect(largest[0]).toMatchObject({name:'Sample coin',symbol:'SAMPLE',liquidity_usd:122000});
      expect((await db.sql.query('SELECT count(*) AS n FROM read_blue_chip')).rows[0].n).toBe(21999);
    } finally {await db.close();}
  });
});
