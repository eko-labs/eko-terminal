import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { WsClient, WsServer, WsEvent, WsEventMap } from '@eko/shared';
import { FRAME_FALLBACK_MS, Realtime, type ChannelTransport } from './realtime';
import { ChannelSocket, type WsState } from './ws';
import { createAddress, createFeedItem, createRadarRow, createTick, createTradeOrder } from '../mocks/fixtures';
class FakeTransport implements ChannelTransport {
  state: WsState = 'closed'; sent: WsClient[] = [];
  private messages = new Set<(m: WsServer) => void>(); private states = new Set<(s: WsState) => void>();
  connect() { this.change('open'); } close() { this.change('closed'); } reconnect() { this.change('reconnecting'); this.change('open'); }
  change(state: WsState) { this.state = state; this.states.forEach((l) => l(state)); }
  send(m: WsClient) { this.sent.push(m); }
  emit(m: WsServer) { this.messages.forEach((l) => l(m)); }
  on(l: (m: WsServer) => void) { this.messages.add(l); return () => { this.messages.delete(l); }; }
  onState(l: (s: WsState) => void) { this.states.add(l); return () => { this.states.delete(l); }; }
}
function setup() {
  const transport = new FakeTransport(); const frames = new Map<number, FrameRequestCallback>(); let id = 0;
  const rt = new Realtime(transport, (cb) => { frames.set(++id, cb); return id; }, (id) => { frames.delete(id); });
  const paint = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach((cb) => cb(0)); };
  return { transport, rt, paint };
}
const radar = (seq: number, address = createAddress()): WsEvent<'radar'> => ({ t: 'ev', ch: 'radar', seq, ts: 1, kind: 'row_upsert', data: { ...createRadarRow(), address, rank: seq } });
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe('channel realtime', () => {
  it('refcounts subscribers and reuses the two-second route-change grace', () => {
    vi.useFakeTimers(); const { rt, transport } = setup(); rt.connect();
    const stop1 = rt.subscribe('radar', () => {}), stop2 = rt.subscribe('radar', () => {});
    expect(transport.sent).toEqual([{ op: 'sub', ch: ['radar'] }]);
    stop1(); stop2(); vi.advanceTimersByTime(1999);
    expect(transport.sent).toHaveLength(1);
    const stop3 = rt.subscribe('radar', () => {}); vi.advanceTimersByTime(2000); expect(transport.sent).toHaveLength(1);
    stop3(); stop3(); vi.advanceTimersByTime(2000);
    expect(transport.sent.at(-1)).toEqual({ op: 'unsub', ch: ['radar'] }); rt.close();
  });
  it('re-subscribes once per active channel and resyncs snapshots after reconnect', async () => {
    const { rt, transport } = setup(); const resync = vi.fn(); rt.subscribe('radar', () => {}, resync); rt.subscribe('radar', () => {}, resync);
    rt.connect(); expect(resync).not.toHaveBeenCalled(); transport.reconnect(); await settle();
    expect(transport.sent.filter((m) => m.op === 'sub')).toHaveLength(2); expect(resync).toHaveBeenCalledTimes(2); rt.close();
  });
  it('gates user channels by SIWE and unsubscribes them on sign-out', () => {
    const { rt, transport } = setup(); rt.connect(); rt.subscribe('orders', () => {});
    expect(transport.sent).toEqual([]); rt.setSignedIn(true); expect(transport.sent).toEqual([{ op: 'sub', ch: ['orders'] }]);
    rt.setSignedIn(false); expect(transport.sent.at(-1)).toEqual({ op: 'unsub', ch: ['orders'] }); rt.close();
  });
  it('caps coin + flow channels at 40 and evicts the least recently used', () => {
    const { rt, transport } = setup(); rt.connect();
    for (let i = 0; i < 41; i++) rt.subscribe(`coin:0x${i.toString(16).padStart(40, '0')}`, () => {});
    expect(transport.sent.filter((m) => m.op === 'unsub')).toEqual([{ op: 'unsub', ch: [`coin:0x${'0'.repeat(40)}`] }]);
    rt.subscribe(`coin:0x${'0'.repeat(40)}`, () => {});
    expect(transport.sent.at(-1)).toEqual({ op: 'unsub', ch: [`coin:0x${'0'.repeat(39)}1`] }); rt.close();
  });
  it('coalesces updates by key per animation frame and rejects malformed payloads', () => {
    const { rt, transport, paint } = setup(); const listener = vi.fn(); rt.subscribe('radar', listener); rt.connect();
    transport.emit(radar(1)); transport.emit(radar(2)); transport.emit(radar(3));
    expect(listener).not.toHaveBeenCalled(); paint(); expect(listener).toHaveBeenCalledTimes(1); expect(listener.mock.calls[0][0].data.rank).toBe(3);
    expect(rt.lastEventAt('radar')).toEqual(expect.any(Number)); expect(rt.lastEventAt('missing')).toBeNull();
    transport.emit({ ...radar(4), data: null } as unknown as WsServer); paint(); expect(listener).toHaveBeenCalledTimes(1); rt.close();
  });
  it('holds gap deltas for the snapshot, drops covered seqs and applies the rest', async () => {
    const { rt, transport, paint } = setup(); const listener = vi.fn(); let finish!: (seq: number) => void;
    const resync = vi.fn(() => new Promise<number>((resolve) => { finish = resolve; }));
    rt.subscribe('radar', listener, resync); rt.connect(); transport.emit(radar(1)); paint();
    transport.emit(radar(3)); transport.emit(radar(4, '0x1111111111111111111111111111111111111111')); await settle();
    paint(); expect(listener).toHaveBeenCalledTimes(1); expect(resync).toHaveBeenCalledTimes(1);
    finish(3); await settle(); paint(); expect(listener).toHaveBeenCalledTimes(2); expect(listener.mock.calls[1][0].seq).toBe(4);
    transport.emit(radar(3)); paint(); expect(listener).toHaveBeenCalledTimes(2);
    transport.emit(radar(5)); await settle(); paint(); expect(resync).toHaveBeenCalledOnce(); expect(listener).toHaveBeenCalledTimes(3); rt.close();
  });
  it('handles server resync and failed snapshots without applying inconsistent buffered events', async () => {
    const { rt, transport, paint } = setup(); const listener = vi.fn(), resync = vi.fn(async () => { throw new Error('Offline'); });
    rt.subscribe('radar', listener, resync); rt.connect(); transport.emit({ t: 'resync', ch: 'radar' }); transport.emit(radar(8));
    await settle(); paint(); expect(resync).toHaveBeenCalledOnce(); expect(listener).not.toHaveBeenCalled(); rt.close();
  });
  it('suspends public stream channels after 30s hidden, keeps private channels and resyncs on return', async () => {
    vi.useFakeTimers(); const { rt, transport, paint } = setup(); const resync = vi.fn(), radarListener = vi.fn(), orderListener = vi.fn();
    rt.setSignedIn(true); rt.subscribe('radar', radarListener, resync); rt.subscribe('orders', orderListener); rt.connect();
    rt.setHidden(true); vi.advanceTimersByTime(29999); expect(transport.sent).toHaveLength(2);
    vi.advanceTimersByTime(1); expect(transport.sent.at(-1)).toEqual({ op: 'unsub', ch: ['radar'] });
    transport.emit(radar(1)); transport.emit({ t: 'ev', ch: 'orders', kind: 'order', seq: 1, ts: 1, data: createTradeOrder() }); paint();
    expect(radarListener).not.toHaveBeenCalled(); expect(orderListener).toHaveBeenCalledOnce();
    rt.setHidden(false); await settle(); expect(transport.sent.at(-1)).toEqual({ op: 'sub', ch: ['radar'] }); expect(resync).toHaveBeenCalledOnce(); rt.close();
  });
  it('resyncs instead of growing feed buffers without bound', async () => {
    const { rt, transport, paint } = setup(); const listener = vi.fn(), resync = vi.fn(); rt.subscribe('feed', listener, resync); rt.connect();
    for (let seq = 1; seq <= 700; seq++) transport.emit({ t: 'ev', ch: 'feed', seq, ts: 1, kind: 'item', data: { ...createFeedItem(), id: `item-${seq}` } });
    await settle(); paint(); expect(resync).toHaveBeenCalledOnce(); expect(listener.mock.calls.length).toBeLessThanOrEqual(500); rt.close();
  });
  it('dispatches one store batch per channel/frame', () => {
    const { rt, transport, paint } = setup(); const batch = vi.fn(); rt.subscribeBatch('radar', batch); rt.connect();
    transport.emit(radar(1)); transport.emit(radar(2, '0x1111111111111111111111111111111111111111')); paint();
    expect(batch).toHaveBeenCalledOnce(); expect(batch.mock.calls[0][0]).toHaveLength(2); rt.close();
  });
  it('drains batches on a timer when the page is not painting frames, once per batch', () => {
    // Background tabs, hidden panes and occluded windows never run animation frames. Before the fallback the
    // pairs/radar stores froze ("Stale · updated 1m ago") while the socket kept delivering events.
    vi.useFakeTimers(); const transport = new FakeTransport(), never = vi.fn(() => 1), cancel = vi.fn();
    const rt = new Realtime(transport, never, cancel), batch = vi.fn(); rt.subscribeBatch('radar', batch); rt.connect();
    transport.emit(radar(1)); transport.emit(radar(2, '0x1111111111111111111111111111111111111111'));
    expect(never).toHaveBeenCalledOnce(); vi.advanceTimersByTime(FRAME_FALLBACK_MS - 1); expect(batch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(batch).toHaveBeenCalledOnce(); expect(batch.mock.calls[0][0]).toHaveLength(2); expect(cancel).toHaveBeenCalledWith(1);
    for (let seq = 3; seq < 13; seq++) { transport.emit(radar(seq)); vi.advanceTimersByTime(FRAME_FALLBACK_MS); }
    expect(batch).toHaveBeenCalledTimes(11); expect(batch.mock.calls.at(-1)![0][0].seq).toBe(12); rt.close();
  });
  it('a painted frame wins over the fallback and does not deliver twice', () => {
    vi.useFakeTimers(); const { rt, transport, paint } = setup(); const batch = vi.fn(); rt.subscribeBatch('radar', batch); rt.connect();
    transport.emit(radar(1)); paint(); vi.advanceTimersByTime(FRAME_FALLBACK_MS * 4);
    expect(batch).toHaveBeenCalledOnce(); rt.close();
  });
  it('invalidates a snapshot pending from a previous connection', async () => {
    const { rt, transport, paint } = setup(); const listener = vi.fn(); const finishes: ((seq: number) => void)[] = [];
    const resync = vi.fn(() => new Promise<number>((resolve) => { finishes.push(resolve); }));
    rt.subscribe('radar', listener, resync); rt.connect(); transport.emit(radar(1)); paint();
    transport.emit(radar(3)); await settle(); transport.reconnect(); await settle();
    expect(resync).toHaveBeenCalledTimes(2);
    transport.emit(radar(1)); finishes[0](100); await settle(); paint(); expect(listener).toHaveBeenCalledTimes(1);
    finishes[1](0); await settle(); paint(); expect(listener).toHaveBeenCalledTimes(2); rt.close();
  });
  it('exports event payloads correlated to WsEventMap', () => {
    expectTypeOf<Extract<WsEvent<'coin'>, { kind: 'tick' }>['data']>().toEqualTypeOf<WsEventMap['coin']['tick']>();
  });
});

class FakeWebSocket {
  static OPEN = 1; static instances: FakeWebSocket[] = [];
  readyState = 1; sent: string[] = []; url: string;
  onopen?: () => void; onclose?: () => void; onmessage?: (e: { data: string }) => void;
  constructor(url: string) { this.url = url; FakeWebSocket.instances.push(this); }
  send(data: string) { this.sent.push(data); } close() { this.onclose?.(); }
}
describe('retained reconnect transport', () => {
  it('keeps exponential backoff, bounded jitter, ping cadence and explicit close', async () => {
    vi.useFakeTimers(); vi.stubGlobal('WebSocket', FakeWebSocket); FakeWebSocket.instances = [];
    vi.spyOn(Math, 'random').mockReturnValue(.5);
    const socket = new ChannelSocket(() => 'ws://localhost/v1/ws'); const reconnect = vi.fn(); socket.onReconnect = reconnect;
    socket.connect(); socket.connect(); expect(FakeWebSocket.instances).toHaveLength(1);
    FakeWebSocket.instances[0].onclose?.(); vi.advanceTimersByTime(4999); expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1); expect(FakeWebSocket.instances).toHaveLength(2);
    FakeWebSocket.instances[1].onclose?.(); vi.advanceTimersByTime(4999); expect(FakeWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1); expect(FakeWebSocket.instances).toHaveLength(3);
    const ws = FakeWebSocket.instances[2]; ws.onopen?.(); expect(ws.sent).toContain('{"op":"ping"}');
    vi.advanceTimersByTime(10000); expect(ws.sent.filter((s) => s === '{"op":"ping"}')).toHaveLength(2);
    ws.onclose?.(); vi.advanceTimersByTime(5000); FakeWebSocket.instances[3].onopen?.(); expect(reconnect).toHaveBeenCalledOnce();
    socket.close(); vi.advanceTimersByTime(30000); expect(FakeWebSocket.instances).toHaveLength(4); expect(socket.state).toBe('closed');
  });
});

