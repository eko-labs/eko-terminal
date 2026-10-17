import { withRpcOrigin } from '@eko/chain';
import { decodeAbiParameters, decodeEventLog, decodeFunctionData, encodeAbiParameters, encodeFunctionData, formatUnits, hexToBigInt, keccak256, padHex, parseAbi,
  toHex, zeroAddress, type Address, type Hex, type PublicClient } from 'viem';
import { loadRegistry, v4PoolId, type V4PoolKey } from '@eko/chain';
import { binary, hex, type SqlClient } from '@eko/db';
import type { TradeQuote, TradeQuoteRequest, UnsignedTx } from '@eko/shared';
import { ChainQuoteError, ERC20_ABI, rawUsd, verified, type V3TradeRoute, type V3TradeSources } from './v3-routes.js';
import type { RetainedTrade } from './trades.js';
import type { ActualFill, TradeReceipt } from './trade-reconcile.js';

// Uniswap v4 routes for the v1 live trade path: native-ETH pools (currency0 = ETH) of one coin, quoted by the V4Quoter
// and executed through the UniversalRouter's V4_SWAP command, at a 0% terminal fee. Graduated Pons coins trade here (the
// Pons graduation pool), as does any indexed native v4 pool without a hook. Every read is pinned to the quote block on
// the API's metered client; nothing here signs or simulates. The calldata was checked against the deployed router.
const registry = loadRegistry();
const lower = (a: string) => a.toLowerCase() as Address;
const same = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
export const V4_MANAGER = lower(registry.requireAddress('uniswapV4.poolManager'));
export const V4_ROUTER = lower(registry.requireAddress('uniswapV4.universalRouter'));
export const PERMIT2 = lower(registry.requireAddress('uniswapV4.permit2'));
const V4_QUOTER = lower(registry.requireAddress('uniswapV4.v4Quoter'));
const PONS_HOOK = lower(registry.requireAddress('pons.v4Hook'));
const WETH = lower(registry.requireAddress('tokens.WETH'));

const keyType = '(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)';
export const V4_QUOTER_ABI = parseAbi([`function quoteExactInputSingle((${keyType} poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)`,
  'function poolManager() view returns (address)']);
export const V4_ROUTER_ABI = parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable', 'function poolManager() view returns (address)']);
export const PERMIT2_ABI = parseAbi(['function approve(address token, address spender, uint160 amount, uint48 expiration)',
  'function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)']);
export const V4_MANAGER_ABI = parseAbi(['function extsload(bytes32 slot) view returns (bytes32)',
  'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)']);
const WETH_ABI = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)', 'event Withdrawal(address indexed src, uint256 wad)']);
/** Network-fee sizing above the quoter's swap gas (router, settlement and, for sells, Permit2 and the unwrap). */
const ROUTER_GAS = 120_000n;
/** Permit2 allowances are exact and short-lived (task 071): at most 30 minutes, and refreshed with 5 minutes left. */
export const PERMIT2_TTL_SEC = 1_800, PERMIT2_MIN_LEFT_SEC = 300;

/** A native v4 pool of one coin from indexed state. Only hookless pools and the reviewed Pons graduation hook trade. */
export interface IndexedV4Pool { id: Hex; key: V4PoolKey }
export interface V4TradeSources extends Pick<V3TradeSources, 'priceUsd' | 'networkFeeWei'> {
  pools(coin: Address, block: bigint): Promise<IndexedV4Pool[]>;
  /** The indexer's graduation pool for a Pons coin (its curve's successor), or null. */
  graduation?(coin: Address): Promise<Hex | null>;
}
/** True for the hooks v1 trades through: none, or the Pons graduation hook. Any other hook is unsupported. */
export const supportedV4Hook = (hooks: Address) => same(hooks, zeroAddress) || same(hooks, PONS_HOOK);
/** Indexed native-ETH v4 pools of `coin` created by `block` whose key hashes to the indexed PoolId. Query failures reject. */
export function indexedV4Pools(sql: SqlClient): V4TradeSources['pools'] {
  return async (coin, block) => {
    const { rows } = await sql.query<{ id: Uint8Array; currency1: Uint8Array; fee: number; tick_spacing: number; hooks: Uint8Array | null }>(
      `SELECT id,currency1,fee,tick_spacing,hooks FROM pools WHERE venue='uniswap_v4' AND currency0=$1 AND currency1=$2 AND created_block <= $3`,
      [binary(zeroAddress), binary(coin), block.toString()]);
    return rows.map(r => ({ id: hex(r.id).toLowerCase() as Hex, key: { currency0: zeroAddress, currency1: lower(hex(r.currency1)), fee: r.fee,
      tickSpacing: r.tick_spacing, hooks: r.hooks ? lower(hex(r.hooks)) : zeroAddress } }))
      .filter(p => supportedV4Hook(p.key.hooks) && v4PoolId(p.key).toLowerCase() === p.id);
  };
}

