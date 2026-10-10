import { expect, it } from 'vitest';
import { migrate, migrateEngines, binary } from '@eko/db';
import { openDb } from '../../../packages/db/test/helpers/historical-db.js';
import { ReadStore } from '../src/read/store.js';
import { RowProjectionCache, serializeRadarRow } from '../src/read/row-cache.js';
import { BaselineRows } from './radar-row-baseline.js';
import { seedReadFixture } from './read-fixture.js';
const now=Date.parse('2026-10-17T12:00:00Z');
it('byte-matches the original row and card, reuses revisions, and refreshes repairs and identity changes',async()=>{
  const db=await openDb({pgliteDir:':memory:'});
  try {
    await migrate(db);await migrateEngines(db);const card=await seedReadFixture(db,now),coin=card.identity.address;
    const current=new ReadStore(db,()=>now),baseline=new BaselineRows(db,()=>now);
    const compare=async()=>{
      const expected=await baseline.rows(coin),actual=await current.rows(coin);
      expect(actual).toEqual(expected);
      expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
      expect(serializeRadarRow(actual[0].row)).toBe(JSON.stringify(expected[0].row));return actual;
    };
    // Thin launches reuse trade points until a source/identity revision changes, even without a new bar.
    await compare();
    await db.sql.query('UPDATE swaps SET usd=usd*2 WHERE coin=$1',[binary(coin)]);await compare();
    await db.sql.query('UPDATE tokens SET decimals=17 WHERE address=$1',[binary(coin)]);await compare();
    await db.sql.query('UPDATE tokens SET decimals=18 WHERE address=$1',[binary(coin)]);
    await db.sql.query(`INSERT INTO bars_1m(coin,minute,open,high,low,close,volume_usd,trades,first_block,last_block)
      SELECT $1,to_timestamp($2::double precision-m*60),1,1,1,1+m/1000.0,m+1,3,1,1 FROM generate_series(0,479) m
      ON CONFLICT(coin,minute) DO UPDATE SET close=excluded.close,volume_usd=excluded.volume_usd,trades=excluded.trades`,[binary(coin),now/1000]);
    await compare();expect(current.rowCache.size).toBe(1);
    const query=db.sql.query.bind(db.sql),sql:string[]=[];
    db.sql.query=async<T>(statement:string,params?:unknown[])=>{sql.push(statement);return query<T>(statement,params);};
    const again=await current.rows(coin);
    expect(sql.some(s=>s.includes('FROM bars_1m') || s.includes('JOIN coin_card_latest') || s.includes('jsonb_agg'))).toBe(false);
    // Returned cards are independent overlays. Mutating an overlay's freshness must not poison the cached base.
    again[0].card!.freshness.ageSec=999999;await compare();
    await db.sql.query("UPDATE coin_card_latest SET data=jsonb_set(data,'{verdict,reasons}','[\"updated measurement\"]') WHERE coin=$1",[binary(coin)]);
    await compare();
    await db.sql.query("UPDATE tokens SET name='Changed fixture',symbol='NEXT' WHERE address=$1",[binary(coin)]);await compare();
    current.now=baseline.now=()=>now+61*60*1000;await compare();
  } finally {await db.close();}
});
it('bounds cached revisions by entries and bytes and replaces obsolete revisions',()=>{
  const cache=new RowProjectionCache();
  for(let i=0;i<cache.maxEntries+20;i++)cache.set(String(i),'1',null,'Sample','DEMO');
  expect(cache.size).toBe(cache.maxEntries);expect(cache.get('0','1')).toBeUndefined();
  const existing=cache.get('20','1');expect(existing).toBeDefined();
  expect(cache.set('20','1',{invalid:'duplicate load'},'Ignored','IGNORED')).toBe(existing);
  cache.set('20','2',null,'Next','NEXT');
  expect(cache.get('20','1')).toBeUndefined();expect(cache.get('20','2')).toBeDefined();
  expect(cache.byteSize).toBeLessThanOrEqual(cache.maxBytes);
  const byteBound=new RowProjectionCache(2048,9000);
  for(let i=0;i<3;i++)byteBound.set(String(i),'1',null,'Sample','DEMO');
  expect(byteBound.size).toBeLessThan(3);expect(byteBound.byteSize).toBeLessThanOrEqual(9000);
  expect(byteBound.get('0','1')).toBeUndefined();
  const oversized=new RowProjectionCache(2048,1);
  oversized.set('sample','1',null,'Sample','DEMO');expect(oversized.size).toBe(0);
});
