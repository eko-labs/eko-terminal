import { NOT_CHECKED_LABEL, NOT_TRACKED_LABEL } from '../../copy/availability';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from 'react';
import type { Level, Untrusted, Verdict, WalletLabel } from '@eko/shared';
import { SCANNING, SCAN_DELAYED, SCAN_DELAYED_DETAIL, NOT_FULLY_CHECKED, NO_FLAGS, missingChecks } from '../../copy/availability';
import { projectGuardLevelToV1, guardInertText, type CoinCardMeta, type PlaybookId, type GuardAssessmentV2 } from '@eko/shared';
import { GUARD_LABELS, GUARD_SHADOW, GUARD_CANDIDATE, guardGapText } from '../../copy/guard';
import { IconAlert, IconCheck, IconChevron, IconFlame, IconInfo, IconOct, IconEye } from '../icons';

const VERDICTS = {
  clear: { label: NO_FLAGS, Icon: IconCheck },
  monitor: { label: 'Monitor', Icon: IconAlert },
  danger: { label: 'Danger', Icon: IconOct },
  info: { label: 'Info', Icon: IconInfo },
  pending: { label: NOT_FULLY_CHECKED, Icon: IconEye },
} as const satisfies Record<Level | 'pending', { label: string; Icon: typeof IconCheck }>;
export type VerdictLevel = Verdict['level'] | Extract<Level, 'info'> | 'pending';
export function VerdictChip({ level, size, detail, detailTitle, verdictPending = false, scanDelayed = false, evaluatedPlaybooks, meta, missing, guard, showGaps = true }: { level: VerdictLevel; size?: 'lg'; detail?: string; detailTitle?: string; verdictPending?: boolean; scanDelayed?: boolean; evaluatedPlaybooks?: PlaybookId[]; meta?: CoinCardMeta; missing?: string[]; guard?: GuardAssessmentV2; showGaps?: boolean }) {
  if (guard) {
    const projected = projectGuardLevelToV1(guard.level), Icon = VERDICTS[projected].Icon;
    const gap = guardGapText(guard), shadow = guard.mode !== 'active';
    return <span className={`guard-chip${size === 'lg' ? ' lg' : ''}`} aria-busy={false}>
      {shadow && <span className="tag">{guard.mode === 'candidate' ? GUARD_CANDIDATE : GUARD_SHADOW}</span>}
      <span className={`verdict ${shadow ? 'pending' : projected}${size === 'lg' ? ' lg' : ''}`}><Icon />{GUARD_LABELS[guard.level]}</span>
      {showGaps && gap && <strong className="guard-gap">{gap}</strong>}
    </span>;
  }
  const { label, Icon } = VERDICTS[level];
  const checking = verdictPending, delayed = checking && scanDelayed;
  return <span className={`verdict ${level}${checking ? ' scanning' : ''}${delayed ? ' delayed' : ''}${size === 'lg' ? ' lg' : ''}`} aria-busy={checking} title={delayed ? SCAN_DELAYED_DETAIL : level === 'pending' && !checking ? missingChecks(evaluatedPlaybooks, meta, missing) : undefined} tabIndex={delayed || (level === 'pending' && !checking) ? 0 : undefined}>
    <Icon />{delayed ? SCAN_DELAYED : checking ? SCANNING : label}{detail && <span className="verdict-detail" title={detailTitle}>· {detail}</span>}
  </span>;
}

export const inertText = guardInertText;
export function UntrustedText({ value, className = '' }: { value: Untrusted; className?: string }) {
  return <span className={`untrusted ${className}`}>
    <span className="untrusted-value">{inertText(value.text)}</span>
    {value.truncated && <span className="tag" title="The source text was truncated">truncated</span>}
    {value.flags.includes('agent_bait') && <span className="tag warn">Agent bait</span>}
    {value.flags.includes('impersonation') && <span className="tag warn">Impersonation</span>}
  </span>;
}

export const WALLET_LABEL_WORD = {
  declared_agent: 'Declared agent', likely_agent: 'Likely agent', crew: 'Crew', human: 'Human',
} as const satisfies Record<WalletLabel, string>;

export function HeatTag({ heat, compact = false }: { heat: 'hot' | 'fading' | 'normal' | 'avoid' | 'scanning'; compact?: boolean }) {
  if (heat !== 'hot' && heat !== 'fading') return null;
  const hot = heat === 'hot';
  return <span className={`heat-tag ${heat}`} title={hot ? "Unusual trading in the last hour against this coin's usual hour. Not a recommendation." : 'Activity and price are falling off.'}>
    {hot ? <IconFlame /> : <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 5l4.5 4.5 2-2L13 11M13 7.5V11H9.5" /></svg>}
    <span className={compact ? 'sr' : undefined}>{hot ? 'Hot' : 'Fading'}</span>
  </span>;
}

export function Info({ label, children, side = 'bottom' }: { label: string; children: ReactNode; side?: 'bottom' | 'left' | 'right' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); trigger.current?.focus(); }
    };
    const outside = (e: PointerEvent) => { if (e.target instanceof Node && !ref.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('keydown', key);
    document.addEventListener('pointerdown', outside);
    return () => { document.removeEventListener('keydown', key); document.removeEventListener('pointerdown', outside); };
  }, [open]);
  return <span className="info" ref={ref}>
    <button type="button" ref={trigger} className="info-btn" aria-expanded={open} aria-controls={id} aria-label={`About: ${label}`} onClick={(e) => { e.stopPropagation(); setOpen(!open); }}><IconInfo /></button>
    {open && <span className={`info-pop ${side}`} id={id} role="note"><b>{label}</b>{children}</span>}
  </span>;
}

