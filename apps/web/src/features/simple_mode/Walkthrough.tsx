import { useCallback, useEffect, useMemo, useState } from 'react';
import { Spotlight, findVisible, type SpotlightStep } from '../../components/onboarding/Spotlight';
import { prefersReducedMotion } from '../../components/onboarding/useDialog';
import { useMedia } from '../../lib/useMedia';
import { useSimple, type Walk } from './choice';

/**
 * Simple's walkthroughs: the screen darkens except the one thing a step explains, with a short card beside it. Each
 * runs once on this device (the first Simple coins list, the first Simple coin page) and the coins list's can be
 * replayed from Help. Steps find their element by `data-walk`; a step whose element is not on screen is passed over.
 */
/** `within`: narrower targets inside the step's `data-walk` element, tried in order before the element itself. */
export interface WalkStep { id: string; title: string; body: string; placement?: SpotlightStep['placement']; within?: string[] }
const LABELS = { skip: 'Skip', back: null, next: 'Next', finish: 'Got it' };

export const LIST_WALK: WalkStep[] = [
  { id: 'list', title: 'New coins', body: 'These are new coins. EKO checks every one.' },
  { id: 'answer', title: 'Is it safe?', body: "This tells you if a coin looks safe: Looks OK, Be careful or Don't buy." },
  { id: 'search', title: 'Check any coin', body: 'Got a coin from a friend? Paste its address here.', placement: 'bottom' },
  { id: 'switch', title: 'Simple or Full', body: 'Simple gives you the answer. Full shows every number and chart. Experienced? Try Full.', placement: 'bottom' },
];
/** The coins list walkthrough ends on the switch with "Show me Full": it switches, and Full explains itself (Switch.tsx). */
export const LIST_FINISH = 'Show me Full';
/** The card Full shows on the switch right after "Show me Full". */
export const FULL_STEP: WalkStep = { id: 'switch', title: 'This is Full', body: 'Every number, chart and check. Tap Simple to go back anytime.', placement: 'bottom' };
export function coinWalk(dont: boolean): WalkStep[] {
  return [
    { id: 'answer', title: "EKO's answer", body: "This is EKO's answer for this coin, in a word or two." },
    { id: 'sell', title: 'Can you sell it later?', body: "Some coins can't be sold once bought. EKO checks for you." },
    dont
      ? { id: 'buy', title: 'Find a safer coin', body: "When EKO says Don't buy, this shows coins that look OK." }
      : { id: 'buy', title: 'Buy with one button', body: 'Pick an amount, then your wallet signs. EKO never holds your money.', within: ['.tp-submit', '.tp-sides'] },
  ];
}

/** The element a step lights: the first visible of its narrower targets, else its own `data-walk` element. */
function findStep(s: WalkStep): HTMLElement | null {
  for (const inner of s.within ?? []) { const el = findVisible(`[data-walk="${s.id}"] ${inner}`); if (el) return el; }
  return findVisible(`[data-walk="${s.id}"]`);
}

/** Starts `walk` once its page is ready, unless it already ran on this device; renders it while it runs. */
export function Walkthrough({ walk, steps, ready, finish, onFinish }: { walk: Walk; steps: WalkStep[]; ready: boolean; finish?: string; onFinish?: () => void }) {
  const running = useSimple(s => s.walk), seen = useSimple(s => s.walked.includes(walk));
  const isMobile = useMedia('(max-width: 900px)');
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (ready && !seen && running === null) useSimple.getState().startWalk(walk);
  }, [ready, seen, running, walk]);
  useEffect(() => { if (running === walk) setStep(0); }, [running, walk]);
  // Leaving the page stops its walkthrough (it shows again next time, as it was not finished).
  useEffect(() => () => { if (useSimple.getState().walk === walk) useSimple.setState({ walk: null }); }, [walk]);
  const spots = useMemo<SpotlightStep[]>(() => steps.map(s => ({ id: s.id, find: () => findStep(s), title: s.title, body: s.body, ...(s.placement ? { placement: s.placement } : {}) })), [steps]);
  const done = useCallback(() => {
    useSimple.getState().endWalk();
    window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }, []);
  if (running !== walk || !ready) return null;
  return <Spotlight steps={spots} step={step} onStep={setStep} onDone={done} {...(onFinish ? { onFinish: () => { useSimple.getState().endWalk(); onFinish(); } } : {})}
    isMobile={isMobile} phone="float" progress="dots" labels={finish ? { ...LABELS, finish } : LABELS} name="walk" className="sv-walk" waitMs={i => (i === 0 ? 2500 : 1200)} />;
}

/** One card on the switch in Full, right after the coins list walkthrough's "Show me Full": go back, or stay. */
export function FullIntro({ phone }: { phone: boolean }) {
  return useSimple(s => s.tryFull) ? <FullIntroCard phone={phone} /> : null;
}
function FullIntroCard({ phone }: { phone: boolean }) {
  const isMobile = useMedia('(max-width: 899px)');
  const spots = useMemo<SpotlightStep[]>(() => [{ id: FULL_STEP.id, find: () => findStep(FULL_STEP), title: FULL_STEP.title, body: FULL_STEP.body, placement: 'bottom' }], []);
  // The switch is in the desktop header and the phone bar: only the one on screen shows the card.
  if (phone !== isMobile) return null;
  const end = () => useSimple.setState({ tryFull: false });
  return <Spotlight steps={spots} step={0} onStep={() => {}} onDone={end} onFinish={() => { end(); useSimple.getState().choose('simple'); }}
    isMobile={isMobile} phone="float" progress="dots" labels={{ skip: 'Stay in Full', back: null, next: 'Next', finish: 'Back to Simple' }} name="walk-full" className="sv-walk" />;
}
