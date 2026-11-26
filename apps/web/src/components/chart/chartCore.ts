import type { Bar } from '@eko/shared';
import { formatCoinPrice, formatCompactUsd } from '../../lib/format';
import { paintArea, paintCandles, paintVolume, sweep, withAlpha, type CandlePalette } from '../../lib/phosphor';
import { clampView, emaOf, panView, timeLabel, zoomView, stretchScale, type View, type CoinTimeframe } from './coinMath';

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

/** What a viewer can switch on the coin chart (saved per browser: ChartStage). */
export interface ChartOptions { volume: boolean; log: boolean; ema: number[] }
export const EMA_COLORS: Record<number, string> = { 9: COLORS.ema9, 21: COLORS.ema21, 50: COLORS.ema50 };

/** Coin adapter: prototype phosphor paint and view math, retaining the coordinate/onRedraw overlay contract. */
export class ChartCore {
  data: Bar[] = [];
  tf: CoinTimeframe = '5m';
  view: View = { s: 0, e: 1 };
  scale = 1;
  shift = 0;
  mode: 'Line' | 'Candles' = 'Line';
  opts: ChartOptions = { volume: true, log: false, ema: [] };
  axisSupply = 1;
  /** Candle colours other than the default (lib/phosphor CandlePalette); the crosshair follows them, muted. */
  palette: CandlePalette | null = null;
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
  /** Top inset of the price pane: the coin page's toolbar sits above the plate, not over it. */
  readonly T = 18;
  hoverIndex = -1;
  hoverY = -1;
  hoverAt(x:number,y=-1){this.hoverIndex=Math.floor(this.view.s+(x-this.L)/this.paneWidth()*(this.view.e-this.view.s));this.hoverY=y;this.scheduleRedraw();}
  constructor(private el: HTMLElement) {
    this.canvas = document.createElement('canvas'); this.canvas.className = 'light'; this.canvas.setAttribute('aria-hidden', 'true'); el.append(this.canvas);
    this.observer = new ResizeObserver(() => { const narrow = this.width < 560; this.width = el.clientWidth; this.height = el.clientHeight; if (narrow !== (this.width < 560)) this.reset(); this.scheduleRedraw(); });
    this.observer.observe(el); this.width = el.clientWidth; this.height = el.clientHeight;
  }
  paneWidth() { return Math.max(1, this.width - this.L - this.R); }
  mainPaneHeight() { return this.height - 30; }
  /** The newest bars at a readable width (~8 px a slot, 9 on phones), or all of them when fewer. */
  /** The newest bars at a readable width (~8 px a slot, 9 on phones). A young coin with only a few bars keeps that width,
   *  against the right edge, rather than one candle stretched across the whole plot. */
  fit(): View { const n = this.data.length, span = Math.max(18, Math.min(n, Math.floor(this.paneWidth() / (this.width < 560 ? 9 : 8)))); return { s: n - span, e: n || 1 }; }
  reset() { this.view = this.fit(); this.scale = 1; this.shift = 0; this.scheduleRedraw(); }
  autoScale() { this.scale = 1; this.shift = 0; this.scheduleRedraw(); }
  zoom(factor: number, x = this.L + this.paneWidth() / 2) { this.view = clampView(zoomView(this.view, factor, (x - this.L) / this.paneWidth()), this.data.length); this.scheduleRedraw(); }
  pan(dx: number, start = this.view) { this.view = clampView(panView(start, dx, this.paneWidth()), this.data.length); this.scheduleRedraw(); }
  /** Move the price range by a vertical drag of dy pixels from `start` (the price scale then stays where it is put). */
  lift(dy: number, start: number) { this.shift = start + dy / Math.max(1, this.mainPaneHeight() - 42 - this.T) * this.scale; this.scheduleRedraw(); }
  stretch(delta: number, start = this.scale) { this.scale = stretchScale(start, delta); this.scheduleRedraw(); }
  setData(bars: Bar[], tf: CoinTimeframe, keepRange = false) { this.data = [...bars]; this.tf = tf; if (!keepRange) this.reset(); this.scheduleRedraw(); }
  setMode(mode: 'Line' | 'Candles') { this.mode = mode; this.scheduleRedraw(); }
  setOptions(opts: ChartOptions) { this.opts = opts; this.scheduleRedraw(); }
  setPalette(palette: CandlePalette | null) { this.palette = palette; this.scheduleRedraw(); }
  animate() { this.stopSweep(); this.stopSweep = sweep((p) => { this.progress = p; this.paint(); this.listeners.forEach(l => l()); }, { dur: 1000 }); }
  update(bar: Bar): boolean { const last = this.data.at(-1); if (last && bar.ts < last.ts) return false; if (bar.ts === last?.ts) this.data[this.data.length - 1] = bar; else this.data.push(bar); this.scheduleRedraw(); return true; }
  indexAtOrBefore(t: number): number { let lo=0,hi=this.data.length-1,ans=-1;while(lo<=hi){const mid=(lo+hi)>>1;if(this.data[mid].ts<=t){ans=mid;lo=mid+1;}else hi=mid-1;}return ans; }
  slot() { return this.paneWidth()/(this.view.e-this.view.s); }
  xForIndex(i: number): number { return this.L+(i-this.view.s+.5)*this.slot(); }
  xForTime(t: number): number | null { const i=this.indexAtOrBefore(t);return i<0?null:this.xForIndex(i); }
  /** Price to the scale's own units: log prices on a log scale. */
  private f(p: number) { return this.opts.log ? Math.log(Math.max(p, 1e-30)) : p; }
  private inv(v: number) { return this.opts.log ? Math.exp(v) : v; }
  priceRange() { if(this.cachedRange)return this.cachedRange;const visible=this.data.slice(Math.max(0,Math.floor(this.view.s)),Math.min(this.data.length,Math.ceil(this.view.e))), src=visible.length?visible:this.data;let lo=Infinity,hi=-Infinity;for(const b of src){lo=Math.min(lo,this.f(b.l));hi=Math.max(hi,this.f(b.h));}const span=hi-lo||Math.abs(hi)*.02||1,pad=span*.08,mid=(lo+hi)/2+this.shift*span,half=(span/2+pad)*this.scale;this.cachedRange={lo:mid-half,hi:mid+half};return this.cachedRange; }
  yForPrice(p: number): number | null { if(!this.data.length)return null;const r=this.priceRange(), B=this.mainPaneHeight()-42;return B-(this.f(p)-r.lo)/(r.hi-r.lo)*(B-this.T); }
  priceForY(y: number): number { const r=this.priceRange(), B=this.mainPaneHeight()-42;return this.inv(r.lo+(B-y)/(B-this.T)*(r.hi-r.lo)); }
  onRedraw(l:()=>void) { this.listeners.add(l);return()=>{this.listeners.delete(l);}; }
  scheduleRedraw() { this.cachedRange=null; if(this.raf||this.dead)return;this.raf=requestAnimationFrame(()=>{this.raf=0;if(this.dead)return;this.paint();this.listeners.forEach(l=>l());}); }
  private label(_c: CanvasRenderingContext2D, value: number, step?: number) { return this.axisSupply===1?formatCoinPrice(value):formatCompactUsd(value,step); }
  /** The chart without the crosshair, kept after each full paint: moving the pointer only pastes it back and draws the
   *  crosshair (a full paint redraws every glow and dither dot; doing that per mousemove lagged the page). */
  private base: HTMLCanvasElement | null = null;
  private baseKey = '';
  private key() { const l = this.data.at(-1); return [this.data.length, l?.ts, l?.o, l?.h, l?.l, l?.c, l?.vUsd, this.view.s, this.view.e, this.scale, this.shift, this.mode, this.opts.volume, this.opts.log, this.opts.ema.join(','), this.width, this.height, this.axisSupply, this.progress, this.canvas.width, ...(this.palette ? [this.palette.up, this.palette.down, this.palette.hollow] : [])].join('|'); }
  private paint() {
    if(!this.data.length||!this.width)return;
    const key=this.key(),c0=this.canvas.getContext('2d');
    if(c0&&this.base&&key===this.baseKey&&this.base.width===this.canvas.width&&this.base.height===this.canvas.height){
      c0.save();c0.setTransform(1,0,0,1,0,0);c0.globalCompositeOperation='copy';c0.drawImage(this.base,0,0);c0.restore();
      this.paintCrosshair(c0);return;
    }
    const i0=Math.max(0,Math.floor(this.view.s)-1),i1=Math.min(this.data.length,Math.ceil(this.view.e)+1),bars=this.data.slice(i0,i1),slot=this.slot(),B=this.mainPaneHeight()-42;
    const g={W:this.width,H:this.height,L:this.L,R:this.R,T:this.T,B,slot,candles:bars,series:bars.map(b=>b.c),x:(i:number)=>this.xForIndex(i0+i),y:(p:number)=>this.yForPrice(p)!,clip:{x:this.L,y:this.T,w:this.paneWidth(),h:this.mainPaneHeight()-this.T},noHalo:i1<this.data.length,...(this.palette?{palette:this.palette}:{})};
    if(this.mode==='Line')paintArea(this.canvas,g,this.progress);else paintCandles(this.canvas,g,this.progress);
    if(this.opts.volume)paintVolume(this.canvas,{...g,B:this.mainPaneHeight(),volumes:bars.map(b=>b.vUsd)},this.progress);
    const c=this.canvas.getContext('2d');if(!c)return;c.save();
    // Moving averages over every loaded close, drawn for the visible bars.
    if(this.opts.ema.length&&this.progress>=1){const closes=this.data.map(b=>b.c);c.save();c.beginPath();c.rect(this.L,this.T,this.paneWidth(),B-this.T);c.clip();c.lineWidth=1.25;
      for(const period of this.opts.ema){const line=emaOf(closes,period);c.strokeStyle=EMA_COLORS[period]??COLORS.ema21;c.beginPath();for(let i=i0;i<i1;i++){const x=this.xForIndex(i),y=this.yForPrice(line[i]!)!;if(i===i0)c.moveTo(x,y);else c.lineTo(x,y);}c.stroke();}c.restore();}
    c.font='12px sans-serif';c.fillStyle='#71879a';c.strokeStyle='rgba(150,190,235,.08)';const r=this.priceRange();
    for(let i=0;i<5;i++){const y=B-(B-this.T)*i/4,p=this.priceForY(y);c.beginPath();c.moveTo(this.L,y);c.lineTo(this.width-this.R,y);c.stroke();const value=p*this.axisSupply;c.fillText(this.label(c,value,(this.inv(r.hi)-this.inv(r.lo))/4*this.axisSupply),this.width-this.R+10,y+4);}
    const last=this.data.at(-1)!,lastY=this.yForPrice(last.c)!;
    if(lastY>=this.T&&lastY<=B&&this.xForIndex(this.data.length-1)<=this.width-this.R){c.strokeStyle='rgba(200,232,252,.5)';c.setLineDash([2,3]);c.beginPath();c.moveTo(this.L,lastY);c.lineTo(this.width-this.R,lastY);c.stroke();c.setLineDash([]);c.fillStyle='#c8e8fc';c.fillRect(this.width-this.R+2,lastY-9,this.R-4,18);c.fillStyle='#04111a';c.fillText(this.label(c,last.c*this.axisSupply),this.width-this.R+8,lastY+4);c.fillStyle='#71879a';}
    for(const f of [.08,.36,.64,.92]){const i=Math.floor(this.view.s+f*(this.view.e-this.view.s));const bar=this.data[i];if(bar){c.textAlign='center';c.fillText(timeLabel(bar.ts,this.tf),this.xForIndex(i),this.height-10);}}c.textAlign='start';
    c.restore();
    this.el.dataset.scale=String(this.scale);this.el.dataset.slot=String(slot);
    // Keep this frame (without the crosshair) for pointer moves.
    if(!this.base)this.base=document.createElement('canvas');
    if(this.base.width!==this.canvas.width||this.base.height!==this.canvas.height){this.base.width=this.canvas.width;this.base.height=this.canvas.height;}
    const b=this.base.getContext('2d');if(b){b.setTransform(1,0,0,1,0,0);b.globalCompositeOperation='copy';b.drawImage(this.canvas,0,0);b.globalCompositeOperation='source-over';this.baseKey=key;}
    this.paintCrosshair(c);
  }
  private paintCrosshair(c: CanvasRenderingContext2D) {
    const B=this.mainPaneHeight()-42,dpr=this.canvas.width/Math.max(1,this.width);
    c.save();c.setTransform(dpr,0,0,dpr,0,0);c.globalCompositeOperation='source-over';c.font='12px sans-serif';
    const cross=this.palette?withAlpha(this.palette.up,.4):'rgba(200,232,252,.3)';
    // Crosshair: the hovered bar's time line, and the pointer's price line with its value on the scale.
    const hovered=this.data[this.hoverIndex];if(hovered){const x=this.xForIndex(this.hoverIndex);if(x>=this.L&&x<=this.width-this.R){c.strokeStyle=cross;c.setLineDash([3,3]);c.beginPath();c.moveTo(x,this.T);c.lineTo(x,this.mainPaneHeight());c.stroke();c.setLineDash([]);const t=timeLabel(hovered.ts,this.tf),w=c.measureText(t).width+12;c.fillStyle='#1b2a36';c.fillRect(x-w/2,this.height-24,w,18);c.fillStyle='#c8e8fc';c.textAlign='center';c.fillText(t,x,this.height-11);c.textAlign='start';}}
    if(this.hoverY>=this.T&&this.hoverY<=B){const y=this.hoverY;c.strokeStyle=cross;c.setLineDash([3,3]);c.beginPath();c.moveTo(this.L,y);c.lineTo(this.width-this.R,y);c.stroke();c.setLineDash([]);c.fillStyle='#1b2a36';c.fillRect(this.width-this.R+2,y-9,this.R-4,18);c.fillStyle='#c8e8fc';c.fillText(this.label(c,this.priceForY(y)*this.axisSupply),this.width-this.R+8,y+4);}
    c.restore();
  }
  destroy(){this.dead=true;this.observer.disconnect();this.stopSweep();cancelAnimationFrame(this.raf);this.listeners.clear();this.canvas.remove();}
}
