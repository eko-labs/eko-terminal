import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decodeEventLog, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, getAddress, keccak256, parseAbi, zeroAddress, type Address, type Hex } from 'viem';
import { parseYaml, v4PoolId, type V4PoolKey } from '@eko/chain';

/**
 * Wallet trading on Robinhood Chain (4663), no custody and no fee: the unsigned call for a Pons coin, its approvals, a
 * quote and the fill read back from the receipt. A Pons coin trades on its bonding curve until it graduates, then in a
 * native-ETH Uniswap v4 pool with the Pons hook. Pure builders plus plain `eth_call` reads; nothing here signs.
 *
 * Proven on an anvil fork of 4663 by scripts/robinhood/fork-trade.ts (buy about $1, sell half, fills equal to the wallet's
 * balance changes to the wei, gas included) for one coin on its curve and one graduated coin.
 */

export interface RobinhoodTradeAddresses { universalRouter: Address; permit2: Address; poolManager: Address; quoter: Address; weth: Address }
export type RobinhoodRoute = { kind: 'curve'; curve: Address; token: Address } | { kind: 'v4'; key: V4PoolKey; token: Address };
export type RobinhoodApproval =
  | { kind: 'erc20'; token: Address; spender: Address; amount: string }
  | { kind: 'permit2'; token: Address; spender: Address; amount: string; expiration: number };
type Rpc = { request(i: { method: string; params: readonly unknown[] }): Promise<unknown> };
type Receipt = { status: Hex; logs: { address: string; topics: Hex[]; data: Hex }[] };

const REGISTRY = fileURLToPath(new URL('../../../../../packages/chain/addresses.4663.yaml', import.meta.url));
let loaded: RobinhoodTradeAddresses | undefined;
/** The registry's addresses, read once (robinhoodFill's default). */
const registryAddresses = () => loaded ??= loadRobinhoodTradeAddresses();
/**
 * The trade addresses from the 4663 registry (packages/chain/addresses.4663.yaml). Each must be a verified address: a
 * TODO, a missing `verified` date or another chain's file throws. Read directly, so the registry's schema can change
 * with the runtime chain without touching trading.
 */
export function loadRobinhoodTradeAddresses(text = readFileSync(REGISTRY, 'utf8')): RobinhoodTradeAddresses & { ponsHook: Address; ponsFactory: Address } {
  const doc = parseYaml(text) as Record<string, Record<string, { address?: string; verified?: string }>> & { chainId?: number };
  if (doc.chainId !== 4663) throw new Error('Not the Robinhood Chain (4663) registry');
  const pick = (group: string, key: string): Address => {
    const e = doc[group]?.[key];
    if (!e?.address || !/^0x[0-9a-fA-F]{40}$/.test(e.address) || !e.verified) throw new Error(`Registry address is not verified: ${group}.${key}`);
    return getAddress(e.address);
  };
  return { universalRouter: pick('uniswapV4', 'universalRouter'), permit2: pick('uniswapV4', 'permit2'), poolManager: pick('uniswapV4', 'poolManager'),
    quoter: pick('uniswapV4', 'v4Quoter'), weth: pick('tokens', 'WETH'), ponsHook: pick('pons', 'v4Hook'), ponsFactory: pick('pons', 'factory') };
}

/**
 * The deployed Pons v2 curve (native-ETH quote). Selectors and events match the old product's PONS_CURVE_ABI and were
 * re-read from curves launched on 2026-11-17 (blocks ~116.85M): buy 0x59a87bc1, sell 0xd04c6983, the same getters, and
 * CurveBuy/CurveSell decoding real logs. CurveBuy's `fee` carries the launch anti-snipe tax as well as the 1% curve fee
 * (a launch-block buy logged fee = 1% + 6.18%), so a quote adds `currentSnipeTaxBps` to `feeBps`.
 */
