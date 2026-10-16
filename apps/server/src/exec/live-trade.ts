import { withRpcOrigin } from '@eko/chain';
import { decodeFunctionData, encodeFunctionData, keccak256, padHex, parseAbi, stringToHex, toHex,
  type Address, type Hex, type PublicClient } from 'viem';
import { binary, type SqlClient } from '@eko/db';
import { loadRegistry, SerializedMeteredForkLease, type AnvilRpc, type MeteredForkLease } from '@eko/chain';
import { ActualOrderBindingSchema, canonicalize, type ActualOrderBinding, type ActualOrderObservation, type ActualOrderState,
  isHardDanger, type Agent, type GuardAssessmentV2, type GuardCursor, type Policy, type PreflightRequest, type Verdict } from '@eko/shared';
import { executionPolicyHash, PRESETS, type Deps } from '@eko/policy';
import type { Config } from '../config.js';
import { UniswapV3Adapter, type ChainClients } from './chain.js';
import type { ActualOrderProbe } from './actual-order.js';
import { v3TradeBackend, type V3TradeAcquisition } from './trade-backend.js';
import { v3ReconciliationBackend, type ActualFill, type PostFillEvidence, type TradeReceipt } from './trade-reconcile.js';
import { ERC20_ABI, FACTORY_ABI, POOL_ABI, QUOTER_V2_ABI, ROUTER_ABI, indexedV3Pools, type IndexedV3Pool, type V3TradeSources } from './v3-routes.js';
import type { RetainedTrade, TradeBackend } from './trades.js';
import { indexedPonsCurves } from './pons-routes.js';
import { ponsTradeBackend, venueTradeBackend } from './pons-trade.js';
import { indexedV4Pools } from './v4-routes.js';
import { v4TradeBackend } from './v4-trade.js';

// Live trade acquisition for indexed single-hop Uniswap v3 routes (BACKEND §12, packets 052/075/076). Every chain read
// uses the API's metered mainnet client at a pinned block; every account simulation runs on the private `sim` Anvil.
const registry = loadRegistry();
const lower = (a: string) => a.toLowerCase() as Address;
const WETH = lower(registry.requireAddress('tokens.WETH'));
const USDG = lower(registry.requireAddress('tokens.USDG'));
const ROUTER = lower(registry.requireAddress('uniswapV3.swapRouter02'));
const FACTORY = lower(registry.requireAddress('uniswapV3.factory'));
/** Fee tiers the canonical v3 factory enables on this chain; other fees can only be look-alike pools. */
const FEES = new Set([100, 500, 3000, 10000]);
const QUOTER = lower(registry.requireAddress('uniswapV3.quoterV2'));
/** Arbitrum's NodeInterface virtual contract (protocol address 0xc8, not a deployment): the L1 data share of a
 * transaction, in L2 gas. Like the router's address-this sentinel, it is a fixed protocol constant. */
const NODE_INTERFACE = padHex('0xc8', { size: 20 });
const NODE_INTERFACE_ABI = parseAbi(['function gasEstimateL1Component(address to, bool contractCreation, bytes data) payable returns (uint64 gasEstimateForL1, uint256 baseFee, uint256 l1BaseFeeEstimate)']);
const LIQUIDITY_ABI = parseAbi(['function liquidity() view returns (uint128)']);
const ADDRESS_THIS = padHex('0x02', { size: 20 });
const ZERO = /^0x0{40}$/i;
const same = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const digest = (value: unknown): Hex => keccak256(stringToHex(canonicalize(JSON.parse(JSON.stringify(value, (_k, v) => typeof v === 'bigint' ? v.toString() : v)))));

/** A GuardCursor at the end of one block. Pure projection of a fetched block header. */
export const cursorOf = (block: { number: bigint | null; hash: Hex | null; timestamp: bigint }): GuardCursor => ({
  chainId: 4663, blockNumber: block.number!.toString(), blockHash: block.hash!.toLowerCase() as Hex,
  transactionIndex: null, executionOrdinal: null, timestampSec: block.timestamp.toString(), boundary: 'block_end',
});

export interface RouteTerms { tokenIn: Address; tokenOut: Address; fee: number; recipient: Address; amountIn: bigint; minOut: bigint; unwrapTo: Address | null }
/** Decode the adapter's SwapRouter02 multicall: one exactInputSingle, optionally followed by unwrapWETH9. Anything else is null. */
export function routeTerms(data: Hex): RouteTerms | null {
  try {
    const call = decodeFunctionData({ abi: ROUTER_ABI, data });
    if (call.functionName !== 'multicall') return null;
    let swap: RouteTerms | null = null, unwrapTo: Address | null = null;
    for (const inner of call.args[1]) {
      const c = decodeFunctionData({ abi: ROUTER_ABI, data: inner });
      if (c.functionName === 'exactInputSingle') {
        if (swap) return null;
        const p = c.args[0];
        swap = { tokenIn: lower(p.tokenIn), tokenOut: lower(p.tokenOut), fee: p.fee, recipient: lower(p.recipient), amountIn: p.amountIn, minOut: p.amountOutMinimum, unwrapTo: null };
      } else if (c.functionName === 'unwrapWETH9') unwrapTo = lower(c.args[1]);
      else return null;
    }
    return swap ? { ...swap, unwrapTo } : null;
  } catch { return null; }
}

