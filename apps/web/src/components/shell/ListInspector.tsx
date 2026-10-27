import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMedia } from '../../lib/useMedia';
import { expandTo } from '../../lib/expand';
import { SHELL_COPY as C } from '../../copy/shell';
export interface InspectorItem { id: string; label: string; to: string; body: ReactNode }
/** Shell scaffold; M2/M3 pass their list rows and inspector bodies through it. */
export function ListInspector({ id, items }: { id: string; items: readonly InspectorItem[] }) {
  const wide = useMedia('(min-width: 1480px)');
  const remembered = () => { try { return sessionStorage.getItem(`eko.inspector.${id}`); } catch { return null; } };
  const first = () => items.find((row) => row.id === remembered())?.id ?? items[0]?.id ?? null;
  const [selected, setSelected] = useState<string | null>(() => wide ? first() : null);
  const rows = useRef<HTMLDivElement>(null), panel = useRef<HTMLElement>(null), returnTo = useRef<HTMLElement | null>(null);
  const item = items.find((i) => i.id === selected);
  const select = (next: string | null) => { setSelected(next); if (next) { try { sessionStorage.setItem(`eko.inspector.${id}`, next); } catch { /* optional storage */ } } };
  const close = () => { select(null); (returnTo.current ?? rows.current?.querySelector<HTMLButtonElement>(`[data-selected="true"]`))?.focus(); };
  useEffect(() => { if (wide && !selected) select(first()); }, [wide]);
  useEffect(() => {
    if (!item) return;
    if (!wide) panel.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      if (!wide && e.key === 'Tab') {
        const buttons = panel.current?.querySelectorAll<HTMLElement>('button, a[href], input, [tabindex="0"]');
        if (!buttons?.length) return;
        const first = buttons[0], last = buttons[buttons.length - 1];
        if (e.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [item?.id, wide]);
  const move = (e: React.KeyboardEvent) => {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key) || !items.length) return;
    e.preventDefault(); const index = items.findIndex((i) => i.id === selected);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    select(items[next].id); rows.current?.querySelectorAll<HTMLButtonElement>('[data-inspector-row]')[next]?.focus();
  };
  return <div className={`with-insp ${item ? 'open' : ''}`}><div className="inspector-list" ref={rows} onKeyDown={move}>{items.map((row) => <div className="inspector-row" key={row.id}><button className="btn" data-inspector-row data-selected={row.id === selected} aria-expanded={row.id === selected} aria-controls={`${id}-inspector`} onClick={(e) => { returnTo.current = e.currentTarget; select(row.id); }}>{row.label}</button><a href={row.to} className="insp-link" onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; e.preventDefault(); void expandTo(row.to, e.currentTarget.closest('.inspector-row')!); }}>{C.open}</a></div>)}</div>
    {item && <><button className="insp-scrim" tabIndex={-1} aria-label={C.close} onClick={close} /><aside className="insp" ref={panel} id={`${id}-inspector`} tabIndex={-1} role={wide ? undefined : 'dialog'} aria-modal={wide ? undefined : true} aria-label={C.inspector} onKeyDown={move}><div className="insp-bar"><span>{C.inspector}</span><button className="btn" onClick={close} aria-label={C.close}>×</button></div><h2>{item.label}</h2>{item.body}<button className="btn" onClick={() => void expandTo(item.to, panel.current!)}>{C.open}</button></aside></>}
  </div>;
}
