import type { FastifyInstance } from 'fastify';
import type { FarcasterHandler } from './handler.js';
import { FARCASTER_BODY_LIMIT } from './verify.js';

/** Encapsulated raw-body parser: leave other routes' JSON parsing unchanged. No live wiring. */
export async function farcasterWebhook(app: FastifyInstance, handler: FarcasterHandler) {
  await app.register(async route => {
    route.removeContentTypeParser('application/json');
    route.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
    route.post('/farcaster/mentions', { bodyLimit: FARCASTER_BODY_LIMIT, logLevel: 'silent' }, async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!handler.verifier.valid(req.body, req.headers['x-neynar-signature'])) return reply.code(403).send({ state: 'forbidden' });
      const parsed = handler.verifier.parse(req.body);
      if (!parsed?.success) return reply.code(422).send({ state: 'invalid_event' });
      return reply.code(503).send({ state: 'transport_disabled' });
    });
  });
}
