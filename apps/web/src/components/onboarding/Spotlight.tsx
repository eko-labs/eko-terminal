import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { prefersReducedMotion, useDialog } from './useDialog';

/**
 * A spotlight walkthrough: the screen darkens except the one element a step explains, and a short card sits next to it
 * with Next and Skip. Steps find their own element (`find`); a step whose element is not on screen is passed over in the
 * direction the reader was going. The guided tour (Tour.tsx) is one; anything else that walks someone through the
 * screen uses this too, so every walkthrough looks and behaves the same (keyboard: ←/→ move, Escape skips).
 */
export type Rect = { left: number; top: number; width: number; height: number };
export type Placement = 'right' | 'left' | 'top' | 'bottom' | 'inside';

const PAD = 6;
const GAP = 14;
const MARGIN = 12;

export interface SpotlightStep {
  /** Names the step on the overlay (`data-anchor`), for styles and checks. */
  id: string;
  /** The element this step explains, or null while it is not on screen. */
  find(): HTMLElement | null;
  title: ReactNode;
  body: ReactNode;
  placement?: Exclude<Placement, 'inside'>;
  /** Called when the step opens (e.g. to open the part of the screen that holds its element). */
  onEnter?(): void;
}

/** Where a walkthrough goes from step `index` moving `dir`: the next index, 'done' past the last, or null before the first. */
export function stepTo(index: number, dir: 1 | -1, total: number): number | 'done' | null {
  const n = index + dir;
  return n < 0 ? null : n >= total ? 'done' : n;
}
/** Step `index`'s element is not on screen: keep going the way the reader was going; before the first, go forward. */
export function stepPastMissing(index: number, dir: 1 | -1, total: number): { to: number | 'done'; dir: 1 | -1 } {
  const n = index + dir;
  if (n < 0) return { to: index + 1 >= total ? 'done' : index + 1, dir: 1 };
  return { to: n >= total ? 'done' : n, dir };
}

