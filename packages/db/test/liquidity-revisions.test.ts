import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { migrate, openDb } from '../src/client.js';
import { migrateEngines } from '../src/engines-migrate.js';

it('upgrades populated retained prices without raw scans, and separates price-tail and position revisions',async()=>{
  const db=await openDb({pgliteDir:':memory:'}),coin=Buffer.alloc(20,1),pool=`0x${'02'.repeat(32)}`;
  try {
    await migrate(db);
    await db.sql.query('CREATE TABLE eko_engine_migrations(id text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
    await db.sql.query("INSERT INTO eko_engine_migrations(id) VALUES('0217_liquidity_revisions'),('0218_card_projection_sync')");
    await migrateEngines(db);
    const trade={pool_id:pool,block:10,log_index:0,tx_hash:`0x${'03'.repeat(32)}`,amount_coin:'100',amount_quote:'400',usd:8};
    const data={tail:[trade],lastPositivePriced:trade,liquidity:{[pool]:{fullRangeDelta:'500'}}};
    await db.sql.query('INSERT INTO coin_lifetime(coin,data) VALUES($1,$2)',[coin,JSON.stringify(data)]);
    await db.sql.query("DELETE FROM eko_engine_migrations WHERE id IN ('0217_liquidity_revisions','0218_card_projection_sync')");
    const query=db.sql.query.bind(db.sql),statements:string[]=[];
    db.sql.query=async<T>(sql:string,params?:unknown[])=>{statements.push(sql);return query<T>(sql,params);};
    await migrateEngines(db);
    expect(statements.some(s=>/\b(?:FROM|JOIN)\s+(?:swaps|token_transfers)\b/i.test(s))).toBe(false);
    const migration=await readFile(new URL('../drizzle/0217_liquidity_revisions.sql',import.meta.url),'utf8');
    expect(migration.split('\n').filter(s=>s.trim().startsWith('--')).some(s=>s.includes(';'))).toBe(false);
    const price=async()=>(await db.sql.query<{prices:Record<string,{usd:number}>}>('SELECT prices FROM read_liquidity_retained WHERE coin=$1',[coin])).rows[0].prices[pool].usd;
    expect(await price()).toBe(8);
    trade.usd=16;
    await db.sql.query('UPDATE coin_lifetime SET data=$2 WHERE coin=$1',[coin,JSON.stringify(data)]);
    expect(await price()).toBe(16);
    expect((await db.sql.query('SELECT revision FROM read_liquidity_versions WHERE coin=$1',[coin])).rows).toEqual([]);
    data.liquidity[pool].fullRangeDelta='250';
    await db.sql.query('UPDATE coin_lifetime SET data=$2 WHERE coin=$1',[coin,JSON.stringify(data)]);
    expect((await db.sql.query('SELECT revision FROM read_liquidity_versions WHERE coin=$1',[coin])).rows).toHaveLength(1);
    await db.sql.query('DELETE FROM coin_lifetime WHERE coin=$1',[coin]);
    expect((await db.sql.query('SELECT coin FROM read_liquidity_retained WHERE coin=$1',[coin])).rows).toEqual([]);
  } finally {await db.close();}
});

it('upgrades existing token mutexes and synchronously maintains card eligibility and pair stages',async()=>{
  const db=await openDb({pgliteDir:':memory:'}),coin=Buffer.alloc(20,4),next=Buffer.alloc(20,5);
  try {
    await migrate(db);
    await db.sql.query('CREATE TABLE eko_engine_migrations(id text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
    await db.sql.query("INSERT INTO eko_engine_migrations(id) VALUES('0218_card_projection_sync')");
    await migrateEngines(db);
    await db.sql.query("INSERT INTO tokens(address,deployer,first_block,block,launchpad) VALUES($1,$1,1,1,'pons')",[coin]);
    expect((await db.sql.query('SELECT coin FROM read_projection_locks WHERE coin=$1',[coin])).rows).toEqual([]);
    await db.sql.query("DELETE FROM eko_engine_migrations WHERE id='0218_card_projection_sync'");
    await migrateEngines(db);
    expect((await db.sql.query('SELECT coin FROM read_projection_locks WHERE coin=$1',[coin])).rows).toHaveLength(1);
    await db.sql.query("INSERT INTO tokens(address,deployer,first_block,block,launchpad) VALUES($1,$1,1,1,'pons')",[next]);
    expect((await db.sql.query('SELECT coin FROM read_projection_locks WHERE coin=$1',[next])).rows).toHaveLength(1);
    await db.sql.query('INSERT INTO chain_blocks VALUES(1,1,$1,$1,now())',[Buffer.alloc(32)]);
    const data={identity:{curvePct:75},verdict:{level:'pending'}};
    await db.sql.query("INSERT INTO coin_cards(id,coin,valid_from_block,hash,data) VALUES('sample-card',$1,1,'sample-hash',$2)",[coin,JSON.stringify(data)]);
    await db.sql.query("INSERT INTO coin_card_latest VALUES($1,'sample-card',1,$2)",[coin,JSON.stringify(data)]);
    const projected=async()=>(await db.sql.query('SELECT tier,pair_column FROM read_coins WHERE coin=$1',[coin])).rows;
    expect(await projected()).toEqual([{tier:2,pair_column:'near_grad'}]);
    data.identity.curvePct=50;data.verdict.level='clear';
    await db.sql.query('UPDATE coin_card_latest SET data=$2 WHERE coin=$1',[coin,JSON.stringify(data)]);
    expect(await projected()).toEqual([{tier:0,pair_column:'new'}]);
    await db.sql.query('DELETE FROM coin_card_latest WHERE coin=$1',[coin]);
    expect(await projected()).toEqual([{tier:2,pair_column:'new'}]);
    expect((await db.sql.query('SELECT coin FROM read_dirty WHERE coin=$1',[coin])).rows).toHaveLength(1);
    const migration=await readFile(new URL('../drizzle/0218_card_projection_sync.sql',import.meta.url),'utf8');
    expect(migration.split('\n').filter(s=>s.trim().startsWith('--')).some(s=>s.includes(';'))).toBe(false);
    expect(/\b(?:FROM|JOIN)\s+(?:swaps|token_transfers)\b/i.test(migration)).toBe(false);
  } finally {await db.close();}
});
