import { erc20Abi } from '@eko/chain';
import { toEventSelector, type Address } from 'viem';
import { lower, native } from './clients.js';
import type { RpcLog } from './types.js';

const transferTopic = toEventSelector(erc20Abi[0]);
const DEAD = '0x000000000000000000000000000000000000dead';
const word = (topic: string) => `0x${topic.slice(-40)}`.toLowerCase();
interface Moved { net: bigint; gin: bigint; gout: bigint; fromPool: boolean; toPool: boolean }

/**
 * The wallets whose balance of `token` changed in one transaction, from its Transfer logs: net change, gross in and
 * out, and whether the wallet dealt with `pool` or the pool manager directly. Pools, the pool manager and the mint and
 * burn addresses are left out. `moved` says whether the token moved at all.
 */
function movements(logs: readonly RpcLog[], tx: string, token: string, pool: string, poolManager: string, isPool: (address: string) => boolean) {
  const by = new Map<string, Moved>();
  let moved = false;
  const direct = (address: string) => address === pool || address === poolManager;
  const entry = (address: string) => { let m = by.get(address); if (!m) { m = { net: 0n, gin: 0n, gout: 0n, fromPool: false, toPool: false }; by.set(address, m); } return m; };
  const skipped = (address: string) => address === native || address === DEAD || address === poolManager || address === pool || isPool(address);
  for (const l of logs) {
    // An ERC-721 Transfer has the same topic and four topics; only fungible transfers of the token count.
    if (l.topics[0] !== transferTopic || l.topics.length !== 3 || lower(l.address) !== token || lower(l.transactionHash) !== tx) continue;
    let amount: bigint;
    try { amount = BigInt(l.data); } catch { continue; }
    moved = true;
    const from = word(l.topics[1]), to = word(l.topics[2]);
    if (!skipped(to)) { const m = entry(to); m.net += amount; m.gin += amount; if (direct(from)) m.fromPool = true; }
    if (!skipped(from)) { const m = entry(from); m.net -= amount; m.gout += amount; if (direct(to)) m.toPool = true; }
  }
  return { by, moved };
}
const largest = (candidates: [string, bigint][]) => candidates.sort((a, b) => a[1] === b[1] ? (a[0] < b[0] ? -1 : 1) : a[1] > b[1] ? -1 : 1)[0]?.[0] as Address | undefined;

/**
 * The wallet behind a swap in a pool whose transaction sender the indexer does not read (every pool outside the Pons
 * sender scope: reading a block's receipts for each would cost about 485,000 requests a day on 2026-10-13). The buyer
 * is the wallet whose balance of the coin rose most in the transaction, the seller the one whose balance fell most; a
 * router that only passes coins on nets to zero. When no balance moved that way (a wallet that bought and sold in one
 * transaction) it is the wallet that took the coins from the pool or sent them to it, then any wallet that received
 * or sent them. `moved` is false when the coin did not move at all (one hop of a route inside the v4 pool manager):
 * nobody took delivery. The worker's backfill applies the same rule in SQL (apps/server/src/coin-onboarding.ts).
 */
export function swapWallet(logs: readonly RpcLog[], tx: string, coin: string, pool: string, poolManager: string, side: 1 | -1, isPool: (address: string) => boolean): { wallet: Address | null; moved: boolean } {
  const { by, moved } = movements(logs, lower(tx), lower(coin), lower(pool), lower(poolManager), isPool);
  const all = [...by];
  const wallet = largest(all.filter(([, m]) => side === 1 ? m.net > 0n : m.net < 0n).map(([a, m]) => [a, m.net < 0n ? -m.net : m.net]))
    ?? largest(all.filter(([, m]) => side === 1 ? m.fromPool : m.toPool).map(([a, m]) => [a, side === 1 ? m.gin : m.gout]))
    ?? largest(all.filter(([, m]) => side === 1 ? m.gin > 0n : m.gout > 0n).map(([a, m]) => [a, side === 1 ? m.gin : m.gout]));
  return { wallet: wallet ?? null, moved };
}

/**
 * The wallet behind a liquidity event in such a pool: whoever's balance of the pool's coins (its tokens other than the
 * reference assets) fell most in the transaction added the liquidity, whoever's rose most took it out. Null when no
 * balance moved that way; the caller keeps the owner or sender the event names.
 */
export function liquidityWallet(logs: readonly RpcLog[], tx: string, tokens: readonly string[], pool: string, poolManager: string, way: 1 | -1, isPool: (address: string) => boolean): Address | null {
  const net = new Map<string, bigint>();
  for (const token of tokens) for (const [address, m] of movements(logs, lower(tx), lower(token), lower(pool), lower(poolManager), isPool).by) net.set(address, (net.get(address) ?? 0n) + m.net);
  return largest([...net].filter(([, n]) => way === 1 ? n > 0n : n < 0n).map(([a, n]) => [a, n < 0n ? -n : n])) ?? null;
}
