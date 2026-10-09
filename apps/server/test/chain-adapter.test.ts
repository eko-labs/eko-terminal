import { RpcGuardError } from '@eko/chain';
import { describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, parseUnits, type Address, type Hex, type TransactionReceipt } from 'viem';
import { UniswapV3Adapter, POOL_ABI, ROUTER_ABI } from '../src/exec/chain.js';
import type { ChainClients } from '../src/exec/chain.js';
import type { VenueQuoteInput } from '../src/exec/types.js';
const wallet = `0x${'11'.repeat(20)}` as Address, hash = `0x${'22'.repeat(32)}` as Hex;
const now = 1_800_000_000_000;
function fixture() {
  const client = {
    simulateContract: vi.fn(async (_args: { args: [{ fee: number }] }) => ({ result: [2n * 10n ** 18n, 0n, 0, 100_000n] })),
    readContract: vi.fn(async ({ functionName }: { functionName: string }): Promise<any> => {
      if (functionName === 'getPool') return wallet;
      if (functionName === 'slot0') return [2n ** 96n];
      if (functionName === 'token0') return adapter.network.tokens.WETH.address;
      if (functionName === 'balanceOf' || functionName === 'allowance') return 10n ** 30n;
      throw new Error('Unexpected fixture read');
    }),
    getGasPrice: vi.fn(async () => 1_000_000_000n), getBalance: vi.fn(async () => 10n ** 20n),
    call: vi.fn(async () => ({})), estimateGas: vi.fn(async () => 200_000n),
    getTransactionReceipt: vi.fn(async () => ({ status: 'success' })), getTransaction: vi.fn(async () => ({ hash })),
  };
  const chains = { get: () => client } as unknown as ChainClients;
  const adapter = new UniswapV3Adapter(chains, 'robinhood-mainnet', () => 2000, () => now);
  const input: VenueQuoteInput = { id: 'fixture-quote', market: 'ETH-USD', side: 'buy', amountIn: 100, slippageBps: 100, account: wallet, referenceMid: 2000, mode: 'live' };
  return { adapter, client, input, chains };
}
describe('configured unsigned v3 adapter', () => {
  it('selects the best tier and binds exact input, slippage, expiry, unwrap recipient and gas cost', async () => {
    const { adapter, client, input } = fixture(), route = adapter.route(input.market)!;
    client.simulateContract.mockImplementation(async (args) => ({ result: [BigInt(args.args[0].fee === route.feeTiers[0] ? 2 : 1) * 10n ** 18n, 0n, 0, 100_000n] }));
    const quote = await adapter.quote(input);
    expect(quote).toMatchObject({ id: input.id, expectedOut: 2, minOut: 1.98, price: 50, account: wallet, quotedAt: now, expiresAt: now + 20_000 });
    expect(quote.tx).toMatchObject({ amountInRaw: parseUnits('100', route.quote.token.decimals).toString(), minOutRaw: '1980000000000000000', approval: null, swap: { value: '0' } });
    const multicall = decodeFunctionData({ abi: ROUTER_ABI, data: quote.tx!.swap.data as Hex });
    expect(multicall.functionName).toBe('multicall'); expect(multicall.args![0]).toBe(BigInt(now / 1000 + 120));
    const calls = multicall.args![1] as readonly Hex[];
    expect(calls).toHaveLength(2);
    expect(decodeFunctionData({ abi: ROUTER_ABI, data: calls[0] }).args![0]).toMatchObject({ fee: route.feeTiers[0], amountOutMinimum: 1980000000000000000n });
    expect(decodeFunctionData({ abi: ROUTER_ABI, data: calls[1] }).args).toEqual([1980000000000000000n, wallet]);
    expect(client.call).toHaveBeenCalledWith({ account: wallet, to: quote.tx!.swap.to, data: quote.tx!.swap.data, value: 0n });
    expect(quote.fees.find(f => f.asset === 'ETH')!.amount).toBe(0.0002);
    expect(quote.fees.find(f => f.asset === 'USD')!.amount).toBe(0.4);
  });
  it('creates an exact approval and withholds simulation until allowance is available', async () => {
    const { adapter, client, input } = fixture(), read = client.readContract.getMockImplementation()!;
    client.readContract.mockImplementation(args => args.functionName === 'allowance' ? Promise.resolve(0n) : read(args));
    const quote = await adapter.quote(input);
    expect(quote.tx!.approval).toMatchObject({ token: adapter.network.tokens.USDG.address, spender: quote.tx!.swap.to, amount: quote.tx!.amountInRaw });
    expect(quote.warnings.some(w => w.startsWith('approval_required'))).toBe(true);
    expect(client.call).not.toHaveBeenCalled(); expect(client.estimateGas).not.toHaveBeenCalled();
  });
  it.each(['buy', 'sell'] as const)('reports insufficient %s balance without simulating', async side => {
    const { adapter, client, input } = fixture();
    client.getBalance.mockResolvedValue(0n); const read = client.readContract.getMockImplementation()!;
    client.readContract.mockImplementation(args => args.functionName === 'balanceOf' ? Promise.resolve(0n) : read(args));
    const quote = await adapter.quote({ ...input, side });
    expect(quote.warnings.some(w => w.startsWith('insufficient_balance'))).toBe(true);
    expect(client.call).not.toHaveBeenCalled();
  });
  it('constructs native-input sell calldata and retains a bounded simulation failure', async () => {
    const { adapter, client, input } = fixture();
    client.call.mockRejectedValue({ shortMessage: 'fixture revert '.repeat(30) });
    const quote = await adapter.quote({ ...input, side: 'sell', amountIn: 1 });
    expect(quote.tx!.swap.value).toBe('1000000000000000000'); expect(quote.tx!.approval).toBeNull();
    const calls = decodeFunctionData({ abi: ROUTER_ABI, data: quote.tx!.swap.data as Hex }).args![1] as readonly Hex[];
    expect(calls).toHaveLength(1);
    expect(decodeFunctionData({ abi: ROUTER_ABI, data: calls[0] }).args![0]).toMatchObject({ recipient: wallet, amountIn: 10n ** 18n });
    const failure = quote.warnings.find(w => w.startsWith('simulation_failed:'))!;
    expect(failure).toBe('simulation_failed: ' + 'fixture revert '.repeat(30).slice(0, 160));
    expect(client.estimateGas).not.toHaveBeenCalled();
  });
  it('keeps disconnected quotes unsigned and omits unavailable USD gas estimates', async () => {
    const { client, input, chains } = fixture();
    const adapter = new UniswapV3Adapter(chains, 'robinhood-mainnet', () => null, () => now);
    const quote = await adapter.quote({ ...input, account: undefined });
    expect(quote.account).toBeNull(); expect(quote.warnings).toContain('Connect a wallet to check balances, allowance and simulate the transaction.');
    expect(quote.fees.map(f => f.asset)).not.toContain('USD'); expect(client.getBalance).not.toHaveBeenCalled(); expect(client.call).not.toHaveBeenCalled();
  });
  it('distinguishes route, amount, liquidity and transport refusals', async () => {
    const { adapter, client, input, chains } = fixture();
    await expect(adapter.quote({ ...input, market: 'UNKNOWN' })).rejects.toMatchObject({ code: 'no_route' });
    await expect(adapter.quote({ ...input, amountIn: -1 })).rejects.toMatchObject({ code: 'bad_amount' });
    await expect(adapter.quote({ ...input, amountIn: NaN })).rejects.toMatchObject({ code: 'bad_amount' });
    expect(client.simulateContract).not.toHaveBeenCalled();
    client.simulateContract.mockRejectedValue(new Error('contract reverted'));
    await expect(adapter.quote(input)).rejects.toMatchObject({ code: 'no_liquidity' });
    client.simulateContract.mockRejectedValue(Object.assign(new Error('fixture transport'), { name: 'HttpRequestError' }));
    await expect(adapter.quote(input)).rejects.toMatchObject({ code: 'rpc_unavailable' });
    await expect(new UniswapV3Adapter(chains, 'robinhood-testnet', () => null).quoteTrade({} as never, {} as never)).rejects.toMatchObject({ code: 'no_route' });
  });
  it('reads transactions/receipts and returns null on unavailable providers', async () => {
    const { adapter, client } = fixture();
    expect(await adapter.transaction(hash)).toEqual({ hash }); expect(await adapter.receipt(hash)).toEqual({ status: 'success' });
    expect(client.getTransaction).toHaveBeenCalledWith({ hash }); expect(client.getTransactionReceipt).toHaveBeenCalledWith({ hash });
    client.getTransaction.mockRejectedValue(new Error('not found')); client.getTransactionReceipt.mockRejectedValue(new Error('not found'));
    expect(await adapter.transaction(hash)).toBeNull(); expect(await adapter.receipt(hash)).toBeNull();
  });
  it('preserves provider pause scheduling through receipt and transaction adapters',async()=>{
    const {adapter,client}=fixture();
    const error=new RpcGuardError('provider_balance_exceeded','provider_balance_exceeded',true,now+60_000);
    client.getTransaction.mockRejectedValue(error);client.getTransactionReceipt.mockRejectedValue(error);
    await expect(adapter.transaction(hash)).rejects.toBe(error);await expect(adapter.receipt(hash)).rejects.toBe(error);
  });
  it('parses signed swap amounts, ignores malformed logs and refuses zero-base or unknown-market fills', () => {
    const { adapter } = fixture(), route = adapter.route('ETH-USD')!;
    const event = POOL_ABI.find(e => e.type === 'event' && e.name === 'Swap')!;
    const baseIs0 = BigInt(route.base.token.address) < BigInt(route.quote.token.address);
    const args = { sender: wallet, recipient: wallet, amount0: baseIs0 ? -(10n ** 18n) : parseUnits('2000', route.quote.token.decimals),
      amount1: baseIs0 ? parseUnits('2000', route.quote.token.decimals) : -(10n ** 18n), sqrtPriceX96: 2n ** 96n, liquidity: 1n, tick: 0 };
    const log = { topics: encodeEventTopics({ abi: [event], args }), data: encodeAbiParameters(event.inputs.filter(p => !('indexed' in p && p.indexed)), [args.amount0, args.amount1, args.sqrtPriceX96, args.liquidity, args.tick]) };
    const receipt = { logs: [{ topics: [], data: '0x' }, log] } as unknown as TransactionReceipt;
    expect(adapter.parseSwap(receipt, 'ETH-USD')).toEqual({ baseQty: 1, quoteQty: 2000, price: 2000 });
    expect(adapter.parseSwap(receipt, 'UNKNOWN')).toBeNull();
    expect(adapter.parseSwap({ logs: [] } as unknown as TransactionReceipt, 'ETH-USD')).toBeNull();
    log.data = encodeAbiParameters(event.inputs.filter(p => !('indexed' in p && p.indexed)), [0n, 0n, args.sqrtPriceX96, args.liquidity, 0]);
    expect(adapter.parseSwap(receipt, 'ETH-USD')).toBeNull();
  });
});