export const PONS_CURVE_ABI = parseAbi([
  'function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable',
  'function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient)',
  'function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)',
  'function sellableTokens() view returns (uint256)',
  'function realQuoteReserve() view returns (uint256)',
  'function feeBps() view returns (uint256)',
  'function creatorTaxBps() view returns (uint256)',
  'function currentSnipeTaxBps(address token) view returns (uint256)',
  'function graduated() view returns (bool)',
  'function readyToGraduate() view returns (bool)',
  'function token() view returns (address)',
  'function pairToken() view returns (address)',
  'event CurveBuy(address indexed buyer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 tax)',
  'event CurveSell(address indexed seller, address indexed recipient, uint256 tokensIn, uint256 quoteOut, uint256 fee, uint256 tax)',
]);
export const universalRouterAbi = parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable']);
export const v4QuoterAbi = parseAbi(['function quoteExactInputSingle(((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)']);
const erc20Abi = parseAbi(['function approve(address spender, uint256 amount) returns (bool)', 'function allowance(address owner, address spender) view returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 value)']);
const permit2Abi = parseAbi(['function approve(address token, address spender, uint160 amount, uint48 expiration)',
  'function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)']);
const wethAbi = parseAbi(['event Withdrawal(address indexed src, uint256 wad)', 'event Transfer(address indexed from, address indexed to, uint256 value)']);
const managerAbi = parseAbi(['function extsload(bytes32 slot) view returns (bytes32)',
  'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)']);

/**
 * Universal Router commands and v4 actions (universal-router Commands, v4-periphery Actions).
 *
 * The router at 0x204FAca1…0498 takes the SIX-field ExactInputSingleParams (poolKey, zeroForOne, amountIn,
 * amountOutMinimum, a static uint256, hookData), not the five-field layout the old product encoded. Evidence, 2026-11-17:
 * the last 40 PoolManager Swaps sent by this router (blocks 116,850,710 to 116,852,735) include 26 successful
 * SWAP_EXACT_IN_SINGLE calls (e.g. 0x0df251dd…4b05, 0xc01db738…ecf9, and 0x9e13e5cb…ceaf on a Pons-hook pool); every one
 * decodes and re-encodes byte for byte as six fields with the uint256 = 0, and none as five (the same layout as Elysium's
 * router, apps/edge/src/trade.ts; the word is called `reserved` here and always 0). SETTLE_ALL (0x0c), TAKE (0x0e),
 * TAKE_ALL (0x0f) and the UNWRAP_WETH command (0x0c) appear in the same calls. The fork script executes these exact bytes.
 */
const V4_SWAP = 0x10, WRAP_ETH = 0x0b, UNWRAP_WETH = 0x0c;
const SWAP_EXACT_IN_SINGLE = 0x06, SETTLE_ALL = 0x0c, TAKE = 0x0e;
/** v4-periphery ActionConstants: ADDRESS_THIS is the router itself, OPEN_DELTA takes the whole credit, CONTRACT_BALANCE all it holds. */
const ADDRESS_THIS: Address = '0x0000000000000000000000000000000000000002', OPEN_DELTA = 0n, CONTRACT_BALANCE = 1n << 255n;
const poolKeyType = { type: 'tuple', name: 'poolKey', components: [{ name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'fee', type: 'uint24' },
  { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }] } as const;
const exactInputSingle = [{ type: 'tuple', components: [poolKeyType, { name: 'zeroForOne', type: 'bool' }, { name: 'amountIn', type: 'uint128' },
  { name: 'amountOutMinimum', type: 'uint128' }, { name: 'reserved', type: 'uint256' }, { name: 'hookData', type: 'bytes' }] }] as const;
const bytes = (...codes: number[]) => `0x${codes.map(c => c.toString(16).padStart(2, '0')).join('')}` as Hex;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const fail = (code: string, message: string, status = 409) => Object.assign(new Error(message), { code, status });
/** A Permit2 allowance lasts 25 minutes: the web app refuses one over 30, and this leaves room for clock drift (as on Elysium). */
export const PERMIT2_TTL_SEC = 1500;

