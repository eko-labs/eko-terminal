import type { Hex } from 'viem';

/**
 * Elysium's block explorer (Blockscout, Etherscan-compatible `/api`). Keyless and free; used for what a node answers
 * slowly on the free RPC tier: one coin's whole log history (by pool id or token address) and a wallet's first
 * transactions (who funded it). Requests are spaced to `ratePerSec`, retried with back-off, and never block the live
 * tracker (it uses the RPC).
 */
export interface ExplorerLog { address: string; topics: Hex[]; data: Hex; blockNumber: Hex; transactionHash: Hex; logIndex: Hex; blockTimestamp?: Hex }
export interface ExplorerTx { hash: Hex; from: string; to: string; value: string; timeStamp: string; blockNumber: string; isError?: string }

export interface ExplorerOptions { base?: string; ratePerSec?: number; fetch?: typeof fetch; retries?: number }

const PAGE = 1000;

export class Explorer {
  private readonly base: string;
  private readonly gapMs: number;
  private readonly fetcher: typeof fetch;
  private readonly retries: number;
  private next = 0;
  calls = 0;

  constructor(options: ExplorerOptions = {}) {
    this.base = options.base ?? 'https://elysium.kinetiq.xyz/explorer/api';
    this.gapMs = 1000 / (options.ratePerSec ?? 3);
    this.fetcher = options.fetch ?? fetch;
    this.retries = options.retries ?? 4;
  }

  private async slot() {
    const now = Date.now(), at = Math.max(now, this.next);
    this.next = at + this.gapMs;
    if (at > now) await new Promise(r => setTimeout(r, at - now));
  }

  private async get<T>(params: Record<string, string | number>): Promise<T[]> {
    const url = new URL(this.base);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    let delay = 1000;
    for (let attempt = 0; ; attempt++) {
      await this.slot();
      this.calls++;
      try {
        const res = await this.fetcher(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
        if (res.status === 429 || res.status >= 500) throw new Error(`explorer HTTP ${res.status}`);
        const body = await res.json() as { status?: string; message?: string; result?: unknown };
        if (Array.isArray(body.result)) return body.result as T[];
        // "No logs found" / "No transactions found" are empty answers, not failures.
        if (/no (logs|transactions|records)|not found/i.test(String(body.message ?? ''))) return [];
        throw new Error(`explorer: ${String(body.message ?? 'bad response').slice(0, 120)} ${typeof body.result === 'string' ? body.result.slice(0, 120) : ''}`);
      } catch (error) {
        if (attempt >= this.retries) throw error;
        await new Promise(r => setTimeout(r, delay)); delay = Math.min(delay * 2, 20_000);
      }
    }
  }

  /**
   * Every log matching the filter in [from, to], oldest first. The explorer returns at most 1,000 per call, so a full
   * page is continued from its last block (the last block's logs are re-read and de-duplicated).
   */
  async logs(filter: { address?: string; topic0?: Hex; topic1?: Hex }, from: number, to: number, onPage?: (logs: ExplorerLog[], through: number) => void | Promise<void>): Promise<ExplorerLog[]> {
    const out: ExplorerLog[] = [], seen = new Set<string>();
    let cursor = from;
    while (cursor <= to) {
      const page = await this.get<{ address: string; topics: (Hex | null)[]; data: Hex; blockNumber: Hex; transactionHash: Hex; logIndex: Hex; timeStamp?: Hex }>({
        module: 'logs', action: 'getLogs', fromBlock: cursor, toBlock: to,
        ...(filter.address ? { address: filter.address } : {}), ...(filter.topic0 ? { topic0: filter.topic0 } : {}),
        ...(filter.topic1 ? { topic1: filter.topic1, topic0_1_opr: 'and' } : {}),
      });
      const fresh: ExplorerLog[] = [];
      for (const l of page) {
        const key = `${l.transactionHash}:${Number(l.logIndex)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        fresh.push({ address: l.address, topics: l.topics.filter((t): t is Hex => !!t), data: l.data, blockNumber: l.blockNumber, transactionHash: l.transactionHash, logIndex: l.logIndex,
          ...(l.timeStamp ? { blockTimestamp: l.timeStamp } : {}) });
      }
      const last = page.length ? Number(page[page.length - 1]!.blockNumber) : to;
      const through = page.length < PAGE ? to : (fresh.length ? last : last + 1);
      out.push(...fresh);
      await onPage?.(fresh, through);
      if (page.length < PAGE) break;
      // A full page that added nothing new means one block holds 1,000+ matching logs: move past it.
      cursor = fresh.length ? last : last + 1;
    }
    return out;
  }

  /** A wallet's oldest transactions (normal, then internal), up to `limit` of each. */
  async firstTxs(wallet: string, limit = 20): Promise<{ normal: ExplorerTx[]; internal: ExplorerTx[] }> {
    const q = { module: 'account', address: wallet, startblock: 0, endblock: 999_999_999, page: 1, offset: limit, sort: 'asc' };
    // Both: the first funding can be either kind (a bridge or disperse contract pays through an internal transfer).
    const [normal, internal] = [await this.get<ExplorerTx>({ ...q, action: 'txlist' }), await this.get<ExplorerTx>({ ...q, action: 'txlistinternal' })];
    return { normal, internal };
  }
}
