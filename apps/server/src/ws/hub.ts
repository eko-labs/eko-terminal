import { serializeRadarRow } from '../read/row-cache.js';
import type { WebSocket } from 'ws';
import type { Agent, Alert, ClientMessage, ServerMessage, Timeframe } from '@eko/shared';
import { TradeOrderSchema, type TradeOrder, GuardWsClientSchema, GuardWsEventSchema, type GuardWsEvent, type CoinCardV2, type Address, WsClientSchema, WsChannelSchema, type WsChannel, type WsChannelKind, type WsEventMap } from '@eko/shared';
import { TIMEFRAMES, getMarket } from '@eko/shared';
import { logger } from '../obs/logger.js';
import { WS_DEFAULT_LIMITS } from '../config.js';

interface Client {
  id: number;
  socket: WebSocket;
  accountId: string;
  markets: Set<string>;
  timeframes: Set<Timeframe>;
}

const MAX_BUFFER = 2 * 1024 * 1024;
const MAX_CHANNELS = 64;

interface ChannelClient {
  socket: WebSocket;
  channels: Set<string>;
  resync: Set<string>;
  version: 1 | 2;
  closed: boolean;
  windowStart: number;
  messages: number;
}
interface V1Client extends ChannelClient { accountId?: string; alertSeq: number }
interface V2Client extends ChannelClient {
  activeReads: number;
  pending: Map<string, SnapshotJob>;
}
interface SnapshotJob {
  client: V2Client;
  ch: string;
  card: (coin: Address) => Promise<CoinCardV2 | null>;
  active: boolean;
}

/** Fan-out uses bounded replies; V2 snapshot reads share a process-wide scheduler. */
export class Hub {
  private clients = new Map<number, Client>();
  private nextId = 1;
  private v1 = new Map<number, V1Client>();
  private v2 = new Map<number, V2Client>();
  private seqV2 = new Map<string, number>();
  private seq = new Map<string, number>();
  private snapshotQueue: SnapshotJob[] = [];
  private activeReads = 0;

  constructor(private readonly limits = WS_DEFAULT_LIMITS) {}

  private channelClient(socket: WebSocket, version: 1 | 2): ChannelClient {
    return { socket, version, channels: new Set(), resync: new Set(), closed: false, windowStart: Date.now(), messages: 0 };
  }

  /** Never enqueue even a control reply above MAX_BUFFER. Resume with one resync per held channel. */
  private reply(client: ChannelClient, message: object | string, ch?: string): boolean {
    if (client.closed || client.socket.readyState !== 1) return false;
    if (client.socket.bufferedAmount > MAX_BUFFER) {
      if (ch && client.channels.has(ch)) client.resync.add(ch);
      else for (const channel of client.channels) client.resync.add(channel);
      return false;
    }
    if (ch && client.resync.delete(ch)) {
      client.socket.send(JSON.stringify({ t: 'resync', ...(client.version === 2 ? { version: 2 } : {}), ch }));
      return false;
    }
    client.socket.send(typeof message === 'string' ? message : JSON.stringify(message));
    return true;
  }

  private rateError(client: ChannelClient, message: string) {
    this.reply(client, { t: 'err', ...(client.version === 2 ? { version: 2 } : {}), code: 'rate_limited', message });
  }

  /** Count all frames before parsing, including malformed input; emit at most one budget error per window. */
  private acceptMessage(client: ChannelClient, disconnect: () => void): boolean {
    if (client.closed || client.socket.readyState !== 1) return false;
    const now = Date.now();
    if (now - client.windowStart >= this.limits.windowMs) {
      client.windowStart = now;
      client.messages = 0;
    }
    client.messages++;
    if (client.messages > this.limits.hardMessagesPerWindow) {
      disconnect();
      client.socket.close(1008, 'Message budget exceeded');
      return false;
    }
    if (client.messages > this.limits.messagesPerWindow) {
      if (client.messages === this.limits.messagesPerWindow + 1) this.rateError(client, 'Message budget exceeded.');
      return false;
    }
    return true;
  }

