import type { Bar } from '@eko/shared';
import { formatCoinPrice } from '../../lib/format';
import { paintArea, paintCandles, paintVolume, sweep } from '../../lib/phosphor';
import { clampView, panView, zoomView, stretchScale, type View, type CoinTimeframe } from './coinMath';

export const COLORS = {
  up: '#19d99f',
  down: '#f0445a',
  upWick: 'rgba(25,217,159,0.8)',
  downWick: 'rgba(240,68,90,0.8)',
  upVol: 'rgba(25,217,159,0.28)',
  downVol: 'rgba(240,68,90,0.26)',
  ema9: '#ffb547',
  ema21: '#5aabff',
  ema50: '#ff4fa8',
  bb: 'rgba(90,171,255,0.6)',
  bbMid: 'rgba(90,171,255,0.35)',
};

/** Dark chart colours; candles keep their direction colours. */
export const CHART_THEME = { text: '#7c8997', grid: 'rgba(150,190,235,0.045)', border: 'rgba(150,190,235,0.08)', cross: 'rgba(200,220,255,0.25)', label: '#1b2a36', sep: 'rgba(150,190,235,0.08)' };

/** Coin adapter: prototype phosphor paint and view math, retaining the coordinate/onRedraw overlay contract. */
export class ChartCore {
  data: Bar[] = [];
  tf: CoinTimeframe = '5m';
  view: View = { s: 0, e: 1 };
  scale = 1;
  shift = 0;
  mode: 'Line' | 'Candles' = 'Line';
  axisSupply = 1;
  readonly canvas: HTMLCanvasElement;
  private observer: ResizeObserver;
  private listeners = new Set<() => void>();
  private raf = 0;
  private stopSweep = () => {};
  private progress = 1;
  private dead = false;
  private cachedRange: {lo:number;hi:number}|null = null;
  private width = 1;
  private height = 440;
  readonly L = 12;
  readonly R = 78;
  readonly T = 44;
  hoverIndex = -1;
  hoverAt(x:number){this.hoverIndex=Math.floor(this.view.s+(x-this.L)/this.paneWidth()*(this.view.e-this.view.s));this.scheduleRedraw();}
  constructor(private el: HTMLElement) {
    this.canvas = document.createElement('canvas'); this.canvas.className = 'light'; this.canvas.setAttribute('aria-hidden', 'true'); el.append(this.canvas);
    this.observer = new ResizeObserver(() => { const narrow = this.width < 560; this.width = el.clientWidth; this.height = el.clientHeight; if (narrow !== (this.width < 560)) this.reset(); this.scheduleRedraw(); });
    this.observer.observe(el); this.width = el.clientWidth; this.height = el.clientHeight;
  }
  paneWidth() { return Math.max(1, this.width - this.L - this.R); }
  mainPaneHeight() { return this.height - 30; }
  fit(): View { const n = this.data.length, span = this.width < 560 ? Math.min(n, Math.max(18, Math.floor(this.width / 9))) : n; return { s: n - span, e: n || 1 }; }
  reset() { this.view = this.fit(); this.scale = 1; this.shift = 0; this.scheduleRedraw(); }
  zoom(factor: number, x = this.L + this.paneWidth() / 2) { this.view = clampView(zoomView(this.view, factor, (x - this.L) / this.paneWidth()), this.data.length); this.scheduleRedraw(); }
  pan(dx: number, start = this.view) { this.view = clampView(panView(start, dx, this.paneWidth()), this.data.length); this.scheduleRedraw(); }
  stretch(delta: number, start = this.scale) { this.scale = stretchScale(start, delta); this.scheduleRedraw(); }
  setData(bars: Bar[], tf: CoinTimeframe, keepRange = false) { this.data = [...bars]; this.tf = tf; if (!keepRange) this.reset(); this.scheduleRedraw(); }
  setMode(mode: 'Line' | 'Candles') { this.mode = mode; this.scheduleRedraw(); }
  animate() { this.stopSweep(); this.stopSweep = sweep((p) => { this.progress = p; this.paint(); this.listeners.forEach(l => l()); }, { dur: 1000 }); }
  update(bar: Bar): boolean { const last = this.data.at(-1); if (last && bar.ts < last.ts) return false; if (bar.ts === last?.ts) this.data[this.data.length - 1] = bar; else this.data.push(bar); this.scheduleRedraw(); return true; }
  indexAtOrBefore(t: number): number { let lo=0,hi=this.data.length-1,ans=-1;while(lo<=hi){const mid=(lo+hi)>>1;if(this.data[mid].ts<=t){ans=mid;lo=mid+1;}else hi=mid-1;}return ans; }
  xForTime(t: number): number | null { const i=this.indexAtOrBefore(t);return i<0?null:this.L+(i-this.view.s+.5)*this.paneWidth()/(this.view.e-this.view.s); }
  priceRange() { if(this.cachedRange)return this.cachedRange;const visible=this.data.slice(Math.max(0,Math.floor(this.view.s)),Math.min(this.data.length,Math.ceil(this.view.e))), src=visible.length?visible:this.data;const lo=Math.min(...src.map(b=>b.l)),hi=Math.max(...src.map(b=>b.h)),span=hi-lo||hi*.02||1,pad=span*.08,mid=(lo+hi)/2+this.shift*span,half=(span/2+pad)*this.scale;this.cachedRange={lo:mid-half,hi:mid+half};return this.cachedRange; }
  yForPrice(p: number): number | null { if(!this.data.length)return null;const r=this.priceRange(), B=this.mainPaneHeight()-42;return B-(p-r.lo)/(r.hi-r.lo)*(B-this.T); }
  onRedraw(l:()=>void) { this.listeners.add(l);return()=>{this.listeners.delete(l);}; }
  scheduleRedraw() { this.cachedRange=null; if(this.raf||this.dead)return;this.raf=requestAnimationFrame(()=>{this.raf=0;if(this.dead)return;this.paint();this.listeners.forEach(l=>l());}); }
  private paint() {
    if(!this.data.length||!this.width)return;
    const i0=Math.max(0,Math.floor(this.view.s)-1),i1=Math.min(this.data.length,Math.ceil(this.view.e)+1),bars=this.data.slice(i0,i1),slot=this.paneWidth()/(this.view.e-this.view.s),B=this.mainPaneHeight()-42;
    const g={W:this.width,H:this.height,L:this.L,R:this.R,T:this.T,B,slot,candles:bars,series:bars.map(b=>b.c),x:(i:number)=>this.xForTime(bars[i].ts)!,y:(p:number)=>this.yForPrice(p)!,clip:{x:this.L,y:this.T,w:this.paneWidth(),h:this.mainPaneHeight()-this.T},noHalo:i1<this.data.length};
    if(this.mode==='Line')paintArea(this.canvas,g,this.progress);else paintCandles(this.canvas,g,this.progress);
    paintVolume(this.canvas,{...g,B:this.mainPaneHeight(),volumes:bars.map(b=>b.vUsd)},this.progress);
    const c=this.canvas.getContext('2d');if(!c)return;c.save();c.font='12px sans-serif';c.fillStyle='#71879a';c.strokeStyle='rgba(150,190,235,.08)';const r=this.priceRange();
    for(let i=0;i<5;i++){const p=r.lo+(r.hi-r.lo)*i/4,y=this.yForPrice(p)!;c.beginPath();c.moveTo(this.L,y);c.lineTo(this.width-this.R,y);c.stroke();const value=p*this.axisSupply;c.fillText(this.axisSupply===1?formatCoinPrice(value):`$${(value/1e6).toFixed(2)}M`,this.width-this.R+10,y+4);}
    const last=this.data.at(-1)!,lastY=this.yForPrice(last.c)!;
    if(lastY>=this.T&&lastY<=B&&this.xForTime(last.ts)!<=this.width-this.R){c.strokeStyle='rgba(200,232,252,.5)';c.setLineDash([2,3]);c.beginPath();c.moveTo(this.L,lastY);c.lineTo(this.width-this.R,lastY);c.stroke();c.setLineDash([]);c.fillStyle='#c8e8fc';c.fillRect(this.width-this.R+2,lastY-9,this.R-4,18);c.fillStyle='#04111a';const value=last.c*this.axisSupply;c.fillText(this.axisSupply===1?formatCoinPrice(value):`$${(value/1e6).toFixed(2)}M`,this.width-this.R+8,lastY+4);c.fillStyle='#71879a';}
    const hovered=this.data[this.hoverIndex];if(hovered){const x=this.xForTime(hovered.ts)!;if(x>=this.L&&x<=this.width-this.R){c.strokeStyle='rgba(200,232,252,.3)';c.beginPath();c.moveTo(x,this.T);c.lineTo(x,B);c.stroke();}}
    for(const f of [.08,.36,.64,.92]){const i=Math.floor(this.view.s+f*(this.view.e-this.view.s));const bar=this.data[i];if(bar){c.textAlign='center';c.fillText(new Date(bar.ts*1000).toISOString().slice(11,16),this.xForTime(bar.ts)!,this.height-10);}}c.restore();
    this.el.dataset.scale=String(this.scale);this.el.dataset.slot=String(slot);
  }
  destroy(){this.dead=true;this.observer.disconnect();this.stopSweep();cancelAnimationFrame(this.raf);this.listeners.clear();this.canvas.remove();}
}
