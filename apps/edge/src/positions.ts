import { zeroAddress } from 'viem';
import { FOLDED_TX, MAX_TRADES_PER_COIN, type CoinState } from './tracker.js';
import { notTraders } from './flow-stats.js';
import { unitScale } from './views.js';
import { transferCoverage } from './coverage.js';

/**
 * Every wallet's position in one coin, from what the edge keeps for it: its trades (native amount per swap transaction)
 * and its token transfers. Pure, apart from a small per-coin memo.
 *
 * Wallets are found as flow-stats.ts (tradeWallets) and holders.ts (flowStats) find them: a wallet's net change of the
 * coin inside a transaction that swapped is a buy (it rose) or a sell (it fell); routers that pass tokens through net
 * to zero and drop out; the coin's pool manager, curve, launcher, the token itself, zero and burn addresses and the
 * chain's protocol addresses are never wallets. As in bundles.ts, a buy's tokens came from the pool (a sell's went to
 * it), directly or through a router: tokens the launchpad pays out in a swap transaction (a graduation's fee) are not
 * bought. A swap transaction that bought for several wallets (a bundler) shares
 * its native amount among them by the tokens each got; likewise for sells. A wallet's net change in any other
 * transaction is a plain transfer: tokens received that way have no known cost, tokens sent away leave its position.
 *
 * Cost is the average cost of the tokens a wallet bought. Selling or sending tokens takes them out of its bought and
 * received tokens in proportion, so a sell's realized profit counts only the bought part. Amounts are in the chain's
 * native coin (ETH on Robinhood Chain); a coin quoted in a token counts only when the chain converts its trades into
 * native units (CoinState.quoteConverted), as views.ts prices it. Token amounts are base units; prices are native per
 * whole token at the coin's own decimals.
 */
export interface Position {
  /** Lowercase. */
  wallet: string;
  /** Native the wallet paid in its buys, and got back in its sells. */
  spent: number; received: number;
  /** Swap transactions it bought in, and sold in. */
  buys: number; sells: number;
  /** Tokens it got in buys and gave up in sells. */
  bought: bigint; sold: bigint;
  /** Tokens it got by plain transfer (no known cost), and sent away outside a trade. */
  transferredIn: bigint; transferredOut: bigint;
  /** Its balance now, from every transfer EKO holds for the coin. */
  balance: bigint;
  /** The part of `balance` it bought and still holds (known cost), and what that part cost (native, average cost). */
  costed: bigint; cost: number;
  /** Native its sells returned beyond the average cost of the bought tokens they sold. */
  realized: number;
  /** Average buy price over all its buys (native per whole token); null without a buy. */
  entry: number | null;
  /** Average cost of the bought tokens it still holds (native per whole token); null when it holds none. */
  costBasis: number | null;
  firstBuy: { ts: number; block: number } | null;
  /** Its latest buy, sell or transfer (unix seconds). */
  lastTs: number;
}

/** Why a coin's positions have no price: quoted in a token the chain does not convert, or never traded. */
export type Unpriced = 'quote_not_converted' | 'no_price';

export interface Positions {
  /** Native per whole token now (the last trade's price), or null with `unpriced`. */
  price: number | null;
  unpriced?: Unpriced;
  decimals: number;
  /**
   * Whether EKO holds the coin's trades and transfers from launch. When not, `since` is when the history it holds
   * starts (unix seconds): older transfers were folded or never seen, or older trades dropped (tracker.ts caps both),
   * so tokens moved before then count as received by transfer, with no known cost.
   */
  history: { complete: boolean; since: number };
  /** Every wallet that held, bought, sold, received or sent the coin, in no particular order. */
  wallets: Position[];
}

export interface PositionOptions {
  /** The chain's protocol addresses (ChainAdapter.excluded). */
  excluded: readonly string[];
  /** The tracker's trade cap (TrackerOptions.maxTradesPerCoin): a coin at it may have lost its oldest trades. */
  maxTrades?: number;
}

/** Its trades are in native currency: quoted in it, or in a token the chain converts (views.ts inNative). */
export const pricedInNative = (c: Pick<CoinState, 'quote' | 'quoteConverted'>) => c.quote === zeroAddress || !!c.quoteConverted;
/** Native per whole token now, as views.ts prices a coin: the last trade, or before any a Montra pool's opening price. */
export function priceNow(c: CoinState): number | null {
  if (!pricedInNative(c)) return null;
  const perUnit = c.trades.at(-1)?.priceHype ?? c.openPrice ?? 0;
  return perUnit > 0 ? perUnit * unitScale(c) : null;
}

