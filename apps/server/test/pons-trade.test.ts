import { describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, padHex, toFunctionSelector, zeroAddress, type Address, type Hex, type PublicClient } from 'viem';
import { loadRegistry, ponsExecutableSelectors } from '@eko/chain';
import { actualStateHash, evaluate } from '@eko/policy';
import type { ActualOrderObservation, ActualOrderState, TradeQuote } from '@eko/shared';
import { decodePonsFill, ponsBuyOut, ponsCallTerms, ponsDepthWei, PonsHandoff, ponsSellOut, ponsTradeCall, PONS_CURVE_ABI, quotePonsTrade,
  type PonsCurveState, type PonsTradeSources } from '../src/exec/pons-routes.js';
import { PonsActualOrderProbe, ponsTradeBackend, venueTradeBackend, VenueActualOrderProbe } from '../src/exec/pons-trade.js';
import { ChainQuoteError, ERC20_ABI, ROUTER_ABI } from '../src/exec/v3-routes.js';
import { preparationError, TradeError, type RetainedTrade, type TradeBackend } from '../src/exec/trades.js';
import type { TradeReceipt } from '../src/exec/trade-reconcile.js';
import { binding, stateFor, wallet } from '../../../packages/policy/test/actual-fixtures.js';
import { verdict as legacyVerdict } from '../../../packages/policy/test/fixtures.js';

// Offline: curve math, calldata, quoting, fill decoding and venue routing with injected readers. Fork evidence for the
// same code lives in test/fork/v1-trade.fork.test.ts.
const registry = loadRegistry();
const FACTORY = registry.requireAddress('pons.factory');
const coin = padHex('0xc0', { size: 20 }), curve = padHex('0xc1', { size: 20 });
const lower = (a: string) => a.toLowerCase() as Address;

// A deployed native curve read on a fork of chain 4663 (Oct 6, 2026): a 0.002 ETH buy received exactly this many tokens,
// and the following sell of 516565384823786418472768 tokens paid exactly 941413851087925 wei (fee 1%, creator tax 2%).
const measured: PonsCurveState = { coin, curve, block: 100n, graduated: false, readyToGraduate: false,
  quoteReserve: 1775172974973060957n, tokenReserve: 946386647208559954415110393n, sellable: 660672361494274240129396108n,
  realQuote: 95172974973060957n, feeBps: 100n, creatorTaxBps: 200n, snipeTaxBps: 0n, decimals: 18 };

describe('Pons curve math and calldata', () => {
  it('uses the lead-verified deployed buy and sell selectors', () => {
    for (const name of ['buy', 'sell'] as const) {
      const selector = toFunctionSelector(`${name}(uint256,uint256,address)`);
      expect(ponsTradeCall({ side: name, amountIn: 1n, minOut: 1n, recipient: wallet }).slice(0, 10)).toBe(selector);
      expect(ponsExecutableSelectors.find(f => f.signature === `${name}(uint256,uint256,address)`)!.selector).toBe(selector);
    }
  });
  it('reproduces a measured deployed buy and the following sell to the wei', () => {
    const bought = ponsBuyOut(measured, 2_000_000_000_000_000n);
    expect(bought).toMatchObject({ fee: 20_000_000_000_000n, tax: 40_000_000_000_000n, tokens: 1033130769647572836945537n, completes: false });
    const sold = ponsSellOut(bought.after, 516565384823786418472768n);
    expect(sold).toMatchObject({ out: 941413851087925n, fee: 9705297433896n, tax: 19410594867792n, capacity: true });
  });
  it('flags a buy that would take the last sellable tokens, and a sell the real quote cannot pay', () => {
    expect(ponsBuyOut(measured, 10n ** 19n).completes).toBe(true);
    expect(ponsSellOut({ ...measured, realQuote: 10n }, 10n ** 24n).capacity).toBe(false);
  });
  it('measures ±2% depth by exact inversion of the marginal-price move, capped by the sellable tokens', () => {
    const x = ponsDepthWei(measured), q = measured.quoteReserve;
    expect((q + x) ** 2n * 100n <= q * q * 102n).toBe(true);
    expect((q + x + 1n) ** 2n * 100n > q * q * 102n).toBe(true);
    expect(ponsDepthWei({ ...measured, sellable: 10n ** 20n })).toBe(10n ** 20n * q / (measured.tokenReserve - 10n ** 20n));
  });
  it('round-trips exact buy/sell bytes and rejects anything else', () => {
    const terms = { side: 'sell' as const, amountIn: 7n, minOut: 5n, recipient: lower(wallet) };
    const data = ponsTradeCall(terms);
    expect(data.slice(0, 10)).toBe('0xd04c6983');
    expect(ponsCallTerms(data)).toEqual(terms);
    expect(ponsCallTerms(`${data}00`)).toBeNull();
    expect(ponsCallTerms(encodeFunctionData({ abi: ROUTER_ABI, functionName: 'multicall', args: [1n, []] }))).toBeNull();
  });
});

