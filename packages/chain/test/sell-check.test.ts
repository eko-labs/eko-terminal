import { describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, encodeAbiParameters, getAddress, pad, parseAbi, toHex, zeroAddress, type Address, type Hex } from 'viem';
import { RpcGuardError } from '../src/rpc/metered.js';
import { probeAbi } from '../src/simulation/reference.js';
import { EKO_PAIR_PROBE_RUNTIME } from '../src/simulation/pair-probe-runtime.js';
import { EKO_PROBE_RUNTIME } from '../src/simulation/probe-runtime.js';
import { EKO_V4_PROBE_RUNTIME } from '../src/simulation/v4-probe-runtime.js';
import { BALANCE_SLOTS, balanceKey, balanceSlot, ponsCurveSellCheckAbi, runSellProbe, sellRouteId, type SellRoute } from '../src/simulation/sell-check.js';
import { v4PoolId, v4ProbeAbi } from '../src/simulation/v4.js';

// Synthetic transport only: every output below is an ABI-encoded fixture, never a live chain reading.
const address = (n: number): Address => getAddress(`0x${n.toString(16).padStart(40, '0')}`);
const output = (tokens: bigint, returned: bigint, spent: bigint, buyOk = true, sellOk = true, revert: Hex = '0x', quoted = returned) =>
  encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bool' }, { type: 'bool' }, { type: 'bytes' }],
    [tokens, quoted, returned, spent, buyOk, sellOk, revert]);
const v3: SellRoute = { venue: 'uniswap_v3', coin: address(10), pool: address(11), router: address(12), quoter: address(13), weth: address(14), fee: 3000 };
const pons: SellRoute = { venue: 'pons_curve', coin: address(20), curve: address(21) };
const key = { currency0: zeroAddress, currency1: address(30), fee: 10000, tickSpacing: 200, hooks: address(31) };
const v4: SellRoute = { venue: 'uniswap_v4', coin: address(30), poolId: v4PoolId(key), manager: address(32), quoter: address(33), key, hookData: '0x' };
const counter = (n: number) => { let i = n; return (size: number) => new Uint8Array(size).fill(++i); };
function rpc(...answers: unknown[]) {
  const request = vi.fn(async (_input: { method: string; params: readonly unknown[] }) => {
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return next;
  });
  return { request };
}