/** Whole tokens from base units at the coin's decimals. */
export const wholeTokens = (v: bigint, decimals: number) => Number(v) / 10 ** decimals;
/** A position's profit at `price` (native): realized, plus what its bought tokens are worth now less their cost. */
export function profitAt(p: Position, price: number, decimals: number) {
  const unrealized = wholeTokens(p.costed, decimals) * price - p.cost;
  return { realized: p.realized, unrealized, total: p.realized + unrealized };
}

export function positions(c: CoinState, opts: PositionOptions): Positions {
  const sig = `${c.trades.length}:${c.trades.at(-1)?.tx ?? ''}:${c.flows.length}:${c.flows.at(-1)?.tx ?? ''}:${c.trades.at(-1)?.priceHype ?? ''}:${opts.excluded.join(',')}:${opts.maxTrades ?? ''}`;
  const hit = MEMO.get(c);
  if (hit?.sig === sig) return hit.value;
  const value = build(c, opts);
  MEMO.set(c, { sig, value });
  return value;
}
const MEMO = new WeakMap<CoinState, { sig: string; value: Positions }>();

interface Book extends Position { uncosted: bigint }

function build(c: CoinState, opts: PositionOptions): Positions {
  const decimals = c.decimals ?? 18, perToken = 10 ** decimals;
  const skip = notTraders(c, opts.excluded);
  const native = pricedInNative(c);

  // Native in and out per swap transaction (a coin quoted in an unconverted token has no counted trades: tracker.ts).
  const swaps = new Map<string, { in: number; out: number }>();
  if (native) for (const t of c.trades) {
    const k = t.tx.toLowerCase(), e = swaps.get(k) ?? { in: 0, out: 0 };
    if (t.side === 'buy') e.in += t.hype; else e.out += t.hype;
    swaps.set(k, e);
  }

  // Each transaction's transfers, in chain order (the tracker keeps flows in it), and every balance.
  const txs = new Map<string, CoinState['flows']>();
  const balance = new Map<string, bigint>();
  for (const f of c.flows) {
    balance.set(f.from, (balance.get(f.from) ?? 0n) - f.value); balance.set(f.to, (balance.get(f.to) ?? 0n) + f.value);
    const k = f.tx.toLowerCase(), list = txs.get(k);
    if (list) list.push(f); else txs.set(k, [f]);
  }
  const pools = new Set([c.manager, ...(c.curve ? [c.curve.address] : [])].map(a => a.toLowerCase()));

  const books = new Map<string, Book>();
  const book = (w: string): Book => {
    let b = books.get(w);
    if (!b) {
      b = { wallet: w, spent: 0, received: 0, buys: 0, sells: 0, bought: 0n, sold: 0n, transferredIn: 0n, transferredOut: 0n, balance: 0n,
        costed: 0n, cost: 0, realized: 0, entry: null, costBasis: null, firstBuy: null, lastTs: 0, uncosted: 0n };
      books.set(w, b);
    }
    return b;
  };
  // Tokens leave in proportion to the bought (costed) and received (uncosted) tokens the wallet holds; returns the
  // bought part and the average cost that leaves with it. More than it is known to hold leaves the excess uncosted.
  const takeOut = (b: Book, n: bigint) => {
    const known = b.costed + b.uncosted;
    const part = known > 0n ? (n >= known ? b.costed : n * b.costed / known) : 0n;
    const cost = b.costed > 0n ? b.cost * (Number(part) / Number(b.costed)) : 0;
    b.costed -= part; b.cost -= cost; if (b.costed === 0n) b.cost = 0;
    const rest = n - part; b.uncosted = rest >= b.uncosted ? 0n : b.uncosted - rest;
    return { part, cost };
  };

  for (const [tx, flows] of txs) {
    const swap = swaps.get(tx), { ts, block } = flows[0]!;
    const nets = new Map<string, bigint>();
    for (const f of flows) {
      if (!skip.has(f.from)) nets.set(f.from, (nets.get(f.from) ?? 0n) - f.value);
      if (!skip.has(f.to)) nets.set(f.to, (nets.get(f.to) ?? 0n) + f.value);
    }
    const legs = swap ? swapLegs(flows, pools, nets) : null;
    const buy = (w: string, net: bigint) => !!swap && swap.in > 0 && net > 0n && legs!.fromPool.has(w);
    const sell = (w: string, net: bigint) => !!swap && swap.out > 0 && net < 0n && legs!.toPool.has(w);
    let up = 0n, down = 0n;
    for (const [w, net] of nets) { if (buy(w, net)) up += net; else if (sell(w, net)) down -= net; }
    for (const [w, net] of nets) {
      if (net === 0n) continue;
      const b = book(w);
      b.lastTs = Math.max(b.lastTs, ts);
      if (buy(w, net)) {
        const paid = swap!.in * (Number(net) / Number(up));
        b.spent += paid; b.bought += net; b.buys++; b.costed += net; b.cost += paid;
        b.firstBuy ??= { ts, block };
      } else if (net > 0n) {
        b.transferredIn += net; b.uncosted += net;
      } else if (sell(w, net)) {
        const n = -net, got = swap!.out * (Number(n) / Number(down)), { part, cost } = takeOut(b, n);
        b.received += got; b.sold += n; b.sells++;
        b.realized += got * (Number(part) / Number(n)) - cost;
      } else {
        b.transferredOut -= net; takeOut(b, -net);
      }
    }
  }

  // Holders that EKO saw only through folded or untracked transfers still get a position (cost unknown).
  for (const [w, v] of balance) if (v > 0n && !skip.has(w)) book(w);
  const wallets: Position[] = [];
  for (const b of books.values()) {
    const held = balance.get(b.wallet) ?? 0n, now = held > 0n ? held : 0n;
    // The running split can drift from the balance when history is partial: the balance wins, bought tokens first.
    const costed = b.costed > now ? now : b.costed;
    const cost = b.costed > 0n ? b.cost * (Number(costed) / Number(b.costed)) : 0;
    const { uncosted: _u, ...p } = b;
    wallets.push({ ...p, balance: now, costed, cost,
      entry: b.bought > 0n ? b.spent / (Number(b.bought) / perToken) : null,
      costBasis: costed > 0n ? cost / (Number(costed) / perToken) : null });
  }

  const price = priceNow(c);
  return { price, ...(price === null ? { unpriced: native ? 'no_price' as const : 'quote_not_converted' as const } : {}), decimals,
    history: historyOf(c, opts.maxTrades ?? MAX_TRADES_PER_COIN), wallets };
}

