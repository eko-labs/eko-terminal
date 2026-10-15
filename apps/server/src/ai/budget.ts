import { and, eq, gte, sql } from 'drizzle-orm';
import { FALLBACK_PRICE_PER_M, modelInfo, type ProviderId } from '@eko/shared';
import type { Db } from '../db/client.js';
import { inferenceRuns } from '../db/schema.js';

export function estimateCost(provider: ProviderId, model: string, inputTokens: number | null, outputTokens: number | null, route: 'direct' | 'gateway' = 'direct'): number {
  const info = modelInfo(provider, model, route);
  const pin = info?.inputPerM ?? FALLBACK_PRICE_PER_M.input;
  const pout = info?.outputPerM ?? FALLBACK_PRICE_PER_M.output;
  return ((inputTokens ?? 3000) * pin + (outputTokens ?? 2000) * pout) / 1_000_000;
}

/**
 * Inference cost controls: a hard daily ceiling across all providers and a per-bot hourly
 * call cap. Budgets are enforced BEFORE a call; spend is read back from recorded runs.
 */
export class InferenceBudget {
  constructor(
    private db: Db,
    private dailyUsd: number,
    private maxCallsPerBotHour: number,
  ) {}

  /** Conservative budget usage, including possible billed calls with lost responses. */
  async spentToday(now = Date.now()): Promise<number> {
    const dayStart = Math.floor(now / 86_400_000) * 86_400_000;
    const dayEnd = dayStart + 86_400_000;
    const result = await this.db.execute(sql`SELECT
      (SELECT coalesce(sum(est_cost_usd),0) FROM inference_runs WHERE started_at >= ${dayStart} AND started_at < ${dayEnd} AND reservation_id IS NULL)
      + (SELECT coalesce(sum(greatest(r.max_cost_usd,coalesce(b.cost,0))),0) FROM swarm_budget_reservations r
        LEFT JOIN LATERAL (SELECT sum(est_cost_usd) AS cost FROM inference_runs WHERE reservation_id=r.id) b ON true
        WHERE r.started_at >= ${dayStart} AND r.started_at < ${dayEnd}) AS total`);
    return Number((result as { rows: { total: unknown }[] }).rows[0]?.total ?? 0);
  }

  async check(botId: string, now = Date.now()): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (this.dailyUsd <= 0) return { ok: false, reason: 'AI_DAILY_BUDGET_USD is 0 — AI inference disabled' };
    const spent = await this.spentToday(now);
    if (spent >= this.dailyUsd) return { ok: false, reason: `Daily AI budget reached ($${spent.toFixed(2)} of $${this.dailyUsd.toFixed(2)})` };
    const [row] = await this.db
      .select({ n: sql<number>`count(*)` })
      .from(inferenceRuns)
      .where(and(eq(inferenceRuns.botId, botId), gte(inferenceRuns.startedAt, now - 3_600_000), sql`${inferenceRuns.outcome} in ('ok','abstained','rejected','error')`));
    if (Number(row?.n ?? 0) >= this.maxCallsPerBotHour) return { ok: false, reason: `Bot hourly call cap reached (${this.maxCallsPerBotHour}/h)` };
    return { ok: true };
  }

  get limits() {
    return { dailyUsd: this.dailyUsd, maxCallsPerBotHour: this.maxCallsPerBotHour };
  }
}

/** Reserve before I/O under a database lock. Unknown/failed calls retain their
 * ceiling across restarts: a lost response must never restore spend permission.
 * Both routes reserve independently, including a potentially billed failover.
 */
export async function reserveSwarmBudget(db: import('@eko/db').ChainDb, input: {
  id: string; jobId: string; coin: string; maxUsd: number; now: number;
  aiDailyUsd: number; dailyUsd: number; perCoinUsd: number;
}): Promise<boolean> {
  if (![input.maxUsd,input.aiDailyUsd,input.dailyUsd,input.perCoinUsd].every(n => Number.isFinite(n) && n > 0)
    || !Number.isSafeInteger(input.now) || input.now < 0) return false;
  input = {...input,coin:input.coin.toLowerCase()};
  return db.tx(async tx => {
    await tx.sql.query('LOCK TABLE swarm_budget_reservations IN SHARE ROW EXCLUSIVE MODE');
    const job = (await tx.sql.query<{state:string}>('SELECT state FROM swarm_jobs WHERE id=$1 FOR UPDATE',[input.jobId])).rows[0];
    if (job?.state !== 'running') return false;
    await tx.sql.query('UPDATE swarm_jobs SET started_at=clock_timestamp() WHERE id=$1',[input.jobId]);
    const start = Math.floor(input.now / 86400000) * 86400000;
    const end = start + 86400000;
    const row = (await tx.sql.query<{ total: string; coin: string }>(`SELECT coalesce(sum(greatest(max_cost_usd,coalesce(billed.cost,0))),0)::text AS total,
      coalesce(sum(CASE WHEN coin=$3 THEN greatest(max_cost_usd,coalesce(billed.cost,0)) ELSE 0 END),0)::text AS coin
      FROM swarm_budget_reservations r LEFT JOIN LATERAL
        (SELECT sum(est_cost_usd) AS cost FROM inference_runs WHERE reservation_id=r.id) billed ON true
      WHERE r.started_at >= $1 AND r.started_at < $2`, [start,end,input.coin])).rows[0]!;
    const legacy = (await tx.sql.query<{ total: string }>(`SELECT coalesce(sum(est_cost_usd),0)::text AS total FROM inference_runs
      WHERE started_at >= $1 AND started_at < $2 AND reservation_id IS NULL`, [start,end])).rows[0]!;
    // Integer microdollars rounded upward avoid floating point permission at a cap.
    const micros = (n: number) => Math.ceil(n * 1e6);
    const total = micros(Number(row.total)) + micros(input.maxUsd);
    if (total > Math.floor(Math.min(33,input.dailyUsd) * 1e6) || total + micros(Number(legacy.total)) > Math.floor(input.aiDailyUsd * 1e6)
      || micros(Number(row.coin)) + micros(input.maxUsd) > Math.floor(input.perCoinUsd * 1e6)) return false;
    await tx.sql.query('INSERT INTO swarm_budget_reservations VALUES($1,$2,$3,$4,$5)',
      [input.id,input.jobId,input.coin,input.now,input.maxUsd]);
    return true;
  });
}
