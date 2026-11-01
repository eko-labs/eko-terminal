import { getAddress, type Address } from 'viem';
import type { CardSources } from '@eko/playbooks';
import type { CoinState } from './tracker.js';

/**
 * Holder, early-buyer and deployer figures for one coin, from its transfers and its pool's swaps. Pure.
 *
 * A wallet's net change of the coin inside a transaction that swapped in the coin's pool is a buy (positive) or a sell
 * (negative): routers that pass tokens through net to zero and drop out. Anything else is a transfer. Shares are of
 * total supply. Pool, hook, zero and burn addresses are not holders.
 */
export interface FlowStats {
  holders: NonNullable<CardSources['holders']>;
  earlyBuyers: NonNullable<CardSources['earlyBuyers']>;
  dev: NonNullable<CardSources['dev']>;
  /** Wallets with at least one buy. */
  buyers: number;
  /** Supply share held by wallets that never bought (top ten and overall are both in `holders`). */
  holderCount: number;
}

const DEAD = ['0x0000000000000000000000000000000000000000', '0x000000000000000000000000000000000000dead', '0x0000000000000000000000000000000000000001'];

/** A wallet's traced funder (not a hub), when known. */
export type FunderLookup = (wallet: string) => { funder: Address | null; fundedTs: number | null } | undefined;

export function flowStats(coin: CoinState, opts: { excluded: Address[]; hypeUsd: number | null; cohortSec?: number; funders?: FunderLookup }): FlowStats {
  const supply = coin.supply > 0n ? coin.supply : 1n;
  const share = (v: bigint) => Number((v * 1_000_000n) / supply) / 1_000_000;
  const excluded = new Set([...DEAD, ...opts.excluded.map(a => a.toLowerCase())]);
  const creator = coin.creator.toLowerCase();

  // Balances from every transfer since the mint.
  const balance = new Map<string, bigint>();
  const add = (k: string, v: bigint) => balance.set(k, (balance.get(k) ?? 0n) + v);
  for (const f of coin.flows) { add(f.from, -f.value); add(f.to, f.value); }

  // Net change per wallet per swap transaction, and the HYPE each swap transaction moved.
  const swapTx = new Map<string, { hypeIn: number; hypeOut: number; ts: number; block: number }>();
  for (const t of coin.trades) {
    const k = t.tx.toLowerCase(), e = swapTx.get(k) ?? { hypeIn: 0, hypeOut: 0, ts: t.ts, block: t.block };
    if (t.side === 'buy') e.hypeIn += t.hype; else e.hypeOut += t.hype;
    swapTx.set(k, e);
  }
  const perTx = new Map<string, Map<string, bigint>>();
  for (const f of coin.flows) {
    const k = f.tx.toLowerCase();
    if (!swapTx.has(k)) continue;
    const m = perTx.get(k) ?? new Map<string, bigint>();
    if (!excluded.has(f.from)) m.set(f.from, (m.get(f.from) ?? 0n) - f.value);
    if (!excluded.has(f.to)) m.set(f.to, (m.get(f.to) ?? 0n) + f.value);
    perTx.set(k, m);
  }
  const bought = new Map<string, bigint>(), sold = new Map<string, bigint>();
  const cohortSec = opts.cohortSec ?? 60, early = new Map<string, { bought: bigint; ts: number; block: number }>();
  const dev = { cashInHype: 0, cashOutHype: 0, sold: 0n, firstSellTs: null as number | null };
  for (const [tx, nets] of perTx) {
    const s = swapTx.get(tx)!;
    for (const [wallet, net] of nets) {
      if (net > 0n) {
        bought.set(wallet, (bought.get(wallet) ?? 0n) + net);
        if (s.ts - coin.ts < cohortSec) { const e = early.get(wallet) ?? { bought: 0n, ts: s.ts, block: s.block }; e.bought += net; early.set(wallet, e); }
        if (wallet === creator) dev.cashInHype += s.hypeIn;
      } else if (net < 0n) {
        sold.set(wallet, (sold.get(wallet) ?? 0n) - net);
        if (wallet === creator) { dev.cashOutHype += s.hypeOut; dev.sold -= net; dev.firstSellTs = Math.min(dev.firstSellTs ?? s.ts, s.ts); }
      }
    }
  }

  const holdersRanked = [...balance].filter(([k, v]) => v > 0n && !excluded.has(k)).sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0));
  const top10 = holdersRanked.slice(0, 10);
  const largestOther = holdersRanked.find(([k]) => k !== creator);
  const neverBought = top10.filter(([k]) => !bought.has(k) && k !== creator);
  const usd = (hype: number) => (opts.hypeUsd ? hype * opts.hypeUsd : 0);
  const evidence = (wallet: string, label: string) => [{ kind: 'address' as const, ref: getAddress(wallet), label }];

  return {
    holders: {
      top10Share: share(top10.reduce((n, [, v]) => n + v, 0n)),
      largestShare: largestOther ? share(largestOther[1]) : 0,
      largest: largestOther ? getAddress(largestOther[0]) : null,
      transferredShare: share(neverBought.reduce((n, [, v]) => n + v, 0n)),
      transferredWallets: neverBought.length,
      evidence: top10.slice(0, 5).flatMap(([k]) => evidence(k, k === creator ? 'Deployer (top holder)' : 'Top holder')),
    },
    earlyBuyers: [...early].map(([wallet, e]) => {
      // A wallet whose funder is not traced yet (or was paid by a hub) is its own funder: it joins no bundle.
      const f = opts.funders?.(wallet), funder = f?.funder ?? null;
      return {
      wallet: getAddress(wallet),
      funder: getAddress(funder ?? wallet), fundedAtSec: funder && f?.fundedTs != null ? f.fundedTs : e.ts, buyAtSec: e.ts, buyBlock: e.block,
      heldShare: share(balance.get(wallet) ?? 0n), boughtShare: share(e.bought), sellingIntoNetInflow: false,
      deployer: wallet === creator, evidence: evidence(wallet, wallet === creator ? 'Deployer early buy' : 'Early buyer'),
    }; }),
    dev: {
      heldShare: share(balance.get(creator) ?? 0n), cashInUsd: usd(dev.cashInHype), cashOutUsd: usd(dev.cashOutHype), soldShare: share(dev.sold),
      firstSellSec: dev.firstSellTs === null ? null : Math.max(0, dev.firstSellTs - coin.ts), evidence: evidence(creator, 'Deployer'),
    },
    buyers: bought.size,
    holderCount: holdersRanked.length,
  };
}
