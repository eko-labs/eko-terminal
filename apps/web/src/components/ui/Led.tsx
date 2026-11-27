import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { LED_CELLS, LED_FPS, LED_N, LED_PERIOD, LED_STILL, ledDone, ledFrame, ledStep, type LedPattern } from '../../lib/led';

/**
 * EKO's LED indicator: a small 7×7 dot panel running a pattern (lib/led.ts), drawn on a canvas, for things that are in
 * progress or just changed. It is decoration: aria-hidden, the words beside it carry the meaning.
 *
 * Cheap by design: every panel on the page is painted from one requestAnimationFrame loop, and only on the frames
 * where its pattern steps (about ten a second), never through React. Panels off screen are skipped (one shared
 * IntersectionObserver), the loop stops while the tab is hidden, and with motion off (the OS setting, or the site's
 * own: :root[data-motion]) every panel shows one still, lit frame.
 */
export type LedTone = 'blue' | 'ice' | 'coral';
/** EKO's palette only: blue is the cold accent (working, live, good), ice the Monitor colour, coral Danger. */
const TONE: Record<LedTone, [cssVar: string, fallback: string]> = { blue: ['--accent', '#8fcaf0'], ice: ['--monitor', '#d6ecfa'], coral: ['--danger', '#f08c7e'] };

export function motionOff(): boolean {
  if (typeof document === 'undefined') return true;
  const set = document.documentElement.dataset.motion;
  if (set === 'off') return true;
  if (set === 'on') return false;
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

interface Panel {
  canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; pattern: LedPattern; tone: LedTone; size: number; speed: number; cycles: number;
  dpr: number; start: number | null; last: number; visible: boolean; done: boolean; onDone?: () => void; timer?: number;
}
const panels = new Set<Panel>();
const byCanvas = new WeakMap<Element, Panel>();
let raf = 0, io: IntersectionObserver | null = null, watching = false;

const colours = new Map<LedTone, string>();
/** The tone's colour as "r, g, b", read once from the site's tokens. */
function colour(tone: LedTone) {
  let c = colours.get(tone);
  if (!c) {
    const [v, fallback] = TONE[tone], read = getComputedStyle(document.documentElement).getPropertyValue(v).trim();
    const hex = /^#[0-9a-f]{6}$/i.test(read) ? read : fallback;
    c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', '); colours.set(tone, c);
  }
  return c;
}
/** A soft bloom, drawn once per tone and dot size and stamped under every lit dot. */
const blooms = new Map<string, HTMLCanvasElement>();
function bloom(tone: LedTone, px: number) {
  const key = `${tone}|${px}`; let b = blooms.get(key);
  if (b) return b;
  b = document.createElement('canvas'); b.width = b.height = px;
  const g = b.getContext('2d');
  if (g) {
    const grad = g.createRadialGradient(px / 2, px / 2, 0, px / 2, px / 2, px / 2), c = colour(tone);
    grad.addColorStop(0, `rgba(${c}, 1)`); grad.addColorStop(0.3, `rgba(${c}, .45)`); grad.addColorStop(1, `rgba(${c}, 0)`);
    g.fillStyle = grad; g.fillRect(0, 0, px, px);
  }
  blooms.set(key, b); return b;
}

