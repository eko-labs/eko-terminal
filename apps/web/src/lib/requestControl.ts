/** One transport request per resource, including callers mounted in different panels. */
interface Entry { pending?: Promise<unknown>; controller?: AbortController; users: number; next: number; failures: number }
export const READS_PER_MINUTE = 150;
/** Base of the error backoff, and the default gap between two reads of one resource. */
export const RESOURCE_SPACING_MS = 5000;
/** Gap for market reads. Short, so reopening a coin or a list is not held back. The per-minute ceiling bounds storms. */
export const MARKET_SPACING_MS = 1500;
const abortError = () => new DOMException('Aborted', 'AbortError');
export function resourceKey(url: string) {
  const parsed = new URL(url, 'https://example.invalid');
  // Chart reconnects move the end time; the timeframe and start still identify the resource.
  if (/\/(candles|markers)$/.test(parsed.pathname)) parsed.searchParams.delete('to');
  parsed.searchParams.sort();
  return parsed.href;
}
export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(abortError()); return; }
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(abortError()); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
export async function waitVisible(signal: AbortSignal) {
  while (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
    await new Promise<void>((resolve, reject) => {
      const clean = () => { document.removeEventListener('visibilitychange', visible); signal.removeEventListener('abort', abort); };
      const visible = () => { if (document.visibilityState !== 'hidden') { clean(); resolve(); } };
      const abort = () => { clean(); reject(abortError()); };
      if (signal.aborted) { reject(abortError()); return; }
      document.addEventListener('visibilitychange', visible); signal.addEventListener('abort', abort, { once: true });
    });
  }
  if (signal.aborted) throw abortError();
}
export class RequestControl {
  private entries = new Map<string, Entry>();
  private starts: number[] = [];
  constructor(private readonly cooldown: () => number = () => 0) {}
  async admission(signal: AbortSignal) {
    for (;;) {
      await waitVisible(signal);
      const now = Date.now(); this.starts = this.starts.filter(at => at > now - 60000);
      const next = Math.max(this.cooldown(), this.starts.length >= READS_PER_MINUTE ? this.starts[0]! + 60000 : 0);
      if (next > now) { await pause(next - now, signal); continue; }
      this.starts.push(now); return;
    }
  }
  run<T>(key: string, work: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal, spacing = RESOURCE_SPACING_MS): Promise<T> {
    if (signal?.aborted) return Promise.reject(abortError());
    // Keep only active or recent entries; browsing thousands of coins must not grow a permanent cache.
    for (const [id, e] of this.entries) if (!e.pending && e.next < Date.now() - 60000) this.entries.delete(id);
    let entry = this.entries.get(key);
    if (entry?.controller?.signal.aborted) { entry = { users: 0, next: entry.next, failures: entry.failures }; this.entries.set(key, entry); }
    if (!entry) { entry = { users: 0, next: 0, failures: 0 }; this.entries.set(key, entry); }
    const e = entry;
    if (!e.pending) {
      const controller = e.controller = new AbortController();
      e.pending = (async () => {
        if (e.next > Date.now()) await pause(e.next - Date.now(), controller.signal);
        await this.admission(controller.signal);
        e.next = Date.now() + spacing;
        try { const result = await work(controller.signal); e.failures = 0; return result; }
        catch (error) {
          if ((error as Error).name !== 'AbortError') {
            e.failures++; e.next = Math.max(e.next, Date.now() + Math.min(60000, RESOURCE_SPACING_MS * 2 ** Math.min(e.failures, 4)));
          }
          throw error;
        }
      })().finally(() => { e.pending = undefined; e.controller = undefined; });
    }
    const pending = e.pending; e.users++;
    return new Promise<T>((resolve, reject) => {
      let done = false;
      const finish = (fn: () => void) => { if (done) return; done = true; signal?.removeEventListener('abort', abort); e.users--; if (!e.users) e.controller?.abort(); fn(); };
      const abort = () => finish(() => reject(abortError()));
      signal?.addEventListener('abort', abort, { once: true });
      pending.then(value => finish(() => resolve(value as T)), error => finish(() => reject(error)));
    });
  }
}