/**
 * Block-bound route sources for the v3 adapter, all read through the supplied metered client at the quote block:
 * indexed pools; USD prices from the deepest indexed pool spot price (USDG counts as $1, WETH via the deepest
 * WETH/USDG pool, other coins via their deepest WETH or USDG pool); and total network fee as execution gas plus
 * the L1 data gas Arbitrum's NodeInterface reports, at the block's base fee. Any missing input returns null, which
 * the adapter turns into a refusal.
 */
export function liveTradeSources(chain: () => PublicClient, sql: () => SqlClient): V3TradeSources {
  const memo = new Map<string, Promise<number | null>>();
  const decimals = new Map<string, Promise<number>>();
  const decimalsOf = (token: Address) => {
    let found = decimals.get(token);
    if (!found) { found = withRpcOrigin('server.live_trade.L77',()=>chain().readContract({ address: token, abi: ERC20_ABI, functionName: 'decimals' })).then(Number); decimals.set(token, found); found.catch(() => decimals.delete(token)); }
    return found;
  };
  /** Spot price of `token` in `quote` units from the deepest indexed pool pairing them, at the block. */
  const spot = async (token: Address, quote: Address, pools: IndexedV3Pool[], block: bigint) => {
    let best: { liquidity: bigint; sqrt: bigint; token0: Address } | null = null;
    // Any contract can emit a v3 Initialize event, so the index holds look-alike "pools". Price only from pools the
    // canonical factory created for exactly this pair and fee; a look-alike could revert or report a false price.
    const candidates = pools.filter(p => FEES.has(Number(p.fee)) &&
      [p.currency0, p.currency1].some(c => same(c, quote)) && [p.currency0, p.currency1].some(c => same(c, token)));
    for (const p of candidates) {
      try {
        const canonical = await withRpcOrigin('server.live_trade.L84',()=>chain().readContract({ address: FACTORY, abi: FACTORY_ABI, functionName: 'getPool', args: [token, quote, Number(p.fee)], blockNumber: block }));
        if (!same(canonical, p.address)) continue;
        const [liquidity, slot] = await Promise.all([
          withRpcOrigin('server.live_trade.L85',()=>chain().readContract({ address: p.address, abi: LIQUIDITY_ABI, functionName: 'liquidity', blockNumber: block })),
          withRpcOrigin('server.live_trade.L86',()=>chain().readContract({ address: p.address, abi: POOL_ABI, functionName: 'slot0', blockNumber: block })),
        ]);
        if (slot[0] > 0n && (!best || liquidity > best.liquidity)) best = { liquidity, sqrt: slot[0], token0: lower(p.currency0) };
      } catch { /* an unreadable pool is skipped, never priced */ }
    }
    if (!best) return null;
    const [dToken, dQuote] = await Promise.all([decimalsOf(token), decimalsOf(quote)]);
    const q = Number(best.sqrt) / 2 ** 96, raw = q * q; // token1 raw per token0 raw
    const price = same(best.token0, token) ? raw * 10 ** (dToken - dQuote) : 1 / raw * 10 ** (dToken - dQuote);
    return Number.isFinite(price) && price > 0 ? price : null;
  };
  const priceUsd = (token: Address, block: bigint): Promise<number | null> => {
    const key = `${token.toLowerCase()}:${block}`;
    let found = memo.get(key);
    if (!found) {
      found = (async () => {
        if (same(token, USDG)) return 1;
        const pools = await indexedV3Pools(sql())(lower(token), block);
        if (same(token, WETH)) return spot(WETH, USDG, pools, block);
        const viaWeth = await spot(lower(token), WETH, pools, block);
        if (viaWeth !== null) { const eth = await priceUsd(WETH, block); return eth === null ? null : viaWeth * eth; }
        return spot(lower(token), USDG, pools, block);
      })();
      memo.set(key, found);
      found.catch(() => memo.delete(key));
      while (memo.size > 512) memo.delete(memo.keys().next().value!);
    }
    return found;
  };
  return {
    pools: (coin, block) => indexedV3Pools(sql())(coin, block),
    priceUsd,
    networkFeeWei: async (tx, gas, block) => {
      try {
        const [header, l1] = await Promise.all([chain().getBlock({ blockNumber: block }),
          withRpcOrigin('server.live_trade.rawL121',()=>chain().simulateContract({ address: NODE_INTERFACE, abi: NODE_INTERFACE_ABI, functionName: 'gasEstimateL1Component', args: [tx.to, false, tx.data], blockNumber: block }))]);
        return header.baseFeePerGas == null ? null : (gas + l1.result[0]) * header.baseFeePerGas;
      } catch { return null; }
    },
  };
}

/** JSON-RPC client for the private simulation host. Errors keep the method and Anvil's message, never the URL. */
export function simulationRpc(url: string, timeoutMs = 10_000): AnvilRpc {
  let id = 0;
  return { request: async ({ method, params }) => {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(timeoutMs) });
    const body = await response.json() as { result?: unknown; error?: { message?: string } };
    if (body.error) throw new Error(`${method}: ${body.error.message ?? 'simulation error'}`);
    return body.result;
  } };
}
/**
 * Exclusive use of one simulation host, reset to the requested block of its own fork upstream (configured where the
 * host runs; no upstream URL travels from here). Serialized within this process only: each process needs its own host.
 */
