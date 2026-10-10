import { expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { migrate, migrateEngines, binary } from '@eko/db';
import { openDb } from '../../../packages/db/test/helpers/historical-db.js';
import { backfillPoolPrices } from '../../../scripts/backfill-pool-prices.js';
import { LIQUIDITY_PRICE_SQL } from '../src/read/liquidity-model.js';
import { HEADER_COUNTS_SQL, HEADER_TODAY_SQL, HEADER_HOURS_SQL, GUARD_HEADER_TODAY_SQL, GUARD_LIVE_COINS_SQL } from '../src/read/header-totals.js';
import { OLD_LIQUIDITY_PRICE_SQL } from './header-price-baseline.js';

const now=Date.parse('2026-10-17T12:00:00Z'),address=(n:number)=>`0x${n.toString(16).padStart(40,'0')}`,pool=(n:number)=>`0x${n.toString(16).padStart(64,'0')}`;
it('maintains multi-pool prices in chain order, repairs prices, caps cold probes, and backfills idempotently',async()=>{
  const db=await openDb({pgliteDir:':memory:'});
  try {
    await migrate(db);await migrateEngines(db);await db.ensurePartitions(new Date(now));
    await db.sql.query(`INSERT INTO tokens(address,deployer,first_block,block,launchpad)
      SELECT decode(lpad(to_hex(n),40,'0'),'hex'),decode(repeat('01',20),'hex'),1,1,'other' FROM generate_series(1,4) n`);
    // Each coin has 1-4 pools. An inactive pool's last priced trade is more than 200 positive trades behind.
    await db.sql.query(`INSERT INTO swaps(ts,block,tx_hash,log_index,venue,pool_id,coin,quote_asset,side,amount_coin,amount_quote,usd)
      SELECT to_timestamp($1::double precision-b),b,decode(lpad(to_hex(c*1000+b),64,'0'),'hex'),0,'uniswap_v4',
        decode(lpad(to_hex(c*10+CASE WHEN b>4 THEN 0 ELSE (b-1)%c END),64,'0'),'hex'),decode(lpad(to_hex(c),40,'0'),'hex'),decode(repeat('00',20),'hex'),1,100,400,b
      FROM generate_series(1,4) c CROSS JOIN generate_series(1,220) b`,[now/1000]);
    const keys=Array.from({length:4},(_,i)=>i+1).flatMap(c=>[...Array.from({length:c},(_,p)=>({coin:address(c),pool:pool(c*10+p)})),{coin:address(c),pool:null}]);
    const query=(sql:string)=>db.sql.query(sql,[JSON.stringify(keys)]).then(r=>r.rows);
    const expected=await query(OLD_LIQUIDITY_PRICE_SQL);
    expect(await query(LIQUIDITY_PRICE_SQL)).toEqual(expected);
    await db.sql.query('UPDATE swaps SET usd=999 WHERE coin=$1 AND block=220',[binary(address(4))]);
    expect(await query(LIQUIDITY_PRICE_SQL)).toEqual(await query(OLD_LIQUIDITY_PRICE_SQL));
    // An invalidated winning trade cannot remain visible, nor can an older repair replace the latest trade.
    await db.sql.query('UPDATE swaps SET usd=0 WHERE coin=$1 AND block=220',[binary(address(4))]);
    expect(await query(LIQUIDITY_PRICE_SQL)).toEqual(await query(OLD_LIQUIDITY_PRICE_SQL));
    await db.sql.query('UPDATE swaps SET usd=111 WHERE coin=$1 AND block=50',[binary(address(4))]);
    expect(await query(LIQUIDITY_PRICE_SQL)).toEqual(await query(OLD_LIQUIDITY_PRICE_SQL));
    await db.sql.query('UPDATE swaps SET usd=555 WHERE coin=$1 AND block=219',[binary(address(4))]);
    await db.sql.query('DELETE FROM swaps WHERE coin=$1 AND block=219',[binary(address(4))]);
    expect(await query(LIQUIDITY_PRICE_SQL)).toEqual(await query(OLD_LIQUIDITY_PRICE_SQL));
    // A cold key beyond the hard cap deliberately has no raw fallback price until backfill.
    await db.sql.query('DELETE FROM coin_pool_prices');
    const cold=(await db.sql.query<{trade:unknown}>(LIQUIDITY_PRICE_SQL,[JSON.stringify([{coin:address(4),pool:pool(41)}])])).rows[0];
    expect(cold.trade).toBeNull();
    const batches:number[]=[];
    expect((await backfillPoolPrices(db,2,n=>batches.push(n))).coins).toBe(4);
    expect(batches).toEqual([2,4]);
    expect(await query(LIQUIDITY_PRICE_SQL)).toEqual(await query(OLD_LIQUIDITY_PRICE_SQL));
    const filled=(await db.sql.query('SELECT * FROM coin_pool_prices ORDER BY coin,pool_id')).rows;
    await backfillPoolPrices(db,1);
    expect((await db.sql.query('SELECT * FROM coin_pool_prices ORDER BY coin,pool_id')).rows).toEqual(filled);
    await expect(backfillPoolPrices(db,0)).rejects.toThrow('Batch size');
    const migration=await readFile(new URL('../../../packages/db/drizzle/0221_pool_prices_headers.sql',import.meta.url),'utf8');
    expect(/\b(?:FROM|JOIN)\s+(?:swaps|token_transfers)\b/i.test(migration)).toBe(false);
    expect(migration.split('\n').some(s=>s.trim().startsWith('--') && s.includes(';'))).toBe(false);
  } finally {await db.close();}
});

it('includes card-only coins without duplicating projections and returns 24 distinct-coin hourly buckets',async()=>{
  const db=await openDb({pgliteDir:':memory:'});
  try {
    await migrate(db);await migrateEngines(db);
    await db.sql.query(`INSERT INTO tokens(address,deployer,first_block,block,launchpad)
      SELECT decode(lpad(to_hex(n),40,'0'),'hex'),decode(repeat('01',20),'hex'),1,1,'other' FROM generate_series(1,3) n`);
    await db.sql.query(`INSERT INTO read_coins(coin,tier,activity,first_block,pair_column,pair_block)
      SELECT address,2,to_timestamp($1::double precision),1,'new',1 FROM tokens WHERE address<>$2`,[now/1000,binary(address(3))]);
    const cutoff=new Date(now-7*86400000),counts=()=>db.sql.query(HEADER_COUNTS_SQL,[cutoff]).then(r=>r.rows[0]);
    expect(await counts()).toMatchObject({coins:2,no_verdict:2,incomplete:0});
    await db.sql.query("INSERT INTO coin_cards(id,coin,valid_from_block,hash,data) VALUES('sample-card',$1,1,'sample-hash','{}')",[binary(address(1))]);
    await db.sql.query("INSERT INTO coin_card_latest VALUES($1,'sample-card',1,'{}')",[binary(address(1))]);
    expect(await counts()).toMatchObject({coins:2,no_verdict:1,incomplete:1});
    await db.sql.query("UPDATE coin_card_latest SET data='{\"verdict\":{\"level\":\"pending\"}}'");
    expect(await counts()).toMatchObject({no_verdict:1,incomplete:1});
    await db.sql.query("INSERT INTO coin_cards(id,coin,valid_from_block,hash,data) VALUES('pending-card',$1,1,'pending-hash','{}')",[binary(address(3))]);
    await db.sql.query("INSERT INTO coin_card_latest VALUES($1,'pending-card',1,'{\"verdict\":{\"level\":\"danger\"}}')",[binary(address(3))]);
    await db.sql.query('DELETE FROM read_coins WHERE coin=$1',[binary(address(3))]);
    expect(await counts()).toMatchObject({coins:3,no_verdict:1,incomplete:1,high:1});
    expect((await db.sql.query(GUARD_LIVE_COINS_SQL,[cutoff])).rows).toHaveLength(3);
    await db.sql.query("INSERT INTO read_coins(coin,tier,activity,first_block,pair_column,pair_block) VALUES($1,3,$2,1,'new',1)",[binary(address(3)),new Date(now)]);
    expect(await counts()).toMatchObject({coins:3,no_verdict:1,high:1});
    await db.sql.query('DELETE FROM read_coins WHERE coin=$1',[binary(address(3))]);
    await db.sql.query(`INSERT INTO engine_runs(coin,block,sec,created_at)
      SELECT decode(lpad(to_hex(c),40,'0'),'hex'),b,$1::bigint,to_timestamp($1::double precision-b*3600)
      FROM generate_series(1,3) c CROSS JOIN generate_series(1,2) b`,[now/1000]);
    // Two runs of the same coin in an hour still count as one. Null created_at uses the indexed legacy path.
    await db.sql.query('INSERT INTO engine_runs(coin,block,sec,created_at) VALUES($1,3,$2,NULL)',[binary(address(1)),now/1000-3600]);
    await db.sql.query("INSERT INTO verdicts(id,coin,valid_from_block,rules_version,signature,data) VALUES('sample-danger',$1,1,'1.0.0','sample-signature','{\"level\":\"danger\"}')",[binary(address(1))]);
    const today=(await db.sql.query(HEADER_TODAY_SQL,[now/1000-12*3600,now/1000+12*3600,cutoff])).rows[0];
    expect(Number(today.n)).toBe(2);
    const guardToday=(await db.sql.query(GUARD_HEADER_TODAY_SQL,[now/1000-12*3600,now/1000+12*3600,cutoff])).rows[0];
    expect(Number(guardToday.n)).toBe(3);
    const hours=(await db.sql.query<{h:number;n:string;danger:string}>(HEADER_HOURS_SQL,[now/1000-23*3600,cutoff])).rows;
    expect(hours).toHaveLength(24);expect(hours[22]).toEqual({h:22,n:2,danger:1});expect(Number(hours[21].n)).toBe(2);
    await db.sql.query('DELETE FROM coin_card_latest');
    expect(await counts()).toMatchObject({no_verdict:2,incomplete:0});
  } finally {await db.close();}
});