  addV1(socket: WebSocket, accountId?: string, alertSeq?: () => Promise<number>) {
    const id = this.nextId++;
    const client: V1Client = { ...this.channelClient(socket, 1), accountId, alertSeq: 0 };
    const disconnect = () => {
      client.closed = true;
      client.channels.clear();
      client.resync.clear();
      this.v1.delete(id);
    };
    this.v1.set(id, client);
    this.reply(client, { t: 'hello', serverTime: Date.now(), session: accountId ? 'user' : 'anon', delayedSec: 0 });
    socket.on('message', async raw => {
      if (!this.acceptMessage(client, disconnect)) return;
      let input: unknown; try { input = JSON.parse(String(raw)); } catch { return; }
      const parsed = WsClientSchema.safeParse(input); if (!parsed.success) return;
      const msg = parsed.data;
      if (msg.op === 'ping') { this.reply(client, { t: 'pong', serverTime: Date.now() }); return; }
      for (const ch of msg.ch.slice(0, MAX_CHANNELS)) {
        const valid = WsChannelSchema.safeParse(ch);
        if (!valid.success || !(['agents', 'alerts', 'orders'].includes(valid.data) && accountId) && !/^(radar|pairs|feed|coin:0x[0-9a-f]{40}|flow:0x[0-9a-f]{40})$/.test(valid.data)) {
          this.reply(client, { t: 'err', code: 'not_found', message: 'Channel is not available', ch }); continue;
        }
        const channel = valid.data;
        if (msg.op === 'unsub') { client.channels.delete(channel); client.resync.delete(channel); continue; }
        if (client.channels.has(channel) || client.channels.size >= MAX_CHANNELS) continue;
        client.channels.add(channel);
        if (channel === 'alerts') {
          try {
            const seq = alertSeq ? await alertSeq() : this.seq.get(`alerts:${accountId}`) ?? 0;
            if (client.closed || !client.channels.has(channel) || socket.readyState !== 1) continue;
            this.reply(client, { t: 'ack', ch: channel, seq }, channel);
            client.alertSeq = Math.max(seq, client.alertSeq);
            this.seq.set(`alerts:${accountId}`, Math.max(seq, this.seq.get(`alerts:${accountId}`) ?? 0));
            // The persisted REST stream recovers missed messages across restarts/reconnects.
            if (seq > 0) this.reply(client, { t: 'resync', ch: channel }, channel);
          } catch {
            if (!client.closed && client.channels.has(channel)) this.reply(client, { t: 'err', ch: channel, code: 'internal_error', message: 'Alerts are unavailable.' }, channel);
          }
          continue;
        }
        this.reply(client, { t: 'ack', ch: channel, seq: this.seq.get(['agents', 'orders'].includes(channel) ? `${channel}:${accountId}` : channel) ?? 0 }, channel);
      }
    });
    socket.on('close', disconnect);
    socket.on('error', disconnect);
    return id;
  }

  addV2(socket: WebSocket, card: (coin: Address) => Promise<CoinCardV2 | null>) {
    const id = this.nextId++;
    const client: V2Client = { ...this.channelClient(socket, 2), activeReads: 0, pending: new Map() };
    const disconnect = () => {
      client.closed = true;
      client.channels.clear();
      client.resync.clear();
      client.pending.clear();
      this.snapshotQueue = this.snapshotQueue.filter(job => job.client !== client);
      this.v2.delete(id);
      // Running reads retain their global slot until settled; disconnect must not bypass the work cap.
      this.drainSnapshots();
    };
    this.v2.set(id, client);
    this.reply(client, { t: 'hello', version: 2, serverTime: Date.now(), mode: 'shadow' });
    socket.on('message', raw => {
      if (!this.acceptMessage(client, disconnect)) return;
      let input: unknown; try { input = JSON.parse(String(raw)); } catch { return; }
      const parsed = GuardWsClientSchema.safeParse(input); if (!parsed.success) return;
      const msg = parsed.data;
      if (msg.op === 'ping') { this.reply(client, { t: 'pong', version: 2, serverTime: Date.now() }); return; }
      for (const ch of msg.ch) {
        if (msg.op === 'unsub') {
          client.channels.delete(ch);
          client.resync.delete(ch);
          const job = client.pending.get(ch);
          if (job && !job.active) {
            client.pending.delete(ch);
            this.snapshotQueue = this.snapshotQueue.filter(queued => queued !== job);
          }
          continue;
        }
        if (client.channels.has(ch) || client.channels.size >= MAX_CHANNELS) continue;
        const pending = client.pending.has(ch);
        const canStart = client.activeReads < this.limits.snapshotsPerConnection && this.activeReads < this.limits.snapshotsGlobal;
        if (!pending && !canStart && this.snapshotQueue.length >= this.limits.snapshotQueue) {
          this.rateError(client, 'Snapshot capacity reached.');
          continue;
        }
        client.channels.add(ch);
        if (!this.reply(client, { t: 'ack', version: 2, ch, seq: this.seqV2.get(ch) ?? 0 }, ch)) continue;
        if (pending) continue;
        const job: SnapshotJob = { client, ch, card, active: false };
        client.pending.set(ch, job);
        this.snapshotQueue.push(job);
        this.drainSnapshots();
      }
      this.drainSnapshots();
    });
    socket.on('close', disconnect);
    socket.on('error', disconnect);
    return id;
  }

