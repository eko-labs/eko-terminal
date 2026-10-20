import { TELEMETRY_BODY_LIMIT, TelemetrySchema } from '@eko/shared';
import type { FastifyInstance } from 'fastify';
import { metrics } from '../../obs/metrics.js';
import { observeTelemetry, type LatencyStore } from '../../obs/telemetry.js';
import { sendError } from './helpers.js';
import { addressKey } from '../address-limit.js';

/**
 * Register anonymous schema-bounded telemetry POST with finite body size and per-IP rate limit. No
 * wallet session; demo attribution is marked separately. Invalid/oversized/rate-limited input
 * yields fixed errors without echoing private field names; unexpected ingress failures use the
 * shared envelope.
 * @see {@link ../../../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../../../docs/security/INVARIANTS.md | Implemented core invariants}
 */
export function telemetryIngress(app: FastifyInstance, path = '/telemetry') {
  app.setErrorHandler((err, _req, reply) => {
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 429) return sendError(reply, 'rate_limited', 'Telemetry rate limit exceeded');
    if (status === 413) return reply.status(413).send({ error: 'bad_request', message: 'Telemetry body too large' });
    return sendError(reply, status && status < 500 ? 'bad_request' : 'internal_error', 'Telemetry request failed');
  });
  app.post(path, {
    bodyLimit: TELEMETRY_BODY_LIMIT,
    config: { rateLimitKeyKind: 'address', rateLimit: { max: 120, timeWindow: '1 minute', keyGenerator: req => addressKey(req.ip) } },
  }, async (req, reply) => {
    const parsed = TelemetrySchema.safeParse(req.body);
    // Zod errors can echo unknown field names; never return private input.
    if (!parsed.success) return sendError(reply, 'bad_request', 'Invalid telemetry');
    observeTelemetry(parsed.data, !!req.demoSession);
    reply.header('Cache-Control', 'no-store');
    return { ok: true };
  });
}

/**
 * Register anonymous telemetry ingress and aggregate metric reads with no-store responses. No
 * wallet auth. Ingress uses bounded validation; aggregate database failures reject and no raw
 * telemetry rows are returned here.
 * @see {@link ../../../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../../../docs/security/INVARIANTS.md | Implemented core invariants}
 */
export async function telemetryRoutes(app: FastifyInstance, store: LatencyStore) {
  telemetryIngress(app);
  app.get('/metrics', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { metrics: metrics.summary(), telemetry: await store.aggregate(), retentionDays: 30, at: Date.now() };
  });
}
