import type { RpcLog } from './metered.js';
export type ProviderErrorClass = 'provider_balance_exceeded' | 'provider_quota_exceeded' | 'rpc_unavailable';
export interface RpcPause {
  state: 'PAUSED'; reason: ProviderErrorClass; provider: 'paid' | 'public'; since: number; nextRetryAt: number;
}
/** Bounded classification of transport/provider errors, never request bodies or URLs. */
export function providerErrorClass(error: unknown): ProviderErrorClass | undefined {
  const seen = new Set<unknown>();
  let quota = false;
  for (let depth = 0; error && typeof error === 'object' && depth < 16 && !seen.has(error); depth++) {
    seen.add(error);
    const e = error as { code?: unknown; status?: unknown; statusCode?: unknown; message?: unknown; shortMessage?: unknown; details?: unknown; cause?: unknown };
    const text = [e.message, e.shortMessage, e.details].join(' ');
    if (e.code === 'provider_balance_exceeded' || (Number(e.status ?? e.statusCode) === 402 || Number(e.code) === 402) || /(?:balance|credits?).*(?:exceeded|exhausted|insufficient|depleted)|(?:insufficient|not enough).*(?:balance|credits?)|payment required/i.test(text)) return 'provider_balance_exceeded';
    if (e.code === 'provider_quota_exceeded' || (Number(e.status ?? e.statusCode) === 429 || Number(e.code) === 429) || /quota|rate.?limit|too many requests|usage limit|request limit/i.test(text)) quota = true;
    error = e.cause;
  }
  return quota ? 'provider_quota_exceeded' : undefined;
}
/** One recovery loop per process. Callers wait on the same promise, retaining their stacks and caches. */
export class RpcOutage {
  pause: RpcPause | null = null;
  private recovery?: Promise<void>;
  constructor(private readonly options: {
    maxBackoffMs: number; now: () => number; wait: (ms: number) => Promise<void>; log: RpcLog;
    changed?: (pause: RpcPause | null) => Promise<void> | void;
  }) {}
  wait() { return this.recovery ?? Promise.resolve(); }
  async recover(reason: ProviderErrorClass, provider: 'paid' | 'public', probe: () => Promise<void>, classify: (error: unknown) => ProviderErrorClass | undefined) {
    if (this.recovery) return this.recovery;
    const { now, log, changed } = this.options;
    this.pause = { state: 'PAUSED', reason, provider, since: now(), nextRetryAt: now() + 10_000 };
    const report = () => { log('rpc_paused', { ...this.pause }); };
    report();
    let reportFailure: unknown;
    let reporting = Promise.resolve();
    const timer = setInterval(() => {
      report();
      reporting = reporting.then(() => changed?.(this.pause)).catch(error => { reportFailure = error; });
    }, 60_000);
    this.recovery = (async () => {
      try {
        await changed?.(this.pause);
        let delay = 10_000;
        for (;;) {
          await this.options.wait(Math.max(0, this.pause!.nextRetryAt - now()));
          if (reportFailure) throw reportFailure;
          try { await probe(); break; }
          catch (error) {
            const nextReason = classify(error);
            if (!nextReason) throw error;
            delay = Math.min(delay * 2, this.options.maxBackoffMs);
            this.pause = { ...this.pause!, reason: nextReason, nextRetryAt: now() + delay };
            await changed?.(this.pause);
          }
        }
        clearInterval(timer);
        await reporting;
        if (reportFailure) throw reportFailure;
        await changed?.(null);
        log('rpc_resumed', { provider });
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
        // A local ceiling can clear for urgent work or the next UTC day; it is not a persisted provider outage.
        if (code === 'rpc_paid_deferred' || code === 'rpc_budget_exhausted') await changed?.(null);
        throw error;
      } finally { clearInterval(timer); this.pause = null; this.recovery = undefined; }
    })();
    return this.recovery;
  }
}
