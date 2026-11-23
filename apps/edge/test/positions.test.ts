import { describe, expect, it } from 'vitest';
import { getAddress, keccak256, toHex, zeroAddress, type Address, type Hex } from 'viem';
import { loadRegistry } from '@eko/chain';
import quoted from './fixtures/robinhood/longxyz-quoted.json' with { type: 'json' };
import { robinhoodChain, v3TokenPrice, robinhoodAddresses, type QuotePrices } from '../src/chains/robinhood/index.js';
import { compactFlows, FOLDED_TX, Tracker, type CoinState, type RawLog, type Rpc } from '../src/tracker.js';
import { historyOf, positions, priceNow, profitAt, wholeTokens, type Position } from '../src/positions.js';
import { flowStats } from '../src/holders.js';
import { launchGroups } from '../src/bundles.js';
import { fx, nymo } from './fixtures/nymo.js';

const A = (n: number) => getAddress(`0x${n.toString(16).padStart(40, '0')}`);
const token = A(0x70c), manager = A(0x9a1), launcher = A(0xfac), router = A(0x707), protocol = A(0x9e0);
const dev = A(0xde5), early = A(0x5a1), late = A(0x1a7e), friend = A(0xf00e), other = A(0xb16);
const LAUNCH = 1000, T0 = 1_800_000_000, e18 = 10n ** 18n, M = 1_000_000n * e18, SUPPLY = 1000n * M;

function launched(over: Partial<CoinState> = {}): CoinState {
  const c = { launchpad: 'pons', key: null, flipped: false, supplyFromMints: false, launcher, manager, token, creator: dev, poolId: `0x${'0'.repeat(64)}`, quote: zeroAddress,
    supply: SUPPLY, configId: 0n, firstBuyIn: 0n, firstBuyOut: 0n, feeRecipient: dev, feeLocked: false, block: LAUNCH, ts: T0, tx: `0x${'1'.repeat(64)}`,
    trades: [], netHype: 0, sqrtPriceX96: null, graduated: false, name: 'X', symbol: 'X', flows: [], ...over } as CoinState;
  c.flows.push({ tx: c.tx, block: LAUNCH, ts: T0, from: zeroAddress, to: manager.toLowerCase(), value: SUPPLY });
  return c;
}
let n = 0;
/** A trade through the router: `millions` of tokens for `eth`, `sec` after launch (one block a second). */
function trade(c: CoinState, wallet: Address, side: 'buy' | 'sell', eth: number, sec: number, millions: number): Hex {
  const tx = keccak256(toHex(`tx${n++}`)), ts = T0 + sec, block = LAUNCH + sec, value = BigInt(millions) * M;
  c.trades.push({ ts, block, tx, sender: router, side, hype: eth, tokens: millions * 1e6, priceHype: eth / (millions * 1e6) });
  const pool = manager.toLowerCase(), w = wallet.toLowerCase(), r = router.toLowerCase();
  for (const [from, to] of side === 'buy' ? [[pool, r], [r, w]] : [[w, r], [r, pool]]) c.flows.push({ tx, block, ts, from: from!, to: to!, value });
  return tx;
}
function transfer(c: CoinState, from: Address, to: Address, millions: number, sec: number) {
  c.flows.push({ tx: keccak256(toHex(`tx${n++}`)), block: LAUNCH + sec, ts: T0 + sec, from: from.toLowerCase(), to: to.toLowerCase(), value: BigInt(millions) * M });
}
const of = (c: CoinState, w: Address, excluded: string[] = [protocol]) => positions(c, { excluded }).wallets.find(p => p.wallet === w.toLowerCase());
const tokens = (p: Position | undefined, k: keyof Position) => Number((p![k] as bigint) / M);

