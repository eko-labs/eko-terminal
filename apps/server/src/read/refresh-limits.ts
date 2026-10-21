import type { ChainDb } from '@eko/db';

/** Transaction-local limits apply to preparation, lock acquisition and every projection write. */
export async function limitRefresh(db:ChainDb) {
  await db.sql.query("SET LOCAL statement_timeout = '5s'");
  await db.sql.query("SET LOCAL lock_timeout = '2s'");
}
export function refreshTimedOut(error:unknown) {
  return typeof error==='object' && error!==null && 'code' in error && ['57014','55P03'].includes(String(error.code));
}
