import { afterEach, describe, expect, it } from 'vitest';
import { binary, migrate, rebuildBars, refreshBars, type ChainDb } from '../src/index.js';
import { openDb } from './helpers/historical-db.js';

const epoch = Date.parse('2026-10-01T00:00:00Z');
const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as `0x${string}`;
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as `0x${string}`;
const handles: ChainDb[] = [];
afterEach(async () => { await Promise.all(handles.splice(0).map(db => db.close())); });
// Coins: a graduated Pons coin (curve swaps count before graduation, pool swaps after), a plain token, and one with
// unknown decimals (never priced into bars).
const pons = address(0xc1), plain = address(0xc2), unknown = address(0xc3), quote = address(0xee);
async function database() {
  const db = await openDb({ pgliteDir: ':memory:' }); handles.push(db);
  await migrate(db); await db.ensurePartitions(new Date(epoch));
  await db.insert('tokens', { address: binary(pons), decimals: 18, launchpad: 'pons', first_block: '1', block: '1' });
  await db.sql.query('UPDATE tokens SET graduated_block=$2 WHERE address=$1', [binary(pons), '600']);
  await db.insert('tokens', { address: binary(plain), decimals: 6, first_block: '1', block: '1' });
  await db.insert('tokens', { address: binary(unknown), decimals: null, first_block: '1', block: '1' });
  // Two hours of swaps, several per minute and coin, with unpriced and zero-USD rows mixed in.
  const rows: Record<string, unknown>[] = [];
  for (let block = 1; block <= 1200; block++) for (const [i, coin] of [pons, plain, unknown].entries()) {
    if ((block + i) % 3 === 0) continue;
    rows.push({ ts: new Date(epoch + block * 6000), block: String(block), tx_hash: binary(hash(block * 10 + i)), log_index: i, venue: coin === pons && block % 2 ? 'pons_curve' : 'uniswap_v3',
      pool_id: binary(address(0xb0 + i)), coin: binary(coin), quote_asset: binary(quote), side: block % 2 ? 1 : -1, amount_coin: String(1000 + block * 7 % 991), amount_quote: '5',
      price_quote: 1, usd: block % 17 === 0 ? null : block % 19 === 0 ? 0 : 1 + (block * 31 % 97) / 10 });
  }
  await db.insertMany('swaps', rows);
  return db;
}
const bars = async (db: ChainDb) => (await db.sql.query('SELECT * FROM bars_1m ORDER BY coin,minute')).rows;
const touched = (db: ChainDb, from: number, to: number) => db.sql.query<{ coin: Uint8Array; minute: Date }>(
  "SELECT DISTINCT coin,date_trunc('minute',ts) AS minute FROM swaps WHERE block BETWEEN $1 AND $2", [from, to]).then(r => r.rows);

describe('bar refresh', () => {
  it('matches a full rebuild while reading only the touched minute of each coin', async () => {
    const db = await database();
    await db.tx(tx => rebuildBars(tx, 0n, 1200n));
    const truth = await bars(db);
    expect(truth.length).toBeGreaterThan(200);
    await db.sql.query('DELETE FROM bars_1m');
    // Refresh in applied-batch slices, as the indexer does, including minutes that span two slices.
    for (let from = 1; from <= 1200; from += 70) {
      const keys = await touched(db, from, Math.min(1200, from + 69));
      await db.tx(tx => refreshBars(tx, keys));
    }
    expect(await bars(db)).toEqual(truth);
    // The refresh statement bounds its index scan by the minute as well as the coin.
    const statements: { sql: string; params?: unknown[] }[] = [], keys = await touched(db, 400, 410);
    await db.tx(async tx => { const query = tx.sql.query.bind(tx.sql); tx.sql.query = async (sql, params) => { statements.push({ sql, params }); return query(sql, params); }; await refreshBars(tx, keys); });
    expect(statements.some(s=>s.sql==='LOCK TABLE bars_1m IN EXCLUSIVE MODE')).toBe(false);
    expect(statements.some(s=>s.sql==='SELECT coin FROM bar_write_locks WHERE coin=$1 FOR UPDATE')).toBe(true);
    const insert = statements.find(s => s.sql.trimStart().startsWith('INSERT INTO bars_1m'))!;
    const plan = (await db.sql.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${insert.sql}`, insert.params)).rows.map(r => r['QUERY PLAN']).join('\n');
    expect(plan).toMatch(/Index Cond: \(\(coin = [^)]*\) AND \(ts >= [^)]*\) AND \(ts < /);
    expect(await bars(db)).toEqual(truth);
  });
});
