import type { Address } from 'viem';
import { flowStats } from './holders.js';
import { findSnipers } from './snipers.js';
import type { CoinState } from './tracker.js';
import type { Horizon, Outcome } from './history.js';

/**
 * What became of a launch, and what it looked like early, from its trades and transfers alone (pure). The labels match
 * EKO's Robinhood Chain outcomes, adapted to Elysium, where launch liquidity is locked so it cannot be pulled:
 * - honeypot: a buy-then-sell check could not sell;
 * - rugged: the price fell 90% or more from its peak while insiders sold (the run was unloaded on buyers);
 * - dumped: insiders sold more than half of what they bought or held, and at least 1% of supply, within the first hour;
 * - survived: none of these.
 * Insiders are the deployer and the first minute's buyers it is tied to: paid by the deployer, or by the deployer's own
 * funder (when traced). The first minute's other buyers are mostly bots that flip within minutes on Elysium: counting them
 * labelled 98% of traded launches "dumped" (2026-11-11), which says nothing about the deployer.
 * Each outcome also records the price move from each feature point (5 minutes, 1 hour) to the horizon: whether a buyer at
 * that point had lost half by then. That is what the thresholds are refit on (launches here run and die within an hour).
 * A coin with no trade beyond its launch transaction has no outcome (nothing happened to label).
 */
export const HORIZON_SEC: Record<Horizon, number> = { '1h': 3600, '24h': 86_400 };
export const FEATURE_POINTS = [300, 3600] as const;
/** dumpMinShare: as in EKO's dev_dump rule, a dump must be at least 1% of supply (selling a crumb is not one). */
export const OUTCOME_CONFIG = { rugDrop: 0.9, dumpSold: 0.5, dumpMinShare: 0.01, cohortSec: 60 } as const;

/** The coin as it stood `sec` seconds after launch. */
export function coinAt(coin: CoinState, sec: number): CoinState {
  const end = coin.ts + sec;
  return { ...coin, trades: coin.trades.filter(t => t.ts <= end), flows: coin.flows.filter(f => f.ts <= end) };
}

/** A wallet's traced funder (not a hub), when known. */
export type Funders = (wallet: string) => { funder: Address | null } | undefined;

/**
 * Supply bought and still held by a set of the first minute's buyers plus the deployer. `linked` picks which early
 * buyers count: all of them (the cohort, a feature) or only the deployer's (insiders, for outcomes).
 */
function group(coin: CoinState, excluded: Address[], linked: (wallet: string) => boolean) {
  const s = flowStats(coin, { excluded, hypeUsd: null, cohortSec: OUTCOME_CONFIG.cohortSec });
  const creator = coin.creator.toLowerCase();
  const members = s.earlyBuyers.filter(b => b.wallet.toLowerCase() !== creator && linked(b.wallet.toLowerCase()));
  // The deployer's stake is what it holds or bought, whichever is larger (Montra mints to the pool, not the deployer).
  const dev = s.earlyBuyers.find(b => b.wallet.toLowerCase() === creator);
  const bought = members.reduce((n, b) => n + (b.boughtShare ?? 0), 0) + Math.max(dev?.boughtShare ?? 0, s.dev.heldShare + s.dev.soldShare);
  const held = members.reduce((n, b) => n + b.heldShare, 0) + s.dev.heldShare;
  return { stats: s, bought, held, wallets: members.length + 1 };
}
const cohort = (coin: CoinState, excluded: Address[]) => group(coin, excluded, () => true);
function insiders(coin: CoinState, excluded: Address[], funders?: Funders) {
  const creator = coin.creator.toLowerCase(), creatorFunder = funders?.(creator)?.funder?.toLowerCase() ?? null;
  return group(coin, excluded, (w) => {
    const f = funders?.(w)?.funder?.toLowerCase();
    return !!f && (f === creator || (creatorFunder !== null && f === creatorFunder));
  });
}

