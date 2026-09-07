import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn(), connect: vi.fn(), end: vi.fn(), pool: vi.fn() }));
vi.mock('pg', () => ({ default: { Pool: class {
  constructor(options: unknown) { fixture.pool(options); }
  query = fixture.query;
  connect = fixture.connect;
  end = fixture.end;
} } }));
import { openDb } from '../src/client.js';
beforeEach(() => {
  vi.clearAllMocks();
  fixture.query.mockResolvedValue({ rows: [] });
  fixture.connect.mockResolvedValue({ query: fixture.query, release: fixture.release });
});
afterEach(() => vi.unstubAllEnvs());

describe('Postgres connection lifecycle', () => {
  it('commits successful callbacks, releases the connection and closes the pool', async () => {
    const db = await openDb({ databaseUrl: 'postgres://demo.invalid/fixture', poolOptions: { max: 2 } });
    expect(fixture.pool).toHaveBeenCalledWith({ max: 2, connectionString: 'postgres://demo.invalid/fixture' });
    expect(await db.tx(async tx => { await tx.sql.query('SELECT 1'); return 'committed'; })).toBe('committed');
    expect(fixture.query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'SELECT 1', 'COMMIT']);
    expect(fixture.release).toHaveBeenCalledOnce();
    await db.close(); expect(fixture.end).toHaveBeenCalledOnce();
  });
  it('rolls back failures and releases the connection without committing', async () => {
    const db = await openDb({ databaseUrl: 'postgres://demo.invalid/fixture' });
    await expect(db.tx(async () => { throw new Error('fixture failure'); })).rejects.toThrow('fixture failure');
    expect(fixture.query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'ROLLBACK']);
    expect(fixture.release).toHaveBeenCalledOnce();
    await db.close();
  });
  it('refuses production fallback without attempting a connection', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    await expect(openDb({ databaseUrl: '  ', pgliteDir: ':memory:' })).rejects.toThrow('DATABASE_URL is required');
    expect(fixture.pool).not.toHaveBeenCalled();
  });
});
