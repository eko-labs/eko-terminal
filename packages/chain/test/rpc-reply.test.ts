import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPublicClient, http } from 'viem';
import { robinhood } from 'viem/chains';
import { checkReply, replyGuardFetch, RpcReplyError, type FetchFn } from '../src/rpc/reply.js';
import { isTransientRpcError } from '../src/rpc/transient.js';
import { RpcMeter, isTransientRpcUnavailable, RpcGuardError } from '../src/rpc/metered.js';
import { createMeteredClients } from '../src/rpc/clients.js';
import type { UsageStore } from '../src/rpc/usage.js';
import type { RpcRequest } from '../src/rpc/routes.js';

type Body = { id: number; method: string }[];
const paidUrl = 'https://paid.rpc.invalid/', publicUrl = 'https://public.rpc.invalid/';
const json = (body: unknown, status = 200, type = 'application/json') => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': type } });
const ok = (requests: Body) => json(requests.map(r => ({ jsonrpc: '2.0', id: r.id, result: '0x10' })));
const batchError = (code: number, message: string) => ({ jsonrpc: '2.0', id: null, error: { code, message } });
// Provider replies seen in the field that viem's batch transport cannot pair with its requests.
const badReplies: [string, (requests: Body) => Response, boolean][] = [
  ['a single JSON-RPC error object for the whole batch (HTTP 200)', () => json(batchError(-32005, 'rate limit hit')), true],
  ['an HTTP 429 with a JSON-RPC error body', () => json(batchError(-32005, 'too many requests'), 429), true],
  ['an HTTP 503 with a JSON-RPC error body', () => json(batchError(-32603, 'upstream unavailable'), 503), true],
  ['an empty body (HTTP 200)', () => new Response('', { status: 200 }), true],
  ['a batch reply missing an entry', requests => json([{ jsonrpc: '2.0', id: requests[0].id, result: '0x1' }]), true],
];
const htmlReplies: [string, () => Response][] = [
  ['an HTML page (HTTP 200)', () => json('<html><body>maintenance</body></html>', 200, 'text/html')],
  ['an HTML 502 page', () => json('<html><body>bad gateway</body></html>', 502, 'text/html')],
];
/** Raw viem client over a fake provider; three concurrent calls share one batch. */
function viemClient(reply: (requests: Body) => Response, guarded: boolean, seen: Body[] = []) {
  const provider: FetchFn = async (_url, init) => { const body = JSON.parse(String(init!.body)) as Body; seen.push(body); return reply(body); };
  const fetchFn = guarded ? replyGuardFetch(provider) : provider;
  return createPublicClient({ chain: robinhood, transport: http(paidUrl, { retryCount: 0, batch: { batchSize: 100, wait: 1 }, fetchFn }) });
}
const calls = (client: ReturnType<typeof viemClient>) => Promise.allSettled([1, 2, 3].map(() => client.request({ method: 'eth_blockNumber' })));
afterEach(() => { vi.useRealTimers(); });

