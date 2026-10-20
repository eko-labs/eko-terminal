import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AuthService } from '../auth.js';
import type { TelegramLinkService } from '../../telegram/link.js';
import { parse, sendError } from './helpers.js';

export interface TelegramServices { auth: AuthService; telegram: TelegramLinkService }
/**
 * Register private no-store Telegram link/unlink routes with Origin and wallet-session checks.
 * Issue owner-bound links or return not_found when unconfigured; deletion idempotently revokes
 * linking and queued notices. Storage/validation failures propagate.
 */
export async function telegramRoutes(app: FastifyInstance, { auth, telegram }: TelegramServices) {
  app.addHook('onRequest', async (req, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    reply.header('Referrer-Policy', 'no-referrer');
    auth.originFor(req, true);
    const account = await auth.fromToken(auth.readCookie(req));
    if (!account || account.kind !== 'wallet') return sendError(reply, 'wallet_auth_required', 'Verify your wallet to link Telegram alerts.');
    req.account = account;
  });
  app.post('/telegram/link', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    parse(z.strictObject({}).default({}), req.body);
    const link = await telegram.issue(req.account!.id);
    return link ?? sendError(reply, 'not_found', 'Telegram linking is not configured.');
  });
  // TODO(spec): CA-22 names only POST; DELETE /telegram/link is the owner-only,
  // idempotent unlink counterpart. Revokes outstanding codes and pending notices.
  app.delete('/telegram/link', async req => {
    await telegram.unlink(req.account!.id);
    return { ok: true };
  });
}
