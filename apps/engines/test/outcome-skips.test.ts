import { afterEach, describe, expect, it, vi } from 'vitest';
import { binary, migrate, migrateEngines, type ChainDb } from '@eko/db';
import { openDb } from '../../../packages/db/test/helpers/historical-db.js';
import { OUTCOME_SKIP_RETRY_SEC, updateOutcomes } from '../src/outcomes.js';

const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as const;
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as const;
const epoch = Date.parse('2026-10-01T00:00:00Z') / 1000;
const handles: ChainDb[] = [];
afterEach(async () => { await Promise.all(handles.splice(0).map(db => db.close())); });

describe('live outcome retries', () => {
  it('does not reload a never-traded coin on every write, and retries it after the backoff', async () => {
    const db = await openDb({ pgliteDir: ':memory:' }); handles.push(db);
    await migrate(db); await migrateEngines(db); await db.ensurePartitions(new Date(epoch * 1000));
    for (let n = 1; n <= 30; n++) {
      await db.insert('chain_blocks', { number: String(n), block: String(n), hash: binary(hash(n)), parent_hash: binary(hash(n - 1)), ts: new Date((epoch + n * 3600) * 1000) });
      await db.sql.query('INSERT INTO engine_block_times VALUES($1,$2,$3,$4)', [n, new Date((epoch + n * 3600) * 1000), binary(hash(n)), 'header']);
    }
    // Launched at block 1, never traded: no horizon can ever produce an outcome.
    await db.insert('tokens', { address: binary(address(1)), deployer: binary(address(2)), curve: null, name: 'Sample token', symbol: 'DEMO',
      launchpad: 'other', decimals: 0, total_supply: '100', supply_block: '1', first_block: '1', block: '1' });
    const query = vi.spyOn(db.sql, 'query');
    const endLookups = () => query.mock.calls.filter(([sql]) => String(sql).includes('FROM engine_block_times WHERE ts>=')).length;
    const skips = new Map<string, number>(), now = epoch + 30 * 3600;
    await updateOutcomes(db, 30, now, undefined, undefined, skips);
    const first = endLookups();
    expect(first).toBe(2); // the 1h and 24h horizons have passed
    expect([...skips.keys()].sort()).toEqual([`${address(1)}:1h`, `${address(1)}:24h`]);
    await updateOutcomes(db, 30, now + 60, undefined, undefined, skips);
    expect(endLookups()).toBe(first);
    await updateOutcomes(db, 30, now + OUTCOME_SKIP_RETRY_SEC + 1, undefined, undefined, skips);
    expect(endLookups()).toBe(first + 2);
    expect((await db.sql.query('SELECT 1 FROM outcomes')).rows).toEqual([]);
  });
  it('finds the first block at or after a horizon through the time index', async () => {
    const db = await openDb({ pgliteDir: ':memory:' }); handles.push(db);
    await migrate(db); await migrateEngines(db);
    for (const [n, sec] of [[1, 0], [2, 10], [3, 10], [4, 25], [5, 40]] as const)
      await db.sql.query('INSERT INTO engine_block_times VALUES($1,$2,NULL,$3)', [n, new Date((epoch + sec) * 1000), 'header']);
    const sql = 'SELECT number FROM engine_block_times WHERE ts>=to_timestamp($2) AND number<=$1 ORDER BY ts,number LIMIT 1';
    const first = async (limit: number, sec: number) => { const n = (await db.sql.query<{ number: string | number }>(sql, [limit, epoch + sec])).rows[0]?.number; return n === undefined ? undefined : Number(n); };
    expect(await first(5, 10)).toBe(2);
    expect(await first(5, 11)).toBe(4);
    expect(await first(3, 11)).toBeUndefined();
  });
});
