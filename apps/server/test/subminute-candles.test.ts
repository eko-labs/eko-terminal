import { withHistoryFixtures } from '../../../packages/db/test/helpers/historical-db.js';
import { EventEmitter } from 'node:events';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { binary, InProcessBus } from '@eko/db';
import { BarSchema, WsServerSchema, type Address } from '@eko/shared';
import type { WebSocket } from 'ws';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { ReadLive } from '../src/read/live.js';
import { Hub } from '../src/ws/hub.js';
import { sampleAddress } from './read-fixture.js';

const epoch = Date.parse('2026-10-02T12:00:00Z') / 1000;
let now = epoch;
let built: Awaited<ReturnType<typeof buildApp>>;
let sequence = 0;
const coin = sampleAddress(9100);
beforeAll(async () => {
  built = await buildApp(loadConfig({ NODE_ENV: 'test', PGLITE_DIR: ':memory:', SESSION_SECRET: 'test-only-placeholder'.repeat(2), LEGACY_API: 'false', RUN_WORKER: 'false', MARKET_DATA_SOURCE: 'onchain' }), { startBackground: false });
  built.ctx.reads.store.now = () => now * 1000;
  withHistoryFixtures(built.ctx.dbh.chain);
  await built.ctx.dbh.chain.ensurePartitions(new Date(epoch * 1000));
  await token(coin);
  await built.ctx.dbh.chain.setCursor('head', 999n, null);
});
afterAll(async () => { await built.close(); });
async function token(address: Address) {
  await built.ctx.dbh.chain.insert('tokens', { address: binary(address), decimals: 2, total_supply: '100000', supply_block: '1', first_block: '1', block: '1', launchpad: 'other', name: 'Sample coin', symbol: 'DEMO' });
}
async function swap(address: Address, ts: number, price: number | null, block: number, logIndex = 0, pending = false) {
  const txHash = `0x${(++sequence).toString(16).padStart(64, '0')}`;
  await built.ctx.dbh.chain.insert('swaps', { ts: new Date(ts * 1000), block, tx_hash: binary(txHash), log_index: logIndex,
    venue: 'uniswap_v3', pool_id: binary(sampleAddress(9200)), coin: binary(address), quote_asset: binary(sampleAddress(0)),
    trader: binary(sampleAddress(9201)), tx_from: binary(sampleAddress(9201)), tx_to: binary(sampleAddress(9202)), side: 1,
    amount_coin: '200', amount_quote: '1', price_quote: 1, usd: price == null ? null : price * 2, priced_block: price == null ? null : block, pricing_pending: pending });
  return txHash;
}
async function request(address: Address, tf: string, from: number, to: number) {
  const res = await built.app.inject(`/v1/coins/${address}/candles?tf=${tf}&from=${from}&to=${to}`);
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.tf).toBe(tf); expect(body.delayedSec).toBe(0);
  for (const bar of body.bars) expect(BarSchema.safeParse(bar).success).toBe(true);
  return body;
}

