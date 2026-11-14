import type { FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import type { Edge } from './service.js';
import { feedItem } from './views.js';
import { readCookie, sameOrigin, type AccountStore } from './accounts.js';
import type { FastifyRequest } from 'fastify';

/** Channels that carry one account's own events: only a signed-in socket may join, and only its events reach it. */
const PRIVATE = new Set(['orders', 'approvals', 'agents', 'alerts']);

/**
 * The web app's realtime socket, minimal: hello on connect, pong to ping, ack to every subscription, and new feed
 * items (launches, graduations) pushed to `feed` subscribers, and a signed-in wallet's own orders, approvals and agent
 * events pushed to it alone. Other channels are acknowledged and stay quiet: their pages refresh over REST. Nothing is
 * accepted from the client but sub/unsub/ping.
 */
export async function registerRealtime(app: FastifyInstance, edge: Edge, opts: { maxClients?: number; maxPerAddress?: number; idleMs?: number; accounts?: AccountStore } = {}) {
  await app.register(fastifyWebsocket, { options: { maxPayload: 4096 } });
  const clients = new Map<WebSocket, Set<string>>();
  const owner = new Map<WebSocket, string>();
  // Slots are shared, so no one address may hold many, a socket that stops talking is closed (the web app pings every
  // 10 s and reconnects with its subscriptions), and another site's page cannot open a socket with this site's cookie.
  const perAddress = new Map<string, number>(), lastHeard = new Map<WebSocket, number>();
  const idleMs = opts.idleMs ?? 120_000;
  const sweep = setInterval(() => { const cutoff = Date.now() - idleMs; for (const [ws, t] of lastHeard) if (t < cutoff) ws.close(1001, 'idle'); }, Math.min(30_000, idleMs / 2));
  sweep.unref?.();
  app.addHook('onClose', async () => clearInterval(sweep));
  let seq = 0;
  const send = (ws: WebSocket, msg: unknown) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); };

  // The web app connects to `${API_BASE}/ws` (/v1/ws); /ws is kept for other clients.
  const handler = (socket: WebSocket, req: FastifyRequest) => {
    if (!sameOrigin(req)) { socket.close(1008, 'origin'); return; }
    if (clients.size >= (opts.maxClients ?? 2000)) { socket.close(1013, 'busy'); return; }
    let ip = 'unknown'; try { ip = req.ip || ip; } catch { /* no socket address (in-process tests) */ }
    const held = perAddress.get(ip) ?? 0;
    if (held >= (opts.maxPerAddress ?? 20)) { socket.close(1013, 'too many sockets from this address'); return; }
    perAddress.set(ip, held + 1); lastHeard.set(socket, Date.now());
    clients.set(socket, new Set());
    const account = opts.accounts?.bySession(readCookie(req)) ?? null;
    if (account) owner.set(socket, account.id);
    send(socket, { t: 'hello', serverTime: Date.now(), session: account ? 'user' : 'anon', delayedSec: 0 });
    socket.on('message', (raw: Buffer) => {
      lastHeard.set(socket, Date.now());
      let msg: { op?: string; ch?: unknown };
      try { msg = JSON.parse(raw.toString('utf8')); } catch { return; }
      if (msg.op === 'ping') return send(socket, { t: 'pong', serverTime: Date.now() });
      if ((msg.op === 'sub' || msg.op === 'unsub') && Array.isArray(msg.ch)) {
        const subs = clients.get(socket)!;
        for (const ch of msg.ch.slice(0, 64)) {
          if (typeof ch !== 'string' || ch.length > 80 || (PRIVATE.has(ch) && !owner.has(socket))) continue;
          if (msg.op === 'sub') { subs.add(ch); send(socket, { t: 'ack', ch, seq }); } else subs.delete(ch);
        }
      }
    });
    socket.on('close', () => {
      clients.delete(socket); owner.delete(socket); lastHeard.delete(socket);
      const n = (perAddress.get(ip) ?? 1) - 1; if (n > 0) perAddress.set(ip, n); else perAddress.delete(ip);
    });
  };
  app.get('/v1/ws', { websocket: true }, handler);
  app.get('/ws', { websocket: true }, handler);

  /** Send one account's event to its own sockets on that channel. */
  function pushTo(accountId: string, ch: string, kind: string, data: unknown) {
    const msg = { t: 'ev', ch, seq: ++seq, ts: Date.now(), kind, data };
    for (const [ws, subs] of clients) if (owner.get(ws) === accountId && subs.has(ch)) send(ws, msg);
  }

  // Push feed items that landed since the last push (called after each tracker tick).
  let pushed = edge.tracker.feed.at(-1)?.id ?? null;
  const publish = function publish() {
    const feed = edge.tracker.feed;
    const from = pushed ? feed.findIndex(e => e.id === pushed) + 1 : 0;
    const fresh = feed.slice(from > 0 ? from : feed.length > 50 ? feed.length - 50 : 0);
    if (!fresh.length) return;
    pushed = fresh.at(-1)!.id;
    for (const e of fresh) {
      const msg = { t: 'ev', ch: 'feed', seq: ++seq, ts: e.ts * 1000, kind: 'item', data: feedItem(e, edge.assessment(e.coin), edge.tracker.coin(e.coin)) };
      for (const [ws, subs] of clients) if (subs.has('feed')) send(ws, msg);
    }
  };
  return { publish, pushTo };
}
