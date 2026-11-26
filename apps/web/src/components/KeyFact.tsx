import type { ComponentType, ReactNode } from 'react';
import { IconAlert, IconCheck, IconInfo, IconOct } from './icons';
import type { GlanceTone } from './GlanceTile';

/**
 * One key fact in a short list of facts about a coin (coin slot `fact`, features.ts): a label of a word or two with its
 * tone's icon, one short figure under it, and optionally a plain line. A list item: the page that lists facts gives the
 * list and its look.
 */
const ICON: Record<GlanceTone, ComponentType<{ size?: number }>> = { good: IconCheck, watch: IconAlert, bad: IconOct, neutral: IconInfo };
export function KeyFact({ label, value, line, tone = 'neutral', title }: { label: string; value: ReactNode; line?: ReactNode; tone?: GlanceTone; title?: string }) {
  const Icon = ICON[tone];
  return <li className={`key-fact tone-${tone}`} title={title}>
    <span className="key-fact-label"><Icon size={13} />{label}</span>
    <b className="num">{value}</b>
    {line && <span className="key-fact-line">{line}</span>}
  </li>;
}