/** Measured features `sec` after launch (for calibration and the history page). */
export function featuresAt(coin: CoinState, sec: number, excluded: Address[], tips: Record<string, number> = {}): Record<string, number | null> {
  const c = coinAt(coin, sec), i = cohort(c, excluded), s = i.stats;
  const snipers = findSnipers(c, excluded, tips);
  const prices = c.trades.map(t => t.priceHype).filter(p => p > 0);
  const first = prices[0] ?? null, peak = prices.length ? Math.max(...prices) : null, last = prices.at(-1) ?? null;
  const round = (v: number | null, d = 1e4) => v === null ? null : Math.round(v * d) / d;
  return {
    trades: c.trades.length, buyers: s.buyers, holders: s.holderCount,
    top10: round(s.holders.top10Share), largest: round(s.holders.largestShare), transferred: round(s.holders.transferredShare),
    devHeld: round(s.dev.heldShare), devSold: round(s.dev.soldShare), devFirstSellSec: s.dev.firstSellSec,
    cohortWallets: s.earlyBuyers.length, cohortBought: round(i.bought), cohortHeld: round(i.held),
    snipers: snipers.length, snipersBought: round(snipers.reduce((n, x) => n + x.boughtShare, 0)), snipersHeld: round(snipers.reduce((n, x) => n + x.heldShare, 0)),
    sniperTipGwei: snipers.some(x => x.tipGwei !== null) ? Math.max(...snipers.map(x => x.tipGwei ?? 0)) : null,
    netHype: round(c.trades.reduce((n, t) => n + (t.side === 'buy' ? t.hype : -t.hype), 0), 1e3),
    peakMultiple: first && peak ? round(peak / first, 100) : null, lastMultiple: first && last ? round(last / first, 100) : null,
  };
}

/** The coin's outcome at `horizon`, or null when it never traded beyond its launch transaction. */
export function outcomeAt(coin: CoinState, horizon: Horizon, excluded: Address[], honeypot: boolean, funders?: Funders): { outcome: Outcome; detail: Record<string, number | string | null> } | null {
  const c = coinAt(coin, HORIZON_SEC[horizon]);
  const traded = c.trades.some(t => t.tx.toLowerCase() !== coin.tx.toLowerCase());
  if (!traded && !honeypot) return null;
  const prices = c.trades.map(t => t.priceHype).filter(p => p > 0);
  const first = prices[0] ?? null, peak = prices.length ? Math.max(...prices) : null, last = prices.at(-1) ?? null;
  const drop = peak && last ? 1 - last / peak : null;
  // Insiders' selling is judged on the first hour, as on Robinhood Chain.
  const early = insiders(coinAt(coin, 3600), excluded, funders), late = insiders(c, excluded, funders);
  const soldFirstHour = early.bought > 0 ? Math.max(0, early.bought - early.held) / early.bought : 0;
  const insiderSold = late.bought > late.held + 1e-6;
  const soldShareFirstHour = Math.max(0, early.bought - early.held);
  const outcome: Outcome = honeypot ? 'honeypot' : drop !== null && drop >= OUTCOME_CONFIG.rugDrop && insiderSold ? 'rugged'
    : soldFirstHour > OUTCOME_CONFIG.dumpSold && soldShareFirstHour >= OUTCOME_CONFIG.dumpMinShare ? 'dumped' : 'survived';
  const r = (v: number | null) => v === null ? null : Math.round(v * 1e4) / 1e4;
  // The price move a buyer at each feature point would have seen by this horizon: changeFrom300 (5 minutes in) and
  // changeFrom3600 (an hour in), and whether it halved. Null when the point is not before the horizon or nothing had
  // traded by then. changeFromHour/halvedFromHour repeat the hour figures (the names stored first).
  const changes: Record<string, number | null> = {};
  for (const at of FEATURE_POINTS) {
    const p = at < HORIZON_SEC[horizon] ? coinAt(coin, at).trades.map(t => t.priceHype).filter(x => x > 0).at(-1) ?? null : null;
    const ch = p && last ? last / p - 1 : null;
    changes[`changeFrom${at}`] = r(ch); changes[`halvedFrom${at}`] = ch === null ? null : ch <= -0.5 ? 1 : 0;
  }
  return { outcome, detail: { trades: c.trades.length, buyers: late.stats.buyers, peakMultiple: first && peak ? r(peak / first) : null, dropFromPeak: r(drop),
    insiderWallets: late.wallets, insidersBought: r(early.bought), insidersSoldFirstHour: r(soldFirstHour), insidersSoldShare: r(soldShareFirstHour), insidersHeld: r(late.held), ...changes,
    changeFromHour: changes.changeFrom3600 ?? null, halvedFromHour: changes.halvedFrom3600 ?? null } };
}
