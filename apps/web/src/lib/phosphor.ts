export interface PlotGeometry {
 W:number; H:number; L:number; R:number; T:number; B:number;
 y:(value:number)=>number; mini?:boolean;
 clip?:{x:number;y:number;w:number;h:number};
}
export interface AreaGeometry extends PlotGeometry { x:(index:number)=>number; series:readonly number[]; hot?:boolean; halos?:readonly {i:number}[]; base?:number }
export interface BarsGeometry extends PlotGeometry { series:readonly number[]; zero?:boolean; lo?:number; tone?:'warm'|'dim' }
export interface CandlesGeometry extends PlotGeometry { x:(index:number)=>number; candles:readonly {o:number;h:number;l:number;c:number}[]; slot:number; noHalo?:boolean }
// Phosphor light layer, ported from the site's signal desk.
// Charts are an SVG (labels, markers, interaction) over a canvas that carries the light:
// an LCD cell grid, an ordered-dither exposure under the trace, a bloomed beam with a
// faint chromatic fringe, halos, then scanlines. It paints once per change; the only
// motion is a one-shot sweep when a chart first appears or its data set changes.
export const candleWidth=(slot:number)=>slot*.72;
const BAYER=[0,8,2,10,12,4,14,6,3,11,1,9,15,7,13,5];

function setup(canvas:HTMLCanvasElement,W:number,H:number){
 const dpr=Math.min(2,window.devicePixelRatio||1);
 if(canvas.width!==Math.round(W*dpr)||canvas.height!==Math.round(H*dpr)){canvas.width=Math.round(W*dpr);canvas.height=Math.round(H*dpr);}
 const c=canvas.getContext('2d');if(!c)throw new Error('Canvas 2D is unavailable');c.setTransform(dpr,0,0,dpr,0,0);c.globalCompositeOperation='source-over';c.shadowBlur=0;c.clearRect(0,0,W,H);
 return {c,dpr};
}
/** Limit drawing to the plot when a chart is zoomed or panned: g.clip = {x,y,w,h}. */
function clipTo(c:CanvasRenderingContext2D,g:PlotGeometry){if(!g.clip)return;c.beginPath();c.rect(g.clip.x,g.clip.y,g.clip.w,g.clip.h);c.clip();}
function scan(c:CanvasRenderingContext2D,W:number,H:number,a=.3){c.globalCompositeOperation='destination-out';c.fillStyle=`rgba(0,0,0,${a})`;for(let y=0;y<H;y+=3)c.fillRect(0,y,W,1);c.globalCompositeOperation='source-over';}
function halo(c:CanvasRenderingContext2D,x:number,y:number,r:number,a:number){const g=c.createRadialGradient(x,y,0,x,y,r);g.addColorStop(0,`rgba(228,246,255,${a})`);g.addColorStop(.22,`rgba(116,194,248,${a*.4})`);g.addColorStop(1,'rgba(40,110,200,0)');c.fillStyle=g;c.beginPath();c.arc(x,y,r,0,Math.PI*2);c.fill();}

