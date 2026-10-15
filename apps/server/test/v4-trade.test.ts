import { describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, hexToBigInt, keccak256, padHex, toHex, zeroAddress, type Address, type Hex, type PublicClient } from 'viem';
import { binary } from '@eko/db';
import { loadRegistry, v4PoolId, type V4PoolKey } from '@eko/chain';
import type { SqlClient } from '@eko/db';
import type { TradeQuote } from '@eko/shared';
import { decodeV4Fill, indexedV4Pools, PERMIT2, quoteV4Trade, readV4Pool, v4CallTerms, v4DepthWei, V4_MANAGER, V4_MANAGER_ABI, V4_ROUTER, v4TradeCall,
  type V4TradeSources } from '../src/exec/v4-routes.js';
import { isV4Binding, V4ActualOrderProbe, v4TradeBackend } from '../src/exec/v4-trade.js';
import { venueTradeBackend, VenueActualOrderProbe } from '../src/exec/pons-trade.js';
import { ponsTradeCall, PonsHandoff } from '../src/exec/pons-routes.js';
import { ChainQuoteError, ERC20_ABI, ROUTER_ABI } from '../src/exec/v3-routes.js';
import type { RetainedTrade, TradeBackend } from '../src/exec/trades.js';
import type { TradeReceipt } from '../src/exec/trade-reconcile.js';
import { evaluate } from '@eko/policy';
import type { ActualOrderObservation } from '@eko/shared';
import { binding, stateFor, wallet } from '../../../packages/policy/test/actual-fixtures.js';
import { verdict as legacyVerdict } from '../../../packages/policy/test/fixtures.js';

// The per-pool lock proof has its own tests (pons-graduation.test.ts); here it is a switch.
const lockProof = vi.hoisted(() => ({ locked: false, calls: [] as unknown[][] }));
vi.mock('../src/exec/pons-graduation.js', async importOriginal => ({ ...await importOriginal<typeof import('../src/exec/pons-graduation.js')>(),
  ponsGraduationLock: vi.fn(async (...args: unknown[]) => { lockProof.calls.push(args); return { locked: lockProof.locked, tokenId: 1n, liquidity: 1n, locker: null }; }) }));

// Offline: v4 router calldata, pool state, depth, quoting, fill decoding and the venue order, with injected readers.
// Fork evidence for the same code lives in test/fork/v1-trade.fork.test.ts.
const registry = loadRegistry();
const WETH = registry.requireAddress('tokens.WETH').toLowerCase() as Address, HOOK = registry.requireAddress('pons.v4Hook').toLowerCase() as Address;
const coin = padHex('0xc0', { size: 20 });
const key: V4PoolKey = { currency0: zeroAddress, currency1: coin, fee: 0, tickSpacing: 200, hooks: HOOK };
const poolId = v4PoolId(key).toLowerCase() as Hex;
// A graduated Pons pool read on a fork of chain 4663 (Oct 6, 2026).
const sqrtP = 2353873535370495825968764447753268n, tick = 205995n, liquidity = 29277002188455996366490n;

describe('Uniswap v4 router calldata', () => {
  it('builds the UniversalRouter execute bytes and decodes exactly them back', () => {
    const buy = { side: 'buy' as const, key, amountIn: 2_000_000_000_000_000n, minOut: 5n, recipient: wallet, deadline: 1_900_000_000n };
    const data = v4TradeCall(buy);
    expect(data.slice(0, 10)).toBe('0x3593564c'); // execute(bytes,bytes[],uint256)
    expect(v4CallTerms(data)).toEqual({ ...buy, recipient: null, key: { ...key, currency1: coin.toLowerCase() } });
    const sell = { ...buy, side: 'sell' as const, amountIn: 10n ** 24n };
    expect(v4CallTerms(v4TradeCall(sell))).toEqual({ ...sell, recipient: wallet.toLowerCase(), key: { ...key, currency1: coin.toLowerCase() } });
    expect(v4CallTerms(`${data}00`)).toBeNull();
    expect(v4CallTerms(encodeFunctionData({ abi: ROUTER_ABI, functionName: 'multicall', args: [1n, []] }))).toBeNull();
    // A pool keyed on WETH (not native ETH) is not this route.
    expect(v4CallTerms(v4TradeCall({ ...buy, key: { ...key, currency0: WETH } }))).toBeNull();
  });
});

