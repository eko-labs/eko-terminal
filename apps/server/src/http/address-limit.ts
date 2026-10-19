import { recordAddressRejection } from '../obs/rate-limits.js';
import { isIPv6 } from 'node:net';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * The rate-limit identity of a client address. IPv4 (and IPv4-mapped IPv6) is the address itself; other IPv6 is
 * grouped by its /64, the block one subscriber usually holds, so rotating within it does not reset a bucket.
 */
export function addressKey(ip: string | undefined): string {
  // Some transports (for example a socket without a peer address) give no address; they share one bucket.
  if (!ip) return 'unknown';
  const value = ip.toLowerCase().split('%')[0]!;
  if (!isIPv6(value)) return value;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  if (mapped) return mapped[1]!;
  const groups = (part: string) => part ? part.split(':').flatMap(group => {
    if (!group.includes('.')) return [group];
    const [a, b, c, d] = group.split('.').map(Number);
    return [((a! << 8) | b!).toString(16), ((c! << 8) | d!).toString(16)];
  }) : [];
  const [head, tail] = value.split('::');
  const left = groups(head ?? ''), right = tail === undefined ? [] : groups(tail);
  const full = tail === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  return `${full.slice(0, 4).map(group => parseInt(group, 16).toString(16)).join(':')}::/64`;
}

type Limiter = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
const shared = new WeakMap<object, Map<string, Limiter>>();

/**
 * A per-client-address cap layered over the per-session limits. GET /v1/me mints a guest session for anyone,
 * so session buckets alone never bound one client. Unlike a second route limiter, this does not mark the
 * request as already limited, so the route's own per-session limit still applies.
 */
export function addressLimit(app: FastifyInstance, max: number, skip: (req: FastifyRequest) => boolean = () => false): Limiter {
  const limit = app.createRateLimit({ max, timeWindow: '1 minute', keyGenerator: req => addressKey(req.ip), allowList: skip });
  return async (req, reply) => {
    const result = await limit(req);
    if (result.isAllowed || !result.isExceeded) return;
    recordAddressRejection(app, req);
    return reply.code(429).header('retry-after', String(result.ttlInSeconds)).send({ error: 'rate_limited', message: 'Rate limit exceeded' });
  };
}

/** One address cap shared by every route registered under `name` on this server (for example v1 and legacy sign-in). */
export function sharedAddressLimit(app: FastifyInstance, name: string, max: number): Limiter {
  const byName = shared.get(app.server) ?? new Map<string, Limiter>();
  shared.set(app.server, byName);
  const existing = byName.get(name);
  if (existing) return existing;
  const created = addressLimit(app, max);
  byName.set(name, created);
  return created;
}

declare module 'fastify' { interface FastifyContextConfig { rateLimitKeyKind?: 'session' | 'address' } }