describe('live sell check (eth_call with the probe injected by state override)', () => {
  it('pins the block and overrides only the fresh probe code and native funding', async () => {
    const t = rpc(output(5000n, 990n, 1000n));
    const result = await runSellProbe(t, v3, 1000n, 777n, { random: counter(0), nowSec: () => 2000 });
    expect(result).toMatchObject({ status: 'sellable', reason: null, exitCostPct: 1, spentWei: '1000', returnedWei: '990', tokens: '5000', requests: 1, block: '777', routeId: sellRouteId(v3) });
    expect(t.request).toHaveBeenCalledTimes(1);
    const { method, params } = t.request.mock.calls[0]![0];
    expect(method).toBe('eth_call');
    expect(params[1]).toBe(toHex(777n));
    const tx = params[0] as { from: Address; to: Address; data: Hex };
    expect(tx.to).not.toBe(tx.from);
    expect(params[2]).toEqual({ [tx.to]: { code: EKO_PROBE_RUNTIME, balance: toHex(1000n + 10n ** 18n) } });
    const call = decodeFunctionData({ abi: probeAbi, data: tx.data });
    expect(call.args[0]).toBe(v3.coin);
    expect(call.args[1]).toBe(v3.router);
  });
  it('calls a failed or near-zero sell a failed sell, and a failed buy only a failed buy', async () => {
    expect(await runSellProbe(rpc(output(5000n, 0n, 1000n, true, false, '0x08c379a0')), v3, 1000n, 1n)).toMatchObject({ status: 'sell_failed', reason: 'sell_reverted', exitCostPct: 100, revert: '0x08c379a0' });
    expect(await runSellProbe(rpc(output(5000n, 40n, 1000n)), v3, 1000n, 1n)).toMatchObject({ status: 'sell_failed', reason: 'returns_under_5pct', exitCostPct: 96 });
    // Exactly 5% back is still a sell, with its measured cost.
    expect(await runSellProbe(rpc(output(5000n, 50n, 1000n)), v3, 1000n, 1n)).toMatchObject({ status: 'sellable', exitCostPct: 95 });
    expect(await runSellProbe(rpc(output(0n, 0n, 0n, false, false, '0x12345678')), v3, 1000n, 1n)).toMatchObject({ status: 'buy_failed', exitCostPct: null, spentWei: null });
  });
  it('never turns provider errors, malformed bytes or impossible debits into a reading', async () => {
    expect(await runSellProbe(rpc(new Error('upstream said something with a key in it')), v3, 1000n, 1n)).toMatchObject({ status: 'unavailable', reason: 'provider_failure', exitCostPct: null });
    expect(await runSellProbe(rpc('0x1234'), v3, 1000n, 1n)).toMatchObject({ status: 'unavailable', reason: 'invalid_output' });
    expect(await runSellProbe(rpc(null), v3, 1000n, 1n)).toMatchObject({ status: 'unavailable', reason: 'invalid_output' });
    expect(await runSellProbe(rpc(output(5000n, 0n, 0n, true, false)), v3, 1000n, 1n)).toMatchObject({ status: 'unavailable', reason: 'invalid_debit' });
    expect(await runSellProbe(rpc(output(5000n, 0n, 2000n, true, false)), v3, 1000n, 1n)).toMatchObject({ status: 'unavailable', reason: 'invalid_debit' });
    expect(await runSellProbe(rpc(output(0n, 0n, 1000n, true, false)), v3, 1000n, 1n)).toMatchObject({ status: 'unavailable', reason: 'zero_tokens' });
    await expect(runSellProbe(rpc(new RpcGuardError('rpc_budget_exhausted')), v3, 1000n, 1n)).rejects.toThrow('rpc_budget_exhausted');
    await expect(runSellProbe(rpc(), v3, 0n, 1n)).rejects.toThrow('Invalid sell-check input');
  });
  it('reports a profitable round trip as no cost, never a negative one', async () => {
    expect(await runSellProbe(rpc(output(5000n, 1200n, 1000n)), v3, 1000n, 1n)).toMatchObject({ status: 'sellable', exitCostPct: 0 });
  });
  it('drives a Pons curve with msg.value as the quote and patches the acquired amount after the selector', async () => {
    const t = rpc(output(7000n, 900n, 1000n));
    expect(await runSellProbe(t, pons, 1000n, 5n)).toMatchObject({ status: 'sellable', exitCostPct: 10, venue: 'pons_curve' });
    const call = decodeFunctionData({ abi: probeAbi, data: (t.request.mock.calls[0]![0].params[0] as { data: Hex }).data });
    if (call.functionName !== 'roundTrip') throw new Error('fixture');
    const [, spender, buy, quote, sell] = call.args;
    expect(spender).toBe(pons.curve);
    expect(buy.value).toBe(1000n);
    expect(decodeFunctionData({ abi: ponsCurveSellCheckAbi, data: buy.data })).toMatchObject({ functionName: 'buy', args: [1000n, 0n, expect.any(String)] });
    expect(quote.target).toBe(zeroAddress);
    expect(sell).toMatchObject({ target: pons.curve, amountOffset: 4n, patch: true });
    expect(decodeFunctionData({ abi: ponsCurveSellCheckAbi, data: sell.data }).functionName).toBe('sell');
  });
  it('does not call a sell that graduation closed a failed sell, and re-reads capacity at the same block', async () => {
    const capacity = (n: bigint) => encodeAbiParameters([{ type: 'uint256' }], [n]);
    const graduated = rpc(output(7000n, 0n, 1000n, true, false), capacity(7000n));
    expect(await runSellProbe(graduated, pons, 1000n, 9n)).toMatchObject({ status: 'unavailable', reason: 'graduates_on_buy', exitCostPct: null, requests: 2 });
    expect(graduated.request.mock.calls[1]![0].params[1]).toBe(toHex(9n));
    expect(await runSellProbe(rpc(output(7000n, 0n, 1000n, true, false), capacity(10n ** 20n)), pons, 1000n, 9n)).toMatchObject({ status: 'sell_failed', reason: 'sell_reverted' });
    expect(await runSellProbe(rpc(output(7000n, 0n, 1000n, true, false), new Error('down')), pons, 1000n, 9n)).toMatchObject({ status: 'unavailable', reason: 'graduation_state_unknown' });
  });
  it('runs the v4 probe for native-ETH pools and refuses mismatched pool keys', async () => {
    const t = rpc(output(4000n, 950n, 1000n));
    expect(await runSellProbe(t, v4, 1000n, 3n)).toMatchObject({ status: 'sellable', exitCostPct: 5, venue: 'uniswap_v4' });
    const params = t.request.mock.calls[0]![0].params;
    const tx = params[0] as { to: Address; data: Hex };
    expect(Object.values(params[2] as Record<string, { code: Hex }>)[0]!.code).toBe(EKO_V4_PROBE_RUNTIME);
    expect(decodeFunctionData({ abi: v4ProbeAbi, data: tx.data }).args).toEqual([v4.manager, v4.quoter, key, '0x', 1000n]);
    await expect(runSellProbe(rpc(), { ...v4, poolId: `0x${'1'.repeat(64)}` }, 1000n, 3n)).rejects.toThrow('Unsupported v4');
  });
  it('drives a token-paired Pons curve with the pair probe, funding the probe through the pair token\'s balance slot', async () => {
    const pairToken = address(40), paired: SellRoute = { ...pons, pair: { token: pairToken, balance: { layout: 'solidity', slot: 1 } } };
    const t = rpc(output(7000n, 98_010_000n, 100_000_000n));
    expect(await runSellProbe(t, paired, 100_000_000n, 5n)).toMatchObject({ status: 'sellable', exitCostPct: 1.99, spentWei: '100000000', returnedWei: '98010000', routeId: sellRouteId(pons) });
    const [tx, , overrides] = t.request.mock.calls[0]![0].params as [{ to: Address; data: Hex }, Hex, Record<string, unknown>];
    expect(overrides).toEqual({ [tx.to]: { code: EKO_PAIR_PROBE_RUNTIME, balance: toHex(100_000_000n + 10n ** 18n) },
      [pairToken]: { stateDiff: { [balanceKey({ layout: 'solidity', slot: 1 }, tx.to)]: pad(toHex(200_000_000n)) } } });
    const abi = parseAbi(['struct Trip { address pair; address token; address curve; uint256 amountIn; bytes buyData; bytes sellData; }', 'function roundTrip(Trip trip)']);
    const [trip] = decodeFunctionData({ abi, data: tx.data }).args;
    expect(trip).toMatchObject({ pair: pairToken, token: pons.coin, curve: pons.curve, amountIn: 100_000_000n });
    expect(decodeFunctionData({ abi: ponsCurveSellCheckAbi, data: trip.buyData })).toMatchObject({ functionName: 'buy', args: [100_000_000n, 0n, getAddress(tx.to)] });
    expect(decodeFunctionData({ abi: ponsCurveSellCheckAbi, data: trip.sellData }).functionName).toBe('sell');
    // Without a known balance slot nothing is sent.
    const none = rpc();
    expect(await runSellProbe(none, { ...pons, pair: { token: pairToken } }, 1000n, 5n)).toMatchObject({ status: 'unavailable', reason: 'pair_balance_unknown', requests: 0 });
    expect(none.request).not.toHaveBeenCalled();
  });
  it('finds an ERC-20 balance layout by overriding candidate storage keys at the block', async () => {
    const token = address(41), block = 9n;
    // The synthetic token keeps balances in a Solidity mapping at slot 3: balanceOf returns an override only at that key.
    const request = vi.fn(async ({ params }: { method: string; params: readonly unknown[] }) => {
      const [tx, at, overrides] = params as [{ to: Address; data: Hex }, Hex, Record<string, { stateDiff: Record<Hex, Hex> }>];
      expect(at).toBe(toHex(block)); expect(tx.to).toBe(token);
      const holder = decodeFunctionData({ abi: parseAbi(['function balanceOf(address) view returns (uint256)']), data: tx.data }).args[0];
      const value = overrides[token]!.stateDiff[balanceKey({ layout: 'solidity', slot: 3 }, holder)];
      return value ?? pad(toHex(0n));
    });
    const found = await balanceSlot({ request }, token, block);
    expect(found).toEqual({ balance: { layout: 'solidity', slot: 3 }, requests: 5 });
    // A token keeping balances in the low 64 bits of the word (as USDG does) is found too.
    const packed = vi.fn(async (input: { method: string; params: readonly unknown[] }) => pad(toHex(BigInt(await request(input)) & (2n ** 64n - 1n))));
    expect(await balanceSlot({ request: packed }, token, block)).toEqual({ balance: { layout: 'solidity', slot: 3 }, requests: 5 });
    // A token whose balanceOf never reflects an override has no layout; every candidate is tried once.
    const computed = vi.fn(async () => pad(toHex(1n)));
    expect(await balanceSlot({ request: computed }, token, block)).toEqual({ balance: null, requests: 1 + 2 * BALANCE_SLOTS });
    // A budget stop propagates, and a failed read is unknown, never "no layout".
    await expect(balanceSlot({ request: async () => { throw new RpcGuardError('rpc_budget_exhausted'); } }, token, block)).rejects.toThrow('rpc_budget_exhausted');
    expect(await balanceSlot({ request: async () => { throw new Error('header not found'); } }, token, block)).toEqual({ balance: null, requests: 1, failed: true });
    expect(await balanceSlot({ request: async () => '0x' }, token, block)).toEqual({ balance: null, requests: 1, failed: true });
  });
});