function checkRoute(route: RobinhoodRoute) {
  if (route.kind === 'v4' && (route.key.currency0 !== zeroAddress || !same(route.key.currency1, route.token))) throw new Error('Only native-ETH pools of the coin are traded');
}

/**
 * The call for one exact-input trade, for the wallet to sign. `recipient` must be the wallet (never a router sentinel:
 * the curve pays it directly).
 * - Curve: `buy(amountIn, minOut, recipient)` with `amountIn` as the value, or `sell(amountIn, minOut, recipient)`. The
 *   curve has no deadline; `deadline` is ignored. Per the old product's notes, a buy that would cross graduation is
 *   clamped and the excess refunded to the caller (not exercised on the fork; robinhoodQuote never quotes such a buy).
 * - v4 buy: V4_SWAP [SWAP_EXACT_IN_SINGLE, SETTLE_ALL ETH (from the value), TAKE coin to recipient]. The minimum is
 *   enforced inside the swap.
 * - v4 sell: V4_SWAP [SWAP_EXACT_IN_SINGLE, SETTLE_ALL coin (through Permit2), TAKE ETH to the router], then WRAP_ETH
 *   and UNWRAP_WETH to the recipient with the minimum again. The round trip through WETH costs two WETH calls and makes
 *   the exact native payout a log (4663's WETH logs the unwrap as a Transfer to the zero address), which a direct TAKE
 *   of ETH never emits; see robinhoodFill. On the fork a $1 v4 sell used ~194k gas, the buy ~157k.
 */
export function buildRobinhoodSwap(route: RobinhoodRoute, side: 'buy' | 'sell', amountIn: bigint, minOut: bigint, recipient: Address, deadline: bigint,
  a: RobinhoodTradeAddresses): { to: Address; data: Hex; value: bigint } {
  if (amountIn <= 0n || minOut < 0n) throw new Error('Invalid trade amounts');
  if (BigInt(recipient) < 0x10000n) throw new Error('The recipient must be the wallet');
  const buy = side === 'buy';
  if (route.kind === 'curve') {
    return { to: route.curve, value: buy ? amountIn : 0n,
      data: encodeFunctionData({ abi: PONS_CURVE_ABI, functionName: side, args: [amountIn, minOut, recipient] }) };
  }
  checkRoute(route);
  if (amountIn >= 2n ** 128n || minOut >= 2n ** 128n) throw new Error('Invalid trade amounts');
  const { key } = route, paid = buy ? key.currency0 : key.currency1, received = buy ? key.currency1 : key.currency0;
  const swap = encodeAbiParameters(exactInputSingle, [{ poolKey: key, zeroForOne: buy, amountIn, amountOutMinimum: minOut, reserved: 0n, hookData: '0x' }]);
  const settle = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [paid, amountIn]);
  const take = encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], [received, buy ? recipient : ADDRESS_THIS, OPEN_DELTA]);
  const v4 = encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [bytes(SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE), [swap, settle, take]]);
  if (buy) return { to: a.universalRouter, value: amountIn, data: encodeFunctionData({ abi: universalRouterAbi, functionName: 'execute', args: [bytes(V4_SWAP), [v4], deadline] }) };
  const wrap = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [ADDRESS_THIS, CONTRACT_BALANCE]);
  const unwrap = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [recipient, minOut]);
  return { to: a.universalRouter, value: 0n,
    data: encodeFunctionData({ abi: universalRouterAbi, functionName: 'execute', args: [bytes(V4_SWAP, WRAP_ETH, UNWRAP_WETH), [v4, wrap, unwrap], deadline] }) };
}

