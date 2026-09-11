import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { binary, migrate, migrateEngines } from '../src/index.js';
import { openDb } from './helpers/historical-db.js';
const coin = (n: number) => binary(`0x${n.toString(16).padStart(40, '0')}`);

it('measures UTC-day repeats, idle sellable checks, and first retained live/unlisted checks with read-only SQL', async () => {
  const db = await openDb({ pgliteDir: ':memory:' });
  try {
    await migrate(db); await migrateEngines(db);
    for (let n = 1; n <= 9; n++) await db.insert('tokens', { address: coin(n), first_block: 1, block: 1 });
    for (const n of [1, 5]) await db.sql.query("INSERT INTO read_coins(coin,tier,activity,first_block,pair_column,pair_block) VALUES($1,2,now(),1,'new',1)", [coin(n)]);
    const run = (n: number, status: string, age: string, block: number, requests = 4) => db.sql.query(
      `INSERT INTO sell_check_runs(coin,block,checked_at,status,requests,data) VALUES($1,$2,date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'-$3::interval,$4,$5,'{}')`,
      [coin(n), block, age, status, requests]);
    await run(1, 'unsupported', '1 day', 1);
    await run(2, 'buy_failed', '6 days', 1);
    await run(3, 'unsupported', '8 days', 1);
    await run(4, 'sellable', '1 day', 1);
    for (const n of [1, 2, 3, 4, 5, 6]) await run(n, n === 1 ? 'unsupported' : 'sellable', '0 days', 2);
    // The immediately preceding result, rather than any old failed result, determines repeats.
    await run(7, 'buy_failed', '2 days', 1); await run(7, 'sellable', '1 day', 1); await run(7, 'sellable', '0 days', 2);
    await run(8, 'sellable', '1 day', 1); await run(8, 'sellable', '0 days', 2);
    await db.ensurePartitions(new Date());
    await db.insert('swaps', { ts: new Date(), coin: coin(8), block: 2, tx_hash: binary(`0x${'01'.repeat(32)}`), log_index: 0,
      venue: 'pons_curve', pool_id: coin(80), quote_asset: coin(81), side: 1, amount_coin: '1', amount_quote: '1', price_quote: 1 });
    await db.sql.query("INSERT INTO read_coins(coin,tier,activity,first_block,pair_column,pair_block) VALUES($1,2,now()-interval '2 days',1,'new',1)", [coin(9)]);
    await run(9, 'unsupported', '0 days', 2);
    const sql = readFileSync(new URL('../../../scripts/sell-check-budget-report.sql', import.meta.url), 'utf8');
    await db.sql.query('BEGIN READ ONLY');
    const rows = (await db.sql.query(sql)).rows;
    await db.sql.query('ROLLBACK');
    expect(rows).toEqual([{
      checks_today: 9, requests_today: 36, repeat_failed_7d: 2, repeat_unsupported_7d: 1, repeat_buy_failed_7d: 1,
      repeat_failed_requests: 8, sellable_no_new_trades: 2, sellable_trade_history_unknown: 0, sellable_no_new_trade_requests: 8, first_retained_listed_live: 1, first_retained_unlisted: 2,
    }]);
    await db.sql.query("INSERT INTO raw_history_watermarks(name,through_block) VALUES('swaps',1) ON CONFLICT(name) DO UPDATE SET through_block=1");
    const pruned = (await db.sql.query(sql)).rows[0]!;
    // A boundary at the previous block leaves the whole interval available.
    expect(Number(pruned.sellable_no_new_trades)).toBe(2);
    await db.sql.query("UPDATE raw_history_watermarks SET through_block=2 WHERE name='swaps'");
    const unknown = (await db.sql.query(sql)).rows[0]!;
    expect(Number(unknown.sellable_no_new_trades)).toBe(0);
    expect(Number(unknown.sellable_trade_history_unknown)).toBe(2);
  } finally { await db.close(); }
});
