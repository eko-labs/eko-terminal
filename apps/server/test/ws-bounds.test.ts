// Synthetic integration checks through buildApp's production /v1/ws and /v2/ws registrations.
import { once } from 'node:events';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Address, CoinCardV2 } from '@eko/shared';
import { GuardWsServerSchema, WsServerSchema } from '@eko/shared';
import type { WebSocket } from 'ws';
import { buildApp } from '../src/app.js';
import { loadConfig, WS_DEFAULT_LIMITS } from '../src/config.js';

const MAX_BUFFER = 2 * 1024 * 1024;
const address = (n: number): Address => `0x${n.toString(16).padStart(40, '0')}`;
const channel = (n: number) => `coin:${address(n)}`;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const base = { NODE_ENV: 'test', PGLITE_DIR: ':memory:', SESSION_SECRET: 'ws-fixture-placeholder'.repeat(3), LEGACY_API: 'false', RUN_WORKER: 'false', MARKET_DATA_SOURCE: 'onchain' };
let built: Awaited<ReturnType<typeof buildApp>>;
interface Connection { ws: WebSocket; server: WebSocket; seen: Record<string, unknown>[] }
const connections: Connection[] = [];
interface Read { coin: Address; resolve(value: CoinCardV2 | null): void; reject(error: Error): void }
let reads: Read[] = [];

beforeAll(async () => {
  built = await buildApp(loadConfig({ ...base, WS_WINDOW_MS: '60000', WS_MESSAGES_PER_WINDOW: '12', WS_HARD_MESSAGES_PER_WINDOW: '20', WS_SNAPSHOTS_PER_CONNECTION: '2', WS_SNAPSHOTS_GLOBAL: '3', WS_SNAPSHOT_QUEUE: '4' }), { startBackground: false });
  await built.app.ready();
});
afterAll(async () => { await built?.close(); });
afterEach(async () => {
  for (const connection of connections.splice(0)) {
    if (connection.server.readyState !== 3) {
      const closed = once(connection.server, 'close');
      connection.server.terminate();
      connection.ws.terminate();
      await closed;
    }
  }
  // Settle running promises only after disconnect, so cleanup cannot start queued work.
  for (const read of reads) read.resolve(null);
  await tick();
  reads = [];
  vi.restoreAllMocks();
});

async function connect(path = '/v2/ws', beforeRegister?: (socket: WebSocket) => void): Promise<Connection> {
  let server!: WebSocket;
  built.app.websocketServer.once('connection', socket => { server = socket; beforeRegister?.(socket); });
  const seen: Record<string, unknown>[] = [];
  // injectWS needs a synthetic peer for the production HTTP rate limiter's req.ip lookup.
  const ws = await built.app.injectWS(path, { socket: { remoteAddress: '127.0.0.1' } as import('node:net').Socket }, { onInit: socket => socket.on('message', raw => seen.push(JSON.parse(String(raw)))) });
  await tick();
  const connection = { ws, server, seen };
  connections.push(connection);
  return connection;
}
async function frame(connection: Connection, message: unknown, raw = false) {
  const handled = new Promise<void>(resolve => connection.server.once('message', () => setImmediate(resolve)));
  connection.ws.send(raw ? String(message) : JSON.stringify(message));
  await handled;
}
const subscribe = (connection: Connection, numbers: number[]) => frame(connection, { op: 'sub', version: 2, ch: numbers.map(channel) });
function deferredCards() {
  return vi.spyOn(built.ctx.reads.guard, 'card').mockImplementation(coin => new Promise<CoinCardV2 | null>((resolve, reject) => reads.push({ coin, resolve, reject })));
}
async function finishReads() {
  for (let i = 0; i < reads.length; i++) { reads[i]!.resolve(null); await tick(); }
}

