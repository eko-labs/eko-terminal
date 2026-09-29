import { ChainDb, migrate, migrateEngines, rebuildBalances, type SqlClient } from '@eko/db';
import { openDb } from '../../../packages/db/test/helpers/historical-db.js';

/**
 * A month of indexed history for live-poll cost checks: `idleCoins` coins that traded for a day or so between days 0
 * and 13 and then went quiet (outcomes already labeled), and `activeCoins` coins launched in the last week that trade
 * every half hour up to `now`. Two-second blocks; every block with a row has a stored header. No network.
 */
export const LIVE_EPOCH = Date.parse('2026-09-01T00:00:00Z') / 1000;
export const LIVE_B0 = 7_000_000;
export const liveBlock = (sec: number) => LIVE_B0 + Math.floor((sec - LIVE_EPOCH) / 2);
export interface LiveHistoryShape { idleCoins: number; idleTrades: number; activeCoins: number; days?: number }
export async function liveHistory(shape: LiveHistoryShape) {
  const db = await openDb({ pgliteDir: ':memory:' });
  await migrate(db); await migrateEngines(db); await db.ensurePartitions(new Date(LIVE_EPOCH * 1000));
  const days = shape.days ?? 30, now = LIVE_EPOCH + days * 86400;
  for(let day=0;day<=days;day++)await db.ensurePartitions(new Date((LIVE_EPOCH+day*86400)*1000));
  // Coins: ids 1..idle are idle, idle+1..idle+active are active. Launch times in seconds after the epoch.
  await db.sql.query(`INSERT INTO tokens(address,deployer,name,symbol,launchpad,decimals,total_supply,supply_block,first_block,block)
    SELECT decode(lpad(to_hex(1000+c),40,'0'),'hex'),decode(lpad(to_hex(900000+c),40,'0'),'hex'),'Sample coin','DEMO','other',0,1000000000,b,b,b
    FROM generate_series(1,$1::int) c CROSS JOIN LATERAL (SELECT CASE WHEN c<=$2::int THEN (c%13)*86400+600*(c%7) ELSE ($3::int-7)*86400+(c-$2::int)*43200 END AS launch) l
    CROSS JOIN LATERAL (SELECT $4::bigint+floor(l.launch/2)::bigint AS b) x`, [shape.idleCoins + shape.activeCoins, shape.idleCoins, days, LIVE_B0]);
  // Trades: idle coins every ten minutes from launch for idleTrades trades, active coins every half hour until an hour
  // before now. One swap and one transfer per trade, each from a wallet of its own coin.
  await db.sql.query(`CREATE TEMP TABLE fixture_trades AS SELECT c,j,(launch+60+j*step)::bigint AS sec FROM (
      SELECT c,CASE WHEN c<=$1::int THEN (c%13)*86400+600*(c%7) ELSE ($3::int-7)*86400+(c-$1::int)*43200 END AS launch,CASE WHEN c<=$1::int THEN 600 ELSE 1800 END AS step,
        CASE WHEN c<=$1::int THEN $2::int ELSE 0 END AS trades FROM generate_series(1,$1::int+$4::int) c) t
    CROSS JOIN LATERAL generate_series(0,CASE WHEN t.trades>0 THEN t.trades-1 ELSE floor((($3::int*86400-3600)-(launch+60))/step)::int END) j`,
  [shape.idleCoins, shape.idleTrades, days, shape.activeCoins]);
  await db.sql.query(`INSERT INTO swaps(ts,block,tx_hash,log_index,venue,pool_id,coin,quote_asset,trader,tx_from,tx_to,side,amount_coin,amount_quote,price_quote,usd,priced_block)
    SELECT to_timestamp($1::bigint+sec),$2::bigint+sec/2,decode(lpad(to_hex(c*100000+j),64,'0'),'hex'),0,'uniswap_v3',decode(lpad(to_hex(500000+c),40,'0'),'hex'),
      decode(lpad(to_hex(1000+c),40,'0'),'hex'),decode(repeat('00',20),'hex'),w,w,decode(lpad(to_hex(500000+c),40,'0'),'hex'),
      CASE WHEN j%2=0 THEN 1 ELSE -1 END,100,100,1+(j%5)*0.03,25,$2::bigint+sec/2
    FROM fixture_trades CROSS JOIN LATERAL (SELECT decode(lpad(to_hex(2000000+c*10+j%10),40,'0'),'hex') AS w) x`, [LIVE_EPOCH, LIVE_B0]);
  await db.sql.query(`INSERT INTO token_transfers(ts,block,tx_hash,log_index,token,from_address,to_address,amount)
    SELECT to_timestamp($1::bigint+sec),$2::bigint+sec/2,decode(lpad(to_hex(c*100000+j),64,'0'),'hex'),1,decode(lpad(to_hex(1000+c),40,'0'),'hex'),
      decode(lpad(to_hex(500000+c),40,'0'),'hex'),decode(lpad(to_hex(2000000+c*10+j%10),40,'0'),'hex'),100
    FROM fixture_trades`, [LIVE_EPOCH, LIVE_B0]);
  await db.sql.query(`INSERT INTO chain_blocks(number,block,hash,parent_hash,ts) SELECT b,b,decode(lpad(to_hex(b),64,'0'),'hex'),decode(lpad(to_hex(b-1),64,'0'),'hex'),to_timestamp($1::bigint+(b-$2::bigint)*2)
    FROM (SELECT DISTINCT $2::bigint+sec/2 AS b FROM fixture_trades UNION SELECT first_block FROM tokens) x ON CONFLICT DO NOTHING`, [LIVE_EPOCH, LIVE_B0]);
  // Quiet coins' outcomes are labeled, as they would be long after their horizons.
  await db.sql.query(`INSERT INTO outcomes SELECT address,h,first_block,'survived','{"evidence":[]}' FROM tokens CROSS JOIN unnest(ARRAY['1h','24h','7d']) h
    WHERE address<=decode(lpad(to_hex(1000+$1::int),40,'0'),'hex')`, [shape.idleCoins]);
  await db.sql.query('DROP TABLE fixture_trades');
  await db.tx(tx => rebuildBalances(tx));
  let id = 0;
  return {
    db, now,
    rows: async () => Number((await db.sql.query<{ n: string }>('SELECT (SELECT count(*) FROM swaps)+(SELECT count(*) FROM token_transfers)+(SELECT count(*) FROM engine_block_times) AS n')).rows[0]!.n),
    /** One more trade of active coin `index` (1-based) at `sec`, with its header. */
    trade: async (index: number, sec: number) => {
      const c = shape.idleCoins + index, block = liveBlock(sec), wallet = 3000000 + id;
      await db.sql.query(`INSERT INTO chain_blocks(number,block,hash,parent_hash,ts) VALUES($1::bigint,$1::bigint,decode(lpad(to_hex($1::bigint),64,'0'),'hex'),decode(lpad(to_hex($1::bigint-1),64,'0'),'hex'),to_timestamp($2::bigint)) ON CONFLICT DO NOTHING`, [block, sec]);
      await db.sql.query(`INSERT INTO swaps(ts,block,tx_hash,log_index,venue,pool_id,coin,quote_asset,trader,tx_from,tx_to,side,amount_coin,amount_quote,price_quote,usd,priced_block)
        VALUES(to_timestamp($1::bigint),$2::bigint,decode(lpad(to_hex($3::bigint),64,'0'),'hex'),0,'uniswap_v3',decode(lpad(to_hex(500000+$4::int),40,'0'),'hex'),decode(lpad(to_hex(1000+$4::int),40,'0'),'hex'),
          decode(repeat('00',20),'hex'),decode(lpad(to_hex($5::int),40,'0'),'hex'),decode(lpad(to_hex($5::int),40,'0'),'hex'),decode(lpad(to_hex(500000+$4::int),40,'0'),'hex'),1,100,100,1.2,25,$2::bigint)`,
      [sec, block, 900000000 + id, c, wallet]);
      await db.sql.query(`INSERT INTO token_transfers(ts,block,tx_hash,log_index,token,from_address,to_address,amount) VALUES(to_timestamp($1::bigint),$2::bigint,decode(lpad(to_hex($3::bigint),64,'0'),'hex'),1,
        decode(lpad(to_hex(1000+$4::int),40,'0'),'hex'),decode(lpad(to_hex(500000+$4::int),40,'0'),'hex'),decode(lpad(to_hex($5::int),40,'0'),'hex'),100)`, [sec, block, 900000000 + id, c, wallet]);
      id++;
    },
  };
}
/** A handle on the same database that counts the rows every query returns (what a poll loads into memory). */
export function counting(db: ChainDb) {
  const count = { rows: 0, queries: 0 };
  const wrap = (sql: SqlClient): SqlClient => ({
    query: async <T,>(text: string, params?: unknown[]) => { const result = await sql.query<T>(text, params); count.rows += result.rows.length; count.queries++; return result; },
  });
  return { db: new ChainDb(wrap(db.sql), fn => db.tx(tx => fn(wrap(tx.sql)))), count };
}
