import { WsChannelSchema, WsServerSchema, type WsChannel, type WsChannelKind, type WsEvent, type WsEventMap, type WsServer, type WsClient } from '@eko/shared';
import { API_BASE, MOCKS } from './api';
import { ChannelSocket, type WsState } from './ws';

export type Channel<K extends keyof WsEventMap> = WsChannel<K>;
export type ChannelEvent<K extends keyof WsEventMap> = WsEvent<K>;
type Resync = () => void | number | Promise<void | number>;
export interface ChannelTransport {
  state: WsState; connect(): void; close(): void; reconnect(): void; send(message: WsClient): void;
  on(listener: (message: WsServer) => void): () => void;
  onState(listener: (state: WsState) => void): () => void;
}
interface Listener { event?: (event: WsEvent) => void; batch?: (events: WsEvent[]) => void; resync?: Resync }
interface Subscription {
  listeners: Set<Listener>; active: boolean; touched: number; seq: number | null; lastEvent: number | null;
  grace?: ReturnType<typeof setTimeout>; buffer: Map<string, WsEvent>; syncing: boolean; needsSnapshot: boolean; generation: number;
}
const USER = new Set(['alerts', 'agents', 'approvals', 'orders']);
export const FRAME_FALLBACK_MS = 250;
const foreground = (ch: string) => ['feed', 'pairs', 'radar', 'coin', 'flow'].includes(ch.split(':')[0]);
const limit = (ch: string) => ch === 'feed' ? 500 : ch === 'pairs' ? 300 : ch.startsWith('flow:') ? 5000 : 500;
const eventKey = (event: WsEvent) => {
  const data = event.data as Record<string, unknown>;
  if (event.kind === 'marker') return `${event.kind}:${data.wallet}:${data.ts}:${data.side}`;
  return `${event.kind}:${data.column ?? ''}:${data.address ?? data.id ?? data.agentId ?? ''}`;
};

