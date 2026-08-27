import type { RpcUsageDb } from './usage.js';
export interface PaidPolicy { role: string; urgent: boolean; softLimit: number; ceiling: number; reserve: number; incurred?: boolean }
export interface PaidState { allowed: boolean; degraded: boolean; total: number; nonIndexer: number }
/** Call counts, independent of compute-unit weights and process-local unit leases. */
export function sqlPaidPolicy(db: RpcUsageDb) {
  let ready: Promise<unknown> | undefined;
  const init = () => ready ??= db.sql.query(`CREATE TABLE IF NOT EXISTS rpc_paid_daily (
    day date PRIMARY KEY, total bigint NOT NULL, non_indexer bigint NOT NULL)`);
  return async (day: string, p: PaidPolicy, consume: boolean): Promise<PaidState> => {
    await init();
    if(!consume) {
      const stored=(await db.sql.query<{total:string;non_indexer:string}>('SELECT total,non_indexer FROM rpc_paid_daily WHERE day=$1',[day])).rows[0];
      const baseline=stored ? 0 : Number((await db.sql.query<{calls:string}>("SELECT coalesce(sum(calls),0) AS calls FROM rpc_usage WHERE day=$1 AND provider='paid' AND method<>'__total__'",[day])).rows[0].calls);
      const total=stored ? Number(stored.total) : baseline,nonIndexer=stored ? Number(stored.non_indexer) : baseline;
      return {total,nonIndexer,degraded:total>=p.softLimit,allowed:total<p.ceiling && (p.role==='indexer' ||
        (nonIndexer<Math.max(0,p.ceiling-p.reserve) && (total<p.softLimit || p.urgent)))};
    }
    // The upsert locks one shared daily row. On rollout, existing paid attempts are charged conservatively to
    // non-indexer work because the historical ledger has no role dimension. No already-spent money is forgotten.
    const step = consume ? 1 : 0, indexer = p.role === 'indexer';
    const result = await db.sql.query<{total:string;non_indexer:string;allowed:boolean}>(`WITH seeded AS (
      INSERT INTO rpc_paid_daily(day,total,non_indexer)
        SELECT $1,coalesce(sum(calls),0),coalesce(sum(calls),0) FROM rpc_usage WHERE day=$1 AND provider='paid' AND method<>'__total__'
      ON CONFLICT(day) DO NOTHING
    ), updated AS (
      UPDATE rpc_paid_daily SET total=total+$2,non_indexer=non_indexer+CASE WHEN $3 THEN 0 ELSE $2 END
      WHERE day=$1 AND ($8 OR (total<$4 AND ($3 OR (non_indexer<$5 AND (total<$6 OR $7)))))
      RETURNING total,non_indexer
    ) SELECT total,non_indexer,true AS allowed FROM updated`,
      [day, step, indexer, p.ceiling, Math.max(0,p.ceiling-p.reserve), p.softLimit, p.urgent, p.incurred ?? false]);
    // PostgreSQL data-modifying CTEs share a snapshot: the first insert becomes visible on the next statement.
    if (!result.rows.length) {
      const retry = await db.sql.query<{total:string;non_indexer:string}>(`UPDATE rpc_paid_daily
        SET total=total+$2,non_indexer=non_indexer+CASE WHEN $3 THEN 0 ELSE $2 END
        WHERE day=$1 AND ($8 OR (total<$4 AND ($3 OR (non_indexer<$5 AND (total<$6 OR $7))))) RETURNING total,non_indexer`,
        [day,step,indexer,p.ceiling,Math.max(0,p.ceiling-p.reserve),p.softLimit,p.urgent,p.incurred ?? false]);
      if (retry.rows[0]) {
        const row=retry.rows[0];return {allowed:true,degraded:Number(row.total)>=p.softLimit,total:Number(row.total),nonIndexer:Number(row.non_indexer)};
      }
      const row = (await db.sql.query<{total:string;non_indexer:string}>('SELECT total,non_indexer FROM rpc_paid_daily WHERE day=$1',[day])).rows[0]!;
      return {allowed:false,degraded:Number(row.total)>=p.softLimit,total:Number(row.total),nonIndexer:Number(row.non_indexer)};
    }
    const row=result.rows[0];return {allowed:true,degraded:Number(row.total)>=p.softLimit,total:Number(row.total),nonIndexer:Number(row.non_indexer)};
  };
}