export interface V4PoolState { sqrtPriceX96: bigint; tick: bigint; liquidity: bigint; stateSlot: Hex }
const POOLS_SLOT = 6n, LIQUIDITY_OFFSET = 3n, TICK_BITMAP_OFFSET = 5n;
/** Slot0 and active liquidity of a pool from PoolManager storage (v4-core StateLibrary layout), at a pinned block. */
export async function readV4Pool(client: Pick<PublicClient, 'readContract'>, poolId: Hex, block: bigint): Promise<V4PoolState> {
  const stateSlot = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [poolId, POOLS_SLOT]));
  const load = (slot: Hex) => withRpcOrigin('server.v4_routes.L64',()=>client.readContract({ address: V4_MANAGER, abi: V4_MANAGER_ABI, functionName: 'extsload', args: [slot], blockNumber: block }));
  const [slot0, liquidity] = await Promise.all([load(stateSlot), load(toHex(hexToBigInt(stateSlot) + LIQUIDITY_OFFSET, { size: 32 }))]);
  const s = hexToBigInt(slot0), rawTick = (s >> 160n) & 0xffffffn;
  return { sqrtPriceX96: s & ((1n << 160n) - 1n), tick: rawTick >= 0x800000n ? rawTick - 0x1000000n : rawTick,
    liquidity: hexToBigInt(liquidity) & ((1n << 128n) - 1n), stateSlot };
}
/** Coin raw units per wei at the pool's marginal price (currency0 is ETH). */
export const coinPerWei = (s: V4PoolState, wei: bigint) => wei * s.sqrtPriceX96 * s.sqrtPriceX96 >> 192n;

/**
 * ±2% buy depth lower bound in wei (Guard 2.0 §3.4, market-only): the ETH that moves the coin's marginal price up 2%
 * with the pool's active liquidity, stopping at the first initialized tick inside that band, past which liquidity may
 * fall. Read from the pool's tick bitmap at the block; never interpolated beyond what the liquidity proves.
 */
export async function v4DepthWei(client: Pick<PublicClient, 'readContract'>, pool: IndexedV4Pool, s: V4PoolState, block: bigint): Promise<bigint> {
  if (s.liquidity === 0n || s.sqrtPriceX96 === 0n) return 0n;
  const spacing = BigInt(pool.key.tickSpacing), band = 199n; // ⌈ln(1.02)/ln(1.0001)⌉ ticks
  const compress = (t: bigint) => t / spacing - (t < 0n && t % spacing !== 0n ? 1n : 0n);
  const hi = compress(s.tick), lo = compress(s.tick - band);
  let crossed: bigint | null = null;
  for (let word = hi >> 8n; word >= lo >> 8n && crossed === null; word--) {
    const slot = keccak256(encodeAbiParameters([{ type: 'int256' }, { type: 'bytes32' }], [word, toHex(hexToBigInt(s.stateSlot) + TICK_BITMAP_OFFSET, { size: 32 })]));
    const bits = hexToBigInt(await withRpcOrigin('server.v4_routes.L86',()=>client.readContract({ address: V4_MANAGER, abi: V4_MANAGER_ABI, functionName: 'extsload', args: [slot], blockNumber: block })));
    for (let c = word === hi >> 8n ? hi : (word << 8n) + 255n; c >= word << 8n && c >= lo; c--) {
      const t = c * spacing;
      if (t <= s.tick && t > s.tick - band && (bits >> BigInt(((Number(c % 256n) + 256) % 256))) & 1n) { crossed = t; break; }
    }
  }
  const now = Number(s.sqrtPriceX96), band2 = now / Math.sqrt(1.02);
  const target = crossed === null ? band2 : Math.max(band2, 1.0001 ** (Number(crossed) / 2) * 2 ** 96);
  const wei = Number(s.liquidity) * (2 ** 96 / target - 2 ** 96 / now) * 0.999;
  return Number.isFinite(wei) && wei > 0 ? BigInt(Math.floor(wei)) : 0n;
}

