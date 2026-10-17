import { decodeEventLog, decodeFunctionData, parseAbi, zeroAddress, type Hex, type TransactionReceipt } from 'viem';
import type { RetainedTrade } from './trades.js';
import { ERC20_ABI, POOL_ABI, ROUTER_ABI, type V3TradeSources } from './v3-routes.js';
import type { UniswapV3Adapter } from './chain.js';

export { ActualFillSchema, PostFillEvidenceSchema, type ActualFill, type PostFillEvidence } from './trade-evidence.js';
import type { ActualFill, PostFillEvidence } from './trade-evidence.js';
export type TradeReceipt = Pick<TransactionReceipt, 'transactionHash' | 'blockHash' | 'blockNumber' | 'status' | 'logs'>;
export interface TradeTransaction { hash: Hex; chainId?: number; from: string; to: string | null; input: Hex; value: bigint; blockHash: Hex | null }

/** Installed only by an accepted host. These methods never take caller-supplied route metadata.
 * Post-fill replay sells the actual bought amount from the retained account at the fill block. */
export interface TradeReconciliationBackend {
  supports(retained: RetainedTrade): boolean;
  receipt(hash: Hex): Promise<TradeReceipt | null>;
  transaction(hash: Hex): Promise<TradeTransaction | null>;
  decodeFill(retained: RetainedTrade, receipt: TradeReceipt): Promise<ActualFill | null>;
  postFillSell(retained: RetainedTrade, receipt: TradeReceipt, fill: ActualFill): Promise<PostFillEvidence>;
}

/** Single-hop indexed v3 only. Pool Swap proves execution; coin Transfer logs measure the
 * account's net token amount, including transfer tax, without converting raw units to Number.
 * Native output is the router's unwrap: a WETH9 Withdrawal from the router, or the router's WETH burn. */
