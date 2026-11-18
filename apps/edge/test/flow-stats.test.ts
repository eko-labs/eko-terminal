import { describe, expect, it } from 'vitest';
import { getAddress, keccak256, toHex, zeroAddress, type Address, type Hex } from 'viem';
import { CoinCardSchema, FlowSchema, PairRowSchema, RadarRowSchema } from '@eko/shared';
import { flowActivity, tradeWallets } from '../src/flow-stats.js';
import { coinCard, flowView, pairRow, radarRow, type ViewContext } from '../src/views.js';
import type { CoinState } from '../src/tracker.js';

const A = (n: number) => getAddress(`0x${n.toString(16).padStart(40, '0')}`);
const token = A(0x70c), manager = A(0x9a1), launcher = A(0xfac), router = A(0x707), curve = A(0xc0e);
const alice = A(0xa11ce), bob = A(0xb0b), carol = A(0xca201);
const NOW = 1_800_000_000, ETH_USD = 3000, e18 = 10n ** 18n;

function coin(over: Partial<CoinState> = {}): CoinState {
  return { launchpad: 'pons', key: null, flipped: false, supplyFromMints: false, launcher, manager, token, creator: carol, poolId: `0x${'0'.repeat(64)}`, quote: zeroAddress,
    supply: 1_000_000_000n * e18, configId: 0n, firstBuyIn: 0n, firstBuyOut: 0n, feeRecipient: carol, feeLocked: false, block: 1, ts: NOW - 90_000, tx: `0x${'0'.repeat(64)}`,
    trades: [], netHype: 0, sqrtPriceX96: null, graduated: false, name: 'X', symbol: 'X', flows: [], ...over } as CoinState;
}
let n = 0;
/** A trade of `eth` by `wallet`, `ago` seconds before NOW. Through the router (tokens pass through it) unless direct. */
function trade(c: CoinState, wallet: Address | null, side: 'buy' | 'sell', eth: number, ago: number, opts: { direct?: boolean; tx?: Hex } = {}) {
  const tx = opts.tx ?? keccak256(toHex(`tx${n++}`)), ts = NOW - ago, block = 1000 + n, tokens = eth * 1e6, value = BigInt(tokens) * e18;
  // The swap's sender is the router, as on chain: it must never be read as the wallet.
  c.trades.push({ ts, block, tx, sender: router, side, hype: eth, tokens, priceHype: eth / tokens });
  if (!wallet) return tx;
  const pool = manager.toLowerCase(), w = wallet.toLowerCase(), r = router.toLowerCase();
  const hops: [string, string][] = side === 'buy' ? (opts.direct ? [[pool, w]] : [[pool, r], [r, w]]) : (opts.direct ? [[w, pool]] : [[w, r], [r, pool]]);
  for (const [from, to] of hops) c.flows.push({ tx, block, ts, from, to, value });
  return tx;
}
const ctx: ViewContext = { nowSec: NOW, head: 5000, hypeUsd: ETH_USD, native: 'ETH' };