export class Realtime {
  private channels = new Map<string, Subscription>();
  private dispose: (() => void)[] = [];
  private stateListeners = new Set<(state: WsState) => void>();
  private controlListeners = new Set<(message: Exclude<WsServer, WsEvent>) => void>();
  private frame: number | null = null;
  private frameFallback?: ReturnType<typeof setTimeout>;
  private hiddenTimer?: ReturnType<typeof setTimeout>;
  private suspended = false;
  private signedIn = false;
  private everOpened = false;
  private touch = 0;
  state: WsState = 'closed';
  constructor(private transport: ChannelTransport,
    private schedule = (cb: FrameRequestCallback) => requestAnimationFrame(cb),
    private cancel = (id: number) => cancelAnimationFrame(id),
    /** Browsers pause animation frames for pages they are not painting; deltas must still drain. */
    private frameFallbackMs = FRAME_FALLBACK_MS) {
    this.dispose.push(transport.on((m) => this.receive(m)), transport.onState((state) => {
      this.state = state;
      if (state === 'open') {
        for (const [ch, sub] of this.channels) {
          sub.generation++; sub.syncing = false; sub.seq = null; sub.buffer.clear();
          if (sub.active) { this.send('sub', ch); if (this.everOpened) this.resync(ch, sub); }
        }
        this.everOpened = true;
      }
      this.stateListeners.forEach((l) => l(state));
    }));
    if (typeof document !== 'undefined') {
      const visibility = () => this.setHidden(document.visibilityState === 'hidden');
      document.addEventListener('visibilitychange', visibility);
      this.dispose.push(() => document.removeEventListener('visibilitychange', visibility));
      visibility();
    }
  }
  connect() { this.transport.connect(); }
  reconnect() { this.transport.reconnect(); }
  onState(l: (state: WsState) => void) { this.stateListeners.add(l); return () => { this.stateListeners.delete(l); }; }
  onControl(l: (message: Exclude<WsServer, WsEvent>) => void) { this.controlListeners.add(l); return () => { this.controlListeners.delete(l); }; }
  lastEventAt(ch: string) { return this.channels.get(ch)?.lastEvent ?? null; }
  setSignedIn(signedIn: boolean) { this.signedIn = signedIn; this.reconcile(true); }
  private send(op: 'sub' | 'unsub', ch: string) { if (this.state === 'open') this.transport.send({ op, ch: [ch] }); }
  subscribe<K extends WsChannelKind>(channel: Channel<K>, onEvent: (event: ChannelEvent<K>) => void, onResync?: Resync): () => void {
    return this.register(channel, { event: onEvent as (e: WsEvent) => void, resync: onResync });
  }
  /** Store consumers receive one batch per channel/frame and perform one state write. */
  subscribeBatch<K extends WsChannelKind>(channel: Channel<K>, onEvents: (events: ChannelEvent<K>[]) => void, onResync?: Resync): () => void {
    return this.register(channel, { batch: onEvents as (events: WsEvent[]) => void, resync: onResync });
  }
  private register(channel: WsChannel, listener: Listener): () => void {
    const ch = WsChannelSchema.parse(channel);
    let sub = this.channels.get(ch);
    if (!sub) {
      sub = { listeners: new Set(), active: false, touched: 0, seq: null, lastEvent: null, buffer: new Map(), syncing: false, needsSnapshot: false, generation: 0 };
      this.channels.set(ch, sub);
    }
    if (sub.grace) clearTimeout(sub.grace);
    sub.grace = undefined; sub.touched = ++this.touch;
    // Type erasure is confined to the listener registry; caller payloads stay correlated.
    sub.listeners.add(listener);
    this.reconcile();
    let removed = false;
    return () => {
      if (removed) return; removed = true;
      sub!.listeners.delete(listener);
      if (!sub!.listeners.size) sub!.grace = setTimeout(() => {
        if (sub!.active) this.send('unsub', ch);
        sub!.generation++; this.channels.delete(ch); this.reconcile();
      }, 2000);
    };
  }
  private reconcile(resync = false) {
    const candidates = [...this.channels].filter(([ch, s]) => (s.listeners.size || s.grace) && (!USER.has(ch) || this.signedIn) && !(this.suspended && foreground(ch)));
    const addressChannels = candidates.filter(([ch]) => /^(coin|flow):/.test(ch)).sort((a, b) => b[1].touched - a[1].touched).slice(0, 40);
    const active = new Set(candidates.filter(([ch]) => !/^(coin|flow):/.test(ch)).map(([ch]) => ch).concat(addressChannels.map(([ch]) => ch)));
    for (const [ch, sub] of this.channels) {
      const next = active.has(ch);
      if (next === sub.active) continue;
      sub.active = next; sub.buffer.clear(); sub.seq = null;
      this.send(next ? 'sub' : 'unsub', ch);
      if (next && resync) this.resync(ch, sub);
    }
  }
  setHidden(hidden: boolean) {
    if (this.hiddenTimer) clearTimeout(this.hiddenTimer);
    this.hiddenTimer = undefined;
    if (hidden) this.hiddenTimer = setTimeout(() => { this.suspended = true; this.reconcile(); }, 30_000);
    else if (this.suspended) { this.suspended = false; this.reconcile(true); }
  }
  private resync(ch: string, sub: Subscription) {
    if (sub.syncing) return;
    sub.syncing = true; sub.needsSnapshot = true; sub.buffer.clear();
    const generation = ++sub.generation;
    const snapshots = [...sub.listeners].filter((l) => l.resync);
    Promise.all(snapshots.map((l) => Promise.resolve().then(() => l.resync!()))).then((seqs) => {
      if (sub.generation !== generation || this.channels.get(ch) !== sub) return;
      const seq = seqs.filter((s): s is number => typeof s === 'number');
      if (seq.length) {
        const snapshotSeq = Math.max(...seq);
        sub.seq = Math.max(sub.seq ?? 0, snapshotSeq);
        for (const [key, event] of sub.buffer) if (event.seq <= snapshotSeq) sub.buffer.delete(key);
      }
      sub.syncing = false; sub.needsSnapshot = false; this.flushSoon();
    }).catch(() => {
      // A failed snapshot must never release possibly inconsistent deltas.
      if (sub.generation === generation) { sub.buffer.clear(); sub.syncing = false; sub.seq = null; }
    });
  }
  private receive(raw: WsServer) {
    const parsed = WsServerSchema.safeParse(raw);
    if (!parsed.success) return;
    const msg = parsed.data;
    if (msg.t !== 'ev') this.controlListeners.forEach((l) => l(msg));
    if (msg.t === 'ack') { const sub = this.channels.get(msg.ch); if (sub) sub.seq = msg.seq; return; }
    if (msg.t === 'resync') { const sub = this.channels.get(msg.ch); if (sub) this.resync(msg.ch, sub); return; }
    if (msg.t !== 'ev') return;
    const sub = this.channels.get(msg.ch);
    if (!sub?.active) return;
    sub.lastEvent = Date.now();
    if (sub.needsSnapshot && !sub.syncing) this.resync(msg.ch, sub);
    if (sub.seq !== null && msg.seq <= sub.seq) return;
    if (sub.seq !== null && msg.seq !== sub.seq + 1 && !sub.syncing) this.resync(msg.ch, sub);
    sub.seq = msg.seq;
    const key = eventKey(msg);
    sub.buffer.delete(key); sub.buffer.set(key, msg);
    const pairOverflow = msg.ch === 'pairs' && [...sub.buffer.values()].filter((e) => (e.data as { column?: string }).column === (msg.data as { column?: string }).column).length > 100;
    if (sub.buffer.size > limit(msg.ch) || pairOverflow) { this.resync(msg.ch, sub); return; }
    this.flushSoon();
  }
  private flushSoon() {
    if (this.frame !== null) return;
    // One write per painted frame. A page that is not painting (background tab, hidden pane, occluded window)
    // never runs the frame, so a timer drains the same batch; otherwise the store froze until a reload.
    this.frame = this.schedule(() => this.flush());
    this.frameFallback = setTimeout(() => this.flush(), this.frameFallbackMs);
  }
  private flush() {
    if (this.frame !== null) this.cancel(this.frame);
    if (this.frameFallback) clearTimeout(this.frameFallback);
    this.frame = null; this.frameFallback = undefined;
    for (const sub of this.channels.values()) {
      if (sub.syncing) continue;
      const events = [...sub.buffer.values()].sort((a, b) => a.seq - b.seq); sub.buffer.clear();
      if (events.length) sub.listeners.forEach((l) => { l.batch?.(events); if (l.event) for (const event of events) l.event(event); });
    }
  }
  close() {
    this.transport.close(); this.dispose.forEach((fn) => fn());
    if (this.hiddenTimer) clearTimeout(this.hiddenTimer);
    if (this.frameFallback) clearTimeout(this.frameFallback);
    if (this.frame !== null) this.cancel(this.frame);
    for (const sub of this.channels.values()) { if (sub.grace) clearTimeout(sub.grace); sub.generation++; }
    this.channels.clear();
  }
}
export function websocketUrl() {
  if (import.meta.env.VITE_WS_URL) return import.meta.env.VITE_WS_URL as string;
  const url = new URL(`${API_BASE}/ws`, location.origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}
export async function createRealtime(): Promise<Realtime> {
  const transport = (import.meta.env.DEV ? MOCKS : import.meta.env.VITE_MOCKS === '1') ? new (await import('../mocks/socket')).MockChannelSocket() : new ChannelSocket(websocketUrl);
  return new Realtime(transport);
}
