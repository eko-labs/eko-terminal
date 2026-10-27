import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { GLOSSARY } from './glossary';

export type TermId =
  | 'rule_lab'
  | 'paper'
  | 'live'
  | 'slippage'
  | 'gas'
  | 'usdg'
  | 'approval'
  | 'spot_only';

/**
 * Inline glossary term: dotted-underlined text with a short explanation on hover, focus or tap.
 * The definition is also wired to aria-describedby, so screen readers announce it on focus.
 * Don't nest a Term inside a button or link: it is focusable itself.
 */
export function Term({ id, children }: { id: TermId; children: ReactNode }) {
  const entry = GLOSSARY[id];
  const descId = useId();
  const ref = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const hideTimer = useRef<number | null>(null);
  const lastPointer = useRef<string>('mouse');

  const show = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    setOpen(true);
  }, []);
  const hide = useCallback((delay = 0) => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    if (!delay) {
      setOpen(false);
      setPinned(false);
      return;
    }
    hideTimer.current = window.setTimeout(() => {
      setOpen(false);
      setPinned(false);
    }, delay);
  }, []);

  // Position the bubble above the term (or below when there's no room), inside the viewport.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const t = ref.current;
      const tip = tipRef.current;
      if (!t || !tip) return;
      const r = t.getBoundingClientRect();
      const w = tip.offsetWidth;
      const h = tip.offsetHeight;
      const vw = window.innerWidth;
      const below = r.top - h - 10 < 8;
      const left = Math.max(8, Math.min(vw - w - 8, r.left + r.width / 2 - w / 2));
      const top = below ? r.bottom + 8 : r.top - h - 8;
      tip.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
      tip.dataset.side = below ? 'below' : 'above';
      tip.style.setProperty('--arrow-x', `${Math.round(Math.max(12, Math.min(w - 12, r.left + r.width / 2 - left)))}px`);
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open]);

  // Tap-opened bubbles close on Escape or a tap elsewhere.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        hide();
      }
    };
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) hide();
    };
    window.addEventListener('keydown', onKey, true);
    if (pinned) window.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onDown, true);
    };
  }, [open, pinned, hide]);

  useEffect(() => () => void (hideTimer.current && clearTimeout(hideTimer.current)), []);

  if (!entry) return <>{children}</>;
  return (
    <>
      <span
        ref={ref}
        className={`term ${open ? 'is-open' : ''}`}
        data-term={id}
        tabIndex={0}
        aria-describedby={descId}
        onPointerDown={(e) => {
          lastPointer.current = e.pointerType;
        }}
        onPointerEnter={(e) => e.pointerType === 'mouse' && show()}
        onPointerLeave={(e) => e.pointerType === 'mouse' && !pinned && hide(120)}
        onFocus={show}
        onBlur={() => hide()}
        onClick={(e) => {
          // Touch has no hover: a tap toggles the bubble and doesn't trigger whatever contains the term.
          if (lastPointer.current !== 'mouse') {
            e.preventDefault();
            e.stopPropagation();
            if (open && pinned) hide();
            else {
              setPinned(true);
              show();
            }
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (open) hide();
            else show();
          }
        }}
      >
        {children}
      </span>
      <span id={descId} hidden>
        {`${entry.term}: ${entry.short}`}
      </span>
      {open
        ? createPortal(
            <span ref={tipRef} className="term-tip" aria-hidden onPointerEnter={show} onPointerLeave={() => !pinned && hide(120)}>
              <strong>{entry.term}</strong>
              <span>{entry.short}</span>
            </span>,
            document.body,
          )
        : null}
    </>
  );
}
