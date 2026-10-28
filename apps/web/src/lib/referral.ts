const KEY = 'eko.ref';
const TTL_MS = 30 * 24 * 3600_000;
const valid = (value: string | null) => value && /^[a-zA-Z0-9_-]{1,64}$/.test(value) ? value : undefined;

function readReferral(): string | undefined {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (stored && typeof stored.expiresAt === 'number' && stored.expiresAt > Date.now() && typeof stored.code === 'string') return valid(stored.code);
    localStorage.removeItem(KEY);
  } catch { /* Storage may be unavailable. */ }
  return undefined;
}

/** Capture on landing, before navigation removes the query. Attribution binds on SIWE. */
export function captureReferral() {
  try {
    const url = new URL(window.location.href);
    const ref = valid(url.searchParams.get('ref'));
    if (ref && !readReferral()) localStorage.setItem(KEY, JSON.stringify({ code: ref, expiresAt: Date.now() + TTL_MS }));
    if (url.searchParams.has('ref')) {
      url.searchParams.delete('ref');
      window.history.replaceState(window.history.state, '', url);
    }
  } catch { /* Storage may be unavailable. */ }
}
export function capturedReferral() {
  captureReferral();
  return readReferral();
}
export function clearReferral() {
  try { localStorage.removeItem(KEY); } catch { /* Storage may be unavailable. */ }
}
