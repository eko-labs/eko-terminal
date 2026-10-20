import { loopHealth } from '../../loop-health.js';
import { readRpcRoleHealth } from '@eko/chain';
import type { RpcUsageDb } from '@eko/chain';
import type { RpcMeter } from '@eko/chain';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Config } from '../../config.js';
import { runtimeIdentity } from '../../build-identity.js';

/**
 * Register database liveness and separate loop readiness with the same status body. Stale cycles
 * only make /health/loops return HTTP 503; database failures make both return 503. No wallet auth
 * or chain probe is required; provider error details are withheld. The additive /build route
 * returns only baked bundle metadata, role and an allowlisted config digest;
 * invalid production image identity prevents route registration.
 * @see {@link ../../../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../../../docs/security/INVARIANTS.md | Implemented core invariants}
 */
export async function healthRoutes(app: FastifyInstance, rpcUsage: () => ReturnType<RpcMeter['usage']>, cfg: Config, databaseProbe: () => Promise<unknown>, health = () => loopHealth({}), roleDb?: Pick<RpcUsageDb, 'sql'>) {
  const identity = runtimeIdentity(cfg);
  const respond = (requireLoops: boolean) => async (_request: unknown, reply: FastifyReply) => {
    const status = health();
    const loops = Object.fromEntries(Object.entries(status.loops).map(([name, cycle]) => [name, {
      name, lastCycleAt: cycle.lastCycleAt, periodSec: cycle.periodMs / 1000, stale: !cycle.ok,
    }]));
    let roles: Awaited<ReturnType<typeof readRpcRoleHealth>> = {};
    let ok = true;
    let rpc: Awaited<ReturnType<typeof rpcUsage>> | null = null;
    try { await databaseProbe(); if (roleDb) roles = await readRpcRoleHealth(roleDb); } catch { ok = false; }
    // Usage is diagnostic data; its collection must not turn database liveness into a failure.
    if (ok) { try { rpc = await rpcUsage(); } catch { /* Keep liveness independent of telemetry. */ } }
    return reply.header('Cache-Control', 'no-store').code(ok && (!requireLoops || status.ok && Object.keys(roles).length === 0) ? 200 : 503).send({ ok, loops: { ...loops, ...roles }, rpc });
  };
  app.get('/health', respond(false));
  app.get('/health/loops', respond(true));
  // Deployment-only additive identity endpoint.
  app.get('/build', async (_request, reply) => reply.header('Cache-Control', 'no-store').send(identity));
}
