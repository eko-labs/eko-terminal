import { useUi } from '../../store/ui';
import { WALLET_LABELS_LATER } from '../../copy/availability';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Address, Bar, ChartMarker, WalletLabel } from '@eko/shared';
import { Seg, WALLET_LABEL_WORD } from '../ui';
import { formatCoinPrice, formatCompactUsd } from '../../lib/format';
import { TimeframeControls } from './TimeframeControls';
import { ChartCore, EMA_COLORS, type ChartOptions } from './chartCore';
import { COIN_TIMEFRAMES, type CoinTimeframe, type View } from './coinMath';
import { FlowLayer, Glyph } from './FlowLayer';
type Saved = ChartOptions & { mode: 'Line' | 'Candles' };
const SAVED_KEY = 'eko.chart.v1', DEFAULTS: Saved = { mode: 'Line', volume: true, log: false, ema: [] };
/** The viewer's chart settings, kept in this browser only (a private window starts from the defaults). */
function loadSaved(): Saved { try { const v = JSON.parse(localStorage.getItem(SAVED_KEY) ?? 'null') as Partial<Saved> | null; return { ...DEFAULTS, ...(v ?? {}), ema: Array.isArray(v?.ema) ? v.ema.filter(n => n in EMA_COLORS) : [] }; } catch { return DEFAULTS; } }
function save(v: Saved) { try { localStorage.setItem(SAVED_KEY, JSON.stringify(v)); } catch { /* not kept: the chart still works */ } }
export function ChartStage(p:{market:string;timeframe:CoinTimeframe;onTimeframe:(tf:CoinTimeframe)=>void;bars:Bar[];markers:ChartMarker[];supply:number;verdict:ReactNode;delayedSec?:number;ownToken?:boolean;burnWallet?:Address;launchTs?:number;crewsEnabled?:boolean;labelsUnavailable?:boolean}){
 const humanMarkers=useUi(s=>s.humanMarkers);
 const readout=useRef<HTMLSpanElement>(null),plot=useRef<HTMLDivElement>(null),surface=useRef<HTMLDivElement>(null),scale=useRef<HTMLDivElement>(null),[core,setCore]=useState<ChartCore|null>(null),[saved,setSaved]=useState<Saved>(loadSaved),mode=saved.mode,setMode=(m:'Line'|'Candles')=>update({mode:m}),[axis,setAxis]=useState('Price'),[show,setShow]=useState<Record<WalletLabel,boolean>>({declared_agent:true,likely_agent:true,crew:true,human:humanMarkers});
 useEffect(()=>setShow(s=>({...s,human:humanMarkers})),[humanMarkers]);
 function update(next:Partial<Saved>){setSaved(v=>{const merged={...v,...next};save(merged);return merged;});}
 const toggleEma=(n:number)=>update({ema:saved.ema.includes(n)?saved.ema.filter(x=>x!==n):[...saved.ema,n].sort((a,b)=>a-b)});
 const drag=useRef<{x:number;y:number;view:View;k:number;shift:number;kind:'plot'|'scale'}|null>(null),pointers=useRef(new Map<number,{x:number;y:number}>()),pinch=useRef<number|null>(null),lastTf=useRef<CoinTimeframe|null>(null);
 useLayoutEffect(()=>{const c=new ChartCore(plot.current!);setCore(c);if(import.meta.env.DEV)(plot.current as HTMLDivElement & { __ekoChartCore?:ChartCore }).__ekoChartCore=c;return()=>c.destroy();},[p.market]);
 useLayoutEffect(()=>{if(!core)return;const changed=lastTf.current!==p.timeframe;core.setData(p.bars,p.timeframe,!changed);if(changed&&p.bars.length)core.animate();if(p.bars.length)lastTf.current=p.timeframe;},[core,p.bars,p.timeframe]);
 useLayoutEffect(()=>{if(core){core.setMode(mode);core.setOptions({volume:saved.volume,log:saved.log,ema:saved.ema});core.axisSupply=axis==='Price'?1:p.supply;core.scheduleRedraw();}},[core,mode,saved.volume,saved.log,saved.ema,axis,p.supply]);
 useLayoutEffect(()=>{if(!core)return;const sync=()=>{const b=core.data[core.hoverIndex]??core.data.at(-1);if(!b||!readout.current)return;const fmt=(v:number)=>axis==='Price'?formatCoinPrice(v):formatCompactUsd(v*p.supply);readout.current.textContent=`O ${fmt(b.o)} H ${fmt(b.h)} L ${fmt(b.l)} C ${fmt(b.c)} · Vol ${formatCompactUsd(b.vUsd)}`;};sync();return core.onRedraw(sync);},[core,axis,p.supply]);
 useEffect(()=>{if(!core)return;const el=surface.current!,sc=scale.current!;
 const wheel=(e:WheelEvent)=>{e.preventDefault();const x=e.clientX-plot.current!.getBoundingClientRect().left;if(Math.abs(e.deltaX)>Math.abs(e.deltaY)&&!e.ctrlKey)core.pan(-e.deltaX);else core.zoom(Math.exp(e.deltaY*(e.ctrlKey?.01:.0018)),x);};
 const stretch=(e:WheelEvent)=>{e.preventDefault();core.stretch(e.deltaY);};el.addEventListener('wheel',wheel,{passive:false});sc.addEventListener('wheel',stretch,{passive:false});return()=>{el.removeEventListener('wheel',wheel);sc.removeEventListener('wheel',stretch);};},[core]);
 const settingsMenu=<details className="cc-settings" onKeyDown={e=>{if(e.key==='Escape'){e.preventDefault();(e.currentTarget as HTMLDetailsElement).open=false;}}}><summary aria-label="Chart settings">Settings</summary><div className="cc-settings-menu" role="group" aria-label="Chart settings">
  <label className="check"><input type="checkbox" checked={saved.volume} onChange={e=>update({volume:e.target.checked})}/>Volume</label>
  <label className="check"><input type="checkbox" checked={saved.log} onChange={e=>update({log:e.target.checked})}/>Log scale</label>
  <hr/>{[9,21,50].map(n=><label className="check" key={n}><input type="checkbox" checked={saved.ema.includes(n)} onChange={()=>toggleEma(n)}/><span className="cc-swatch" style={{background:EMA_COLORS[n]}}/>EMA {n}</label>)}
  <hr/><button type="button" className="btn btn-sm btn-ghost" onClick={()=>core?.autoScale()}>Auto-fit price</button>
 </div></details>;
 const up=(id:number)=>{pointers.current.delete(id);pinch.current=null;drag.current=null;};
 return <div className="cchart">
 <div className="chart-top" role="toolbar" aria-label="Chart controls"><div className="chart-read">{p.verdict}<span className="num coin-ohlc" ref={readout} aria-hidden="true"/>{!!p.delayedSec&&<span className="tag">Delayed ~{p.delayedSec} s</span>}</div><div className="chart-ctl"><Seg options={['Line','Candles']} value={mode} onChange={v=>setMode(v as typeof mode)} label="Chart type"/><TimeframeControls value={p.timeframe} onChange={p.onTimeframe}/><Seg options={['Price','FDV']} value={axis} onChange={setAxis} label="Axis"/>
 {settingsMenu}</div></div>
 <div className="plate coin-chart" ref={plot} data-timeframe={p.timeframe}>
 <div ref={surface} className="cc-surface" tabIndex={0} role="application" aria-roledescription="chart" aria-label={`${p.market} price chart. Plus and minus zoom, arrow keys move, 0 resets. Keys 1 to 9 select timeframe.`}
 onKeyDown={e=>{if(!core||e.target!==e.currentTarget)return;const key=e.key;if(key==='+'||key==='=')core.zoom(.8);else if(key==='-'||key==='_')core.zoom(1.25);else if(key==='0')core.reset();else if(key==='ArrowLeft'||key==='ArrowRight')core.pan((key==='ArrowLeft'?1:-1)*core.paneWidth()*.1);else if(/^[1-9]$/.test(key))p.onTimeframe(COIN_TIMEFRAMES[Number(key)-1]);else return;e.preventDefault();e.stopPropagation();}}
 onPointerDown={e=>{if(!core)return;e.currentTarget.setPointerCapture(e.pointerId);pointers.current.set(e.pointerId,{x:e.clientX,y:e.clientY});drag.current={x:e.clientX,y:e.clientY,view:{...core.view},k:core.scale,shift:core.shift,kind:'plot'};}}
 onPointerMove={e=>{if(!core)return;const box=plot.current!.getBoundingClientRect();if(!pointers.current.has(e.pointerId)){core.hoverAt(e.clientX-box.left,e.clientY-box.top);return;}pointers.current.set(e.pointerId,{x:e.clientX,y:e.clientY});const pts=[...pointers.current.values()];if(pts.length===2){const distance=Math.hypot(pts[0].x-pts[1].x,pts[0].y-pts[1].y);if(pinch.current)core.zoom(pinch.current/distance,(pts[0].x+pts[1].x)/2-plot.current!.getBoundingClientRect().left);pinch.current=distance;return;}const d=drag.current;if(d){core.pan(e.clientX-d.x,d.view);if(Math.abs(e.clientY-d.y)>4)core.lift(e.clientY-d.y,d.shift);}}}
 onPointerUp={e=>up(e.pointerId)} onPointerCancel={e=>up(e.pointerId)} onPointerLeave={()=>{if(core){core.hoverIndex=-1;core.hoverY=-1;core.scheduleRedraw();}}} onDoubleClick={()=>core?.reset()}/>
 <div ref={scale} className="cc-scale" aria-label="Price scale" title="Drag or scroll to stretch the price scale · double-click to fit" onPointerDown={e=>{if(!core)return;e.currentTarget.setPointerCapture(e.pointerId);drag.current={x:e.clientX,y:e.clientY,view:core.view,k:core.scale,shift:core.shift,kind:'scale'};}} onPointerMove={e=>{const d=drag.current;if(core&&d?.kind==='scale')core.stretch((e.clientY-d.y)*3,d.k);}} onPointerUp={e=>up(e.pointerId)} onPointerCancel={e=>up(e.pointerId)} onDoubleClick={()=>core?.autoScale()}/>
 {core&&!p.labelsUnavailable&&<FlowLayer {...p} core={core} show={show}/>}
 </div><div className="coin-chart-phone-options"><Seg options={['Line','Candles']} value={mode} onChange={v=>setMode(v as typeof mode)} label="Chart type"/><Seg options={['Price','FDV']} value={axis} onChange={setAxis} label="Axis"/>{settingsMenu}</div>
 <div data-tour={!p.labelsUnavailable && p.markers.length ? "flow-markers" : undefined} className="chart-flowkeys"><span className="muted">Show trades by</span>{(Object.keys(show) as WalletLabel[]).map(label=><label className="check" key={label}><input type="checkbox" disabled={p.labelsUnavailable} title={p.labelsUnavailable ? WALLET_LABELS_LATER : undefined} checked={!p.labelsUnavailable && show[label]} onChange={e=>setShow({...show,[label]:e.target.checked})}/><Glyph label={label}/>{WALLET_LABEL_WORD[label]}</label>)}{p.labelsUnavailable && <span className="muted">{WALLET_LABELS_LATER}</span>}<span className="cc-hint">Scroll to zoom out to thin candles · drag to move · drag the price scale to stretch it · double-click to reset</span><span className="cc-zoom" role="group" aria-label="Zoom"><button className="btn btn-sm btn-ghost" aria-label="Reset chart" onClick={()=>core?.reset()}>Reset</button><button className="iconbtn" aria-label="Zoom out" onClick={()=>core?.zoom(1.25)}>−</button><button className="iconbtn" aria-label="Zoom in" onClick={()=>core?.zoom(.8)}>+</button></span></div></div>;
}