export function simulationLease(rpc: AnvilRpc): MeteredForkLease {
  return new SerializedMeteredForkLease(rpc, async cursor => {
    await withRpcOrigin('server.live_trade.rawL145',()=>rpc.request({ method: 'anvil_reset', params: [{ forking: { blockNumber: Number(cursor.blockNumber) } }] }));
  });
}

const erc20 = {
  balanceOf: (who: Address) => encodeFunctionData({ abi: ERC20_ABI, functionName: 'balanceOf', args: [who] }),
  allowance: (who: Address, spender: Address) => encodeFunctionData({ abi: ERC20_ABI, functionName: 'allowance', args: [who, spender] }),
  approve: (spender: Address, amount: bigint) => encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [spender, amount] }),
};

/** The account on the simulation host: impersonation only, never balance, code or storage overrides. */
class SimAccount {
  readonly receipts: Hex[] = [];
  constructor(private readonly rpc: AnvilRpc, readonly address: Address) {}
  private async call(to: Address, data: Hex) { return await withRpcOrigin('server.live_trade.rawL159',()=>this.rpc.request({ method: 'eth_call', params: [{ from: this.address, to, data }, 'latest'] })) as Hex; }
  async token(token: Address) { return BigInt(await this.call(token, erc20.balanceOf(this.address))); }
  async allowance(token: Address, spender: Address) { return BigInt(await this.call(token, erc20.allowance(this.address, spender))); }
  async native() { return BigInt(await withRpcOrigin('server.live_trade.rawL162',()=>this.rpc.request({ method: 'eth_getBalance', params: [this.address, 'latest'] })) as Hex); }
  async code() { return await withRpcOrigin('server.live_trade.rawL163',()=>this.rpc.request({ method: 'eth_getCode', params: [this.address, 'latest'] })) as Hex; }
  async send(to: Address, data: Hex, value: bigint) {
    const hash = await withRpcOrigin('server.live_trade.rawL165',()=>this.rpc.request({ method: 'eth_sendTransaction', params: [{ from: this.address, to, data, value: toHex(value), gas: toHex(3_000_000n) }] })) as Hex;
    // Mine explicitly: a forked Anvil's automine can seal over a second later, beyond the 5-second refresh window.
    await withRpcOrigin('server.live_trade.rawL167',()=>this.rpc.request({ method: 'evm_mine', params: [] }));
    const receipt = await withRpcOrigin('server.live_trade.rawL168',()=>this.rpc.request({ method: 'eth_getTransactionReceipt', params: [hash] })) as { status: Hex; gasUsed: Hex; effectiveGasPrice: Hex } | null;
    if (!receipt) throw new Error('Simulation receipt unavailable');
    this.receipts.push(hash);
    return { ok: BigInt(receipt.status) === 1n, network: BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice) };
  }
  /** Sell `amount` of `coin` for `quote` on one pool; WETH proceeds are unwrapped to native ETH. */
  async sellBack(coin: Address, quote: Address, fee: number, amount: bigint) {
    const nativeOut = same(quote, WETH);
    const calls: Hex[] = [encodeFunctionData({ abi: ROUTER_ABI, functionName: 'exactInputSingle', args: [{ tokenIn: coin, tokenOut: quote, fee,
      recipient: nativeOut ? ADDRESS_THIS : this.address, amountIn: amount, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }] })];
    if (nativeOut) calls.push(encodeFunctionData({ abi: ROUTER_ABI, functionName: 'unwrapWETH9', args: [0n, this.address] }));
    const before = nativeOut ? await this.native() : await this.token(quote);
    const sold = await this.send(ROUTER, encodeFunctionData({ abi: ROUTER_ABI, functionName: 'multicall', args: [BigInt(Math.floor(Date.now() / 1000) + 3600), calls] }), 0n);
    const returned = nativeOut ? await this.native() - before + sold.network : await this.token(quote) - before;
    return { ...sold, returned };
  }
}
async function withAccount<T>(lease: MeteredForkLease, cursor: GuardCursor, account: Address, work: (sim: SimAccount) => Promise<T>): Promise<T> {
  return lease.withExclusive(async (rpc, reset) => {
    await reset(cursor);
    await withRpcOrigin('server.live_trade.rawL188',()=>rpc.request({ method: 'evm_setAutomine', params: [false] }));
    const header = await withRpcOrigin('server.live_trade.rawL189',()=>rpc.request({ method: 'eth_getBlockByNumber', params: [toHex(BigInt(cursor.blockNumber)), false] })) as { hash?: string } | null;
    if (!same(header?.hash, cursor.blockHash)) throw new Error('Simulation pin mismatch');
    await withRpcOrigin('server.live_trade.rawL191',()=>rpc.request({ method: 'anvil_impersonateAccount', params: [account] }));
    try { return await work(new SimAccount(rpc, account)); }
    finally { await withRpcOrigin('server.live_trade.rawL193',()=>rpc.request({ method: 'anvil_stopImpersonatingAccount', params: [account] })); }
  });
}

