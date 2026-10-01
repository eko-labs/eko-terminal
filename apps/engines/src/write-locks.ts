import type { ChainDb } from '@eko/db';
import type { LoadedSources } from './sources.js';
/** Preserve same-coin and deployer-history ordering without blocking unrelated schedules. */
export async function lockEngineWrites(db:ChainDb,sources:readonly Pick<LoadedSources,'coin'|'deployer'>[]=[],outcomes=false,cursor=false) {
  const keys=[...new Set([...(cursor ? ['0-cursor'] : []),'1-outcomes',
    ...sources.map(s=>`2-deployer:${s.deployer}`),...sources.map(s=>`3-coin:${s.coin}`)])].sort();
  if(!keys.length)return;
  await db.sql.query('INSERT INTO engine_write_locks(key) SELECT unnest($1::text[]) ORDER BY 1 ON CONFLICT DO NOTHING',[keys]);
  if(cursor)await db.sql.query("SELECT key FROM engine_write_locks WHERE key='0-cursor' FOR UPDATE");
  // Cards share the outcome fence; horizon materialization excludes cards while it changes deployer history.
  await db.sql.query(`SELECT key FROM engine_write_locks WHERE key='1-outcomes' FOR ${outcomes ? 'UPDATE' : 'SHARE'}`);
  await db.sql.query('SELECT read_lock_coins($1::bytea[])',[sources.map(s=>Buffer.from(s.coin.slice(2),'hex'))]);
  await db.sql.query('SELECT key FROM engine_write_locks WHERE key=ANY($1::text[]) ORDER BY key FOR UPDATE',[keys.filter(key=>key.startsWith('2-') || key.startsWith('3-'))]);
}
