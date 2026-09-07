import { expect, it } from 'vitest';
import { migrate, migrateEngines } from '../src/index.js';
import { openDb } from './helpers/historical-db.js';

it('upgrades populated 0220 databases without reading raw history and replays through the engines ledger',async()=>{
  const db=await openDb({pgliteDir:':memory:'}),coin=Buffer.alloc(20,7);
  try {
    await migrate(db);
    await db.sql.query('CREATE TABLE eko_engine_migrations(id text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
    await db.sql.query("INSERT INTO eko_engine_migrations(id) VALUES('0221_pool_prices_headers')");
    await migrateEngines(db);
    await db.sql.query('INSERT INTO tokens(address,deployer,first_block,block) VALUES($1,$1,1,1)',[coin]);
    await db.sql.query("INSERT INTO coin_cards(id,coin,valid_from_block,hash,data) VALUES('sample-card',$1,1,'sample-hash','{}')",[coin]);
    await db.sql.query("INSERT INTO coin_card_latest VALUES($1,'sample-card',1,'{}')",[coin]);
    await db.sql.query("DELETE FROM eko_engine_migrations WHERE id='0221_pool_prices_headers'");
    const query=db.sql.query.bind(db.sql),statements:string[]=[];
    db.sql.query=async<T>(sql:string,params?:unknown[])=>{statements.push(sql);return query<T>(sql,params);};
    await migrateEngines(db);
    expect(statements.some(s=>/\b(?:FROM|JOIN)\s+(?:swaps|token_transfers)\b/i.test(s))).toBe(false);
    expect((await db.sql.query('SELECT coin FROM read_coin_verdicts')).rows).toHaveLength(1);
    expect((await db.sql.query('SELECT * FROM coin_pool_prices')).rows).toEqual([]);
    await migrateEngines(db);
    expect((await db.sql.query("SELECT id FROM eko_engine_migrations WHERE id='0221_pool_prices_headers'")).rows).toHaveLength(1);
    expect((await db.sql.query("SELECT indexname FROM pg_indexes WHERE indexname='engine_runs_legacy_sec_coin'")).rows).toHaveLength(1);
  } finally {await db.close();}
});
