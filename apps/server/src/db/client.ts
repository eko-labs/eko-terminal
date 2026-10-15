import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type { UsageStore } from '@eko/chain';
import { createSqlUsageStore } from '@eko/chain';
import * as schema from './schema.js';

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface DbHandle {
  db: Db;
  chain: import('@eko/db').ChainDb;
  driver: 'pg' | 'pglite';
  rpcUsage: UsageStore;
  close(): Promise<void>;
}

const here = dirname(fileURLToPath(import.meta.url));
/** Resolved relative to this file so it works from src/ (tsx) and dist/ (bundled). */
export const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR ?? resolve(here, here.endsWith('dist') ? '../drizzle' : '../../drizzle');

/**
 * Postgres when DATABASE_URL is set; otherwise an embedded PGlite database on disk
 * (or in memory when dir === ':memory:'), so the app runs with zero external services.
 */
export async function openDb(opts: { databaseUrl?: string; pgliteDir: string }): Promise<DbHandle> {
  const { openDb: openChainDb } = await import('@eko/db');
  const chain = await openChainDb({ ...opts, poolOptions:{ max:10, ssl:opts.databaseUrl && /sslmode=require|neon\.tech|supabase\.co/.test(opts.databaseUrl) ? {rejectUnauthorized:false} : undefined } });
  try {
    const db = opts.databaseUrl
      ? (await import('drizzle-orm/node-postgres')).drizzle(chain.sql as never, { schema }) as unknown as Db
      : (await import('drizzle-orm/pglite')).drizzle(chain.sql as never, { schema }) as unknown as Db;
    return { db, chain, driver: opts.databaseUrl ? 'pg' : 'pglite', rpcUsage: createSqlUsageStore(chain), close: chain.close };
  } catch (error) { await chain.close(); throw error; }
}

export async function runMigrations(handle: DbHandle): Promise<void> {
  if (handle.driver === 'pg') {
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    await migrate(handle.db as never, { migrationsFolder: MIGRATIONS_DIR });
  } else {
    const { migrate } = await import('drizzle-orm/pglite/migrator');
    await migrate(handle.db as never, { migrationsFolder: MIGRATIONS_DIR });
  }
}
