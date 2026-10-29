import { afterEach, describe, expect, it, vi } from 'vitest';
import { BarSchema, ChartMarkerSchema, CoinCardSchema, VerdictSchema, WsServerSchema, type WsServer } from '@eko/shared';
import { z } from 'zod';
import { createApi } from '../../lib/api';
import { createMockTransport } from '../transport';
import { MockChannelSocket } from '../socket';
import { createRadarRows } from './radar';
import { coinCandles, coinMarkers, coinTick, UNKNOWN_COIN, COIN_EPOCH } from './coin';
import { COIN_TIMEFRAMES } from '../../components/chart/coinMath';
import { CandlesSchema, MarkersSchema } from '../../pages/terminal/useCoin';
afterEach(()=>vi.useRealTimers());
describe('coin demo',()=>{
 it('ports prototype candles deterministically for every coin and timeframe',()=>{for(const row of createRadarRows())for(const tf of COIN_TIMEFRAMES){const bars=coinCandles(row.address,tf);expect(bars).toHaveLength(72);expect(coinCandles(row.address,tf)).toEqual(bars);for(const bar of bars)expect(BarSchema.parse(bar)).toEqual(bar);expect(bars.every(b=>b.h>=Math.max(b.o,b.c)&&b.l<=Math.min(b.o,b.c))).toBe(true);}});
 it('covers every label and size and responds by requested resource',async()=>{const api=createApi('/v1',createMockTransport()),address=createRadarRows()[0].address,ms=coinMarkers(address);expect(new Set(ms.map(m=>m.label)).size).toBe(4);expect(new Set(ms.map(m=>m.sizeUsd<100?0:m.sizeUsd<1000?1:2)).size).toBe(3);ms.forEach(m=>ChartMarkerSchema.parse(m));expect((await api.parse(`/coins/${address}`,CoinCardSchema)).identity.address).toBe(address);expect((await api.parse(`/coins/${address}/verdict`,VerdictSchema)).coin).toBe(address);expect((await api.parse(`/coins/${address}/candles?tf=15s&from=0&to=${COIN_EPOCH}`,CandlesSchema)).tf).toBe('15s');expect((await api.parse(`/coins/${address}/markers`,MarkersSchema)).markers).toEqual(ms);for(const w of ['5m','1h','24h'])expect((await api.parse(`/coins/${address}/flow?window=${w}`,z.object({window:z.string()}))).window).toBe(w);await expect(api.request(`/coins/${UNKNOWN_COIN}/verdict`)).rejects.toMatchObject({status:404});});
 it('streams valid deterministic ticks about every 2s and stops delivering after unsubscribe',()=>{vi.useFakeTimers();const socket=new MockChannelSocket(),events:WsServer[]=[],address=createRadarRows()[0].address;socket.on(e=>events.push(WsServerSchema.parse(e)));socket.connect();socket.send({op:'sub',ch:[`coin:${address}`,`flow:${address}`]});const ticks=()=>events.filter(e=>e.t==='ev'&&e.kind==='tick');vi.advanceTimersByTime(1999);expect(ticks()).toHaveLength(0);vi.advanceTimersByTime(1);expect(ticks()).toHaveLength(1);vi.advanceTimersByTime(2000);expect(ticks()).toHaveLength(2);expect(coinTick(address,3)).toEqual(coinTick(address,3));socket.send({op:'unsub',ch:[`coin:${address}`,`flow:${address}`]});vi.advanceTimersByTime(2000);expect(ticks()).toHaveLength(2);socket.close();});
});
