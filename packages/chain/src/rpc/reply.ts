import { ResponseBodyTooLargeError } from 'viem';

/**
 * viem's batched HTTP transport assumes every reply is an array with one entry per request
 * (viem utils/promise/createBatchScheduler resolves `data[i]`, then clients/transports/http
 * destructures `const [{ error, result }]`). A single JSON-RPC error object for the whole batch
 * (rate limit, capacity), an HTTP 429/5xx with a JSON-RPC body, an empty body or a short array
 * left `data[i]` undefined, which surfaced as the unclassified, non-retryable
 * "Cannot read properties of undefined (reading 'error')". Entries are also matched by index
 * after sorting, so a missing entry shifted later results onto the wrong requests.
 */
export type RpcReplyFault = 'http_status' | 'not_json' | 'batch_error' | 'not_batch' | 'missing_entry' | 'timeout';
export class RpcReplyError extends Error {
  override readonly name = 'RpcReplyError';
  constructor(readonly fault: RpcReplyFault, readonly transient: boolean, message: string, readonly status?: number) { super(message); }
}
const transientStatus = (status: number) => status === 402 || status === 408 || status === 425 || status === 429 || status >= 500;
type Entry = { id?: unknown; result?: unknown; error?: unknown };
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
/** The provider's own short reason, never its body: HTML pages and echoed request text stay out of logs. */
function providerReason(data: unknown): string {
  const error = isObject(data) ? data.error : undefined;
  const message = isObject(error) && typeof error.message === 'string' ? error.message : typeof error === 'string' ? error : '';
  const code = isObject(error) && (typeof error.code === 'number' || typeof error.code === 'string') ? ` (code ${error.code})` : '';
  return message ? `: ${message.replace(/\s+/g, ' ').slice(0, 160)}${code}` : '';
}
function requestIds(body: unknown): { batch: boolean; ids: unknown[] } | undefined {
  if (typeof body !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    if (Array.isArray(parsed)) return { batch: true, ids: parsed.map(item => isObject(item) ? item.id : undefined) };
    return isObject(parsed) ? { batch: false, ids: [parsed.id] } : undefined;
  } catch { return undefined; }
}
const validEntry = (entry: unknown): entry is Entry => isObject(entry) && ('result' in entry || isObject(entry.error));
/**
 * Check one buffered reply against the JSON-RPC request it answers. A usable reply is returned as
 * a JSON response holding exactly one entry per request id (per-entry errors such as reverts still
 * flow through viem's normal RpcRequestError mapping). Anything else throws RpcReplyError: HTTP
 * 408/425/429/5xx and malformed or incomplete 2xx replies are transient; other HTTP 4xx are not, except a 403 whose
 * body is not JSON: that is an edge or bot-protection page (seen from the public provider against hosted egress IPs on
 * 2026-10-06/07), not a JSON-RPC refusal, so the meter retries it on the other lane instead of halting the indexer.
 */
export function checkReply(requestBody: unknown, status: number, text: string): Response {
  const request = requestIds(requestBody);
  const ok = status >= 200 && status < 300;
  let data: unknown, parsed = false;
  if (text.trim()) { try { data = JSON.parse(text); parsed = true; } catch { /* classified below */ } }
  const fail = (fault: RpcReplyFault, message: string, transient = ok || transientStatus(status)): never => {
    throw new RpcReplyError(fault, transient, `RPC reply ${message}${ok ? '' : ` (HTTP ${status})`}`, ok ? undefined : status);
  };
  const reply = (body: string) => new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (!request) {
    // Not a JSON-RPC body this guard can match; keep viem's own handling, but never lose the status.
    if (!ok) fail('http_status', `failed${parsed ? providerReason(data) : ''}`);
    return new Response(text, { status, headers: { 'Content-Type': parsed ? 'application/json' : 'text/plain' } });
  }
  if (!parsed) fail('not_json', text.trim() ? 'was not JSON' : 'was empty', ok || transientStatus(status) || status === 403);
  if (!request.batch) {
    if (!ok) fail('http_status', `failed${providerReason(data)}`);
    if (!validEntry(data)) fail('not_batch', 'had no result or error');
    return reply(text);
  }
  if (!Array.isArray(data)) {
    if (isObject(data) && data.error !== undefined) fail('batch_error', `rejected the whole batch${providerReason(data)}`);
    fail('not_batch', 'to a batch was not an array');
  }
  const replies = data as unknown[];
  const byId = new Map<unknown, Entry>();
  for (const entry of replies) if (validEntry(entry) && entry.id != null && !byId.has(entry.id)) byId.set(entry.id, entry);
  const missing = request.ids.filter(id => !byId.has(id)).length;
  if (missing) {
    const batchError = replies.find(entry => isObject(entry) && entry.id == null && entry.error !== undefined);
    fail('missing_entry', `omitted ${missing} of ${request.ids.length} batch entries${providerReason(batchError)}`);
  }
  // viem pairs entries with requests by index after sorting by id: pass exactly one entry per id.
  if (replies.length === request.ids.length && ok) return reply(text);
  return reply(JSON.stringify(request.ids.map(id => byId.get(id))));
}
async function readBody(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('Content-Length'));
  if (declared > maxBytes) throw new ResponseBodyTooLargeError({ maxSize: maxBytes, size: declared });
  if (!response.body) return response.text();
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let text = '', size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel().catch(() => {}); throw new ResponseBodyTooLargeError({ maxSize: maxBytes, size }); }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally { reader.releaseLock(); }
}
export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
/**
 * A viem `fetchFn` that buffers the whole reply before returning, so viem's request timeout and
 * abort signal cover the body as well as the headers, then validates it with checkReply.
 */
export function replyGuardFetch(fetchFn: FetchFn = fetch, maxBytes = 10_485_760): FetchFn {
  return async (input, init) => {
    const response = await fetchFn(input, init);
    return checkReply(init?.body, response.status, await readBody(response, maxBytes));
  };
}
