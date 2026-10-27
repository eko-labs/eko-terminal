import { useEffect } from 'react';
import { ONBOARDING_VERSION, useOnboarding } from '../../store/onboarding';
import { Link } from '../../lib/Link';
import { usePath } from '../../lib/router';
import Checklist from './Checklist';
import Tour from './Tour';
import { useOnboardingSync } from './sync';
import '../../styles/onboarding.css';

export function Onboarding() {
  useOnboardingSync();
  const path = usePath();
  const s = useOnboarding();
  useEffect(() => { useOnboarding.getState().clearPointer(); }, [path]);
  return <OnboardingView state={s} path={path} />;
}

export function OnboardingView({ state: s, path }: { state: ReturnType<typeof useOnboarding.getState>; path: string }) {
  if (!s.hydrated) return null;
  const offered = s.scanSeen && !s.disabled && (!s.tourDone || s.version < ONBOARDING_VERSION) && (!s.welcomeDone || s.version < ONBOARDING_VERSION);
  return <>
    <Tour key={path} />
    {offered && !s.tour && <aside className="ob-root ob-tour-offer" aria-label="Tour offered">
      <button className="btn" onClick={s.startTour} data-testid="tour-pill">Take the 40-second tour.</button>
      <button className="btn btn-ghost" aria-label="Dismiss tour offer" onClick={s.closeWelcome}>Not now</button>
    </aside>}
    {s.scanSeen && !s.disabled && !offered && !s.tour && !s.pointer && !s.checklistDismissed && <Checklist />}
    {s.helpOpen && <aside className="ob-root ob-cl" aria-label="Help">
      <button className="btn" onClick={s.startTour}>Replay the tour</button>
      <button className="btn" onClick={() => { s.restoreChecklist(); s.closeHelp(); }}>Show checklist</button>
      <Link to="/settings#about" onClick={s.closeHelp}>Help and About</Link>
      <button className="btn" onClick={s.closeHelp}>Close help</button>
    </aside>}
  </>;
}
