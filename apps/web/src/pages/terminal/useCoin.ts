import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { BarSchema, ChartMarkerSchema, CoinCardSchema, VerdictSchema, FlowSchema, type Bar, type ChartMarker, type CoinCard, type Verdict, type Address, type Flow } from '@eko/shared';
import { fetchParsed, isRateLimited, ApiError, MOCKS } from '../../lib/api';
import { useRealtime } from '../../lib/RealtimeContext';
import { aggregateTick, reconcileCandleTicks, bucketStart, seconds, type CoinTimeframe } from '../../components/chart/coinMath';
import { markerId } from '../../components/chart/markerMath';
export const CandlesSchema=z.object({tf:z.string(),bars:z.array(BarSchema),asOfBlock:z.number(),firstTradeTs:z.number().nullable().optional(),lastTradeTs:z.number().nullable().optional(),unavailable:z.array(z.string()).optional()});
export const MarkersSchema=z.object({markers:z.array(ChartMarkerSchema).optional(),rows:z.array(ChartMarkerSchema).optional(),unavailable:z.array(z.string()).optional()}).transform(v=>({...v,markers:v.rows ?? v.markers ?? []}));
export function mergeMarkers(old:ChartMarker[],next:ChartMarker[]){return [...new Map([...old,...next].map(m=>[markerId(m),m])).values()].slice(-2000);}
export function useCoin(address:string,tf:CoinTimeframe,fullHistory=false){
 const rt=useRealtime(),[card,setCard]=useState<CoinCard|null>(null),[verdict,setVerdict]=useState<Verdict|null>(null),[bars,setBars]=useState<Bar[]>([]),[markers,setMarkers]=useState<ChartMarker[]>([]),[flows,setFlows]=useState<Flow[]>([]),[error,setError]=useState(''),[unknown,setUnknown]=useState(false),[retry,setRetry]=useState(0),[freshAt,setFreshAt]=useState(Date.now()),[now,setNow]=useState(Date.now());
 const [candlesLoading,setCandlesLoading]=useState(true),[lastTradeTs,setLastTradeTs]=useState<number|null>(null),[firstTradeTs,setFirstTradeTs]=useState<number|null>(null),[labelsUnavailable,setLabelsUnavailable]=useState(!MOCKS),[candlesUnavailable,setCandlesUnavailable]=useState(false);
 const generation=useRef(0);
 const fail=useCallback((e:unknown)=>{if((e as Error).name==='AbortError'||isRateLimited(e))return;if(e instanceof ApiError&&e.status===404){setUnknown(true);setError(e.message);}else setError((e as Error).message);},[]);
 useEffect(()=>{const t=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(t);},[]);
 useEffect(()=>{const ac=new AbortController(),opts={signal:ac.signal},base=`/coins/${encodeURIComponent(address)}`;setError('');setUnknown(false);
 // Separate promises let the smaller verdict render before the full card.
 void fetchParsed(`${base}/verdict`,VerdictSchema,opts).then(setVerdict).catch(fail);
 void fetchParsed(base,CoinCardSchema,opts).then(c=>{setCard(c);setFreshAt(Date.now()-c.freshness.ageSec*1000);}).catch(fail);
 void Promise.all(['5m','1h','24h'].map(w=>fetchParsed(`${base}/flow?window=${w}`,FlowSchema,opts))).then(setFlows).catch(fail);
 return()=>ac.abort();},[address,retry,fail]);
 useEffect(()=>{const ac=new AbortController(),gen=++generation.current;const restTf=tf==='30m'?'15m':tf;let snapshotFlight:Promise<void>|undefined;let syncing=false;let buffered:Parameters<typeof aggregateTick>[1][]=[];let flowBuffer:ChartMarker[]=[];setCandlesLoading(true);
 const loadSnapshot=async()=>{syncing=true;buffered=[];flowBuffer=[];const to=Math.floor(Date.now()/1000),from=fullHistory ? Math.max(0,Math.floor((firstTradeTs ?? to-365*86400)/60)*60) : bucketStart(to,tf)-seconds(tf)*72,base=`/coins/${encodeURIComponent(address)}`;
 try{const [candles,ms,v,c]=await Promise.all([fetchParsed(`${base}/candles?tf=${restTf}&from=${from}&to=${to}`,CandlesSchema,{signal:ac.signal}),fetchParsed(`${base}/markers?from=${from}&to=${to}`,MarkersSchema,{signal:ac.signal}),fetchParsed(`${base}/verdict`,VerdictSchema,{signal:ac.signal}),fetchParsed(base,CoinCardSchema,{signal:ac.signal})]);
 if(ac.signal.aborted||generation.current!==gen)return;const data=reconcileCandleTicks(candles.bars,buffered,to,tf);setBars(data);setCandlesUnavailable(!!candles.unavailable?.length);setLastTradeTs(candles.lastTradeTs ?? null);setFirstTradeTs(candles.firstTradeTs ?? null);setLabelsUnavailable(!!ms.unavailable?.includes("labels"));setCandlesLoading(false);setMarkers(mergeMarkers(ms.markers,flowBuffer));setVerdict(v);setCard(c);setFreshAt(Date.now()-c.freshness.ageSec*1000);setError('');
 }catch(e){fail(e);}finally{syncing=false;}};
 const snapshot=()=>snapshotFlight??(snapshotFlight=loadSnapshot().finally(()=>{snapshotFlight=undefined;}));
 // Initial chart/markers load is separate from the fast verdict/card above.
 const initial=async()=>{const to=Math.floor(Date.now()/1000),from=fullHistory ? Math.max(0,Math.floor((firstTradeTs ?? to-365*86400)/60)*60) : bucketStart(to,tf)-seconds(tf)*72;syncing=true;try{const [cs,ms]=await Promise.all([fetchParsed(`/coins/${address}/candles?tf=${restTf}&from=${from}&to=${to}`,CandlesSchema,{signal:ac.signal}),fetchParsed(`/coins/${address}/markers?from=${from}&to=${to}`,MarkersSchema,{signal:ac.signal})]);if(ac.signal.aborted)return;const data=reconcileCandleTicks(cs.bars,buffered,to,tf);setBars(data);setCandlesUnavailable(!!cs.unavailable?.length);setLastTradeTs(cs.lastTradeTs ?? null);setFirstTradeTs(cs.firstTradeTs ?? null);setLabelsUnavailable(!!ms.unavailable?.includes("labels"));setCandlesLoading(false);setMarkers(mergeMarkers(ms.markers,flowBuffer));}catch(e){fail(e);}finally{syncing=false;}};
 void initial();
 const offCoin=rt?.subscribe<'coin'>(`coin:${address as Address}`,e=>{if(ac.signal.aborted)return;if(e.kind==='tick'){if(syncing)buffered.push(e.data);else setBars(b=>aggregateTick(b,e.data,tf));}else if(e.kind==='card'){setCard(e.data);setFreshAt(Date.now()-e.data.freshness.ageSec*1000);}else {setVerdict(e.data);if(e.data.lastChecked)setFreshAt(Date.parse(e.data.lastChecked.at));}},snapshot);
 const offFlow=rt?.subscribe<'flow'>(`flow:${address as Address}`,e=>{if(ac.signal.aborted)return;if(e.kind==='marker'){if(syncing)flowBuffer.push(e.data);else setMarkers(m=>mergeMarkers(m,[e.data]));}else setFlows(f=>[...f.filter(x=>x.window!==e.data.window),e.data]);},snapshot);
 return()=>{ac.abort();offCoin?.();offFlow?.();};},[address,tf,retry,rt,fail,fullHistory]);
 return {candlesUnavailable,candlesLoading,lastTradeTs,labelsUnavailable,card,verdict,bars,markers,flows,error,unknown,ageSec:Math.max(0,Math.floor((now-freshAt)/1000)),retry:()=>setRetry(n=>n+1)};
}
