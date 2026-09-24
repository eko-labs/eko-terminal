/** Shared by all range workers; even retries and rollbacks obey the same RPC concurrency bound. */
export class Semaphore {
  private active = 0;
  private waiting: (() => void)[] = [];
  constructor(readonly limit: number) { if (!Number.isInteger(limit) || limit < 1) throw new Error('Invalid concurrency'); }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>(resolve => this.waiting.push(resolve));
    else this.active++;
    try { return await fn(); }
    finally { const next = this.waiting.shift(); if (next) next(); else this.active--; }
  }
}
/** In-flight promises are shared; failures never poison a retry. */
export class AsyncCache<K, V> {
  private values = new Map<K, Promise<V>>();
  constructor(private limit = 4096) {}
  get(key: K, read: () => Promise<V>): Promise<V> {
    const existing = this.values.get(key);
    if (existing) return existing;
    const value = read().catch(error => { if (this.values.get(key) === value) this.values.delete(key); throw error; });
    this.values.set(key, value);
    if (this.values.size > this.limit) this.values.delete(this.values.keys().next().value!);
    return value;
  }
  delete(key: K) { this.values.delete(key); }
  clear() { this.values.clear(); }
}
/** Wait for every sibling read before propagating failure, so retry/drain cannot leave old RPCs running. */
export async function settle(reads: Promise<unknown>[]): Promise<void> {
  const results = await Promise.allSettled(reads);
  const failure = results.find(r => r.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
}