/** A curve and wallet at one block, served the way the metered client answers readContract/getCode/getBlock. */
function chainFor(state: { curve: Partial<PonsCurveState> & { token?: Address; factory?: Address; pair?: Address }; allowance?: bigint; held?: bigint; native?: bigint }) {
  const s = { ...measured, token: coin as Address, factory: FACTORY as Address, pair: zeroAddress as Address, ...state.curve };
  const reads: Record<string, unknown> = { token: s.token, factory: s.factory, pairToken: s.pair, graduated: s.graduated, readyToGraduate: s.readyToGraduate,
    getReserves: [s.quoteReserve, s.tokenReserve], sellableTokens: s.sellable, realQuoteReserve: s.realQuote, feeBps: s.feeBps,
    creatorTaxBps: s.creatorTaxBps, currentSnipeTaxBps: s.snipeTaxBps };
  return {
    getBlockNumber: vi.fn(async () => 100n),
    getBlock: vi.fn(async () => ({ number: 100n, hash: `0x${'ab'.repeat(32)}`, timestamp: BigInt(Math.floor(Date.now() / 1000)), baseFeePerGas: 10n })),
    getCode: vi.fn(async ({ address }: { address: Address }) => (address === coin ? '0x6001' : '0x6002') as Hex),
    getBalance: vi.fn(async () => state.native ?? 10n ** 18n),
    readContract: vi.fn(async (a: { address: Address; functionName: string }) => {
      if (a.functionName === 'decimals') return 18;
      if (a.functionName === 'allowance') return state.allowance ?? 0n;
      if (a.functionName === 'balanceOf') return state.held ?? 0n;
      if (a.address !== curve || !(a.functionName in reads)) throw new Error(`unexpected ${a.functionName}`);
      return reads[a.functionName];
    }),
  } as unknown as PublicClient;
}
const sources = (over: Partial<PonsTradeSources> = {}): PonsTradeSources => ({
  curve: async c => c === coin ? { curve, graduatedBlock: null, graduatedPool: null } : null,
  priceUsd: async () => 2000, networkFeeWei: async (_tx, gas) => gas * 10n, ...over,
});
const input = (side: 'buy' | 'sell', account: Address | undefined = wallet) => ({ coin, side, amountUsd: 4, slippageBps: 100, riskMode: 'degen' as const, ...(account ? { account } : {}) });