/** PoolManager storage as StateLibrary reads it: slot0, liquidity and one tick-bitmap word. */
function managerStorage(initializedTicks: bigint[] = []) {
  const stateSlot = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [poolId, 6n]));
  const words = new Map<string, bigint>();
  for (const t of initializedTicks) {
    const c = t / 200n, word = c >> 8n, slot = keccak256(encodeAbiParameters([{ type: 'int256' }, { type: 'bytes32' }], [word, toHex(hexToBigInt(stateSlot) + 5n, { size: 32 })]));
    words.set(slot, (words.get(slot) ?? 0n) | 1n << BigInt(Number(((c % 256n) + 256n) % 256n)));
  }
  const slot0 = (tick < 0n ? tick + 0x1000000n : tick) << 160n | sqrtP;
  return (slot: Hex) => toHex(slot === stateSlot ? slot0 : slot === toHex(hexToBigInt(stateSlot) + 3n, { size: 32 }) ? liquidity : words.get(slot) ?? 0n, { size: 32 });
}
function chainFor(o: { erc20Allowance?: bigint; permit2?: [bigint, number]; wired?: boolean; ticks?: bigint[]; quote?: bigint } = {}) {
  const storage = managerStorage(o.ticks);
  return {
    getBlockNumber: vi.fn(async () => 100n),
    getBlock: vi.fn(async () => ({ number: 100n, hash: `0x${'ab'.repeat(32)}`, timestamp: BigInt(Math.floor(Date.now() / 1000)), baseFeePerGas: 10n })),
    getCode: vi.fn(async () => '0x6001' as Hex),
    getBalance: vi.fn(async () => 10n ** 18n),
    readContract: vi.fn(async (a: { address: Address; functionName: string; args?: unknown[] }) => {
      if (a.functionName === 'poolManager') return o.wired === false ? padHex('0x99', { size: 20 }) : V4_MANAGER;
      if (a.functionName === 'extsload') return storage(a.args![0] as Hex);
      if (a.functionName === 'allowance') return a.address.toLowerCase() === PERMIT2 ? [...(o.permit2 ?? [0n, 0]), 0] : o.erc20Allowance ?? 0n;
      if (a.functionName === 'balanceOf') return 0n;
      throw new Error(`unexpected ${a.functionName}`);
    }),
    simulateContract: vi.fn(async () => ({ result: [o.quote ?? 1_709_234_482_602_360_547_375_797n, 136_133n] })),
  } as unknown as PublicClient;
}
const sources = (over: Partial<V4TradeSources> = {}): V4TradeSources => ({ pools: async c => c === coin ? [{ id: poolId, key }] : [],
  priceUsd: async () => 2000, networkFeeWei: async (_tx, gas) => gas * 10n, ...over });
const input = (side: 'buy' | 'sell') => ({ coin, side, amountUsd: 4, slippageBps: 100, riskMode: 'balanced' as const, account: wallet });