/** The space round the dots the bloom may spill into; the panel's layout box stays `size`. */
const spill = (size: number) => Math.ceil(size / LED_N * 0.9);
function paint(p: Panel, frame: Float32Array) {
  const { ctx, size, dpr, tone } = p, pitch = size / LED_N, m = spill(size), full = size + 2 * m;
  const r = pitch * 0.4, glowPx = Math.max(4, Math.round(pitch * 2.6 * dpr)), glow = bloom(tone, glowPx), g = glowPx / dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1; ctx.clearRect(0, 0, full, full);
  // The bloom first, added up where dots sit close, then the dots: unlit ones at a tenth, lit ones solid.
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < LED_CELLS; i++) {
    const v = frame[i]!; if (v < 0.08) continue;
    const x = m + (i % LED_N + 0.5) * pitch, y = m + (Math.floor(i / LED_N) + 0.5) * pitch;
    ctx.globalAlpha = v * 0.62; ctx.drawImage(glow, x - g / 2, y - g / 2, g, g);
  }
  ctx.globalCompositeOperation = 'source-over'; ctx.fillStyle = `rgb(${colour(tone)})`;
  for (let i = 0; i < LED_CELLS; i++) {
    const v = frame[i]!, x = m + (i % LED_N + 0.5) * pitch, y = m + (Math.floor(i / LED_N) + 0.5) * pitch;
    ctx.globalAlpha = 0.1 + 0.9 * v; ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.fill();
  }
  // A hot white centre on the brightest dots, as a real LED has.
  ctx.fillStyle = '#ffffff';
  for (let i = 0; i < LED_CELLS; i++) {
    const v = frame[i]!; if (v < 0.75) continue;
    const x = m + (i % LED_N + 0.5) * pitch, y = m + (Math.floor(i / LED_N) + 0.5) * pitch;
    ctx.globalAlpha = (v - 0.75) * 1.6; ctx.beginPath(); ctx.arc(x, y, r * 0.5, 0, 2 * Math.PI); ctx.fill();
  }
  ctx.globalAlpha = 1;
}
const still = (p: Panel) => paint(p, ledFrame(p.pattern, LED_STILL[p.pattern]));
function finish(p: Panel) {
  if (p.done) return;
  p.done = true; still(p);
  const done = p.onDone; if (done) queueMicrotask(done);
}

function tick(now: number) {
  raf = 0;
  for (const p of panels) {
    if (!p.visible || p.done) continue;
    const step = ledStep(p.pattern, now, p.speed);
    if (p.start === null) p.start = step;
    if (ledDone(p.pattern, p.start, step, p.cycles)) { finish(p); continue; }
    if (step !== p.last) { p.last = step; paint(p, ledFrame(p.pattern, step)); }
  }
  schedule();
}
function schedule() {
  if (raf || typeof requestAnimationFrame !== 'function' || document.hidden || motionOff()) return;
  for (const p of panels) if (p.visible && !p.done) { raf = requestAnimationFrame(tick); return; }
}
/** Motion turned off: every panel holds its still frame (one that plays once ends after its usual time). */
function settle() {
  const off = motionOff();
  for (const p of panels) {
    if (p.done) continue;
    if (off) { still(p); if (Number.isFinite(p.cycles) && p.timer === undefined) p.timer = window.setTimeout(() => finish(p), playMs(p)); }
    else p.last = NaN;
  }
  schedule();
}
const playMs = (p: Panel) => (p.cycles * LED_PERIOD[p.pattern] / (LED_FPS[p.pattern] * p.speed)) * 1000;
function watch() {
  if (watching) return; watching = true;
  document.addEventListener('visibilitychange', schedule);
  if (typeof matchMedia === 'function') matchMedia('(prefers-reduced-motion: reduce)').addEventListener?.('change', settle);
  if (typeof MutationObserver === 'function') new MutationObserver(settle).observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] });
  if (typeof IntersectionObserver === 'function') io = new IntersectionObserver((entries) => {
    for (const e of entries) { const p = byCanvas.get(e.target); if (p) { p.visible = e.isIntersecting; if (p.visible) p.last = NaN; } }
    schedule();
  }, { rootMargin: '48px' });
}

