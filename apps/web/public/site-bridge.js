// Bridge from the landing into the terminal, served only on the combined site (vite.config.js).
// It adds a Terminal link to the header and "Open in the terminal" to the signal desk, and leaves with
// the desk's own move: a square that expands from what you pressed to the whole screen.
const EASE='cubic-bezier(.2,.85,.1,1)';
const still=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;

function expandInto(href,from){
 try{sessionStorage.setItem('eko.enter',JSON.stringify(from.getBoundingClientRect()));}catch{}
 if(still()){location.href=href;return;}
 const r=from.getBoundingClientRect(),veil=document.createElement('div');veil.className='eko-veil';document.body.append(veil);
 const box=(x,y,w,h)=>({left:`${x}px`,top:`${y}px`,width:`${w}px`,height:`${h}px`});
 const run=veil.animate([{...box(r.left,r.top,r.width,r.height),opacity:.6},{...box(0,0,innerWidth,innerHeight),opacity:1}],{duration:640,easing:EASE,fill:'forwards'});
 run.finished.then(()=>{location.href=href;});
}
function wire(a){a.addEventListener('click',e=>{if(e.metaKey||e.ctrlKey||e.shiftKey||e.button)return;e.preventDefault();expandInto(a.href,a);});}

// Header: the terminal sits beside "Try EKO", in the same underlined mono style.
const cta=document.querySelector('.site-header .enter-field');
if(cta){const a=document.createElement('a');a.className='enter-field eko-terminal';a.href='/radar';a.innerHTML='TERMINAL <span aria-hidden="true">↗</span>';
 const wrap=document.createElement('span');wrap.className='eko-header-ctas';cta.replaceWith(wrap);wrap.append(cta,a);wire(a);}

// Signal desk: open the terminal. (The desk's tokens are fictional samples, so this goes to Radar, not a coin page.)
const bar=document.querySelector('.desk-bar'),close=bar?.querySelector('.desk-close');
if(bar&&close){const a=document.createElement('a');a.className='eko-desk-open';a.href='/radar';a.innerHTML='Open in the terminal <span aria-hidden="true">↗</span>';close.before(a);
 wire(a);}
