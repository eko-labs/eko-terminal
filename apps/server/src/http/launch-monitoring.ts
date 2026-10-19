import { metrics } from '../obs/metrics.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../app.js';
import { MeasurementSchema, checkNames } from '../obs/launch.js';
import { auditLog } from '../db/schema.js';
import { IncidentSchema } from '../obs/incidents.js';
import { phaseAt } from '../harness/entitlements.js';
import { sendError } from './v1/helpers.js';

// TODO(spec): Measurement ingestion and individual status-check URLs are not specified; use v1 conventions.
/**
 * Register public metrics/status reads and incident/measurement mutations. Mutations require a
 * wallet session explicitly in the configured admin wallet allowlist, allowed Origin and no demo
 * session; a stored admin role alone is insufficient. Invalid measurements/kinds reject; status
 * collection failure yields unavailable/503. Durable incident stop precedes delivery.
 * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../../docs/security/INVARIANTS.md | Implemented core invariants}
 */
export async function launchMonitoringRoutes(app: FastifyInstance, ctx: Ctx) {
  const { monitoring, incidents, auth, cfg, flags } = ctx;
  const admin = async (req: FastifyRequest) => {
    if (req.demoSession) throw Object.assign(new Error('Demo sessions cannot write'), { statusCode: 403 });
    const actor = await auth.fromToken(auth.readCookie(req));
    if (!actor || actor.kind !== 'wallet' || !actor.walletAddress) throw Object.assign(new Error('Wallet sign-in required'), { statusCode: 401 });
    // Database role alone is insufficient: §18 requires the wallet allowlist.
    if (!cfg.adminWallets.has(actor.walletAddress.toLowerCase())) throw Object.assign(new Error('Admin required'), { statusCode: 403 });
    auth.originFor(req, true);
    return actor;
  };
  const stage = async () => {
    const burn = phaseAt(cfg, Date.now()) !== 'launch_week';
    return { burn, summons: burn && await flags.isOn('summon_x') };
  };
  const collect = async () => {
    await monitoring.collect();
    if (ctx.budget.limits.dailyUsd > 0) await monitoring.record({ metric: 'ai_budget_ratio', value: await ctx.budget.spentToday() / ctx.budget.limits.dailyUsd });
  };
  app.get('/api/metrics/prometheus', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    await collect();
    const active = await stage();
    return reply.type('text/plain; version=0.0.4').send((await monitoring.prometheus(active.burn, active.summons)) + metrics.counterPrometheus());
  });
  app.get('/v1/health/checks/:check', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const input = z.enum(checkNames).safeParse((req.params as { check: string }).check);
    if (!input.success) return sendError(reply, 'not_found', 'Unknown status check');
    try {
      await collect();
      const active = await stage();
      const check = (await monitoring.checks(active.burn, active.summons))[input.data];
      return reply.status(check.state === 'healthy' || check.state === 'inactive' ? 200 : 503).send(check);
    } catch { return reply.status(503).send({ state: 'unavailable', value: null }); }
  });
  app.post('/admin/incident', async (req, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const actor = await admin(req);
    const input = IncidentSchema.safeParse(req.body);
    if (!input.success) return sendError(reply, 'bad_request', 'Unsupported incident kind or fields');
    const result = await incidents.raise(actor.id, input.data.kind);
    if (input.data.kind === 'guard_miss') await monitoring.record({ metric: 'post_fill_sell_failure', value: 1 });
    return result;
  });
  app.post('/v1/admin/monitoring/measurements', async (req, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const actor = await admin(req);
    const input = MeasurementSchema.safeParse(req.body);
    if (!input.success) return sendError(reply, 'bad_request', 'Invalid monitoring measurement');
    await monitoring.record(input.data);
    await ctx.dbh.db.insert(auditLog).values({ accountId: actor.id, action: 'ops.measurement_recorded', data: input.data });
    return { recorded: true };
  });
}
