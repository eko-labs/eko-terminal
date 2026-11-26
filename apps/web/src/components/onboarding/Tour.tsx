import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMedia } from '../../lib/useMedia';
import { useOnboarding } from '../../store/onboarding';
import { IconClose } from '../icons';
import { POINTERS, availableTourSteps, findAnchor, openMobile } from './steps';
import { useDialog } from './useDialog';
import { Hole, Spotlight, sheetOnTop, useAnchor, usePlacement, type SpotlightStep } from './Spotlight';

export { tourKeyboard } from './Spotlight';

/** The guided tour and the checklist's "Show me" hints. Hidden while another walkthrough is in charge (store `guide`). */
export default function Tour() {
  const tour = useOnboarding((s) => s.tour);
  const pointer = useOnboarding((s) => s.pointer);
  const guided = useOnboarding((s) => !!s.guide);
  const isMobile = useMedia('(max-width: 900px)');
  if (guided) return null;
  if (tour) return <TourRunner isMobile={isMobile} />;
  if (pointer) return <PointerRunner key={pointer} isMobile={isMobile} />;
  return null;
}

function TourRunner({ isMobile }: { isMobile: boolean }) {
  const step = useOnboarding((s) => s.tour?.step ?? 0);
  const setTourStep = useOnboarding((s) => s.setTourStep);
  const endTour = useOnboarding((s) => s.endTour);
  const [available] = useState(availableTourSteps);
  // Phones: each step shows the part of the screen that holds its element.
  const steps = useMemo<SpotlightStep[]>(() => available.map((s) => ({
    id: s.anchor, find: () => findAnchor(s.anchor), title: s.title, body: s.body, ...(s.placement ? { placement: s.placement } : {}),
    onEnter: () => { if (isMobile) openMobile(s.mobileSheet ?? 'none'); },
  })), [available, isMobile]);
  const finish = useCallback(() => {
    endTour();
    if (isMobile) openMobile('none');
  }, [endTour, isMobile]);
  return <Spotlight steps={steps} step={step} onStep={setTourStep} onDone={finish} isMobile={isMobile} />;
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

  const { status, rect } = useAnchor(() => findAnchor(def?.anchor ?? 'scan'), def?.anchor ?? 'scan', 1200, isMobile ? 'start' : 'nearest');
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
      {!isMobile && status === 'found' ? <Hole rect={rect} ring /> : null}
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
