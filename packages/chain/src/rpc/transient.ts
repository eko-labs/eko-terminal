import { providerErrorClass } from './outage.js';
import { RpcReplyError } from './reply.js';
/** Classify transport failures before sanitizing them; never retain provider bodies or URLs. */
export function isTransientRpcError(error: unknown): boolean {
  if (providerErrorClass(error)) return true;
  const seen = new Set<unknown>();
  let transient = false;
  for (let depth = 0; error && depth < 16 && !seen.has(error); depth++) {
    seen.add(error);
    // A checked reply carries its own verdict (malformed, incomplete, timed out or an HTTP status).
    if (error instanceof RpcReplyError) return error.transient;
    const e = error as { status?: unknown; statusCode?: unknown; code?: unknown; name?: unknown; message?: unknown; shortMessage?: unknown; details?: unknown; cause?: unknown };
    // An oversized reply repeats on every retry; the caller narrows its range instead (viem wraps it as "HTTP request failed").
    if (e.name === 'ResponseBodyTooLargeError') return false;
    const status = Number(e.status ?? e.statusCode);
    if (status >= 400 && status < 500 && status !== 408 && status !== 429) return false;
    if (status >= 500 && status < 600 || status === 408 || status === 429) transient = true;
    const text = [e.code,e.name,e.message,e.shortMessage,e.details,typeof error === 'string' ? error : ''].join(' ');
    if (/GOAWAY|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR_|fetch failed|HTTP request failed|network error|connection (?:reset|closed|terminated)|socket hang up|timed? ?out|timeout|rate limit|too many requests|non[- ]JSON|invalid JSON|not valid JSON|unexpected (?:token|end)|JSON.*(?:parse|position)|SyntaxError|HTTP[^\d]*5\d\d|status(?: code)?:? 5\d\d/i.test(text)) transient = true;
    error = e.cause;
  }
  return transient;
}