describe('Pons curve quotes', () => {
  it('quotes a native buy at the block ETH price: exact bytes to the wallet, no approval, zero terminal fee', async () => {
    const route = await quotePonsTrade(chainFor({ curve: {} }), input('buy'), sources());
    const amountIn = 2_000_000_000_000_000n, out = ponsBuyOut(measured, amountIn).tokens, minOut = out * 9900n / 10_000n;
    expect(route).toMatchObject({ amountIn: amountIn.toString(), valueWei: amountIn.toString(), expectedOut: out.toString(), minOut: minOut.toString(),
      route: { venue: 'pons_curve', poolId: curve, executable: false }, fee: { bps: 0, usd: 0, destination: null }, approvals: [], asOfBlock: 100,
      tx: { chainId: 4663, to: curve, value: amountIn.toString(), data: ponsTradeCall({ side: 'buy', amountIn, minOut, recipient: wallet }) },
      costs: { buyTaxPct: 2, sellTaxPct: 2 } });
    expect(route.costs.exitCostPct).toBeGreaterThan(5.9);
    expect(route.networkFeeUsd).toBeCloseTo(150_000 * 10 / 1e18 * 2000, 12);
  });
  it('sizes a sell at the marginal curve price and lists the exact approval while the allowance is short', async () => {
    const short = await quotePonsTrade(chainFor({ curve: {}, allowance: 0n }), input('sell'), sources());
    const tokens = 2_000_000_000_000_000n * measured.tokenReserve / measured.quoteReserve;
    expect(short).toMatchObject({ amountIn: tokens.toString(), valueWei: '0', expectedOut: ponsSellOut(measured, tokens).out.toString(),
      approvals: [{ token: coin, spender: curve, amount: tokens.toString(), kind: 'erc20' }] });
    expect(ponsCallTerms(short.tx.data)).toEqual({ side: 'sell', amountIn: tokens, minOut: BigInt(short.minOut), recipient: lower(wallet) });
    expect((await quotePonsTrade(chainFor({ curve: {}, allowance: tokens }), input('sell'), sources())).approvals).toEqual([]);
  });
  it('hands a coin with no curve, or a graduated curve, to the pool routes and never quotes the curve', async () => {
    await expect(quotePonsTrade(chainFor({ curve: {} }), { ...input('buy'), coin: padHex('0xee', { size: 20 }) }, sources())).rejects.toMatchObject({ reason: 'not_pons' });
    await expect(quotePonsTrade(chainFor({ curve: { graduated: true } }), input('buy'), sources())).rejects.toBeInstanceOf(PonsHandoff);
    // The indexer saw the graduation first: no curve read at all.
    const client = chainFor({ curve: {} });
    await expect(quotePonsTrade(client, input('sell'), sources({ curve: async () => ({ curve, graduatedBlock: 99n, graduatedPool: `0x${'77'.repeat(32)}` }) })))
      .rejects.toMatchObject({ reason: 'graduated' });
    expect(client.readContract).not.toHaveBeenCalled();
  });
  it('refuses a graduating curve, the anti-snipe window, a foreign or ERC-20 curve, and a buy that would complete the curve', async () => {
    const refusal = (curveState: Parameters<typeof chainFor>[0]['curve'], side: 'buy' | 'sell' = 'buy', usd = 4) =>
      quotePonsTrade(chainFor({ curve: curveState }), { ...input(side), amountUsd: usd }, sources()).then(() => null, (e: ChainQuoteError | TradeError) => [e.code, e.message, e instanceof PonsHandoff]);
    expect(await refusal({ readyToGraduate: true })).toEqual(['no_route', expect.stringMatching(/graduating/), false]);
    expect(await refusal({ snipeTaxBps: 9900n })).toEqual(['anti_snipe_active', expect.stringMatching(/anti-snipe/), false]);
    expect(await refusal({ factory: padHex('0x99', { size: 20 }) })).toEqual(['no_route', expect.stringMatching(/does not belong/), false]);
    expect(await refusal({ token: padHex('0x98', { size: 20 }) })).toEqual(['no_route', expect.stringMatching(/does not belong/), false]);
    expect(await refusal({ pair: padHex('0x97', { size: 20 }) })).toEqual(['no_route', expect.stringMatching(/native-ETH/), false]);
    expect(await refusal({}, 'buy', 20_000)).toEqual(['no_route', expect.stringMatching(/complete the curve/), false]);
    expect(await refusal({ realQuote: 1n }, 'sell')).toEqual(['no_route', expect.stringMatching(/cannot pay/), false]);
  });
});