/**
 * Who took tokens out of the pool in a swap transaction, and who put them in, as bundles.ts reads a trade's legs: tokens
 * that left the pool manager or curve, directly or through a wallet that passed them on and kept none (a router, net
 * zero). Tokens from the launchpad's own contracts (a graduation paying its fee recipient) or any other protocol address
 * are neither, so they count as a transfer.
 */
function swapLegs(flows: CoinState['flows'], pools: ReadonlySet<string>, nets: ReadonlyMap<string, bigint>) {
  const through = new Set([...nets].filter(([, v]) => v === 0n).map(([w]) => w));
  const fromPool = new Set(pools), toPool = new Set(pools);
  for (let grew = true; grew;) {
    grew = false;
    for (const f of flows) if (f.value > 0n) {
      if (fromPool.has(f.from) && through.has(f.to) && !fromPool.has(f.to)) { fromPool.add(f.to); grew = true; }
      if (toPool.has(f.to) && through.has(f.from) && !toPool.has(f.from)) { toPool.add(f.from); grew = true; }
    }
  }
  const touched = (side: Set<string>, w: string, out: boolean) => flows.some(f => f.value > 0n && (out ? f.from === w && side.has(f.to) : f.to === w && side.has(f.from)));
  return { fromPool: new Set([...nets.keys()].filter(w => touched(fromPool, w, false))), toPool: new Set([...nets.keys()].filter(w => touched(toPool, w, true))) };
}

/** From when EKO holds the coin's whole history (see Positions.history): its transfers from launch (coverage.ts), and
 *  beyond that every individual transfer and trade, since costs need them (balances alone survive a fold). */
export function historyOf(c: Pick<CoinState, 'flows' | 'trades' | 'ts' | 'tx' | 'firstScanSec'>, maxTrades = MAX_TRADES_PER_COIN): Positions['history'] {
  let { since } = transferCoverage(c);
  for (let i = c.flows.length - 1; i >= 0; i--) if (c.flows[i]!.tx === FOLDED_TX) { since = Math.max(since, c.flows[i]!.ts); break; }
  if (c.trades.length >= maxTrades) since = Math.max(since, c.trades[0]!.ts);
  return { complete: since === c.ts, since };
}
