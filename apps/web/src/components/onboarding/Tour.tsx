import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { useMedia } from '../../lib/useMedia';
import { useOnboarding, type TourAnchor } from '../../store/onboarding';
import { IconClose } from '../icons';
import { POINTERS, availableTourSteps, findAnchor, openMobile } from './steps';
import { prefersReducedMotion, useDialog } from './useDialog';

type Rect = { left: number; top: number; width: number; height: number };
type Placement = 'right' | 'left' | 'top' | 'bottom' | 'inside';

const PAD = 6;
const GAP = 14;
const MARGIN = 12;

/**
 * Resolve an anchor element (waiting briefly for it to mount), scroll it into view, then follow its
 * box every frame so the spotlight stays glued through resizes, scrolls and layout changes.
 */
function useAnchor(anchor: TourAnchor, waitMs: number, block: ScrollLogicalPosition = 'nearest') {
  const [status, setStatus] = useState<'searching' | 'found' | 'missing'>('searching');
  const [rect, setRect] = useState<Rect | null>(null);
  useEffect(() => {
    if (!anchor) return;
    let raf = 0;
    let el: HTMLElement | null = null;
    let last = '';
    let scrolled = false;
    const t0 = performance.now();
    setStatus('searching');
    setRect(null);
    const tick = () => {
      const visible = findAnchor(anchor);
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
      const key = `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}`;
      if (key !== last) {
        last = key;
        setRect({ left: r.left, top: r.top, width: r.width, height: r.height });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [anchor, waitMs, block]);
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
function sheetOnTop(rect: Rect | null): boolean {
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

function Spotlight({ rect, ring = false }: { rect: Rect | null; ring?: boolean }) {
  if (!rect) return <div className={`tour-hole is-empty ${ring ? 'is-ring' : ''}`} />;
  return (
    <div
      className={`tour-hole ${ring ? 'is-ring' : ''}`}
      style={{ transform: `translate3d(${Math.round(rect.left - PAD)}px, ${Math.round(rect.top - PAD)}px, 0)`, width: Math.round(rect.width + PAD * 2), height: Math.round(rect.height + PAD * 2) }}
    />
  );
}

/** Positions a coach-mark card next to `rect` by writing styles directly (no re-render per frame). */
function usePlacement(cardRef: RefObject<HTMLDivElement | null>, rect: Rect | null, prefer: Placement | undefined, deps: unknown[]) {
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

export default function Tour() {
  const tour = useOnboarding((s) => s.tour);
  const pointer = useOnboarding((s) => s.pointer);
  const isMobile = useMedia('(max-width: 900px)');
  if (tour) return <TourRunner isMobile={isMobile} />;
  if (pointer) return <PointerRunner key={pointer} isMobile={isMobile} />;
  return null;
}

function TourRunner({ isMobile }: { isMobile: boolean }) {
  const step = useOnboarding((s) => s.tour?.step ?? 0);
  const setTourStep = useOnboarding((s) => s.setTourStep);
  const endTour = useOnboarding((s) => s.endTour);
  const dir = useRef<1 | -1>(1);
  const cardRef = useRef<HTMLDivElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const [steps] = useState(availableTourSteps);
  const total = steps.length;
  const idx = Math.max(0, Math.min(total - 1, step));
  const def = steps[idx];
  const last = idx === total - 1;

  const finish = useCallback(() => {
    endTour();
    if (isMobile) openMobile('none');
  }, [endTour, isMobile]);

  const go = useCallback(
    (d: 1 | -1) => {
      dir.current = d;
      const n = idx + d;
      if (n < 0) return;
      if (n >= total) finish();
      else setTourStep(n);
    },
    [idx, total, finish, setTourStep],
  );

  // Phones: show the part of the screen that holds this step's element.
  useEffect(() => {
    if (isMobile) openMobile(def?.mobileSheet ?? 'none');
  }, [def, isMobile]);

  // Both layouts skip stops whose implemented anchor is no longer visible.
  const { status, rect } = useAnchor(def?.anchor ?? 'scan', idx === 0 ? 2500 : 900, isMobile ? 'start' : 'nearest');
  useEffect(() => {
    if (total > 0 && status !== 'missing') return;
    const n = idx + dir.current;
    if (n < 0) go(1);
    else if (n >= total) finish();
    else setTourStep(n);
  }, [status, isMobile, idx, total, go, finish, setTourStep]);

  useDialog(cardRef, { onEscape: finish, trap: !isMobile });

  // ←/→ move, from anywhere on the page while the tour is open.
  useEffect(() => {
    const h = (e: KeyboardEvent) => tourKeyboard(e, go, finish);
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, [go, finish]);

  // Keep focus on the primary button as steps change, so Enter keeps going.
  useEffect(() => {
    const t = window.setTimeout(() => {
      if (cardRef.current && !cardRef.current.contains(document.activeElement)) nextRef.current?.focus({ preventScroll: true });
    }, 60);
    return () => clearTimeout(t);
  }, [idx]);

  usePlacement(cardRef, isMobile ? null : status === 'found' ? rect : null, def?.placement, [idx, isMobile]);

  if (!def) return null;
  const showCard = status === 'found';
  const pct = ((idx + 1) / total) * 100;
  const onTop = isMobile && status === 'found' && sheetOnTop(rect);
  const mobileRing = isMobile && status === 'found' ? uncovered(rect, cardRef.current, onTop) : null;
  return (
    <div className={`ob-root tour ${isMobile ? 'tour--mobile' : 'tour--desktop'}`} data-anchor={def.anchor} data-testid="tour">
      {!isMobile ? (
        <>
          <div className="tour-block" onPointerDown={(e) => e.preventDefault()} />
          <Spotlight rect={status === 'found' ? rect : null} />
        </>
      ) : mobileRing ? (
        <Spotlight rect={mobileRing} ring />
      ) : null}
      <div className="sr-only" aria-live="polite">
        {showCard ? `Step ${idx + 1} of ${total}: ${def.title}` : ''}
      </div>
      <div
        ref={cardRef}
        className={`tour-card ${isMobile ? 'tour-sheet' : ''} ${onTop ? 'is-top' : ''} ${showCard ? '' : 'is-hidden'}`}
        role="dialog"
        aria-modal={!isMobile}
        aria-labelledby="tour-title"
        aria-describedby="tour-body"
        data-testid="tour-card"
        data-step={def.anchor}
        key={isMobile ? 'sheet' : 'card'}
      >
        <div className="tour-top">
          <span className="tour-count num" data-testid="tour-count">
            {idx + 1} / {total}
          </span>
          <span className="tour-bar" aria-hidden>
            <span style={{ width: `${pct}%` }} />
          </span>
          <button className="tour-skip" onClick={finish} data-testid="tour-skip">
            Skip tour
          </button>
        </div>
        <h3 id="tour-title" key={`t${idx}`} className="tour-title">
          {def.title}
        </h3>
        <p id="tour-body" key={`b${idx}`} className="tour-body">
          {def.body}
        </p>
        <div className="tour-actions">
          {!isMobile ? (
            <span className="tour-keys" aria-hidden>
              <span className="kbd">←</span>
              <span className="kbd">→</span>
            </span>
          ) : null}
          <span className="grow" />
          <button className="btn ghost" onClick={() => go(-1)} disabled={idx === 0} data-testid="tour-back">
            Back
          </button>
          <button ref={nextRef} className="btn primary" onClick={() => go(1)} data-autofocus data-testid="tour-next">
            {last ? 'Finish' : 'Next'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** "Show me" from the checklist: a non-blocking ring around the real control and a short hint. */
function PointerRunner({ isMobile }: { isMobile: boolean }) {
  const step = useOnboarding((s) => s.pointer)!;
  const clearPointer = useOnboarding((s) => s.clearPointer);
  const def = POINTERS[step];
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isMobile) openMobile(def?.mobileSheet ?? 'none');
  }, [def, isMobile]);

  const { status, rect } = useAnchor(def?.anchor ?? 'scan', 1200, isMobile ? 'start' : 'nearest');
  useDialog(cardRef, { onEscape: clearPointer, trap: false, restore: false });

  // Any press outside the hint dismisses it — including pressing the highlighted control itself —
  // and so does Escape, wherever focus is.
  useEffect(() => {
    const h = (e: PointerEvent) => {
      if (!cardRef.current?.contains(e.target as Node)) clearPointer();
    };
    const k = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      clearPointer();
    };
    const t = window.setTimeout(() => window.addEventListener('pointerdown', h, true), 250);
    window.addEventListener('keydown', k, true);
    return () => {
      clearTimeout(t);
      window.removeEventListener('pointerdown', h, true);
      window.removeEventListener('keydown', k, true);
    };
  }, [clearPointer]);

  usePlacement(cardRef, isMobile ? null : status === 'found' ? rect : null, undefined, [step, isMobile]);

  return (
    <div className={`ob-root tour tour--pointer ${isMobile ? 'tour--mobile' : ''}`} data-anchor={def.anchor} data-testid="pointer">
      {!isMobile && status === 'found' ? <Spotlight rect={rect} ring /> : null}
      <div
        ref={cardRef}
        className={`tour-card tour-card--pointer ${isMobile ? 'tour-sheet' : ''} ${isMobile && status === 'found' && sheetOnTop(rect) ? 'is-top' : ''} ${!isMobile && status === 'searching' ? 'is-hidden' : ''}`}
        role="dialog"
        aria-modal="false"
        aria-labelledby="pointer-title"
        data-testid="pointer-card"
      >
        <div className="tour-top">
          <span className="eyebrow">Show me</span>
          <span className="grow" />
          <button className="icon-btn" onClick={clearPointer} aria-label="Close hint">
            <IconClose size={13} />
          </button>
        </div>
        <h3 id="pointer-title" className="tour-title">
          {def.title}
        </h3>
        <p className="tour-body">{def.body}</p>
        {status === 'missing' && !isMobile ? <p className="tour-body muted">It isn’t on screen right now — open the relevant page and try again.</p> : null}
        <div className="tour-actions">
          <span className="grow" />
          <button className="btn primary sm" onClick={clearPointer} data-autofocus>
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}

/** Escape dismisses even when focus is still in the scanned input. */
export function tourKeyboard(e: KeyboardEvent, go: (direction: 1 | -1) => void, finish: () => void) {
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(); return; }
  const target = e.target as HTMLElement;
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    e.preventDefault(); e.stopPropagation(); go(e.key === 'ArrowRight' ? 1 : -1);
  }
}