const hash = `0x${'aa'.repeat(32)}` as Hex, blockHash = `0x${'bb'.repeat(32)}` as Hex;
const event = (address: Address, name: 'CurveBuy' | 'CurveSell' | 'Transfer', args: Record<string, unknown>) => {
  if (name === 'Transfer') return { address, topics: encodeEventTopics({ abi: ERC20_ABI, eventName: 'Transfer', args: { from: args.from as Address, to: args.to as Address } }),
    data: encodeAbiParameters([{ type: 'uint256' }], [args.value as bigint]) };
  const parties = name === 'CurveBuy' ? { buyer: args.party as Address, recipient: args.recipient as Address } : { seller: args.party as Address, recipient: args.recipient as Address };
  return { address, topics: encodeEventTopics({ abi: PONS_CURVE_ABI, eventName: name, args: parties }),
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], args.amounts as [bigint, bigint, bigint, bigint]) };
};
const receiptOf = (logs: ReturnType<typeof event>[]): TradeReceipt => ({ transactionHash: hash, blockHash, blockNumber: 101n, status: 'success',
  logs: logs.map((l, i) => ({ ...l, blockHash, transactionHash: hash, blockNumber: 101n, logIndex: i, transactionIndex: 0, removed: false })) as TradeReceipt['logs'] });
function retainedFor(side: 'buy' | 'sell', amountIn: bigint, minOut: bigint): RetainedTrade {
  const b = { ...binding(), coin, side, amountIn: amountIn.toString(), minOut: minOut.toString(),
    tx: { chainId: 4663 as const, to: curve, value: side === 'buy' ? amountIn.toString() : '0', data: ponsTradeCall({ side, amountIn, minOut, recipient: wallet }) } };
  return { quote: { coin, side, route: { venue: 'pons_curve', poolId: curve, executable: true } } as TradeQuote, checked: { order: { execution: b } } } as RetainedTrade;
}

describe('Pons fills from receipts', () => {
  const buy = retainedFor('buy', 2_000_000_000_000_000n, 1n), sell = retainedFor('sell', 5n * 10n ** 23n, 1n);
  it('measures a buy from the curve event and the wallet’s coin transfers', () => {
    const logs = [event(coin, 'Transfer', { from: curve, to: wallet, value: 1000n }), event(curve, 'CurveBuy', { party: wallet, recipient: wallet, amounts: [2_000_000_000_000_000n, 1000n, 1n, 2n] })];
    expect(decodePonsFill(buy, receiptOf(logs))).toEqual({ filledIn: '2000000000000000', filledOut: '1000' });
    // A transfer tax is measured, not assumed: the wallet received less than the curve paid out.
    const taxed = [event(coin, 'Transfer', { from: curve, to: wallet, value: 950n }), event(coin, 'Transfer', { from: curve, to: padHex('0x55', { size: 20 }), value: 50n }), logs[1]!];
    expect(decodePonsFill(buy, receiptOf(taxed))).toEqual({ filledIn: '2000000000000000', filledOut: '950' });
  });
  it('measures a sell as the coin that left the wallet and the curve’s native payout', () => {
    const logs = [event(coin, 'Transfer', { from: wallet, to: curve, value: 5n * 10n ** 23n }), event(curve, 'CurveSell', { party: wallet, recipient: wallet, amounts: [5n * 10n ** 23n, 777n, 7n, 14n] })];
    expect(decodePonsFill(sell, receiptOf(logs))).toEqual({ filledIn: (5n * 10n ** 23n).toString(), filledOut: '777' });
  });
  it('refuses a fill without exactly one curve event by and to the wallet, or from another venue', () => {
    const buyEvent = event(curve, 'CurveBuy', { party: wallet, recipient: wallet, amounts: [2_000_000_000_000_000n, 1000n, 1n, 2n] });
    const toWallet = event(coin, 'Transfer', { from: curve, to: wallet, value: 1000n });
    expect(decodePonsFill(buy, receiptOf([toWallet]))).toBeNull();
    expect(decodePonsFill(buy, receiptOf([toWallet, buyEvent, buyEvent]))).toBeNull();
    expect(decodePonsFill(buy, receiptOf([toWallet, event(curve, 'CurveBuy', { party: padHex('0x44', { size: 20 }), recipient: wallet, amounts: [1n, 1000n, 0n, 0n] })]))).toBeNull();
    expect(decodePonsFill(buy, receiptOf([toWallet, event(padHex('0x45', { size: 20 }), 'CurveBuy', { party: wallet, recipient: wallet, amounts: [1n, 1000n, 0n, 0n] })]))).toBeNull();
    expect(decodePonsFill(sell, receiptOf([toWallet, buyEvent]))).toBeNull();
    expect(decodePonsFill({ ...buy, quote: { ...buy.quote, route: { venue: 'uniswap_v3', poolId: curve, executable: true } } }, receiptOf([toWallet, buyEvent]))).toBeNull();
  });
});