/** Route, code and control fingerprints for one coin/pool route; stable across blocks unless code or route changes. */
async function fingerprints(client: PublicClient, coin: Address, pool: Address, terms: RouteTerms, block: bigint) {
  const [coinCode, poolCode] = await Promise.all([withRpcOrigin('server.live_trade.L198.c1',()=>client.getCode({ address: coin, blockNumber: block })), withRpcOrigin('server.live_trade.L198.c2',()=>client.getCode({ address: pool, blockNumber: block }))]);
  return {
    routeFingerprint: digest({ venue: 'uniswap_v3', pool, router: ROUTER, tokenIn: terms.tokenIn, tokenOut: terms.tokenOut, fee: terms.fee }),
    profileHash: digest({ coinCode: keccak256(coinCode ?? '0x'), poolCode: keccak256(poolCode ?? '0x') }),
    stateFingerprint: digest({ coin, pool, factory: FACTORY, accountClass: 'eoa' }),
  };
}

/** Largest USD size of a short ladder (up to the strictest preset's $50k) whose buy moves the pool price at most 2%. */
async function depthUsdLower(client: PublicClient, pool: Address, terms: RouteTerms, priceIn: number, decimalsIn: number, block: bigint): Promise<number> {
  const slot = await withRpcOrigin('server.live_trade.L208',()=>client.readContract({ address: pool, abi: POOL_ABI, functionName: 'slot0', blockNumber: block }));
  for (const usd of [50_000, 10_000, 2_000]) {
    const amountIn = BigInt(Math.floor(usd / priceIn * 10 ** decimalsIn));
    try {
      const { result } = await withRpcOrigin('server.live_trade.rawL213',()=>client.simulateContract({ address: QUOTER, abi: QUOTER_V2_ABI, functionName: 'quoteExactInputSingle',
        args: [{ tokenIn: terms.tokenIn, tokenOut: terms.tokenOut, amountIn, fee: terms.fee, sqrtPriceLimitX96: 0n }], blockNumber: block }));
      if (Math.abs((Number(result[1]) / Number(slot[0])) ** 2 - 1) <= 0.02) return usd;
    } catch { /* this size cannot fill; try a smaller one */ }
  }
  return 0;
}

/**
 * Exact-account probe for indexed single-hop v3 routes (the v3 counterpart of the chain package's
 * PonsActualOrderProbe): on the simulation host at the state's block, a buy runs the exact bytes and sells the
 * bought amount back; a sell runs the exact bytes. Approvals the wallet still lacks are granted exactly inside the
 * simulation only, and the wallet's real allowance is reported (`allowanceBefore`: the coin for sells, the paying
 * token for token-paid buys). Any provider error is `provider_failure`; nothing here signs or broadcasts.
 */