describe('Uniswap v4 pool state, depth and quotes', () => {
  it('reads slot0 and active liquidity from PoolManager storage, negative ticks included', async () => {
    expect(await readV4Pool(chainFor(), poolId, 100n)).toMatchObject({ sqrtPriceX96: sqrtP, tick, liquidity });
  });
  it('measures ±2% buy depth from active liquidity, and stops at an initialized tick inside the band', async () => {
    const s = await readV4Pool(chainFor(), poolId, 100n), pool = { id: poolId, key };
    const open = await v4DepthWei(chainFor(), pool, s, 100n);
    expect(Number(open)).toBeCloseTo(Number(liquidity) * 2 ** 96 / Number(sqrtP) * (Math.sqrt(1.02) - 1) * 0.999, -10);
    // ~0.01 ETH: a graduated Pons pool is far below every pool depth floor ($2,000 in Degen).
    expect(Number(open) / 1e18).toBeLessThan(0.011);
    const bounded = await v4DepthWei(chainFor({ ticks: [205800n] }), pool, s, 100n);
    expect(bounded).toBeGreaterThan(0n);
    expect(bounded).toBeLessThan(open);
    expect(await v4DepthWei(chainFor({ ticks: [205800n] }), pool, { ...s, liquidity: 0n }, 100n)).toBe(0n);
  });
  it('quotes a native buy through the router with no approval and a zero terminal fee', async () => {
    const route = await quoteV4Trade(chainFor(), input('buy'), sources());
    const amountIn = 2_000_000_000_000_000n, out = 1_709_234_482_602_360_547_375_797n, minOut = out * 9900n / 10_000n;
    expect(route).toMatchObject({ amountIn: amountIn.toString(), valueWei: amountIn.toString(), expectedOut: out.toString(), minOut: minOut.toString(),
      route: { venue: 'uniswap_v4', poolId, executable: false }, fee: { bps: 0, usd: 0, destination: null }, approvals: [], tx: { to: V4_ROUTER } });
    expect(v4CallTerms(route.tx.data)).toMatchObject({ side: 'buy', amountIn, minOut });
  });
  it('lists the exact ERC-20 → Permit2 and Permit2 → router approvals a sell still lacks, with a 30-minute expiry', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const short = await quoteV4Trade(chainFor({ quote: 941_882_577_991_498n }), input('sell'), sources());
    expect(short.approvals).toEqual([{ token: coin, spender: PERMIT2, amount: short.amountIn, kind: 'erc20' },
      { token: coin, spender: V4_ROUTER, amount: short.amountIn, kind: 'permit2', expiration: expect.any(Number) }]);
    expect(short.approvals[1]!.expiration! - nowSec).toBeGreaterThanOrEqual(1799);
    expect(short.approvals[1]!.expiration! - nowSec).toBeLessThanOrEqual(1801);
    expect(v4CallTerms(short.tx.data)).toMatchObject({ side: 'sell', recipient: wallet.toLowerCase() });
    const amount = BigInt(short.amountIn);
    expect((await quoteV4Trade(chainFor({ erc20Allowance: amount, permit2: [amount, nowSec + 1000] }), input('sell'), sources())).approvals).toEqual([]);
    // A Permit2 allowance about to expire is listed again.
    expect((await quoteV4Trade(chainFor({ erc20Allowance: amount, permit2: [amount, nowSec + 60] }), input('sell'), sources())).approvals).toMatchObject([{ kind: 'permit2' }]);
  });
  it('refuses without a supported indexed pool, or when the router is not wired to the PoolManager', async () => {
    await expect(quoteV4Trade(chainFor(), input('buy'), sources({ pools: async () => [] }))).rejects.toMatchObject({ code: 'no_route' });
    await expect(quoteV4Trade(chainFor({ wired: false }), input('buy'), sources())).rejects.toMatchObject({ code: 'no_route', message: expect.stringMatching(/wiring/) });
  });
  it('indexes only native pools with no hook or the Pons hook whose key hashes to the stored PoolId', async () => {
    const other = { ...key, hooks: padHex('0x77', { size: 20 }) }, plain = { ...key, hooks: zeroAddress, fee: 3000, tickSpacing: 60 };
    const rows = [key, other, plain].map(k => ({ id: binary(v4PoolId(k)), currency1: binary(coin), fee: k.fee, tick_spacing: k.tickSpacing, hooks: k.hooks === zeroAddress ? null : binary(k.hooks) }));
    rows.push({ ...rows[0]!, id: binary(`0x${'12'.repeat(32)}`) });
    const sql = { query: async () => ({ rows }) } as unknown as SqlClient;
    expect((await indexedV4Pools(sql)(coin, 100n)).map(p => p.id)).toEqual([v4PoolId(key).toLowerCase(), v4PoolId(plain).toLowerCase()]);
  });
});

