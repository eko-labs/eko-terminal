import { binary, type ChainDb } from '@eko/db';
import { loadRegistry, ponsCurveAbi, v3Abi, erc20Abi } from '@eko/chain';
import { encodeAbiParameters, encodeEventTopics, toHex, type AbiEvent, type Address, type Hex } from 'viem';
import { lower } from '../src/clients.js';
import type { ChainClient, RpcBlock, RpcLog, RpcReceipt } from '../src/types.js';

/**
 * A production-shaped catch-up range: about one block in eight carries no indexed log (its successor needs a parent
 * header), one in seven holds a Pons curve trade (receipts for senders), the rest swap on tracked v3 pools with token
 * transfers, and every non-empty block also moves an untracked token (a candidate log that is not kept).
 */
export const registry = loadRegistry();
const address = (n: number): Address => toHex(n, { size: 20 });
const hash = (n: number, branch = 0): Hex => toHex(n + branch * 1_000_000, { size: 32 });
export const COINS = 12, POOLS = 24;
export const coin = (i: number) => address(1000 + i), curve = (i: number) => address(2000 + i), pool = (i: number) => address(3000 + i), other = (i: number) => address(4000 + i);
const stray = (i: number) => address(5000 + i), router = (i: number) => address(600 + i), actor = (n: number) => address(10_000 + n % 2500);
const buy = ponsCurveAbi.find((e): e is AbiEvent => e.type === 'event' && e.name === 'CurveBuy')!;
export type Chain = Map<bigint, { block: RpcBlock; receipts: RpcReceipt[] }>;
function event(e: AbiEvent, emitter: Address, args: Record<string, unknown>, block: RpcBlock, tx: Hex, index: number): RpcLog {
  return { address: emitter, topics: encodeEventTopics({ abi: [e], args }) as [Hex, ...Hex[]], data: encodeAbiParameters(e.inputs.filter(p => !p.indexed), e.inputs.filter(p => !p.indexed).map(p => args[p.name!])), blockNumber: block.number, blockHash: block.hash, blockTimestamp: block.timestamp, transactionHash: tx, logIndex: toHex(index) };
}
/** Block `n` of one branch: branch > 0 gives the same contents different hashes; `parentBranch` links it to another branch. */
export function blockOf(n: number, branch = 0, parentBranch = branch): { block: RpcBlock; receipts: RpcReceipt[] } {
  const block: RpcBlock = { number: toHex(n), hash: hash(n, branch), parentHash: hash(Math.max(0, n - 1), parentBranch), timestamp: toHex(1790812800 + Math.floor(n / 10)), transactions: [] };
  const receipts: RpcReceipt[] = [];
  if (n === 0 || n % 8 === 0) return { block, receipts };
  const txs = 1 + n % 3;
  for (let t = 0; t < txs; t++) {
    const tx = hash(5_000_000 + n * 10 + t, branch), from = actor(n * 7 + t), to = router((n + t) % 8);
    block.transactions.push({ hash: tx, from, to, type: '0x2' });
    const logs: RpcLog[] = []; let i = t * 10;
    if (t === 0 && n % 7 === 1) {
      const c = n % COINS;
      logs.push(event(buy, curve(c), { buyer: from, recipient: from, quoteIn: 10n ** 16n * BigInt(1 + n % 5), tokensOut: 10n ** 20n, fee: 0n, tax: 0n }, block, tx, i++));
      logs.push(event(erc20Abi[0], coin(c), { from: curve(c), to: from, value: 10n ** 20n }, block, tx, i++));
    } else {
      const p = (n + t) % POOLS, amount = BigInt(1 + n % 97) * 10n ** 15n;
      logs.push(event(erc20Abi[0], other(p), { from: pool(p), to: from, value: amount * 1000n }, block, tx, i++));
      logs.push(event(erc20Abi[0], registry.requireAddress('tokens.WETH'), { from, to: pool(p), value: amount }, block, tx, i++));
      logs.push(event(v3Abi[1], pool(p), { sender: from, recipient: from, amount0: -amount * 1000n, amount1: amount, sqrtPriceX96: 2n ** 96n, liquidity: 1000n, tick: 0 }, block, tx, i++));
    }
    if (t === txs - 1) logs.push(event(erc20Abi[0], stray(n % 5), { from, to: to, value: 1n }, block, tx, i++));
    receipts.push({ transactionHash: tx, blockHash: block.hash, blockNumber: block.number, from, to, type: '0x2', logs });
  }
  return { block, receipts };
}
export function catchUpChain(blocks: number): Chain {
  return new Map(Array.from({ length: blocks + 1 }, (_, n) => [BigInt(n), blockOf(n)] as const));
}
/** Logs as a provider answers eth_getLogs: the public lane leaves blockTimestamp zero, the paid lane fills it. */
export function logsOf(chain: Chain, from: bigint, to: bigint, topics: readonly Hex[], addresses?: readonly Address[], timestamps = true): RpcLog[] {
  const logs: RpcLog[] = [];
  for (let n = from; n <= to; n++) for (const r of chain.get(n)?.receipts ?? []) for (const l of r.logs)
    if (topics.includes(l.topics[0]) && (!addresses || addresses.some(a => lower(a) === lower(l.address)))) logs.push(timestamps ? l : { ...l, blockTimestamp: '0x0' });
  return logs;
}
/** Tracked tokens and pools as an indexer that already knows these coins and pools would hold them. */
export async function seedCatchUp(db: ChainDb) {
  const weth = registry.requireAddress('tokens.WETH'), usdg = registry.requireAddress('tokens.USDG');
  await db.insert('tokens', { address: binary(weth), decimals: 18, symbol: 'WETH', name: 'WETH', first_block: '0', block: '0' });
  await db.insert('tokens', { address: binary(usdg), decimals: 6, symbol: 'USDG', name: 'USDG', first_block: '0', block: '0' });
  for (let i = 0; i < COINS; i++) await db.insert('tokens', { address: binary(coin(i)), curve: binary(curve(i)), decimals: 18, symbol: '<sample>', name: '<sample>', launchpad: 'pons', first_block: '0', block: '0' });
  for (let i = 0; i < POOLS; i++) {
    await db.insert('tokens', { address: binary(other(i)), decimals: 18, symbol: '<sample>', name: '<sample>', first_block: '0', block: '0' });
    await db.insert('pools', { id: binary(pool(i)), venue: 'uniswap_v3', currency0: binary(other(i)), currency1: binary(weth), fee: 3000, tick_spacing: 60, creation_verified: true, created_block: '0', block: '0' });
  }
  // The selected ETH/USD reference pool with one earlier canonical swap, as on a live database.
  const ts = new Date(1790812800 * 1000);
  await db.insert('pools', { id: binary(reference), venue: 'uniswap_v3', currency0: binary(weth), currency1: binary(usdg), fee: 3000, tick_spacing: 60, creation_verified: true, created_block: '0', block: '0' });
  await db.ensurePartitions(ts);
  await db.insert('swaps', { ts, block: '0', tx_hash: binary(hash(9000)), log_index: 0, venue: 'uniswap_v3', pool_id: binary(reference), coin: binary(weth), quote_asset: binary(usdg), trader: binary(actor(1)), tx_from: binary(actor(1)), tx_to: binary(router(0)), side: 1, amount_coin: '1', amount_quote: '2000', price_quote: 2000 });
}
const reference = address(110);
/** A provider-free client over `chain`, with the public/paid timestamp split of production logs. */
export function memoryClient(chain: Chain, head: () => bigint): ChainClient & { calls: Record<string, number> } {
  const calls: Record<string, number> = {};
  const count = (name: string) => { calls[name] = (calls[name] ?? 0) + 1; };
  const get = (n: bigint) => { const b = chain.get(n); if (!b) throw new Error('Block absent from fixture'); return b; };
  return { calls, chainId: async () => 4663, head: async () => { count('head'); return head(); },
    block: async n => get(n).block, header: async n => { count('header'); return get(n).block; },
    parentHeader: async n => { count('parentHeader'); return get(n).block; }, timestampHeader: async n => { count('timestampHeader'); return get(n).block; },
    receipts: async n => { count('receipts'); return get(n).receipts; },
    logs: async ({ from, to, addresses, topics }) => { count('logs'); return logsOf(chain, from, to, topics, addresses, false); },
    timestampLogs: async ({ from, to, topics }) => { count('timestampLogs'); return logsOf(chain, from, to, topics); },
    code: async () => '0x', tokenMetadata: async () => ({ symbol: '<sample>', name: '<sample>', decimals: 18 }), v3Pool: async () => null,
    ethUsdRate: async n => ({ value: 2000, block: n, source: { address: reference, venue: 'uniswap_v3' as const, fee: 3000 } }) };
}
