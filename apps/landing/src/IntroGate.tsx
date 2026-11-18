import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import "./intro-gate.css";
import OriginalHeroIntro from "./OriginalHeroIntro";
import { INTRO_SEEN_KEY } from "./intro-captions";
import { IntroCovered } from "./intro-state";

/** The intro plays again once this long has passed since it last played (a first visit always plays it). */
export const INTRO_REPLAY_MS = 3 * 24 * 3600 * 1000;
/** Recent visitors and anyone who prefers reduced motion go straight to the landing. The key holds when the intro last
 *  played; the old "1" (seen at some point) reads as long ago, so returning visitors see it once more. */
export function introAlreadySeen(now = Date.now()) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return true;
  try {
    const at = Number(localStorage.getItem(INTRO_SEEN_KEY) ?? 0);
    return at > 1 && now - at < INTRO_REPLAY_MS;
  } catch {
    return false;
  }
}
function rememberIntroSeen() {
  try {
    localStorage.setItem(INTRO_SEEN_KEY, String(Date.now()));
  } catch {
    // Storage can be unavailable (private mode); the intro then plays again next time.
  }
}

type Phase = "opening" | "fading" | "ready";

export default function IntroGate({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>(() => (introAlreadySeen() ? "ready" : "opening"));
  const showsIntro = useRef(phase === "opening");
  const content = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef(false);
  const reveal = useCallback(() => {
    rememberIntroSeen();
    setPhase((current) => (current === "opening" ? "fading" : current));
  }, []);
  const skip = useCallback(() => {
    restoreFocus.current = true;
    reveal();
  }, [reveal]);

  useLayoutEffect(() => {
    // Without the intro, deep links and scroll restoration behave normally.
    if (!showsIntro.current) return;
    const previousRestoration = history.scrollRestoration;
    history.scrollRestoration = "manual";
    // Every fresh landing entry starts here, including bookmarks to a section.
    history.replaceState(history.state, "", location.pathname + location.search);
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    const onReturn = (event: PageTransitionEvent) => {
      if (!event.persisted || introAlreadySeen()) return;
      history.replaceState(history.state, "", location.pathname + location.search);
      window.scrollTo({ top: 0, left: 0, behavior: "instant" });
      setPhase("opening");
    };
    window.addEventListener("pageshow", onReturn);
    return () => {
      history.scrollRestoration = previousRestoration;
      window.removeEventListener("pageshow", onReturn);
    };
  }, []);

  useLayoutEffect(() => {
    // Reset after the overlay releases the landing.
    if (showsIntro.current) window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  }, [phase]);

  useEffect(() => {
    if (phase === "ready") return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        restoreFocus.current = true;
        reveal();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [phase, reveal]);

  useEffect(() => {
    if (phase !== "fading") return;
    const duration = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 900;
    const timeout = window.setTimeout(() => setPhase("ready"), duration);
    return () => window.clearTimeout(timeout);
  }, [phase]);

  useEffect(() => {
    if (phase === "ready" && restoreFocus.current)
      content.current?.focus({ preventScroll: true });
  }, [phase]);

  return (
    <>
      {/* The landing is mounted under the intro, so it is ready (and readable by crawlers) from the start. */}
      <div
        ref={content}
        className="eko-entry-content"
        tabIndex={-1}
        inert={phase !== "ready"}
        aria-hidden={phase !== "ready" || undefined}
      >
        <IntroCovered.Provider value={phase === "opening"}>{children}</IntroCovered.Provider>
      </div>
      {phase !== "ready" && (
        <div
          className="eko-entry"
          data-phase={phase}
          role="dialog"
          aria-modal="true"
          aria-label="EKO opening animation"
        >
          <OriginalHeroIntro
            onComplete={reveal}
            onError={reveal}
            onSkip={skip}
          />
        </div>
      )}
    </>
  );
}