describe('incident reproduction: viem batch replies', () => {
  it.each(badReplies.map(([name, reply]) => [name, reply] as const))('unguarded, %s becomes the unclassified TypeError', async (_name, reply) => {
    const results = await calls(viemClient(reply, false));
    const failures = results.flatMap(r => r.status === 'rejected' ? [r.reason] : []);
    expect(failures.length).toBeGreaterThan(0);
    // The exact production text: viem wraps the TypeError as an unknown RPC error with no status.
    expect(failures.some(e => String(e.details ?? e.message).includes("Cannot read properties of undefined (reading 'error')"))).toBe(true);
    expect(failures.some(e => !isTransientRpcError(e))).toBe(true);
  });
  it('unguarded, a short batch reply hands one request another request\'s result; guarded, none is paired', async () => {
    const short = (requests: Body) => json(requests.slice(1).map(r => ({ jsonrpc: '2.0', id: r.id, result: `0x${r.id.toString(16)}` })));
    const seen: Body[] = [];
    const results = await calls(viemClient(short, false, seen));
    expect(seen).toHaveLength(1);
    expect(results[0]).toEqual({ status: 'fulfilled', value: `0x${seen[0][1].id.toString(16)}` });
    const guarded = await calls(viemClient(short, true));
    expect(guarded.every(r => r.status === 'rejected' && isTransientRpcError(r.reason))).toBe(true);
  });
  it.each(badReplies)('guarded, %s is a classified RPC reply error (transient: %s)', async (_name, reply, transient) => {
    const results = await calls(viemClient(reply, true));
    for (const result of results) {
      expect(result.status).toBe('rejected');
      const error = (result as PromiseRejectedResult).reason;
      expect(String(error.details ?? error.message)).not.toContain('Cannot read properties');
      expect(isTransientRpcError(error)).toBe(transient);
      let cause = error; while (cause && !(cause instanceof RpcReplyError)) cause = cause.cause;
      expect(cause).toBeInstanceOf(RpcReplyError);
    }
  });
  it.each(htmlReplies)('guarded, %s is transient and never echoes the page', async (_name, reply) => {
    for (const result of await calls(viemClient(reply, true))) {
      const error = (result as PromiseRejectedResult).reason;
      expect(isTransientRpcError(error)).toBe(true);
      expect(String(error.details)).not.toContain('<html');
    }
  });
  it('guarded, complete replies pair by id whatever their order, and per-entry errors stay per entry', async () => {
    const client = viemClient(requests => json([...requests].reverse().map((r, i) => i === 0
      ? { jsonrpc: '2.0', id: r.id, error: { code: 3, message: 'execution reverted' } }
      : { jsonrpc: '2.0', id: r.id, result: `0x${r.id.toString(16)}` })), true);
    const results = await calls(client);
    expect(results[2]).toMatchObject({ status: 'rejected' });
    expect(String((results[2] as PromiseRejectedResult).reason.details)).toContain('execution reverted');
    const values = results.slice(0, 2).map(r => (r as PromiseFulfilledResult<string>).value);
    expect(new Set(values).size).toBe(2);
    expect(Number(values[1]) - Number(values[0])).toBe(1);
  });
  it('treats permanent HTTP statuses as permanent and keeps the provider reason without its body', () => {
    const request = JSON.stringify([{ jsonrpc: '2.0', id: 7, method: 'eth_blockNumber' }]);
    for (const [status, transient] of [[401, false], [403, false], [400, false], [408, true], [429, true], [500, true]] as const) {
      let caught: unknown;
      try { checkReply(request, status, JSON.stringify(batchError(-32000, 'nope'))); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(RpcReplyError);
      expect(caught).toMatchObject({ transient, status });
      expect(isTransientRpcError(caught)).toBe(transient);
    }
    const kept = checkReply(request, 400, JSON.stringify([{ jsonrpc: '2.0', id: 7, error: { code: -32602, message: 'invalid params' } }]));
    expect(kept.status).toBe(200);
  });
  it('treats an HTML 403 page (edge or bot protection) as transient, but not an HTML 401 or a JSON 403', () => {
    const request = JSON.stringify([{ jsonrpc: '2.0', id: 7, method: 'eth_blockNumber' }]);
    for (const [status, body, transient] of [[403, '<html>Forbidden</html>', true], [401, '<html>Unauthorized</html>', false],
      [403, JSON.stringify(batchError(-32000, 'forbidden')), false]] as const) {
      let caught: unknown;
      try { checkReply(request, status, body); } catch (error) { caught = error; }
      expect(caught).toMatchObject({ transient, status });
      expect(isTransientRpcError(caught)).toBe(transient);
    }
  });
});

function meterHarness(replies: Record<'paid' | 'public', (requests: Body, signal?: AbortSignal | null) => Response | Promise<Response>>, transientRetrySec = 300, env: Record<string, string> = {}) {
  let now = Date.UTC(2026, 9, 6, 8);
  const lines: { event: string; [k: string]: unknown }[] = [], sent: { provider: string; method: string }[] = [];
  const store: UsageStore = { reserve: async (_day, _provider, _method, _units, _limit) => ({ allowed: true, total: 0 }), today: async () => [] };
  const fetchFn: FetchFn = async (url, init) => {
    const provider = String(url).startsWith(paidUrl) ? 'paid' : 'public';
    const body = JSON.parse(String(init!.body)) as Body;
    for (const r of body) sent.push({ provider, method: r.method });
    return replies[provider](body, init?.signal);
  };
  const meter = new RpcMeter({ RPC_HTTP_URL: paidUrl, RPC_PUBLIC_HTTP_URL: publicUrl, ...env }, {
    store, transientRetrySec, fetchFn, now: () => now, sleep: async ms => { now += ms; }, random: () => .5,
    log: (event, fields) => lines.push({ event, ...fields }),
  });
  return { meter, lines, sent, clients: createMeteredClients(meter.env, { meter }), advance: (ms: number) => { now += ms; } };
}
describe('metered transport over bad replies', () => {
  it('retries a malformed paid reply with backoff instead of halting an archive-only read', async () => {
    let bad = 2;
    const h = meterHarness({ paid: requests => bad-- > 0 ? json(batchError(-32005, 'capacity exceeded')) : ok(requests), public: ok });
    const value = await h.clients.archive.request({ method: 'eth_call', params: [{ to: '0x0000000000000000000000000000000000000001', data: '0x' }, '0x10'] });
    expect(value).toBe('0x10');
    expect(h.sent.every(s => s.provider === 'paid')).toBe(true);
    expect(h.lines.filter(l => l.event === 'rpc_transient_retry').map(l => l.backoff_ms)).toEqual([375, 750]);
    await h.meter.close();
  });
  it('falls back to public for a head read when the paid batch reply is short, without spending public twice', async () => {
    const h = meterHarness({ paid: () => json([]), public: ok });
    expect(await h.clients.paid.request({ method: 'eth_getBlockByNumber', params: ['0x10', false] })).toBe('0x10');
    expect(h.sent.map(s => s.provider)).toEqual(['paid', 'public']);
    await h.meter.close();
  });
  it('keeps a head read alive when paid hiccups and the public provider answers an HTML 403 (2026-10-07 production)', async () => {
    let bad = 1;
    const forbidden = () => new Response('<html><body>Forbidden</body></html>', { status: 403, headers: { 'Content-Type': 'text/html' } });
    const h = meterHarness({ paid: requests => bad-- > 0 ? json([]) : ok(requests), public: forbidden });
    expect(await h.clients.paid.request({ method: 'eth_getBlockByNumber', params: ['0x10', false] })).toBe('0x10');
    expect(h.sent.map(s => s.provider)).toEqual(['paid', 'public', 'paid']);
    await h.meter.close();
  });
  it('gives up after the retry window with a transient rpc_unavailable the head loop can retry', async () => {
    const h = meterHarness({ paid: () => new Response('', { status: 200 }), public: () => json(batchError(429, 'rate limit')) }, 30);
    const error = await h.clients.head.request({ method: 'eth_getLogs', params: [{ fromBlock: '0x1', toBlock: '0x2' }] }).catch((e: unknown) => e);
    expect(isTransientRpcUnavailable(error)).toBe(true);
    expect(String((error as Error).message)).not.toContain('Cannot read properties');
    // Permanent faults stay permanent.
    const denied = meterHarness({ paid: () => json(batchError(-32000, 'unauthorized'), 401), public: () => json(batchError(-32000, 'unauthorized'), 401) });
    const permanent = await denied.clients.head.request({ method: 'eth_getLogs', params: [{ fromBlock: '0x1', toBlock: '0x2' }] }).catch((e: unknown) => e);
    expect(permanent).toBeDefined();
    expect(isTransientRpcUnavailable(permanent)).toBe(false);
    await h.meter.close(); await denied.meter.close();
  });
  it('times out a reply whose body never finishes, then uses the other provider', async () => {
    const stalled = (_requests: Body, signal?: AbortSignal | null) => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('[{"jsonrpc":"2.0",'));
      signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
    } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const h = meterHarness({ paid: stalled, public: ok }, 300, { RPC_TIMEOUT_MS: '50' });
    expect(await h.clients.paid.request({ method: 'eth_getBlockByNumber', params: ['0x10', false] })).toBe('0x10');
    expect(h.sent.map(s => s.provider)).toEqual(['paid', 'public']);
    await h.meter.close();
  });
});
describe('request deadline and paid fallback', () => {
  function sends() {
    return { paid: vi.fn(async (_r: RpcRequest): Promise<unknown> => 'paid'), public: vi.fn(async (_r: RpcRequest): Promise<unknown> => 'public') };
  }
  function meter(env: Record<string, string> = {}, options: { now?: () => number } = {}) {
    let now = Date.UTC(2026, 9, 6, 8);
    const lines: { event: string; [k: string]: unknown }[] = [];
    const sleeps: number[] = [];
    const store: UsageStore = { reserve: async () => ({ allowed: true, total: 0 }), today: async () => [] };
    const m = new RpcMeter({ RPC_HTTP_URL: paidUrl, ...env }, { store, now: options.now ?? (() => now), sleep: options.now ? undefined : async ms => { sleeps.push(ms); now += ms; }, random: () => .5, log: (event, fields) => lines.push({ event, ...fields }) });
    return { meter: m, lines, sleeps, advance: (ms: number) => { now += ms; } };
  }
  it('bounds a send that never settles, even without a transport timeout', async () => {
    vi.useFakeTimers();
    const h = meter({ RPC_TIMEOUT_MS: '1000' }, { now: () => Date.now() });
    const send = sends(); send.paid.mockImplementation(() => new Promise(() => {}));
    const pending = h.meter.request({ method: 'eth_call', params: [{}, '0x10'] }, send, 'archive').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(6_000);
    const error = await pending;
    expect(error).toBeInstanceOf(RpcGuardError);
    expect(error).toMatchObject({ code: 'rpc_unavailable', transient: true });
    expect(String((error as Error).message)).toContain('timed out after 6000 ms');
    await h.meter.close();
  });
  it('bounds a hung usage-store admission so one query cannot freeze a provider lane', async () => {
    vi.useFakeTimers();
    const store: UsageStore = { reserve: () => new Promise(() => {}), today: async () => [] };
    const m = new RpcMeter({ RPC_HTTP_URL: paidUrl }, { store, storeTimeoutMs: 1000, now: () => Date.now(), log: () => {} });
    const pending = m.request({ method: 'eth_blockNumber' }, sends()).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toMatchObject({ code: 'rpc_unavailable', message: 'RPC usage persistence unavailable', transient: false });
  });
  it('sends public-capable reads to public first while paid keeps failing, keeps archive reads on paid, and probes paid after a cool-down', async () => {
    const h = meter(), send = sends();
    send.paid.mockRejectedValue(new RpcReplyError('batch_error', true, 'RPC reply rejected the whole batch'));
    for (let i = 0; i < 3; i++) expect(await h.meter.request({ method: 'eth_getBlockByNumber', params: ['0x1', false] }, send)).toBe('public');
    expect(send.paid).toHaveBeenCalledTimes(3);
    expect(h.lines.filter(l => l.event === 'rpc_paid_degraded')).toEqual([{ event: 'rpc_paid_degraded', failures: 3, public_first_ms: 60_000 }]);
    // Degraded: no paid attempt for public-capable reads; public admission keeps its own 200 ms spacing.
    const before = h.sleeps.length;
    await Promise.all([1, 2].map(() => h.meter.request({ method: 'eth_getBlockByNumber', params: ['0x1', false] }, send)));
    expect(send.paid).toHaveBeenCalledTimes(3);
    expect(h.sleeps.slice(before).every(ms => ms <= 200)).toBe(true);
    // Pinned state has no public route; it still goes to paid.
    send.paid.mockResolvedValueOnce('paid');
    expect(await h.meter.request({ method: 'eth_call', params: [{}, '0x10'] }, send, 'archive')).toBe('paid');
    expect(h.lines.filter(l => l.event === 'rpc_paid_recovered')).toHaveLength(1);
    // A fresh run of failures degrades again; after the cool-down the next read probes paid.
    for (let i = 0; i < 3; i++) await h.meter.request({ method: 'eth_getBlockByNumber', params: ['0x1', false] }, send);
    h.advance(60_000);
    send.paid.mockResolvedValueOnce('paid');
    expect(await h.meter.request({ method: 'eth_getBlockByNumber', params: ['0x1', false] }, send)).toBe('paid');
    expect(h.lines.filter(l => l.event === 'rpc_paid_recovered')).toHaveLength(2);
    await h.meter.close();
  });
});
