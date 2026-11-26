import { useSimple, type ViewChoice } from './choice';
import './simple.css';

const OPTIONS: { value: ViewChoice; label: string }[] = [{ value: 'simple', label: 'Simple' }, { value: 'full', label: 'Full' }];

/** Simple | Full, in the top bar on every page. Switching is instant: the page re-renders in the other view. */
export default function Switch({ compact }: { compact: boolean }) {
  const choice = useSimple(s => s.choice), choose = useSimple(s => s.choose);
  return <div className={`sv-switch${compact ? ' compact' : ''}`} role="radiogroup" aria-label="How much EKO shows" data-walk="switch"
    onKeyDown={(e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); const next = choice === 'simple' ? 'full' : 'simple'; choose(next); (e.currentTarget.querySelector(`[data-value="${next}"]`) as HTMLElement | null)?.focus(); } }}>
    {OPTIONS.map(o => <button key={o.value} type="button" role="radio" data-value={o.value} aria-checked={choice === o.value} tabIndex={choice === o.value ? 0 : -1}
      onClick={(e) => { e.stopPropagation(); choose(o.value); }}>{o.label}</button>)}
  </div>;
}
