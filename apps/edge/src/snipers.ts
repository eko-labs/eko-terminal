import { getAddress, type Address, type Hex } from 'viem';
import type { EvidenceRef } from '@eko/shared';
import type { CardSources } from '@eko/playbooks';
import type { CoinState } from './tracker.js';

/**
 * Launch-block snipers on Elysium: wallets, other than the deployer, that bought within about a second of a launch.
 * Elysium orders transactions by priority fee, so these buys are a fee auction; the tip each paid is read from its
 * receipt during the probe and attached as evidence. The buyers themselves come from transfers (no RPC).
 */
export const SNIPER_BLOCKS = 10; // ~1 s at Elysium's ~98 ms blocks (measured 2026-11-11)
/** One launch sniper, in the shape the launch_snipers rule reads (thresholds live in the playbooks config). */
export type Sniper = NonNullable<CardSources['snipers']>[number] & { txs: Hex[] };

/** The coin's launch snipers: net buyers in swap transactions in the first SNIPER_BLOCKS blocks, deployer excluded. */
export function findSnipers(coin: CoinState, excluded: Address[], tips: Record<string, number> = {}): Sniper[] {
  const supply = coin.supply > 0n ? coin.supply : 1n;
  const share = (v: bigint) => Number((v * 1_000_000n) / supply) / 1_000_000;
  const skip = new Set([...excluded.map(a => a.toLowerCase()), coin.creator.toLowerCase(), '0x0000000000000000000000000000000000000000']);
  const early = new Set(coin.trades.filter(t => t.side === 'buy' && t.block - coin.block <= SNIPER_BLOCKS).map(t => t.tx.toLowerCase()));
  const balance = new Map<string, bigint>();
  for (const f of coin.flows) { balance.set(f.from, (balance.get(f.from) ?? 0n) - f.value); balance.set(f.to, (balance.get(f.to) ?? 0n) + f.value); }
  const byWallet = new Map<string, { block: number; txs: Set<string>; bought: bigint }>();
  const nets = new Map<string, Map<string, { net: bigint; block: number }>>();
  for (const f of coin.flows) {
    const tx = f.tx.toLowerCase();
    if (!early.has(tx)) continue;
    const m = nets.get(tx) ?? new Map();
    for (const [w, d] of [[f.from, -f.value], [f.to, f.value]] as const) {
      if (skip.has(w)) continue;
      const e = m.get(w) ?? { net: 0n, block: f.block }; e.net += d; m.set(w, e);
    }
    nets.set(tx, m);
  }
  for (const [tx, m] of nets) for (const [w, e] of m) {
    if (e.net <= 0n) continue;
    const s = byWallet.get(w) ?? { block: e.block, txs: new Set(), bought: 0n };
    s.bought += e.net; s.block = Math.min(s.block, e.block); s.txs.add(tx); byWallet.set(w, s);
  }
  return [...byWallet].map(([w, s]) => {
    const txs = [...s.txs] as Hex[];
    const paid = txs.map(t => tips[t]).filter((v): v is number => typeof v === 'number');
    const bal = balance.get(w) ?? 0n;
    const wallet = getAddress(w), tipGwei = paid.length ? Math.max(...paid) : null;
    const evidence: EvidenceRef[] = [{ kind: 'address', ref: wallet, label: 'Launch sniper' },
      ...txs.slice(0, 1).map((tx): EvidenceRef => ({ kind: 'tx', ref: tx, block: s.block, label: tipGwei !== null ? `Sniper buy (priority fee ${tipGwei} gwei)` : 'Sniper buy' }))];
    return { wallet, block: s.block, txs, boughtShare: share(s.bought), heldShare: share(bal > 0n ? bal : 0n), tipGwei, evidence };
  }).sort((a, b) => b.boughtShare - a.boughtShare);
}
