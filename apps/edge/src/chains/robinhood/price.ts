import type { Address, Hex } from 'viem';
import type { Rpc } from '../../tracker.js';
import { ROBINHOOD_PROFILE } from './profile.js';

/** slot0's sqrtPriceX96 of a WETH/USDG v3 pool as USDG per ETH (ported from apps/indexer/src/price.ts). */
export function ethUsdFromSlot0(sqrtPriceX96: bigint, wethIsToken0: boolean, wethDecimals: number, usdgDecimals: number): number {
  if (sqrtPriceX96 <= 0n) throw new Error('Uninitialized ETH/USD pool');
  const ratio = (Number(sqrtPriceX96) / 2 ** 96) ** 2;
  const value = (wethIsToken0 ? ratio : 1 / ratio) * 10 ** (wethDecimals - usdgDecimals);
  if (!Number.isFinite(value) || value <= 0) throw new Error('Invalid ETH/USD price');
  return value;
}

/** slot0() of a Uniswap v3 pool. */
const SLOT0 = '0x3850c7bd' as Hex;

export interface EthUsdOptions {
  fetcher?: typeof fetch;
  /** The public RPC, for the on-chain cross-check. */
  rpc: Rpc;
  pool?: { address: Address; wethIsToken0: boolean; wethDecimals: number; usdgDecimals: number };
  url?: string; ttlMs?: number; now?: () => number;
  /** Largest relative gap between the two sources that is accepted (default 2%). */
  maxGap?: number;
}

/**
 * ETH in USD, the same shape as HypeUsd (hype.ts): `get()` refreshes at most every `ttlMs`, `latest` is the last
 * accepted value, and null means never known. The price is Hyperliquid's allMids ETH, accepted only when the WETH/USDG
 * pool on Robinhood Chain agrees within 2%. A gap wider than that, or either source failing, keeps the last accepted
 * value: a wrong price would size the $1,000 sell probe and every USD figure wrongly, a stale one only slightly.
 */
export class EthUsd {
  private value: number | null = null;
  private at = 0;
  /** When a refresh last started: a refused or failed one is not retried on every call. */
  private tried = Number.NEGATIVE_INFINITY;
  private flight: Promise<void> | null = null;
  /** The last refusal, for diagnostics: both readings and when. */
  lastRefusal: { hyperliquid: number; pool: number; at: number } | null = null;
  private readonly fetcher: typeof fetch; private readonly rpc: Rpc; private readonly url: string; private readonly ttlMs: number;
  private readonly now: () => number; private readonly maxGap: number; private readonly pool: NonNullable<EthUsdOptions['pool']>;
  constructor(options: EthUsdOptions) {
    this.fetcher = options.fetcher ?? fetch; this.rpc = options.rpc; this.url = options.url ?? 'https://api.hyperliquid.xyz/info';
    this.ttlMs = options.ttlMs ?? 30_000; this.now = options.now ?? (() => Date.now()); this.maxGap = options.maxGap ?? 0.02;
    this.pool = options.pool ?? ROBINHOOD_PROFILE.ethUsdPool;
  }
  get latest(): number | null { return this.value; }
  /** When the value was last accepted (ms), 0 if never. */
  get acceptedAt(): number { return this.at; }
  async get(): Promise<number | null> {
    // Never known yet: retry sooner (5 s) than the refresh period.
    if (this.now() - this.tried < (this.value === null ? Math.min(this.ttlMs, 5000) : this.ttlMs)) return this.value;
    this.flight ??= this.refresh().finally(() => { this.flight = null; });
    await this.flight;
    return this.value;
  }
  private async hyperliquid(): Promise<number | null> {
    try {
      const res = await this.fetcher(this.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'allMids' }), signal: AbortSignal.timeout(5000) });
      if (!res.ok) return null;
      const price = Number((await res.json() as Record<string, string>).ETH);
      return Number.isFinite(price) && price > 0 ? price : null;
    } catch { return null; }
  }
  private async onChain(): Promise<number | null> {
    try {
      const out = await this.rpc.request({ method: 'eth_call', params: [{ to: this.pool.address, data: SLOT0 }, 'latest'] });
      if (typeof out !== 'string' || out.length < 66) return null;
      return ethUsdFromSlot0(BigInt(out.slice(0, 66)), this.pool.wethIsToken0, this.pool.wethDecimals, this.pool.usdgDecimals);
    } catch { return null; }
  }
  private async refresh() {
    this.tried = this.now();
    const [primary, check] = await Promise.all([this.hyperliquid(), this.onChain()]);
    if (primary === null || check === null) return;
    if (Math.abs(primary - check) / check > this.maxGap) { this.lastRefusal = { hyperliquid: primary, pool: check, at: this.now() }; return; }
    this.value = primary; this.at = this.now();
  }
}
