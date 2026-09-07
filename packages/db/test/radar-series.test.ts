import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { migrate, migrateEngines, type ChainDb } from '../src/index.js';
import { openDb } from './helpers/historical-db.js';
import { backfillRadarSeries } from '../../../scripts/backfill-radar-series.js';
const at=Date.parse('2026-10-17T12:00:00Z')/1000,coin=Buffer.alloc(20,7);
async function database() {
  const db=await openDb({pgliteDir:':memory:'});await migrate(db);await migrateEngines(db);
  await db.sql.query('INSERT INTO tokens(address,deployer,first_block,block) VALUES($1,$1,1,1)',[coin]);
  return db;
}
async function bars(db:ChainDb) {
  await db.sql.query(`INSERT INTO bars_1m(coin,minute,open,high,low,close,volume_usd,trades,first_block,last_block)
    SELECT $1,to_timestamp($2::double precision-m*60),m+1,m+1,m+1,m+1,m+10,2,1,1 FROM generate_series(0,600) m`,[coin,at]);
}
it('maintains bars on insert, correction, deletion, clock expiry and truncate, including coins listed later',async()=>{
  const db=await database();
  try {
    await bars(db);await db.sql.query('SELECT refresh_read_row_series($1::bytea[],$2)',[[coin],at]);
    const row=()=>db.sql.query('SELECT row_price,row_previous1h,row_volume,row_trades FROM read_coins WHERE coin=$1',[coin]).then(r=>r.rows[0]);
    await db.sql.query("INSERT INTO read_coins(coin,tier,activity,first_block,pair_column,pair_block) VALUES($1,2,to_timestamp($2),1,'new',1)",[coin,at]);
    expect(await row()).toEqual({row_price:1,row_previous1h:61,row_volume:2440,row_trades:122});
    const initial=(await db.sql.query<{points:number[]}>('SELECT points FROM read_row_series')).rows[0].points;
    expect(initial).toHaveLength(97);expect(initial[0]).toBe(477);expect(initial.at(-1)).toBe(1);
    await db.sql.query('UPDATE bars_1m SET close=9 WHERE coin=$1 AND minute=to_timestamp($2)',[coin,at]);
    await db.sql.query('SELECT refresh_read_row_series($1::bytea[],$2)',[[coin],at]);
    expect((await row()).row_price).toBe(9);
    await db.sql.query('DELETE FROM bars_1m WHERE coin=$1 AND minute=to_timestamp($2)',[coin,at]);
    await db.sql.query('SELECT refresh_read_row_series($1::bytea[],$2)',[[coin],at]);
    expect((await row()).row_price).toBe(2);
    await db.sql.query('SELECT refresh_read_row_series($1::bytea[],$2,false)',[[coin],at+9*3600]);
    expect((await db.sql.query<{points:number[]}>('SELECT points FROM read_row_series')).rows[0].points).toEqual([]);
    expect((await row()).row_volume).toBe(0);
    await db.sql.query('TRUNCATE bars_1m');expect((await row()).row_price).toBeNull();
  } finally {await db.close();}
});
it('backfills in rerunnable keyset batches and registers 0223 without raw scans or comment semicolons',async()=>{
  const db=await database();
  try {
    await db.sql.query('ALTER TABLE bars_1m DISABLE TRIGGER read_row_bars_insert');await bars(db);
    await db.sql.query('ALTER TABLE bars_1m ENABLE TRIGGER read_row_bars_insert');
    expect((await db.sql.query('SELECT points,revision FROM read_row_series')).rows).toEqual([{points:[],revision:0}]);
    expect(await backfillRadarSeries(db,1,at)).toEqual({coins:1});
    const before=(await db.sql.query('SELECT points,minutes,closes FROM read_row_series')).rows;
    await backfillRadarSeries(db,1,at);expect((await db.sql.query('SELECT points,minutes,closes FROM read_row_series')).rows).toEqual(before);
    await expect(backfillRadarSeries(db,0,at)).rejects.toThrow('Batch size');
    await migrateEngines(db);expect((await db.sql.query("SELECT id FROM eko_engine_migrations WHERE id='0223_radar_row_projection'")).rows).toHaveLength(1);
    const sql=await readFile(new URL('../drizzle/0223_radar_row_projection.sql',import.meta.url),'utf8');
    expect(/\b(?:FROM|JOIN)\s+(?:swaps|token_transfers)\b/i.test(sql)).toBe(false);
    expect(sql.split('\n').some(s=>s.trim().startsWith('--') && s.includes(';'))).toBe(false);
  } finally {await db.close();}
});