export class V3ActualOrderProbe implements ActualOrderProbe {
  /** Wire the simulation lease, block-bound sources and the metered chain client. No request is made here. */
  constructor(private readonly lease: MeteredForkLease, private readonly sources: V3TradeSources, private readonly chain: () => PublicClient) {}
  /** Measure one binding at the captured state; see the class comment for what is simulated and reported. */
  async observe(binding: ActualOrderBinding, state: ActualOrderState, requestClockMs: number): Promise<ActualOrderObservation> {
    const b = ActualOrderBindingSchema.parse(binding), terms = routeTerms(b.tx.data);
    const result: ActualOrderObservation = { binding: b, state, quotedAtMs: requestClockMs, refreshedAtMs: requestClockMs,
      expiresAtMs: requestClockMs + 15_000, origin: 'measured', mode: b.side === 'buy' ? 'round_trip' : 'sell_only', accountClass: 'eoa',
      status: 'unsupported', spent: '0', returned: '0', tokens: '0', heldBefore: '0', allowanceBefore: '0', notionalUsd: 0,
      entryNetworkFee: '0', exitNetworkFee: '0', depthUsdLower: null, evidenceIds: [] };
    if (!terms || !same(b.tx.to, ROUTER) || !same(b.side === 'buy' ? terms.tokenOut : terms.tokenIn, b.coin) ||
      terms.amountIn !== BigInt(b.amountIn) || terms.minOut !== BigInt(b.minOut)) return result;
    const block = BigInt(state.cursor.blockNumber), quote = b.side === 'buy' ? terms.tokenIn : terms.tokenOut;
    try {
      const pool = lower(await withRpcOrigin('server.live_trade.L241',()=>this.chain().readContract({ address: FACTORY, abi: FACTORY_ABI, functionName: 'getPool', args: [terms.tokenIn, terms.tokenOut, terms.fee], blockNumber: block })));
      const [price, decimals, fp] = await Promise.all([this.sources.priceUsd(quote, block),
        withRpcOrigin('server.live_trade.L243',()=>this.chain().readContract({ address: quote, abi: ERC20_ABI, functionName: 'decimals', blockNumber: block })),
        fingerprints(this.chain(), b.coin, pool, terms, block)]);
      if (ZERO.test(pool) || !price || fp.routeFingerprint !== b.routeFingerprint) return result;
      const paidInToken = b.side === 'buy' && BigInt(b.tx.value) === 0n;
      // Measured on the chain client while the simulation runs; a failed read reports no depth, never a guess.
      const depth = b.side === 'buy' ? depthUsdLower(this.chain(), pool, terms, price, decimals, block).catch(() => null) : Promise.resolve(null);
      await withAccount(this.lease, state.cursor, b.account, async sim => {
        if (await sim.code() !== '0x') { result.accountClass = 'smart_account'; return; }
        const original = await sim.token(b.coin);
        result.heldBefore = original.toString();
        result.allowanceBefore = (await sim.allowance(paidInToken ? quote : b.coin, ROUTER)).toString();
        let approvals = 0n;
        if (b.side === 'buy') {
          if (paidInToken && BigInt(result.allowanceBefore) < BigInt(b.amountIn)) {
            const approved = await sim.send(quote, erc20.approve(ROUTER, BigInt(b.amountIn)), 0n);
            if (!approved.ok) { result.status = 'entry_limited'; return; }
            approvals = approved.network;
          }
          const before = paidInToken ? await sim.token(quote) : await sim.native();
          const bought = await sim.send(b.tx.to, b.tx.data, BigInt(b.tx.value));
          result.entryNetworkFee = (approvals + bought.network).toString();
          if (!bought.ok) { result.status = 'entry_limited'; return; }
          const spent = paidInToken ? before - await sim.token(quote) : before - await sim.native() - bought.network;
          const tokens = await sim.token(b.coin) - original;
          if (spent <= 0n || tokens <= 0n) throw new Error('Invalid simulated debit');
          const approved = await sim.send(b.coin, erc20.approve(ROUTER, tokens), 0n);
          if (!approved.ok) { result.status = 'exit_restricted'; return; }
          const sold = await sim.sellBack(b.coin, quote, terms.fee, tokens);
          result.exitNetworkFee = (approved.network + sold.network).toString();
          if (!sold.ok || sold.returned <= 0n) { result.status = 'exit_restricted'; return; }
          Object.assign(result, { spent: spent.toString(), tokens: tokens.toString(), returned: sold.returned.toString(),
            notionalUsd: Number(spent) / 10 ** decimals * price });
        } else {
          if (original < BigInt(b.amountIn)) { result.status = 'entry_limited'; return; }
          const approved = await sim.send(b.coin, erc20.approve(ROUTER, BigInt(b.amountIn)), 0n);
          if (!approved.ok) { result.status = 'exit_restricted'; return; }
          const nativeOut = terms.unwrapTo !== null;
          const before = nativeOut ? await sim.native() : await sim.token(quote);
          const sold = await sim.send(b.tx.to, b.tx.data, BigInt(b.tx.value));
          result.exitNetworkFee = (approved.network + sold.network).toString();
          if (!sold.ok) { result.status = 'exit_restricted'; return; }
          const returned = nativeOut ? await sim.native() - before + sold.network : await sim.token(quote) - before;
          if (returned <= 0n || await sim.token(b.coin) !== original - BigInt(b.amountIn)) throw new Error('Invalid simulated credit');
          Object.assign(result, { tokens: b.amountIn, returned: returned.toString(), notionalUsd: Number(returned) / 10 ** decimals * price });
        }
        result.status = 'ok';
        result.evidenceIds = [digest({ binding: b, state, receipts: sim.receipts, spent: result.spent, returned: result.returned, tokens: result.tokens })];
      });
      result.depthUsdLower = await depth;
    } catch {
      return { ...result, status: 'provider_failure', evidenceIds: [] };
    }
    return result;
  }
}

/** Measured post-fill replay: sell the actual bought amount from the account at the fill block, on the simulation host. */
export async function v3PostFillSell(lease: MeteredForkLease, retained: RetainedTrade, receipt: TradeReceipt, fill: ActualFill): Promise<PostFillEvidence> {
  const b = retained.checked!.order.execution!, terms = routeTerms(b.tx.data);
  if (!terms) throw new Error('Unsupported route shape');
  const cursor: GuardCursor = { chainId: 4663, blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash.toLowerCase() as Hex,
    transactionIndex: null, executionOrdinal: null, timestampSec: '0', boundary: 'block_end' };
  const sold = await withAccount(lease, cursor, b.account, async sim => {
    const approved = await sim.send(b.coin, erc20.approve(ROUTER, BigInt(fill.filledOut)), 0n);
    if (!approved.ok) return { ok: false, receipts: sim.receipts, returned: 0n };
    const out = await sim.sellBack(b.coin, terms.tokenIn, terms.fee, BigInt(fill.filledOut));
    return { ok: out.ok && out.returned > 0n, receipts: sim.receipts, returned: out.returned };
  });
  return { status: sold.ok ? 'passed' : 'failed', origin: 'measured', code: sold.ok ? 'sell_ok' : 'sell_failed', chainId: 4663,
    account: b.account, txHash: receipt.transactionHash.toLowerCase() as Hex, blockHash: receipt.blockHash.toLowerCase() as Hex,
    blockNumber: receipt.blockNumber.toString(), amount: fill.filledOut, checkedAt: new Date().toISOString(),
    evidenceIds: [digest({ replay: sold.receipts, returned: sold.returned, fill })] };
}

