import { z } from 'zod';
import { AlertSettingsSchema, WatchBodySchema } from '@eko/shared';
import type { FastifyInstance } from 'fastify';
import type { AuthService } from '../auth.js';
import type { WatchAlertsService } from '../../alerts/service.js';
import { parse, sendError } from './helpers.js';

export interface WatchServices { auth: AuthService; alerts: WatchAlertsService }
/**
 * Register account-scoped watches, alert settings and ascending delivery history. Wallet sessions
 * are required for the group; writes require allowed Origin, with global demo guard supplied by
 * the app. Validation/auth/storage failures reject; request account is set from the verified
 * session.
 * @see {@link ../../../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../../../docs/security/INVARIANTS.md | Implemented core invariants}
 */
export async function watchRoutes(app: FastifyInstance, { auth, alerts }: WatchServices) {
  app.addHook('onRequest', async (req, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    if (!['GET','HEAD','OPTIONS'].includes(req.method)) auth.originFor(req, true);
    const account = await auth.fromToken(auth.readCookie(req));
    if (!account || account.kind !== 'wallet') return sendError(reply, 'wallet_auth_required', 'Verify your wallet to manage watches and alerts.');
    req.account = account;
  });
  // TODO(spec): CA-28 has no watch list/delete wrappers; return shared WatchBody
  // items to match existing callers, delete by the POST body, and acknowledge idempotently.
  app.get('/watch', async req => ({ items: await alerts.watches(req.account!.id) }));
  app.post('/watch', async req => alerts.add(req.account!.id, parse(WatchBodySchema, req.body)));
  app.delete('/watch', async req => {
    await alerts.remove(req.account!.id, parse(WatchBodySchema, req.body));
    return { ok: true };
  });
  app.get('/alerts/settings', async req => alerts.settings(req.account!.id));
  app.put('/alerts/settings', async req => alerts.saveSettings(req.account!.id, parse(AlertSettingsSchema, req.body)));
  // TODO(spec): reconnect recovery has no frozen REST endpoint. Expose a private
  // ascending delivery cursor at GET /alerts?after=<seq>, matching the WS stream.
  app.get('/alerts', async req => {
    const { after } = parse(z.object({ after: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0) }), req.query);
    return alerts.history(req.account!.id, after);
  });
}
