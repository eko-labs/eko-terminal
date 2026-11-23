import type { CoinState } from './tracker.js';
import { BURN_SINKS } from './burn.js';

/**
 * Who bought a launch together, read from the coin's own transfers. Pure.
 *
 * A bundle is wallets one operator controls. The transfers show it directly:
 * - one transaction that bought for two or more wallets (one signer paid for all of them);
 * - one transaction that sold from one wallet and bought into another (the operator passing its tokens to a fresh wallet,
 *   so the supply looks spread out);
 * - tokens sent from one wallet to another outside a trade.
 * Wallets joined that way form a group. A group is a bundle when it reaches a launch buyer (a buy in the first
 * `firstBlocks`) and either bought for two wallets in one transaction inside that window, or holds `minWallets` wallets.
 *
 * Copy traders are the opposite: each signs its own transaction, through the same trading bot, within the launch window.
 * They move together because the bot copies one leader, not because one wallet paid for them. They join no bundle here.
 * (Wallets a bundler funded and sent through a bot one by one look the same in the transfers; the funder trace, where it
 * runs, still groups them as a bundle in bundle_dump.)
 *
 * A wallet's net change of the coin in a transaction is a buy leg when the tokens came from the coin's pool or curve, or
 * through an address that passed them on (a router, net zero); a sell leg the other way. Tokens from the launchpad's own
 * contracts (a graduation paying its fee recipient) are neither. Legs under a tenth of the transaction's largest are
 * left out, so a bot's small fee cut never ties its users together.
 */
export interface Bundle {
  /** Every wallet in the bundle, lowercase, in the order they first appear. */
  wallets: string[];
  /** The bundle's wallets that bought in the launch window. */
  launchWallets: string[];
  /** A launch-window transaction that bought for two or more of its wallets, when there was one. */
  oneTx: { tx: string; block: number; wallets: number; bought: string[] } | null;
  block: number; ts: number;
  /** Supply the bundle took out of the pool (its buys less what it sold back to itself), what it sold out, and holds now. */
  bought: bigint; sold: bigint; held: bigint;
  /** The block of the bundle's last sell, null while it has sold nothing. */
  lastSellBlock: number | null;
  /** Tokens one of its wallets passed to another of its wallets, oldest first (see `Rotation`). */
  rotations: Rotation[];
}

/**
 * One wallet of a group passing tokens to another: in one transaction that sold from `from` and bought into `to`
 * (`how: 'swap'`), or a plain transfer between them (`how: 'transfer'`). `value` is what `to` received of it; when a
 * transaction moved several wallets' tokens at once, each receiver's amount is split across the senders by their size.
 */
export interface Rotation { tx: string; block: number; ts: number; from: string; to: string; value: bigint; how: 'swap' | 'transfer' }

export interface CopyGroup {
  /** The contract every buy went through (the trade's sender: a trading bot's router). */
  bot: string;
  /** The wallets, lowercase, in buy order. */
  wallets: string[];
  firstBlock: number; lastBlock: number;
  bought: bigint; sold: bigint; held: bigint;
}

export interface LaunchGroups { bundles: Bundle[]; copyTraders: CopyGroup[] }

export interface LaunchGroupOptions {
  /** Addresses that are the protocol, not traders (ChainAdapter.excluded). */
  excluded: readonly string[];
  /** The launch window in blocks (bundle_dump.firstBlocks). */
  firstBlocks: number;
  /** Wallets a group needs to be a bundle without a one-transaction buy, and a copy-trading group's least size. */
  minWallets: number;
  /** Public routers everyone trades through (a Uniswap router): buys through them are not one bot's copy trades. */
  publicRouters?: readonly string[];
}

const LEG_SHARE = 10n;