/**
 * Every approval the trade needs, exact and never unlimited (the integrator drops the ones the wallet already holds; see
 * robinhoodHeldApprovals). Buys need none. A curve sell needs an ERC-20 approval of exactly `amountIn` to the curve (no
 * Permit2). A v4 sell needs the coin approved to Permit2, then a Permit2 allowance to the router that ends in 25 minutes.
 */
export function robinhoodApprovals(route: RobinhoodRoute, side: 'buy' | 'sell', amountIn: bigint, a: RobinhoodTradeAddresses, nowSec = Math.floor(Date.now() / 1000)): RobinhoodApproval[] {
  if (side === 'buy') return [];
  if (route.kind === 'curve') return [{ kind: 'erc20', token: route.token, spender: route.curve, amount: amountIn.toString() }];
  // Permit2 reads max uint160 as unlimited, so an exact amount must stay below it.
  if (amountIn >= 2n ** 160n - 1n) throw new Error('Invalid trade amounts');
  return [{ kind: 'erc20', token: route.token, spender: a.permit2, amount: amountIn.toString() },
    { kind: 'permit2', token: route.token, spender: a.universalRouter, amount: amountIn.toString(), expiration: nowSec + PERMIT2_TTL_SEC }];
}

/** The unsigned transaction for one approval from robinhoodApprovals. */
export function robinhoodApprovalTx(approval: RobinhoodApproval, a: RobinhoodTradeAddresses): { to: Address; data: Hex; value: bigint } {
  return approval.kind === 'erc20'
    ? { to: approval.token, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [approval.spender, BigInt(approval.amount)] }) }
    : { to: a.permit2, value: 0n, data: encodeFunctionData({ abi: permit2Abi, functionName: 'approve', args: [approval.token, approval.spender, BigInt(approval.amount), approval.expiration] }) };
}

const hex = (n: bigint) => `0x${n.toString(16)}`;
const call = async (rpc: Rpc, to: Address, data: Hex, block = 'latest') => await rpc.request({ method: 'eth_call', params: [{ to, data }, block] }) as Hex;
type CurveRead = 'getReserves' | 'sellableTokens' | 'realQuoteReserve' | 'feeBps' | 'creatorTaxBps' | 'graduated' | 'readyToGraduate' | 'token' | 'pairToken';
type CurveValue<F extends CurveRead> = F extends 'getReserves' ? readonly [bigint, bigint] : F extends 'graduated' | 'readyToGraduate' ? boolean : F extends 'token' | 'pairToken' ? Address : bigint;
async function readCurve<F extends CurveRead>(rpc: Rpc, curve: Address, functionName: F, block: string): Promise<CurveValue<F>> {
  const data = await call(rpc, curve, encodeFunctionData({ abi: PONS_CURVE_ABI, functionName } as never), block);
  return decodeFunctionResult({ abi: PONS_CURVE_ABI, functionName, data } as never) as CurveValue<F>;
}

/**
 * Drop the approvals the wallet already holds: an ERC-20 allowance of at least the amount, or a Permit2 allowance of at
 * least the amount with over two minutes left. Approvals that cannot be read are kept.
 */
export async function robinhoodHeldApprovals(rpc: Rpc, wallet: Address, approvals: RobinhoodApproval[], a: RobinhoodTradeAddresses, nowSec = Math.floor(Date.now() / 1000)): Promise<RobinhoodApproval[]> {
  const needed = await Promise.all(approvals.map(async ap => {
    try {
      if (ap.kind === 'erc20') return BigInt(await call(rpc, ap.token, encodeFunctionData({ abi: erc20Abi, functionName: 'allowance', args: [wallet, ap.spender] }))) < BigInt(ap.amount);
      const [amount, expiration] = decodeFunctionResult({ abi: permit2Abi, functionName: 'allowance',
        data: await call(rpc, a.permit2, encodeFunctionData({ abi: permit2Abi, functionName: 'allowance', args: [wallet, ap.token, ap.spender] })) });
      return amount < BigInt(ap.amount) || expiration <= nowSec + 120;
    } catch { return true; }
  }));
  return approvals.filter((_, i) => needed[i]);
}

