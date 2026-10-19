import { z } from 'zod';
import { AddressSchema, BagShareRequestSchema, BagShareResponseSchema } from '@eko/shared';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { BagsService } from '../../read/bags.js';
import type { ReadStore } from '../../read/store.js';
import type { AccountServices } from './account.js';
import { parse, sendError } from './helpers.js';

/**
 * Register wallet-owner holdings, explicit share creation and public immutable shared reports.
 * Holdings require a matching wallet session; sharing also requires allowed Origin and rejects
 * demos; demos cannot request scan retries. Invalid input, foreign wallet, missing report or
 * storage/RPC failures reject; private responses remain no-store.
 * @see {@link ../../../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../../../docs/security/INVARIANTS.md | Implemented core invariants}
 */
export async function bagsRoutes(app: FastifyInstance, store: ReadStore, services: AccountServices) {
  const bags = new BagsService(store, services.db, services.client);
  // Even denied requests and rate-limit errors cannot be shared-cache entries.
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('Cache-Control', 'private, no-store');
    return payload;
  });
  const owner = async (req: FastifyRequest, reply: FastifyReply) => {
    const address = parse(z.object({ address: AddressSchema }), req.params).address;
    const account = await services.auth.fromToken(services.auth.readCookie(req));
    if (!account || account.kind !== 'wallet' || !account.walletAddress) {
      sendError(reply, 'wallet_auth_required', 'Verify your wallet to view holdings.'); return;
    }
    if (account.walletAddress.toLowerCase() !== address) {
      sendError(reply, 'forbidden', 'Wallet holdings are available to the owner only.'); return;
    }
    return address;
  };
  const bounded = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };
  app.get('/wallets/:address/bags', bounded, async (req, reply) => {
    const wallet = await owner(req, reply); if (!wallet) return reply;
    const query = parse(z.object({ cursor: AddressSchema.optional(), retry: z.enum(['true', 'false']).optional() }).strict(), req.query);
    if (req.demoSession && query.retry === 'true') return sendError(reply, 'forbidden', 'Demo sessions cannot retry scans');
    return bags.report(wallet, { cursor: query.cursor, retry: query.retry === 'true' });
  });
  app.post('/wallets/:address/bags/share', bounded, async (req, reply) => {
    if (req.demoSession) return sendError(reply, 'forbidden', 'Demo sessions cannot write');
    services.auth.originFor(req, true);
    const wallet = await owner(req, reply); if (!wallet) return reply;
    const input = parse(BagShareRequestSchema, req.body);
    return reply.code(201).send(BagShareResponseSchema.parse(await bags.share(wallet, input)));
  });
  app.get('/bags/:id', async (req, reply) => {
    const id = parse(z.object({ id: z.uuid() }), req.params).id;
    const snapshot = await bags.publicReport(id);
    return snapshot ?? sendError(reply, 'not_found', 'Bag report not found.');
  });
}