describe('positions', () => {
  it('reads each wallet\'s buys and sells from its net change in swap transactions, never the router or pool', () => {
    const c = launched();
    transfer(c, manager, protocol, 100, 0);
    trade(c, dev, 'buy', 1, 0, 50);
    trade(c, early, 'buy', 2, 5, 40);
    trade(c, dev, 'sell', 1.6, 60, 40);
    const p = positions(c, { excluded: [protocol] });
    expect(p.wallets.map(w => w.wallet).sort()).toEqual([dev, early].map(a => a.toLowerCase()).sort());
    const d = of(c, dev)!;
    expect(d).toMatchObject({ spent: 1, received: 1.6, buys: 1, sells: 1, firstBuy: { ts: T0, block: LAUNCH }, lastTs: T0 + 60 });
    expect([tokens(d, 'bought'), tokens(d, 'sold'), tokens(d, 'balance'), tokens(d, 'costed')]).toEqual([50, 40, 10, 10]);
    // Bought at 1 ETH for 50M: 0.02 ETH per million; 40M of it sold for 1.6 ETH (cost 0.8).
    expect(d.entry! * 1e6).toBeCloseTo(0.02, 12);
    expect(d.realized).toBeCloseTo(0.8, 12);
    expect(d.cost).toBeCloseTo(0.2, 12);
    // The last trade's price is the coin's price now: 1.6 ETH / 40M.
    expect(p.price! * 1e6).toBeCloseTo(0.04, 12);
    expect(profitAt(d, p.price!, p.decimals).total).toBeCloseTo(0.8 + 0.4 - 0.2, 12);
    expect(profitAt(of(c, early)!, p.price!, p.decimals).total).toBeCloseTo(40 * 0.04 - 2, 12);
    expect(p.history).toEqual({ complete: true, since: T0 });
  });

  it('shares one transaction\'s buy among the wallets it bought for, by the tokens each got', () => {
    const c = launched();
    const tx = keccak256(toHex('bundle')), wallets = [A(0xb1), A(0xb2), A(0xb3)], got = [10n, 20n, 10n];
    c.trades.push({ ts: T0 + 1, block: LAUNCH + 1, tx, sender: router, side: 'buy', hype: 4, tokens: 40e6, priceHype: 1e-7 });
    c.flows.push({ tx, block: LAUNCH + 1, ts: T0 + 1, from: manager.toLowerCase(), to: router.toLowerCase(), value: 40n * M });
    wallets.forEach((w, i) => c.flows.push({ tx, block: LAUNCH + 1, ts: T0 + 1, from: router.toLowerCase(), to: w.toLowerCase(), value: got[i]! * M }));
    expect(wallets.map(w => of(c, w)!.spent)).toEqual([1, 2, 1]);
    expect(wallets.map(w => of(c, w)!.buys)).toEqual([1, 1, 1]);
  });

  it('keeps tokens received by transfer apart: no known cost, and sells take from both in proportion', () => {
    const c = launched();
    trade(c, early, 'buy', 1, 1, 10);
    trade(c, other, 'buy', 1, 2, 10);
    transfer(c, other, early, 10, 3);
    transfer(c, other, friend, 0, 3);
    trade(c, early, 'sell', 3, 100, 10);
    const e = of(c, early)!, o = of(c, other)!;
    expect([tokens(e, 'transferredIn'), tokens(e, 'balance'), tokens(e, 'costed')]).toEqual([10, 10, 5]);
    // Half the sold tokens were bought (cost 0.5 ETH): realized 1.5 - 0.5.
    expect(e.realized).toBeCloseTo(1, 12);
    expect(e.cost).toBeCloseTo(0.5, 12);
    expect(e.costBasis! * 1e6).toBeCloseTo(0.1, 12);
    // Sent away: its bought tokens left with their cost; nothing realized.
    expect(o).toMatchObject({ spent: 1, realized: 0, cost: 0, costed: 0n, balance: 0n, costBasis: null });
    expect(tokens(o, 'transferredOut')).toBe(10);
    // A wallet that only ever received tokens has a balance and no cost at all.
    transfer(c, early, friend, 4, 200);
    const f = of(c, friend)!;
    expect(f).toMatchObject({ buys: 0, spent: 0, entry: null, costBasis: null, costed: 0n });
    expect(tokens(f, 'balance')).toBe(4);
  });

  it('does not count tokens the launchpad pays out in a swap transaction as bought', () => {
    const c = launched();
    const tx = trade(c, early, 'buy', 1, 30, 10), feeTaker = A(0xfee);
    // The graduation in the same transaction: the launcher passes tokens to its fee recipient.
    c.flows.push({ tx, block: LAUNCH + 30, ts: T0 + 30, from: manager.toLowerCase(), to: launcher.toLowerCase(), value: 5n * M });
    c.flows.push({ tx, block: LAUNCH + 30, ts: T0 + 30, from: launcher.toLowerCase(), to: feeTaker.toLowerCase(), value: 5n * M });
    expect(of(c, early)).toMatchObject({ spent: 1, buys: 1 });
    expect(of(c, feeTaker)).toMatchObject({ spent: 0, buys: 0, transferredIn: 5n * M });
  });

  it('prices per whole token at the coin\'s own decimals', () => {
    // Nine decimals: 1e18 base units are 1e9 whole tokens.
    const c = launched({ decimals: 9 });
    trade(c, early, 'buy', 1, 1, 10);
    const p = positions(c, { excluded: [] }), e = p.wallets[0]!;
    expect(wholeTokens(e.balance, p.decimals)).toBe(10e6 * 1e9);
    expect(e.entry! * 10e15).toBeCloseTo(1, 9);
    expect(p.price! * 10e15).toBeCloseTo(1, 9);
  });

  it('says when a coin cannot be priced rather than guess', () => {
    // Quoted in a token the chain does not convert: its swaps are not trades (tracker.ts), so nothing is bought.
    const c = launched({ quote: A(0x7770) });
    trade(c, early, 'buy', 1, 1, 10);
    const p = positions(c, { excluded: [] });
    expect(p).toMatchObject({ price: null, unpriced: 'quote_not_converted' });
    expect(p.wallets[0]).toMatchObject({ buys: 0, spent: 0, transferredIn: 10n * M });
    expect(positions(launched(), { excluded: [] })).toMatchObject({ price: null, unpriced: 'no_price', wallets: [] });
    expect(priceNow({ ...launched(), openPrice: 2e-8 } as CoinState)).toBe(2e-8);
  });

  it('says from when the history it holds is whole', () => {
    const c = launched();
    for (let i = 0; i < 30; i++) trade(c, A(0x100 + (i % 3)), 'buy', 0.1, 700 + i * 10, 1);
    expect(historyOf(c)).toEqual({ complete: true, since: T0 });
    // Folded transfers (tracker.ts compactFlows): balances stay, individual trades before the fold are gone.
    const folded = structuredClone(c);
    compactFlows(folded, 40);
    const lastFold = folded.flows.filter(f => f.tx === FOLDED_TX).at(-1)!;
    expect(historyOf(folded)).toEqual({ complete: false, since: lastFold.ts });
    const before = positions(c, { excluded: [] }).wallets.filter(w => w.balance > 0n), after = positions(folded, { excluded: [] }).wallets.filter(w => w.balance > 0n);
    expect(after.map(w => [w.wallet, w.balance]).sort()).toEqual(before.map(w => [w.wallet, w.balance]).sort());
    // The folded part of each balance has no known cost.
    for (const w of after) { expect(w.transferredIn).toBeGreaterThan(0n); expect(w.costed).toBeLessThan(w.balance); }
    // A coin first seen after its mint (found late), or at the trade cap (its oldest trades dropped).
    const lateSeen = launched(); lateSeen.flows.splice(0, 1); trade(lateSeen, late, 'buy', 1, 900, 1);
    expect(historyOf(lateSeen)).toEqual({ complete: false, since: T0 + 900 });
    expect(historyOf(c, 30)).toEqual({ complete: false, since: T0 + 700 });
  });

  it('agrees with holders.ts on balances and with bundles.ts on who bought at a real launch (NYMO)', () => {
    const c = nymo();
    // The fixture keeps who traded, not the amounts: give each trade a native amount so buys and sells carry one.
    c.trades.forEach((t, i) => { t.hype = 0.01 * (1 + (i % 5)); t.priceHype = 1e-9; });
    const excluded = [fx.curve, fx.factory, fx.manager, '0xe33E9E479dF8802cb0866d5d05258bEc4cF62948', '0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044'].map(a => getAddress(a));
    const p = positions(c, { excluded }), byWallet = new Map(p.wallets.map(w => [w.wallet, w]));
    expect(p.history).toEqual({ complete: true, since: fx.launchTs });
    // Every native amount lands with a wallet, but for swaps whose transfers name none (the pool's hook paying the pool).
    const named = new Set([...excluded.map(a => a.toLowerCase()), zeroAddress]);
    const walletTxs = new Set(c.flows.filter(f => !named.has(f.from) || !named.has(f.to)).map(f => f.tx));
    const total = (side: 'buy' | 'sell') => c.trades.filter(t => t.side === side && walletTxs.has(t.tx)).reduce((s, t) => s + t.hype, 0);
    expect(c.trades.filter(t => !walletTxs.has(t.tx))).toHaveLength(1);
    const sum = (k: 'spent' | 'received') => p.wallets.reduce((s, w) => s + w[k], 0);
    expect(sum('spent')).toBeCloseTo(total('buy'), 9);
    expect(sum('received')).toBeCloseTo(total('sell'), 9);
    // The largest holder and the holder count, as the coin's checks read them.
    const stats = flowStats(c, { excluded, hypeUsd: 3000 });
    const holders = p.wallets.filter(w => w.balance > 0n).sort((a, b) => (b.balance > a.balance ? 1 : -1));
    expect(holders.length).toBe(stats.holderCount);
    // The deployer bought in the launch transaction and still holds all of it.
    expect(byWallet.get(fx.deployer)).toMatchObject({ buys: 1, sells: 0, firstBuy: { ts: fx.launchTs, block: fx.launchBlock } });
    expect(byWallet.get(fx.deployer)!.costed).toBe(byWallet.get(fx.deployer)!.balance);
    // The two-wallet bundle bought in one transaction, a block after launch, at one price; both sold out since.
    const [b1, b2] = ['0x1fd3598b55ae38564d6c0c4cdfcb11d3a293cbac', '0x8a94ea7c8597673a3b7ff3406ec771852a37ef53'].map(w => byWallet.get(w)!);
    expect(b1!.firstBuy!.block - fx.launchBlock).toBe(1);
    expect(b1!.entry).toBeCloseTo(b2!.entry!, 18);
    expect([b1!.balance, b2!.balance]).toEqual([0n, 0n]);
    // Every launch-window buyer bundles.ts names bought here too; the graduation's fee recipient did not buy.
    const bundle = launchGroups(c, { excluded, firstBlocks: 35, minWallets: 3 }).bundles[0]!;
    for (const w of bundle.launchWallets) expect(byWallet.get(w)!.buys).toBeGreaterThan(0);
    expect(byWallet.get('0x74ab274b19f0989f9064f803e820b4e082bd058e')).toMatchObject({ buys: 1 }); // it bought in the graduating swap
  });
});

