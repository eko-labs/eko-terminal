import { randomUUID } from 'node:crypto';
import { logger } from './logger.js';

/**
 * Error reporting. Always logs; additionally forwards to Sentry's envelope endpoint
 * when SENTRY_DSN is configured (no SDK dependency required).
 */
let dsn: { url: string; key: string } | null = null;
let environment = 'development';

export function initErrorReporting(sentryDsn: string | undefined, env: string) {
  environment = env;
  dsn = null;
  if (!sentryDsn) return;
  try {
    const u = new URL(sentryDsn);
    const projectId = u.pathname.replace(/^\//, '');
    dsn = { url: `${u.protocol}//${u.host}/api/${projectId}/envelope/`, key: u.username };
  } catch {
    logger.warn('SENTRY_DSN is not a valid URL; remote error reporting disabled');
  }
}

export async function reportError(err: unknown, context: Record<string, unknown> = {}): Promise<void> {
  await deliverError(err, context);
}

export async function deliverError(err: unknown, context: Record<string, unknown> = {}): Promise<boolean> {
  const e = err instanceof Error ? err : new Error(String(err));
  logger.error({ err: e, ...context }, e.message);
  if (!dsn) return false;
  const eventId = randomUUID().replace(/-/g, '');
  const event = {
    event_id: eventId,
    timestamp: Date.now() / 1000,
    platform: 'node',
    level: 'error',
    environment,
    exception: { values: [{ type: e.name, value: e.message, stacktrace: { frames: parseStack(e.stack) } }] },
    extra: context,
  };
  const body = `${JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString() })}\n${JSON.stringify({ type: 'event' })}\n${JSON.stringify(event)}`;
  return fetch(dsn.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-sentry-envelope',
      'x-sentry-auth': `Sentry sentry_version=7, sentry_key=${dsn.key}, sentry_client=eko/0.1`,
    },
    body,
    signal: AbortSignal.timeout(5000),
  }).then(response => response.ok).catch(() => false);
}

function parseStack(stack?: string) {
  if (!stack) return [];
  return stack
    .split('\n')
    .slice(1, 30)
    .map((l) => ({ function: l.trim() }))
    .reverse();
}