const hash = `0x${'aa'.repeat(32)}` as Hex, blockHash = `0x${'bb'.repeat(32)}` as Hex;
const swapLog = (amount0: bigint, amount1: bigint, sender: Address = V4_ROUTER, id: Hex = poolId) => ({ address: V4_MANAGER,
  topics: encodeEventTopics({ abi: V4_MANAGER_ABI, eventName: 'Swap', args: { id, sender } }),
  data: encodeAbiParameters([{ type: 'int128' }, { type: 'int128' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }, { type: 'uint24' }], [amount0, amount1, sqrtP, liquidity, 205956, 0]) });
const transfer = (token: Address, from: Address, to: Address, value: bigint) => ({ address: token,
  topics: encodeEventTopics({ abi: ERC20_ABI, eventName: 'Transfer', args: { from, to } }), data: encodeAbiParameters([{ type: 'uint256' }], [value]) });
const receiptOf = (logs: ReturnType<typeof transfer>[]): TradeReceipt => ({ transactionHash: hash, blockHash, blockNumber: 101n, status: 'success',
  logs: logs.map((l, i) => ({ ...l, blockHash, transactionHash: hash, blockNumber: 101n, logIndex: i, transactionIndex: 0, removed: false })) as TradeReceipt['logs'] });
function retainedFor(side: 'buy' | 'sell', amountIn: bigint): RetainedTrade {
  const b = { ...binding(), coin, side, amountIn: amountIn.toString(), minOut: '1',
    tx: { chainId: 4663 as const, to: V4_ROUTER, value: side === 'buy' ? amountIn.toString() : '0', data: v4TradeCall({ side, key, amountIn, minOut: 1n, recipient: wallet, deadline: 1_900_000_000n }) } };
  return { quote: { coin, side, route: { venue: 'uniswap_v4', poolId, executable: true } } as TradeQuote, checked: { order: { execution: b } } } as RetainedTrade;
}

describe('Uniswap v4 fills from receipts (amounts measured on a fork)', () => {
  const manager = V4_MANAGER, buy = retainedFor('buy', 2_000_000_000_000_000n), sell = retainedFor('sell', 854_617_241_301_180_273_687_898n);
  it('measures a buy as the ETH sent and the coin the wallet received after the hook’s share', () => {
    const logs = [swapLog(-2_000_000_000_000_000n, 1_762_097_404_744_701_595_232_779n), transfer(coin, manager, HOOK, 52_862_922_142_341_047_856_982n),
      transfer(coin, manager, wallet, 1_709_234_482_602_360_547_375_797n)];
    expect(decodeV4Fill(buy, receiptOf(logs))).toEqual({ filledIn: '2000000000000000', filledOut: '1709234482602360547375797' });
  });
  it('measures a sell as the coin that left the wallet and the router’s WETH unwrap to it (the exact native payout)', () => {
    const logs = [swapLog(971_012_967_001_543n, -854_617_241_301_180_273_687_898n), transfer(coin, wallet, manager, 854_617_241_301_180_273_687_898n),
      transfer(WETH, zeroAddress, V4_ROUTER, 941_882_577_991_498n), transfer(WETH, V4_ROUTER, zeroAddress, 941_882_577_991_498n)];
    expect(decodeV4Fill(sell, receiptOf(logs))).toEqual({ filledIn: '854617241301180273687898', filledOut: '941882577991498' });
    // Without the unwrap the payout is not measured, so there is no fill.
    expect(decodeV4Fill(sell, receiptOf(logs.slice(0, 2)))).toBeNull();
  });
  it('refuses a fill without exactly one Swap by the router on the quoted pool', () => {
    const paid = transfer(coin, manager, wallet, 10n);
    expect(decodeV4Fill(buy, receiptOf([paid]))).toBeNull();
    expect(decodeV4Fill(buy, receiptOf([swapLog(-1n, 10n), swapLog(-1n, 10n), paid]))).toBeNull();
    expect(decodeV4Fill(buy, receiptOf([swapLog(-1n, 10n, padHex('0x44', { size: 20 })), paid]))).toBeNull();
    expect(decodeV4Fill(buy, receiptOf([swapLog(-1n, 10n, V4_ROUTER, `0x${'12'.repeat(32)}`), paid]))).toBeNull();
    expect(decodeV4Fill({ ...buy, quote: { ...buy.quote, route: { venue: 'uniswap_v3', poolId, executable: true } } }, receiptOf([swapLog(-1n, 10n), paid]))).toBeNull();
  });
});