/** Area/line: g = {W,H,L,R,T,B,x(i),y(v),series,mini?,hot?,halos?:[{i}],base?} */
export function paintArea(canvas:HTMLCanvasElement,g:AreaGeometry,progress=1){
 const {W,H,mini}=g,{c,dpr}=setup(canvas,W,H);c.save();clipTo(c,g);
 if(g.series.length<2){c.restore();return;}
 const n=g.series.length-1,x0=g.x(0),x1=g.x(n),span=Math.max(Number.EPSILON,x1-x0),xEnd=x0+span*progress;
 const yAt=(x:number)=>{const f=Math.max(0,Math.min(n,(x-x0)/span*n)),i=Math.floor(f),t=f-i,a=g.series[i],b=g.series[Math.min(n,i+1)];return g.y(a+(b-a)*t);};
 const cell=mini?2.5:3,dot=mini?1.3:1.8,base=g.base??g.B;
 c.fillStyle=mini?'rgba(70,120,160,.06)':'rgba(70,125,170,.075)';c.beginPath();
 for(let x=x0;x<=x1;x+=cell)for(let y=g.T;y<=g.B;y+=cell)c.rect(x,y,dot*.7,dot*.7);c.fill();
 c.globalCompositeOperation='lighter';
 const tones=['rgba(58,120,186,.38)','rgba(78,150,212,.5)','rgba(108,180,236,.62)','rgba(170,216,250,.76)'],buckets:number[][]=[[],[],[],[]];
 for(let x=x0;x<Math.min(xEnd,x1+.01);x+=cell){const ty=yAt(x),ix=Math.round((x-x0)/cell);
  for(let y=g.T+Math.ceil((ty-g.T)/cell)*cell;y<=base;y+=cell){const iy=Math.round((y-g.T)/cell),d=(y-ty)/Math.max(10,g.B-g.T),v=Math.exp(-d*3.4)*.92+.05;
   if(v*16>BAYER[(ix&3)+((iy&3)<<2)]+.5)buckets[Math.min(3,Math.floor(v*4))].push(x,y);}}
 buckets.forEach((b,k)=>{c.fillStyle=tones[k];c.beginPath();for(let i=0;i<b.length;i+=2)c.rect(b[i],b[i+1],dot,dot);c.fill();});
 const path=(dx=0,dy=0)=>{c.beginPath();for(let i=0;i<=n;i++){const x=g.x(i);if(x>xEnd+.01){c.lineTo(xEnd+dx,yAt(xEnd)+dy);break;}const y=g.y(g.series[i]);i?c.lineTo(x+dx,y+dy):c.moveTo(x+dx,y+dy);}};
 const k=g.hot?1.25:1;c.lineJoin='round';c.lineCap='round';
 c.save();c.shadowColor='rgba(64,156,240,.95)';c.shadowBlur=(mini?10:24)*dpr;path();c.strokeStyle=`rgba(80,166,240,${.34*k})`;c.lineWidth=mini?3:5;c.stroke();c.restore();
 c.save();c.shadowColor='rgba(130,200,255,.9)';c.shadowBlur=(mini?4:8)*dpr;path();c.strokeStyle=`rgba(120,196,250,${.5*k})`;c.lineWidth=mini?1.6:2.6;c.stroke();c.restore();
 if(!mini){c.lineWidth=1.1;path(-.9,0);c.strokeStyle='rgba(80,226,255,.26)';c.stroke();path(.9,0);c.strokeStyle='rgba(76,104,255,.3)';c.stroke();path(0,2.4);c.strokeStyle='rgba(120,176,226,.16)';c.lineWidth=1;c.stroke();}
 c.save();c.shadowColor='rgba(210,238,255,.9)';c.shadowBlur=3*dpr;path();c.strokeStyle='rgba(238,250,255,.98)';c.lineWidth=g.hot?2.2:mini?1.2:1.6;c.stroke();c.restore();
 const tip=Math.min(xEnd,x1);halo(c,tip,yAt(tip),mini?11:progress<1?30:20,progress<1?.95:.55);
 (g.halos||[]).forEach(h=>{const hx=g.x(h.i);if(hx<=xEnd)halo(c,hx,g.y(g.series[h.i]),18,.6);});
 c.restore();scan(c,W,H,mini?.28:.34);
}

/** Bars: g = {W,H,L,R,T,B,y(v),series,zero?,tone?:'warm'|'dim'} — warm is for refusals and blocks, dim for paused things. */
export function paintBars(canvas:HTMLCanvasElement,g:BarsGeometry,progress=1){
 const {W,H}=g,{c,dpr}=setup(canvas,W,H);
 const n=g.series.length,slot=(g.W-g.L-g.R)/n,bw=Math.max(2,slot*.58),base=g.y(g.zero?0:g.lo??0),span=Math.max(...g.series.map(Math.abs))||1;
 c.globalCompositeOperation='lighter';
 for(let i=0;i<n;i++){
  if(i/n>progress)break;const v=g.series[i],x=g.L+i*slot+(slot-bw)/2,y=g.y(v),a=.32+.6*Math.abs(v)/span,up=y<base;
  const warm=g.tone==='warm',dim=g.tone==='dim';
  c.save();c.shadowColor=warm?'rgba(240,110,86,.8)':dim?'rgba(0,0,0,0)':'rgba(80,170,240,.85)';c.shadowBlur=(g.mini?4:7)*dpr;c.fillStyle=`rgba(${warm?'244,150,128':dim?'120,136,148':up||!g.zero?'150,210,250':'96,150,214'},${a})`;
  if(up)for(let yy=base-2;yy>=y-.5;yy-=3)c.fillRect(x,yy,bw,Math.min(2,yy-y+2));else for(let yy=base+1;yy<=y;yy+=3)c.fillRect(x,yy,bw,Math.min(2,y-yy+1));
  c.restore();
 }
 scan(c,W,H,.22);
}