/** A curve's pricing state: reserves (virtual quote included, pending fees excluded), what is left to buy, and its charges. */
export interface PonsCurveState {
  quoteReserve: bigint; tokenReserve: bigint; sellable: bigint; realQuote: bigint;
  feeBps: bigint; creatorTaxBps: bigint; snipeTaxBps: bigint; graduated: boolean; readyToGraduate: boolean;
}
/** Read one curve at a block (all reads pinned to it). A graduated curve returns its flags with zero reserves. */
export async function readPonsCurve(rpc: Rpc, route: Extract<RobinhoodRoute, { kind: 'curve' }>, block: bigint | 'latest' = 'latest'): Promise<PonsCurveState> {
  const at = typeof block === 'bigint' ? hex(block) : block;
  const [graduated, readyToGraduate, token, pair] = await Promise.all([readCurve(rpc, route.curve, 'graduated', at), readCurve(rpc, route.curve, 'readyToGraduate', at),
    readCurve(rpc, route.curve, 'token', at), readCurve(rpc, route.curve, 'pairToken', at)]);
  if (!same(token, route.token)) throw fail('route_unavailable', 'The curve does not belong to this coin');
  if (pair !== zeroAddress) throw fail('route_unavailable', 'Only native-ETH Pons curves are traded');
  const none = { quoteReserve: 0n, tokenReserve: 0n, sellable: 0n, realQuote: 0n, feeBps: 0n, creatorTaxBps: 0n, snipeTaxBps: 0n, graduated, readyToGraduate };
  if (graduated) return none;
  const snipe = encodeFunctionData({ abi: PONS_CURVE_ABI, functionName: 'currentSnipeTaxBps', args: [route.token] });
  const [[quoteReserve, tokenReserve], sellable, realQuote, feeBps, creatorTaxBps, snipeTaxBps] = await Promise.all([
    readCurve(rpc, route.curve, 'getReserves', at), readCurve(rpc, route.curve, 'sellableTokens', at), readCurve(rpc, route.curve, 'realQuoteReserve', at),
    readCurve(rpc, route.curve, 'feeBps', at), readCurve(rpc, route.curve, 'creatorTaxBps', at),
    call(rpc, route.curve, snipe, at).then(d => decodeFunctionResult({ abi: PONS_CURVE_ABI, functionName: 'currentSnipeTaxBps', data: d }))]);
  if (feeBps + snipeTaxBps + creatorTaxBps >= 10_000n || quoteReserve <= 0n || tokenReserve <= 0n || sellable > tokenReserve || realQuote > quoteReserve)
    throw fail('route_unavailable', 'The curve state is not valid');
  return { ...none, quoteReserve, tokenReserve, sellable, realQuote, feeBps, creatorTaxBps, snipeTaxBps };
}

/** Fee (curve fee plus any anti-snipe tax) and creator tax, each floored from the gross ETH leg. */
const charges = (s: PonsCurveState, gross: bigint) => {
  const fee = gross * (s.feeBps + s.snipeTaxBps) / 10_000n, tax = gross * s.creatorTaxBps / 10_000n;
  return { fee, tax, net: gross - fee - tax };
};
/**
 * Tokens a buy of `gross` wei gets: net = gross less fee and tax, tokens = ⌊net·T / (Q + net)⌋ (the curve's own integer
 * math, matched on the fork to the wei). `completes` when it would take the last sellable tokens: the curve then clamps
 * and refunds, which this does not model, so such a buy is not quoted.
 */