/** The strictest-first preset policy for a wallet trade; wallets have no stored policy (TODO(spec) in http/v1/trade.ts). */
export const walletPolicy = (mode: Policy['mode']): Policy => ({ mode, blockPlaybookLevel: PRESETS[mode].blockPlaybookLevel, killed: false, version: 1 });
/** A wallet trade has no harness agent: the signed-in wallet is the agent the policy evaluates. */
export const walletAgentId = (accountId: string) => `wallet-${accountId}`;
const walletAgent = (accountId: string, wallet: string): Agent => ({ id: walletAgentId(accountId), name: 'Wallet', kind: 'onchain', wallet: lower(wallet), status: 'active', uncheckedOrders24h: 0 });

/** What live trade admission knows about one coin's verdict. */
export interface TradeVerdict {
  /** The current verdict (what Radar shows) plus any stored Guard v2 assessment; `unavailable` when a read failed. */
  verdict: Verdict | 'unavailable' | undefined;
  /** A Guard v2 release is active: its gate (packages/policy/src/guard.ts) takes precedence over the current verdict. */
  guardV2Active: boolean;
  /** A requested scan or rescan of this coin is queued or running (scan_jobs phase other than `done`). */
  scanPending: boolean;
}
export type VerdictSource = (coin: Address) => Promise<TradeVerdict>;
/**
 * Read-model verdicts for trade admission. A Guard v2 release counts as active once any active-mode assessment has been
 * recorded (the only release signal in storage; refreshed every 10 seconds). Any read failure is `unavailable`, which
 * refuses buys.
 */
export function readModelVerdicts(reads: { store: { verdict(coin: Address): Promise<Verdict | null> }; guard: { verdict(coin: Address): Promise<GuardAssessmentV2 | null> } },
  sql: () => SqlClient, now: () => number = Date.now): VerdictSource {
  let release: { at: number; active: Promise<boolean> } | undefined;
  const releaseActive = () => {
    if (!release || now() - release.at > 10_000) {
      const active = sql().query<{ active: boolean }>(`SELECT EXISTS(SELECT 1 FROM guard_verdict_revisions
        WHERE chain_id=4663 AND data->'assessment'->>'mode'='active') AS active`).then(r => r.rows[0]?.active === true);
      release = { at: now(), active };
      active.catch(() => { release = undefined; });
    }
    return release.active;
  };
  return async coin => {
    try {
      const [legacy, guardV2, guardV2Active, scans] = await Promise.all([reads.store.verdict(coin), reads.guard.verdict(coin), releaseActive(),
        sql().query<{ pending: number }>(`SELECT 1 AS pending FROM scan_jobs WHERE coin=$1 AND phase<>'done' LIMIT 1`, [binary(coin)])]);
      const scanPending = scans.rows.length > 0;
      if (!legacy && !guardV2) return { verdict: undefined, guardV2Active, scanPending };
      const base: Verdict = legacy ?? { coin, level: 'pending', reasons: [], playbooks: [], schemaVersion: 'verdict-1+guard-2', asOfBlock: Number(guardV2!.cursor.blockNumber),
        receipt: { id: guardV2!.receipt.id, hash: guardV2!.receipt.payloadHash, status: 'pending' } };
      return { verdict: guardV2 ? { ...base, guardV2 } : base, guardV2Active, scanPending };
    } catch { return { verdict: 'unavailable', guardV2Active: false, scanPending: false }; }
  };
}

/**
 * Buy admission on the current verdict while no Guard v2 release is active (owner decisions 2026-10-06 and 2026-10-12).
 * A hard Danger finding (HARD_DANGER_PLAYBOOKS in @eko/shared) refuses in every risk mode. Any other Danger, by level or by playbook match,
 * refuses in Careful and Balanced; in Degen the buyer has chosen to accept buyer-risk findings, so it is admitted with a
 * warning that names them (since 2026-10-12 Danger also covers run-ups and early-buyer holdings, which describe most
 * actively traded launches). No verdict yet, a `pending` verdict, or a queued or running scan of the coin refuses as
 * `scanning`, which is retryable: a requested scan always produces a verdict newer than the stored one, so while it
 * runs the stored verdict is treated as superseded. `clear` and `monitor` are admitted, with no waiting period. Sells
 * never reach this gate; the sell check, policy limits and the exact-account simulation still apply to every buy.
 */
export function currentVerdictGate(scanPending: boolean): NonNullable<Deps['buyVerdictGate']> {
  return (verdict, policy) => {
    const danger = verdict?.playbooks.filter(m => m.level === 'danger') ?? [], hard = danger.filter(m => isHardDanger(m.id));
    if (hard.length)
      return { deny: [`guard_danger: EKO rates this coin Danger (${hard.map(m => m.id).join(', ')}), so buys are refused in every risk mode`], warn: [] };
    const soft = verdict?.level === 'danger' || danger.length > 0;
    if (soft && policy?.mode !== 'degen')
      return { deny: ['guard_danger: EKO rates this coin Danger, so buys are refused; Degen mode accepts buyer-risk findings'], warn: [] };
    if (!verdict || verdict.level === 'pending' || scanPending)
      return { deny: ['scanning: EKO is still scanning this coin; try again shortly'], warn: [] };
    return { deny: [], warn: soft ? [`guard_danger_accepted: rated Danger (${danger.map(m => m.id).join(', ') || 'level'}); Degen mode accepts buyer-risk findings`] : [] };
  };
}
/** The buy gate for one coin: Guard v2's own gate once a release is active, otherwise the current-verdict gate. */
export const buyVerdictGateFor = (tv: TradeVerdict) => tv.guardV2Active ? undefined : currentVerdictGate(tv.scanPending);
/**
 * The Guard reference bound into an order and rechecked at order time. Under Guard v2 it is the assessment's receipt
 * (a new assessment invalidates the quote). Under the current verdict the gate itself re-runs on the fresh verdict at
 * order time, so a constant keeps routine verdict refreshes from voiding quotes. Sells never depend on a verdict.
 */