export async function decodeV3Fill(retained: RetainedTrade, receipt: TradeReceipt, sources: V3TradeSources): Promise<ActualFill | null> {
  const q = retained.quote, b = retained.checked?.order.execution;
  if (!b || q.route.venue !== 'uniswap_v3' || !q.route.executable || !q.route.poolId) return null;
  const same = (a: string, c: string) => a.toLowerCase() === c.toLowerCase();
  const pool = (await sources.pools(q.coin, receipt.blockNumber)).find(p => same(p.address, q.route.poolId!));
  if (!pool || ![pool.currency0, pool.currency1].some(c => same(c, q.coin))) return null;
  const coin0 = same(pool.currency0, q.coin), quoteToken = coin0 ? pool.currency1 : pool.currency0;
  let nativeOut = false;
  try {
    const call = decodeFunctionData({ abi: ROUTER_ABI, data: b.tx.data });
    if (call.functionName !== 'multicall') return null;
    const calls = call.args[1].map(data => decodeFunctionData({ abi: ROUTER_ABI, data }));
    const swapCall = calls.find(c => c.functionName === 'exactInputSingle');
    if (!swapCall || calls.filter(c => c.functionName === 'exactInputSingle').length !== 1) return null;
    const terms = swapCall.args[0];
    if (!same(terms.tokenIn, q.side === 'buy' ? quoteToken : q.coin) ||
      !same(terms.tokenOut, q.side === 'buy' ? q.coin : quoteToken) || terms.fee !== pool.fee) return null;
    const unwrap = calls.find(c => c.functionName === 'unwrapWETH9');
    nativeOut = Boolean(unwrap && q.side === 'sell' && same(unwrap.args[1], b.account));
    if (unwrap && !nativeOut) return null;
  } catch { return null; }
  const swaps = [];
  let recipientTransfer = false;
  let received = 0n, spent = 0n, quoteReceived = 0n, quoteSpent = 0n, unwrapped = 0n, burned = 0n;
  const withdrawalAbi = parseAbi(['event Withdrawal(address indexed src, uint256 wad)']);
  for (const log of receipt.logs) {
    if (log.removed || log.transactionHash !== receipt.transactionHash || log.blockHash !== receipt.blockHash) return null;
    try {
      if (same(log.address, pool.address)) {
        const ev = decodeEventLog({ abi: POOL_ABI, data: log.data, topics: log.topics });
        if (ev.eventName === 'Swap') swaps.push(ev.args);
      } else if (same(log.address, q.coin)) {
        const ev = decodeEventLog({ abi: ERC20_ABI, data: log.data, topics: log.topics });
        if (ev.eventName === 'Transfer') {
          if (same(ev.args.to, b.account)) { received += ev.args.value; recipientTransfer = true; }
          if (same(ev.args.from, b.account)) spent += ev.args.value;
        }
      } else if (same(log.address, quoteToken)) {
        try {
          const ev = decodeEventLog({ abi: ERC20_ABI, data: log.data, topics: log.topics });
          if (ev.eventName === 'Transfer') {
            if (same(ev.args.to, b.account)) quoteReceived += ev.args.value;
            if (same(ev.args.from, b.account)) quoteSpent += ev.args.value;
            // Robinhood Chain's WETH emits no WETH9 Withdrawal: an unwrap burns the router's WETH (Transfer to zero).
            if (same(ev.args.from, b.tx.to) && same(ev.args.to, zeroAddress)) burned += ev.args.value;
          }
        } catch {
          const ev = decodeEventLog({ abi: withdrawalAbi, data: log.data, topics: log.topics });
          if (same(ev.args.src, b.tx.to)) unwrapped += ev.args.wad;
        }
      }
    } catch { /* unrelated event; absence of the required event refuses the fill */ }
  }
  if (swaps.length !== 1) return null;
  const swap = swaps[0]!;
  if (!same(swap.sender, b.tx.to)) return null;
  const coinDelta = coin0 ? swap.amount0 : swap.amount1;
  const quoteDelta = coin0 ? swap.amount1 : swap.amount0;
  if (q.side === 'buy') {
    if (coinDelta >= 0n || quoteDelta <= 0n || !recipientTransfer || received < spent || received - spent > -coinDelta) return null;
    if (!same(swap.recipient, b.account)) return null;
    const actualIn = BigInt(b.tx.value) > 0n ? quoteDelta : quoteSpent - quoteReceived;
    if (actualIn < quoteDelta) return null;
    return { filledIn: actualIn.toString(), filledOut: (received - spent).toString() };
  }
  if (coinDelta <= 0n || quoteDelta >= 0n || spent <= received || spent - received < coinDelta) return null;
  if (!same(swap.recipient, nativeOut ? b.tx.to : b.account)) return null;
  // A token that emits both events for one unwrap is counted once, preferring the WETH9 event.
  const actualOut = nativeOut ? (unwrapped > 0n ? unwrapped : burned) : quoteReceived - quoteSpent;
  if (actualOut <= 0n || actualOut > -quoteDelta) return null;
  return { filledIn: (spent - received).toString(), filledOut: actualOut.toString() };
}

/**
 * Wire injected receipt/transaction readers, single-hop v3 fill decoding and post-fill sell
 * replay. No transport or worker starts here; retained executable v3 routes with pool IDs are
 * supported, and injected failures propagate.
 */
export function v3ReconciliationBackend(adapter: Pick<UniswapV3Adapter, 'receipt' | 'transaction'>,
  sources: V3TradeSources, postFillSell: TradeReconciliationBackend['postFillSell']): TradeReconciliationBackend {
  return {
    supports: r => r.quote.route.venue === 'uniswap_v3' && r.quote.route.executable && Boolean(r.quote.route.poolId),
    receipt: hash => adapter.receipt(hash), transaction: hash => adapter.transaction(hash),
    decodeFill: (r, receipt) => decodeV3Fill(r, receipt, sources), postFillSell,
  };
}
