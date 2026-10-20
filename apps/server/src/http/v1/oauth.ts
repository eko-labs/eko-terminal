import { z } from 'zod';
import { OAuthConsentSchema } from '@eko/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Config } from '../../config.js';
import type { AuthService } from '../auth.js';
import { EntitlementsService } from '../../harness/entitlements.js';
import { HarnessError } from '../../harness/service.js';
import type { OAuthConsentService } from '../../harness/oauth-consent.js';
import { InputError, parse, sendError } from './helpers.js';
import { addressKey } from '../address-limit.js';

export interface OAuthConsentServices { auth: AuthService; consent: OAuthConsentService }
/**
 * Register bounded private consent inspection/decision routes with no-store, no-referrer and
 * frame refusal. Require allowed Origin, signed session and no demo mode; the service requires
 * fresh wallet authentication and owner-bound requests. Return bounded errors and entitlement-
 * limited agent creation. Production wiring remains omitted until connector acceptance.
 */
export async function oauthConsentRoutes(app: FastifyInstance, cfg: Config, services: OAuthConsentServices) {
  app.addHook('onRequest', async (_req, reply) => {
    reply.header('Cache-Control', 'private, no-store').header('Content-Security-Policy', "frame-ancestors 'none'").header('Referrer-Policy', 'no-referrer');
  });
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof HarnessError) return sendError(reply, error.code, error.message);
    if (error instanceof InputError) return sendError(reply, 'bad_request', error.message);
    if (error instanceof Error && 'statusCode' in error && error.statusCode === 403) return sendError(reply, 'forbidden', 'Forbidden');
    if (error instanceof Error && 'statusCode' in error && error.statusCode === 429) return sendError(reply, 'rate_limited', 'Too many consent requests.');
    return sendError(reply, 'internal_error', 'Consent is unavailable.');
  });
  const token = (req: FastifyRequest) => {
    if (req.demoSession) throw new HarnessError('forbidden', 'Demo consent is unavailable.');
    services.auth.originFor(req, true);
    return services.auth.readCookie(req);
  };
  const bounded = { config: { rateLimit: { max: 30, timeWindow: '1 minute', keyGenerator: (req: FastifyRequest) => services.auth.readCookie(req) ?? addressKey(req.ip) } } };
  app.get('/oauth/requests/:id', bounded, req => services.consent.inspect(token(req), parse(z.object({ id: z.uuid() }), req.params).id));
  app.post('/oauth/consent', bounded, req => services.consent.consent(token(req), parse(OAuthConsentSchema, req.body), new EntitlementsService(cfg).get().limits.agents));
}