/** UniversalRouter commands and v4 router actions used here (v4-periphery Actions, universal-router Commands). */
const V4_SWAP = 0x10, WRAP_ETH = 0x0b, UNWRAP_WETH = 0x0c;
const SWAP_EXACT_IN_SINGLE = 0x06, SETTLE_ALL = 0x0c, TAKE = 0x0e, TAKE_ALL = 0x0f;
const ADDRESS_THIS = padHex('0x02', { size: 20 }), CONTRACT_BALANCE = 1n << 255n, OPEN_DELTA = 0n;
const singleParams = { type: 'tuple', components: [{ type: 'tuple', name: 'poolKey', components: [{ type: 'address', name: 'currency0' },
  { type: 'address', name: 'currency1' }, { type: 'uint24', name: 'fee' }, { type: 'int24', name: 'tickSpacing' }, { type: 'address', name: 'hooks' }] },
{ type: 'bool', name: 'zeroForOne' }, { type: 'uint128', name: 'amountIn' }, { type: 'uint128', name: 'amountOutMinimum' }, { type: 'bytes', name: 'hookData' }] } as const;
const currencyAmount = [{ type: 'address' }, { type: 'uint256' }] as const;
const currencyRecipientAmount = [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }] as const;
const bytes = (...codes: number[]) => toHex(new Uint8Array(codes));

export interface V4CallTerms { side: 'buy' | 'sell'; key: V4PoolKey; amountIn: bigint; minOut: bigint;
  /** A sell's native payout recipient; a buy pays out to the signer (TAKE_ALL). */ recipient: Address | null; deadline: bigint }
/**
 * Exact router bytes for one exact-input swap on a native pool. A buy settles the sent ETH and takes all of the coin to
 * the signer. A sell settles the coin through Permit2 and takes the ETH to the router, which wraps and unwraps it to the
 * recipient: the unwrap's WETH burn logs the exact native payout (hook fees included), so the fill is measured from logs.
 */
export function v4TradeCall(t: Omit<V4CallTerms, 'recipient'> & { recipient: Address }): Hex {
  const buy = t.side === 'buy', [paid, received] = buy ? [t.key.currency0, t.key.currency1] : [t.key.currency1, t.key.currency0];
  const swap = encodeAbiParameters([singleParams], [{ poolKey: t.key, zeroForOne: buy, amountIn: t.amountIn, amountOutMinimum: t.minOut, hookData: '0x' }]);
  const settle = encodeAbiParameters(currencyAmount, [paid, t.amountIn]);
  if (buy) {
    const v4 = encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [bytes(SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL),
      [swap, settle, encodeAbiParameters(currencyAmount, [received, t.minOut])]]);
    return encodeFunctionData({ abi: V4_ROUTER_ABI, functionName: 'execute', args: [bytes(V4_SWAP), [v4], t.deadline] });
  }
  const v4 = encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [bytes(SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE),
    [swap, settle, encodeAbiParameters(currencyRecipientAmount, [received, ADDRESS_THIS, OPEN_DELTA])]]);
  return encodeFunctionData({ abi: V4_ROUTER_ABI, functionName: 'execute', args: [bytes(V4_SWAP, WRAP_ETH, UNWRAP_WETH),
    [v4, encodeAbiParameters(currencyAmount, [ADDRESS_THIS, CONTRACT_BALANCE]), encodeAbiParameters(currencyAmount, [t.recipient, t.minOut])], t.deadline] });
}
/** Decode exactly the bytes v4TradeCall builds (anything else, trailing bytes included, is null). */
export function v4CallTerms(data: Hex): V4CallTerms | null {
  try {
    const call = decodeFunctionData({ abi: V4_ROUTER_ABI, data });
    if (call.functionName !== 'execute') return null;
    const [commands, inputs, deadline] = call.args as readonly [Hex, readonly Hex[], bigint];
    const buy = commands === bytes(V4_SWAP);
    if (!buy && commands !== bytes(V4_SWAP, WRAP_ETH, UNWRAP_WETH)) return null;
    const [actions, params] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], inputs[0]!);
    if (params.length !== 3) return null;
    const [swap] = decodeAbiParameters([singleParams], params[0]!);
    const key: V4PoolKey = { currency0: lower(swap.poolKey.currency0), currency1: lower(swap.poolKey.currency1), fee: swap.poolKey.fee,
      tickSpacing: swap.poolKey.tickSpacing, hooks: lower(swap.poolKey.hooks) };
    if (swap.zeroForOne !== buy || !same(key.currency0, zeroAddress)) return null;
    const recipient = buy ? null : lower(decodeAbiParameters(currencyAmount, inputs[2]!)[0]);
    const terms: V4CallTerms = { side: buy ? 'buy' : 'sell', key, amountIn: swap.amountIn, minOut: swap.amountOutMinimum, recipient, deadline };
    const rebuilt = v4TradeCall({ ...terms, recipient: recipient ?? zeroAddress });
    return rebuilt.toLowerCase() === data.toLowerCase() && actions === (buy ? bytes(SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL) : bytes(SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE)) ? terms : null;
  } catch { return null; }
}

