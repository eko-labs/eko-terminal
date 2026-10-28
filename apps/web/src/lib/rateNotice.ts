const STORAGE = 'eko.request-pause';
let until = 0;
const listeners = new Set<() => void>();
export const rateNotice = {
  get: () => until,
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
};
export function requestPauseUntil() {
  try { if (typeof window === 'undefined') return until; return Math.max(until, Number(localStorage.getItem(STORAGE)) || 0); } catch { return until; }
}
export function noteRateLimit(deadline: number) {
  until = Math.max(requestPauseUntil(), deadline);
  try { if (typeof window !== 'undefined') localStorage.setItem(STORAGE, String(until)); } catch { /* Storage is optional. */ }
  listeners.forEach(listener => listener());
}
if (typeof window !== 'undefined') window.addEventListener('storage', event => {
  if (event.key === STORAGE) { until = Math.max(until, Number(event.newValue) || 0); listeners.forEach(listener => listener()); }
});
export function retryDeadline(header: string | null, now = Date.now()) {
  const seconds = header === null ? NaN : Number(header);
  const date = header === null ? NaN : Date.parse(header);
  return now + Math.max(1000, Number.isFinite(seconds) ? seconds * 1000 : Number.isFinite(date) ? date - now : 60000);
}
