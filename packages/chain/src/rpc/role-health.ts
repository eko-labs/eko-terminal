import type { RpcUsageDb } from './usage.js';
import type { RpcPause } from './outage.js';
// TODO(spec): role pause health is additive incident telemetry; the spec has no cross-process pause schema.
const schema = `CREATE TABLE IF NOT EXISTS rpc_role_health (
  role text PRIMARY KEY CHECK (role IN ('indexer','engines')),
  pause jsonb, updated_at bigint NOT NULL
)`;
/** One bounded row per role; no provider messages, credentials or request data are persisted. */
export async function rpcRoleHealth(db: Pick<RpcUsageDb, 'sql'>, role: 'indexer' | 'engines') {
  await db.sql.query(schema);
  const update = async (pause: RpcPause | null) => {
    await db.sql.query(`INSERT INTO rpc_role_health(role,pause,updated_at) VALUES($1,$2,$3)
      ON CONFLICT(role) DO UPDATE SET pause=excluded.pause,updated_at=excluded.updated_at`,
    [role, pause ? JSON.stringify(pause) : null, Date.now()]);
  };
  await update(null);
  return update;
}
/** Absence before the first role startup is valid; an expired pause remains visible as stale. */
export async function readRpcRoleHealth(db: Pick<RpcUsageDb, 'sql'>) {
  const providerExists=(await db.sql.query<{name:string|null}>("SELECT to_regclass('rpc_provider_pause')::text AS name")).rows[0]?.name;
  const provider=providerExists ? (await db.sql.query<{pause:RpcPause}>('SELECT pause FROM rpc_provider_pause WHERE id=1 AND pause IS NOT NULL')).rows[0]?.pause : undefined;
  if (!(await db.sql.query<{name: string | null}>("SELECT to_regclass('rpc_role_health')::text AS name")).rows[0]?.name) return provider ? {provider} : {};
  const rows = (await db.sql.query<{role: string; pause: RpcPause; updated_at: string}>('SELECT role,pause,updated_at FROM rpc_role_health WHERE pause IS NOT NULL')).rows;
  return {...Object.fromEntries(rows.map(row => [row.role, { ...row.pause, stale: Date.now() - Number(row.updated_at) > 90_000 }])),...(provider ? {provider} : {})};
}