export function launchGroups(coin: CoinState, o: LaunchGroupOptions): LaunchGroups {
  const lower = (a: string) => a.toLowerCase();
  const pools = new Set([coin.manager, ...(coin.curve ? [coin.curve.address] : [])].map(lower));
  const protocol = new Set([...BURN_SINKS, coin.token, coin.launcher, ...o.excluded].map(lower));
  for (const p of pools) protocol.add(p);
  const routers = new Set((o.publicRouters ?? []).map(lower));
  const inWindow = (block: number) => block >= coin.block && block - coin.block < o.firstBlocks;

  const swapTxs = new Map<string, { block: number; ts: number; senders: Set<string> }>();
  for (const t of coin.trades) {
    const k = lower(t.tx), e = swapTxs.get(k) ?? { block: t.block, ts: t.ts, senders: new Set<string>() };
    if (t.side === 'buy' && t.sender) e.senders.add(lower(t.sender));
    swapTxs.set(k, e);
  }
  const byTx = new Map<string, CoinState['flows']>();
  for (const f of coin.flows) { const k = lower(f.tx), list = byTx.get(k); if (list) list.push(f); else byTx.set(k, [f]); }

  // Union-find over wallets.
  const parent = new Map<string, string>();
  const find = (w: string): string => { let r = w; while (parent.get(r) !== r) r = parent.get(r)!; let x = w; while (x !== r) { const n = parent.get(x)!; parent.set(x, r); x = n; } return r; };
  const join = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(rb, ra); };
  const seen: string[] = [];
  const meet = (w: string) => { if (!parent.has(w)) { parent.set(w, w); seen.push(w); } };

  const balance = new Map<string, bigint>();
  const firstBuy = new Map<string, { block: number; ts: number; tx: string }>();
  const multiBuy: { tx: string; block: number; wallets: string[] }[] = [];
  const passes: Rotation[] = [];
  const pass = (tx: string, block: number, ts: number, how: Rotation['how'], out: [string, bigint][], into: [string, bigint][]) => {
    const total = out.reduce((n, [, v]) => n - v, 0n);
    if (total > 0n) for (const [from, sent] of out) for (const [to, got] of into) passes.push({ tx, block, ts, from, to, value: got * -sent / total, how });
  };
  // Per transaction: each wallet's net, and its buy/sell legs.
  const nets = new Map<string, Map<string, bigint>>();
  for (const [tx, flows] of byTx) {
    const net = new Map<string, bigint>(), touched = new Set<string>();
    for (const f of flows) {
      balance.set(f.from, (balance.get(f.from) ?? 0n) - f.value); balance.set(f.to, (balance.get(f.to) ?? 0n) + f.value);
      for (const [a, d] of [[f.from, -f.value], [f.to, f.value]] as const) if (!protocol.has(a)) { net.set(a, (net.get(a) ?? 0n) + d); touched.add(a); }
    }
    nets.set(tx, net);
    const swap = swapTxs.get(tx);
    // Tokens that left the pool, and addresses that passed them on (routers, net zero): a buy through one is still a
    // buy. The same backwards for sells. Zero-value transfers carry nothing.
    const through = new Set([...touched].filter(a => (net.get(a) ?? 0n) === 0n));
    const src = new Set(pools), sink = new Set(pools);
    for (let grew = true; grew;) {
      grew = false;
      for (const f of flows) if (f.value > 0n) {
        if (src.has(f.from) && through.has(f.to) && !src.has(f.to)) { src.add(f.to); grew = true; }
        if (sink.has(f.to) && through.has(f.from) && !sink.has(f.from)) { sink.add(f.from); grew = true; }
      }
    }
    const fromPool = (w: string) => flows.some(f => f.to === w && f.value > 0n && src.has(f.from));
    const toPool = (w: string) => flows.some(f => f.from === w && f.value > 0n && sink.has(f.to));
    const moving = [...net].filter(([, v]) => v !== 0n);
    if (!moving.length) continue;
    const top = moving.reduce((m, [, v]) => (v < 0n ? -v : v) > m ? (v < 0n ? -v : v) : m, 0n);
    const big = moving.filter(([, v]) => (v < 0n ? -v : v) * LEG_SHARE >= top);
    if (swap) {
      const buys = big.filter(([w, v]) => v > 0n && fromPool(w)).map(([w]) => w);
      const sells = big.filter(([w, v]) => v < 0n && toPool(w)).map(([w]) => w);
      for (const w of buys) if (!firstBuy.has(w)) firstBuy.set(w, { block: swap.block, ts: swap.ts, tx });
      const legs = [...buys, ...sells];
      for (const w of legs) meet(w);
      if (buys.length >= 2 || (buys.length >= 1 && sells.length >= 1)) for (const w of legs.slice(1)) join(legs[0]!, w);
      if (buys.length && sells.length) pass(tx, swap.block, swap.ts, 'swap', big.filter(([w]) => sells.includes(w)), big.filter(([w]) => buys.includes(w)));
      if (buys.length >= 2 && inWindow(swap.block)) multiBuy.push({ tx, block: swap.block, wallets: buys });
    } else {
      // A plain transfer between wallets: the same operator moving its tokens.
      const out = big.filter(([, v]) => v < 0n).map(([w]) => w), into = big.filter(([, v]) => v > 0n).map(([w]) => w);
      if (out.length && into.length) {
        for (const w of [...out, ...into]) { meet(w); join(out[0]!, w); }
        pass(tx, flows[0]!.block, flows[0]!.ts, 'transfer', big.filter(([, v]) => v < 0n), big.filter(([, v]) => v > 0n));
      }
    }
  }

  // Groups, kept when they reach a launch buyer and look like one operator's.
  const groups = new Map<string, string[]>();
  for (const w of seen) { const r = find(w), list = groups.get(r); if (list) list.push(w); else groups.set(r, [w]); }
  const bundles: Bundle[] = [];
  const bundled = new Set<string>();
  for (const wallets of groups.values()) {
    if (wallets.length < 2) continue;
    const launch = wallets.filter(w => { const b = firstBuy.get(w); return b && inWindow(b.block); });
    if (!launch.length) continue;
    const one = multiBuy.filter(m => m.wallets.some(w => wallets.includes(w))).sort((a, b) => a.block - b.block)[0];
    if (!one && wallets.length < o.minWallets) continue;
    const set = new Set(wallets);
    let bought = 0n, sold = 0n, lastSellBlock: number | null = null;
    for (const [tx, net] of nets) {
      const swap = swapTxs.get(tx);
      if (!swap) continue;
      let d = 0n;
      for (const [w, v] of net) if (set.has(w)) d += v;
      if (d > 0n) bought += d;
      else if (d < 0n) { sold -= d; lastSellBlock = Math.max(lastSellBlock ?? 0, swap.block); }
    }
    const firsts = launch.map(w => firstBuy.get(w)!).sort((a, b) => a.block - b.block);
    bundles.push({ wallets, launchWallets: launch, oneTx: one ? { tx: one.tx, block: one.block, wallets: one.wallets.length, bought: one.wallets } : null,
      block: firsts[0]!.block, ts: firsts[0]!.ts, bought, sold, held: wallets.reduce((n, w) => n + ((balance.get(w) ?? 0n) > 0n ? balance.get(w)! : 0n), 0n), lastSellBlock,
      rotations: passes.filter(p => set.has(p.from) && set.has(p.to)).sort((a, b) => a.block - b.block) });
    for (const w of wallets) bundled.add(w);
  }
  bundles.sort((a, b) => a.block - b.block);

  // Copy traders: launch buyers outside any bundle that bought through the same bot, each in a transaction of its own.
  const viaBot = new Map<string, { wallet: string; block: number }[]>();
  for (const [w, b] of firstBuy) {
    if (!inWindow(b.block) || bundled.has(w) || w === lower(coin.creator)) continue;
    const swap = swapTxs.get(b.tx)!;
    if (swap.senders.size !== 1) continue;
    const bot = [...swap.senders][0]!;
    if (bot === w || protocol.has(bot) || routers.has(bot)) continue;
    // Its own transaction: no other wallet bought in it.
    if ([...(nets.get(b.tx) ?? [])].filter(([x, v]) => v > 0n && x !== w).length) continue;
    const list = viaBot.get(bot); if (list) list.push({ wallet: w, block: b.block }); else viaBot.set(bot, [{ wallet: w, block: b.block }]);
  }
  const copyTraders: CopyGroup[] = [];
  for (const [bot, rows] of viaBot) {
    if (rows.length < o.minWallets) continue;
    rows.sort((a, b) => a.block - b.block);
    const wallets = rows.map(r => r.wallet), set = new Set(wallets);
    let bought = 0n, sold = 0n;
    for (const [tx, net] of nets) if (swapTxs.has(tx)) for (const [w, v] of net) if (set.has(w)) { if (v > 0n) bought += v; else sold -= v; }
    copyTraders.push({ bot, wallets, firstBlock: rows[0]!.block, lastBlock: rows.at(-1)!.block, bought, sold,
      held: wallets.reduce((n, w) => n + ((balance.get(w) ?? 0n) > 0n ? balance.get(w)! : 0n), 0n) });
  }
  copyTraders.sort((a, b) => a.firstBlock - b.firstBlock);
  return { bundles, copyTraders };
}