/** The router and quoter are wired to the registry's PoolManager and Permit2 is deployed, at the block. */
export async function v4Wired(client: Pick<PublicClient, 'readContract' | 'getCode'>, block: bigint): Promise<boolean> {
  const [router, quoter, permit2] = await Promise.all([
    withRpcOrigin('server.v4_routes.L154',()=>client.readContract({ address: V4_ROUTER, abi: V4_ROUTER_ABI, functionName: 'poolManager', blockNumber: block })),
    withRpcOrigin('server.v4_routes.L155',()=>client.readContract({ address: V4_QUOTER, abi: V4_QUOTER_ABI, functionName: 'poolManager', blockNumber: block })),
    withRpcOrigin('server.v4_routes.L156',()=>client.getCode({ address: PERMIT2, blockNumber: block }))]);
  return same(router, V4_MANAGER) && same(quoter, V4_MANAGER) && !!permit2 && permit2 !== '0x';
}
/**
 * The wallet's usable allowance for a v4 sell: the smaller of its ERC-20 allowance to Permit2 and its Permit2 allowance
 * to the router, which counts only while it has at least five minutes left.
 */
export async function v4Allowances(client: Pick<PublicClient, 'readContract'>, coin: Address, account: Address, block: bigint, nowSec: number) {
  const [erc20, [amount, expiration]] = await Promise.all([
    withRpcOrigin('server.v4_routes.L165',()=>client.readContract({ address: coin, abi: ERC20_ABI, functionName: 'allowance', args: [account, PERMIT2], blockNumber: block })),
    withRpcOrigin('server.v4_routes.L166',()=>client.readContract({ address: PERMIT2, abi: PERMIT2_ABI, functionName: 'allowance', args: [account, coin, V4_ROUTER], blockNumber: block }))]);
  const permit2 = expiration > nowSec + PERMIT2_MIN_LEFT_SEC ? amount : 0n;
  return { erc20, permit2, permit2Expiration: expiration, usable: erc20 < permit2 ? erc20 : permit2 };
}

export interface V4TradeRoute extends V3TradeRoute { pool: IndexedV4Pool; state: V4PoolState }
const positive = (n: number | null): n is number => n !== null && Number.isFinite(n) && n > 0;

/**
 * Unsigned zero-terminal-fee route on the coin's best native v4 pool, like quoteV3Trade: validate amount and slippage,
 * check the router/quoter/Permit2 wiring at the block, size the input at the block's ETH-USD (sells at the pool's
 * marginal price), quote every supported indexed pool and keep the largest output. A sell lists the exact approvals the
 * wallet still lacks: ERC-20 to Permit2, then Permit2 to the router with a 30-minute expiry. executable stays false.
 */
