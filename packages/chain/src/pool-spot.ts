import { batchGetters } from './rpc/getter-batch.js';
import { decodeFunctionResult, encodeFunctionData, parseAbi, toHex, zeroAddress, type Address, type Hex } from 'viem';
import { loadRegistry, type AddressRegistry } from './registry.js';
import { rpcStopReason } from './rpc/metered.js';

/** A raw JSON-RPC requester (a viem client or the sell check's metered lane). */
export interface SpotRpc { request(input: { method: string; params: readonly unknown[] }): Promise<unknown> }
/** A token's Uniswap v3 pool against USDG and whether the token is its token0 (Uniswap orders the pair by address). */
export interface UsdgPool { pool: Address; tokenFirst: boolean }

const FEES = [100, 500, 3000, 10000] as const;
const factoryAbi = parseAbi(['function getPool(address,address,uint24) view returns (address)']);
const poolAbi = parseAbi(['function liquidity() view returns (uint128)', 'function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)']);

/**
 * The token's most liquid Uniswap v3 pool against USDG at the block (one getPool per fee tier, one liquidity read per
 * pool found). Robinhood stock tokens trade there; their pools are not indexed, so they have no indexed USD price.
 * Null without a pool holding liquidity. Provider failures and budget stops propagate.
 */
export async function bestUsdgPool(rpc: SpotRpc, token: Address, block: bigint, registry: AddressRegistry = loadRegistry(), batch = false): Promise<{ pool: UsdgPool | null; requests: number }> {
  const factory = registry.addressOf('uniswapV3.factory'), usdg = registry.requireAddress('tokens.USDG');
  let requests = 0, best: { pool: UsdgPool; liquidity: bigint } | null = null;
  if (!factory) return { pool: null, requests };
  const call = async (to: Address, data: Hex) => { requests++; return await rpc.request({ method: 'eth_call', params: [{ to, data }, toHex(block)] }) as Hex; };
  if (!batch) {
    for (const fee of FEES) {
      const pool = decodeFunctionResult({ abi: factoryAbi, functionName: 'getPool', data: await call(factory, encodeFunctionData({ abi: factoryAbi, functionName: 'getPool', args: [token, usdg, fee] })) });
      if (pool === zeroAddress) continue;
      const liquidity = decodeFunctionResult({ abi: poolAbi, functionName: 'liquidity', data: await call(pool, encodeFunctionData({ abi: poolAbi, functionName: 'liquidity' })) });
      if (liquidity > 0n && (!best || liquidity > best.liquidity)) best = { pool: { pool, tokenFirst: token.toLowerCase() < usdg.toLowerCase() }, liquidity };
    }
  } else {
    requests++;
    const pools=await batchGetters(rpc,FEES.map(fee=>({to:factory,
      data:encodeFunctionData({abi:factoryAbi,functionName:'getPool',args:[token,usdg,fee]})})),block);
    const addresses=pools.map(data=>decodeFunctionResult({abi:factoryAbi,functionName:'getPool',data})).filter(pool=>pool!==zeroAddress);
    if(addresses.length)requests++;
    const liquids=await batchGetters(rpc,addresses.map(to=>({to,data:encodeFunctionData({abi:poolAbi,functionName:'liquidity'})})),block);
    for(let i=0;i<addresses.length;i++) {
      const pool=addresses[i],liquidity=decodeFunctionResult({abi:poolAbi,functionName:'liquidity',data:liquids[i]});
      if(liquidity>0n && (!best || liquidity>best.liquidity))best={pool:{pool,tokenFirst:token.toLowerCase()<usdg.toLowerCase()},liquidity};
    }
  }
  return { pool: best?.pool ?? null, requests };
}
/** The pool's spot USD price of one whole token at the block (one slot0 read). Null when the price is not positive. */
export async function usdgPoolPrice(rpc: SpotRpc, pool: UsdgPool, decimals: number, block: bigint, registry: AddressRegistry = loadRegistry()): Promise<number | null> {
  const usdgDecimals = registry.data.tokens.USDG.decimals ?? 6;
  const [sqrtPriceX96] = decodeFunctionResult({ abi: poolAbi, functionName: 'slot0', data: await rpc.request({ method: 'eth_call',
    params: [{ to: pool.pool, data: encodeFunctionData({ abi: poolAbi, functionName: 'slot0' }) }, toHex(block)] }) as Hex });
  // token1 per token0 in base units.
  const raw = (Number(sqrtPriceX96) / 2 ** 96) ** 2;
  const usd = (pool.tokenFirst ? raw : 1 / raw) * 10 ** (decimals - usdgDecimals);
  return Number.isFinite(usd) && usd > 0 ? usd : null;
}
/**
 * The token's spot USD price in its most liquid Uniswap v3 USDG pool at the block. A failed read leaves the price
 * unknown (`failed`), never "no pool"; budget and shutdown stops propagate.
 */
export async function poolSpotUsd(rpc: SpotRpc, token: Address, decimals: number, block: number | bigint, registry: AddressRegistry = loadRegistry()): Promise<{ usd: number | null; requests: number; failed?: true }> {
  let requests = 0;
  try {
    const found = await bestUsdgPool(rpc, token, BigInt(block), registry);
    requests += found.requests;
    if (!found.pool) return { usd: null, requests };
    requests++;
    return { usd: await usdgPoolPrice(rpc, found.pool, decimals, BigInt(block), registry), requests };
  } catch (error) {
    if (rpcStopReason(error)) throw error;
    return { usd: null, requests, failed: true };
  }
}