describe('socket storm bounds', () => {
  it('increases backoff when upgrades fail before opening', () => {
    vi.useFakeTimers(); vi.stubGlobal('WebSocket', FakeWebSocket); vi.spyOn(Math,'random').mockReturnValue(.5); FakeWebSocket.instances=[];
    const socket=new ChannelSocket(()=> 'ws://localhost/v1/ws'); socket.connect();
    for(const delay of [5000,5000,5000,5000,8000]) {FakeWebSocket.instances.at(-1)!.onclose?.();vi.advanceTimersByTime(delay);}
    expect(FakeWebSocket.instances).toHaveLength(6); FakeWebSocket.instances.at(-1)!.onclose?.();
    vi.advanceTimersByTime(14999); expect(FakeWebSocket.instances).toHaveLength(6);
    vi.advanceTimersByTime(1); expect(FakeWebSocket.instances).toHaveLength(7); socket.close();
  });
  it('bounds explicit reconnects and successful immediate disconnects across a minute', () => {
    vi.useFakeTimers(); vi.stubGlobal('WebSocket', FakeWebSocket); FakeWebSocket.instances = [];
    const socket = new ChannelSocket(() => 'ws://localhost/v1/ws'); socket.connect();
    const opened = new Set<FakeWebSocket>();
    for (let i=0;i<600;i++) { const ws = FakeWebSocket.instances.at(-1)!; if (!opened.has(ws)) { ws.onopen?.(); opened.add(ws); } socket.reconnect(); vi.advanceTimersByTime(100); }
    // Half-open minute [0, 60000) plus the connection exactly at the next boundary.
    expect(FakeWebSocket.instances.length).toBeLessThanOrEqual(13); socket.close();
  });
  it('does not upgrade while hidden and stops its retry timer on disposal', () => {
    vi.useFakeTimers(); vi.stubGlobal('WebSocket', FakeWebSocket); FakeWebSocket.instances = [];
    const doc = new EventTarget() as EventTarget & { visibilityState: string }; doc.visibilityState='hidden'; vi.stubGlobal('document',doc);
    const socket = new ChannelSocket(() => 'ws://localhost/v1/ws'); socket.connect(); vi.advanceTimersByTime(60000);
    expect(FakeWebSocket.instances).toHaveLength(0);
    doc.visibilityState='visible'; doc.dispatchEvent(new Event('visibilitychange')); expect(FakeWebSocket.instances).toHaveLength(1);
    doc.visibilityState='hidden'; doc.dispatchEvent(new Event('visibilitychange')); vi.advanceTimersByTime(60000);
    expect(FakeWebSocket.instances).toHaveLength(1); socket.close();
    doc.visibilityState='visible'; doc.dispatchEvent(new Event('visibilitychange')); vi.advanceTimersByTime(60000);
    expect(FakeWebSocket.instances).toHaveLength(1); vi.unstubAllGlobals();
  });
});
