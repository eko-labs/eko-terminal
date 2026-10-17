import { withRpcOrigin } from '@eko/chain';
import { loadRegistry, type AddressRegistry, type RegistryKey } from '@eko/chain';
import { binary, hex, type SqlClient } from '@eko/db';
import type { TradeQuote, TradeQuoteRequest, UnsignedTx } from '@eko/shared';
import { encodeFunctionData, formatUnits, padHex, parseAbi, zeroAddress, type Address, type PublicClient } from 'viem';

export const ERC20_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);
export const QUOTER_V2_ABI = parseAbi([
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
]);
export const FACTORY_ABI = parseAbi(['function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)']);
export const POOL_ABI = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function token0() view returns (address)',
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
]);
export const ROUTER_ABI = parseAbi([
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
  'function unwrapWETH9(uint256 amountMinimum, address recipient) payable',
  'function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)',
]);

export class ChainQuoteError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}


export interface IndexedV3Pool {
  address: Address;
  currency0: Address;
  currency1: Address;
  fee: number;
}

/** Callers supply indexed state and block-bound prices, never unmetered RPC clients. */
export interface V3TradeSources {
  pools(coin: Address, block: bigint): Promise<IndexedV3Pool[]>;
  priceUsd(token: Address, block: bigint): Promise<number | null>;
  /** Total L2 execution + L1 data cost for these exact bytes, at the pinned block. */
  networkFeeWei(tx: UnsignedTx, gasEstimate: bigint, block: bigint): Promise<bigint | null>;
  registry?: AddressRegistry;
}

export type V3TradeRoute = Pick<TradeQuote,
  'amountIn' | 'valueWei' | 'networkFeeUsd' | 'route' | 'expectedOut' | 'minOut' |
  'priceImpactBps' | 'fee' | 'approvals' | 'expiresAt' | 'asOfBlock'> & { tx: UnsignedTx };

/** Only indexed v3 pools created by this block are eligible; factory identity is checked on-chain.
 * @remarks
 * Return a source callback reading indexed v3 pools at or before the requested block. Host
 * supplies the SQL connection; no account authorization or factory authentication occurs here.
 * Query failures reject when invoked.
 * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../../docs/security/INVARIANTS.md | Unsigned execution and current admission invariants}
 */
export function indexedV3Pools(sql: SqlClient): V3TradeSources['pools'] {
  return async (coin, block) => {
    const { rows } = await sql.query<{ id: Uint8Array; currency0: Uint8Array; currency1: Uint8Array; fee: number }>(
      `SELECT id,currency0,currency1,fee FROM pools WHERE venue='uniswap_v3'
       AND (currency0=$1 OR currency1=$1) AND created_block <= $2 AND block <= $2`,
      [binary(coin), block.toString()],
    );
    return rows.map(row => ({ address: hex(row.id), currency0: hex(row.currency0), currency1: hex(row.currency1), fee: row.fee }));
  };
}

const FEES = new Set([100, 500, 3000, 10000]);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const positive = (n: number | null): n is number => n !== null && Number.isFinite(n) && n > 0;

// Preserve the decimal request representation and floor to raw units, including tiny amounts.
function fraction(n: number): [bigint, bigint] {
  const [mantissa, exponent = '0'] = String(n).split('e');
  const [whole, tail = ''] = mantissa!.split('.');
  const power = Number(exponent) - tail.length;
  const digits = BigInt(whole! + tail);
  return power >= 0 ? [digits * 10n ** BigInt(power), 1n] : [digits, 10n ** BigInt(-power)];
}
/** Raw units of a token worth `usd` at `price` USD per whole token, floored. Shared with the Pons curve route. */
export function rawUsd(usd: number, price: number, decimals: number): bigint {
  const [u, ud] = fraction(usd);
  const [p, pd] = fraction(price);
  return u * pd * 10n ** BigInt(decimals) / (ud * p);
}
/** A registry address that is verified and not pending review, else `no_route`. Shared with the v4 route. */
export function verified(registry: AddressRegistry, key: RegistryKey): Address {
  const entry = registry.entries().find(([k]) => k === key)?.[1];
  if (!entry?.verified || entry.address === 'TODO' || entry.check === 'VERIFY' || entry.check === 'VERIFY_ABI') {
    throw new ChainQuoteError('no_route', `Unverified execution address: ${key}`);
  }
  return registry.requireAddress(key);
}
function rpcFailure(err: unknown): boolean {
  const e = err as { name?: string; cause?: { name?: string }; message?: string };
  return /HttpRequestError|TimeoutError|FetchError|SocketClosedError/.test(e.cause?.name ?? e.name ?? '') || /fetch failed|ECONNREFUSED|timed out/i.test(e.message ?? '');
}

