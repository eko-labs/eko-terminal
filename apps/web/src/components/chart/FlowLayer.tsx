import { memo, useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { Address, ChartMarker, WalletLabel } from '@eko/shared';
import { IconFlame } from '../icons';
import { WALLET_LABEL_WORD } from '../ui';
import { api } from '../../lib/api';
import type { ChartCore } from './chartCore';
import { anchorTime } from './coinMath';
import { burnLabel, clusterMarkers, markerId, markerName, markerSize } from './markerMath';
export function Glyph({label,size=10}:{label:WalletLabel;size?:number}){
 return <svg width={size} height={size} viewBox="0 0 10 10" aria-hidden="true">{label==='declared_agent'?<g fill="var(--l-agent)"><rect x="1" y="2" width="8" height="7" rx="1.2"/><rect x="4.5" width="1" height="2"/></g>:label==='likely_agent'?<rect x="1.5" y="2.5" width="7" height="6" rx="1.2" fill="none" stroke="var(--l-likely)" strokeWidth="1.3"/>:label==='crew'?<g fill="none" stroke="var(--l-crew)" strokeWidth="1.3"><circle cx="3.4" cy="5" r="2.4"/><circle cx="6.6" cy="5" r="2.4"/></g>:<circle cx="5" cy="5" r="2.6" fill="var(--l-human)"/>}</svg>;
}
export const FlowLayer=memo(function FlowLayer(p:{core:ChartCore;markers:ChartMarker[];show:Record<WalletLabel,boolean>;ownToken?:boolean;burnWallet?:Address;launchTs?:number;crewsEnabled?:boolean}){
 const overlay=useRef<HTMLDivElement>(null),els=useRef(new Map<string,HTMLButtonElement>()), tip=useRef<HTMLDivElement>(null),frame=useRef(0),picked=useRef<ChartMarker|null>(null),[pick,setPick]=useState<ChartMarker|null>(null),[followed,setFollowed]=useState(false),[error,setError]=useState('');
 picked.current=pick;
 const sync=useCallback(()=>{if(frame.current)return;frame.current=requestAnimationFrame(()=>{frame.current=0;const core=p.core;
   const positions=p.markers.flatMap(marker=>{const key=markerId(marker),el=els.current.get(key),t=anchorTime(marker.ts,core.tf),i=core.indexAtOrBefore(t),bar=core.data[i],x=core.xForTime(t);if(!bar||bar.ts!==t||x===null||!p.show[marker.label]){if(el)el.hidden=true;return [];}const y=(core.yForPrice(marker.side==='buy'?bar.l:bar.h)??-100)+(marker.side==='buy'?16:-16);const visible=x>=core.L+6&&x<=core.L+core.paneWidth()-6&&y>=core.T-10&&y<=core.mainPaneHeight()+10;if(el)el.hidden=!visible;return visible?[{marker,x,y}]:[];});
   for(const c of clusterMarkers(positions))for(const item of c.items){const el=els.current.get(markerId(item.marker));if(!el)continue;el.style.transform=`translate3d(${item.x-12}px,${item.y-12}px,0)`;el.dataset.x=String(item.x);el.dataset.anchor=String(anchorTime(item.marker.ts,core.tf));el.dataset.clustered=String(item!==c.items[0]);const count=el.querySelector('.fcount');if(count)count.textContent=item===c.items[0]&&c.items.length>1?`×${c.items.length}`:'';}
   if(picked.current&&tip.current){const pos=positions.find(x=>markerId(x.marker)===markerId(picked.current!));tip.current.hidden=!pos;if(pos){tip.current.style.left=`${Math.max(8,Math.min(core.L+core.paneWidth()-224,pos.x-110))}px`;tip.current.style.top=`${Math.max(62,Math.min(core.mainPaneHeight()-156,pos.y+24))}px`;}}
 });},[p.core,p.markers,p.show]);
 useLayoutEffect(()=>{const el=overlay.current!;const stop=(e:WheelEvent)=>{e.preventDefault();e.stopPropagation();};el.addEventListener('wheel',stop,{passive:false});return()=>el.removeEventListener('wheel',stop);},[]);
 useLayoutEffect(()=>{sync();const off=p.core.onRedraw(sync);return()=>{off();cancelAnimationFrame(frame.current);frame.current=0;};},[p.core,sync]);
 useLayoutEffect(()=>{sync();},[pick,sync]);
 const select=(m:ChartMarker)=>{setPick(m);setFollowed(false);setError('');};
 const burn=pick&&burnLabel(pick,!!p.ownToken,p.burnWallet,p.launchTs);
 return <><div ref={overlay} className="flow-layer" aria-label="Agent and crew trades on chart" onWheel={e=>e.stopPropagation()} onPointerDown={e=>e.stopPropagation()}>
  {p.markers.map(m=><button type="button" hidden={!p.show[m.label]} ref={el=>{if(el)els.current.set(markerId(m),el);else els.current.delete(markerId(m));}} key={markerId(m)} className={`fmark ${m.side}`} aria-label={markerName(m,burnLabel(m,!!p.ownToken,p.burnWallet,p.launchTs))} aria-expanded={pick===m} onFocus={()=>select(m)} onPointerEnter={()=>select(m)} onClick={()=>select(m)} onKeyDown={e=>{if(e.key==='Escape')setPick(null);}}>
   <span className="fmark-content">{burnLabel(m,!!p.ownToken,p.burnWallet,p.launchTs)?<IconFlame/>:<Glyph label={m.label} size={markerSize(m.sizeUsd)}/>}<span className="fcount"/></span></button>)}
 </div>{pick&&<div ref={tip} className="tip coin-tip" onWheel={e=>e.stopPropagation()} onPointerDown={e=>e.stopPropagation()}>
  <button className="iconbtn tip-close" aria-label="Close trade details" onClick={()=>setPick(null)}>×</button><b>{burn||WALLET_LABEL_WORD[pick.label]} {pick.side}</b><p>${pick.sizeUsd.toLocaleString('en-US')} · {Math.round(pick.confidence*100)}% confidence</p><p className="num">{new Date(pick.ts*1000).toISOString().slice(11,19)} UTC</p><p className="addr">{pick.wallet}</p>{pick.crewId&&<p>{p.crewsEnabled?<a href={`/crews/${encodeURIComponent(pick.crewId)}`}>{pick.crewId}</a>:pick.crewId}</p>}
  <button className="btn btn-sm" disabled={followed} onClick={()=>void api('/watch',{body:{kind:'wallet',target:pick.wallet}}).then(()=>setFollowed(true)).catch(()=>setError('Could not follow wallet. Try again.'))}>{followed?'Following wallet':'Follow wallet'}</button>{error&&<p role="status">{error}</p>}
 </div>}</>;
});
