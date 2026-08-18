import { describe, expect, it } from 'vitest';
import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, encodeFunctionData, pad, parseAbi, toHex, zeroAddress, type Address, type Hex } from 'viem';
import { bestUsdgPool, poolSpotUsd, usdgPoolPrice } from '../src/pool-spot.js';
import { loadRegistry } from '../src/registry.js';
import { RpcGuardError } from '../src/rpc/metered.js';

// Synthetic transport only: every reply is an ABI-encoded fixture, never a live chain reading.
const registry = loadRegistry(), usdg = registry.requireAddress('tokens.USDG').toLowerCase() as Address, factory = registry.requireAddress('uniswapV3.factory').toLowerCase();
const abi = parseAbi(['function getPool(address,address,uint24) view returns (address)', 'function liquidity() view returns (uint128)',
  'function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)']);
const low = '0x0000000000000000000000000000000000000a01' as Address, high = '0xffffffffffffffffffffffffffffffffffff0a02' as Address;
const slot0 = (sqrt: bigint) => encodeAbiParameters([{ type: 'uint160' }, { type: 'int24' }, { type: 'uint16' }, { type: 'uint16' }, { type: 'uint16' }, { type: 'uint8' }, { type: 'bool' }], [sqrt, 0, 0, 0, 0, 0, true]);
/** Pools by fee for one token: liquidity and token1-per-token0 price in base units. */
function chain(token: Address, pools: Record<number, { liquidity: bigint; raw: number }>) {
  const addressOf = (fee: number) => `0x${fee.toString(16).padStart(40, '0')}` as Address;
  return { request: async ({ params }: { method: string; params: readonly unknown[] }) => {
    const [call] = params as [{ to: string; data: Hex }];
    if (call.to.toLowerCase() === factory) {
      const [a, b, fee] = decodeFunctionData({ abi, data: call.data }).args as [Address, Address, number];
      expect([a.toLowerCase(), b.toLowerCase()]).toEqual([token.toLowerCase(), usdg]);
      return pad(pools[fee] ? addressOf(fee) : zeroAddress);
    }
    const fee = Number(BigInt(call.to)), pool = pools[fee]!;
    return call.data === encodeFunctionData({ abi, functionName: 'liquidity' }) ? pad(toHex(pool.liquidity)) : slot0(BigInt(Math.round(Math.sqrt(pool.raw) * 2 ** 96)));
  } };
}

describe('Uniswap v3 USDG pool prices', () => {
  it('reads the most liquid pool and prices a whole token in USD, whichever side the token is on', async () => {
    // $50 a share: 50e6 USDG base units per 1e18 token base units when the token sorts first.
    const first = chain(low, { 500: { liquidity: 10n, raw: 49 * 1e6 / 1e18 }, 3000: { liquidity: 1000n, raw: 50 * 1e6 / 1e18 } });
    const found = await bestUsdgPool(first, low, 9n, registry);
    expect(found).toEqual({ pool: { pool: `0x${(3000).toString(16).padStart(40, '0')}`, tokenFirst: true }, requests: 6 });
    expect(await usdgPoolPrice(first, found.pool!, 18, 9n, registry)).toBeCloseTo(50, 6);
    // When USDG sorts first the pool quotes token per USDG.
    const second = chain(high, { 10000: { liquidity: 5n, raw: 1e18 / (50 * 1e6) } });
    expect((await poolSpotUsd(second, high, 18, 9n, registry)).usd).toBeCloseTo(50, 6);
  });
  it('has no price without a pool holding liquidity, and an unknown one when a read fails', async () => {
    expect(await poolSpotUsd(chain(low, {}), low, 18, 9n, registry)).toEqual({ usd: null, requests: 4 });
    expect(await poolSpotUsd(chain(low, { 500: { liquidity: 0n, raw: 1 } }), low, 18, 9n, registry)).toEqual({ usd: null, requests: 5 });
    expect(await poolSpotUsd({ request: async () => { throw new Error('header not found'); } }, low, 18, 9n, registry)).toEqual({ usd: null, requests: 0, failed: true });
    await expect(poolSpotUsd({ request: async () => { throw new RpcGuardError('rpc_budget_exhausted'); } }, low, 18, 9n, registry)).rejects.toThrow('rpc_budget_exhausted');
  });
});

it('batches worker pool discovery at the same block: identical pool, six calls become two',async()=>{
  const raw=chain(low,{500:{liquidity:10n,raw:1},3000:{liquidity:1000n,raw:1}});
  const multi=parseAbi(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)']);
  let counted=0;
  const rpc={request:async (r:{method:string;params:readonly unknown[]})=>{
    counted++;expect(r.params[1]).toBe('0x9');
    const [call]=r.params as [{to:Address;data:Hex}];
    if(call.to.toLowerCase()!==registry.requireAddress('multicall3').toLowerCase())return raw.request(r);
    const decoded=decodeFunctionData({abi:multi,data:call.data});
    const results=await Promise.all(decoded.args[0].map(async c=>({success:true,returnData:await raw.request({method:'eth_call',params:[{to:c.target,data:c.callData},r.params[1]]}) as Hex})));
    return encodeFunctionResult({abi:multi,functionName:'aggregate3',result:results});
  }};
  const before=await bestUsdgPool(rpc,low,9n,registry);expect(counted).toBe(6);counted=0;
  const after=await bestUsdgPool(rpc,low,9n,registry,true);expect(after.pool).toEqual(before.pool);
  expect(after.requests).toBe(2);expect(counted).toBe(2);
});
