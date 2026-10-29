import { requestPauseUntil } from './rateNotice';
import { WsServerSchema, type ClientMessage, type ServerMessage, type Timeframe } from '@eko/shared';
import { observeServerTime, setRoughServerTime } from './clock';
import { track } from './telemetry';

export type WsState = 'connecting' | 'open' | 'reconnecting' | 'closed';

type Listener = (m: ServerMessage) => void;

/**
 * Resilient WebSocket: exponential backoff with jitter, subscription replay on reconnect,
 * ping-based RTT + clock sync, and an `onReconnect` hook so state can be re-fetched.
 */
export class SignalSocket {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private stateListeners = new Set<(s: WsState) => void>();
  private backoff = 500;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private watching = false;
  private visibility = () => { if (document.visibilityState !== 'hidden' && !this.stopped) this.connect(); };
  private sub: { markets: string[]; timeframes: Timeframe[] } = { markets: [], timeframes: [] };
  private pingTimer: number | null = null;
  private pending = new Map<number, number>();
  private everOpened = false;
  private nextConnect = 0;
  private openedAt = 0;
  state: WsState = 'connecting';
  onReconnect: (() => void) | null = null;

  connect() {
    if (this.ws || this.retry) return;
    this.stopped = false;
    if (!this.watching && typeof document !== 'undefined') { document.addEventListener('visibilitychange', this.visibility); this.watching = true; }
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    this.nextConnect = Math.max(this.nextConnect, requestPauseUntil());
    if (Date.now() < this.nextConnect) { this.retry = setTimeout(() => { this.retry = null; this.connect(); }, this.nextConnect - Date.now()); return; }
    this.nextConnect = Date.now() + 5000;
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    this.setState(this.everOpened ? 'reconnecting' : 'connecting');
    this.openedAt = 0;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      const wasReconnect = this.everOpened;
      this.everOpened = true;
      this.openedAt = Date.now();
      this.setState('open');
      this.send({ type: 'subscribe', ...this.sub });
      this.ping();
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => this.ping(), 10_000);
      if (wasReconnect) this.onReconnect?.();
    };
    ws.onmessage = (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === 'pong') {
        const sent = this.pending.get(msg.t);
        if (sent !== undefined) {
          const now = performance.now();
          this.pending.delete(msg.t);
          track('ws.rtt_ms', now - sent);
          observeServerTime(msg.serverTime, performance.timeOrigin + sent, performance.timeOrigin + now);
        }
        return;
      }
      if (msg.type === 'hello') setRoughServerTime(msg.serverTime);
      for (const l of this.listeners) l(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.pingTimer) clearInterval(this.pingTimer);
      if (this.stopped) return;
      if (this.openedAt > 0 && Date.now() - this.openedAt >= 30000) this.backoff = 500;
      this.setState('reconnecting');
      const delay = Math.max(5000, Math.min(15_000, this.backoff) * (0.75 + Math.random() * 0.5));
      this.backoff = Math.min(15_000, this.backoff * 2);
      this.retry = setTimeout(() => { this.retry = null; this.connect(); }, delay);
    };
  }

  close() {
    this.stopped = true; if (this.retry) clearTimeout(this.retry); this.retry = null;
    if (this.pingTimer) clearInterval(this.pingTimer);
    const ws = this.ws; this.ws = null; ws?.close();
    if (this.watching) document.removeEventListener('visibilitychange', this.visibility); this.watching = false;
    this.setState('closed');
  }
  private ping() {
    const t = Math.round(performance.now() * 1000);
    this.pending.set(t, performance.now());
    this.send({ type: 'ping', t });
  }

  private setState(s: WsState) {
    this.state = s;
    for (const l of this.stateListeners) l(s);
  }

  send(m: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  subscribe(markets: string[], timeframes: Timeframe[]) {
    this.sub = { markets, timeframes };
    this.send({ type: 'subscribe', markets, timeframes });
  }

  on(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  onState(l: (s: WsState) => void) {
    this.stateListeners.add(l);
    return () => this.stateListeners.delete(l);
  }
}

export const socket = new SignalSocket();

/** Channel transport evolved from SignalSocket: same backoff, jitter and clock sync. */
export class ChannelSocket {
  private ws: WebSocket | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private backoff = 500;
  private everOpened = false;
  private nextConnect = 0;
  private openedAt = 0;
  private stopped = true;
  private watching = false;
  private visibility = () => {
    if (document.visibilityState === 'hidden') {
      if (this.retry) clearTimeout(this.retry); this.retry = null; this.clearPing();
      const ws = this.ws; this.ws = null; ws?.close(); this.setState('closed');
    } else if (!this.stopped) this.connect();
  };
  private sentAt = 0;
  private messages = new Set<(m: import('@eko/shared').WsServer) => void>();
  private states = new Set<(s: WsState) => void>();
  state: WsState = 'closed';
  onReconnect: (() => void) | null = null;
  constructor(private url: () => string) {}
  private setState(state: WsState) { this.state = state; this.states.forEach((l) => l(state)); }
  connect() {
    if (this.ws || this.retry) return;
    this.stopped = false;
    if (!this.watching && typeof document !== 'undefined') { document.addEventListener('visibilitychange', this.visibility); this.watching = true; }
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    this.nextConnect = Math.max(this.nextConnect, requestPauseUntil());
    if (Date.now() < this.nextConnect) { this.retry = setTimeout(() => { this.retry = null; this.connect(); }, this.nextConnect - Date.now()); return; }
    this.nextConnect = Date.now() + 5000;
    this.setState(this.everOpened ? 'reconnecting' : 'connecting');
    this.openedAt = 0;
    const ws = new WebSocket(this.url());
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      const reconnect = this.everOpened;
      this.everOpened = true; this.openedAt = Date.now();
      this.setState('open');
      this.ping();
      this.pingTimer = setInterval(() => this.ping(), 10_000);
      if (reconnect) this.onReconnect?.();
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      let raw: unknown;
      try { raw = JSON.parse(ev.data); } catch { return; }
      const parsed = WsServerSchema.safeParse(raw);
      if (!parsed.success) return;
      const msg = parsed.data;
      if (msg.t === 'pong' && this.sentAt) {
        const now = performance.now();
        track('ws.rtt_ms', now - this.sentAt);
        observeServerTime(msg.serverTime, performance.timeOrigin + this.sentAt, performance.timeOrigin + now);
        this.sentAt = 0;
      }
      if (msg.t === 'hello') setRoughServerTime(msg.serverTime);
      this.messages.forEach((l) => l(msg));
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearPing();
      if (this.stopped) return;
      this.setState('reconnecting');
      if (this.openedAt > 0 && Date.now() - this.openedAt >= 30000) this.backoff = 500;
      const delay = Math.max(5000, Math.min(15_000, this.backoff * (0.75 + Math.random() * 0.5)));
      this.backoff = Math.min(15_000, this.backoff * 2);
      this.retry = setTimeout(() => { this.retry = null; this.connect(); }, delay);
    };
  }
  private ping() { this.sentAt = performance.now(); this.send({ op: 'ping' }); }
  private clearPing() { if (this.pingTimer) clearInterval(this.pingTimer); this.pingTimer = null; this.sentAt = 0; }
  send(m: import('@eko/shared').WsClient) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m)); }
  on(l: (m: import('@eko/shared').WsServer) => void) { this.messages.add(l); return () => { this.messages.delete(l); }; }
  onState(l: (s: WsState) => void) { this.states.add(l); return () => { this.states.delete(l); }; }
  reconnect() { this.close(); this.connect(); }
  close() {
    this.stopped = true;
    if (this.watching) document.removeEventListener('visibilitychange', this.visibility); this.watching = false;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null; this.clearPing();
    const ws = this.ws; this.ws = null; ws?.close(); this.setState('closed');
  }
}
