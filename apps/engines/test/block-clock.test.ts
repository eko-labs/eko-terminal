import { describe, expect, it } from 'vitest';
import { binary, ChainDb, migrate, migrateEngines, } from '@eko/db';
import { openDb } from '../../../packages/db/test/helpers/historical-db.js';
import { CLOCK_CACHE_LIMIT, CLOCK_LOOKBACK_BLOCKS, refreshClock, resolveClock, type ClockCache } from '../src/activity.js';

const epoch = Date.parse('2026-10-01T00:00:00Z');
const hash = (n: number) => binary(`0x${n.toString(16).padStart(64, '0')}`);
const sample = binary(`0x${'1'.repeat(40)}`);

describe('engine block clock', () => {
  it('copies indexed headers on every poll without rewriting rows that did not change', async () => {
    const db = await openDb({ pgliteDir: ':memory:' });
    try {
      await migrate(db); await migrateEngines(db); await db.ensurePartitions(new Date(epoch));
      for (const n of [1, 2, 3]) await db.insert('chain_blocks', { number: String(n), block: String(n), hash: hash(n), parent_hash: hash(n - 1), ts: new Date(epoch + n * 1000) });
      // Block 4 is known only from an indexed transfer until its header is stored.
      await db.insert('token_transfers', { ts: new Date(epoch + 4000), block: '4', tx_hash: hash(400), log_index: 0, token: sample, from_address: sample, to_address: sample, amount: '1', kind: 'Transfer' });
      const rows = async () => (await db.sql.query<{ number: string; version: string; source: string; hash: Uint8Array | null }>(
        'SELECT number::text, xmin::text AS version, source, hash FROM engine_block_times ORDER BY number')).rows;
      await refreshClock(db);
      const first = await rows();
      expect(first.map(r => [r.number, r.source])).toEqual([['1', 'head'], ['2', 'head'], ['3', 'head'], ['4', 'activity']]);
      // A second poll leaves every unchanged row version in place.
      await refreshClock(db);
      expect(await rows()).toEqual(first);
      // A replaced header and a newly stored header are still written.
      await db.sql.query('UPDATE chain_blocks SET hash=$1 WHERE number=3', [hash(33)]);
      await db.insert('chain_blocks', { number: '4', block: '4', hash: hash(4), parent_hash: hash(33), ts: new Date(epoch + 4000) });
      await refreshClock(db);
      const after = await rows();
      expect(after.slice(0, 2)).toEqual(first.slice(0, 2));
      expect(after.slice(2).map(r => [r.number, r.source, Buffer.from(r.hash!).toString('hex')])).toEqual([
        ['3', 'head', Buffer.from(hash(33)).toString('hex')], ['4', 'head', Buffer.from(hash(4)).toString('hex')]]);
      expect(after[2]!.version).not.toBe(first[2]!.version);
    } finally { await db.close(); }
  });
  it('re-reads only blocks above the previous pass minus the lookback, and still resolves a late old block', async () => {
    const db = await openDb({ pgliteDir: ':memory:' });
    try {
      await migrate(db); await migrateEngines(db); await db.ensurePartitions(new Date(epoch));
      const seconds = epoch / 1000;
      // Blocks 1..2000 have headers, except block 100.
      await db.sql.query(`INSERT INTO chain_blocks(number,block,hash,parent_hash,ts)
        SELECT n,n,decode(lpad(to_hex(n),64,'0'),'hex'),decode(lpad(to_hex(n-1),64,'0'),'hex'),to_timestamp($1::double precision+n)
        FROM generate_series(1,2000) n WHERE n<>100`, [seconds]);
      const cache: ClockCache = new Map();
      await refreshClock(db, cache);
      // The table is copied in full, but the cache holds only the newest re-read range.
      expect([...cache.keys()].sort((a, b) => a - b)).toEqual(Array.from({ length: CLOCK_LOOKBACK_BLOCKS }, (_, i) => 2000 - CLOCK_LOOKBACK_BLOCKS + 1 + i));
      const count = async () => Number((await db.sql.query<{ n: string }>('SELECT count(*)::text AS n FROM engine_block_times')).rows[0]!.n);
      expect(await count()).toBe(1999);
      // Later activity: a new header, a transfer in a block with no header yet, a changed header inside the lookback,
      // and a transfer for old block 100 (below the lookback) written late.
      await db.insert('chain_blocks', { number: '2001', block: '2001', hash: hash(2001), parent_hash: hash(2000), ts: new Date(epoch + 2001_000) });
      await db.insert('token_transfers', { ts: new Date(epoch + 2002_000), block: '2002', tx_hash: hash(9002), log_index: 0, token: sample, from_address: sample, to_address: sample, amount: '1', kind: 'Transfer' });
      await db.sql.query('UPDATE chain_blocks SET hash=$1 WHERE number=$2', [hash(77), 2000 - CLOCK_LOOKBACK_BLOCKS + 10]);
      await db.insert('token_transfers', { ts: new Date(epoch + 100_000), block: '100', tx_hash: hash(9100), log_index: 0, token: sample, from_address: sample, to_address: sample, amount: '1', kind: 'Transfer' });
      await refreshClock(db, cache);
      const row = async (n: number) => (await db.sql.query<{ source: string; hash: Uint8Array | null }>('SELECT source, hash FROM engine_block_times WHERE number=$1', [n])).rows[0];
      expect((await row(2001))?.source).toBe('head');
      expect((await row(2002))?.source).toBe('activity');
      expect(Buffer.from((await row(2000 - CLOCK_LOOKBACK_BLOCKS + 10))!.hash!).toString('hex')).toBe(Buffer.from(hash(77)).toString('hex'));
      // The incremental pass does not look below the lookback, so block 100 is not copied...
      expect(await row(100)).toBeUndefined();
      expect(cache.has(2002) && !cache.has(1)).toBe(true);
      // ...but resolving it falls back to a header read and records it, as resolving block 1 falls back to the table.
      expect((await resolveClock(db, 1, undefined, cache))?.ts.getTime()).toBe(epoch + 1000);
      const resolved = await resolveClock(db, 100, async () => ({ timestamp: BigInt(seconds + 100), hash: null }), cache);
      expect(resolved?.ts.getTime()).toBe(epoch + 100_000);
      expect((await row(100))?.source).toBe('archive');
    } finally { await db.close(); }
  });
  it('keeps the cache bounded over many polls', async () => {
    const db = await openDb({ pgliteDir: ':memory:' });
    try {
      await migrate(db); await migrateEngines(db);
      const cache: ClockCache = new Map();
      for (let n = 0; n < CLOCK_CACHE_LIMIT + 1000; n++) cache.set(n, { ts: new Date(epoch), hash: null });
      await db.insert('chain_blocks', { number: '1', block: '1', hash: hash(1), parent_hash: hash(0), ts: new Date(epoch + 1000) });
      await refreshClock(db, cache);
      expect(cache.size).toBeLessThanOrEqual(CLOCK_CACHE_LIMIT);
      expect(cache.has(1)).toBe(true);
    } finally { await db.close(); }
  });
  it('starts a new process from the newest stored block instead of copying every block again', async () => {
    const db = await openDb({ pgliteDir: ':memory:' });
    try {
      await migrate(db); await migrateEngines(db); await db.ensurePartitions(new Date(epoch));
      const seconds = epoch / 1000;
      await db.sql.query(`INSERT INTO chain_blocks(number,block,hash,parent_hash,ts)
        SELECT n,n,decode(lpad(to_hex(n),64,'0'),'hex'),decode(lpad(to_hex(n-1),64,'0'),'hex'),to_timestamp($1::double precision+n)
        FROM generate_series(1,2000) n WHERE n<>100`, [seconds]);
      await refreshClock(db, new Map());
      // While no process runs: a late transfer for old block 100 and a new header.
      await db.insert('token_transfers', { ts: new Date(epoch + 100_000), block: '100', tx_hash: hash(9100), log_index: 0, token: sample, from_address: sample, to_address: sample, amount: '1' });
      await db.insert('chain_blocks', { number: '2001', block: '2001', hash: hash(2001), parent_hash: hash(2000), ts: new Date(epoch + 2001_000) });
      // A new process (refreshClock keeps its watermark per handle) re-reads only the newest blocks and caches only those.
      const restarted = new ChainDb(db.sql, fn => db.tx(tx => fn(tx.sql)));
      const cache: ClockCache = new Map();
      await refreshClock(restarted, cache);
      expect([...cache.keys()].sort((a, b) => a - b)).toEqual(Array.from({ length: CLOCK_LOOKBACK_BLOCKS + 1 }, (_, i) => 2001 - CLOCK_LOOKBACK_BLOCKS + i));
      expect((await db.sql.query('SELECT 1 FROM engine_block_times WHERE number=100')).rows).toHaveLength(0);
      expect((await db.sql.query<{ source: string }>('SELECT source FROM engine_block_times WHERE number=2001')).rows[0]?.source).toBe('head');
      // Only an empty table is copied in full (into the table; the cache again holds the newest range).
      const empty = await openDb({ pgliteDir: ':memory:' });
      try {
        await migrate(empty); await migrateEngines(empty);
        await empty.sql.query(`INSERT INTO chain_blocks(number,block,hash,parent_hash,ts) SELECT n,n,decode(lpad(to_hex(n),64,'0'),'hex'),
          decode(lpad(to_hex(n-1),64,'0'),'hex'),to_timestamp($1::double precision+n) FROM generate_series(1,2000) n`, [seconds]);
        const full: ClockCache = new Map();
        await refreshClock(empty, full);
        expect((await empty.sql.query<{ n: string }>('SELECT count(*)::text AS n FROM engine_block_times')).rows[0]!.n).toBe('2000');
        expect(full.size).toBe(CLOCK_LOOKBACK_BLOCKS);
      } finally { await empty.close(); }
    } finally { await db.close(); }
  });
});
