import { sqlProviderPause, type ProviderPauseStore } from './provider-pause.js';
import { sqlPaidPolicy, type PaidPolicy, type PaidState } from './paid-policy.js';
import type { ChainDb, SqlClient } from '@eko/db';
import type { Provider } from './routes.js';
export type UsageRow = { provider: Provider; method: string; calls: number; units: number };
export type UsageBatch = UsageRow & { day: string; unleasedUnits: number };
export interface PaidRefund { requestId: string; day: string; role: string; method: string; units: number; policy: boolean; leased: boolean }
export interface UsageStore {
  providerPause?: ProviderPauseStore;
  refundPaid?(refund: PaidRefund): Promise<void>;
  recordRefused?(day: string, role: string, method: string, calls: number): Promise<void>;
  refusedToday?(day: string): Promise<number>;
  paidPolicy?(day: string, policy: PaidPolicy, consume: boolean): Promise<PaidState>;
  lease?(day: string, provider: Provider, units: number, minimum: number, limit: number): Promise<{ allowed: boolean; total: number; units: number }>;
  record?(rows: UsageBatch[]): Promise<void>;
  release?(day: string, provider: Provider, units: number): Promise<void>;
  reserve(day: string, provider: Provider, method: string, units: number, limit: number): Promise<{ allowed: boolean; total: number }>;
  today(day: string): Promise<UsageRow[]>;
  close?(): Promise<void>;
}
export const rpcUsageSchema = `CREATE TABLE IF NOT EXISTS rpc_usage (
  day date NOT NULL, provider text NOT NULL CHECK (provider IN ('paid','public')), method text NOT NULL,
  calls bigint NOT NULL DEFAULT 0, units double precision NOT NULL DEFAULT 0,
  PRIMARY KEY(day,provider,method)
)`;
/** The __total__ row serializes admissions across processes; detail and total commit together. */
export interface RpcUsageDb { sql: SqlClient; tx<T>(fn: (tx: { sql: SqlClient }) => Promise<T>): Promise<T> }
export function createSqlUsageStore(db: RpcUsageDb): UsageStore {
  let ready: Promise<unknown> | undefined;
  const init = () => ready ??= db.sql.query(rpcUsageSchema);
  const policy = sqlPaidPolicy(db);
  let refundsReady: Promise<unknown> | undefined;
  const initRefunds = () => refundsReady ??= (async () => {
    await init();
    await db.sql.query('CREATE TABLE IF NOT EXISTS rpc_paid_refunds (request_id text PRIMARY KEY, day date NOT NULL)');
    await db.sql.query(`CREATE TABLE IF NOT EXISTS rpc_paid_refused (
      day date NOT NULL, role text NOT NULL, method text NOT NULL, calls bigint NOT NULL DEFAULT 0, PRIMARY KEY(day,role,method))`);
  })();
  const recordRefused = async (sql: SqlClient, day: string, role: string, method: string, calls: number) => {
    await sql.query(`INSERT INTO rpc_paid_refused(day,role,method,calls) VALUES($1,$2,$3,$4)
      ON CONFLICT(day,role,method) DO UPDATE SET calls=rpc_paid_refused.calls+excluded.calls`,[day,role,method,calls]);
  };
  return {
    providerPause: sqlProviderPause(db),
    async refundPaid(r) {
      await initRefunds();
      await db.tx(async tx => {
        const inserted = await tx.sql.query(`INSERT INTO rpc_paid_refunds(request_id,day) VALUES($1,$2)
          ON CONFLICT DO NOTHING RETURNING request_id`,[r.requestId,r.day]);
        if (!inserted.rows.length) return;
        // Lock in admission order: daily call ceiling, then total usage, then method detail.
        if (r.policy) await tx.sql.query(`UPDATE rpc_paid_daily SET total=total-1,
          non_indexer=non_indexer-CASE WHEN $2='indexer' THEN 0 ELSE 1 END WHERE day=$1`,[r.day,r.role]);
        await tx.sql.query(`UPDATE rpc_usage SET units=units-$2,calls=calls-$3
          WHERE day=$1 AND provider='paid' AND method='__total__'`,[r.day,r.units,r.leased?0:1]);
        await tx.sql.query(`UPDATE rpc_usage SET units=units-$3,calls=calls-1
          WHERE day=$1 AND provider='paid' AND method=$2`,[r.day,r.method,r.units]);
        await recordRefused(tx.sql,r.day,r.role,r.method,1);
      });
    },
    async recordRefused(day,role,method,calls) { await initRefunds(); await recordRefused(db.sql,day,role,method,calls); },
    async refusedToday(day) {
      await initRefunds();
      return Number((await db.sql.query<{calls:string}>('SELECT coalesce(sum(calls),0) AS calls FROM rpc_paid_refused WHERE day=$1',[day])).rows[0].calls);
    },
    paidPolicy: async (...args) => { await init(); return policy(...args); },
    async lease(day, provider, units, minimum, limit) {
      await init();
      const acquire = async (amount: number) => {
        const result = await db.sql.query<{ units: number }>(`INSERT INTO rpc_usage(day,provider,method,calls,units)
          SELECT $1,$2,'__total__',1,$3 WHERE $3::double precision <= $4::double precision
          ON CONFLICT(day,provider,method) DO UPDATE SET calls=rpc_usage.calls+1,units=rpc_usage.units+excluded.units
          WHERE rpc_usage.units+excluded.units <= $4::double precision RETURNING units`, [day,provider,amount,Number.isFinite(limit)?limit:Number.MAX_VALUE]);
        return result.rows[0] ? { allowed:true,total:Number(result.rows[0].units),units:amount } : null;
      };
      const first = await acquire(units); if (first) return first;
      const current = await db.sql.query<{ units: number }>("SELECT units FROM rpc_usage WHERE day=$1 AND provider=$2 AND method='__total__'",[day,provider]);
      const total = Number(current.rows[0]?.units ?? 0), remaining = Math.min(units,limit-total);
      if (remaining >= minimum) { const last = await acquire(remaining); if (last) return last; }
      return { allowed:false,total,units:0 };
    },
    async record(rows) {
      if (!rows.length) return;
      await init();
      const totals = new Map<string, UsageBatch>();
      for (const row of rows) if (row.unleasedUnits) {
        const key = `${row.day}:${row.provider}`, total = totals.get(key) ?? { ...row,method:'__total__',calls:0,units:0,unleasedUnits:0 };
        total.calls += row.calls; total.units += row.unleasedUnits; totals.set(key,total);
      }
      const params: unknown[] = [];
      const values = [...rows,...totals.values()].map(row => {
        const offset = params.length; params.push(row.day,row.provider,row.method,row.calls,row.units);
        return `($${offset+1}::date,$${offset+2}::text,$${offset+3}::text,$${offset+4}::bigint,$${offset+5}::double precision)`;
      });
      // One autocommit statement; no ChainDb transaction, no chain-table locks.
      await db.sql.query(`INSERT INTO rpc_usage(day,provider,method,calls,units) VALUES ${values.join(',')}
        ON CONFLICT(day,provider,method) DO UPDATE SET calls=rpc_usage.calls+excluded.calls,units=rpc_usage.units+excluded.units`,params);
    },
    async release(day, provider, units) {
      if (units > 0) await db.sql.query("UPDATE rpc_usage SET units=units-$3 WHERE day=$1 AND provider=$2 AND method='__total__' AND units >= $3",[day,provider,units]);
    },
    async reserve(day, provider, method, units, limit) {
      await init();
      return db.tx(async tx => {
        const { rows } = await tx.sql.query<{ units: number }>(`INSERT INTO rpc_usage(day,provider,method,calls,units)
          SELECT $1,$2,'__total__',1,$3 WHERE $3::double precision <= $4::double precision
          ON CONFLICT(day,provider,method) DO UPDATE SET calls=rpc_usage.calls+1,units=rpc_usage.units+excluded.units
          WHERE rpc_usage.units+excluded.units <= $4::double precision RETURNING units`, [day, provider, units, Number.isFinite(limit) ? limit : Number.MAX_VALUE]);
        if (!rows.length) {
          const current = await tx.sql.query<{ units: number }>("SELECT units FROM rpc_usage WHERE day=$1 AND provider=$2 AND method='__total__'", [day, provider]);
          return { allowed: false, total: Number(current.rows[0]?.units ?? 0) };
        }
        await tx.sql.query(`INSERT INTO rpc_usage(day,provider,method,calls,units) VALUES($1,$2,$3,1,$4)
          ON CONFLICT(day,provider,method) DO UPDATE SET calls=rpc_usage.calls+1,units=rpc_usage.units+excluded.units`, [day, provider, method, units]);
        return { allowed: true, total: Number(rows[0].units) };
      });
    },
    async today(day) {
      await init();
      const { rows } = await db.sql.query<UsageRow>("SELECT provider,method,calls,units FROM rpc_usage WHERE day=$1 AND method <> '__total__' AND calls>0 ORDER BY provider,method", [day]);
      return rows.map(r => ({ ...r, calls: Number(r.calls), units: Number(r.units) }));
    },
  };
}
/** Lazy database creation keeps construction side-effect free, including offline CLI tests. */
export function persistentUsageStore(env: { DATABASE_URL?: string; RPC_USAGE_DIR?: string }): UsageStore {
  let opened: Promise<{ db: ChainDb; store: UsageStore }> | undefined;
  const get = () => opened ??= import('@eko/db').then(async ({ openDb }) => {
    const db = await openDb({ databaseUrl: env.DATABASE_URL, pgliteDir: env.RPC_USAGE_DIR ?? '.data/rpc-usage' });
    return { db, store: createSqlUsageStore(db) };
  });
  return {
    providerPause: {
      read: async (...args) => (await get()).store.providerPause!.read(...args),
      refuse: async (...args) => (await get()).store.providerPause!.refuse(...args),
      claim: async (...args) => (await get()).store.providerPause!.claim(...args),
      finish: async (...args) => (await get()).store.providerPause!.finish(...args),
    },
    refundPaid: async r => (await get()).store.refundPaid!(r),
    recordRefused: async (...args) => (await get()).store.recordRefused!(...args),
    refusedToday: async day => (await get()).store.refusedToday!(day),
    paidPolicy: async (...args) => (await get()).store.paidPolicy!(...args),
    reserve: async (...args) => (await get()).store.reserve(...args),
    lease: async (...args) => (await get()).store.lease!(...args),
    record: async rows => (await get()).store.record!(rows),
    release: async (...args) => (await get()).store.release!(...args),
    today: async day => (await get()).store.today(day),
    close: async () => { if (opened) await (await opened).db.close(); },
  };
}
