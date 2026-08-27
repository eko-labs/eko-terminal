import type { RpcPause, ProviderErrorClass } from './outage.js';
import type { RpcUsageDb } from './usage.js';

export interface ProviderPauseStore {
  read(now: number, refresh?: boolean): Promise<RpcPause | null>;
  refuse(reason: ProviderErrorClass, now: number): Promise<RpcPause>;
  claim(token: string, role: string, now: number, leaseMs: number): Promise<boolean>;
  finish(token: string, now: number, reason: ProviderErrorClass | null, maxBackoffMs: number): Promise<void>;
}
export const providerPauseSchema = `CREATE TABLE IF NOT EXISTS rpc_provider_pause (
  id integer PRIMARY KEY CHECK (id=1), pause jsonb, backoff_ms bigint NOT NULL DEFAULT 10000,
  lease_token text, lease_until bigint NOT NULL DEFAULT 0
)`;
const stores = new WeakMap<object, ProviderPauseStore>();
/** A three-second process cache; refusals invalidate it immediately. SQL fences each probe by a unique lease token. */
export function sqlProviderPause(db: RpcUsageDb): ProviderPauseStore {
  const existing = stores.get(db.sql); if (existing) return existing;
  let ready: Promise<unknown> | undefined, cached: RpcPause | null = null, expires = -Infinity;
  const init = () => ready ??= db.sql.query(providerPauseSchema);
  const store: ProviderPauseStore = {
    async read(now, refresh = false) {
      if (!refresh && now < expires) return cached;
      await init();
      cached = (await db.sql.query<{pause: RpcPause | null}>('SELECT pause FROM rpc_provider_pause WHERE id=1')).rows[0]?.pause ?? null;
      expires = now + 3000; return cached;
    },
    async refuse(reason, now) {
      await init();
      const pause: RpcPause = {state:'PAUSED',reason,provider:'paid',since:now,nextRetryAt:now+10_000};
      // Concurrent refusals retain the original outage and its retry schedule, including any active lease.
      cached = (await db.sql.query<{pause:RpcPause}>(`INSERT INTO rpc_provider_pause(id,pause) VALUES(1,$1)
        ON CONFLICT(id) DO UPDATE SET pause=coalesce(rpc_provider_pause.pause,excluded.pause),
        backoff_ms=CASE WHEN rpc_provider_pause.pause IS NULL THEN 10000 ELSE rpc_provider_pause.backoff_ms END
        RETURNING pause`,[JSON.stringify(pause)])).rows[0].pause;
      expires = now + 3000; return cached;
    },
    async claim(token, role, now, leaseMs) {
      await init();
      // Give a live indexer a one-second head start. Any other role takes over without a designated leader.
      const result = await db.sql.query(`UPDATE rpc_provider_pause SET lease_token=$1,lease_until=$2
        WHERE id=1 AND pause IS NOT NULL AND (pause->>'nextRetryAt')::bigint+$4<=$3 AND (lease_until<=$3 OR lease_token=$1) RETURNING id`,
      [token,now+leaseMs,now,role==='indexer'?0:1000]);
      return result.rows.length === 1;
    },
    async finish(token, now, reason, maxBackoffMs) {
      await init();
      await db.sql.query(`UPDATE rpc_provider_pause SET pause=CASE WHEN $2::text IS NULL THEN NULL ELSE
        jsonb_set(jsonb_set(pause,'{reason}',to_jsonb($2::text)),'{nextRetryAt}',to_jsonb($3::bigint+least(backoff_ms*2,$4::bigint))) END,
        backoff_ms=least(backoff_ms*2,$4),lease_token=NULL,lease_until=0 WHERE id=1 AND lease_token=$1`,[token,reason,now,maxBackoffMs]);
      expires = -Infinity;
    },
  };
  stores.set(db.sql,store); return store;
}