export function ponsBuyOut(s: PonsCurveState, gross: bigint) {
  const c = charges(s, gross), tokens = c.net * s.tokenReserve / (s.quoteReserve + c.net);
  return { ...c, tokens, completes: tokens >= s.sellable };
}
/** ETH a sell of `tokens` pays: gross = ⌊t·Q / (T + t)⌋, less fee and tax. `capacity` is false past the real ETH it holds. */
export function ponsSellOut(s: PonsCurveState, tokens: bigint) {
  const gross = tokens * s.quoteReserve / (s.tokenReserve + tokens), c = charges(s, gross);
  return { gross, fee: c.fee, tax: c.tax, out: c.net, capacity: gross <= s.realQuote };
}

/** Slot0 of a v4 pool from PoolManager storage (v4-core StateLibrary: `pools` is slot 6). */
export async function readV4Price(rpc: Rpc, key: V4PoolKey, a: RobinhoodTradeAddresses, block = 'latest'): Promise<{ sqrtPriceX96: bigint; tick: number }> {
  const slot = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [v4PoolId(key), 6n]));
  const word = BigInt(decodeFunctionResult({ abi: managerAbi, functionName: 'extsload',
    data: await call(rpc, a.poolManager, encodeFunctionData({ abi: managerAbi, functionName: 'extsload', args: [slot] }), block) }));
  const raw = Number((word >> 160n) & 0xffffffn);
  return { sqrtPriceX96: word & ((1n << 160n) - 1n), tick: raw >= 0x800000 ? raw - 0x1000000 : raw };
}

/**
 * Expected output, price impact and the venue's charges (both in basis points). Impact is the output's shortfall against
 * the same input at the price before the trade, the venue's fees excluded: a fee is a cost, not a price move, and the
 * expected output already includes it.
 * - Curve: the curve's integer math from its live reserves (matched on the fork to the wei). `feeBps` is the curve fee,
 *   any anti-snipe tax and the creator tax. A closed curve (graduated or graduating), one that cannot pay a sell, or a
 *   buy that would complete it throws.
 * - v4: the V4Quoter's exact output, hook fees included. Impact is measured against a quote of 1/1000 of the size, which
 *   pays the same proportional fees; `feeBps` is that small quote's shortfall against the pool's slot0 price. The Pons
 *   hook took ~2.95% each way on the fork (from the coin on a buy, from the ETH on a sell); measured against slot0 alone,
 *   a $1 trade's "impact" was 296 bps, nearly all of it that fee.
 */
export async function robinhoodQuote(rpc: Rpc, route: RobinhoodRoute, side: 'buy' | 'sell', amountIn: bigint, a: RobinhoodTradeAddresses): Promise<{ expectedOut: bigint; priceImpactBps: number; feeBps: number }> {
  if (amountIn <= 0n) throw fail('amount_out_of_range', 'Amount too small.', 400);
  const bps = (short: bigint, whole: bigint) => whole > 0n && short > 0n ? Number(short * 1_000_000n / whole) / 100 : 0;
  if (route.kind === 'curve') {
    const s = await readPonsCurve(rpc, route);
    if (s.graduated || s.readyToGraduate || s.sellable === 0n) throw fail('route_unavailable', 'The curve has closed; the coin trades in its pool.');
    const feeBps = Number(s.feeBps + s.snipeTaxBps + s.creatorTaxBps);
    if (side === 'buy') {
      const b = ponsBuyOut(s, amountIn);
      if (b.tokens <= 0n) throw fail('amount_out_of_range', 'Amount too small for this curve.', 400);
      if (b.completes) throw fail('route_unavailable', 'This buy would complete the curve; buy a smaller amount.');
      return { expectedOut: b.tokens, priceImpactBps: bps(b.net, s.quoteReserve + b.net), feeBps };
    }
    const o = ponsSellOut(s, amountIn);
    if (!o.capacity) throw fail('route_unavailable', 'The curve cannot pay out a sell of this size.');
    if (o.out <= 0n) throw fail('amount_out_of_range', 'Amount too small for this curve.', 400);
    return { expectedOut: o.out, priceImpactBps: bps(amountIn, s.tokenReserve + amountIn), feeBps };
  }
  checkRoute(route);
  if (amountIn >= 2n ** 128n) throw fail('amount_out_of_range', 'Amount too large.', 400);
  const buy = side === 'buy', ref = amountIn / 1000n;
  const quote = async (exactAmount: bigint) => decodeFunctionResult({ abi: v4QuoterAbi, functionName: 'quoteExactInputSingle',
    data: await call(rpc, a.quoter, encodeFunctionData({ abi: v4QuoterAbi, functionName: 'quoteExactInputSingle', args: [{ poolKey: route.key, zeroForOne: buy, exactAmount, hookData: '0x' }] })) })[0];
  const [expectedOut, refOut, price] = await Promise.all([
    quote(amountIn).catch(() => { throw fail('quote_failed', 'The pool would not quote this trade.'); }),
    ref > 0n ? quote(ref).catch(() => 0n) : 0n, readV4Price(rpc, route.key, a)]);
  if (price.sqrtPriceX96 === 0n) throw fail('route_unavailable', 'The pool is not initialized.');
  // currency0 is ETH: the price is coin per wei = sqrtP² / 2^192.
  const p2 = price.sqrtPriceX96 * price.sqrtPriceX96, atPrice = (x: bigint) => buy ? x * p2 >> 192n : (x << 192n) / p2;
  const atRef = refOut > 0n ? refOut * amountIn / ref : 0n;
  return { expectedOut, priceImpactBps: bps(atRef - expectedOut, atRef), feeBps: refOut > 0n ? bps(atPrice(ref) - refOut, atPrice(ref)) : 0 };
}

