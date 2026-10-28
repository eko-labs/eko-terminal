import { navigate } from './router';
export function reducedMotion() {
  return document.documentElement.dataset.motion === 'off' || (document.documentElement.dataset.motion !== 'on' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}
const box = (r: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>) => ({ left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
/** The prototype's expanding square, shared by inspector and full-page row links. */
export async function expandTo(to: string, from?: Element | DOMRect) {
  if (!from || reducedMotion() || typeof Element.prototype.animate !== 'function') { navigate(to); return; }
  const r = from instanceof Element ? from.getBoundingClientRect() : from;
  const main = document.getElementById('main')?.getBoundingClientRect();
  const top = Math.max(0, main?.top ?? 0);
  const target = { left: main?.left ?? 0, top, width: main?.width || innerWidth, height: innerHeight - top };
  const veil = document.createElement('div'); veil.className = 'eko-veil'; veil.setAttribute('aria-hidden', 'true'); document.body.append(veil);
  try {
    await veil.animate([{ ...box(r), opacity: .7 }, { ...box(target), opacity: 1 }], { duration: 520, easing: 'cubic-bezier(.2,.85,.1,1)', fill: 'forwards' }).finished;
    navigate(to);
    await veil.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 260, delay: 60, fill: 'forwards' }).finished;
  } catch { navigate(to); } finally { veil.remove(); }
}

/** Arriving from the landing (public/site-bridge.js): its square already filled the screen, so fade a veil away here. */
export function arrive() {
  let from: string | null = null;
  try { from = sessionStorage.getItem('eko.enter'); sessionStorage.removeItem('eko.enter'); } catch { /* storage unavailable */ }
  if (!from || reducedMotion() || typeof Element.prototype.animate !== 'function') return;
  const veil = document.createElement('div'); veil.className = 'eko-veil'; veil.setAttribute('aria-hidden', 'true');
  Object.assign(veil.style, { left: '0px', top: '0px', width: `${innerWidth}px`, height: `${innerHeight}px` });
  document.body.append(veil);
  veil.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 260, delay: 120, fill: 'forwards' }).finished.finally(() => veil.remove());
}