  private drainSnapshots() {
    while (this.activeReads < this.limits.snapshotsGlobal) {
      const index = this.snapshotQueue.findIndex(job => job.client.activeReads < this.limits.snapshotsPerConnection);
      if (index < 0) return;
      const job = this.snapshotQueue.splice(index, 1)[0]!;
      const { client, ch } = job;
      if (client.closed || !client.channels.has(ch) || client.socket.readyState !== 1 || client.socket.bufferedAmount > MAX_BUFFER) {
        if (!client.closed && client.channels.has(ch)) client.resync.add(ch);
        client.pending.delete(ch);
        continue;
      }
      job.active = true;
      client.activeReads++;
      this.activeReads++;
      void this.readSnapshot(job);
    }
  }

  private async readSnapshot(job: SnapshotJob) {
    const { client, ch, card } = job;
    try {
      const data = await card(ch.slice(5) as Address);
      if (!client.closed && client.channels.has(ch)) {
        this.reply(client, GuardWsEventSchema.parse({ t: 'ev', version: 2, ch, seq: this.seqV2.get(ch) ?? 0, ts: Date.now(), kind: 'card', data }), ch);
      }
    } catch {
      if (!client.closed && client.channels.has(ch)) this.reply(client, { t: 'err', version: 2, code: 'internal_error', message: 'Card is unavailable.' }, ch);
    } finally {
      if (client.pending.get(ch) === job) client.pending.delete(ch);
      client.activeReads--;
      this.activeReads--;
      this.drainSnapshots();
    }
  }

  hasV2Subscribers(coin: Address) { return [...this.v2.values()].some(c => c.channels.has(`coin:${coin}`)); }
  publishV2(coin: Address, kind: GuardWsEvent['kind'], data: CoinCardV2 | null | import('@eko/shared').GuardAssessmentV2) {
    const ch = `coin:${coin}`, seq = (this.seqV2.get(ch) ?? 0) + 1; this.seqV2.set(ch, seq);
    const payload = JSON.stringify(GuardWsEventSchema.parse({ t: 'ev', version: 2, ch, seq, ts: Date.now(), kind, data }));
    for (const client of this.v2.values()) if (client.channels.has(ch)) this.reply(client, payload, ch);
  }
  publish<K extends WsChannelKind, E extends keyof WsEventMap[K]>(ch: WsChannel<K>, kind: E, data: WsEventMap[K][E]) {
    // Private channel events must always pass through account-scoped publication.
    if (['agents', 'alerts', 'approvals', 'orders'].includes(ch)) return;
    const seq = (this.seq.get(ch) ?? 0) + 1; this.seq.set(ch, seq);
    const header={ t:'ev',ch,seq,ts:Date.now(),kind };
    const payload=ch==='radar' && kind==='row_upsert' ? JSON.stringify(header).slice(0,-1)+',\"data\":'+serializeRadarRow(data as object)+'}' : JSON.stringify({...header,data});
    for (const client of this.v1.values()) if (client.channels.has(ch)) this.reply(client, payload, ch);
  }
  publishAlert(accountId: string, seq: number, alert: Alert): number {
    const key = `alerts:${accountId}`;
    this.seq.set(key, Math.max(seq, this.seq.get(key) ?? 0));
    const payload = JSON.stringify({ t: 'ev', ch: 'alerts', seq, ts: Date.now(), kind: 'alert', data: alert });
    let sent = 0;
    for (const client of this.v1.values()) {
      if (client.closed || client.accountId !== accountId || !client.channels.has('alerts') || client.socket.readyState !== 1) continue;
      if (seq <= client.alertSeq) continue;
      const gap = seq > client.alertSeq + 1;
      client.alertSeq = seq;
      if (gap && !client.resync.has('alerts')) this.reply(client, { t: 'resync', ch: 'alerts' }, 'alerts');
      if (this.reply(client, payload, 'alerts')) sent++;
    }
    return sent;
  }
  alertSubscriptions() {
    const accounts = new Map<string, number>();
    for (const client of this.v1.values()) if (client.accountId && client.channels.has('alerts')) {
      // Polling also delivers deferred recovery after congestion, even without a new source.
      if (client.resync.has('alerts') && client.socket.bufferedAmount <= MAX_BUFFER) {
        this.reply(client, { t: 'resync', ch: 'alerts' }, 'alerts');
      }
      accounts.set(client.accountId, Math.min(client.alertSeq, accounts.get(client.accountId) ?? client.alertSeq));
    }
    return [...accounts].map(([accountId, seq]) => ({ accountId, seq }));
  }
  publishOrder(accountId: string, order: TradeOrder) {
    const key = `orders:${accountId}`, seq = (this.seq.get(key) ?? 0) + 1;
    this.seq.set(key, seq);
    const payload = JSON.stringify({ t: 'ev', ch: 'orders', seq, ts: Date.now(), kind: 'order', data: TradeOrderSchema.parse(order) });
    for (const client of this.v1.values()) {
      if (client.accountId === accountId && client.channels.has('orders')) this.reply(client, payload, 'orders');
    }
  }
  publishAgent(accountId: string, agent: Agent) {
    const key = `agents:${accountId}`, seq = (this.seq.get(key) ?? 0) + 1;
    this.seq.set(key, seq);
    const payload = JSON.stringify({ t: 'ev', ch: 'agents', seq, ts: Date.now(), kind: 'agent', data: agent });
    for (const client of this.v1.values()) {
      if (client.accountId === accountId && client.channels.has('agents')) this.reply(client, payload, 'agents');
    }
  }
  onSubscriptionsChanged: (() => void) | null = null;