/**
 * What the wallet actually paid and got, from the receipt alone; null for a reverted call or a receipt without exactly
 * one matching trade by this wallet. Coin amounts are the wallet's net coin Transfers (a transfer tax included), never
 * a pool's figure.
 * - Curve: the single CurveBuy (buyer = wallet) gives `filledIn` = quoteIn, the gross ETH the curve kept, fee and tax
 *   included, and the coin received. The single CurveSell (seller = wallet) gives the coin sent and `filledOut` =
 *   quoteOut, the ETH paid after fee and tax. Both equal the balance changes on the fork. A buy the curve clamps at
 *   graduation refunds the excess; the old product read quoteIn as net of that refund, which the fork did not exercise
 *   (such a buy is never quoted).
 * - v4: the pool's Swap amounts are not what the wallet paid or got: the Pons hook takes its fee around the swap (the
 *   Elysium lesson; on the fork a $1 buy's Swap paid out 23,365 coin and the wallet received 22,676). A buy's `filledIn`
 *   is therefore absent: the integrator records the transaction's value, which SETTLE_ALL spends whole. A sell's
 *   `filledOut` is the router's WETH unwrap to the wallet, exact; if that log is missing (a call not built by
 *   buildRobinhoodSwap) it is absent and the integrator measures the wallet's balance change instead.
 */