describe('the venue order: curve, then v3 pools, then v4 pools', () => {
  const owner = { id: 'acct-1', wallet };
  const backend = (quote: TradeBackend['quote']) => ({ quote: vi.fn(quote), capture: vi.fn(), probe: { observe: vi.fn() },
    reconciliation: { supports: vi.fn(() => true), receipt: vi.fn(), transaction: vi.fn(), decodeFill: vi.fn(), postFillSell: vi.fn() } }) as unknown as TradeBackend;
  const handoff = backend(async () => { throw new PonsHandoff('graduated'); });
  it('quotes v4 only when v3 has no route, and keeps v3’s answer otherwise', async () => {
    const v4Quote = { quote: { route: { venue: 'uniswap_v4' } }, checked: null } as never;
    const v4 = backend(async () => v4Quote);
    expect(await venueTradeBackend(backend(async () => { throw new ChainQuoteError('no_route', 'No indexed v3 pool'); }), handoff, v4).quote(owner, input('buy'), 'q')).toBe(v4Quote);
    await expect(venueTradeBackend(backend(async () => { throw new ChainQuoteError('stale_data', 'ETH USD price unavailable'); }), handoff, v4).quote(owner, input('buy'), 'q'))
      .rejects.toMatchObject({ code: 'stale_data' });
    expect(v4.quote).toHaveBeenCalledTimes(1);
    const none = backend(async () => { throw new ChainQuoteError('no_route', 'No indexed v4 pool'); });
    await expect(venueTradeBackend(backend(async () => { throw new ChainQuoteError('no_route', 'No indexed v3 pool'); }), handoff, none).quote(owner, input('buy'), 'q'))
      .rejects.toMatchObject({ code: 'no_route', message: 'No indexed v3 pool' });
  });
  it('dispatches capture, probe and fills of a v4 order to the v4 backend', async () => {
    const pools = backend(async () => { throw new Error('unused'); }), v4 = backend(async () => { throw new Error('unused'); });
    const venue = venueTradeBackend(pools, handoff, v4), retained = { quote: { route: { venue: 'uniswap_v4' } } } as RetainedTrade;
    await venue.capture(retained);
    expect(v4.capture).toHaveBeenCalledWith(retained);
    const b = binding(), v4Binding = { ...b, tx: { ...b.tx, to: V4_ROUTER, data: v4TradeCall({ side: 'buy', key, amountIn: 1n, minOut: 1n, recipient: wallet, deadline: 1n }) } };
    expect(isV4Binding(v4Binding)).toBe(true);
    expect(venue.probe).toBeInstanceOf(VenueActualOrderProbe);
    await venue.probe.observe(v4Binding, stateFor(v4Binding), 1);
    await venue.probe.observe({ ...b, tx: { ...b.tx, data: ponsTradeCall({ side: 'buy', amountIn: 1n, minOut: 1n, recipient: wallet }) } }, stateFor(b), 1);
    expect(v4.probe.observe).toHaveBeenCalledTimes(1);
    expect(handoff.probe.observe).toHaveBeenCalledTimes(1);
    await venue.reconciliation!.decodeFill(retained, receiptOf([]));
    expect(v4.reconciliation!.decodeFill).toHaveBeenCalled();
  });
  it('reports an unsupported v4 binding without touching the simulation host', async () => {
    const lease = { withExclusive: vi.fn() };
    const probe = new V4ActualOrderProbe(lease, sources(), () => chainFor());
    const b = binding();
    expect(await probe.observe(b, stateFor(b), 1)).toMatchObject({ status: 'unsupported', evidenceIds: [] });
    const foreignCoin = { ...b, tx: { ...b.tx, to: V4_ROUTER, data: v4TradeCall({ side: 'buy', key, amountIn: BigInt(b.amountIn), minOut: BigInt(b.minOut), recipient: wallet, deadline: 1n }) } };
    expect(await probe.observe(foreignCoin, stateFor(foreignCoin), 1)).toMatchObject({ status: 'unsupported' });
    expect(lease.withExclusive).not.toHaveBeenCalled();
  });
});