function readOpen(id: string, fallback: boolean) {
  try { const value = localStorage.getItem(`eko.open.${id}`); return value === null ? fallback : value === '1'; }
  catch { return fallback; }
}
export interface CollapsibleProps {
  id: string; title: string; count?: number; summary?: ReactNode; actions?: ReactNode;
  defaultOpen?: boolean; className?: string; children: ReactNode; level?: 2 | 3 | 4 | 5 | 6;
}
export function Collapsible({ id, title, count, summary, actions, defaultOpen = true, className = '', children, level = 2 }: CollapsibleProps) {
  // Key the inner state by id so reusing a component for another section reads that section's preference.
  return <Disclosure key={id} {...{ id, title, count, summary, actions, defaultOpen, className, children, level }} />;
}
function Disclosure({ id, title, count, summary, actions, defaultOpen = true, className, children, level = 2 }: CollapsibleProps) {
  const [open, setOpen] = useState(() => readOpen(id, defaultOpen));
  const H = `h${level}` as 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
  const toggle = () => {
    const next = !open;
    try { localStorage.setItem(`eko.open.${id}`, next ? '1' : '0'); } catch { /* Storage is optional. */ }
    setOpen(next);
  };
  return <section className={`fold${open ? ' open' : ''} ${className}`}>
    <div className="fold-head"><H className="fold-title"><button type="button" className="fold-btn" aria-expanded={open} aria-controls={`${id}-body`} onClick={toggle}>
      <span className="fold-name">{title}</span>
      {count !== undefined && <span className="fold-count num" aria-hidden={count === 0}>{count}</span>}
      {summary && <span className="fold-sum">{summary}</span>}
      <span className="fold-tog"><span className="fold-tog-t">{open ? 'Collapse' : 'Expand'}</span><IconChevron /></span>
    </button></H>{actions && <div className="fold-acts">{actions}</div>}</div>
    <div className="fold-body" id={`${id}-body`} inert={!open} aria-hidden={!open}><div className="fold-inner">{children}</div></div>
  </section>;
}

export type Choice = string | { value: string; label: ReactNode; disabled?: boolean };
const choice = (item: Choice) => typeof item === 'string' ? { value: item, label: item, disabled: false } : item;
function useIndicator(value: string, options: readonly Choice[], inset = false) {
  const ref = useRef<HTMLDivElement>(null);
  const placed = useRef(false);
  const [style, setStyle] = useState<CSSProperties>({ opacity: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const place = () => {
      const selected = el.querySelector<HTMLElement>('[aria-pressed="true"], [aria-selected="true"]');
      if (!selected) { setStyle({ opacity: 0 }); return; }
      let x = selected.offsetLeft, width = selected.offsetWidth;
      if (inset) { const css = getComputedStyle(selected); x += parseFloat(css.paddingLeft); width -= parseFloat(css.paddingLeft) + parseFloat(css.paddingRight); }
      setStyle({ transform: `translateX(${x}px)`, width, transition: placed.current ? undefined : 'none' });
      placed.current = true;
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(el);
    el.querySelectorAll('button').forEach((button) => observer.observe(button));
    return () => observer.disconnect();
  }, [value, options, inset]);
  return { ref, style };
}
export function Seg({ options, value, onChange, label }: { options: readonly Choice[]; value: string; onChange: (value: string) => void; label: string }) {
  const { ref, style } = useIndicator(value, options);
  return <div className="seg has-ind" role="group" aria-label={label} ref={ref}>
    <i className="seg-ind" style={style} aria-hidden="true" />
    {options.map(choice).map((o) => <button type="button" key={o.value} aria-pressed={o.value === value} disabled={o.disabled} onClick={() => onChange(o.value)}>{o.label}</button>)}
  </div>;
}
export function Tabs({ tabs, value, onChange, label, id }: { tabs: readonly Choice[]; value: string; onChange: (value: string) => void; label: string; id: string }) {
  const { ref, style } = useIndicator(value, tabs, true);
  const options = tabs.map(choice);
  return <div className="tabs has-ind" role="tablist" aria-label={label} ref={ref} onKeyDown={(e) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    const enabled = options.filter((o) => !o.disabled);
    if (!enabled.length) return;
    const i = enabled.findIndex((o) => o.value === value);
    const j = e.key === 'Home' ? 0 : e.key === 'End' ? enabled.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + enabled.length) % enabled.length;
    e.preventDefault(); onChange(enabled[j].value);
    ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')[j]?.focus();
  }}>
    <i className="tabs-ind" style={style} aria-hidden="true" />
    {options.map((o, i) => <button type="button" key={o.value} id={`${id}-tab-${i}`} role="tab" aria-controls={`${id}-panel-${i}`} aria-selected={o.value === value} tabIndex={o.value === value ? 0 : -1} disabled={o.disabled} onClick={() => onChange(o.value)}>{o.label}</button>)}
  </div>;
}
export function TabPanel({ id, index, active, children }: { id: string; index: number; active: boolean; children: ReactNode }) {
  return <div id={`${id}-panel-${index}`} role="tabpanel" aria-labelledby={`${id}-tab-${index}`} hidden={!active} tabIndex={0}>{children}</div>;
}
export function Button({ variant = 'default', size, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' | 'danger' | 'ghost'; size?: 'sm' | 'lg' }) {
  return <button type="button" className={`btn ${variant === 'default' ? '' : `btn-${variant}`} ${size ? `btn-${size}` : ''} ${className}`} {...props} />;
}

export function UnavailableValue({tracked=false}:{tracked?:boolean}) {
 const label=tracked ? NOT_TRACKED_LABEL : NOT_CHECKED_LABEL;
 return <span className="muted availability" aria-label={label} title={label}>—</span>;
}