export async function quoteV4Trade(client: PublicClient, input: TradeQuoteRequest, sources: V4TradeSources, now = Date.now): Promise<V4TradeRoute> {
  if (!positive(input.amountUsd)) throw new ChainQuoteError('bad_request', 'Amount must be positive and finite');
  if (!Number.isInteger(input.slippageBps) || input.slippageBps < 0 || input.slippageBps >= 10_000)
    throw new ChainQuoteError('bad_request', 'Slippage must be an integer from 0 to 9999 bps');
  for (const key of ['uniswapV4.poolManager', 'uniswapV4.v4Quoter', 'uniswapV4.universalRouter', 'uniswapV4.permit2', 'tokens.WETH'] as const) verified(registry, key);
  const coin = lower(input.coin), block = await client.getBlockNumber({ cacheTime: 0 });
  if (block > BigInt(Number.MAX_SAFE_INTEGER)) throw new ChainQuoteError('stale_data', 'Block is out of range');
  const quotedAt = now(), nowSec = Math.floor(quotedAt / 1000);
  const pools = await sources.pools(coin, block);
  if (!pools.length) throw new ChainQuoteError('no_route', 'No indexed native v4 pool with a supported hook');
  if (!await v4Wired(client, block)) throw new ChainQuoteError('no_route', 'Uniswap v4 router wiring is unverified');
  const ethUsd = await sources.priceUsd(WETH, block);
  if (!positive(ethUsd)) throw new ChainQuoteError('stale_data', 'ETH USD price unavailable');
  const wei = rawUsd(input.amountUsd, ethUsd, 18);
  const candidates = (await Promise.all(pools.map(async pool => {
    try {
      const state = await readV4Pool(client, pool.id, block);
      if (state.sqrtPriceX96 === 0n || state.liquidity === 0n) return null;
      const amountIn = input.side === 'buy' ? wei : coinPerWei(state, wei);
      if (amountIn <= 0n || amountIn >= 2n ** 128n) return null;
      const { result: [amountOut, gas] } = await withRpcOrigin('server.v4_routes.rawL201',()=>client.simulateContract({ address: V4_QUOTER, abi: V4_QUOTER_ABI, functionName: 'quoteExactInputSingle',
        args: [{ poolKey: pool.key, zeroForOne: input.side === 'buy', exactAmount: amountIn, hookData: '0x' }], blockNumber: block }));
      return amountOut > 0n ? { pool, state, amountIn, amountOut, gas } : null;
    } catch { return null; }
  }))).filter(c => c !== null).sort((a, b) => a.amountOut > b.amountOut ? -1 : a.amountOut < b.amountOut ? 1 : 0);
  const best = candidates[0];
  if (!best) throw new ChainQuoteError('no_route', 'No indexed v4 pool could fill this size');
  const minOut = best.amountOut * BigInt(10_000 - input.slippageBps) / 10_000n;
  if (minOut <= 0n) throw new ChainQuoteError('no_route', 'Minimum output rounds to zero');
  const recipient = input.account ? lower(input.account) : padHex('0x01', { size: 20 });
  const tx: UnsignedTx = { chainId: 4663, to: V4_ROUTER, value: input.side === 'buy' ? best.amountIn.toString() : '0',
    data: v4TradeCall({ side: input.side, key: best.pool.key, amountIn: best.amountIn, minOut, recipient, deadline: BigInt(nowSec + 120) }) };
  const approvals: TradeQuote['approvals'] = [];
  if (input.side === 'sell') {
    const held = input.account ? await v4Allowances(client, coin, recipient, block, nowSec) : null;
    if (!held || held.erc20 < best.amountIn) approvals.push({ token: coin, spender: PERMIT2, amount: best.amountIn.toString(), kind: 'erc20' });
    if (!held || held.permit2 < best.amountIn)
      approvals.push({ token: coin, spender: V4_ROUTER, amount: best.amountIn.toString(), kind: 'permit2', expiration: nowSec + PERMIT2_TTL_SEC });
  }
  const feeWei = await sources.networkFeeWei(tx, best.gas + ROUTER_GAS, block);
  if (feeWei === null || feeWei < 0n) throw new ChainQuoteError('sim_unavailable', 'Total network fee estimate unavailable');
  // Impact against the marginal price net of the LP fee (a dynamic-fee pool counts its whole cost); hook fees are included.
  const lpFee = best.pool.key.fee & 0x800000 ? 0 : best.pool.key.fee / 1_000_000;
  const ideal = input.side === 'buy' ? Number(coinPerWei(best.state, best.amountIn)) : Number(best.amountIn) * 2 ** 192 / Number(best.state.sqrtPriceX96) ** 2;
  const impact = ideal > 0 ? Math.max(0, (ideal * (1 - lpFee) - Number(best.amountOut)) / (ideal * (1 - lpFee)) * 10_000) : 0;
  return {
    amountIn: best.amountIn.toString(), valueWei: tx.value, expectedOut: best.amountOut.toString(), minOut: minOut.toString(),
    networkFeeUsd: Number(formatUnits(feeWei, 18)) * ethUsd, priceImpactBps: Number.isFinite(impact) ? impact : 0,
    // Construction alone is never an accepted probe or account-bound preflight.
    route: { venue: 'uniswap_v4', poolId: best.pool.id, executable: false },
    fee: { bps: 0, usd: 0, destination: null }, approvals,
    asOfBlock: Number(block), expiresAt: new Date(quotedAt + 20_000).toISOString(), tx, pool: best.pool, state: best.state,
  };
}

