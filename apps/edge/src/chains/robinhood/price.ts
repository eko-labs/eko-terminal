import { decodeFunctionResult, encodeFunctionData, getAddress, keccak256, parseAbi, type Address, type Hex } from 'viem';
import type { Rpc } from '../../tracker.js';
import { ROBINHOOD_PROFILE, ROBINHOOD_STOCK_TOKEN } from './profile.js';

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

/**
 * A Uniswap v3 pool's slot0 price as quote per whole token (both sides' decimals applied): the same math as
 * ethUsdFromSlot0, for any pair. sqrtPriceX96² / 2¹⁹² is token1 per token0 in base units.
 */
export function v3TokenPrice(sqrtPriceX96: bigint, tokenIsToken0: boolean, tokenDecimals: number, quoteDecimals: number): number {
  if (sqrtPriceX96 <= 0n) return 0;
  const ratio = (Number(sqrtPriceX96) / 2 ** 96) ** 2;
  const value = (tokenIsToken0 ? ratio : 1 / ratio) * 10 ** (tokenDecimals - quoteDecimals);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** How the API names a quote asset (CoinSummary quoteAsset): WETH reads as ETH. */
export type QuoteKind = 'ETH' | 'USDG' | 'stock_token';
/** A token EKO can price a coin's trades in. */
export interface QuoteAsset { address: Address; symbol: string; decimals: number; kind: QuoteKind }
/** One Uniswap v3 pool that can price a stock token, against USDG or WETH. */
export interface StockPool { pool: Address; quote: 'USDG' | 'WETH'; fee: number; tokenIsToken0: boolean }
/** One pool's reading at a refresh: its price in USD per whole token and the USD of quote it holds. */
export interface PoolReading { pool: Address; usd: number; depthUsd: number; liquidity: bigint }

export interface QuotePriceOptions {
  /** ETH in USD as last accepted (EthUsd): only set while Robinhood Chain's WETH/USDG pool agrees with Hyperliquid. */
  ethUsd: { readonly latest: number | null };
  addrs: { weth: Address; usdg: Address; v3Factory: Address; multicall3: Address };
  ttlMs?: number; now?: () => number;
  /** Least USD of quote (USDG or WETH) a pricing pool must hold (default $10,000). */
  minDepthUsd?: number;
  /** Largest gap between the deepest pool and any other deep pool of the same token (default 3%). */
  maxGap?: number;
  /** Largest move from the last accepted price taken from one reading (default 25%); a larger one needs a second reading
   *  that agrees within maxGap. */
  maxMove?: number;
  /** A stock price older than this is no longer used (default six hours). */
  maxAgeMs?: number;
  stock?: { beacon: Address; proxyCodeHash: Hex };
}

const BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50' as Hex;
const V3_FEES = [100, 500, 3000, 10_000] as const;
const quoteAbi = parseAbi([
  'function getPool(address, address, uint24) view returns (address)', 'function slot0() view returns (uint160, int24, uint16, uint16, uint16, uint8, bool)',
  'function liquidity() view returns (uint128)', 'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)', 'function symbol() view returns (string)',
]);
const multicallAbi = parseAbi(['struct Call3 { address target; bool allowFailure; bytes callData; }', 'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[] returnData)']);
const lower = (a: string) => a.toLowerCase();

/**
 * Pick a stock token's price from its pools' readings, or say why not: the deepest pool by the USD of quote it holds,
 * at least `minDepthUsd` and in range (liquidity above zero), and every other pool that deep within `maxGap` of it.
 */
export function pickStockPrice(readings: readonly PoolReading[], minDepthUsd: number, maxGap: number): { usd: number; pool: Address } | { refused: string } {
  const deep = readings.filter(r => r.liquidity > 0n && r.depthUsd >= minDepthUsd && r.usd > 0).sort((a, b) => b.depthUsd - a.depthUsd);
  const best = deep[0];
  if (!best) return { refused: 'no pool holds enough' };
  if (best.usd < 1e-6 || best.usd > 1e7) return { refused: 'price out of range' };
  if (deep.some(r => Math.abs(r.usd - best.usd) / best.usd > maxGap)) return { refused: 'pools disagree' };
  return { usd: best.usd, pool: best.pool };
}

/**
 * Prices, in ETH, the tokens long.xyz coins are quoted in (Robinhood Chain), so their trades can be counted in ETH like
 * a native pool's. Only an asset whose price can be checked on chain is priced:
 * - WETH: 1:1 with ETH.
 * - USDG: $1. Checked through the ETH price: EthUsd accepts Hyperliquid's ETH only while the WETH/USDG pool agrees with
 *   it within 2%, which holds only while USDG is within about 2% of a dollar (read 0.9996 on 2026-11-18).
 * - Robinhood stock tokens: only a token with Robinhood's stock proxy code and beacon (ROBINHOOD_STOCK_TOKEN), priced from
 *   its deepest Uniswap v3 pool (the registry's factory) against USDG or WETH, refreshed like EthUsd, within the sanity
 *   bounds of pickStockPrice and `maxMove`. Any other token (a coin, a look-alike) is never priced.
 * `want` queues a token seen as a numeraire; `refresh` checks queued tokens and re-reads every stock's pools.
 */
export class QuotePrices {
  private readonly assets = new Map<string, QuoteAsset>();
  private readonly usd = new Map<string, { usd: number; at: number; pool: Address }>();
  private readonly pools = new Map<string, StockPool[]>();
  private readonly wanted = new Set<string>();
  private readonly rejected = new Set<string>();
  /** A reading refused for moving too far, kept to be confirmed by the next one. */
  private readonly unconfirmed = new Map<string, number>();
  /** The last refusal per token, for diagnostics. */
  readonly refusals = new Map<string, { why: string; at: number }>();
  private tried = Number.NEGATIVE_INFINITY;
  private flight: Promise<void> | null = null;
  private readonly o: Required<Omit<QuotePriceOptions, 'ethUsd' | 'addrs'>> & Pick<QuotePriceOptions, 'ethUsd' | 'addrs'>;
  constructor(options: QuotePriceOptions) {
    this.o = { ttlMs: 60_000, now: () => Date.now(), minDepthUsd: 10_000, maxGap: 0.03, maxMove: 0.25, maxAgeMs: 6 * 3600_000, stock: ROBINHOOD_STOCK_TOKEN, ...options };
    this.assets.set(lower(options.addrs.weth), { address: getAddress(options.addrs.weth), symbol: 'WETH', decimals: 18, kind: 'ETH' });
    this.assets.set(lower(options.addrs.usdg), { address: getAddress(options.addrs.usdg), symbol: 'USDG', decimals: 6, kind: 'USDG' });
  }

  /** The asset when it is priced right now, else null (unknown, refused, stale, or no ETH price). */
  asset(quote: string): (QuoteAsset & { ethPer: number }) | null {
    const a = this.assets.get(lower(quote)), ethPer = this.ethPer(quote);
    return a && ethPer !== null ? { ...a, ethPer } : null;
  }
  /** ETH per whole unit of `quote`, or null when it cannot be priced now. */
  ethPer(quote: string): number | null {
    const k = lower(quote), a = this.assets.get(k);
    if (!a) return null;
    if (a.kind === 'ETH') return 1;
    const eth = this.o.ethUsd.latest;
    if (!eth || !(eth > 0)) return null;
    if (a.kind === 'USDG') return 1 / eth;
    const p = this.usd.get(k);
    return p && this.o.now() - p.at <= this.o.maxAgeMs ? p.usd / eth : null;
  }
  /** USD per whole unit of a stock token as last accepted, with its pool (diagnostics, tests). */
  stockUsd(quote: string) { return this.usd.get(lower(quote)) ?? null; }
  /** Queue a numeraire seen in a launch to be checked on the next refresh (no-op for one known or refused). */
  want(quote: string) {
    const k = lower(quote);
    if (!this.assets.has(k) && !this.rejected.has(k)) this.wanted.add(k);
  }
  /** Whether `quote` was checked and is not one EKO prices. */
  isRejected(quote: string) { return this.rejected.has(lower(quote)); }

  /** Check queued tokens and re-read the stocks' pools, at most every `ttlMs` (provider failures keep the last values). */
  async refresh(rpc: Rpc): Promise<void> {
    // A queued token is checked within seconds (a launch in it waits for it); otherwise every ttlMs.
    if (this.o.now() - this.tried < (this.wanted.size ? Math.min(this.o.ttlMs, 5000) : this.o.ttlMs)) return;
    this.flight ??= this.run(rpc).finally(() => { this.flight = null; });
    await this.flight;
  }

  private async run(rpc: Rpc) {
    this.tried = this.o.now();
    const queue = [...this.wanted].slice(0, 120);
    for (let i = 0; i < queue.length; i += 6) await Promise.all(queue.slice(i, i + 6).map(async (k) => {
      try { await this.check(rpc, k as Address); this.wanted.delete(k); } catch { /* provider failure: tried again next refresh */ }
    }));
    try { await this.reprice(rpc); } catch { /* keep the last accepted prices */ }
  }

  private async call(rpc: Rpc, calls: { target: Address; data: Hex }[]) {
    const out: ({ success: boolean; returnData: Hex } | undefined)[] = [];
    for (let i = 0; i < calls.length; i += 150) {
      const chunk = calls.slice(i, i + 150);
      const data = encodeFunctionData({ abi: multicallAbi, functionName: 'aggregate3', args: [chunk.map(c => ({ target: c.target, callData: c.data, allowFailure: true }))] });
      const raw = await rpc.request({ method: 'eth_call', params: [{ to: this.o.addrs.multicall3, data }, 'latest'] }) as Hex;
      out.push(...decodeFunctionResult({ abi: multicallAbi, functionName: 'aggregate3', data: raw }));
    }
    return out;
  }

  /** One queued token: Robinhood's stock proxy and beacon, its decimals and symbol, and its v3 pools against USDG and WETH. */
  private async check(rpc: Rpc, token: Address) {
    const [code, beacon] = await Promise.all([
      rpc.request({ method: 'eth_getCode', params: [token, 'latest'] }) as Promise<Hex>,
      rpc.request({ method: 'eth_getStorageAt', params: [token, BEACON_SLOT, 'latest'] }) as Promise<Hex>,
    ]);
    if (typeof code !== 'string' || keccak256(code) !== this.o.stock.proxyCodeHash || typeof beacon !== 'string'
      || lower(`0x${beacon.slice(-40)}`) !== lower(this.o.stock.beacon)) { this.rejected.add(lower(token)); return; }
    const { weth, usdg, v3Factory } = this.o.addrs, enc = (target: Address, functionName: string, args: readonly unknown[] = []) =>
      ({ target, data: encodeFunctionData({ abi: quoteAbi, functionName, args } as unknown as Parameters<typeof encodeFunctionData>[0]) });
    const pairs = (['USDG', 'WETH'] as const).flatMap(q => V3_FEES.map(fee => ({ q, fee, quote: q === 'USDG' ? usdg : weth })));
    const r = await this.call(rpc, [enc(token, 'decimals'), enc(token, 'symbol'), ...pairs.map(p => enc(v3Factory, 'getPool', [token, p.quote, p.fee]))]);
    const read = <T>(i: number, fn: string): T | null => { const x = r[i]; if (!x?.success) return null;
      try { return decodeFunctionResult({ abi: quoteAbi, functionName: fn, data: x.returnData } as unknown as Parameters<typeof decodeFunctionResult>[0]) as T; } catch { return null; } };
    const decimals = read<number>(0, 'decimals'), symbol = read<string>(1, 'symbol');
    if (decimals === null || decimals > 36) throw new Error('decimals unread');
    const pools: StockPool[] = [];
    pairs.forEach((p, i) => { const pool = read<Address>(i + 2, 'getPool');
      if (pool && pool !== '0x0000000000000000000000000000000000000000') pools.push({ pool: getAddress(pool), quote: p.q, fee: p.fee, tokenIsToken0: lower(token) < lower(p.quote) }); });
    this.assets.set(lower(token), { address: getAddress(token), symbol: (symbol ?? '').slice(0, 16), decimals: Number(decimals), kind: 'stock_token' });
    this.pools.set(lower(token), pools);
  }

  /** Every stock's pools in one batch: price, depth and liquidity, then pickStockPrice and the move bound. */
  private async reprice(rpc: Rpc) {
    const eth = this.o.ethUsd.latest;
    if (!eth) return;
    const { weth, usdg } = this.o.addrs, list = [...this.pools].filter(([, p]) => p.length);
    const enc = (target: Address, functionName: string, args: readonly unknown[] = []) =>
      ({ target, data: encodeFunctionData({ abi: quoteAbi, functionName, args } as unknown as Parameters<typeof encodeFunctionData>[0]) });
    const calls = list.flatMap(([, pools]) => pools.flatMap(p => [enc(p.pool, 'slot0'), enc(p.pool, 'liquidity'), enc(p.quote === 'USDG' ? usdg : weth, 'balanceOf', [p.pool])]));
    if (!calls.length) return;
    const r = await this.call(rpc, calls);
    const word = (i: number) => { const x = r[i]; return x?.success && x.returnData.length >= 66 ? BigInt(x.returnData.slice(0, 66)) : null; };
    let i = 0;
    for (const [k, pools] of list) {
      const asset = this.assets.get(k)!, readings: PoolReading[] = [];
      for (const p of pools) {
        const [sqrt, liquidity, held] = [word(i), word(i + 1), word(i + 2)]; i += 3;
        if (sqrt === null || liquidity === null || held === null) continue;
        const quoteUsd = p.quote === 'USDG' ? 1 : eth, quoteDecimals = p.quote === 'USDG' ? 6 : 18;
        readings.push({ pool: p.pool, liquidity, usd: v3TokenPrice(sqrt, p.tokenIsToken0, asset.decimals, quoteDecimals) * quoteUsd, depthUsd: Number(held) / 10 ** quoteDecimals * quoteUsd });
      }
      this.accept(k, pickStockPrice(readings, this.o.minDepthUsd, this.o.maxGap));
    }
  }

  private accept(k: string, pick: ReturnType<typeof pickStockPrice>) {
    const now = this.o.now();
    if ('refused' in pick) { this.refusals.set(k, { why: pick.refused, at: now }); return; }
    const last = this.usd.get(k)?.usd;
    if (last !== undefined && Math.abs(pick.usd - last) / last > this.o.maxMove) {
      const seen = this.unconfirmed.get(k);
      if (seen === undefined || Math.abs(pick.usd - seen) / seen > this.o.maxGap) {
        this.unconfirmed.set(k, pick.usd); this.refusals.set(k, { why: 'moved too far; waiting for a second reading', at: now }); return;
      }
    }
    this.unconfirmed.delete(k);
    this.usd.set(k, { usd: pick.usd, at: now, pool: pick.pool });
  }
}