export function robinhoodFill(receipt: Receipt, route: RobinhoodRoute, side: 'buy' | 'sell', wallet: Address,
  a: RobinhoodTradeAddresses = registryAddresses()): { filledIn?: bigint; filledOut?: bigint } | null {
  if (receipt.status !== '0x1') return null;
  let received = 0n, sent = 0n, burned = 0n, withdrawn = 0n;
  const legs: { party: string; tokens: bigint; eth: bigint }[] = [], swaps: string[] = [];
  const poolId = route.kind === 'v4' ? v4PoolId(route.key).toLowerCase() : null;
  for (const l of receipt.logs) {
    try {
      if (same(l.address, route.token)) {
        const ev = decodeEventLog({ abi: erc20Abi, eventName: 'Transfer', topics: l.topics as [Hex, ...Hex[]], data: l.data, strict: true });
        if (same(ev.args.to, wallet)) received += ev.args.value;
        if (same(ev.args.from, wallet)) sent += ev.args.value;
      } else if (route.kind === 'curve' && same(l.address, route.curve)) {
        const ev = decodeEventLog({ abi: PONS_CURVE_ABI, topics: l.topics as [Hex, ...Hex[]], data: l.data, strict: true });
        if (ev.eventName === 'CurveBuy' && side === 'buy') legs.push({ party: ev.args.buyer, tokens: ev.args.tokensOut, eth: ev.args.quoteIn });
        if (ev.eventName === 'CurveSell' && side === 'sell') legs.push({ party: ev.args.seller, tokens: ev.args.tokensIn, eth: ev.args.quoteOut });
      } else if (route.kind === 'v4' && same(l.address, a.poolManager)) {
        const ev = decodeEventLog({ abi: managerAbi, eventName: 'Swap', topics: l.topics as [Hex, ...Hex[]], data: l.data, strict: true });
        if (ev.args.id.toLowerCase() === poolId) swaps.push(ev.args.sender);
      } else if (route.kind === 'v4' && same(l.address, a.weth)) {
        // 4663's WETH logs a wrap as Transfer(0 → router) and an unwrap as Transfer(router → 0), with no Deposit or
        // Withdrawal (seen on the fork). A WETH9 would log Withdrawal(src, wad); either counts, never both.
        const ev = decodeEventLog({ abi: wethAbi, topics: l.topics as [Hex, ...Hex[]], data: l.data, strict: true });
        if (ev.eventName === 'Withdrawal' && same(ev.args.src, a.universalRouter)) withdrawn += ev.args.wad;
        if (ev.eventName === 'Transfer' && same(ev.args.from, a.universalRouter) && ev.args.to === zeroAddress) burned += ev.args.value;
      }
    } catch { /* another event of the same contract */ }
  }
  if (route.kind === 'curve') {
    if (legs.length !== 1 || !same(legs[0]!.party, wallet)) return null;
    const leg = legs[0]!;
    if (side === 'buy') return received > sent ? { filledIn: leg.eth, filledOut: received - sent } : null;
    return sent > received ? { filledIn: sent - received, filledOut: leg.eth } : null;
  }
  if (swaps.length !== 1 || !same(swaps[0]!, a.universalRouter)) return null;
  if (side === 'buy') return received > sent ? { filledOut: received - sent } : null;
  if (sent <= received) return null;
  const unwrapped = withdrawn || burned;
  return unwrapped > 0n ? { filledIn: sent - received, filledOut: unwrapped } : { filledIn: sent - received };
}

/** The Pons graduation pool of a coin: native ETH and the coin, fee 0, tick spacing 200, the Pons hook (every Pons-hook pool initialized on 4663 to 2026-11-17). */
export const ponsPoolKey = (token: Address, ponsHook: Address): V4PoolKey => ({ currency0: zeroAddress, currency1: getAddress(token), fee: 0, tickSpacing: 200, hooks: getAddress(ponsHook) });

/**
 * Where a Pons coin trades now: its curve while open, its graduation pool once graduated (checked initialized in the
 * PoolManager). A curve that is full but not yet graduated trades nowhere and throws.
 */
export async function robinhoodRoute(rpc: Rpc, coin: { token: Address; curve: Address }, a: RobinhoodTradeAddresses & { ponsHook: Address }): Promise<RobinhoodRoute> {
  const curve: RobinhoodRoute = { kind: 'curve', curve: getAddress(coin.curve), token: getAddress(coin.token) };
  const s = await readPonsCurve(rpc, curve);
  if (!s.graduated) {
    if (s.readyToGraduate || s.sellable === 0n) throw fail('route_unavailable', 'The curve is graduating to its pool; try again shortly.', 503);
    return curve;
  }
  const key = ponsPoolKey(coin.token, a.ponsHook);
  if ((await readV4Price(rpc, key, a)).sqrtPriceX96 === 0n) throw fail('route_unavailable', 'The graduation pool could not be found.', 503);
  return { kind: 'v4', key, token: curve.token };
}