describe('served sub-minute candles from isolated database rows', () => {
  it('uses [from,to), UTC buckets, deterministic OHLC/volume and a row-pinned block without filling gaps', async () => {
    // Insert out of order; same-second trades are ordered by block then log identity.
    await swap(coin, epoch - 60, 4, 4, 1);
    await swap(coin, epoch - 61, 99, 1);
    await swap(coin, epoch - 60, 2, 2);
    await swap(coin, epoch - 60, 5, 4, 0);
    await swap(coin, epoch - 59, 1, 5);
    await swap(coin, epoch - 45, 3, 6);
    await swap(coin, epoch - 30, 88, 7); // exact exclusive end
    const before = JSON.stringify(built.ctx.chains.meter.usage());
    const second = await request(coin, '1s', epoch - 60, epoch - 30);
    expect(second.bars).toEqual([
      { ts: epoch - 60, o: 2, h: 5, l: 2, c: 4, vUsd: 22, trades: 3, marketCapUsd: 4000 },
      { ts: epoch - 59, o: 1, h: 1, l: 1, c: 1, vUsd: 2, trades: 1, marketCapUsd: 1000 },
      { ts: epoch - 45, o: 3, h: 3, l: 3, c: 3, vUsd: 6, trades: 1, marketCapUsd: 3000 },
    ]);
    expect(second.asOfBlock).toBe(6); expect(second.unavailable).toEqual([]);
    const fifteen = await request(coin, '15s', epoch - 60, epoch - 30);
    expect(fifteen.bars.map((b: { o: number; h: number; l: number; c: number; vUsd: number }) => [b.o, b.h, b.l, b.c, b.vUsd])).toEqual([[2, 5, 1, 1, 24], [3, 3, 3, 3, 6]]);
    expect(fifteen.asOfBlock).toBe(6);
    expect(JSON.stringify(built.ctx.chains.meter.usage())).toBe(before);
  });
  it('separates measured empty windows from absent raw history, archive-only minute bars and clipped-away intervals', async () => {
    const gap = await request(coin, '1s', epoch - 58, epoch - 46);
    expect(gap.bars).toEqual([]); expect(gap.unavailable).toEqual([]); expect(gap.asOfBlock).toBe(0);
    expect(gap.lastTradeTs).toBe(epoch - 30);
    const missing = sampleAddress(9101); await token(missing);
    await built.ctx.dbh.chain.sql.query('INSERT INTO bars_1m VALUES($1,$2,2,2,2,2,4,1,10,10)', [binary(missing), new Date((epoch - 60) * 1000)]);
    await swap(missing, epoch - 21601, 2, 10);
    for (const tf of ['1s', '15s']) {
      const absent = await request(missing, tf, epoch - 60, epoch);
      expect(absent.bars).toEqual([]); expect(absent.unavailable).toEqual(['subMinuteBars']); expect(absent.firstTradeTs).toBeNull(); expect(absent.lastTradeTs).toBeNull();
      const expired = await request(coin, tf, epoch - 30000, epoch - 21600);
      expect(expired.bars).toEqual([]); expect(expired.unavailable).toEqual(['subMinuteBars']);
    }
    const minute = await request(missing, '1m', epoch - 60, epoch);
    expect(minute.bars[0]).toMatchObject({ c: 2, vUsd: 4 }); expect(minute.asOfBlock).toBe(10);
    expect(minute.unavailable).toBeUndefined(); expect(minute.firstTradeTs).toBe(epoch - 21601);
  });
  it('clips both ends to six hours and bounds raw-history metadata queries', async () => {
    const clipped = sampleAddress(9102); await token(clipped);
    await swap(clipped, epoch - 21601, 99, 20);
    await swap(clipped, epoch - 21600, 2, 21);
    await swap(clipped, epoch - 21599, 3, 22);
    await swap(clipped, epoch, 99, 23);
    await swap(clipped, epoch + 1, 99, 24);
    const spy = vi.spyOn(built.ctx.dbh.chain.sql, 'query');
    try {
      for (const tf of ['1s', '15s']) {
        const body = await request(clipped, tf, epoch - 86400, epoch + 86400);
        expect(body.bars.map((b: { c: number }) => b.c)).toEqual(tf === '1s' ? [2, 3] : [3]);
        expect(body.bars[0].ts).toBe(epoch - 21600); expect(body.asOfBlock).toBe(22);
        expect(body.firstTradeTs).toBe(epoch - 21600); expect(body.lastTradeTs).toBe(epoch - 21599);
      }
      const queries = spy.mock.calls.filter(([sql]) => sql.includes('FROM raw_history_live_swaps'));
      expect(queries.length).toBeGreaterThan(0);
      for (const [sql, params] of queries) {
        expect(sql).toMatch(/ts >= to_timestamp\(\$2\)/); expect(sql).toMatch(/ts < to_timestamp\(\$3\)/);
        expect(params?.[1]).toBe(epoch - 21600); expect(params?.[2]).toBe(epoch);
      }
    } finally { spy.mockRestore(); }
  });
  it('marks missing USD prices or decimals unavailable instead of calling them zero-volume gaps', async () => {
    const unpriced = sampleAddress(9103); await token(unpriced);
    await swap(unpriced, epoch - 60, null, 30);
    for (const tf of ['1s', '15s']) {
      const body = await request(unpriced, tf, epoch - 60, epoch);
      expect(body.bars).toEqual([]); expect(body.unavailable).toEqual(['subMinuteBars']);
    }
    await swap(unpriced, epoch - 59, 2, 31);
    await swap(unpriced, epoch - 58, 50, 32, 0, true);
    const partial = await request(unpriced, '1s', epoch - 60, epoch);
    expect(partial.bars.map((b: { c: number }) => b.c)).toEqual([2]); expect(partial.unavailable).toEqual(['subMinuteBars']); expect(partial.asOfBlock).toBe(31);
    await built.ctx.dbh.chain.sql.query('UPDATE tokens SET decimals=NULL WHERE address=$1', [binary(unpriced)]);
    expect((await request(unpriced, '15s', epoch - 60, epoch)).bars).toEqual([]);
  });
  it('rejects invalid and oversized request ranges and unknown coins', async () => {
    for (const q of ['tf=1s&from=2&to=1', 'tf=15s&from=-1&to=1', 'tf=1s&from=0&to=40000000', 'tf=2s&from=1&to=2']) {
      expect((await built.app.inject(`/v1/coins/${coin}/candles?${q}`)).statusCode).toBe(422);
    }
    expect((await built.app.inject(`/v1/coins/${sampleAddress(9199)}/candles?tf=1s&from=1&to=2`)).statusCode).toBe(404);
  });
  it('serves incremental inserted swaps consistently with coin tick events, without rebuilding minute bars', async () => {
    class Socket extends EventEmitter {
      readyState = 1; bufferedAmount = 0; messages: unknown[] = [];
      send(raw: string) { this.messages.push(JSON.parse(raw)); }
      close() { this.emit('close'); }
    }
    const address = sampleAddress(9104); await token(address);
    const socket = new Socket(), hub = new Hub(), bus = new InProcessBus();
    hub.addV1(socket as unknown as WebSocket);
    socket.emit('message', JSON.stringify({ op: 'sub', ch: [`coin:${address}`] }));
    const live = new ReadLive(built.ctx.reads, hub); await live.start(bus);
    try {
      for (const [ts, price, block] of [[epoch - 14, 2, 40], [epoch - 13, 4, 41]]) {
        const txHash = await swap(address, ts, price, block);
        bus.publish({ topic: 'swap', ids: { txHash, logIndex: 0 } });
        bus.publish({ topic: 'swap', ids: { txHash, logIndex: 0 } });
        await live.drain(); await new Promise(resolve => setTimeout(resolve, 1100));
        const body = await request(address, '15s', epoch - 15, epoch);
        expect(body.asOfBlock).toBe(block); expect(body.bars[0].c).toBe(price);
        expect(body.bars[0].vUsd).toBe(block === 40 ? 4 : 12);
      }
      const ticks = socket.messages.map(m => WsServerSchema.parse(m)).filter(e => e.t === 'ev' && e.kind === 'tick');
      expect(ticks.map(e => e.t === 'ev' ? e.data : null)).toEqual([
        { ts: epoch - 14, price: 2, volumeUsd: 4, block: 40 }, { ts: epoch - 13, price: 4, volumeUsd: 8, block: 41 },
      ]);
      expect((await request(address, '1s', epoch - 15, epoch)).bars).toHaveLength(2);
    } finally { await live.close(); hub.closeAll(); }
  });
});
