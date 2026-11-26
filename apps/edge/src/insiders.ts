import type { Address, Hex } from 'viem';
import { launchGroups } from './bundles.js';
import { tradeWallets } from './flow-stats.js';
import { findSnipers } from './snipers.js';
import type { Trade } from './market.js';
import type { CoinState } from './tracker.js';

/**
 * Who counts as a coin's insider, and what an insider sold, for any part of the edge that asks. Pure: the history
 * store's traced funders come in as a function. Built on the edge's core modules only (tracker trades and transfers,
 * snipers.ts, flow-stats.ts).
 *
 * - dev: the deployer.
 * - linked: a wallet whose traced first funding came from the deployer, or from the deployer's own funder (neither a
 *   hub: a funder that paid HUB_FUNDEES or more traced wallets ties no one together).
 * - sniper: a net buyer in the chain's launch window (snipers.ts; the deployer is never one).
 * - bundle: a wallet in a bundle the coin's own transfers show (bundles.ts: one transaction bought for several wallets,
 *   or tokens passed between them, reaching a launch buyer), or an early buyer (bundle_dump's first blocks) whose traced
 *   funder (not a hub) paid enough of the early buyers within bundle_dump's funding window. Buying in the same block is
 *   not enough: copy traders and snipers all buy in the same few blocks of a 0.1 s chain.
 *
 * A sell is the seller's net loss of the coin inside one swap transaction (flow-stats.ts names the seller), measured
 * against what the wallet held right before it.
 */
export type InsiderRole = 'dev' | 'linked' | 'bundle' | 'sniper';
/** A wallet's main role, in this order: the one an alert names. */
export const ROLE_ORDER: readonly InsiderRole[] = ['dev', 'linked', 'bundle', 'sniper'];

/** A wallet's traced first funding: undefined when never traced; `hub` when that funder paid many traced wallets. */
export type FundingLookup = (wallet: string) => { funder: string | null; fundedTs: number | null; hub: boolean } | undefined;

export interface InsiderOptions {
  /** Addresses that are the protocol, not traders (ChainAdapter.excluded). */
  excluded: readonly Address[];
  /** The chain's launch-sniper window in blocks (ChainProfile.sniperBlocks). */
  sniperBlocks: number;
  /** bundle_dump's config (the chain's playbooks). */
  bundle: { firstBlocks: number; fundingWindowH: number; minWallets: number };
  funding?: FundingLookup;
}

/** Early buyers looked up for a shared funder (the launch window rarely has more). */
export const FUNDING_LOOKUPS = 400;

/** The roles fixed by the launch window (sniper, bundle) plus the deployer; `linked` is asked per wallet (linkedToDev). */
export function launchInsiders(coin: CoinState, o: InsiderOptions): Map<string, Set<InsiderRole>> {
  const creator = coin.creator.toLowerCase(), roles = new Map<string, Set<InsiderRole>>();
  const add = (w: string, r: InsiderRole) => { const k = w.toLowerCase(); roles.set(k, (roles.get(k) ?? new Set()).add(r)); };
  add(creator, 'dev');
  for (const s of findSnipers(coin, [...o.excluded], {}, o.sniperBlocks)) add(s.wallet, 'sniper');

  // The first blocks' buyers, each with its first buy there.
  const window = (block: number) => block >= coin.block && block - coin.block < o.bundle.firstBlocks;
  const early = coin.trades.filter(t => t.side === 'buy' && window(t.block));
  const walletOf = tradeWallets(coin, new Set(early.map(t => t.tx.toLowerCase())), o.excluded);
  const firstBuy = new Map<string, Trade>();
  for (const t of [...early].sort((a, b) => a.block - b.block || a.ts - b.ts)) {
    const w = walletOf.get(t.tx.toLowerCase())?.buy;
    if (w && !firstBuy.has(w)) firstBuy.set(w, t);
  }
  for (const b of launchGroups(coin, { excluded: o.excluded, firstBlocks: o.bundle.firstBlocks, minWallets: o.bundle.minWallets }).bundles)
    for (const w of b.wallets) if (w !== creator) add(w, 'bundle');

  if (o.funding) {
    const groups = new Map<string, string[]>();
    for (const [w, buy] of [...firstBuy].slice(0, FUNDING_LOOKUPS)) {
      const f = o.funding(w), funder = f?.funder?.toLowerCase();
      if (!f || !funder || f.hub || f.fundedTs === null || f.fundedTs > buy.ts || buy.ts - f.fundedTs > o.bundle.fundingWindowH * 3600) continue;
      groups.set(funder, [...(groups.get(funder) ?? []), w]);
    }
    for (const wallets of groups.values()) if (wallets.length >= o.bundle.minWallets) for (const w of wallets) if (w !== creator) add(w, 'bundle');
  }
  return roles;
}