describe('a proven-locked Pons graduation pool is judged by its exact exit cost (owner direction 2026-10-06)', () => {
  const lease = { withExclusive: vi.fn() };
  const adapter = () => ({ receipt: vi.fn(), transaction: vi.fn() }) as never;
  const clear = vi.fn(async () => ({ verdict: { ...legacyVerdict, coin, level: 'clear' as const, playbooks: [] }, guardV2Active: false, scanPending: false }));
  /** Quote and capture a $4 buy in `mode`, then run the production policy on a measured round trip of `costPct` with ~$20 of depth. */
  async function admit(mode: 'safe' | 'balanced' | 'degen', costPct: bigint, locked: boolean) {
    lockProof.locked = locked;
    const backend = v4TradeBackend({ chain: () => chainFor(), lease, sources: sources({ graduation: async () => poolId }), verdict: clear, adapter });
    const request = { ...input('buy'), riskMode: mode };
    const { quote, checked } = await backend.quote({ id: 'acct-1', wallet }, request, `quote-${mode}`);
    const retained = { accountId: 'acct-1', wallet, input: request, quote, checked, quotedAt: new Date(), expiresAt: new Date(Date.now() + 15_000) } as RetainedTrade;
    const cap = await backend.capture(retained), b = checked!.order.execution!, now = Date.now();
    const observation: ActualOrderObservation = { binding: b, state: cap.state, quotedAtMs: now, refreshedAtMs: now, expiresAtMs: now + 15_000,
      origin: 'measured', mode: 'round_trip', accountClass: 'eoa', status: 'ok', spent: b.amountIn, returned: (BigInt(b.amountIn) * (100n - costPct) / 100n).toString(),
      tokens: quote.expectedOut, heldBefore: '0', allowanceBefore: '0', notionalUsd: 4, entryNetworkFee: '0', exitNetworkFee: '0', depthUsdLower: 20, evidenceIds: [hash] };
    const result = evaluate(cap.request, cap.policy, cap.agent, { ...cap.deps, guardPolicyV2: true, now: () => now,
      actualStateFor: () => cap.state, actualOrderFor: () => ({ status: 'ready', observation }) });
    return { codes: result.reasons.map(r => r.split(':')[0]), deps: cap.deps, binding: b, fingerprint: b.stateFingerprint };
  }
  it('a 6% round trip on the locked pool is refused in Careful and admitted in Balanced and Degen, with no depth floor', async () => {
    expect((await admit('safe', 6n, true)).codes).toEqual(['round_trip_cost']);
    expect((await admit('balanced', 6n, true)).codes).toEqual([]);
    expect((await admit('degen', 6n, true)).codes).toEqual([]);
    expect((await admit('balanced', 11n, true)).codes).toEqual(['round_trip_cost']);
    // The proof ran for the coin's pool against the indexer's graduation record.
    expect(lockProof.calls.at(-1)).toEqual([expect.anything(), coin.toLowerCase(), { id: poolId, key }, poolId, 100n]);
  });
  it('the same pool without a proven lock keeps its depth floor in every mode', async () => {
    for (const mode of ['safe', 'balanced', 'degen'] as const) expect((await admit(mode, 1n, false)).codes).toEqual(['thin_liquidity']);
  });
  it('only the order’s own bytes qualify, and the lock status is part of the state the order is bound to', async () => {
    const { deps, binding: b, fingerprint } = await admit('degen', 6n, true);
    expect(deps.lockedLiquidityRoute!(b)).toBe(true);
    expect(deps.lockedLiquidityRoute!({ ...b, tx: { ...b.tx, data: v4TradeCall({ side: 'buy', key, amountIn: 1n, minOut: 1n, recipient: wallet, deadline: 1n }) } })).toBe(false);
    expect((await admit('degen', 6n, false)).fingerprint).not.toBe(fingerprint);
  });
});
