import { reducedMotion } from './phosphor';
type Field = (u:number,v:number,x:number,y:number)=>number;
type TextureKind = 'dh'|'de'|'dg'|'dw';
// Ordered-dither textures, from the same 4×4 Bayer matrix as the chart plates. They mark activity without
// shouting: a blue-white shimmer on rising coins and a low ember under risk, each in three tiers
// (lib/heat.js marking). Intensity is dot density, not brightness. Tiers 1–2 have three frames that step
// slowly; tier 3 (surging, red flag) has eight turbulent frames played at about 8–10 fps. Rendered once when the browser is idle, into CSS variables:
// --dh-{tier}-{frame} (row shimmer), --de-… (row ember), --dg-… (card glow), --dw-… (box ember).
const BAYER=[0,8,2,10,12,4,14,6,3,11,1,9,15,7,13,5];
const FRAMES=[0,3,3,8];

// Seeded value noise, so every load draws the same flames.
function hash(x:number,y:number){let h=(x*374761393+y*668265263)^0x5bd1e995;h=Math.imul(h^(h>>>13),1274126177);return ((h^(h>>>16))>>>0)/4294967296;}
function vnoise(x:number,y:number){const xi=Math.floor(x),yi=Math.floor(y),xf=x-xi,yf=y-yi,s=(t:number)=>t*t*(3-2*t);
 const a=hash(xi,yi),b=hash(xi+1,yi),c=hash(xi,yi+1),d=hash(xi+1,yi+1),u=s(xf),v=s(yf);return a+(b-a)*u+(c-a)*v+(a-b-c+d)*u*v;}
const fbm=(x:number,y:number)=>vnoise(x,y)*.55+vnoise(x*2.1,y*2.1)*.3+vnoise(x*4.3,y*4.3)*.15;
const clamp=(v:number)=>Math.max(0,Math.min(1,v));

/** Paint a field (u,v in 0..1 → 0..1) as dithered dots in up to four tones. */
function texture(w:number,h:number,field:Field,tones:readonly string[],{cell=3,dot=1.4,scale=2}={}){
 const cv=document.createElement('canvas');cv.width=w*scale;cv.height=h*scale;const c=cv.getContext('2d');if(!c)throw new Error('Canvas 2D is unavailable');c.scale(scale,scale);
 const buckets:number[][]=tones.map(()=>[]);
 for(let x=0,ix=0;x<w;x+=cell,ix++)for(let y=0,iy=0;y<h;y+=cell,iy++){
  const v=clamp(field(x/w,y/h,x,y));if(v*16>BAYER[(ix&3)+((iy&3)<<2)]+.5)buckets[Math.min(tones.length-1,Math.floor(v*tones.length))].push(x,y);}
 buckets.forEach((b,k)=>{c.fillStyle=tones[k];c.beginPath();for(let i=0;i<b.length;i+=2)c.rect(b[i],b[i+1],dot,dot);c.fill();});
 return cv.toDataURL('image/png');
}

const HOT=['rgba(120,190,240,.16)','rgba(143,202,240,.26)','rgba(190,228,252,.36)','rgba(226,244,255,.48)'];
const EMBER=['rgba(78,20,14,.38)','rgba(112,30,20,.38)','rgba(150,46,30,.36)','rgba(196,82,56,.3)'];
// Tier strength: how much of the field survives the dither threshold.
const SHIMMER_K=[0,.62,.86,1.1],EMBER_K=[0,.4,.56,.76];

// Tier 3 is turbulent: bigger jumps in the noise between frames, a per-frame flicker, and a little more reach.
const flick=(t:number,f:number)=>t===3?.82+.36*hash(f*7+1,t*13):1;
const FIELDS:Record<TextureKind,(k:number,f:number,t:number)=>Field>={
 // Row shimmer: strongest at the left edge, with sparkle that shifts between frames.
 dh:(k,f,t)=>{const j=t===3?9.7:5.3,reach=t===3?3.0:3.8,q=flick(t,f);return (u,v,x,y)=>(Math.exp(-u*reach)*(.5+.6*fbm(x/26+f*j,y/18+f*j*.45))-.06)*k*q;},
 // Row ember: low flame tongues rising from the bottom on the left; each frame lifts and sways the noise.
 de:(k,f,t)=>{const rise=t===3?.55:.35,sway=t===3?Math.sin(f*1.7)*.6:0,tall=t===3?.62:.55,q=flick(t,f);
  return (u,v,x,y)=>{const n=fbm(x/22+sway,y/30+u*3+f*rise);const top=.95-(tall+.5*n)*(1-u*.9);return (v-top)*2.6*Math.exp(-u*2.6)*k*q;};},
 // Card glow: a soft shimmer from the top-right corner.
 dg:(k,f,t)=>{const j=t===3?7.9:4.1,q=flick(t,f);return (u,v,x,y)=>{const d=Math.hypot(1-u,v*.85);return (Math.exp(-d*2.4)*(.62+.55*fbm(x/30+f*j,y/30+f*j*.4))-.05)*k*q;};},
 // Box ember: along the bottom of a box.
 dw:(k,f,t)=>{const rise=t===3?.5:.3,sway=t===3?Math.sin(f*1.3)*.5:0,q=flick(t,f);
  return (u,v,x,y)=>{const n=fbm(x/26+sway,y/34+f*rise);const top=1-(.28+.55*n);return (v-top)*2.4*(.55+.45*Math.exp(-u*1.8))*k*q;};},
};
const SIZES:Record<TextureKind,[number,number]>={dh:[900,64],de:[900,64],dg:[420,240],dw:[640,120]};

export function installDither(){
 if(typeof document==='undefined')return;
 const run=()=>{const root=document.documentElement.style;
  for(const key of Object.keys(FIELDS) as TextureKind[]){const ember=key==='de'||key==='dw',K=ember?EMBER_K:SHIMMER_K,[w,h]=SIZES[key];
   for(let tier=1;tier<=3;tier++)for(let f=0;f<(reducedMotion()?1:FRAMES[tier]);f++)root.setProperty(`--${key}-${tier}-${f}`,`url(${texture(w,h,FIELDS[key](K[tier],f,tier),ember?EMBER:HOT)})`);}};
 let cancelled=false;const work=()=>{if(!cancelled)run();};
 const idle=typeof window.requestIdleCallback==='function';
 const handle=idle?window.requestIdleCallback(work):window.setTimeout(work,200);
 return()=>{cancelled=true;if(idle)window.cancelIdleCallback(handle);else window.clearTimeout(handle);};
}
