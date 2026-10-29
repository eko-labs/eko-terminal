import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoinCardSchema, FeedItemSchema, PairRowSchema, WsServerSchema, type WsServer } from '@eko/shared';
import { createPairRows } from './pairs';
import { createFeedRows } from './feed';
import { MOCK_HEAD_BLOCK } from '../head';
import { createMockTransport } from '../transport';
import { createApi } from '../../lib/api';
import { MockChannelSocket } from '../socket';
import { Realtime } from '../../lib/realtime';
import { FeedResponseSchema, PairResponseSchema } from '../../pages/terminal/pairsFeedModel';

afterEach(() => { vi.useRealTimers(); });
describe('pairs and feed demo contracts and lifecycle', () => {
  it('ports deterministic samples into valid schemas, with the demo head on every feed item', () => {
    const pairs = createPairRows(), feed = createFeedRows(1000000);
    expect(pairs).toEqual(createPairRows()); expect(feed).toEqual(createFeedRows(1000000));
    expect(pairs).toHaveLength(41); expect(feed).toHaveLength(64);
    pairs.forEach((r) => expect(PairRowSchema.safeParse(r).success).toBe(true));
    feed.forEach((r) => { expect(FeedItemSchema.safeParse(r).success).toBe(true); expect(r.block).toBe(MOCK_HEAD_BLOCK); });
    pairs[0].symbol.text = 'modified'; expect(createPairRows()[0].symbol.text).toBe('GLINT');
  });
  it('serves stage, kind and cursor queries and matching pair details through REST', async () => {
    const api = createApi('/v1', createMockTransport());
    for (const stage of ['new', 'near_grad', 'migrated']) {
      const data = await api.parse(`/pairs?stage=${stage}`, PairResponseSchema);
      expect(data.rows.length).toBeGreaterThan(0); expect(data.rows.every((r) => r.column === stage)).toBe(true);
    }
    const pairs = await api.parse('/pairs?stage=new', PairResponseSchema);
    expect((await api.parse(`/coins/${pairs.rows[0].address}`, CoinCardSchema)).identity.address).toBe(pairs.rows[0].address);
    const first = await api.parse('/feed?kinds=verdict,swarm', FeedResponseSchema);
    expect(first.rows.every((r) => ['verdict', 'swarm'].includes(r.kind))).toBe(true);
    const next = await api.parse(`/feed?kinds=verdict,swarm&cursor=${first.rows[0].id}`, FeedResponseSchema);
    expect(next.rows).toEqual(first.rows.slice(1));
  });
  it('emits valid feed items every 2s and new pairs/stage moves every 4s, with idempotent subscription and cleanup', () => {
    vi.useFakeTimers();
    const socket = new MockChannelSocket(), events: WsServer[] = [];
    socket.on((e) => { events.push(WsServerSchema.parse(e)); }); socket.connect();
    socket.send({ op: 'sub', ch: ['pairs', 'feed'] }); socket.send({ op: 'sub', ch: ['pairs', 'feed'] });
    vi.advanceTimersByTime(4000);
    const updates = events.filter((e) => e.t === 'ev');
    expect(updates.filter((e) => e.ch === 'feed')).toHaveLength(2);
    expect(updates.some((e) => e.ch === 'pairs' && e.kind === 'pair_upsert' && e.data.verdictPending)).toBe(true);
    expect(updates.some((e) => e.ch === 'pairs' && e.kind === 'pair_upsert' && e.data.column === 'migrated')).toBe(true);
    vi.advanceTimersByTime(60000);
    const count = events.length; vi.advanceTimersByTime(4000);
    expect(events.slice(count).some((e) => e.t === 'ev' && e.ch === 'pairs' && e.kind === 'pair_upsert' && e.data.column === 'migrated')).toBe(true);
    socket.send({ op: 'unsub', ch: ['pairs', 'feed'] }); const before = events.length; vi.advanceTimersByTime(10000); expect(events).toHaveLength(before);
    socket.send({ op: 'sub', ch: ['pairs', 'feed'] }); socket.close(); const closed = events.length; vi.advanceTimersByTime(10000); expect(events).toHaveLength(closed);
  });
  it('unsubscribes feed after 30s hidden and invokes a parsed REST resync before releasing return events', async () => {
    vi.useFakeTimers();
    const frames = new Map<number, FrameRequestCallback>(); let id = 0;
    const socket = new MockChannelSocket(), messages: WsServer[] = []; socket.on((e) => messages.push(e));
    const send = vi.spyOn(socket, 'send');
    const rt = new Realtime(socket, (cb) => { frames.set(++id, cb); return id; }, (key) => { frames.delete(key); });
    const api = createApi('/v1', createMockTransport());
    const resync = vi.fn(async () => { const response = await api.parse('/feed?kinds=agent_trade,swarm', FeedResponseSchema); expect(response.rows.length).toBeGreaterThan(0); });
    const receive = vi.fn(); rt.connect(); rt.subscribeBatch('feed', receive, resync);
    rt.setHidden(true); vi.advanceTimersByTime(29999); expect(send).not.toHaveBeenCalledWith({ op: 'unsub', ch: ['feed'] });
    vi.advanceTimersByTime(1); expect(send).toHaveBeenCalledWith({ op: 'unsub', ch: ['feed'] });
    const n = messages.length; vi.advanceTimersByTime(10000); expect(messages).toHaveLength(n);
    rt.setHidden(false); for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(resync).toHaveBeenCalledOnce(); expect(send).toHaveBeenLastCalledWith({ op: 'sub', ch: ['feed'] });
    rt.close();
  });
});