/** Unsigned zero-terminal-fee route construction. Guard/probe/account binding is a separate gate.
 * @remarks
 * Validate amount/slippage, accepted manifest wiring and factory-confirmed indexed pools at one
 * block, then select the highest net-USD unsigned route. Caller owns wallet auth, Guard/probe and
 * binding. Missing prices/fee estimates, unsupported routes, RPC failures or invalid raw units
 * reject. Route remains executable=false with zero terminal fee. An exact ERC-20 approval is
 * listed when the account's allowance at the block is below the input (always without an account).
 * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../../docs/security/INVARIANTS.md | Unsigned execution and current admission invariants}
 */
export async function quoteV3Trade(client: PublicClient, input: TradeQuoteRequest, sources: V3TradeSources, now = Date.now): Promise<V3TradeRoute> {
  if (!positive(input.amountUsd)) throw new ChainQuoteError('bad_request', 'Amount must be positive and finite');
  if (!Number.isInteger(input.slippageBps) || input.slippageBps < 0 || input.slippageBps >= 10_000) {
    throw new ChainQuoteError('bad_request', 'Slippage must be an integer from 0 to 9999 bps');
  }
  const registry = sources.registry ?? loadRegistry();
  const factory = verified(registry, 'uniswapV3.factory');
  const quoter = verified(registry, 'uniswapV3.quoterV2');
  const router = verified(registry, 'uniswapV3.swapRouter02');
  if (registry.data.uniswapV3.swapRouter02.check !== 'router02_wiring') throw new ChainQuoteError('no_route', 'Router wiring is unverified');
  const weth = verified(registry, 'tokens.WETH');
  const usdg = verified(registry, 'tokens.USDG');
  // Always the current head: viem's default block-number cache (the polling interval) can pin a fresh quote to a block
  // from before the wallet's just-confirmed approval, which would list that approval again.
  const block = await client.getBlockNumber({ cacheTime: 0 });
  if (block > BigInt(Number.MAX_SAFE_INTEGER)) throw new ChainQuoteError('stale_data', 'Block is out of range');
  const quotedAt = now();
  const indexed = await sources.pools(input.coin, block);
  const pools = indexed.filter(p => FEES.has(p.fee) && !same(p.currency0, p.currency1) &&
    ((same(p.currency0, input.coin) && (same(p.currency1, weth) || same(p.currency1, usdg))) ||
     (same(p.currency1, input.coin) && (same(p.currency0, weth) || same(p.currency0, usdg)))));
  if (!pools.length) throw new ChainQuoteError('no_route', 'No indexed v3 pool with a supported quote asset');
  const tokens = [...new Set([input.coin.toLowerCase(), weth.toLowerCase(), ...pools.flatMap(p => [p.currency0.toLowerCase(), p.currency1.toLowerCase()])])] as Address[];
  const metadata = new Map(await Promise.all(tokens.map(async token => {
    const [decimals, price] = await Promise.all([
      withRpcOrigin('server.v3_routes.L143',()=>client.readContract({ address: token, abi: ERC20_ABI, functionName: 'decimals', blockNumber: block })),
      sources.priceUsd(token, block),
    ]);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new ChainQuoteError('no_route', 'Invalid token decimals');
    return [token.toLowerCase(), { decimals, price }] as const;
  })));
  const ethPrice = metadata.get(weth.toLowerCase())!.price;
  if (metadata.get(weth.toLowerCase())!.decimals !== 18) throw new ChainQuoteError('no_route', 'Native ETH route requires 18-decimal WETH');
  if (!positive(ethPrice)) throw new ChainQuoteError('stale_data', 'ETH USD price unavailable');
  const recipient = input.account ?? padHex('0x01', { size: 20 });
  // An approval is listed only while the wallet's current allowance is short; indicative quotes always list it.
  const allowances = new Map<string, Promise<bigint>>();
  const allowanceOf = (token: Address) => {
    let found = allowances.get(token.toLowerCase());
    if (!found) {
      found = withRpcOrigin('server.v3_routes.L158',()=>client.readContract({ address: token, abi: ERC20_ABI, functionName: 'allowance', args: [input.account!, router], blockNumber: block }));
      allowances.set(token.toLowerCase(), found);
    }
    return found;
  };
  let missingPrice = false;
  let missingFee = false;
  let rpcFailures = 0;
  const candidates = await Promise.all(pools.map(async pool => {
    const quote = same(pool.currency0, input.coin) ? pool.currency1 : pool.currency0;
    const tokenIn = input.side === 'buy' ? quote : input.coin;
    const tokenOut = input.side === 'buy' ? input.coin : quote;
    const inMeta = metadata.get(tokenIn.toLowerCase())!;
    const outMeta = metadata.get(tokenOut.toLowerCase())!;
    if (!positive(inMeta.price) || !positive(outMeta.price)) { missingPrice = true; return null; }
    const amountIn = rawUsd(input.amountUsd, inMeta.price, inMeta.decimals);
    if (amountIn <= 0n || amountIn >= 2n ** 256n) throw new ChainQuoteError('bad_request', 'Amount is outside token unit range');
    let amountOut: bigint;
    let gasEstimate: bigint;
    let sqrtPrice: bigint;
    let token0: Address;
    let approvalNeeded: boolean;
    try {
      const canonical = await withRpcOrigin('server.v3_routes.L181',()=>client.readContract({ address: factory, abi: FACTORY_ABI, functionName: 'getPool', args: [tokenIn, tokenOut, pool.fee], blockNumber: block }));
      if (same(canonical, zeroAddress) || !same(canonical, pool.address)) return null;
      const [quoted, slot, first] = await Promise.all([
        withRpcOrigin('server.v3_routes.rawL185',()=>client.simulateContract({ address: quoter, abi: QUOTER_V2_ABI, functionName: 'quoteExactInputSingle', args: [{ tokenIn, tokenOut, amountIn, fee: pool.fee, sqrtPriceLimitX96: 0n }], blockNumber: block })),
        withRpcOrigin('server.v3_routes.L185',()=>client.readContract({ address: canonical, abi: POOL_ABI, functionName: 'slot0', blockNumber: block })),
        withRpcOrigin('server.v3_routes.L186',()=>client.readContract({ address: canonical, abi: POOL_ABI, functionName: 'token0', blockNumber: block })),
      ]);
      [amountOut, , , gasEstimate] = quoted.result;
      sqrtPrice = slot[0]; token0 = first;
      if (amountOut <= 0n || sqrtPrice <= 0n || (!same(token0, tokenIn) && !same(token0, tokenOut))) return null;
      approvalNeeded = !(input.side === 'buy' && same(tokenIn, weth)) && (!input.account || await allowanceOf(tokenIn) < amountIn);
    } catch (err) {
      if (rpcFailure(err)) rpcFailures++;
      return null;
    }
    const minOut = amountOut * BigInt(10_000 - input.slippageBps) / 10_000n;
    if (minOut <= 0n) return null;
    const nativeIn = input.side === 'buy' && same(tokenIn, weth);
    const nativeOut = input.side === 'sell' && same(tokenOut, weth);
    const calls = [encodeFunctionData({ abi: ROUTER_ABI, functionName: 'exactInputSingle', args: [{
      tokenIn, tokenOut, fee: pool.fee, recipient: nativeOut ? padHex('0x02', { size: 20 }) : recipient,
      amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n,
    }] })];
    if (nativeOut) calls.push(encodeFunctionData({ abi: ROUTER_ABI, functionName: 'unwrapWETH9', args: [minOut, recipient] }));
    const tx: UnsignedTx = { chainId: 4663, to: router, value: nativeIn ? amountIn.toString() : '0',
      data: encodeFunctionData({ abi: ROUTER_ABI, functionName: 'multicall', args: [BigInt(Math.floor(quotedAt / 1000) + 120), calls] }),
    };
    const feeWei = await sources.networkFeeWei(tx, gasEstimate + 60_000n, block);
    if (feeWei === null || feeWei < 0n) { missingFee = true; return null; }
    const networkFeeUsd = Number(formatUnits(feeWei, 18)) * ethPrice;
    const out = Number(formatUnits(amountOut, outMeta.decimals));
    const q = Number(sqrtPrice) / 2 ** 96;
    const spot = same(token0, tokenIn) ? q * q * 10 ** (inMeta.decimals - outMeta.decimals) : 1 / (q * q * 10 ** (outMeta.decimals - inMeta.decimals));
    const ideal = Number(formatUnits(amountIn, inMeta.decimals)) * spot * (1 - pool.fee / 1_000_000);
    const netUsd = out * outMeta.price - networkFeeUsd;
    if (!Number.isFinite(netUsd) || !Number.isFinite(ideal) || ideal <= 0) return null;
    const route: V3TradeRoute = {
      amountIn: amountIn.toString(), valueWei: tx.value, expectedOut: amountOut.toString(), minOut: minOut.toString(),
      networkFeeUsd, priceImpactBps: Math.max(0, (ideal - out) / ideal * 10_000),
      // Construction alone is never an accepted probe or account-bound preflight.
      route: { venue: 'uniswap_v3', poolId: pool.address, executable: false },
      fee: { bps: 0, usd: 0, destination: null },
      approvals: nativeIn || !approvalNeeded ? [] : [{ token: tokenIn, spender: router, amount: amountIn.toString(), kind: 'erc20' }],
      asOfBlock: Number(block), expiresAt: new Date(quotedAt + 20_000).toISOString(), tx,
    };
    return { route, netUsd };
  }));
  const best = candidates.filter(c => c !== null).sort((a, b) => b.netUsd - a.netUsd)[0];
  if (best) return best.route;
  if (missingPrice) throw new ChainQuoteError('stale_data', 'Route USD price unavailable');
  if (missingFee) throw new ChainQuoteError('sim_unavailable', 'Total network fee estimate unavailable');
  if (rpcFailures) throw new ChainQuoteError('rpc_unavailable', 'RPC unavailable while quoting indexed pools');
  throw new ChainQuoteError('no_route', 'No indexed v3 pool could fill this size');
}