describe('Pons-curve buy admission under the presets (owner decision 2026-10-06)', () => {
  const lease = { withExclusive: vi.fn() };
  const adapter = () => ({ receipt: vi.fn(), transaction: vi.fn() }) as never;
  const clear = vi.fn(async () => ({ verdict: { ...legacyVerdict, coin, level: 'clear' as const, playbooks: [] }, guardV2Active: false, scanPending: false }));
  /** Quote and capture a $4 curve buy in `mode`, then run the production policy on a measured round trip of `costPct`. */
  async function admit(mode: 'safe' | 'balanced' | 'degen', costPct: bigint, curveState: Parameters<typeof chainFor>[0]['curve'] = {}) {
    const backend = ponsTradeBackend({ chain: () => chainFor({ curve: curveState }), lease, sources: sources(), verdict: clear, adapter });
    const request = { ...input('buy'), riskMode: mode };
    const { quote, checked } = await backend.quote({ id: 'acct-1', wallet }, request, `quote-${mode}`);
    const retained = { accountId: 'acct-1', wallet, input: request, quote, checked, quotedAt: new Date(), expiresAt: new Date(Date.now() + 15_000) } as RetainedTrade;
    const cap = await backend.capture(retained), b = checked!.order.execution!, now = Date.now();
    // A fresh curve: ~$70 of ±2% depth, far below every pool floor ($2,000 in Degen).
    const observation: ActualOrderObservation = { binding: b, state: cap.state, quotedAtMs: now, refreshedAtMs: now, expiresAtMs: now + 15_000,
      origin: 'measured', mode: 'round_trip', accountClass: 'eoa', status: 'ok', spent: b.amountIn, returned: (BigInt(b.amountIn) * (100n - costPct) / 100n).toString(),
      tokens: quote.expectedOut, heldBefore: '0', allowanceBefore: '0', notionalUsd: 4, entryNetworkFee: '0', exitNetworkFee: '0', depthUsdLower: 70, evidenceIds: [hash] };
    const result = evaluate(cap.request, cap.policy, cap.agent, { ...cap.deps, guardPolicyV2: true, now: () => now,
      actualStateFor: () => cap.state, actualOrderFor: () => ({ status: 'ready', observation }) });
    return { codes: result.reasons.map(r => r.split(':')[0]), quote, deps: cap.deps, binding: b };
  }
  it('a typical fresh-curve buy (7% round trip) is refused in Careful and admitted in Balanced and Degen, with no depth floor', async () => {
    expect((await admit('safe', 7n)).codes).toEqual(['round_trip_cost']);
    expect((await admit('balanced', 7n)).codes).toEqual([]);
    expect((await admit('degen', 7n)).codes).toEqual([]);
  });
  it('each mode still refuses a round trip above its own ceiling', async () => {
    expect((await admit('safe', 6n)).codes).toEqual(['round_trip_cost']);
    expect((await admit('safe', 4n)).codes).toEqual([]);
    expect((await admit('balanced', 11n)).codes).toEqual(['round_trip_cost']);
    expect((await admit('degen', 26n)).codes).toEqual(['round_trip_cost']);
  });
  it('the quote shows the exact curve exit cost before signing', async () => {
    const { quote } = await admit('balanced', 7n);
    const b = ponsBuyOut(measured, 2_000_000_000_000_000n), back = ponsSellOut(b.after, b.tokens);
    expect(quote.exitCostPct).toBeCloseTo(Number(2_000_000_000_000_000n - back.out) / 2e15 * 100, 3);
    expect(quote.exitCostPct).toBeGreaterThan(5.9);
  });
  it('only the curve’s own buy bytes on an open curve are judged without depth; pools and closed curves keep every floor', async () => {
    const { deps, binding: b } = await admit('degen', 7n);
    expect(deps.lockedLiquidityRoute!(b)).toBe(true);
    const pool = { ...b, tx: { ...b.tx, to: padHex('0x51', { size: 20 }) } };
    expect(deps.lockedLiquidityRoute!(pool)).toBe(false);
    expect(deps.lockedLiquidityRoute!({ ...b, tx: { ...b.tx, data: encodeFunctionData({ abi: ROUTER_ABI, functionName: 'multicall', args: [1n, []] }) } })).toBe(false);
    // The curve closed between quote and order: the state check refuses (quote_changed) and depth would apply again.
    let open = true;
    const backend = ponsTradeBackend({ chain: () => chainFor({ curve: open ? {} : { readyToGraduate: true } }), lease, sources: sources(), verdict: clear, adapter });
    const { quote, checked } = await backend.quote({ id: 'acct-1', wallet }, { ...input('buy'), riskMode: 'degen' }, 'quote-closing');
    open = false;
    const cap = await backend.capture({ accountId: 'acct-1', wallet, input: { ...input('buy'), riskMode: 'degen' }, quote, checked, quotedAt: new Date(), expiresAt: new Date() } as RetainedTrade);
    expect(cap.deps.lockedLiquidityRoute!(checked!.order.execution!)).toBe(false);
    expect(cap.state.stateFingerprint).not.toBe(checked!.order.execution!.stateFingerprint);
  });
});

