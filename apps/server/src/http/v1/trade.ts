import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ExecutionService } from '../../exec/service.js';
import { TradeError, TradeInputSchema, TradeOrderInputSchema } from '../../exec/trades.js';
import type { AccountServices } from './account.js';
import { parse, sendError } from './helpers.js';

/**
 * Register bounded private trade quote/order/report/history routes. Enforce Origin on writes,
 * reject demo sessions, and require wallet sessions for orders; quotes may establish an anonymous
 * account. Delegate admission and ownership to execution services; TradeError uses the bounded
 * response envelope.
 */
export async function tradeRoutes(app: FastifyInstance, { auth }: AccountServices, exec: ExecutionService) {
  app.addHook('onRequest', async (_req, reply) => { reply.header('Cache-Control', 'private, no-store'); });
  const limits = (max: number) => ({ config: { rateLimit: { max, timeWindow: '1 minute' } } });
  app.post('/trade/quote', limits(90), async (req, reply) => {
    const input = parse(TradeInputSchema, req.body);
    auth.originFor(req, true);
    const account = await auth.ensure(req, reply);
    if (req.demoSession) return sendError(reply, 'forbidden', 'Demo sessions cannot request trade quotes');
    // TODO(spec): preferences have no risk mode yet; use the strictest preset when omitted.
    try { return await exec.tradeQuote({ id: account.id, wallet: account.walletAddress }, { ...input, riskMode: input.riskMode ?? 'safe' }); }
    catch (error) { if (error instanceof TradeError) return sendError(reply, error.code, error.message); throw error; }
  });
  app.post('/trade/order', limits(40), async (req, reply) => {
    const input = parse(TradeOrderInputSchema, req.body);
    auth.originFor(req, true);
    if (req.demoSession) return sendError(reply, 'forbidden', 'Demo sessions cannot trade');
    const account = await auth.fromToken(auth.readCookie(req));
    if (!account || account.kind !== 'wallet' || !account.walletAddress) return sendError(reply, 'wallet_auth_required', 'Wallet sign-in required');
    try {
      const { duplicate, ...result } = await exec.tradeOrder({ id: account.id, wallet: account.walletAddress }, input);
      return reply.status(duplicate ? 200 : 201).send(result);
    } catch (error) { if (error instanceof TradeError) return sendError(reply, error.code, error.message); throw error; }
  });

  const params = z.strictObject({ id: z.string().uuid() });
  const owner = async (req: FastifyRequest) => {
    if (req.demoSession) throw new TradeError('forbidden', 'Demo sessions cannot access orders');
    const account = await auth.fromToken(auth.readCookie(req));
    if (!account || account.kind !== 'wallet' || !account.walletAddress) throw new TradeError('wallet_auth_required', 'Wallet sign-in required');
    return { id: account.id, wallet: account.walletAddress };
  };
  const handle = async (reply: import('fastify').FastifyReply, run: () => Promise<unknown>) => {
    try { return await run(); }
    catch (error) { if (error instanceof TradeError) return sendError(reply, error.code, error.message); throw error; }
  };
  app.post('/trade/order/:id/submitted', limits(40), async (req, reply) => {
    auth.originFor(req, true);
    const { id } = parse(params, req.params);
    const { txHash } = parse(z.strictObject({ txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }), req.body);
    return handle(reply, async () => exec.tradeSubmitted(await owner(req), id, txHash));
  });
  app.post('/trade/order/:id/rejected', limits(40), async (req, reply) => {
    auth.originFor(req, true);
    const { id } = parse(params, req.params);
    // TODO(spec): CA-7 does not specify rejection input; retain finite wallet outcomes, never provider messages.
    const { code } = parse(z.strictObject({ code: z.enum(['user_rejected', 'signing_failed']) }), req.body);
    return handle(reply, async () => exec.tradeRejected(await owner(req), id, code));
  });
  app.get('/trade/orders', limits(90), async (req, reply) => {
    const { limit, cursor } = parse(z.strictObject({ limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().uuid().optional() }), req.query);
    return handle(reply, async () => exec.tradeHistory(await owner(req), limit, cursor));
  });
  app.get('/trade/orders/:id', limits(90), async (req, reply) => {
    const { id } = parse(params, req.params);
    return handle(reply, async () => exec.tradeDetail(await owner(req), id));
  });
}