/**
 * The actual fill of a retained v4 order from its receipt. Exactly one PoolManager Swap on the quoted pool by the router
 * proves execution. A buy's input is the exact ETH sent; its output the coin the wallet received net of anything it
 * sent (transfer and hook fees included). A sell's input is the coin that left the wallet; its output the router's
 * WETH unwrap to the wallet, the exact native payout. Anything else is null.
 */
export function decodeV4Fill(retained: RetainedTrade, receipt: TradeReceipt): ActualFill | null {
  const q = retained.quote, b = retained.checked?.order.execution;
  if (!b || q.route.venue !== 'uniswap_v4' || !q.route.executable || !q.route.poolId || !same(b.tx.to, V4_ROUTER)) return null;
  const terms = v4CallTerms(b.tx.data);
  if (!terms || terms.side !== q.side || !same(v4PoolId(terms.key), q.route.poolId) || !same(terms.key.currency1, q.coin) ||
    terms.side === 'sell' && !same(terms.recipient, b.account)) return null;
  const swaps: { sender: Address; amount0: bigint; amount1: bigint }[] = [];
  let received = 0n, sent = 0n, unwrapped = 0n;
  for (const log of receipt.logs) {
    if (log.removed || log.transactionHash !== receipt.transactionHash || log.blockHash !== receipt.blockHash) return null;
    try {
      if (same(log.address, V4_MANAGER)) {
        const ev = decodeEventLog({ abi: V4_MANAGER_ABI, data: log.data, topics: log.topics });
        if (ev.eventName === 'Swap' && same(ev.args.id, q.route.poolId)) swaps.push({ sender: ev.args.sender, amount0: ev.args.amount0, amount1: ev.args.amount1 });
      } else if (same(log.address, q.coin)) {
        const ev = decodeEventLog({ abi: ERC20_ABI, data: log.data, topics: log.topics });
        if (ev.eventName === 'Transfer') {
          if (same(ev.args.to, b.account)) received += ev.args.value;
          if (same(ev.args.from, b.account)) sent += ev.args.value;
        }
      } else if (same(log.address, WETH)) {
        // Robinhood Chain's WETH burns on unwrap (Transfer to zero); a WETH9 Withdrawal counts the same way.
        const ev = decodeEventLog({ abi: WETH_ABI, data: log.data, topics: log.topics });
        if (ev.eventName === 'Transfer' && same(ev.args.from, V4_ROUTER) && same(ev.args.to, zeroAddress)) unwrapped += ev.args.value;
        if (ev.eventName === 'Withdrawal' && same(ev.args.src, V4_ROUTER)) unwrapped += ev.args.wad;
      }
    } catch { /* unrelated event; absence of the required event refuses the fill */ }
  }
  if (swaps.length !== 1 || !same(swaps[0]!.sender, V4_ROUTER)) return null;
  const { amount0, amount1 } = swaps[0]!;
  if (q.side === 'buy') {
    if (amount0 >= 0n || amount1 <= 0n || -amount0 > BigInt(b.tx.value) || received <= sent || received - sent > amount1) return null;
    return { filledIn: BigInt(b.tx.value).toString(), filledOut: (received - sent).toString() };
  }
  if (amount0 <= 0n || amount1 >= 0n || sent <= received || sent - received < -amount1 || unwrapped <= 0n) return null;
  return { filledIn: (sent - received).toString(), filledOut: unwrapped.toString() };
}
