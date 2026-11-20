import { getAddress, type Address } from 'viem';
import type { Funding } from './funders.js';
import type { Rpc } from './tracker.js';

/**
 * Who first paid a wallet, read from an archive RPC: for a chain with no explorer API EKO can script (Robinhood Chain's
 * Blockscout answers scripts with a Cloudflare challenge).
 *
 * Before an account sends its first transaction its nonce is 0 and its native balance can only grow, and once it has
 * sent one its nonce never returns to 0. So "balance > 0 or nonce > 0" is false up to the block the first coins
 * arrived and true from then on, and a binary search over block numbers finds that block in about log2(head) steps
 * (two state reads each at most: about 45 calls on Robinhood Chain). In that block the funder is the sender of a
 * transaction that paid the wallet directly (an L1 deposit counts: its sender is the L1 account); failing that, a
 * call trace of the block finds a contract that paid it inside a transaction. The funder is then that transaction's
 * sender when the sender's own coins paid for it (it sent at least as much as the wallet got: a disperse contract),
 * else the contract (a launchpad paying out fees in someone else's trade, which must not tie the wallet to the
 * stranger who traded), as the explorer reads it on Elysium. Contract wallets that pay gas through a sponsor can break the rule above; the answer for
 * them is a funding, not always the first.
 *
 * Calls are spaced to `perMin` across every trace this source runs, so a busy launch hour cannot crowd out the
 * tracker's own reads of the same paid RPC.
 */
export interface RpcFundingOptions { perMin?: number; sleep?: (ms: number) => Promise<void>; now?: () => number }

interface Tx { hash: string; from: string; to: string | null; value: string }
interface Frame { from: string; to?: string; value?: string; error?: string; calls?: Frame[] }

const hex = (n: bigint) => `0x${n.toString(16)}`;

export class RpcFunding {
  private next = 0;
  private readonly gapMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  calls = 0;

  constructor(private readonly rpc: Rpc, opts: RpcFundingOptions = {}) {
    this.gapMs = 60_000 / Math.max(1, opts.perMin ?? 150);
    this.sleep = opts.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
  }

  private async call<T>(method: string, params: unknown[]): Promise<T> {
    const now = this.now(), at = Math.max(now, this.next);
    this.next = at + this.gapMs;
    if (at > now) await this.sleep(at - now);
    this.calls++;
    return await this.rpc.request({ method, params }) as T;
  }

  private async funded(wallet: string, block: bigint): Promise<boolean> {
    if (BigInt(await this.call<string>('eth_getBalance', [wallet, hex(block)])) > 0n) return true;
    return BigInt(await this.call<string>('eth_getTransactionCount', [wallet, hex(block)])) > 0n;
  }

  /** The block the wallet first held coins (or first sent), or null when it never has. */
  async firstBlock(wallet: string): Promise<bigint | null> {
    const head = BigInt(await this.call<string>('eth_blockNumber', []));
    if (!(await this.funded(wallet, head))) return null;
    let lo = 0n, hi = head;
    while (lo < hi) {
      const mid = (lo + hi) / 2n;
      if (await this.funded(wallet, mid)) hi = mid; else lo = mid + 1n;
    }
    return lo;
  }

  /** The wallet's first funding, or null when nothing ever paid it. Throws when the chain cannot be read (try again later). */
  readonly find = async (raw: string): Promise<Funding | null> => {
    const wallet = raw.toLowerCase();
    const first = await this.firstBlock(wallet);
    if (first === null) return null;
    const block = await this.call<{ timestamp: string; transactions: Tx[] } | null>('eth_getBlockByNumber', [hex(first), true]);
    if (!block) throw new Error(`block ${first} not found`);
    const found = (from: string, tx: string) => ({ funder: getAddress(from) as Address, fundedTs: Number(BigInt(block.timestamp)), fundedBlock: Number(first), tx });
    const paid = (to: string | null | undefined, from: string, value: string | undefined) =>
      to?.toLowerCase() === wallet && from.toLowerCase() !== wallet && BigInt(value || '0') > 0n;
    const direct = block.transactions.find(t => paid(t.to, t.from, t.value));
    if (direct) return found(direct.from, direct.hash);
    const traces = await this.call<{ txHash?: string; result?: Frame }[]>('debug_traceBlockByNumber', [hex(first), { tracer: 'callTracer' }]);
    for (const [i, t] of traces.entries()) {
      const top = t.result, hash = t.txHash ?? block.transactions[i]?.hash;
      if (!top || top.error || !hash) continue;
      const pay = inner(top.calls ?? [], f => paid(f.to, f.from, f.value));
      if (pay) return found(top.from.toLowerCase() !== wallet && BigInt(top.value || '0') >= BigInt(pay.value!) ? top.from : pay.from, hash);
    }
    // Funded with no transfer EKO can see (a genesis allocation, a block reward): traced, no funder.
    return { funder: null, fundedTs: Number(BigInt(block.timestamp)), fundedBlock: Number(first), tx: null };
  };
}

/** The first successful call below these frames that matches (a failed frame's children never ran). */
function inner(frames: Frame[], match: (f: Frame) => boolean): Frame | null {
  for (const f of frames) {
    if (f.error) continue;
    if (match(f)) return f;
    const deeper = inner(f.calls ?? [], match);
    if (deeper) return deeper;
  }
  return null;
}
