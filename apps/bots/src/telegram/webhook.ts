import type { FastifyInstance } from 'fastify';
import type { TelegramHandler } from './handler.js';

/** Prepared route only: deployment transport is deliberately unavailable under packet 116. */
export async function telegramWebhook(app: FastifyInstance, handler: TelegramHandler) {
  app.post('/tg/:secret', { bodyLimit: 32768, logLevel: 'silent' }, async (req, reply) => {
    const secret = (req.params as { secret?: unknown }).secret;
    if (!handler.validSecret(secret) || !handler.validSecret(req.headers['x-telegram-bot-api-secret-token'])) {
      return reply.code(403).send({ state: 'forbidden' });
    }
    return reply.code(503).send({ state: 'transport_disabled' });
  });
}
