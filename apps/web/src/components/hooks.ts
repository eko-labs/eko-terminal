import { useEffect, useState, type RefObject } from 'react';
import { serverNow } from '../lib/clock';

/** Close a popover on outside pointer-down or Escape. */
export function useOutside(ref: RefObject<HTMLElement | null>, onOut: () => void, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const h = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onOut();
    };
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onOut();
    window.addEventListener('pointerdown', h);
    window.addEventListener('keydown', k);
    return () => {
      window.removeEventListener('pointerdown', h);
      window.removeEventListener('keydown', k);
    };
  }, [ref, onOut, active]);
}

/** Server-synchronised clock that re-renders every `ms`. */
export function useNow(ms = 1000) {
  const [t, setT] = useState(serverNow());
  useEffect(() => {
    const i = window.setInterval(() => setT(serverNow()), ms);
    return () => clearInterval(i);
  }, [ms]);
  return t;
}

/** "now", "12s ago", "4m ago", "2h ago", or a clock time for older events. */
export function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return 'now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