describe('public WebSocket work bounds', () => {
  it('configures sensible defaults and rejects invalid budgets', () => {
    const cfg = loadConfig(base);
    expect(cfg.WS_MESSAGES_PER_WINDOW).toBe(WS_DEFAULT_LIMITS.messagesPerWindow);
    expect(cfg.WS_SNAPSHOTS_GLOBAL).toBe(WS_DEFAULT_LIMITS.snapshotsGlobal);
    for (const env of [{ WS_WINDOW_MS: '0' }, { WS_MESSAGES_PER_WINDOW: '-1' }, { WS_SNAPSHOTS_PER_CONNECTION: '0' }, { WS_SNAPSHOTS_GLOBAL: '1.5' }, { WS_SNAPSHOT_QUEUE: '-1' }, { WS_MESSAGES_PER_WINDOW: '30', WS_HARD_MESSAGES_PER_WINDOW: '30' }]) {
      expect(() => loadConfig({ ...base, ...env })).toThrow();
    }
    expect(loadConfig({ ...base, WS_SNAPSHOT_QUEUE: '0' }).WS_SNAPSHOT_QUEUE).toBe(0);
  });

  it('keeps duplicate pending and held subscriptions to one read and one ack, including unsubscribe/resubscribe', async () => {
    const card = deferredCards(), connection = await connect();
    await subscribe(connection, [1, 1, 1]);
    for (let i = 0; i < 5; i++) await subscribe(connection, [1]);
    expect(card).toHaveBeenCalledTimes(1);
    expect(connection.seen.filter(m => m.t === 'ack')).toHaveLength(1);
    await frame(connection, { op: 'unsub', version: 2, ch: [channel(1)] });
    await subscribe(connection, [1]);
    expect(card).toHaveBeenCalledTimes(1);
    reads[0]!.resolve(null); await tick();
    expect(connection.seen.filter(m => m.t === 'ev')).toHaveLength(1);
    await subscribe(connection, [1]);
    expect(card).toHaveBeenCalledTimes(1);
    expect(connection.seen.every(m => GuardWsServerSchema.safeParse(m).success)).toBe(true);
  });

  it('caps concurrent reads per connection and globally, bounds the queue and rejects excess work', async () => {
    const card = deferredCards(), a = await connect(), b = await connect();
    await subscribe(a, [1, 2, 3, 4, 5]);
    expect(card).toHaveBeenCalledTimes(2);
    await subscribe(a, [3, 4, 5, 3]); // Queued subscriptions are coalesced as well.
    await subscribe(b, [6, 7, 8]);
    expect(card).toHaveBeenCalledTimes(3);
    expect(b.seen.filter(m => m.code === 'rate_limited')).toHaveLength(1);
    expect(built.ctx.hub.hasV2Subscribers(address(8))).toBe(false);
    reads[0]!.resolve(null); await tick();
    expect(reads.map(r => r.coin)).toEqual([address(1), address(2), address(6), address(3)]);
    await finishReads();
    expect(card).toHaveBeenCalledTimes(7);
    expect(a.seen.filter(m => m.t === 'ev')).toHaveLength(5);
    expect(b.seen.filter(m => m.t === 'ev')).toHaveLength(2);
    // A rejected subscription may be retried once capacity returns.
    await subscribe(b, [8]); expect(card).toHaveBeenCalledTimes(8);
  });

  it.each(['/v2/ws', '/v1/ws'])('rate-limits a flood then closes with 1008 through %s', async path => {
    const card = deferredCards(), connection = await connect(path);
    for (let i = 0; i < 13; i++) await frame(connection, { op: 'ping' });
    expect(connection.seen.filter(m => m.t === 'pong')).toHaveLength(12);
    expect(connection.seen.filter(m => m.code === 'rate_limited')).toHaveLength(1);
    const closed = once(connection.ws, 'close');
    for (let i = 0; i < 8; i++) connection.ws.send(JSON.stringify({ op: 'ping' }));
    // injectWS uses in-memory streams; explicitly finish them after the close frame is delivered.
    await tick(); connection.ws.terminate(); connection.server.terminate();
    expect((await closed)[0]).toBe(1008);
    expect(connection.seen.filter(m => m.code === 'rate_limited')).toHaveLength(1);
    expect(card).not.toHaveBeenCalled();
    const schema = path === '/v2/ws' ? GuardWsServerSchema : WsServerSchema;
    expect(connection.seen.every(m => schema.safeParse(m).success)).toBe(true);
  });

  it('counts malformed frames and resets the fixed window', async () => {
    const start = Date.now(), now = vi.spyOn(Date, 'now').mockReturnValue(start), connection = await connect();
    for (let i = 0; i < 13; i++) await frame(connection, '{', true);
    expect(connection.seen.filter(m => m.code === 'rate_limited')).toHaveLength(1);
    now.mockReturnValue(start + 60000);
    await frame(connection, { op: 'ping' });
    expect(connection.seen.at(-1)?.t).toBe('pong');
    expect(connection.server.readyState).toBe(1);
  });

  it('discards queued reads on disconnect and ignores late success or failure without freeing running slots early', async () => {
    const card = deferredCards(), a = await connect();
    const sent = vi.spyOn(a.server, 'send');
    await subscribe(a, [1, 2, 3, 4]);
    expect(card).toHaveBeenCalledTimes(2);
    const closed = once(a.server, 'close'); a.server.terminate(); a.ws.terminate(); await closed;
    sent.mockClear();
    const b = await connect(); await subscribe(b, [5, 6]);
    expect(card).toHaveBeenCalledTimes(3); // Two disconnected reads still occupy slots.
    reads[0]!.resolve(null); reads[1]!.reject(new Error('fixture failure')); await tick();
    expect(sent).not.toHaveBeenCalled();
    expect(reads.map(r => r.coin)).toEqual([address(1), address(2), address(5), address(6)]);
    await finishReads();
    expect(card).toHaveBeenCalledTimes(4);
    expect(b.seen.filter(m => m.t === 'ev')).toHaveLength(2);
  });

  it('drops queued work and late replies on socket error', async () => {
    const card = deferredCards(), connection = await connect();
    await subscribe(connection, [1, 2, 3]);
    const sent = vi.spyOn(connection.server, 'send');
    connection.server.emit('error', new Error('fixture transport failure'));
    await finishReads();
    expect(card).toHaveBeenCalledTimes(2);
    expect(sent).not.toHaveBeenCalled();
    expect(built.ctx.hub.hasV2Subscribers(address(1))).toBe(false);
  });

  it('cancels an unsubscribed queued channel before it starts', async () => {
    const card = deferredCards(), connection = await connect();
    await subscribe(connection, [1, 2, 3]);
    await frame(connection, { op: 'unsub', version: 2, ch: [channel(3)] });
    await finishReads(); expect(card).toHaveBeenCalledTimes(2);
    await subscribe(connection, [3]); expect(card).toHaveBeenCalledTimes(3);
  });

  it('never sends a snapshot, error or pong above MAX_BUFFER and drops queued snapshots for a slow consumer', async () => {
    const card = deferredCards(), connection = await connect();
    await subscribe(connection, [1, 2, 3, 4]);
    const buffered = vi.spyOn(connection.server, 'bufferedAmount', 'get').mockReturnValue(MAX_BUFFER + 1);
    const sent = vi.spyOn(connection.server, 'send');
    reads[0]!.resolve(null); reads[1]!.reject(new Error('fixture failure')); await tick();
    await frame(connection, { op: 'ping' });
    for (let i = 0; i < 12; i++) built.ctx.hub.publishV2(address(1), 'card', null);
    expect(card).toHaveBeenCalledTimes(2); expect(sent).not.toHaveBeenCalled();
    buffered.mockReturnValue(0);
    built.ctx.hub.publishV2(address(1), 'card', null); await tick();
    expect(connection.seen.at(-1)).toEqual({ t: 'resync', version: 2, ch: channel(1) });
    built.ctx.hub.publishV2(address(1), 'card', null); await tick();
    expect(connection.seen.at(-1)).toMatchObject({ t: 'ev', ch: channel(1) });
  });

  it.each(['/v2/ws', '/v1/ws'])('checks hello, ack, errors and pong before sending through %s', async path => {
    const card = deferredCards();
    let buffered!: ReturnType<typeof vi.spyOn>;
    let sent!: ReturnType<typeof vi.spyOn>;
    const connection = await connect(path, socket => {
      buffered = vi.spyOn(socket, 'bufferedAmount', 'get').mockReturnValue(MAX_BUFFER + 1);
      sent = vi.spyOn(socket, 'send');
    });
    const sub = path === '/v2/ws' ? { op: 'sub', version: 2, ch: [channel(1)] } : { op: 'sub', ch: ['feed', 'not-a-channel'] };
    await frame(connection, sub);
    for (let i = 0; i < 12; i++) await frame(connection, { op: 'ping' });
    expect(sent).not.toHaveBeenCalled(); expect(card).not.toHaveBeenCalled();
    // Even a rate-limited slow consumer is closed at the hard ceiling.
    const closed = once(connection.ws, 'close');
    for (let i = 0; i < 8; i++) connection.ws.send(JSON.stringify({ op: 'ping' }));
    await tick(); connection.ws.terminate(); connection.server.terminate();
    expect((await closed)[0]).toBe(1008);
    buffered.mockReturnValue(0);
  });

  it('keeps ordinary subscriptions and channel-filtered fan-out working for both versions', async () => {
    const card = vi.spyOn(built.ctx.reads.guard, 'card').mockResolvedValue(null);
    const a = await connect(), b = await connect(), v1 = await connect('/v1/ws');
    await subscribe(a, [101]); await subscribe(b, [102]);
    await frame(v1, { op: 'sub', ch: [channel(101)] });
    expect(card).toHaveBeenCalledTimes(2);
    expect(a.seen.map(m => m.t)).toEqual(['hello', 'ack', 'ev']);
    expect(b.seen.map(m => m.t)).toEqual(['hello', 'ack', 'ev']);
    built.ctx.hub.publishV2(address(101), 'card', null);
    built.ctx.hub.publish(channel(101) as `coin:${Address}`, 'tick', { ts: 1, price: 2, volumeUsd: 3, block: 4 });
    await tick();
    expect(a.seen.at(-1)).toMatchObject({ t: 'ev', ch: channel(101), seq: 1, version: 2 });
    expect(b.seen.filter(m => m.t === 'ev')).toHaveLength(1);
    expect(v1.seen.at(-1)).toMatchObject({ t: 'ev', ch: channel(101), seq: 1, kind: 'tick' });
    expect(a.seen.every(m => GuardWsServerSchema.safeParse(m).success)).toBe(true);
    expect(v1.seen.every(m => WsServerSchema.safeParse(m).success)).toBe(true);
  });
});
