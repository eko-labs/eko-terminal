import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { DEFAULT_PREFERENCES, MeSchema, PreferencesSchema, ReferralsSchema, SiweVerifySchema, type Me } from '@eko/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Hex, PublicClient } from 'viem';
import type { Config } from '../../config.js';
import type { Db } from '../../db/client.js';
import { linkedIdentities, preferences, referralCodes, referrals } from '../../db/schema.js';
import { AuthService, SESSION_COOKIE, type Account } from '../auth.js';
import { sharedAddressLimit } from '../address-limit.js';
import { EntitlementsService } from '../../harness/entitlements.js';
export { EntitlementsService } from '../../harness/entitlements.js';
import { parse, sendError } from './helpers.js';

export interface AccountServices { auth: AuthService; db: Db; client: PublicClient }

/**
 * Register SIWE challenge/verification/logout and account/preferences/referral reads. Challenge
 * creation may create a guest; verification requires a current session, v1 bindings and signature.
 * Mutations require allowed Origin; preference/referral checks differ between session and wallet
 * requirements. Validation/auth/storage errors produce route errors; sessions rotate on sign-in
 * and logout clears the same cookie scope.
 * @see {@link ../../../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../../../docs/security/INVARIANTS.md | Implemented core invariants}
 */
export async function accountRoutes(app: FastifyInstance, cfg: Config, services: AccountServices) {
  const { auth, db, client } = services;
  const entitlements = new EntitlementsService(cfg);
  app.addHook('onRequest', async (_req, reply) => { reply.header('Cache-Control', 'private, no-store'); });
  const current = async (req: FastifyRequest) => auth.fromToken(auth.readCookie(req));
  const codeFor = async (account: Account) => {
    if (account.kind !== 'wallet') return '';
    await db.insert(referralCodes).values({ accountId: account.id, code: randomBytes(12).toString('base64url') }).onConflictDoNothing({ target: referralCodes.accountId });
    const [row] = await db.select().from(referralCodes).where(eq(referralCodes.accountId, account.id));
    return row!.code;
  };
  const me = async (account: Account): Promise<Me> => MeSchema.parse({
    account: { id: account.id, ...(account.walletAddress ? { wallet: account.walletAddress } : {}),
      linked: (await db.select({ provider: linkedIdentities.provider }).from(linkedIdentities).where(eq(linkedIdentities.accountId, account.id))).map(row => row.provider) },
    entitlements: entitlements.get(), trial: { status: 'not_open' },
    holdings: { minBalance24h: null }, referralCode: await codeFor(account),
  });
  const tight = (max: number) => ({ config: { rateLimit: { max, timeWindow: '1 minute' } } });
  app.post('/auth/siwe/nonce', tight(30), async (req, reply) => {
    auth.originFor(req, true);
    const account = await auth.ensure(req, reply);
    return auth.challenge(req, account.id);
  });
  // A failed signature falls back to an on-chain contract-wallet check, so sign-in attempts are also capped per address.
  const verifyPerAddress = sharedAddressLimit(app, 'siwe-verify', 60);
  app.post('/auth/siwe/verify', { ...tight(20), preHandler: verifyPerAddress }, async (req, reply) => {
    auth.originFor(req, true);
    const body = parse(SiweVerifySchema, req.body);
    const account = await current(req);
    if (!account) return sendError(reply, 'wallet_auth_required', 'Sign in again to continue.');
    let verified: Account;
    try { verified = await auth.verifySiwe(req, reply, account, body.message, body.signature as Hex, { 4663: client }, true); }
    catch (error) { return sendError(reply, 'unauthorized', (error as Error).message); }
    if (body.ref) {
      const [referrer] = await db.select().from(referralCodes).where(eq(referralCodes.code, body.ref));
      if (referrer && referrer.accountId !== verified.id) await db.insert(referrals).values({ referredAccountId: verified.id, referrerAccountId: referrer.accountId }).onConflictDoNothing();
    }
    return me(verified);
  });
  app.post('/auth/logout', async (req, reply) => {
    auth.originFor(req, true);
    await auth.destroySession(auth.readCookie(req));
    reply.clearCookie(SESSION_COOKIE, auth.cookieOptions());
    return { ok: true };
  });
  app.get('/me', async (req, reply) => me(await auth.ensure(req, reply)));
  app.get('/me/preferences', async (req, reply) => {
    const account = await current(req);
    if (!account) return sendError(reply, 'wallet_auth_required', 'Sign in again to continue.');
    const [row] = await db.select().from(preferences).where(eq(preferences.accountId, account.id));
    return PreferencesSchema.parse(row?.data ?? DEFAULT_PREFERENCES);
  });
  app.put('/me/preferences', async (req, reply) => {
    auth.originFor(req, true);
    const account = await current(req);
    if (!account) return sendError(reply, 'wallet_auth_required', 'Sign in again to continue.');
    const data = parse(PreferencesSchema, req.body);
    await db.insert(preferences).values({ accountId: account.id, data }).onConflictDoUpdate({ target: preferences.accountId, set: { data, updatedAt: new Date() } });
    // TODO(spec): CA-10 does not freeze a preference response wrapper; return the
    // shared Preferences object directly, matching GET and the v1 client.
    return data;
  });
  app.get('/referrals', async (req, reply) => {
    const account = await current(req);
    if (!account || account.kind !== 'wallet') return sendError(reply, 'wallet_auth_required', 'Verify your wallet to view referrals.');
    const code = await codeFor(account);
    const [count] = await db.select({ n: sql<number>`count(*)::int` }).from(referrals).where(eq(referrals.referrerAccountId, account.id));
    return ReferralsSchema.parse({ code, link: `${cfg.origins[0]}/?ref=${code}`, referred: count!.n, qualified: 0, bonusMinutes: 0 });
  });
}