/** Funded by the deployer, or by the deployer's own funder; hubs tie no one. False when either is untraced. */
export function linkedToDev(coin: Pick<CoinState, 'creator'>, wallet: string, funding?: FundingLookup): boolean {
  if (!funding) return false;
  const creator = coin.creator.toLowerCase(), w = wallet.toLowerCase();
  if (w === creator) return false;
  const f = funding(w), funder = f?.funder?.toLowerCase();
  if (!funder || f!.hub) return false;
  if (funder === creator) return true;
  const d = funding(creator), devFunder = d?.funder?.toLowerCase();
  return !!devFunder && !d!.hub && devFunder === funder;
}

/** One insider's sell in one transaction. Shares are of total supply; `ofPosition` of what it held right before. */
export interface InsiderSell {
  wallet: string; roles: InsiderRole[]; tx: Hex; block: number; ts: number;
  /** Tokens sold (base units) and the wallet's balance right before the sell and now. */
  sold: bigint; before: bigint; now: bigint;
  soldShare: number; ofPosition: number; heldShare: number;
  /** Native currency the sell took out (ETH on Robinhood Chain, HYPE on Elysium). */
  native: number;
}

/** The main role: the first in ROLE_ORDER. */
export const mainRole = (roles: readonly InsiderRole[]): InsiderRole => ROLE_ORDER.find(r => roles.includes(r)) ?? 'sniper';

/**
 * The insiders' sells among `trades` (new trades of the coin, or all of them). `roles(wallet)` names a seller's roles
 * (empty: not an insider). Oldest first.
 */
export function insiderSells(coin: CoinState, trades: readonly Trade[], excluded: readonly Address[], roles: (wallet: string) => InsiderRole[]): InsiderSell[] {
  const sells = trades.filter(t => t.side === 'sell');
  if (!sells.length) return [];
  const txs = new Set(sells.map(t => t.tx.toLowerCase())), sellers = tradeWallets(coin, txs, excluded);
  // One row per (transaction, seller): a transaction can hold several swaps.
  const wanted = new Map<string, { wallet: string; roles: InsiderRole[]; tx: Hex; block: number; ts: number; native: number }>();
  for (const t of sells) {
    const tx = t.tx.toLowerCase(), wallet = sellers.get(tx)?.sell;
    if (!wallet) continue;
    const key = `${tx}:${wallet}`, hit = wanted.get(key);
    if (hit) { hit.native += t.hype; continue; }
    const r = roles(wallet);
    if (r.length) wanted.set(key, { wallet, roles: r, tx: t.tx, block: t.block, ts: t.ts, native: t.hype });
  }
  if (!wanted.size) return [];

  // Balances of the sellers through the transfers in chain order: before each sell, the sell itself, and now.
  const who = new Set([...wanted.values()].map(w => w.wallet)), bal = new Map<string, bigint>();
  const before = new Map<string, bigint>(), net = new Map<string, bigint>();
  for (const f of coin.flows) {
    const tx = f.tx.toLowerCase();
    for (const [w, d] of [[f.from, -f.value], [f.to, f.value]] as const) {
      if (!who.has(w)) continue;
      const key = `${tx}:${w}`;
      if (wanted.has(key)) { if (!before.has(key)) before.set(key, bal.get(w) ?? 0n); net.set(key, (net.get(key) ?? 0n) + d); }
      bal.set(w, (bal.get(w) ?? 0n) + d);
    }
  }
  const supply = coin.supply > 0n ? coin.supply : 1n;
  const share = (v: bigint) => Number((v * 1_000_000n) / supply) / 1_000_000;
  const out: InsiderSell[] = [];
  for (const [key, s] of wanted) {
    const n = net.get(key) ?? 0n;
    if (n >= 0n) continue;
    const sold = -n, prior = before.get(key) ?? 0n, now = bal.get(s.wallet) ?? 0n;
    out.push({ ...s, wallet: s.wallet, sold, before: prior, now: now > 0n ? now : 0n, soldShare: share(sold),
      ofPosition: prior > sold ? Number((sold * 10_000n) / prior) / 10_000 : 1, heldShare: share(now > 0n ? now : 0n) });
  }
  return out.sort((a, b) => a.block - b.block || a.ts - b.ts);
}

/** A wallet's balance of the coin now, from its transfers (for "is it in this account's bag"). */
export function balancesOf(coin: Pick<CoinState, 'flows'>, wallets: ReadonlySet<string>): Map<string, bigint> {
  const bal = new Map<string, bigint>();
  for (const f of coin.flows) {
    if (wallets.has(f.from)) bal.set(f.from, (bal.get(f.from) ?? 0n) - f.value);
    if (wallets.has(f.to)) bal.set(f.to, (bal.get(f.to) ?? 0n) + f.value);
  }
  return bal;
}
