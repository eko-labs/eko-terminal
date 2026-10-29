import type { Address, Bar, ChartMarker, Tick, WalletLabel } from '@eko/shared';
import { aggregateTick, bucketStart, seconds, type CoinTimeframe } from '../../components/chart/coinMath';
import profiles from './coin-profiles.json';
import { createRadarCard, createRadarRows } from './radar';
import { MOCK_HEAD_BLOCK } from '../head';
export const UNKNOWN_COIN='0x1111111111111111111111111111111111111111';
export const COIN_EPOCH=Math.floor(Date.now()/1000);
const liveTicks=new Map<string,Tick[]>();
export function recordCoinTick(address:string,tick:Tick){const key=address.toLowerCase();liveTicks.set(key,[...(liveTicks.get(key)??[]),tick].slice(-10800));}
const labels:WalletLabel[]=['declared_agent','likely_agent','crew','human'];
const labelMap={agent:'declared_agent',likely:'likely_agent',crew:'crew',human:'human'} as const;
export function coinCandles(address:string,tf:CoinTimeframe,now=COIN_EPOCH):Bar[]{
 const p=profiles.find(c=>c.address.toLowerCase()===address.toLowerCase());if(!p)return [];
 const end=bucketStart(now,tf), step=seconds(tf);
 return p.candles.map((c,i)=>({o:c.o,h:c.h,l:c.l,c:c.c,ts:end-(p.candles.length-1-i)*step,vUsd:c.v*10000}));
}
export function coinMarkers(address:string,from=COIN_EPOCH-72*300,to=COIN_EPOCH):ChartMarker[]{
 const p=profiles.find(c=>c.address.toLowerCase()===address.toLowerCase());if(!p)return [];
 const slot=(to-from)/72;
 const markers:ChartMarker[]=p.markers.map(m=>({ts:Math.floor(from+(m.i+.5)*slot),side:m.side as 'buy'|'sell',sizeUsd:m.usd,label:labelMap[m.label as keyof typeof labelMap],confidence:m.label==='agent'?1:.86,wallet:m.wallet as Address,...(m.label==='crew'?{crewId:'demo-crew'}:{})}));
 // Explicit adjacent fixtures exercise each label, all sizes, and clustering at every timeframe.
 for(let i=0;i<12;i++)markers.push({ts:Math.floor(from+(56+Math.floor(i/4)) *slot),side:'buy',sizeUsd:[40,240,1240][i%3],label:labels[i%4],confidence:.86,wallet:`0x${(i+1).toString(16).padStart(40,'0')}`});
 return markers.filter(m=>m.ts>=from&&m.ts<=to);
}
export function coinTick(address:string,step:number,ts=COIN_EPOCH+step*2):Tick|undefined {
 const p=profiles.find(c=>c.address.toLowerCase()===address.toLowerCase());if(!p)return;
 return {ts,price:p.candles.at(-1)!.c*(1+Math.sin(step*.7)*.004),volumeUsd:40+(step%3)*100,block:MOCK_HEAD_BLOCK+step};
}
export function coinResponse(address:string,child:string|undefined,query:URLSearchParams):unknown|undefined {
 const card=createRadarCard(address);if(!card)return;
 if(!child)return card;
 if(child==='verdict')return card.verdict;
 if(child==='candles'){const tf=(query.get('tf')??'5m') as CoinTimeframe;let bars=coinCandles(address,tf);for(const tick of liveTicks.get(address.toLowerCase())??[])if(tick.ts<=Number(query.get('to')??Infinity))bars=aggregateTick(bars,tick,tf);return {tf,bars:bars.filter(b=>b.ts>=Number(query.get('from')??0)&&b.ts<=Number(query.get('to')??Infinity)),asOfBlock:MOCK_HEAD_BLOCK};}
 if(child==='markers')return {markers:coinMarkers(address,Number(query.get('from')??COIN_EPOCH-72*300),Number(query.get('to')??COIN_EPOCH))};
 if(child==='flow'){const window=(query.get('window')??'1h') as '5m'|'1h'|'24h';return {...card.flow,window};}
}
export const coinAddresses=()=>createRadarRows().map(c=>c.address);
