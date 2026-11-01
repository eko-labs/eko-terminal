import { getAddress, type Address } from 'viem';
import type { Explorer, ExplorerTx } from './explorer.js';
import type { HistoryStore } from './history.js';

/**
 * Who funded a wallet: the sender of its earliest incoming HYPE (a plain transfer or an internal one from a contract),
 * read once from the explorer and kept in the history store. A funder that paid many traced wallets is a hub (a bridge
 * relayer, an exchange) and ties no one together; the store answers that. Lookups run in the background, a few at a
 * time, newest requests first; a coin's bundle check uses whatever is known when it is judged.
 */
export function firstFunding(wallet: string, txs: { normal: ExplorerTx[]; internal: ExplorerTx[] }): { funder: Address; fundedTs: number; fundedBlock: number; tx: string } | null {
  const w = wallet.toLowerCase();
  const incoming = [...txs.normal.filter(t => t.isError !== '1'), ...txs.internal.filter(t => t.isError !== '1')]
    .filter(t => t.to?.toLowerCase() === w && t.from?.toLowerCase() !== w && BigInt(t.value || '0') > 0n)
    .sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber));
  const t = incoming[0];
  return t ? { funder: getAddress(t.from), fundedTs: Number(t.timeStamp), fundedBlock: Number(t.blockNumber), tx: t.hash } : null;
}

export class FunderTracer {
  private readonly queue: string[] = [];
  private readonly queued = new Set<string>();
  private running = 0;
  counters = { traced: 0, failures: 0 };

  constructor(private readonly explorer: Explorer, private readonly store: HistoryStore, private readonly opts: { concurrency?: number; maxQueue?: number; now?: () => number; log?: (e: string, f: Record<string, unknown>) => void } = {}) {}

  get pending() { return this.queue.length; }

  /** Ask for these wallets' funders (already traced or queued ones are skipped). */
  want(wallets: string[]) {
    for (const raw of wallets) {
      const w = raw.toLowerCase();
      if (this.queued.has(w) || this.store.funder(w)) continue;
      this.queued.add(w); this.queue.unshift(w);
    }
    const max = this.opts.maxQueue ?? 5000;
    while (this.queue.length > max) this.queued.delete(this.queue.pop()!);
    this.pump();
  }

  private pump() {
    while (this.running < (this.opts.concurrency ?? 2) && this.queue.length) {
      const w = this.queue.shift()!;
      this.running++;
      void this.trace(w).finally(() => { this.running--; this.queued.delete(w); this.pump(); });
    }
  }

  async trace(wallet: string) {
    try {
      const found = firstFunding(wallet, await this.explorer.firstTxs(wallet));
      this.store.recordFunder({ wallet: getAddress(wallet), funder: found?.funder ?? null, fundedTs: found?.fundedTs ?? null, fundedBlock: found?.fundedBlock ?? null, tx: found?.tx ?? null },
        Math.floor((this.opts.now?.() ?? Date.now()) / 1000));
      this.counters.traced++;
    } catch (error) {
      this.counters.failures++;
      this.opts.log?.('funder_failed', { wallet, error: String((error as Error).message).slice(0, 160) });
    }
  }
}
