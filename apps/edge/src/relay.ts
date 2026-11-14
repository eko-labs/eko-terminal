import type { Rpc } from './tracker.js';
import { limiter } from './accounts.js';

/**
 * The browser wallet layer's RPC relay runs on its own plain client to the public RPC: it never shares the metered
 * lanes, budget or queue the tracker, safety checks and trade simulation use, so flooding it cannot stall them.
 * It is bounded three ways: per client (req.ip), overall per minute, and by how many requests are in flight.
 */
export interface RelayLimits { perClientPerMin?: number; totalPerMin?: number; inFlight?: number; timeoutMs?: number }

export class RelayBusy extends Error { constructor(readonly reason: 'client' | 'total' | 'in_flight') { super(`relay busy: ${reason}`); } }

export function relayClient(url: string, fetchFn: typeof fetch = fetch, limits: RelayLimits = {}) {
  const perClient = limiter(limits.perClientPerMin ?? 120, 60_000), total = limiter(limits.totalPerMin ?? 600, 60_000);
  const maxInFlight = limits.inFlight ?? 16, timeoutMs = limits.timeoutMs ?? 8_000;
  let inFlight = 0, id = 0;
  return {
    get inFlight() { return inFlight; },
    async request(client: string, input: { method: string; params: unknown[] }): Promise<unknown> {
      if (!perClient(client)) throw new RelayBusy('client');
      if (inFlight >= maxInFlight) throw new RelayBusy('in_flight');
      if (!total('all')) throw new RelayBusy('total');
      inFlight++;
      try {
        const res = await fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(timeoutMs),
          body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: input.method, params: input.params }) });
        const body = await res.json() as { result?: unknown; error?: { message?: string } };
        if (!res.ok || body.error) throw new Error(body.error?.message ?? `HTTP ${res.status}`);
        return body.result;
      } finally { inFlight--; }
    },
  };
}
export type RelayClient = ReturnType<typeof relayClient>;

/** Adapt a plain Rpc (tests) to the relay's shape, with the same bounds. */
export function relayFromRpc(rpc: Rpc, limits: RelayLimits = {}): RelayClient {
  return relayClient('rpc://local', (async (_url: unknown, init?: RequestInit) => {
    const { method, params } = JSON.parse(String(init?.body));
    try { return new Response(JSON.stringify({ result: await rpc.request({ method, params }) })); }
    catch (e) { return new Response(JSON.stringify({ error: { message: (e as Error).message } })); }
  }) as typeof fetch, limits);
}
