import { AddressSchema } from '@eko/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../config.js';
import { auditLog, featureFlags, tradingAllowlist } from '../../db/schema.js';
import type { AccountServices } from './account.js';
import { list, parse, sendError } from './helpers.js';

// TODO(spec): Admin maintenance URLs/response shape are unspecified; use the existing v1 conventions.
/**
 * Register allowlist read/upsert/delete and durable trading stop/resume with audit writes. Require
 * a wallet-session admin role; refuse demos and require allowed Origin for mutations. Caps may
 * only lower the configured role ceiling; enabling above the host ceiling refuses.
 * Validation/auth/SQL failures reject.
 * @see {@link ../../../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../../../docs/security/INVARIANTS.md | Implemented core invariants}
 */
export async function tradeAdminRoutes(app: FastifyInstance, cfg: Config, { auth, db }: AccountServices) {
  app.addHook('onRequest', async (_req, reply) => { reply.header('Cache-Control', 'private, no-store'); });
  const admin = async (req: FastifyRequest) => {
    if (req.demoSession) throw Object.assign(new Error('Demo sessions cannot write'), { statusCode: 403 });
    const account = await auth.fromToken(auth.readCookie(req));
    if (!account || account.kind !== 'wallet' || !account.walletAddress)
      throw Object.assign(new Error('Wallet sign-in required'), { statusCode: 401 });
    if (account.role !== 'admin') throw Object.assign(new Error('Admin required'), { statusCode: 403 });
    if (req.method !== 'GET') auth.originFor(req, true);
    return account;
  };
  app.get('/admin/trading/allowlist', async req => {
    await admin(req);
    return list(await db.select().from(tradingAllowlist).orderBy(tradingAllowlist.wallet));
  });
  app.put('/admin/trading/allowlist/:wallet', async req => {
    const actor = await admin(req);
    const wallet = parse(AddressSchema, (req.params as { wallet: unknown }).wallet).toLowerCase();
    const input = parse(z.strictObject({ role: z.enum(['team', 'beta_user']), capUsd: z.number().positive().optional(), note: z.string().max(500).default('') }), req.body);
    const defaultCap = cfg.tradeCaps.beta.defaultCapUsd[input.role];
    const capUsd = input.capUsd ?? defaultCap;
    if (capUsd > defaultCap) throw Object.assign(new Error('Wallet cap may only lower the role cap'), { statusCode: 422 });
    return db.transaction(async tx => {
      const [row] = await tx.insert(tradingAllowlist).values({ wallet, role: input.role, capUsd, addedBy: actor.id, note: input.note })
        .onConflictDoUpdate({ target: tradingAllowlist.wallet, set: { role: input.role, capUsd, addedBy: actor.id, addedAt: new Date(), note: input.note } }).returning();
      await tx.insert(auditLog).values({ accountId: actor.id, action: 'trading.allowlist_upsert', data: row! });
      return row;
    });
  });
  app.delete('/admin/trading/allowlist/:wallet', async req => {
    const actor = await admin(req);
    const wallet = parse(AddressSchema, (req.params as { wallet: unknown }).wallet).toLowerCase();
    return db.transaction(async tx => {
      const [previous] = await tx.delete(tradingAllowlist).where(eq(tradingAllowlist.wallet, wallet)).returning();
      await tx.insert(auditLog).values({ accountId: actor.id, action: 'trading.allowlist_delete', data: { wallet, previous: previous ?? null } });
      return { ok: true };
    });
  });
  app.put('/admin/trading/live', async (req, reply) => {
    const actor = await admin(req);
    const { enabled } = parse(z.strictObject({ enabled: z.boolean() }), req.body);
    if (enabled && !cfg.LIVE_TRADING_ENABLED) return sendError(reply, 'trading_paused', 'Live trading ceiling is off');
    await db.transaction(async tx => {
      await tx.insert(featureFlags).values({ key: 'trading_live', enabled, audience: 'public' })
        .onConflictDoUpdate({ target: featureFlags.key, set: { enabled, audience: 'public' } });
      await tx.insert(auditLog).values({ accountId: actor.id, action: 'trading.live_changed', data: { enabled } });
    });
    return { enabled };
  });
}