export interface LedMatrixProps {
  pattern: LedPattern; tone?: LedTone;
  /** The panel's width and height in CSS pixels: 14-20 in chips and rows, up to 28 in loading and empty states. */
  size?: number;
  /** Faster or slower than the pattern's own pace (offline breathes at 0.5). */
  speed?: number;
  /** Play this many cycles, then hold the still frame; leave out to loop for as long as it is shown. */
  cycles?: number;
  onDone?: () => void;
  className?: string;
}
export function LedMatrix({ pattern, tone = 'blue', size = 16, speed = 1, cycles = Infinity, onDone, className = '' }: LedMatrixProps) {
  const ref = useRef<HTMLCanvasElement>(null), done = useRef(onDone);
  done.current = onDone;
  const m = spill(size), full = size + 2 * m;
  const [dpr] = useState(() => typeof window === 'undefined' ? 2 : Math.min(3, Math.max(1, Math.round(window.devicePixelRatio || 1))));
  useLayoutEffect(() => {
    const canvas = ref.current; if (!canvas) return;
    let ctx: CanvasRenderingContext2D | null = null;
    try { ctx = canvas.getContext('2d'); } catch { /* No canvas (tests): nothing to draw. */ }
    if (!ctx) return;
    watch();
    const p: Panel = { canvas, ctx, pattern, tone, size, speed, cycles, dpr, start: null, last: NaN, visible: !io, done: false, onDone: () => done.current?.() };
    panels.add(p); byCanvas.set(canvas, p); io?.observe(canvas);
    // The first frame is drawn at once, so a panel never shows up blank.
    paint(p, ledFrame(pattern, motionOff() ? LED_STILL[pattern] : ledStep(pattern, performance.now(), speed)));
    if (motionOff()) settle(); else schedule();
    return () => { panels.delete(p); io?.unobserve(canvas); if (p.timer !== undefined) clearTimeout(p.timer); };
  }, [pattern, tone, size, speed, cycles, dpr]);
  return <span className={`led ${className}`} aria-hidden="true" style={{ '--led-size': `${size}px`, '--led-spill': `${m}px` } as CSSProperties}>
    <canvas ref={ref} width={full * dpr} height={full * dpr} data-pattern={pattern} data-tone={tone} />
  </span>;
}

/** Words with a light travelling through them while something is in progress; plain text with motion off. */
export function Shimmer({ children, className = '' }: { children: ReactNode; className?: string }) {
  // Every shimmer on the page shares one phase, so a list of them moves together rather than at random.
  const [delay] = useState(() => typeof performance === 'undefined' ? 0 : -Math.round(performance.now() % SHIMMER_MS));
  return <span className={`shimmer ${className}`} style={{ animationDelay: `${delay}ms` }}>{children}</span>;
}
export const SHIMMER_MS = 2000;

/**
 * A loading block in place of a grey skeleton bar: the skeleton's own class keeps its size (so nothing moves when the
 * data lands), with a small LED panel and a plain line saying what EKO is doing.
 */
export function LedWait({ className = '', text = 'Reading the chain…', label, pattern = 'ring', size = 20, style }: { className?: string; text?: string; label?: string; pattern?: LedPattern; size?: number; style?: CSSProperties }) {
  return <div className={`led-wait ${className}`} role="status" aria-label={label} style={style}><LedMatrix pattern={pattern} size={size} /><Shimmer>{text}</Shimmer></div>;
}

/**
 * True from the moment `value` turns into `target` while the component is mounted, until `end` is called. Arriving
 * at `target` from nothing (the first load) does not count: only a change from another known value does.
 */
/** Whether a change from `before` to `value` is a turn into `target` (from another known value, not from nothing). */
export function turnedTo<T>(before: T | undefined | null, value: T | undefined | null, target: T): boolean {
  return before !== undefined && before !== null && before !== target && value === target;
}
export function useTurnedTo<T>(value: T | undefined, target: T): [boolean, () => void] {
  const [playing, setPlaying] = useState(false), prev = useRef(value);
  useEffect(() => {
    const before = prev.current; prev.current = value;
    if (turnedTo(before, value, target)) setPlaying(true);
    else if (value !== target) setPlaying(false);
  }, [value, target]);
  return [playing, () => setPlaying(false)];
}
