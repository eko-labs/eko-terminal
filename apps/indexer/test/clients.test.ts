import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadRegistry, defaultPublicRpc, RpcMeter, RpcGuardError } from '@eko/chain';
import { native } from '../src/clients.js';
const mocks = vi.hoisted(() => ({ count: 0, request: vi.fn(), archive: vi.fn(), publicRead: vi.fn(), contractRead: vi.fn(), slotRead: vi.fn() }));
vi.mock('viem', async importOriginal => {
  const actual = await importOriginal<typeof import('viem')>();
  return { ...actual, createPublicClient: vi.fn(() => ({ request: mocks.request, readContract: mocks.slotRead, multicall: [mocks.publicRead,mocks.contractRead,mocks.archive][mocks.count++] })) };
});
import { createClients } from '../src/clients.js';
const registry = loadRegistry();
const make = () => {
  const env = { RPC_HTTP_URL: defaultPublicRpc };
  return createClients(env, registry, new RpcMeter(env, { store: { reserve: async () => ({ allowed: true, total: 0 }), today: async () => [] } }));
};
beforeEach(() => { mocks.count = 0; mocks.request.mockReset(); mocks.archive.mockReset(); mocks.publicRead.mockReset(); mocks.contractRead.mockReset(); mocks.slotRead.mockReset(); });
const success = (result: unknown) => ({ status: 'success', result });
const failure = { status: 'failure', error: new Error('Contract unavailable') };
describe('Multicall3 and archive reads', () => {
  it('applies the address/block budget to every outgoing eth_getLogs request', async () => {
    mocks.request.mockResolvedValue([]);
    const addresses = Array.from({ length: 101 }, (_, i) => `0x${(i+1).toString(16).padStart(40,'0')}` as const);
    expect(await make().logs({ from: 0n, to: 199999n, addresses, topics: [] })).toEqual([]);
    expect(mocks.request).toHaveBeenCalledTimes(102);
    for (const [input] of mocks.request.mock.calls) {
      expect(input.method).toBe('eth_getLogs');
      const f = input.params[0];
      expect(Number(BigInt(f.toBlock)-BigInt(f.fromBlock)+1n)*f.address.length).toBeLessThanOrEqual(200000);
      expect(BigInt(f.toBlock)-BigInt(f.fromBlock)+1n).toBeLessThanOrEqual(100000n);
    }
  });

  it.each(['rpc_session_budget_reached', 'rpc_budget_exhausted', 'shutdown_requested', 'rpc_unavailable'] as const)('propagates %s from partial Multicall failures instead of null metadata', async reason => {
    const error = new Error('Read refused', { cause: new RpcGuardError(reason) });
    mocks.archive.mockResolvedValue([success(18), { status: 'failure', error }, success('Sample token'), success(1n)]);
    await expect(make().tokenMetadataBatch!([registry.requireAddress('tokens.WETH')], 1234n)).rejects.toBe(error);
  });
  it('batches decimals/symbol/name/totalSupply for every token into the registered Multicall3 at the requested block', async () => {
    const addresses = [registry.requireAddress('tokens.WETH'), registry.requireAddress('tokens.USDG')];
    mocks.archive.mockResolvedValueOnce([success(18), success('<raw-symbol>'), failure, success(123n), success(6), failure, success('<raw-name>'), failure]);
    const client = make();
    expect(await client.tokenMetadataBatch!(addresses, 1234n)).toEqual([{ decimals: 18, symbol: '<raw-symbol>', name: null, totalSupply: 123n, supplyBlock: 1234n }, { decimals: 6, symbol: null, name: '<raw-name>', totalSupply: null, supplyBlock: null }]);
    const input = mocks.archive.mock.calls[0][0];
    expect(input.multicallAddress).toBe(registry.requireAddress('multicall3')); expect(input.blockNumber).toBe(1234n);
    expect(input.contracts.map((c: { functionName: string }) => c.functionName)).toEqual(['decimals','symbol','name','totalSupply','decimals','symbol','name','totalSupply']);
    expect(input.contracts.map((c: { address: string }) => c.address)).toEqual([addresses[0],addresses[0],addresses[0],addresses[0],addresses[1],addresses[1],addresses[1],addresses[1]]); expect(mocks.publicRead).not.toHaveBeenCalled(); expect(mocks.contractRead).not.toHaveBeenCalled();
  });
  it('pins batched owner/wallet/URI reads to the registered Multicall3 and rejects missing wallets',async()=>{
    const owner=registry.requireAddress('tokens.WETH'),wallet=registry.requireAddress('tokens.USDG');
    mocks.archive.mockResolvedValueOnce([success(owner),success(wallet),success('ipfs://fixture'),success(owner),success(native),failure]);
    const client=make();
    expect(await client.agentWallets!([1n,2n],77n)).toEqual([{owner,wallet,tokenUri:'ipfs://fixture'},{owner,wallet:native,tokenUri:null}]);
    expect(mocks.archive.mock.calls[0][0]).toMatchObject({multicallAddress:registry.requireAddress('multicall3'),blockNumber:77n});
    expect(mocks.archive.mock.calls[0][0].contracts.map((c:{functionName:string})=>c.functionName)).toEqual(['ownerOf','getAgentWallet','tokenURI','ownerOf','getAgentWallet','tokenURI']);
    mocks.archive.mockResolvedValueOnce([success(owner),failure,success('ipfs://fixture')]);
    await expect(client.agentWallets!([1n],78n)).rejects.toThrow('wallet/owner');
  });
  it('bounds registry Multicall batches and propagates spend-guard failures',async()=>{
    const owner=registry.requireAddress('tokens.WETH');
    mocks.archive.mockImplementation(async input=>input.contracts.map((c:{functionName:string})=>success(c.functionName==='tokenURI'?'ipfs://fixture':owner)));
    const client=make();expect(await client.agentWallets!(Array.from({length:201},(_,i)=>BigInt(i)),88n)).toHaveLength(201);
    expect(mocks.archive.mock.calls.map(([i])=>i.contracts.length)).toEqual([600,3]);
    const error=new RpcGuardError('rpc_session_budget_reached');
    mocks.archive.mockResolvedValueOnce([{status:'failure',error},success(owner),success('ipfs://fixture')]);
    await expect(client.agentWallets!([1n],89n)).rejects.toBe(error);
  });
  it('uses archive slot0 and token decimals from the deepest initialized reference pool', async () => {
    const pools = [registry.requireAddress('uniswapV3.quoterV2'), registry.requireAddress('uniswapV3.swapRouter02')]; // Neutral test addresses for mock contracts only.
    const slot = (price: number) => [BigInt(Math.floor(Math.sqrt(price/1e12)*2**96)),0,0,0,0,0,true];
    mocks.archive.mockResolvedValueOnce([success(native),success(pools[0]),success(pools[1]),success(native)])
      .mockResolvedValueOnce([success(slot(90000)),success(1n),success(registry.requireAddress('tokens.WETH')),success(slot(2000)),success(10n),success(registry.requireAddress('tokens.WETH'))]);
    const client = make(); const rate = await client.ethUsdRate!(1200n); expect(rate!.value).toBeCloseTo(2000,8); expect(rate!.block).toBe(1200n); expect(rate!.source).toEqual({ address: pools[1], venue: 'uniswap_v3', fee: 3000 });
    expect(mocks.archive.mock.calls.every(([input]) => input.blockNumber === 1200n)).toBe(true); expect(mocks.publicRead).not.toHaveBeenCalled(); expect(mocks.contractRead).not.toHaveBeenCalled();
    expect(mocks.archive.mock.calls[0][0].contracts.every((c: { address: string }) => c.address === registry.requireAddress('uniswapV3.factory'))).toBe(true);
    mocks.slotRead.mockResolvedValue(slot(2100));
    expect(await client.ethUsdRate!(1800n)).toEqual({value:expect.closeTo(2100,8),block:1800n,source:{address:pools[1],venue:'uniswap_v3',fee:3000}});
    expect(mocks.archive).toHaveBeenCalledTimes(2);expect(mocks.slotRead).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({address:pools[1],blockNumber:1800n,functionName:'slot0'}));
  });
  it('shares initial reference discovery across adjacent prefetched sample periods',async()=>{
    const pool=registry.requireAddress('uniswapV3.quoterV2');
    const slot=[BigInt(Math.floor(Math.sqrt(2000/1e12)*2**96)),0,0,0,0,0,true];
    mocks.archive.mockResolvedValueOnce([success(pool),success(native),success(native),success(native)])
      .mockResolvedValueOnce([success(slot),success(1n),success(registry.requireAddress('tokens.WETH'))]);
    mocks.slotRead.mockResolvedValue(slot);
    const client=make();const rates=await Promise.all([client.ethUsdRate!(1200n),client.ethUsdRate!(1800n)]);
    expect(rates.map(r=>r!.block)).toEqual([1200n,1800n]);
    expect(mocks.archive).toHaveBeenCalledTimes(2);expect(mocks.slotRead).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({blockNumber:1800n,functionName:'slot0'}));
  });
  it('discovers a v3 pool with one pinned Multicall and retains third-party factory metadata',async()=>{
    const pool=registry.requireAddress('uniswapV3.quoterV2'),factory=registry.requireAddress('uniswapV3.swapRouter02');
    const currency0=registry.requireAddress('tokens.WETH'),currency1=registry.requireAddress('tokens.USDG');
    mocks.contractRead.mockResolvedValueOnce([success(factory),success(currency0),success(currency1),success(3000),success(60)]);
    expect(await make().v3Pool(pool,1234n)).toEqual({currency0,currency1,fee:3000,tickSpacing:60});
    expect(mocks.contractRead).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({blockNumber:1234n,multicallAddress:registry.requireAddress('multicall3')}));
    expect(mocks.contractRead.mock.calls[0][0].contracts.map((c:{functionName:string})=>c.functionName)).toEqual(['factory','token0','token1','fee','tickSpacing']);
    expect(mocks.slotRead).not.toHaveBeenCalled();
  });
  it('keeps pool probe reverts distinct from transport/guard failures in a Multicall',async()=>{
    const pool=registry.requireAddress('uniswapV3.quoterV2');
    mocks.contractRead.mockResolvedValueOnce([{status:'failure',error:new Error('Contract reverted')},failure,failure,failure,failure]);
    expect(await make().v3Pool(pool,1234n)).toBeNull();
    mocks.count=0;
    const error=new RpcGuardError('rpc_session_budget_reached');
    mocks.contractRead.mockResolvedValueOnce([success(native),{status:'failure',error},failure,failure,failure]);
    await expect(make().v3Pool(pool,1234n)).rejects.toBe(error);
  });
  it('fails archive outages rather than silently producing null prices, and allows history before a reference pool existed', async () => {
    mocks.archive.mockResolvedValueOnce([failure,failure,failure]); await expect(make().tokenMetadataBatch!([registry.requireAddress('tokens.WETH')],600n)).rejects.toThrow('archive');
    mocks.count=0;mocks.archive.mockResolvedValueOnce([failure,failure,failure,failure]); await expect(make().ethUsdRate!(600n)).rejects.toThrow('archive');
    mocks.count=0;mocks.archive.mockResolvedValueOnce([success(native),success(native),success(native),success(native)]); expect(await make().ethUsdRate!(0n)).toBeNull();
  });
});