describe('Pons acquisition and the venue hook', () => {
  const verdict = vi.fn(async () => ({ verdict: undefined, guardV2Active: false, scanPending: false }));
  const lease = { withExclusive: vi.fn() };
  const adapter = () => ({ receipt: vi.fn(), transaction: vi.fn() }) as never;
  const owner = { id: 'acct-1', wallet };
  it('binds the curve bytes to the wallet with fingerprints, and a graduation after the quote changes the order-time state', async () => {
    let graduated = false;
    const open = chainFor({ curve: {} }), closed = chainFor({ curve: { graduated: true } });
    const backend = ponsTradeBackend({ chain: () => graduated ? closed : open, lease, sources: sources(), verdict, adapter });
    const { quote, checked } = await backend.quote(owner, input('buy'), 'quote-1');
    const b = checked!.order.execution!;
    expect(quote).toMatchObject({ route: { venue: 'pons_curve', poolId: curve, executable: true }, fee: { bps: 0 }, buyTaxPct: 2, binding: false });
    expect(quote).not.toHaveProperty('tx');
    expect(b).toMatchObject({ account: wallet, recipient: wallet, coin, side: 'buy', tx: { to: curve }, approval: null });
    const retained = { id: 'quote-1', accountId: owner.id, wallet, input: input('buy'), quote, checked, quotedAt: new Date(), expiresAt: new Date(Date.now() + 15_000), createdAt: new Date() } as RetainedTrade;
    const before = await backend.capture(retained);
    expect(before.state).toMatchObject({ routeFingerprint: b.routeFingerprint, profileHash: b.profileHash, stateFingerprint: b.stateFingerprint, routeAvailable: true });
    graduated = true;
    const after = await backend.capture(retained);
    expect(after.state.routeFingerprint).toBe(b.routeFingerprint);
    expect(after.state.stateFingerprint).not.toBe(b.stateFingerprint);
    expect(actualStateHash(after.state as ActualOrderState)).not.toBe(actualStateHash(before.state));
    // The policy gate reports actual_order_state_changed, which the order endpoint returns as quote_changed: re-quote.
    expect(preparationError('actual_order_state_changed')).toBe('quote_changed');
  });
  it('a fee change between quote and order also changes the state fingerprint', async () => {
    let fee = 100n;
    const backend = ponsTradeBackend({ chain: () => chainFor({ curve: { feeBps: fee } }), lease, sources: sources(), verdict, adapter });
    const { quote, checked } = await backend.quote(owner, input('buy'), 'quote-2');
    fee = 150n;
    const retained = { accountId: owner.id, wallet, input: input('buy'), quote, checked, quotedAt: new Date(), expiresAt: new Date() } as RetainedTrade;
    expect((await backend.capture(retained)).state.stateFingerprint).not.toBe(checked!.order.execution!.stateFingerprint);
  });
  it('reports an unsupported binding without touching the simulation host', async () => {
    const probe = new PonsActualOrderProbe(lease, sources(), () => chainFor({ curve: {} }));
    const b = binding();
    expect(await probe.observe(b, stateFor(b), 1)).toMatchObject({ status: 'unsupported', origin: 'measured', evidenceIds: [] });
    // Curve bytes to a curve that is not the coin's indexed curve.
    const foreign = { ...b, tx: { ...b.tx, to: padHex('0x46', { size: 20 }), data: ponsTradeCall({ side: 'buy', amountIn: BigInt(b.amountIn), minOut: BigInt(b.minOut), recipient: wallet }) } };
    expect(await probe.observe(foreign, stateFor(foreign), 1)).toMatchObject({ status: 'unsupported' });
    expect(lease.withExclusive).not.toHaveBeenCalled();
  });
  it('quotes open curves on the curve, hands everything else to the pools, and dispatches capture, probe and fills by venue', async () => {
    const poolQuote = { quote: { route: { venue: 'uniswap_v3' } }, checked: null } as never;
    const pools = { quote: vi.fn(async () => poolQuote), capture: vi.fn(), probe: { observe: vi.fn() },
      reconciliation: { supports: vi.fn(() => true), receipt: vi.fn(), transaction: vi.fn(), decodeFill: vi.fn(), postFillSell: vi.fn() } } as unknown as TradeBackend;
    const pons = { quote: vi.fn(async (_o: unknown, i: { coin: string }) => { if (i.coin === coin) return { quote: { route: { venue: 'pons_curve' } }, checked: null }; throw new PonsHandoff('graduated'); }),
      capture: vi.fn(), probe: { observe: vi.fn() },
      reconciliation: { supports: vi.fn(() => true), receipt: vi.fn(), transaction: vi.fn(), decodeFill: vi.fn(), postFillSell: vi.fn() } } as unknown as TradeBackend;
    const venue = venueTradeBackend(pools, pons);
    expect(venue.probe).toBeInstanceOf(VenueActualOrderProbe);
    expect(await venue.quote(owner, input('buy'), 'q')).toMatchObject({ quote: { route: { venue: 'pons_curve' } } });
    expect(pools.quote).not.toHaveBeenCalled();
    expect(await venue.quote(owner, { ...input('buy'), coin: padHex('0xee', { size: 20 }) }, 'q')).toBe(poolQuote);
    // A refusal from an open curve (graduating, anti-snipe) is final: it never falls through to another venue.
    vi.mocked(pons.quote).mockRejectedValueOnce(new ChainQuoteError('no_route', 'The curve is graduating'));
    await expect(venue.quote(owner, input('buy'), 'q')).rejects.toMatchObject({ code: 'no_route' });
    expect(pools.quote).toHaveBeenCalledTimes(1);
    const ponsRetained = { quote: { route: { venue: 'pons_curve' } } } as RetainedTrade, poolRetained = { quote: { route: { venue: 'uniswap_v3' } } } as RetainedTrade;
    await venue.capture(ponsRetained); await venue.capture(poolRetained);
    expect(pons.capture).toHaveBeenCalledWith(ponsRetained);
    expect(pools.capture).toHaveBeenCalledWith(poolRetained);
    const b = binding(), curveBinding = { ...b, tx: { ...b.tx, data: ponsTradeCall({ side: 'buy', amountIn: 1n, minOut: 1n, recipient: wallet }) } };
    await venue.probe.observe(curveBinding, stateFor(curveBinding), 1); await venue.probe.observe(b, stateFor(b), 1);
    expect(pons.probe.observe).toHaveBeenCalledTimes(1);
    expect(pools.probe.observe).toHaveBeenCalledTimes(1);
    const receipt = receiptOf([]);
    await venue.reconciliation!.decodeFill(ponsRetained, receipt); await venue.reconciliation!.decodeFill(poolRetained, receipt);
    expect(pons.reconciliation!.decodeFill).toHaveBeenCalledWith(ponsRetained, receipt);
    expect(pools.reconciliation!.decodeFill).toHaveBeenCalledWith(poolRetained, receipt);
  });
});
