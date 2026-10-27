import { useEffect, useRef, type ReactNode } from 'react';
import { formatDuration } from '@eko/shared';

/** Small presentational helpers shared by the Backtest lab, Portfolio and Settings pages. */

export function Switch({
  checked,
  onChange,
  label,
  hint,
  disabled = false,
  id,
}: {
  checked: boolean;
  onChange?: (v: boolean) => void;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <label className={`lx-switch ${disabled ? 'is-disabled' : ''}`} htmlFor={id}>
      <input id={id} type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange?.(e.target.checked)} />
      <span className="switch" aria-hidden />
      <span className="lx-switch-text">
        <span>{label}</span>
        {hint ? <span className="lx-switch-hint">{hint}</span> : null}
      </span>
    </label>
  );
}

/** Horizontally scrollable wrapper for wide tables (keeps the page itself from scrolling sideways). */
export function TableWrap({ children, maxHeight, label }: { children: ReactNode; maxHeight?: number; label?: string }) {
  return (
    <div className="lx-table-wrap" style={maxHeight ? { maxHeight } : undefined} role={label ? 'region' : undefined} aria-label={label} tabIndex={label ? 0 : undefined}>
      {children}
    </div>
  );
}

export function Panel({ title, note, actions, children, className = '', id }: { title: ReactNode; note?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; id?: string }) {
  return (
    <section className={`panel lx-panel ${className}`} id={id} aria-label={typeof title === 'string' ? title : undefined}>
      <header className="panel-head lx-panel-head">
        <h3 className="panel-title">{title}</h3>
        {note ? <span className="lx-panel-note">{note}</span> : null}
        <span className="grow" />
        {actions}
      </header>
      {children}
    </section>
  );
}

export function Kv({ rows }: { rows: [ReactNode, ReactNode][] }) {
  return (
    <dl className="lx-kv">
      {rows.map(([k, v], i) => (
        <div key={i}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Sub({ children }: { children: ReactNode }) {
  return <span className="lx-sub">{children}</span>;
}

export function Modal({ title, onClose, children, actions, tone }: { title: string; onClose: () => void; children: ReactNode; actions: ReactNode; tone?: 'danger' }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>('[data-autofocus]') ?? el?.querySelector<HTMLElement>('button');
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
      if (e.key === 'Tab' && el) {
        const f = [...el.querySelectorAll<HTMLElement>('button:not(:disabled), input, select, textarea, a[href]')];
        if (!f.length) return;
        const a = f[0]!;
        const z = f[f.length - 1]!;
        if (e.shiftKey && document.activeElement === a) {
          e.preventDefault();
          z.focus();
        } else if (!e.shiftKey && document.activeElement === z) {
          e.preventDefault();
          a.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      prev?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal lx-modal ${tone === 'danger' ? 'is-danger' : ''}`} role="dialog" aria-modal="true" aria-labelledby="lx-modal-title" ref={ref}>
        <h2 id="lx-modal-title">{title}</h2>
        {children}
        <div className="modal-actions">{actions}</div>
      </div>
    </div>
  );
}

// ─────────────── formatting ───────────────

/** unix seconds → "Sep 28, 14:00" */
export function fmtTime(sec: number | null | undefined): string {
  if (!sec) return '—';
  return new Date(sec * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

/** unix seconds → "Sep 28, 2026" */
export function fmtDate(sec: number | null | undefined): string {
  if (!sec) return '—';
  return new Date(sec * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** unix seconds → "Sep 28" */
export function fmtDay(sec: number | null | undefined): string {
  if (!sec) return '—';
  return new Date(sec * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function fmtSpan(startSec: number, endSec: number): string {
  if (!startSec || !endSec || endSec < startSec) return '—';
  return formatDuration((endSec - startSec) * 1000);
}

/** ms epoch → "14:03:22" */
export function fmtClock(ms: number | null | undefined): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleTimeString(undefined, { hour12: false });
}

/** ms epoch → "12s ago" / "4m 10s ago" */
export function fmtAgo(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return 'never';
  const d = Math.max(0, now - ms);
  if (d < 1500) return 'just now';
  return `${formatDuration(d)} ago`;
}

export function toneOf(v: number | null | undefined): '' | 'up' | 'down' {
  if (v === null || v === undefined || !Number.isFinite(v) || v === 0) return '';
  return v > 0 ? 'up' : 'down';
}

export function readLocal<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writeLocal(key: string, v: string) {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* storage unavailable */
  }
}
