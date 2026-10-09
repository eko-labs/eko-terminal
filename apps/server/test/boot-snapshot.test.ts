import { afterEach, expect, it, vi } from 'vitest';
import type { SqlClient } from '@eko/db';
import { ReadStore } from '../src/read/store.js';
import * as storage from '../src/db/client.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const openDb = storage.openDb;
afterEach(() => vi.restoreAllMocks());
it.each(['worker', 'api'])('%s boot summary SQL only reads committed projections without taking locks', async role => {
  const statements: string[] = [];
  vi.spyOn(storage, 'openDb').mockImplementation(async options => {
    const handle = await openDb(options);
    const trace = (client: SqlClient) => {
      const query = client.query.bind(client);
      client.query = async <T>(sql: string, params?: unknown[]) => {
        statements.push(sql);
        return query<T>(sql, params);
      };
      return () => { client.query = query; };
    };
    trace(handle.chain.sql);
    const originalTx = handle.chain.tx.bind(handle.chain);
    handle.chain.tx = fn => originalTx(async tx => {
      const restore = trace(tx.sql);
      try { return await fn(tx); } finally { restore(); }
    });
    return handle;
  });
  const refresh = ReadStore.prototype.refreshSummaries;
  vi.spyOn(ReadStore.prototype, 'refreshSummaries').mockImplementation(async function(this: ReadStore) {
    // A dirty coin ensures the former boot path would actually acquire its projection mutex.
    await this.db.sql.query('INSERT INTO tokens(address,first_block,block) VALUES($1,1,1)', [new Uint8Array(20).fill(1)]);
    return refresh.call(this);
  });
  const built = await buildApp(loadConfig({ NODE_ENV: 'test', APP_ROLE: role, RUN_WORKER: role === 'worker' ? 'true' : 'false', PGLITE_DIR: ':memory:', SESSION_SECRET: 'boot-fixture-placeholder'.repeat(3), MARKET_DATA_SOURCE: 'onchain' }), { startBackground: false });
  try {
    expect(statements.some(sql => sql.includes('SELECT 1 FROM chain_blocks LIMIT 1'))).toBe(true);
    expect(statements.filter(sql => /^\s*SELECT\s+(?:read_lock_coins|prepare_read_models|refresh_read_models)\s*\(/i.test(sql))).toEqual([]);
    expect(statements.filter(sql => /FROM read_rank_clock.*FOR UPDATE/i.test(sql))).toEqual([]);
  } finally { await built.close(); }
});
