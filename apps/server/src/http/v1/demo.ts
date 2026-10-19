import type {} from '@fastify/cookie';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { FlagNameSchema, type FlagName } from '@eko/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../config.js';
import { notFound, parse, sendError } from './helpers.js';

export const DEMO_COOKIE = 'eko_demo';
export const DEMO_TTL_MS = 24 * 60 * 60 * 1000;
const PayloadSchema = z.object({
  flags: z.array(FlagNameSchema).max(100),
  expiry: z.number().int().positive(),
}).strict();
export type DemoSession = z.infer<typeof PayloadSchema>;

declare module 'fastify' {
  interface FastifyRequest {
    demoSession: DemoSession | null;
  }
}

/**
 * Mint a 24-hour HMAC demo token with deduplicated flags. Host issuer must possess the configured
 * demo secret; it is not wallet authorization. Short secret or invalid payload throws.
 * @see {@link ../../../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../../../docs/security/INVARIANTS.md | Implemented core invariants}
 */
export function createDemoToken(flags: FlagName[], secret: string, now = Date.now()): string {
  if (secret.length < 32) throw new Error('DEMO_SECRET (≥32 chars) is required');
  const payload = PayloadSchema.parse({ flags: [...new Set(flags)], expiry: now + DEMO_TTL_MS });
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encoded}.${createHmac('sha256', secret).update(encoded).digest('base64url')}`;
}

/**
 * Verify bounded token shape, canonical signature encoding, constant-time HMAC, schema and expiry
 * window. Authentication is the demo-secret signature only; invalid/missing/expired input returns
 * null and grants no trading rights.
 * @see {@link ../../../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../../../docs/security/INVARIANTS.md | Implemented core invariants}
 */
export function verifyDemoToken(token: string, secret: string | undefined, now = Date.now()): DemoSession | null {
  if (!secret || token.length > 4096) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encoded, signature] = parts as [string, string];
  // Reject noncanonical encodings so alternate representations can't bypass signature checks.
  if (!/^[A-Za-z0-9_-]+$/.test(encoded) || !/^[A-Za-z0-9_-]{43}$/.test(signature)) return null;
  const expected = createHmac('sha256', secret).update(encoded).digest();
  const supplied = Buffer.from(signature, 'base64url');
  if (supplied.toString('base64url') !== signature || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  try {
    const payload = PayloadSchema.safeParse(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')));
    if (!payload.success || payload.data.expiry <= now || payload.data.expiry > now + DEMO_TTL_MS) return null;
    return payload.data;
  } catch {
    return null;
  }
}

/** Demo sessions may sign in/out, send telemetry and POST bounded read-only RPC. None of them trade or
 * write harness data (CA-9), and blocking sign-in would lock a visitor who opened a demo link out for 24 h. */
export const DEMO_WRITE_ALLOW = new Set(['/api/auth/verify', '/api/auth/logout', '/api/telemetry', '/v1/telemetry', '/v1/auth/siwe/nonce', '/v1/auth/siwe/verify', '/v1/auth/logout', '/v1/rpc']);

/** Mandatory for later write routes; also installed globally for legacy and v1 HTTP writes.
 * @remarks
 * Refuse demo HTTP mutations except the finite auth/telemetry/read-RPC allowlist, returning
 * forbidden. Requires the caller to populate demoSession; this does not resolve wallet
 * authentication itself.
 * @see {@link ../../../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../../../docs/security/INVARIANTS.md | Implemented core invariants}
 */
export function guardDemoWrite(req: FastifyRequest, reply: FastifyReply) {
  if (req.demoSession && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !DEMO_WRITE_ALLOW.has(req.url.split('?')[0]!)) {
    return sendError(reply, 'forbidden', 'Demo sessions cannot write');
  }
}

/**
 * Decorate requests, validate any demo cookie and apply the global demo-write refusal hook. Host
 * registration call; invalid tokens become null, while plugin/decorator registration failures
 * throw.
 * @see {@link ../../../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../../../docs/security/INVARIANTS.md | Implemented core invariants}
 */
export function installDemoGuard(app: FastifyInstance, cfg: Config) {
  app.decorateRequest('demoSession', null);
  app.addHook('onRequest', async (req, reply) => {
    const token = req.cookies[DEMO_COOKIE];
    req.demoSession = token ? verifyDemoToken(token, cfg.DEMO_SECRET) : null;
    guardDemoWrite(req, reply);
  });
}

/**
 * Register token-based demo session entry, setting a bounded HttpOnly cookie with no-store/no-
 * referrer headers. Demo bearer authentication only; invalid token yields not_found and malformed
 * input rejects. It grants display flags, not wallet execution.
 * @see {@link ../../../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../../../docs/security/INVARIANTS.md | Implemented core invariants}
 */
export async function demoRoutes(app: FastifyInstance, cfg: Config) {
  app.get('/demo/:token', async (req, reply) => {
    const { token } = parse(z.object({ token: z.string() }), req.params);
    const session = verifyDemoToken(token, cfg.DEMO_SECRET);
    reply.header('Cache-Control', 'private, no-store');
    reply.header('Referrer-Policy', 'no-referrer');
    if (!session) return notFound(reply);
    reply.setCookie(DEMO_COOKIE, token, {
      path: '/', httpOnly: true, secure: cfg.NODE_ENV === 'production', sameSite: 'lax',
      maxAge: Math.floor((session.expiry - Date.now()) / 1000),
    });
    return { ok: true };
  });
}
