import { getAddress } from 'viem';
import type { CoinCard, FlowActivity, FlowTrade, FlowWallet } from '@eko/shared';
import type { CoinState } from './tracker.js';
import { BURN_SINKS } from './burn.js';

/**
 * Buy and sell flow per window, measured from what the edge keeps for every coin: its trades (side, native amount,
 * tokens, time) and its token transfers. Pure, apart from a small per-coin memo.
 *
 * A trade's wallet is the one whose balance of the coin rose most (a buy) or fell most (a sell) inside that
 * transaction. Routers that pass tokens through net to zero and drop out; the coin's pool, curve and launcher are never
 * a trader. A swap's own `sender` is the router, so it is not used. A trade with no such wallet (its transfers were not
 * kept) still counts in volume and in `unattributed`, never in buyers or sellers.
 *
 * Wallet labels (agent / crew / human) are not measured here: this is what was traded, not who the traders are.
 */
export type FlowWindow = CoinCard['flow']['window'];
export const FLOW_WINDOWS: readonly FlowWindow[] = ['5m', '1h', '24h'];
export const WINDOW_SEC: Record<FlowWindow, number> = { '5m': 300, '1h': 3600, '24h': 86_400 };

const NOT_TRADERS = BURN_SINKS;
/** How many of the largest buyers and of the largest sellers, and how many recent trades, the flow endpoint lists. */
export const LARGEST_PER_SIDE = 5, RECENT_TRADES = 50;

export interface FlowContext { nowSec: number; hypeUsd: number | null }

/** Addresses that move the coin for the protocol, never as a trader: the zero and burn addresses, the token, its pool
 *  manager, launcher and curve, and any the chain names (its routers, hook, factory, locker). */
function notTraders(c: CoinState, extra: readonly string[]) {
  return new Set([...NOT_TRADERS, c.token, c.manager, c.launcher, ...(c.curve ? [c.curve.address] : []), ...extra].map(a => a.toLowerCase()));
}

/** The wallet behind each side of each transaction in `txs`, from the coin's transfers. Keys are lowercase tx hashes. */
export function tradeWallets(c: CoinState, txs: ReadonlySet<string>, excluded: readonly string[] = []): Map<string, { buy?: string; sell?: string }> {
  const skip = notTraders(c, excluded), nets = new Map<string, Map<string, bigint>>();
  for (const f of c.flows) {
    const tx = f.tx.toLowerCase();
    if (!txs.has(tx)) continue;
    const m = nets.get(tx) ?? new Map<string, bigint>();
    if (!skip.has(f.from)) m.set(f.from, (m.get(f.from) ?? 0n) - f.value);
    if (!skip.has(f.to)) m.set(f.to, (m.get(f.to) ?? 0n) + f.value);
    nets.set(tx, m);
  }
  const out = new Map<string, { buy?: string; sell?: string }>();
  for (const [tx, m] of nets) {
    let buy: [string, bigint] | undefined, sell: [string, bigint] | undefined;
    for (const [wallet, net] of m) {
      if (net > 0n && (!buy || net > buy[1])) buy = [wallet, net];
      if (net < 0n && (!sell || net < sell[1])) sell = [wallet, net];
    }
    out.set(tx, { ...(buy ? { buy: buy[0] } : {}), ...(sell ? { sell: sell[0] } : {}) });
  }
  return out;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Buy and sell volume (USD), counts, unique buyers and sellers over the window ending now. With `detail`, also the
 * largest buyers and sellers and the latest trades. Null without a native-coin price, or for a coin quoted in another
 * token (its trades are not counted: tracker.ts).
 */
export function flowActivity(c: CoinState, window: FlowWindow, ctx: FlowContext, opts: { detail?: boolean; excluded?: readonly string[] } = {}): FlowActivity | null {
  if (!ctx.hypeUsd) return null;
  const memoKey = `${window}:${opts.detail ? 1 : 0}`;
  const sig = `${c.trades.length}:${c.trades.at(-1)?.tx ?? ''}:${c.flows.length}:${ctx.nowSec}:${ctx.hypeUsd}:${opts.excluded?.join(',') ?? ''}`;
  const memo = MEMO.get(c)?.get(memoKey);
  if (memo && memo.sig === sig) return memo.value;
  const value = measure(c, window, ctx.nowSec, ctx.hypeUsd, opts);
  const m = MEMO.get(c) ?? new Map();
  m.set(memoKey, { sig, value });
  MEMO.set(c, m);
  return value;
}
const MEMO = new WeakMap<CoinState, Map<string, { sig: string; value: FlowActivity }>>();

function measure(c: CoinState, window: FlowWindow, nowSec: number, ethUsd: number, opts: { detail?: boolean; excluded?: readonly string[] }): FlowActivity {
  const from = nowSec - WINDOW_SEC[window];
  // In chain order (oldest first), as the tracker keeps them.
  const trades = c.trades.filter(t => t.ts >= from && t.ts <= nowSec).sort((a, b) => a.ts - b.ts || a.block - b.block);
  const wallets = tradeWallets(c, new Set(trades.map(t => t.tx.toLowerCase())), opts.excluded);
  let buyUsd = 0, sellUsd = 0, buys = 0, sells = 0, unattributed = 0;
  const buyers = new Set<string>(), sellers = new Set<string>(), totals = new Map<string, FlowWallet>();
  const walletOf = (tx: string, side: 'buy' | 'sell') => wallets.get(tx.toLowerCase())?.[side];
  for (const t of trades) {
    const usd = t.hype * ethUsd, wallet = walletOf(t.tx, t.side);
    if (t.side === 'buy') { buyUsd += usd; buys++; } else { sellUsd += usd; sells++; }
    if (!wallet) { unattributed++; continue; }
    (t.side === 'buy' ? buyers : sellers).add(wallet);
    if (!opts.detail) continue;
    const key = `${t.side}:${wallet}`, e = totals.get(key) ?? { wallet: getAddress(wallet), side: t.side, usd: 0, trades: 0, lastTs: t.ts };
    e.usd += usd; e.trades++; e.lastTs = Math.max(e.lastTs, t.ts);
    totals.set(key, e);
  }
  const activity: FlowActivity = { buyUsd: round2(buyUsd), sellUsd: round2(sellUsd), netUsd: round2(buyUsd - sellUsd), buys, sells,
    buyers: buyers.size, sellers: sellers.size, unattributed };
  if (!opts.detail) return activity;
  const top = (side: 'buy' | 'sell') => [...totals.values()].filter(w => w.side === side).sort((a, b) => b.usd - a.usd).slice(0, LARGEST_PER_SIDE)
    .map(w => ({ ...w, usd: round2(w.usd) }));
  const recent: FlowTrade[] = trades.slice(-RECENT_TRADES).reverse().map(t => {
    const wallet = walletOf(t.tx, t.side);
    return { ts: t.ts, side: t.side, usd: round2(t.hype * ethUsd), tokens: t.tokens, tx: t.tx, ...(wallet ? { wallet: getAddress(wallet) } : {}) };
  });
  return { ...activity, largest: [...top('buy'), ...top('sell')], recent };
}