describe('flow stats', () => {
  it('reads the wallet from the transaction\'s transfers, never from the swap sender', () => {
    const c = coin(), tx = trade(c, alice, 'buy', 1, 10), tx2 = trade(c, bob, 'sell', 1, 5, { direct: true });
    const w = tradeWallets(c, new Set([tx.toLowerCase(), tx2.toLowerCase()]));
    expect(w.get(tx.toLowerCase())).toEqual({ buy: alice.toLowerCase() });
    expect(w.get(tx2.toLowerCase())).toEqual({ sell: bob.toLowerCase() });
  });

  it('measures buy and sell volume, counts, unique wallets and net flow per window', () => {
    const c = coin();
    trade(c, alice, 'buy', 2, 60); trade(c, alice, 'buy', 1, 120); trade(c, bob, 'buy', 0.5, 200);
    trade(c, bob, 'sell', 1, 30, { direct: true });
    trade(c, carol, 'sell', 4, 2 * 3600); // outside 1h, inside 24h
    trade(c, null, 'buy', 1, 100); // its transfers were not kept
    const h = flowActivity(c, '1h', ctx)!;
    expect(h).toMatchObject({ buyUsd: 4.5 * ETH_USD, sellUsd: 1 * ETH_USD, netUsd: 3.5 * ETH_USD, buys: 4, sells: 1, buyers: 2, sellers: 1, unattributed: 1 });
    expect(h.largest).toBeUndefined();
    const m5 = flowActivity(c, '5m', ctx)!;
    expect(m5).toMatchObject({ buys: 4, sells: 1 });
    const d = flowActivity(c, '24h', ctx)!;
    expect(d).toMatchObject({ sellUsd: 5 * ETH_USD, sellers: 2, sells: 2 });
    expect(flowActivity(coin(), '1h', ctx)).toMatchObject({ buyUsd: 0, sellUsd: 0, buys: 0, sells: 0, buyers: 0, sellers: 0 });
  });

  it('lists the largest buyers and sellers and the latest trades on the flow endpoint', () => {
    const c = coin();
    trade(c, alice, 'buy', 2, 60); trade(c, alice, 'buy', 1, 120); trade(c, bob, 'buy', 0.5, 200); trade(c, bob, 'sell', 1, 30);
    trade(c, carol, 'sell', 9, 2 * 3600);
    const f = FlowSchema.parse(flowView(c, ctx, '1h'));
    expect(f.activity!.largest).toEqual([
      { wallet: alice.toLowerCase(), side: 'buy', usd: 3 * ETH_USD, trades: 2, lastTs: NOW - 60 },
      { wallet: bob.toLowerCase(), side: 'buy', usd: 0.5 * ETH_USD, trades: 1, lastTs: NOW - 200 },
      { wallet: bob.toLowerCase(), side: 'sell', usd: 1 * ETH_USD, trades: 1, lastTs: NOW - 30 },
    ]);
    expect(f.activity!.recent!.map(t => t.ts)).toEqual([NOW - 30, NOW - 60, NOW - 120, NOW - 200]);
    expect(f.activity!.recent![0]).toMatchObject({ side: 'sell', wallet: bob.toLowerCase(), usd: ETH_USD });
    // The label split is not measured, and says so.
    expect(f.meta).toMatchObject({ unavailable: true, missing: ['agentPct', 'crewPct', 'humanPct', 'washEstPct'], flags: ['activity_measured', 'wallet_labels_unavailable'] });
  });

  it('never counts the pool, curve or launcher as a trader', () => {
    const c = coin({ curve: { address: curve, graduationThreshold: 1n, realQuoteReserve: 0n, realTokenReserve: 0n } });
    const tx = keccak256(toHex('curve-buy'));
    c.trades.push({ ts: NOW - 10, block: 9, tx, sender: alice, side: 'buy', hype: 1, tokens: 1, priceHype: 1 });
    c.flows.push({ tx, block: 9, ts: NOW - 10, from: curve.toLowerCase(), to: alice.toLowerCase(), value: e18 });
    expect(flowActivity(c, '5m', ctx)).toMatchObject({ buyers: 1, sellers: 0, unattributed: 0 });
  });

  it('is absent without an ETH price, and rides on the radar row, the pairs card and the coin card', () => {
    const c = coin(); trade(c, alice, 'buy', 1, 60);
    expect(flowActivity(c, '1h', { ...ctx, hypeUsd: null })).toBeNull();
    expect(flowView(c, { ...ctx, hypeUsd: null }, '1h').activity).toBeUndefined();
    const row = RadarRowSchema.parse(radarRow(c, undefined, ctx, 1)), pair = PairRowSchema.parse(pairRow(c, undefined, ctx)), card = CoinCardSchema.parse(coinCard(c, undefined, ctx));
    for (const flow of [row.flow, pair.flow, card.flow]) expect(flow.activity).toMatchObject({ buyUsd: ETH_USD, buys: 1, buyers: 1 });
    // The agent split is still named unavailable everywhere.
    expect(row.unavailable).toContain('flow');
    expect(card.meta?.flow).toMatchObject({ unavailable: true, flags: ['activity_measured', 'wallet_labels_unavailable'] });
  });
});

describe('radar trading windows', () => {
  it('uses the 24h cutoff for volume and trades, and the previous price for change', () => {
    const c = coin();
    trade(c, null, 'buy', 8, 86_401);
    trade(c, null, 'sell', 4, 7_200);
    trade(c, null, 'buy', 2, 60);
    c.trades[0].priceHype = 2;
    c.trades[1].priceHype = 3;
    c.trades[2].priceHype = 6;
    expect(RadarRowSchema.parse(radarRow(c, undefined, ctx, 1))).toMatchObject({
      volume1hUsd: 2 * ETH_USD, trades1h: 1, change1hPct: 100,
      volume24hUsd: 6 * ETH_USD, trades24h: 2, change24hPct: 200,
    });
  });

  it('uses the available trades for a coin younger than 24 hours', () => {
    const c = coin({ ts: NOW - 7_200 });
    trade(c, null, 'buy', 2, 7_200);
    trade(c, null, 'sell', 1, 60);
    c.trades[0].priceHype = 4;
    c.trades[1].priceHype = 3;
    expect(RadarRowSchema.parse(radarRow(c, undefined, ctx, 1))).toMatchObject({
      volume24hUsd: 3 * ETH_USD, trades24h: 2, change24hPct: -25,
    });
  });
});
