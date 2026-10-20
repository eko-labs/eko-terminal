import type { FastifyInstance, FastifyRequest } from 'fastify';
import { metrics } from './metrics.js';
import { logger } from './logger.js';
export type LimitKind = 'global' | 'route' | 'address';
export type KeyKind = 'session' | 'address';
export const RATE_LIMIT_COUNTER = 'http.rate_limit_rejections';
export class RateLimitObservations {
  private pending = new Map<string, { limiter: LimitKind; route: string; keyKind: KeyKind; count: number }>();
  private lastLog = -Infinity;
  constructor(private log: (fields: object, message: string) => void = (fields, message) => logger.info(fields, message), private now = Date.now) {}
  reject(limiter: LimitKind, route: string, keyKind: KeyKind) {
    const labels = { limiter, route, keyKind };
    metrics.increment(RATE_LIMIT_COUNTER, labels);
    const id = JSON.stringify(labels), row = this.pending.get(id);
    if (row) row.count++; else this.pending.set(id, { ...labels, count: 1 });
  }
  flush() {
    if (!this.pending.size || this.now() - this.lastLog < 60000) return;
    this.log({ counters: [...this.pending.values()] }, 'HTTP rate limit rejections');
    this.pending.clear(); this.lastLog = this.now();
  }
}
const observers = new WeakMap<object, RateLimitObservations>();
export function installRateLimitObservations(app: FastifyInstance, observer = new RateLimitObservations()) { observers.set(app.server, observer);
  const interval = setInterval(() => observer.flush(), 60000); interval.unref();
  app.addHook('onClose', async () => { clearInterval(interval); observers.delete(app.server); });
  return observer;
}
export function recordAddressRejection(app: FastifyInstance, req: FastifyRequest) {
  observers.get(app.server)?.reject('address', req.routeOptions.url ?? 'unmatched', 'address');
}

export function pluginRejectionObserver(observer: RateLimitObservations, hasSession: (req: FastifyRequest) => boolean) {
  return (req: FastifyRequest) => observer.reject(req.routeOptions.config.rateLimit ? 'route' : 'global', req.routeOptions.url ?? 'unmatched',
    req.routeOptions.config.rateLimitKeyKind === 'address' ? 'address' : hasSession(req) ? 'session' : 'address');
}

export function recordRouteRejection(app: FastifyInstance, req: FastifyRequest, keyKind: KeyKind) {
  observers.get(app.server)?.reject('route', req.routeOptions.url ?? 'unmatched', keyKind);
}
