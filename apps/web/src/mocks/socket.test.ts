import { afterEach, describe, expect, it, vi } from 'vitest';
import { WsServerSchema, type WsServer } from '@eko/shared';
import { MockChannelSocket } from './socket';
import { createRadarRows } from './demo/radar';
import { Realtime } from '../lib/realtime';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
describe('mock radar stream', () => {
  it('emits one valid random-row update every 2.6s and stops on unsubscribe/close', () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValueOnce(0).mockReturnValueOnce(.999);
    const socket = new MockChannelSocket(), events: WsServer[] = [];
    socket.on((event) => { events.push(WsServerSchema.parse(event)); });
    socket.connect(); socket.send({ op: 'sub', ch: ['radar'] });
    const updates = () => events.filter((e) => e.t === 'ev' && e.ch === 'radar');
    vi.advanceTimersByTime(2599); expect(updates()).toHaveLength(0);
    vi.advanceTimersByTime(1); expect(updates()).toHaveLength(1);
    expect(updates()[0]).toMatchObject({ seq: 1, kind: 'row_upsert', data: { address: createRadarRows()[0].address } });
    vi.advanceTimersByTime(2600); expect(updates()).toHaveLength(2);
    expect(updates()[1]).toMatchObject({ seq: 2, data: { address: createRadarRows()[29].address } });
    socket.send({ op: 'unsub', ch: ['radar'] }); vi.advanceTimersByTime(5200); expect(updates()).toHaveLength(2);
    socket.send({ op: 'sub', ch: ['radar'] }); socket.close(); vi.advanceTimersByTime(5200); expect(updates()).toHaveLength(2);
  });
  it('delivers batches through the real client after Strict Mode subscription replay', () => {
    vi.useFakeTimers(); vi.spyOn(Math, 'random').mockReturnValue(0);
    const frames = new Map<number, FrameRequestCallback>(); let id = 0;
    const socket = new MockChannelSocket();
    const rt = new Realtime(socket, (cb) => { frames.set(++id, cb); return id; }, (key) => { frames.delete(key); });
    const receive = vi.fn(); rt.connect();
    const stop = rt.subscribeBatch('radar', receive); stop();
    const stopAgain = rt.subscribeBatch('radar', receive);
    vi.advanceTimersByTime(2600); frames.forEach((cb) => cb(0)); frames.clear();
    expect(receive).toHaveBeenCalledTimes(1);
    expect(receive.mock.calls[0][0]).toHaveLength(1);
    expect(receive.mock.calls[0][0][0]).toMatchObject({ kind: 'row_upsert', data: { address: createRadarRows()[0].address } });
    stopAgain(); rt.close();
  });
});