  add(socket: WebSocket, accountId: string, hello: ServerMessage) {
    const c: Client = { id: this.nextId++, socket, accountId, markets: new Set(), timeframes: new Set() };
    this.clients.set(c.id, c);
    this.send(c, hello);
    socket.on('message', (raw) => this.onMessage(c, String(raw)));
    socket.on('close', () => {
      this.clients.delete(c.id);
      this.onSubscriptionsChanged?.();
    });
    socket.on('error', (err) => logger.debug({ err }, 'ws client error'));
    return c.id;
  }

  private onMessage(c: Client, raw: string) {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === 'ping') {
      this.send(c, { type: 'pong', t: msg.t, serverTime: Date.now() });
    } else if (msg.type === 'subscribe') {
      const markets = (Array.isArray(msg.markets) ? msg.markets : []).filter((m) => getMarket(m)).slice(0, 12);
      const tfs = (Array.isArray(msg.timeframes) ? msg.timeframes : []).filter((t): t is Timeframe => (TIMEFRAMES as readonly string[]).includes(t)).slice(0, 6);
      c.markets = new Set(markets);
      c.timeframes = new Set(tfs);
      this.onSubscriptionsChanged?.();
    }
  }

  private send(c: Client, msg: ServerMessage, droppable = false) {
    if (c.socket.readyState !== 1) return;
    if (droppable && c.socket.bufferedAmount > MAX_BUFFER) return;
    c.socket.send(JSON.stringify(msg));
  }

  broadcast(msg: ServerMessage, droppable = false) {
    const payload = JSON.stringify(msg);
    for (const c of this.clients.values()) {
      if (c.socket.readyState !== 1) continue;
      if (droppable && c.socket.bufferedAmount > MAX_BUFFER) continue;
      c.socket.send(payload);
    }
  }

  broadcastCandle(msg: Extract<ServerMessage, { type: 'candle' }>) {
    const payload = JSON.stringify(msg);
    for (const c of this.clients.values()) {
      if (!c.markets.has(msg.market) || !c.timeframes.has(msg.timeframe)) continue;
      if (c.socket.readyState !== 1 || (!msg.closed && c.socket.bufferedAmount > MAX_BUFFER)) continue;
      c.socket.send(payload);
    }
  }

  /** Order books go only to clients watching that market. */
  broadcastBook(msg: Extract<ServerMessage, { type: 'book' }>) {
    const payload = JSON.stringify(msg);
    for (const c of this.clients.values()) {
      if (!c.markets.has(msg.book.market) || c.socket.readyState !== 1 || c.socket.bufferedAmount > MAX_BUFFER) continue;
      c.socket.send(payload);
    }
  }

  /** Accounts with a client watching this market and timeframe. */
  accountsWatching(market: string, tf: Timeframe): string[] {
    const out = new Set<string>();
    for (const c of this.clients.values()) if (c.markets.has(market) && c.timeframes.has(tf)) out.add(c.accountId);
    return [...out];
  }

  /** Markets at least one client is watching. */
  watchedMarkets(): Set<string> {
    const s = new Set<string>();
    for (const c of this.clients.values()) for (const m of c.markets) s.add(m);
    return s;
  }

  toAccount(accountId: string, msg: ServerMessage) {
    for (const c of this.clients.values()) if (c.accountId === accountId) this.send(c, msg);
  }

  /** "market|tf" pairs at least one client is watching. */
  subscriptions(): Set<string> {
    const s = new Set<string>();
    for (const c of this.clients.values()) for (const m of c.markets) for (const tf of c.timeframes) s.add(`${m}|${tf}`);
    return s;
  }

  get size() {
    return this.clients.size;
  }

  closeAll() {
    for (const c of this.clients.values()) c.socket.close(1001, 'server shutdown');
    this.clients.clear();
    for (const c of this.v1.values()) { c.closed = true; c.socket.close(1001, 'server shutdown'); }
    this.v1.clear();
    this.snapshotQueue = [];
    for (const c of this.v2.values()) { c.closed = true; c.pending.clear(); c.socket.close(1001, 'server shutdown'); }
    this.v2.clear();
  }
}
