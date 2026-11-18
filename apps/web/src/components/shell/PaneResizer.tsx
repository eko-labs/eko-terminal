import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useMedia } from '../../lib/useMedia';

/** Side pane widths in CSS px. The default matches --insp in shell.css; the room left for the page is --main-min there. */
export const PANE = { min: 320, max: 760, initial: 392, step: 16, bigStep: 64, mainMin: 560, overlayGap: 120 } as const;
const KEY_PREFIX = 'eko.pane.';

export function clampWidth(width: number, max: number = PANE.max) {
  const ceiling = Math.max(PANE.min, Math.min(PANE.max, max));
  return Math.round(Math.max(PANE.min, Math.min(ceiling, width)));
}
/** The saved width for this pane, or null when none is saved, storage is blocked or the value is junk. */
export function readPaneWidth(key: string): number | null {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + key);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? clampWidth(value) : null;
  } catch { return null; }
}
/** Saves the width for the next visit in this browser; null forgets it. Storage is optional. */
export function savePaneWidth(key: string, width: number | null) {
  try {
    if (width === null) localStorage.removeItem(KEY_PREFIX + key);
    else localStorage.setItem(KEY_PREFIX + key, String(Math.round(width)));
  } catch { /* storage is optional */ }
}
/**
 * The separator's keyboard: the pane sits on the right, so Left widens it and Right narrows it (Shift for bigger
 * steps), Home and End jump to the narrowest and widest, and Enter restores the default. null means "not ours".
 */
export function keyWidth(key: string, shift: boolean, width: number, max: number): number | null {
  const step = shift ? PANE.bigStep : PANE.step;
  switch (key) {
    case 'ArrowLeft': return clampWidth(width + step, max);
    case 'ArrowRight': return clampWidth(width - step, max);
    case 'Home': return PANE.min;
    case 'End': return clampWidth(PANE.max, max);
    case 'Enter': return clampWidth(PANE.initial, max);
    default: return null;
  }
}

/**
 * The drag edge of a right-hand side pane inside a .with-insp layout. It sets --insp on that layout, so the page column
 * takes the rest. It sits outside the pane, because the pane scrolls and an edge inside it would scroll away.
 * Narrow (mobile) layouts keep their full-width sheet and get no edge.
 */
export function PaneResizer({ storageKey, controls, label }: { storageKey: string; controls: string; label: string }) {
  const desktop = useMedia('(min-width:900px)');
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(() => readPaneWidth(storageKey) ?? PANE.initial);
  const [max, setMax] = useState<number>(PANE.max);
  const host = () => ref.current?.closest<HTMLElement>('.with-insp') ?? null;
  /** The widest the pane may be right now: docked panes leave the page its minimum; overlays leave a strip of page. */
  const room = useCallback(() => {
    const el = ref.current, layout = host();
    if (!el || !layout) return PANE.max;
    const overlay = getComputedStyle(el).position === 'fixed';
    return clampWidth(overlay ? window.innerWidth - PANE.overlayGap : layout.clientWidth - PANE.mainMin);
  }, []);
  const apply = useCallback((next: number | null) => {
    const layout = host();
    if (!layout) return;
    if (next === null) layout.style.removeProperty('--insp'); else layout.style.setProperty('--insp', `${next}px`);
  }, []);
  useLayoutEffect(() => {
    if (!desktop) return;
    const saved = readPaneWidth(storageKey);
    apply(saved);
    const fit = () => setMax(room());
    fit(); window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [desktop, storageKey, apply, room]);
  const commit = (next: number | null, save = true) => {
    const value = next ?? PANE.initial;
    setWidth(value); apply(next);
    if (save) savePaneWidth(storageKey, next);
  };
  const drag = useRef<{ x: number; width: number; frame: number; latest: number } | null>(null);
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const pane = document.getElementById(controls);
    const start = pane?.getBoundingClientRect().width ?? width;
    e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); e.currentTarget.focus({ preventScroll: true });
    const ceiling = room(); setMax(ceiling);
    drag.current = { x: e.clientX, width: start, frame: 0, latest: clampWidth(start, ceiling) };
    document.documentElement.classList.add('pane-resizing');
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    d.latest = clampWidth(d.width + d.x - e.clientX, max);
    if (!d.frame) d.frame = requestAnimationFrame(() => { if (drag.current) { drag.current.frame = 0; commit(drag.current.latest, false); } });
  };
  const end = () => {
    const d = drag.current;
    if (!d) return;
    if (d.frame) cancelAnimationFrame(d.frame);
    drag.current = null; document.documentElement.classList.remove('pane-resizing');
    commit(d.latest);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // A modal pane keeps focus in its loop, and the edge is that loop's first stop: Tab enters, Shift+Tab wraps.
    const pane = document.getElementById(controls);
    if (e.key === 'Tab' && pane?.getAttribute('aria-modal') === 'true') {
      const nodes = pane.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),[tabindex="0"]');
      const target = e.shiftKey ? nodes[nodes.length - 1] : nodes[0];
      if (target) { e.preventDefault(); target.focus(); }
      return;
    }
    const next = keyWidth(e.key, e.shiftKey, width, max);
    if (next === null) return;
    e.preventDefault();
    commit(e.key === 'Enter' ? null : next);
  };
  if (!desktop) return null;
  return <div ref={ref} className="pane-resize" role="separator" aria-orientation="vertical" aria-controls={controls} aria-label={label}
    aria-valuemin={PANE.min} aria-valuemax={max} aria-valuenow={Math.min(width, max)} aria-valuetext={`${Math.min(width, max)} pixels wide`} tabIndex={0}
    title="Drag to resize. Double-click to reset."
    onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}
    onDoubleClick={() => commit(null)} onKeyDown={onKeyDown}><span className="pane-grip" aria-hidden="true" /></div>;
}
