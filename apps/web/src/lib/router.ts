import { useSyncExternalStore } from 'react';

const subs = new Set<() => void>();
if (typeof window !== 'undefined') window.addEventListener('popstate', () => subs.forEach((s) => s()));

export function navigate(path: string, replace = false) {
  if (path === location.pathname + location.search) return;
  if (replace) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
  subs.forEach((s) => s());
  window.scrollTo(0, 0);
}

export function usePath(): string {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => location.pathname,
  );
}

export function useSearch(): URLSearchParams {
  const search = useSyncExternalStore((cb) => { subs.add(cb); return () => subs.delete(cb); }, () => location.search);
  return new URLSearchParams(search);
}

export function match(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean);
  const a = path.split('/').filter(Boolean);
  if (p.length !== a.length) return null;
  const out: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i]!.startsWith(':')) {
      try { out[p[i]!.slice(1)] = decodeURIComponent(a[i]!); } catch { return null; }
    }
    else if (p[i] !== a[i]) return null;
  }
  return out;
}
