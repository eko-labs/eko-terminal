import { describe, expect, it } from 'vitest';
import { aggregateTick, reconcileCandleTicks, barsForTimeframe, anchorTime, bucketStart, candleWidth, COIN_TIMEFRAMES, panView, seconds, slotWidth, stretchScale, zoomView } from './coinMath';
import { burnLabel, clusterMarkers, markerName, markerSize } from './markerMath';
import type { Address, ChartMarker } from '@eko/shared';
const marker=(over:Partial<ChartMarker>={}):ChartMarker=>({ts:Date.parse('2026-10-01T12:03:41Z')/1000,side:'buy',sizeUsd:1240,label:'declared_agent',confidence:.91,wallet:'0xabcdef1234567890abcdef1234567890abcdefcd',...over});
describe('coin chart math',()=>{
 it.each(['1s','15s'] as const)('reconciles %s snapshots and incremental ticks at the REST exclusive end without filling gaps',tf=>{
   const initial=[{ts:120,o:2,h:2,l:2,c:2,vUsd:4}];
   const bars=reconcileCandleTicks(initial,[{ts:119,price:99,volumeUsd:100,block:1},{ts:122,price:1,volumeUsd:2,block:4},{ts:121,price:5,volumeUsd:10,block:3}],121,tf);
   expect(bars).toEqual(tf==='1s' ? [...initial,{ts:121,o:5,h:5,l:5,c:5,vUsd:10},{ts:122,o:1,h:1,l:1,c:1,vUsd:2}] : [{ts:120,o:2,h:5,l:1,c:1,vUsd:16}]);
   const next=aggregateTick(bars,{ts:165,price:3,volumeUsd:6,block:5},tf);
   expect(next).toHaveLength(bars.length+1);expect(next.at(-1)).toEqual({ts:165,o:3,h:3,l:3,c:3,vUsd:6});
   expect(initial[0]).toEqual({ts:120,o:2,h:2,l:2,c:2,vUsd:4});
 });
 it('anchors each interval to its UTC bucket, including 1s and 15s',()=>{for(const tf of COIN_TIMEFRAMES){const step=seconds(tf);expect(bucketStart(100001.9,tf)).toBe(Math.floor(100001.9/step)*step);expect(anchorTime(100001.9,tf)).toBe(bucketStart(100001.9,tf));expect(bucketStart(step,tf)).toBe(step);expect(bucketStart(step-0.01,tf)).toBe(0);}});
 it('derives the prototype 30m interval from 15m OHLCV bars without changing its UTC anchor',()=>{
   const bars=[{ts:1800,o:2,h:5,l:1,c:4,vUsd:10},{ts:2700,o:4,h:6,l:3,c:5,vUsd:20},{ts:3600,o:5,h:7,l:4,c:6,vUsd:30}];
   expect(bucketStart(3599,'30m')).toBe(1800);expect(anchorTime(3600,'30m')).toBe(3600);
   expect(barsForTimeframe(bars,'30m')).toEqual([{ts:1800,o:2,h:6,l:1,c:5,vUsd:30},{ts:3600,o:5,h:7,l:4,c:6,vUsd:30}]);
   expect(bars[0].c).toBe(4);expect(barsForTimeframe(bars,'15m')).toBe(bars);
 });
 it('keeps the point under the pointer fixed at three zooms',()=>{const v={s:0,e:72};for(const factor of [.5,.8,1.25])for(const f of [.1,.5,.9]){const at=v.s+f*(v.e-v.s),next=zoomView(v,factor,f);expect((at-next.s)/(next.e-next.s)).toBeCloseTo(f,12);expect(candleWidth(slotWidth(960,next))/slotWidth(960,next)).toBeCloseTo(.72);}});
 it('pans by slot units at every zoom',()=>{for(const span of [12,36,72]){const v={s:10,e:10+span},next=panView(v,80,800);expect(next.e-next.s).toBeCloseTo(span);expect(next.s).toBeCloseTo(10-span*.1);}});
 it('stretches the price range exponentially with bounded wheel/drag scale',()=>{expect(stretchScale(1,100)).toBeCloseTo(Math.exp(.2));expect(stretchScale(stretchScale(1,100),-100)).toBeCloseTo(1);expect(stretchScale(1,-100000)).toBe(.25);expect(stretchScale(1,100000)).toBe(6);});
 it('aggregates live OHLC/volume and ignores ticks older than the last bucket',()=>{let bars=aggregateTick([],{ts:120,price:10,volumeUsd:20,block:1},'1m');bars=aggregateTick(bars,{ts:130,price:12,volumeUsd:30,block:2},'1m');bars=aggregateTick(bars,{ts:140,price:9,volumeUsd:10,block:3},'1m');expect(bars).toEqual([{ts:120,o:10,h:12,l:9,c:9,vUsd:60}]);expect(aggregateTick(bars,{ts:110,price:1,volumeUsd:10,block:1},'1m')).toEqual(bars);expect(aggregateTick(bars,{ts:180,price:11,volumeUsd:5,block:4},'1m').at(-1)).toEqual({ts:180,o:11,h:11,l:11,c:11,vUsd:5});});
});
describe('flow markers',()=>{
 it('clusters greedily by declared, crew, likely, human then size and recency',()=>{const items=[marker({label:'human',sizeUsd:9000}),marker({label:'likely_agent'}),marker({label:'crew'}),marker({sizeUsd:50}),marker({sizeUsd:2000})].map((m,i)=>({marker:m,x:100+i,y:100}));const clusters=clusterMarkers(items);expect(clusters).toHaveLength(1);expect(clusters[0].marker.sizeUsd).toBe(2000);expect(clusters[0].items).toHaveLength(5);expect(clusterMarkers([{marker:marker(),x:0,y:0},{marker:marker(),x:15,y:0},{marker:marker(),x:0,y:20}])).toHaveLength(3);});
 it('uses three glyph sizes and complete accessible names',()=>{expect([99,100,999,1000].map(markerSize)).toEqual([8,10,10,12]);expect(markerName(marker())).toBe('Declared agent buy, $1,240, 12:03:41, wallet 0xabcd…efcd.');for(const label of ['declared_agent','likely_agent','crew','human'] as const)expect(markerName(marker({label,side:'sell'}))).toContain('sell, $1,240, 12:03:41, wallet');});
 it('requires both own-token identity and the public burn wallet for flames',()=>{const m=marker(),wallet=m.wallet as Address;expect(burnLabel(m,false,wallet)).toBeUndefined();expect(burnLabel(marker({side:'sell'}),true,wallet)).toBeUndefined();expect(burnLabel(m,true,'0x1111111111111111111111111111111111111111')).toBeUndefined();expect(burnLabel(m,true,wallet)).toBe('Daily burn');expect(burnLabel(m,true,wallet,m.ts)).toBe('Launch burn');});
 it('handles 2,000 markers without dropping their keyboard identities',()=>{const positions=Array.from({length:2000},(_,i)=>({marker:marker({ts:i}),x:i%1000,y:Math.floor(i/1000)*30}));expect(clusterMarkers(positions).reduce((n,c)=>n+c.items.length,0)).toBe(2000);});
});
