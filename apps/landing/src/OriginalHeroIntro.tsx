import { useEffect, useRef, useState } from "react";
import type { SignalRenderer } from "./lib/original-signal-renderer";
import { INTRO_CAPTIONS, INTRO_SCREENS } from "./intro-captions";

export default function OriginalHeroIntro({
  onComplete,
  onError,
  onSkip,
}: {
  onComplete: () => void;
  onError: () => void;
  onSkip: () => void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  const [percent, setPercent] = useState(0);
  const [chapter, setChapter] = useState(0);

  useEffect(() => {
    const scroller = viewport.current!;
    const element = canvas.current!;
    const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
    let disposed = false,
      frame = 0,
      finish = 0,
      progress = 0;
    let renderer: SignalRenderer | undefined;
    let renderProgress: (() => void) | undefined;
    // Only renderer startup is timed. The visitor controls the whole timeline.
    const initialization = window.setTimeout(onError, 12000);
    const requestPaint = () => {
      if (disposed || frame || !renderProgress) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        renderProgress?.();
      });
    };
    const onLost = (event: Event) => {
      event.preventDefault();
      onError();
    };
    element.addEventListener("webglcontextlost", onLost);
    scroller.addEventListener("scroll", requestPaint, { passive: true });
    motionPreference.addEventListener("change", requestPaint);
    let observer: ResizeObserver | undefined;

    import("./lib/original-signal-renderer")
      .then(({ SignalRenderer, scrollToClock, chapters }) => {
        if (disposed) return;
        renderer = new SignalRenderer(element);
        renderProgress = () => {
          if (disposed) return;
          const distance = scroller.scrollHeight - scroller.clientHeight;
          progress =
            distance > 0
              ? Math.min(1, Math.max(0, scroller.scrollTop / distance))
              : 0;
          const clock = scrollToClock(progress);
          const index = chapters.findIndex((c) => clock >= c.start && clock < c.end);
          setChapter(index < 0 ? chapters.length - 1 : index);
          try {
            // Keep the opening and its scroll progress for everyone. Reduced
            // motion holds the original opening artwork instead of animating it.
            renderer!.renderAt(motionPreference.matches ? scrollToClock(0) : clock);
          } catch {
            onError();
            return;
          }
          const complete = distance > 0 && distance - scroller.scrollTop <= 1;
          setPercent(complete ? 100 : Math.min(99, Math.floor(progress * 100)));
          if (complete && !finish) finish = window.setTimeout(onComplete, 350);
          else if (!complete) {
            clearTimeout(finish);
            finish = 0;
          }
        };
        observer = new ResizeObserver(() => {
          // The whole timeline over a few screens; chapter proportions are retained by scrollToClock.
          scroller.style.setProperty(
            "--eko-runway-screens",
            String(innerWidth < 700 ? INTRO_SCREENS.phone : INTRO_SCREENS.desktop),
          );
          renderer!.resize();
          scroller.scrollTop =
            progress * (scroller.scrollHeight - scroller.clientHeight);
          requestPaint();
        });
        observer.observe(scroller);
        renderProgress();
        clearTimeout(initialization);
        setReady(true);
        scroller.focus({ preventScroll: true });
      })
      .catch(() => {
        if (!disposed) onError();
      });

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      clearTimeout(finish);
      clearTimeout(initialization);
      observer?.disconnect();
      element.removeEventListener("webglcontextlost", onLost);
      scroller.removeEventListener("scroll", requestPaint);
      motionPreference.removeEventListener("change", requestPaint);
      renderer?.destroy();
    };
  }, [onComplete, onError]);

  return (
    <div
      ref={viewport}
      className="eko-original-intro"
      data-ready={ready}
      role="region"
      aria-label="Scroll through the EKO animation"
      tabIndex={0}
    >
      <div className="eko-intro-runway">
        <div className="eko-intro-stage">
          <canvas ref={canvas} aria-hidden="true" />
          <div className="eko-intro-brand">
            <span className="eko-intro-wordmark">EKO</span>
            <span className="eko-intro-tagline">A trench terminal for Elysium</span>
          </div>
          <div className="eko-intro-caption" key={chapter} aria-live="polite">
            <span className="eko-intro-eyebrow">
              {String(chapter + 1).padStart(2, "0")} / {INTRO_CAPTIONS[chapter].eyebrow}
            </span>
            <p className="eko-intro-headline">{INTRO_CAPTIONS[chapter].headline}</p>
            <p className="eko-intro-support">{INTRO_CAPTIONS[chapter].support}</p>
          </div>
          <div className="eko-intro-hud">
            <span className="eko-intro-hint" aria-hidden="true">
              {percent === 100 ? "ENTERING" : "SCROLL ↓"}
            </span>
            <div
              className="eko-intro-progress"
              role="progressbar"
              aria-label="Animation progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
            >
              <span className="eko-intro-percent">
                {String(percent).padStart(2, "0")}
                <small>%</small>
              </span>
              <span className="eko-intro-track" aria-hidden="true">
                <i style={{ transform: `scaleX(${percent / 100})` }} />
              </span>
            </div>
          </div>
          <div className="eko-intro-actions">
            <a className="eko-intro-open" href="/radar">
              Open terminal <span aria-hidden="true">↗</span>
            </a>
            <button type="button" className="eko-intro-skip" onClick={onSkip}>
              Skip intro <span aria-hidden="true">↓</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
