import { describe, expect, it, vi } from 'vitest';
import { loadRegistry } from '@eko/chain';
import { decodeFunctionData, padHex, zeroAddress, type Address, type PublicClient } from 'viem';
import { UniswapV3Adapter, ROUTER_ABI, type ChainClients } from '../src/exec/chain.js';
import { indexedV3Pools, type IndexedV3Pool, type V3TradeSources } from '../src/exec/v3-routes.js';
import type { TradeQuoteRequest } from '@eko/shared';

const coin = padHex('0x10', { size: 20 });
const account = padHex('0x20', { size: 20 });
const block = 77_500_000n;
const now = () => 1_791_000_000_000;
const request: TradeQuoteRequest = { coin, account, side: 'buy', amountUsd: 100, slippageBps: 50 };

function fixture(quoteAsset: 'WETH' | 'USDG' = 'WETH', decimals = 6, reverse = false, allowance = 0n) {
  const registry = loadRegistry();
  const quote = registry.requireAddress(`tokens.${quoteAsset}`);
  const weth = registry.requireAddress('tokens.WETH');
  const usdg = registry.requireAddress('tokens.USDG');
  const router = registry.requireAddress('uniswapV3.swapRouter02');
  const pools: IndexedV3Pool[] = [100, 500, 3000, 10000].map((fee, i) => ({
    address: padHex(`0x${(40 + i).toString(16)}`, { size: 20 }), fee,
    currency0: reverse ? quote : coin, currency1: reverse ? coin : quote,
  }));
  const readContract = vi.fn(async (args: { functionName: string; args?: unknown[]; address: Address }) => {
    switch (args.functionName) {
      case 'decimals': return args.address.toLowerCase() === usdg.toLowerCase() ? 6 : args.address.toLowerCase() === coin ? decimals : 18;
      case 'getPool': return pools.find(p => p.fee === args.args?.[2])?.address ?? zeroAddress;
      case 'token0': return reverse ? quote : coin;
      // The account's current allowance for the router (fixture: none unless a test grants it).
      case 'allowance': return allowance;
      // 1 coin = 1 quote, with the respective raw-unit scale and token ordering.
      case 'slot0': {
        const pool = pools.find(p => p.address === args.address)!;
        const quoteDecimals = [pool.currency0, pool.currency1].some(token => token.toLowerCase() === usdg.toLowerCase()) ? 6 : 18;
        const ratio = 10 ** ((reverse ? decimals - quoteDecimals : quoteDecimals - decimals) / 2);
        return [BigInt(Math.floor(2 ** 96 * ratio)), 0, 0, 0, 0, 0, true];
      }
      default: throw new Error(`Unexpected read: ${args.functionName}`);
    }
  });
  const simulateContract = vi.fn(async (args: { args: [{ tokenOut: Address; fee: number }] }) => {
    const { tokenOut, fee } = args.args[0];
    const outputDecimals = tokenOut === coin ? decimals : quoteAsset === 'WETH' ? 18 : 6;
    // Tier 500 has greatest gross output, but expensive gas makes tier 3000 best net.
    const gross = fee === 500 ? 102n : fee === 3000 ? 101n : 100n;
    return { result: [gross * 10n ** BigInt(outputDecimals), 1n, 0, fee === 500 ? 9_000_000n : 100_000n] };
  });
  const client = { getBlockNumber: vi.fn(async () => block), readContract, simulateContract } as unknown as PublicClient;
  const sources: V3TradeSources = {
    registry,
    pools: vi.fn(async () => pools),
    priceUsd: vi.fn(async token => token.toLowerCase() === weth.toLowerCase() ? 2000 : 1),
    networkFeeWei: vi.fn(async (_tx, gas) => gas > 1_000_000n ? 2n * 10n ** 15n : 10n ** 14n),
  };
  const chains = { get: () => client } as unknown as ChainClients;
  const adapter = new UniswapV3Adapter(chains, 'robinhood-mainnet', () => 2000, now);
  return { adapter, client, sources, pools, router, quote, weth, readContract, simulateContract };
}

function calls(data: `0x${string}`) {
  const outer = decodeFunctionData({ abi: ROUTER_ABI, data });
  if (outer.functionName !== 'multicall') throw new Error('Expected multicall');
  return { deadline: outer.args[0], legs: outer.args[1].map(data => decodeFunctionData({ abi: ROUTER_ABI, data })) };
}

