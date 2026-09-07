import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { binary, migrate, migrateEngines, readRatingPrices } from '../src/index.js';
import { openDb } from './helpers/historical-db.js';
// The backfill runs by hand on production (no lock on swaps), so tests run the same script after the migration.
const backfill=async(db:Awaited<ReturnType<typeof openDb>>)=>{
  const sql=readFileSync(new URL('../../../scripts/backfill-rating-checks.sql',import.meta.url),'utf8').split('\n').filter(l=>!l.startsWith('--')).join('\n');
  for(const statement of sql.split(/;\s*(?:\n|$)/).map(x=>x.trim()).filter(Boolean))await db.sql.query(statement);
};
const address=(n:number)=>`0x${n.toString(16).padStart(40,'0')}` as const;
const hash=(n:number)=>`0x${n.toString(16).padStart(64,'0')}` as const;
it('retains the swap peak when history is pruned and repairs an orphan peak on rollback',async()=>{
  const db=await openDb({pgliteDir:':memory:'}),coin=address(1),zero=address(0),epoch=Date.parse('2026-10-01T00:00:00Z');
  try {
    await migrate(db);await migrateEngines(db);await db.ensurePartitions(new Date(epoch));
    await db.insert('tokens',{address:binary(coin),decimals:0,first_block:1,block:1});
    for(const [block,usd] of [[1,10],[2,100],[3,20]] as const) {
      await db.insert('chain_blocks',{number:block,block,hash:binary(hash(block)),parent_hash:binary(hash(block-1)),ts:new Date(epoch+block*1000)});
      await db.insert('swaps',{coin:binary(coin),block,ts:new Date(epoch+block*1000),tx_hash:binary(hash(block)),log_index:0,pool_id:binary(coin),quote_asset:binary(zero),venue:'uniswap_v3',side:1,amount_coin:'10',amount_quote:'1',price_quote:1,usd});
    }
    expect((await readRatingPrices(db,[coin])).get(coin)).toMatchObject({price:2,peak:10});
    await db.tx(tx=>tx.deleteAbove(1n));
    expect((await readRatingPrices(db,[coin])).get(coin)).toMatchObject({price:1,peak:1});
    await db.sql.query('DELETE FROM swaps WHERE coin=$1',[binary(coin)]);
    expect((await readRatingPrices(db,[coin])).get(coin)).toMatchObject({price:1,peak:1});
  } finally {await db.close();}
});
it('backfills a retained minute peak even when all raw swaps have already been removed',async()=>{
  const db=await openDb({pgliteDir:':memory:'}),coin=address(2);
  try {
    await migrate(db);await migrateEngines(db);
    await db.insert('tokens',{address:binary(coin),decimals:0,first_block:1,block:1});
    await db.sql.query("INSERT INTO bars_1m VALUES($1,'2026-10-01T00:00:00Z',10,100,10,15,10,1,1,1)",[binary(coin)]);
    for(const sql of ['DROP TRIGGER rating_prices_insert ON swaps','DROP TRIGGER rating_prices_update ON swaps','DROP FUNCTION rating_prices_changed()','DROP TABLE coin_rating_checks','DROP TABLE coin_rating_prices',"DELETE FROM eko_engine_migrations WHERE id='0203_rating_checks'"])await db.sql.query(sql);
    await migrateEngines(db);await backfill(db);
    expect((await readRatingPrices(db,[coin])).get(coin)).toMatchObject({price:15,peak:100});
  } finally {await db.close();}
});
it('backfills the immutable verdict price from retained swap samples, independently of an advanced mutable card block',async()=>{
  const db=await openDb({pgliteDir:':memory:'}),coin=address(3);
  try {
    await migrate(db);await migrateEngines(db);
    await db.insert('tokens',{address:binary(coin),decimals:0,first_block:1,block:1});
    const data={verdict:{asOfBlock:2,receipt:{id:'baseline-verdict'}}};
    await db.sql.query("INSERT INTO verdicts VALUES('baseline-verdict',$1,1,'1.0.2','fixture','{}')",[binary(coin)]);
    await db.sql.query("INSERT INTO coin_cards VALUES('baseline-card',$1,2,'fixture',$2,'1.0.2')",[binary(coin),JSON.stringify(data)]);
    await db.sql.query("INSERT INTO coin_card_latest VALUES($1,'baseline-card',2,$2)",[binary(coin),JSON.stringify(data)]);
    const tail=[{pool_id:coin,block:'1',log_index:0,tx_hash:hash(1),amount_coin:'10',amount_quote:'1',usd:100,ts:'2026-10-01T00:00:01Z'}];
    await db.sql.query('INSERT INTO coin_lifetime(coin,data) VALUES($1,$2)',[binary(coin),JSON.stringify({tail})]);
    for(const sql of ['DROP TRIGGER rating_prices_insert ON swaps','DROP TRIGGER rating_prices_update ON swaps','DROP FUNCTION rating_prices_changed()','DROP TABLE coin_rating_checks','DROP TABLE coin_rating_prices',"DELETE FROM eko_engine_migrations WHERE id='0203_rating_checks'"])await db.sql.query(sql);
    await migrateEngines(db);await backfill(db);
    expect((await db.sql.query('SELECT checked_block,full_block,full_price FROM coin_rating_checks')).rows[0]).toMatchObject({checked_block:2,full_block:1,full_price:10});
  } finally {await db.close();}
});