describe('positions on a long.xyz coin quoted in a token (more_launchpads)', () => {
  const registry = loadRegistry(), addrs = robinhoodAddresses(registry);
  const offline: Rpc = { request: async () => { throw new Error('no RPC in this test'); } };
  type Launch = (typeof quoted.launches)[number] & { launchTx: RawLog[]; after: RawLog[]; token: string };
  const l = (quoted.launches as unknown as Launch[]).find(x => x.quoteSymbol === 'USDG')!;
  const reading = quoted.pricing.find(p => p.symbol === 'WETH' && p.quote === 'USDG' && p.fee === 100)!;
  const ethUsd = v3TokenPrice(BigInt(reading.sqrtPriceX96), reading.tokenIsToken0, 18, 6);
  const quotes = {
    asset: (q: string) => q.toLowerCase() === addrs.usdg.toLowerCase() ? { address: getAddress(q), symbol: 'USDG', decimals: 6, kind: 'USDG' as const, ethPer: 1 / ethUsd } : null,
    ethPer: (q: string) => q.toLowerCase() === addrs.usdg.toLowerCase() ? 1 / ethUsd : null,
    want: () => {}, isRejected: () => false, refresh: async () => {},
  } as unknown as QuotePrices;

  it('reads its trades in ETH, as the tracker converts them', () => {
    const chain = robinhoodChain(registry, { moreLaunchpads: true, quotes }), tracker = new Tracker(offline, chain);
    const logs = [...new Map([...l.launchTx, ...l.after].map(x => [`${x.transactionHash}:${BigInt(x.logIndex)}`, x])).values()];
    tracker.applyAll(logs, x => Math.round(l.launchTs + (Number(BigInt(x.blockNumber)) - l.launchBlock) * 0.1));
    const coin = tracker.coin(l.token)!;
    expect(coin.quoteConverted?.symbol).toBe('USDG');
    const p = positions(coin, { excluded: chain.excluded(coin) });
    expect(p.price).toBeGreaterThan(0);
    const buyers = p.wallets.filter(w => w.buys > 0);
    expect(buyers.length).toBeGreaterThan(0);
    expect(buyers.reduce((s, w) => s + w.spent, 0)).toBeCloseTo(coin.trades.filter(t => t.side === 'buy').reduce((s, t) => s + t.hype, 0), 9);
    for (const w of buyers) expect(w.entry).toBeGreaterThan(0);
  });
});