/** Candles: g = {W,H,L,R,T,B,x(i),y(v),candles:[{o,h,l,c}],slot} */
export function paintCandles(canvas:HTMLCanvasElement,g:CandlesGeometry,progress=1){
 const {W,H}=g,{c,dpr}=setup(canvas,W,H),n=g.candles.length;c.save();clipTo(c,g);
 c.fillStyle='rgba(70,125,170,.07)';c.beginPath();for(let x=g.L;x<=g.W-g.R;x+=3)for(let y=g.T;y<=g.B;y+=3)c.rect(x,y,1.2,1.2);c.fill();
 c.globalCompositeOperation='lighter';
 const bw=candleWidth(g.slot);
 for(let i=0;i<n;i++){
  if(i/n>progress)break;const k=g.candles[i],x=g.x(i),up=k.c>=k.o,top=g.y(Math.max(k.o,k.c)),bot=g.y(Math.min(k.o,k.c)),h=Math.max(1,bot-top);
  c.save();c.shadowColor=up?'rgba(100,190,250,.7)':'rgba(60,110,150,.4)';c.shadowBlur=(up?4:2)*dpr;
  c.strokeStyle=up?'rgba(200,232,252,.85)':'rgba(96,130,156,.8)';c.lineWidth=1;c.beginPath();c.moveTo(x,g.y(k.h));c.lineTo(x,g.y(k.l));c.stroke();
  if(up){c.fillStyle='rgba(190,228,251,.92)';c.fillRect(x-bw/2,top,bw,h);}
  else{c.fillStyle='rgba(20,34,46,.95)';c.fillRect(x-bw/2,top,bw,h);c.strokeStyle='rgba(96,130,156,.9)';c.strokeRect(x-bw/2+.5,top+.5,bw-1,Math.max(0,h-1));}
  c.restore();
 }
 const last=g.candles[Math.min(n-1,Math.floor(progress*n))];if(last&&!g.noHalo)halo(c,g.x(Math.min(n-1,Math.floor(progress*n))),g.y(last.c),22,.55);
 c.restore();scan(c,W,H,.3);
}

/** Run a one-shot sweep, or paint the final frame when motion is reduced. Returns a cancel function. */
export const reducedMotion=()=>typeof document !== 'undefined' && (document.documentElement.dataset.motion === 'off' || (typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches));
export function sweep(paint:(progress:number)=>void,{dur=1000,animate=true,delay=0}={}){
 if(!animate||dur<=0||reducedMotion()){paint(1);return()=>{};}
 let raf=0,timer=0;
 const run=()=>{if(reducedMotion()){paint(1);return;}const began=performance.now();const tick=(now:number)=>{if(reducedMotion()){paint(1);return;}const t=Math.min(1,(now-began)/dur);paint(1-Math.pow(1-t,3));if(t<1)raf=requestAnimationFrame(tick);};raf=requestAnimationFrame(tick);};
 paint(0);if(delay)timer=window.setTimeout(run,delay);else run();
 return()=>{cancelAnimationFrame(raf);clearTimeout(timer);};
}
/** When the sweep (ease-out cubic) reaches a fraction e of the width, in ms: markers appear as the beam passes. */
export const sweepDelay=(e:number,dur=1000)=>Math.round((1-Math.cbrt(1-Math.min(1,Math.max(0,e))))*dur);

/** Volume plate under the candles, using the same phosphor bars without clearing their light. */
export function paintVolume(canvas:HTMLCanvasElement,g:CandlesGeometry & {volumes:readonly number[]},progress=1){
 const c=canvas.getContext('2d');if(!c)return;const max=Math.max(1,...g.volumes),bw=candleWidth(g.slot);c.save();clipTo(c,g);c.globalCompositeOperation='lighter';
 g.volumes.forEach((v,i)=>{if(i/g.volumes.length>progress)return;const x=g.x(i)-bw/2,top=g.B-v/max*32;c.fillStyle=g.candles[i].c>=g.candles[i].o?'rgba(150,210,250,.35)':'rgba(96,130,156,.25)';for(let y=g.B-2;y>=top;y-=3)c.fillRect(x,y,bw,2);});c.restore();
}