export function guardReceiptFor(side: 'buy' | 'sell', tv: TradeVerdict): string {
  if (side === 'sell') return 'not-required:sell';
  if (!tv.guardV2Active) return 'current-verdict';
  return tv.verdict && tv.verdict !== 'unavailable' ? tv.verdict.guardV2?.receipt.id ?? tv.verdict.receipt.id : 'guard-unavailable';
}

/**
 * Accepted acquisition for indexed v3 routes. Quote binds the adapter's exact bytes to the wallet, policy, Guard
 * receipt and route fingerprints; capture reads current wallet/route/verdict state at the chain head; the probe and
 * post-fill replay run on the simulation host. TradeService still runs current admission and policy before bytes.
 */
export function v3TradeAcquisition(o: { chain: () => PublicClient; lease: MeteredForkLease; sources: V3TradeSources; verdict: VerdictSource; adapter: () => Pick<UniswapV3Adapter, 'receipt' | 'transaction'> }): V3TradeAcquisition {
  const chain = o.chain;
  return {
    /** Bind the adapter's exact route bytes to the wallet, current policy hash, Guard receipt and route fingerprints. */
    async quote(owner, input, route, id) {
      const terms = routeTerms(route.tx.data), pool = route.route.poolId ? lower(route.route.poolId) : null;
      if (!terms || !pool) throw new Error('Unsupported route shape');
      const [block, verdict] = await Promise.all([chain().getBlock({ blockNumber: BigInt(route.asOfBlock) }), o.verdict(input.coin)]);
      const guardReceiptId = guardReceiptFor(input.side, verdict);
      const policy = walletPolicy(input.riskMode ?? 'safe'), fp = await fingerprints(chain(), input.coin, pool, terms, block.number!);
      // The coin's exact approval is part of the bound order whenever the quote still lists it.
      const approval = route.approvals.find(a => same(a.token, input.coin));
      const checked: PreflightRequest | null = input.account ? { agentId: walletAgentId(owner.id), clientOrderRef: id,
        order: { venue: 'rhc', instrument: input.coin, side: input.side, orderType: 'market', notionalUsd: input.amountUsd,
          tx: { to: route.tx.to, data: route.tx.data, value: route.tx.value },
          execution: { chainId: 4663, account: input.account, recipient: input.account, coin: input.coin, side: input.side,
            amountIn: route.amountIn, minOut: route.minOut, slippageBps: input.slippageBps, cursor: cursorOf(block), ...fp,
            policyHash: executionPolicyHash(policy), guardReceiptId, tx: route.tx,
            approval: input.side === 'sell' && approval ? { token: input.coin, spender: lower(route.tx.to), amount: route.amountIn, kind: 'erc20',
              tx: { chainId: 4663, to: input.coin, data: erc20.approve(route.tx.to, BigInt(route.amountIn)), value: '0' } } : null } },
        context: { reportedAt: new Date().toISOString() } } : null;
      // Guard and policy decisions happen in TradeService's fresh preparation, never here.
      return { checked, accepted: true, guard: { decision: 'allow', checks: [] }, buyTaxPct: 0, sellTaxPct: 0, exitCostPct: 0 };
    },
    /** Read the wallet's current balances, allowance, route, policy and verdict at the chain head for one retained quote. */
    async capture(retained) {
      const b = retained.checked!.order.execution!, terms = routeTerms(b.tx.data), pool = retained.quote.route.poolId ? lower(retained.quote.route.poolId) : null;
      if (!terms || !pool) throw new Error('Unsupported route shape');
      const head = await chain().getBlock(), at = head.number!;
      const policy = walletPolicy(retained.input.riskMode ?? 'safe');
      const paying = b.side === 'buy' && BigInt(b.tx.value) === 0n ? terms.tokenIn : b.coin;
      const [fp, native, held, allowance, canonical, verdict] = await Promise.all([
        fingerprints(chain(), b.coin, pool, terms, at),
        chain().getBalance({ address: b.account, blockNumber: at }),
        withRpcOrigin('server.live_trade.L438',()=>chain().readContract({ address: b.coin, abi: ERC20_ABI, functionName: 'balanceOf', args: [b.account], blockNumber: at })),
        withRpcOrigin('server.live_trade.L439',()=>chain().readContract({ address: paying, abi: ERC20_ABI, functionName: 'allowance', args: [b.account, ROUTER], blockNumber: at })),
        withRpcOrigin('server.live_trade.L440',()=>chain().readContract({ address: FACTORY, abi: FACTORY_ABI, functionName: 'getPool', args: [terms.tokenIn, terms.tokenOut, terms.fee], blockNumber: at })),
        o.verdict(b.coin),
      ]);
      const now = Date.now();
      const state: ActualOrderState = { observedAtMs: now, criticalCheckedAtMs: now, cursor: cursorOf(head), ...fp,
        balanceHash: digest({ native, held, allowance }), feeHash: digest({ poolFee: terms.fee, ekoFeeBps: 0 }), controlHash: fp.profileHash,
        sourceRevision: digest('live-trade-v3-1'), semanticHash: digest({ coin: b.coin, side: b.side }),
        policyHash: executionPolicyHash(policy), guardReceiptId: guardReceiptFor(b.side, verdict), routeAvailable: same(canonical, pool) };
      const gate = buyVerdictGateFor(verdict);
      const deps: Deps = { now: Date.now, verdictFor: coin => same(coin, b.coin) ? verdict.verdict : undefined, cardFor: () => undefined,
        priceFor: () => undefined, approvalFor: () => undefined, approvalsAvailable: false, ...(gate ? { buyVerdictGate: gate } : {}) };
      return { request: retained.checked!, policy, agent: walletAgent(retained.accountId, retained.wallet!), deps, state,
        admission: { status: 'allowed' }, quoteClocks: { quotedAtMs: retained.quotedAt.getTime(), expiresAtMs: retained.expiresAt.getTime() } };
    },
    probe: new V3ActualOrderProbe(o.lease, o.sources, chain),
    reconciliation: v3ReconciliationBackend({ receipt: h => o.adapter().receipt(h), transaction: h => o.adapter().transaction(h) }, o.sources,
      (retained, receipt, fill) => v3PostFillSell(o.lease, retained, receipt, fill)),
  };
}