describe('indexed v3 unsigned CA-7 routes (injected fixture evidence)', () => {
  it('buys coin with native ETH: exact raw value, recipient, minOut, no approval or terminal fee leg', async () => {
    const f = fixture();
    const q = await f.adapter.quoteTrade(request, f.sources);
    expect(q.amountIn).toBe('50000000000000000');
    expect(q.valueWei).toBe(q.amountIn);
    expect(q.expectedOut).toBe('101000000');
    expect(q.minOut).toBe('100495000');
    expect(q.approvals).toEqual([]);
    expect(q.fee).toEqual({ bps: 0, usd: 0, destination: null });
    expect(q.route).toEqual({ venue: 'uniswap_v3', poolId: f.pools[2]!.address, executable: false });
    expect(q.asOfBlock).toBe(Number(block));
    expect(q.expiresAt).toBe(new Date(now() + 20_000).toISOString());
    expect(q.networkFeeUsd).toBeCloseTo(0.2);
    expect(q.tx).toMatchObject({ chainId: 4663, to: f.router, value: q.amountIn });
    const encoded = calls(q.tx.data);
    expect(encoded.deadline).toBe(BigInt(now() / 1000 + 120));
    expect(encoded.legs).toHaveLength(1);
    expect(encoded.legs[0]).toMatchObject({ functionName: 'exactInputSingle', args: [{
      tokenIn: f.weth, tokenOut: coin, fee: 3000, recipient: account,
      amountIn: BigInt(q.amountIn), amountOutMinimum: BigInt(q.minOut), sqrtPriceLimitX96: 0n,
    }] });
  });

  it.each([6, 8, 18])('sells a %i-decimal coin for native ETH with exact approval and unwrap', async decimals => {
    const f = fixture('WETH', decimals, true);
    const q = await f.adapter.quoteTrade({ ...request, side: 'sell' }, f.sources);
    expect(q.amountIn).toBe((100n * 10n ** BigInt(decimals)).toString());
    expect(q.valueWei).toBe('0');
    expect(q.tx.value).toBe('0');
    expect(q.approvals).toEqual([{ token: coin, spender: f.router, amount: q.amountIn, kind: 'erc20' }]);
    const { legs } = calls(q.tx.data);
    expect(legs).toHaveLength(2);
    expect(legs[0]).toMatchObject({ functionName: 'exactInputSingle', args: [{
      tokenIn: coin, tokenOut: f.weth, recipient: padHex('0x02', { size: 20 }), amountIn: BigInt(q.amountIn), amountOutMinimum: BigInt(q.minOut),
    }] });
    expect(legs[1]).toMatchObject({ functionName: 'unwrapWETH9', args: [BigInt(q.minOut), account] });
    expect(q.fee.destination).toBeNull();
  });

  it.each(['buy', 'sell'] as const)('constructs USDG %s as a token leg without value or fee sweep', async side => {
    const f = fixture('USDG', 8);
    const q = await f.adapter.quoteTrade({ ...request, side, slippageBps: 0 }, f.sources);
    expect(q.amountIn).toBe(side === 'buy' ? '100000000' : '10000000000');
    expect(q.expectedOut).toBe(q.minOut);
    expect(q.valueWei).toBe('0');
    expect(q.approvals[0]).toEqual({ token: side === 'buy' ? f.quote : coin, spender: f.router, amount: q.amountIn, kind: 'erc20' });
    const { legs } = calls(q.tx.data);
    expect(legs).toHaveLength(1);
    expect(legs[0]).toMatchObject({ functionName: 'exactInputSingle', args: [{ recipient: account, amountIn: BigInt(q.amountIn), amountOutMinimum: BigInt(q.minOut) }] });
  });

  it.each(['buy', 'sell'] as const)('lists the exact %s approval only while the account allowance is short', async side => {
    const short = fixture('USDG', 8, false, 99n);
    const q = await short.adapter.quoteTrade({ ...request, side }, short.sources);
    expect(q.approvals).toEqual([{ token: side === 'buy' ? short.quote : coin, spender: short.router, amount: q.amountIn, kind: 'erc20' }]);
    const allowanceReads = short.readContract.mock.calls.filter(([args]) => args.functionName === 'allowance');
    expect(allowanceReads.length).toBeGreaterThan(0);
    for (const [args] of allowanceReads) expect(args).toMatchObject({ args: [account, short.router], blockNumber: block });
    const enough = fixture('USDG', 8, false, BigInt(q.amountIn));
    expect((await enough.adapter.quoteTrade({ ...request, side }, enough.sources)).approvals).toEqual([]);
    // Without an account the allowance is unknown: the approval stays listed and nothing is read for it.
    const indicative = fixture('USDG', 8, false, BigInt(q.amountIn));
    expect((await indicative.adapter.quoteTrade({ ...request, side, account: undefined }, indicative.sources)).approvals).toHaveLength(1);
    expect(indicative.readContract.mock.calls.some(([args]) => args.functionName === 'allowance')).toBe(false);
  });
  it('pins every decimal, pool, slot and tier read, price and fee estimate to one block', async () => {
    const f = fixture();
    await f.adapter.quoteTrade(request, f.sources);
    expect(f.client.getBlockNumber).toHaveBeenCalledTimes(1);
    // Never a cached head: a quote right after an approval must see it.
    expect(f.client.getBlockNumber).toHaveBeenCalledWith({ cacheTime: 0 });
    for (const [args] of f.readContract.mock.calls) expect(args).toHaveProperty('blockNumber', block);
    for (const [args] of f.simulateContract.mock.calls) expect(args).toHaveProperty('blockNumber', block);
    expect(f.simulateContract.mock.calls.map(([args]) => args.args[0].fee).sort((a, b) => a - b)).toEqual([100, 500, 3000, 10000]);
    for (const [, b] of vi.mocked(f.sources.priceUsd).mock.calls) expect(b).toBe(block);
    for (const [, , b] of vi.mocked(f.sources.networkFeeWei).mock.calls) expect(b).toBe(block);
    expect(f.sources.pools).toHaveBeenCalledWith(coin, block);
  });

  it('uses the pool spot and LP fee for price impact with either token order', async () => {
    for (const reverse of [false, true]) {
      const f = fixture('USDG', 8, reverse);
      f.simulateContract.mockImplementation(async () => ({ result: [90n * 10n ** 8n, 1n, 0, 100_000n] }));
      const q = await f.adapter.quoteTrade(request, f.sources);
      expect(q.priceImpactBps).toBeCloseTo((1 - 90 / 99.99) * 10_000, 4);
    }
  });

  it('floors fractional raw input and handles scientific notation without rounding up', async () => {
    const f = fixture('USDG', 18);
    const q = await f.adapter.quoteTrade({ ...request, side: 'sell', amountUsd: 1e-15 }, f.sources);
    expect(q.amountIn).toBe('1000');
    const g = fixture('USDG', 6);
    const r = await g.adapter.quoteTrade({ ...request, amountUsd: 1.23456789 }, g.sources);
    expect(r.amountIn).toBe('1234567');
  });

  it.each([-1, 10000, 1.5, Number.NaN])('refuses invalid slippage %s before reads', async slippageBps => {
    const f = fixture();
    await expect(f.adapter.quoteTrade({ ...request, slippageBps }, f.sources)).rejects.toMatchObject({ code: 'bad_request' });
    expect(f.client.getBlockNumber).not.toHaveBeenCalled();
  });

  it.each([0, -1, Number.POSITIVE_INFINITY, Number.NaN])('refuses invalid USD amount %s', async amountUsd => {
    const f = fixture();
    await expect(f.adapter.quoteTrade({ ...request, amountUsd }, f.sources)).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('refuses no indexed pool, factory mismatch and reverted tiers', async () => {
    const f = fixture();
    vi.mocked(f.sources.pools).mockResolvedValueOnce([]);
    await expect(f.adapter.quoteTrade(request, f.sources)).rejects.toMatchObject({ code: 'no_route' });
    const g = fixture();
    for (const p of g.pools) p.address = zeroAddress;
    await expect(g.adapter.quoteTrade(request, g.sources)).rejects.toMatchObject({ code: 'no_route' });
    const h = fixture();
    h.simulateContract.mockRejectedValue(new Error('execution reverted'));
    await expect(h.adapter.quoteTrade(request, h.sources)).rejects.toMatchObject({ code: 'no_route' });
  });

  it('distinguishes RPC failure from no liquidity', async () => {
    const f = fixture();
    f.simulateContract.mockRejectedValue(new Error('fetch failed'));
    await expect(f.adapter.quoteTrade(request, f.sources)).rejects.toMatchObject({ code: 'rpc_unavailable' });
  });

  it('refuses missing/invalid prices and unavailable total network fee instead of assuming zero', async () => {
    for (const price of [null, 0, Number.NaN]) {
      const f = fixture();
      vi.mocked(f.sources.priceUsd).mockImplementation(async token => token === coin ? price : 2000);
      await expect(f.adapter.quoteTrade(request, f.sources)).rejects.toMatchObject({ code: 'stale_data' });
    }
    const f = fixture();
    vi.mocked(f.sources.networkFeeWei).mockResolvedValue(null);
    await expect(f.adapter.quoteTrade(request, f.sources)).rejects.toMatchObject({ code: 'sim_unavailable' });
  });

  it('rejects unverified router wiring and keeps later fee functions out of the ABI', async () => {
    const f = fixture();
    f.sources.registry!.data.uniswapV3.swapRouter02.check = 'VERIFY';
    await expect(f.adapter.quoteTrade(request, f.sources)).rejects.toMatchObject({ code: 'no_route' });
    expect(ROUTER_ABI.map(fn => fn.name)).toEqual(['exactInputSingle', 'unwrapWETH9', 'multicall']);
  });

  it('refuses missing ETH pricing and unsupported/noncanonical route assets', async () => {
    const f = fixture();
    vi.mocked(f.sources.priceUsd).mockImplementation(async token => token.toLowerCase() === f.weth.toLowerCase() ? null : 1);
    await expect(f.adapter.quoteTrade(request, f.sources)).rejects.toMatchObject({ code: 'stale_data' });
    const g = fixture();
    for (const p of g.pools) p.fee = 2500;
    await expect(g.adapter.quoteTrade(request, g.sources)).rejects.toMatchObject({ code: 'no_route' });
    const h = fixture();
    for (const p of h.pools) p.currency1 = padHex('0x99', { size: 20 });
    await expect(h.adapter.quoteTrade(request, h.sources)).rejects.toMatchObject({ code: 'no_route' });
  });

  it('compares output USD after network cost across ETH and USDG pools', async () => {
    const f = fixture();
    const usdg = f.sources.registry!.requireAddress('tokens.USDG');
    f.pools[0]!.currency1 = usdg;
    // The buy has the same output denomination. Prefer its greater net output, even
    // though the input denominations and raw units differ.
    f.simulateContract.mockImplementation(async ({ args }) => ({ result: [BigInt(args[0].fee === 100 ? 110_000_000 : 101_000_000), 1n, 0, 100_000n] }));
    const q = await f.adapter.quoteTrade(request, f.sources);
    expect(q.route.poolId).toBe(f.pools[0]!.address);
    expect(q.tx.value).toBe('0');
    expect(q.approvals[0]?.token).toBe(usdg);
    expect(q.amountIn).toBe('100000000');
  });

  it('keeps indicative unsigned construction unavailable for execution and never sets account binding', async () => {
    const f = fixture();
    const q = await f.adapter.quoteTrade({ ...request, account: undefined }, f.sources);
    expect(q.route.executable).toBe(false);
    expect(q).not.toHaveProperty('binding');
    expect(calls(q.tx.data).legs[0]).toMatchObject({ args: [{ recipient: padHex('0x01', { size: 20 }) }] });
  });

  it('reads indexed pool rows with bound coin and snapshot parameters', async () => {
    const f = fixture();
    const query = vi.fn(async () => ({ rows: f.pools.map(p => ({ id: Buffer.from(p.address.slice(2), 'hex'), currency0: Buffer.from(p.currency0.slice(2), 'hex'), currency1: Buffer.from(p.currency1.slice(2), 'hex'), fee: p.fee })) }));
    const result = await indexedV3Pools({ query } as unknown as Parameters<typeof indexedV3Pools>[0])(coin, block);
    expect(result).toEqual(f.pools.map(p => ({ ...p, currency1: p.currency1.toLowerCase() })));
    expect(query).toHaveBeenCalledWith(expect.stringContaining('created_block <= $2 AND block <= $2'), [Buffer.from(coin.slice(2), 'hex'), block.toString()]);
  });
});