/** The first element matching `selector` that is actually on screen: not hidden, inert, collapsed or transparent. */
export function findVisible(selector: string): HTMLElement | null {
  return [...document.querySelectorAll<HTMLElement>(selector)].find(el => {
    if (el.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width >= 2 && r.height >= 2 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
  }) ?? null;
}

/**
 * Resolve a step's element (waiting briefly for it to mount), scroll it into view, then follow its box every frame so
 * the spotlight stays glued through resizes, scrolls and layout changes. `key` names the step: a new key starts over.
 */
export function useAnchor(find: () => HTMLElement | null, key: string, waitMs: number, block: ScrollLogicalPosition = 'nearest') {
  const [status, setStatus] = useState<'searching' | 'found' | 'missing'>('searching');
  const [rect, setRect] = useState<Rect | null>(null);
  const finder = useRef(find);
  finder.current = find;
  useEffect(() => {
    if (!key) return;
    let raf = 0;
    let el: HTMLElement | null = null;
    let last = '';
    let scrolled = false;
    const t0 = performance.now();
    setStatus('searching');
    setRect(null);
    const tick = () => {
      const visible = finder.current();
      if (!el || el !== visible) {
        el = visible;
        if (!el) {
          setRect(null);
          if (performance.now() - t0 > waitMs) {
            setStatus('missing');
            return;
          }
          raf = requestAnimationFrame(tick);
          return;
        }
        setStatus('found');
        if (!scrolled) {
          scrolled = true;
          el.scrollIntoView({ block, inline: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
        }
      }
      const r = el.getBoundingClientRect();
      const box = `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}`;
      if (box !== last) {
        last = box;
        setRect({ left: r.left, top: r.top, width: r.width, height: r.height });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [key, waitMs, block]);
  return { status, rect };
}

/** Choose where the coach mark goes: beside the element if it fits, else above/below, else inside it. */
function place(r: Rect, cw: number, ch: number, prefer?: Placement): { left: number; top: number; side: Placement; arrow: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const hole = { left: r.left - PAD, top: r.top - PAD, right: r.left + r.width + PAD, bottom: r.top + r.height + PAD };
  const fits: Record<Exclude<Placement, 'inside'>, boolean> = {
    right: hole.right + GAP + cw <= vw - MARGIN,
    left: hole.left - GAP - cw >= MARGIN,
    bottom: hole.bottom + GAP + ch <= vh - MARGIN,
    top: hole.top - GAP - ch >= MARGIN,
  };
  const order: Exclude<Placement, 'inside'>[] = ['right', 'left', 'bottom', 'top'];
  const side: Placement = prefer && prefer !== 'inside' && fits[prefer] ? prefer : (order.find((s) => fits[s]) ?? 'inside');
  const clampX = (x: number) => Math.max(MARGIN, Math.min(vw - cw - MARGIN, x));
  const clampY = (y: number) => Math.max(MARGIN, Math.min(vh - ch - MARGIN, y));
  const midX = r.left + r.width / 2;
  const midY = r.top + r.height / 2;
  let left: number;
  let top: number;
  if (side === 'right' || side === 'left') {
    left = side === 'right' ? hole.right + GAP : hole.left - GAP - cw;
    top = clampY(midY - ch / 2);
    return { left, top, side, arrow: Math.max(16, Math.min(ch - 16, midY - top)) };
  }
  if (side === 'top' || side === 'bottom') {
    left = clampX(midX - cw / 2);
    top = side === 'bottom' ? hole.bottom + GAP : hole.top - GAP - ch;
    return { left, top, side, arrow: Math.max(16, Math.min(cw - 16, midX - left)) };
  }
  // Too big to sit beside (e.g. the chart): float inside its lower-left corner.
  left = clampX(Math.max(r.left, 0) + 20);
  top = clampY(Math.min(r.top + r.height, vh) - ch - 20);
  return { left, top, side, arrow: 0 };
}

/** Phones: the step sheet docks at the top when its element sits in the lower half (e.g. Buy and Sell). */
export function sheetOnTop(rect: Rect | null): boolean {
  return !!rect && rect.top + rect.height / 2 > window.innerHeight / 2;
}

/** Phones: the part of the element the step sheet doesn't cover (no ring if it's hidden behind it). */
function uncovered(rect: Rect | null, sheet: HTMLElement | null, onTop: boolean): Rect | null {
  if (!rect || !sheet) return null;
  // Layout height: unaffected by the sheet's slide-in transform. 8px margin + 10px gap.
  const h = sheet.offsetHeight + 18;
  const top = Math.max(rect.top, onTop ? h : 64);
  const bottom = Math.min(rect.top + rect.height, onTop ? window.innerHeight - 6 : window.innerHeight - h);
  if (bottom - top < 24) return null;
  const left = Math.max(rect.left, 6);
  return { left, top, width: Math.min(rect.width, window.innerWidth - 12 - left), height: bottom - top };
}

/** The lit hole over the element (the rest of the screen darkened), or a ring around it without the darkening. */
export function Hole({ rect, ring = false }: { rect: Rect | null; ring?: boolean }) {
  if (!rect) return <div className={`tour-hole is-empty ${ring ? 'is-ring' : ''}`} />;
  return (
    <div
      className={`tour-hole ${ring ? 'is-ring' : ''}`}
      style={{ transform: `translate3d(${Math.round(rect.left - PAD)}px, ${Math.round(rect.top - PAD)}px, 0)`, width: Math.round(rect.width + PAD * 2), height: Math.round(rect.height + PAD * 2) }}
    />
  );
}

/** Positions a coach-mark card next to `rect` by writing styles directly (no re-render per frame). */
export function usePlacement(cardRef: RefObject<HTMLDivElement | null>, rect: Rect | null, prefer: Placement | undefined, deps: unknown[]) {
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    if (!rect) {
      card.dataset.side = 'center';
      card.style.left = '';
      card.style.top = '';
      return;
    }
    const p = place(rect, card.offsetWidth, card.offsetHeight, prefer);
    card.dataset.side = p.side;
    card.style.left = `${Math.round(p.left)}px`;
    card.style.top = `${Math.round(p.top)}px`;
    card.style.setProperty('--arrow', `${Math.round(p.arrow)}px`);
  }, [rect, prefer, cardRef, ...deps]);
}

/** Escape skips even when focus is still in an input; ←/→ move from anywhere else on the page. */
export function tourKeyboard(e: KeyboardEvent, go: (direction: 1 | -1) => void, finish: () => void) {
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(); return; }
  const target = e.target as HTMLElement;
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    e.preventDefault(); e.stopPropagation(); go(e.key === 'ArrowRight' ? 1 : -1);
  }
}

export interface SpotlightProps {
  steps: readonly SpotlightStep[];
  /** The open step (controlled), and where to move it. */
  step: number;
  onStep(step: number): void;
  /** Finished or skipped. */
  onDone(): void;
  /** The last step's main button was pressed (default: onDone), so a walkthrough can end on an action of its own. */
  onFinish?(): void;
  isMobile: boolean;
  /**
   * Phones: 'sheet' docks the card as a sheet and rings the element without darkening the screen; 'float' keeps the
   * desktop layout on every width (the screen darkens and the card sits next to the element).
   */
  phone?: 'sheet' | 'float';
  /** A count and a bar, or a dot per step. */
  progress?: 'bar' | 'dots';
  /** Button words; `back: null` leaves the Back button (and the ←/→ hint) out. */
  labels?: { skip: string; back: string | null; next: string; finish: string };
  /** How long a step waits for its element to appear before it is passed over. */
  waitMs?: (index: number) => number;
  className?: string;
  /** Prefix of the overlay's test ids and element ids. */
  name?: string;
}
const TOUR_LABELS = { skip: 'Skip tour', back: 'Back', next: 'Next', finish: 'Finish' };

export function Spotlight({ steps, step, onStep, onDone, onFinish, isMobile, phone = 'sheet', progress = 'bar', labels = TOUR_LABELS, waitMs = (i) => (i === 0 ? 2500 : 900), className = '', name = 'tour' }: SpotlightProps) {
  const dir = useRef<1 | -1>(1);
  const cardRef = useRef<HTMLDivElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const total = steps.length;
  const idx = Math.max(0, Math.min(total - 1, step));
  const def = steps[idx];
  const last = idx === total - 1;
  const sheet = isMobile && phone === 'sheet';

  const go = useCallback(
    (d: 1 | -1) => {
      dir.current = d;
      const to = stepTo(idx, d, total);
      if (to === null) return;
      if (to === 'done') (onFinish ?? onDone)();
      else onStep(to);
    },
    [idx, total, onDone, onFinish, onStep],
  );

  useEffect(() => {
    def?.onEnter?.();
  }, [def]);

  // Stops whose element is no longer visible are passed over.
  const { status, rect } = useAnchor(def?.find ?? (() => null), def ? `${idx}:${def.id}` : 'none', waitMs(idx), sheet ? 'start' : phone === 'float' && isMobile ? 'center' : 'nearest');
  useEffect(() => {
    if (total > 0 && status !== 'missing') return;
    const next = stepPastMissing(idx, dir.current, total);
    dir.current = next.dir;
    if (next.to === 'done') onDone();
    else onStep(next.to);
  }, [status, idx, total, onDone, onStep]);

  useDialog(cardRef, { onEscape: onDone, trap: !sheet });

  useEffect(() => {
    const h = (e: KeyboardEvent) => tourKeyboard(e, go, onDone);
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, [go, onDone]);

  // Keep focus on the primary button as steps change, so Enter keeps going.
  useEffect(() => {
    const t = window.setTimeout(() => {
      if (cardRef.current && !cardRef.current.contains(document.activeElement)) nextRef.current?.focus({ preventScroll: true });
    }, 60);
    return () => clearTimeout(t);
  }, [idx]);

  usePlacement(cardRef, sheet ? null : status === 'found' ? rect : null, def?.placement, [idx, sheet]);

  if (!def) return null;
  const showCard = status === 'found';
  const pct = ((idx + 1) / total) * 100;
  const onTop = sheet && status === 'found' && sheetOnTop(rect);
  const mobileRing = sheet && status === 'found' ? uncovered(rect, cardRef.current, onTop) : null;
  return (
    <div className={`ob-root tour ${sheet ? 'tour--mobile' : 'tour--desktop'}${phone === 'float' ? ' tour--float' : ''}${className ? ` ${className}` : ''}`} data-anchor={def.id} data-testid={name}>
      {!sheet ? (
        <>
          <div className="tour-block" onPointerDown={(e) => e.preventDefault()} />
          <Hole rect={status === 'found' ? rect : null} />
        </>
      ) : mobileRing ? (
        <Hole rect={mobileRing} ring />
      ) : null}
      <div className="sr-only" aria-live="polite">
        {showCard ? `Step ${idx + 1} of ${total}: ${typeof def.title === 'string' ? def.title : ''}` : ''}
      </div>
      <div
        ref={cardRef}
        className={`tour-card ${sheet ? 'tour-sheet' : ''} ${onTop ? 'is-top' : ''} ${showCard ? '' : 'is-hidden'}`}
        role="dialog"
        aria-modal={!sheet}
        aria-labelledby={`${name}-title`}
        aria-describedby={`${name}-body`}
        data-testid={`${name}-card`}
        data-step={def.id}
        key={sheet ? 'sheet' : 'card'}
      >
        <div className="tour-top">
          {progress === 'dots' ? (
            <span className="tour-dots" data-testid={`${name}-count`} aria-label={`Step ${idx + 1} of ${total}`}>
              {steps.map((s, i) => <i key={s.id} className={i === idx ? 'on' : i < idx ? 'past' : undefined} />)}
            </span>
          ) : (
            <>
              <span className="tour-count num" data-testid={`${name}-count`}>
                {idx + 1} / {total}
              </span>
              <span className="tour-bar" aria-hidden>
                <span style={{ width: `${pct}%` }} />
              </span>
            </>
          )}
          {progress === 'dots' && <span className="grow" />}
          <button className="tour-skip" onClick={onDone} data-testid={`${name}-skip`}>
            {labels.skip}
          </button>
        </div>
        <h3 id={`${name}-title`} key={`t${idx}`} className="tour-title">
          {def.title}
        </h3>
        <p id={`${name}-body`} key={`b${idx}`} className="tour-body">
          {def.body}
        </p>
        <div className="tour-actions">
          {!isMobile && labels.back !== null ? (
            <span className="tour-keys" aria-hidden>
              <span className="kbd">←</span>
              <span className="kbd">→</span>
            </span>
          ) : null}
          <span className="grow" />
          {labels.back !== null && (
            <button className="btn ghost" onClick={() => go(-1)} disabled={idx === 0} data-testid={`${name}-back`}>
              {labels.back}
            </button>
          )}
          <button ref={nextRef} className="btn primary" onClick={() => go(1)} data-autofocus data-testid={`${name}-next`}>
            {last ? labels.finish : labels.next}
          </button>
        </div>
      </div>
    </div>
  );
}