/** Test seams only: the fork suite supplies a Guard assessment and Anvil's L2-only gas, which production reads. */
export interface LiveTradeOverrides { verdict?: VerdictSource; sources?: Partial<Pick<V3TradeSources, 'networkFeeWei' | 'priceUsd'>> }
/**
 * Build the live trade backend for this process, or explain why there is none. Fail-closed: without
 * LIVE_TRADING_ENABLED there is no backend (quotes refuse exactly as before); without a pinned-block RPC
 * (RPC_HTTP_URL or RH_MAINNET_RPC_URL) or a simulation host (ANVIL_FORK_URL) quotes refuse with `unavailable`.
 */
export function liveTradeBackend(cfg: Pick<Config, 'LIVE_TRADING_ENABLED' | 'RPC_HTTP_URL' | 'RH_MAINNET_RPC_URL' | 'ANVIL_FORK_URL'>,
  deps: { chains: () => ChainClients; sql: () => SqlClient; verdict: VerdictSource }, overrides: LiveTradeOverrides = {}):
  { backend?: TradeBackend; unavailable: string; missing: string[] } {
  const missing = [...(cfg.LIVE_TRADING_ENABLED ? [] : ['LIVE_TRADING_ENABLED']),
    ...(cfg.RPC_HTTP_URL || cfg.RH_MAINNET_RPC_URL ? [] : ['RPC_HTTP_URL']), ...(cfg.ANVIL_FORK_URL ? [] : ['ANVIL_FORK_URL'])];
  if (!cfg.LIVE_TRADING_ENABLED) return { unavailable: 'Actual-account trade acquisition is unavailable', missing };
  if (missing.length) return { unavailable: 'Live trade quotes are not configured on this server: the chain or simulation host is missing', missing };
  const chain = () => deps.chains().get('robinhood-mainnet');
  let adapter: UniswapV3Adapter | undefined;
  const v3 = () => adapter ??= new UniswapV3Adapter(deps.chains(), 'robinhood-mainnet', () => null);
  const sources: V3TradeSources = { ...liveTradeSources(chain, deps.sql), ...overrides.sources };
  const lease = simulationLease(simulationRpc(cfg.ANVIL_FORK_URL!)), verdict = overrides.verdict ?? deps.verdict;
  const acquisition = v3TradeAcquisition({ chain, lease, sources, verdict, adapter: v3 });
  const pools = v3TradeBackend({ quoteTrade: (input, s) => v3().quoteTrade(input, s) }, sources, acquisition);
  // Venue hook: open Pons curves trade on the curve (same lease, sources and verdict); everything else, graduated coins
  // included, goes to the pools: v3, then v4.
  const pons = ponsTradeBackend({ chain, lease, verdict, adapter: v3,
    sources: { curve: coin => indexedPonsCurves(deps.sql())(coin), priceUsd: sources.priceUsd, networkFeeWei: sources.networkFeeWei } });
  // Native v4 pools (graduated Pons coins, hookless pools) when the coin has no v3 route; a proven-locked Pons graduation
  // pool is judged by its exact exit cost, every other pool by its depth floor.
  const v4 = v4TradeBackend({ chain, lease, verdict, adapter: v3,
    sources: { pools: (coin, block) => indexedV4Pools(deps.sql())(coin, block), priceUsd: sources.priceUsd, networkFeeWei: sources.networkFeeWei,
      graduation: async coin => (await indexedPonsCurves(deps.sql())(coin))?.graduatedPool ?? null } });
  return { backend: venueTradeBackend(pools, pons, v4), unavailable: '', missing };
}
/** Shared with the Pons-curve acquisition (pons-trade.ts). */
export { digest, erc20, walletAgent, withAccount };
