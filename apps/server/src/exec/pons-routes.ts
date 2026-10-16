import { withRpcOrigin } from '@eko/chain';
import { decodeEventLog, decodeFunctionData, encodeFunctionData, formatUnits, padHex, parseAbi, zeroAddress,
  type Address, type Hex, type PublicClient } from 'viem';
import { loadRegistry } from '@eko/chain';
import { binary, hex, type SqlClient } from '@eko/db';
import type { TradeQuoteRequest, UnsignedTx } from '@eko/shared';
import { ChainQuoteError, ERC20_ABI, rawUsd, type V3TradeRoute, type V3TradeSources } from './v3-routes.js';
import { TradeError, type RetainedTrade } from './trades.js';
import type { ActualFill, TradeReceipt } from './trade-reconcile.js';

// Native-ETH Pons v2 bonding-curve routes for the v1 live trade path (packets 072/075/076). The pricing is the curve's
// own integer math (docs/guard/research/pons-executable-notes.md), matched exactly against deployed curves on a fork:
// a buy gives floor(net × T / (Q + net)) tokens and a sell floor(t × Q / (T + t)) gross, where Q and T are the curve's
// pricing reserves (`getReserves()`, virtual quote included) and fee and creator tax are each floored from the gross
// quote leg. Every read is pinned to the quote block on the API's metered client; nothing here signs or simulates.
const registry = loadRegistry();
const lower = (a: string) => a.toLowerCase() as Address;
const same = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
export const PONS_FACTORY = lower(registry.requireAddress('pons.factory'));
const WETH = lower(registry.requireAddress('tokens.WETH'));

/** Deployed curve interface. buy/sell/getReserves/sellableTokens/realQuoteReserve/fee getters/graduation flags are the
 * lead-verified selectors (packages/chain/abi/pons/execution.json); token()/pairToken()/factory() and both events were
 * read from and decoded against deployed curves. */
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
  'function factory() view returns (address)',
  'event CurveBuy(address indexed buyer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 tax)',
  'event CurveSell(address indexed seller, address indexed recipient, uint256 tokensIn, uint256 quoteOut, uint256 fee, uint256 tax)',
]);
/** Network-fee sizing only (measured on a fork: ~100k gas per buy, ~82k per sell); the simulation measures the real gas. */
export const PONS_GAS_ESTIMATE = 150_000n;

/** The coin's curve from indexed launch state (the factory's TokenLaunched log) and the indexer's graduation record. */
export interface IndexedPonsCurve { curve: Address; graduatedBlock: bigint | null; graduatedPool: Hex | null }
export interface PonsTradeSources extends Pick<V3TradeSources, 'priceUsd' | 'networkFeeWei'> {
  curve(coin: Address): Promise<IndexedPonsCurve | null>;
}
/** Read the indexed Pons curve of a coin, or null for a coin with no curve. Query failures reject. */
export function indexedPonsCurves(sql: SqlClient): PonsTradeSources['curve'] {
  return async coin => {
    const { rows } = await sql.query<{ curve: Uint8Array; graduated_block: string | null; graduated_pool: Uint8Array | null }>(
      `SELECT curve,graduated_block,graduated_pool FROM tokens WHERE address=$1 AND launchpad='pons' AND curve IS NOT NULL`, [binary(coin)]);
    const row = rows[0];
    return row ? { curve: lower(hex(row.curve)), graduatedBlock: row.graduated_block == null ? null : BigInt(row.graduated_block),
      graduatedPool: row.graduated_pool ? hex(row.graduated_pool) : null } : null;
  };
}
/** The indexer recorded the coin's graduation pool at or before `block`. */
export const indexedGraduated = (c: IndexedPonsCurve, block: bigint) => c.graduatedBlock !== null && c.graduatedBlock <= block;

/**
 * A Pons coin whose curve no longer trades (graduated, or not a Pons coin at all): the venue picker hands the quote to
 * the pool routes instead. Never thrown for a curve that is open, so a dead curve is never quoted.
 */
export class PonsHandoff extends ChainQuoteError {
  /** Name why the curve cannot quote; a stray handoff still surfaces as `no_route`. No request is made. */
  constructor(readonly reason: 'not_pons' | 'graduated') { super('no_route', reason === 'graduated' ? 'The curve graduated to its pool' : 'Not a Pons curve coin'); }
}

export interface PonsCurveState {
  coin: Address; curve: Address; block: bigint; graduated: boolean; readyToGraduate: boolean;
  /** Pricing reserves: virtual + real quote (pending fees excluded) and tracked tokens. */
  quoteReserve: bigint; tokenReserve: bigint;
  /** Tokens a buy can still take before graduation, and the real quote a sell can be paid from. */
  sellable: bigint; realQuote: bigint;
  feeBps: bigint; creatorTaxBps: bigint; snipeTaxBps: bigint; decimals: number;
}
/** The curve is still trading: not graduated, not waiting to graduate, and with tokens left to buy. */
export const ponsOpen = (s: PonsCurveState) => !s.graduated && !s.readyToGraduate && s.sellable > 0n;

/**
 * Read one curve at a pinned block and check it is the coin's native-ETH curve from the Pons factory. A mismatch is
 * `no_route`; provider failures reject. A graduated curve returns its flags only (its reserves are gone).
 */
export async function readPonsCurve(client: Pick<PublicClient, 'readContract'>, coin: Address, curve: Address, block: bigint): Promise<PonsCurveState> {
  const at = { address: curve, abi: PONS_CURVE_ABI, blockNumber: block } as const;
  const [token, factory, pair, graduated, readyToGraduate] = await Promise.all([
    withRpcOrigin('server.pons_routes.L89.c1',()=>client.readContract({ ...at, functionName: 'token' })), withRpcOrigin('server.pons_routes.L89.c2',()=>client.readContract({ ...at, functionName: 'factory' })),
    withRpcOrigin('server.pons_routes.L90.c1',()=>client.readContract({ ...at, functionName: 'pairToken' })), withRpcOrigin('server.pons_routes.L90.c2',()=>client.readContract({ ...at, functionName: 'graduated' })),
    withRpcOrigin('server.pons_routes.L91',()=>client.readContract({ ...at, functionName: 'readyToGraduate' })),
  ]);
  if (!same(token, coin) || !same(factory, PONS_FACTORY)) throw new ChainQuoteError('no_route', 'The indexed curve does not belong to this coin');
  if (!same(pair, zeroAddress)) throw new ChainQuoteError('no_route', 'Only native-ETH Pons curves are supported');
  const base = { coin: lower(coin), curve: lower(curve), block, graduated, readyToGraduate };
  if (graduated) return { ...base, quoteReserve: 0n, tokenReserve: 0n, sellable: 0n, realQuote: 0n, feeBps: 0n, creatorTaxBps: 0n, snipeTaxBps: 0n, decimals: 18 };
  const [[quoteReserve, tokenReserve], sellable, realQuote, feeBps, creatorTaxBps, snipeTaxBps, decimals] = await Promise.all([
    withRpcOrigin('server.pons_routes.L98.c1',()=>client.readContract({ ...at, functionName: 'getReserves' })), withRpcOrigin('server.pons_routes.L98.c2',()=>client.readContract({ ...at, functionName: 'sellableTokens' })),
    withRpcOrigin('server.pons_routes.L99.c1',()=>client.readContract({ ...at, functionName: 'realQuoteReserve' })), withRpcOrigin('server.pons_routes.L99.c2',()=>client.readContract({ ...at, functionName: 'feeBps' })),
    withRpcOrigin('server.pons_routes.L100.c1',()=>client.readContract({ ...at, functionName: 'creatorTaxBps' })), withRpcOrigin('server.pons_routes.L100.c2',()=>client.readContract({ ...at, functionName: 'currentSnipeTaxBps', args: [coin] })),
    withRpcOrigin('server.pons_routes.L101',()=>client.readContract({ address: coin, abi: ERC20_ABI, functionName: 'decimals', blockNumber: block })),
  ]);
  if ([feeBps, creatorTaxBps, snipeTaxBps].some(bps => bps < 0n || bps > 10_000n) || feeBps + creatorTaxBps >= 10_000n)
    throw new ChainQuoteError('no_route', 'Invalid Pons fee terms');
  if (quoteReserve <= 0n || tokenReserve <= 0n || sellable > tokenReserve || realQuote > quoteReserve || !Number.isInteger(decimals) || decimals > 77)
    throw new ChainQuoteError('no_route', 'Invalid Pons curve state');
  return { ...base, quoteReserve, tokenReserve, sellable, realQuote, feeBps, creatorTaxBps, snipeTaxBps, decimals };
}

const charges = (s: PonsCurveState, gross: bigint) => {
  const fee = gross * s.feeBps / 10_000n, tax = gross * s.creatorTaxBps / 10_000n;
  return { fee, tax, net: gross - fee - tax };
};
/** Tokens a native buy of `gross` wei receives at this state; `completes` when it would take the last sellable tokens. */
export function ponsBuyOut(s: PonsCurveState, gross: bigint) {
  const c = charges(s, gross), tokens = c.net * s.tokenReserve / (s.quoteReserve + c.net);
  return { ...c, tokens, completes: tokens >= s.sellable,
    after: { ...s, quoteReserve: s.quoteReserve + c.net, tokenReserve: s.tokenReserve - tokens, sellable: s.sellable - tokens, realQuote: s.realQuote + c.net } };
}
/** Native ETH a sell of `tokens` pays out (gross less fee and tax); `capacity` is false when the real quote cannot pay it. */
export function ponsSellOut(s: PonsCurveState, tokens: bigint) {
  const gross = tokens * s.quoteReserve / (s.tokenReserve + tokens), c = charges(s, gross);
  return { gross, fee: c.fee, tax: c.tax, out: c.net, capacity: gross <= s.realQuote };
}
function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n, y = (n + 1n) / 2n;
  while (y < x) { x = y; y = (x + n / x) / 2n; }
  return x;
}
/**
 * ±2% buy depth (Guard 2.0 §3.4, market-only, fees separate): the largest net quote input that moves the marginal price
 * Q/T by at most 2%. A buy of x moves it by ((Q + x) / Q)², so x = ⌊√(1.02·Q²)⌋ − Q, capped by the tokens left to buy.
 */
export function ponsDepthWei(s: PonsCurveState): bigint {
  const depth = isqrt(s.quoteReserve * s.quoteReserve * 102n / 100n) - s.quoteReserve;
  const reserved = s.tokenReserve - s.sellable;
  return reserved > 0n ? [depth, s.sellable * s.quoteReserve / reserved].reduce((a, b) => a < b ? a : b) : depth;
}

export interface PonsCallTerms { side: 'buy' | 'sell'; amountIn: bigint; minOut: bigint; recipient: Address }
/** Exact curve calldata for one buy or sell. */
export function ponsTradeCall(t: PonsCallTerms): Hex {
  return encodeFunctionData({ abi: PONS_CURVE_ABI, functionName: t.side, args: [t.amountIn, t.minOut, t.recipient] });
}
/** Decode a curve buy/sell exactly (no trailing bytes); anything else is null. */
export function ponsCallTerms(data: Hex): PonsCallTerms | null {
  try {
    const call = decodeFunctionData({ abi: PONS_CURVE_ABI, data });
    if (call.functionName !== 'buy' && call.functionName !== 'sell') return null;
    const [amountIn, minOut, recipient] = call.args as readonly [bigint, bigint, Address];
    const terms: PonsCallTerms = { side: call.functionName, amountIn, minOut, recipient: lower(recipient) };
    return ponsTradeCall(terms).toLowerCase() === data.toLowerCase() ? terms : null;
  } catch { return null; }
}

export interface PonsTradeRoute extends V3TradeRoute {
  state: PonsCurveState;
  /** Venue charges at this size from the curve math: creator tax per leg and the round-trip (buy) or exit (sell) cost. */
  costs: { buyTaxPct: number; sellTaxPct: number; exitCostPct: number };
}
const positive = (n: number | null): n is number => n !== null && Number.isFinite(n) && n > 0;
const pct = (part: bigint, whole: bigint) => whole > 0n ? Number(part * 1_000_000n / whole) / 10_000 : 0;

/**
 * Unsigned zero-terminal-fee route on the coin's open native Pons curve, like quoteV3Trade: validate amount and
 * slippage, read the curve at one block, size the input at the block's ETH-USD (sells at the curve's marginal price),
 * and build the exact buy/sell bytes to the wallet. A graduated curve throws PonsHandoff so the pool routes quote it; a
 * curve that is graduating or too shallow for the size refuses `no_route`, and one still in its anti-snipe window
 * `anti_snipe_active`. The route stays executable=false: acquisition binds and simulates it separately.
 */
export async function quotePonsTrade(client: PublicClient, input: TradeQuoteRequest, sources: PonsTradeSources, now = Date.now): Promise<PonsTradeRoute> {
  if (!positive(input.amountUsd)) throw new ChainQuoteError('bad_request', 'Amount must be positive and finite');
  if (!Number.isInteger(input.slippageBps) || input.slippageBps < 0 || input.slippageBps >= 10_000)
    throw new ChainQuoteError('bad_request', 'Slippage must be an integer from 0 to 9999 bps');
  const coin = lower(input.coin), indexed = await sources.curve(coin);
  if (!indexed) throw new PonsHandoff('not_pons');
  // Always the current head (as quoteV3Trade): a quote right after the wallet's exact approval must see it.
  const block = await client.getBlockNumber({ cacheTime: 0 });
  if (block > BigInt(Number.MAX_SAFE_INTEGER)) throw new ChainQuoteError('stale_data', 'Block is out of range');
  if (indexedGraduated(indexed, block)) throw new PonsHandoff('graduated');
  const quotedAt = now();
  const s = await readPonsCurve(client, coin, indexed.curve, block);
  if (s.graduated) throw new PonsHandoff('graduated');
  if (!ponsOpen(s)) throw new ChainQuoteError('no_route', 'The curve is graduating to its pool; quote again shortly');
  // TODO(spec): the deployed anti-snipe application is unverified (072); the 3-second launch window refuses instead.
  if (s.snipeTaxBps !== 0n) throw new TradeError('anti_snipe_active', 'The launch anti-snipe tax is active; quote again in a few seconds');
  const ethUsd = await sources.priceUsd(WETH, block);
  if (!positive(ethUsd)) throw new ChainQuoteError('stale_data', 'ETH USD price unavailable');
  const wei = rawUsd(input.amountUsd, ethUsd, 18);
  const recipient = input.account ? lower(input.account) : padHex('0x01', { size: 20 });
  let amountIn: bigint, expectedOut: bigint, impactBps: number, exitCostPct: number;
  if (input.side === 'buy') {
    amountIn = wei;
    const b = ponsBuyOut(s, amountIn);
    if (b.tokens <= 0n) throw new ChainQuoteError('no_route', 'Amount is too small for this curve');
    if (b.completes) throw new ChainQuoteError('no_route', 'This buy would complete the curve; buy a smaller amount');
    const back = ponsSellOut(b.after, b.tokens);
    expectedOut = b.tokens;
    impactBps = pct(b.net, s.quoteReserve + b.net) * 100;
    exitCostPct = pct(amountIn - (back.capacity ? back.out : 0n), amountIn);
  } else {
    amountIn = wei * s.tokenReserve / s.quoteReserve;
    if (amountIn <= 0n) throw new ChainQuoteError('bad_request', 'Amount is outside token unit range');
    const sold = ponsSellOut(s, amountIn);
    if (!sold.capacity) throw new ChainQuoteError('no_route', 'The curve cannot pay out a sell of this size');
    if (sold.out <= 0n) throw new ChainQuoteError('no_route', 'Amount is too small for this curve');
    const ideal = amountIn * s.quoteReserve / s.tokenReserve;
    expectedOut = sold.out;
    impactBps = pct(amountIn, s.tokenReserve + amountIn) * 100;
    exitCostPct = pct(ideal - sold.out, ideal);
  }
  if (amountIn >= 2n ** 256n) throw new ChainQuoteError('bad_request', 'Amount is outside token unit range');
  const minOut = expectedOut * BigInt(10_000 - input.slippageBps) / 10_000n;
  if (minOut <= 0n) throw new ChainQuoteError('no_route', 'Minimum output rounds to zero');
  const approvalNeeded = input.side === 'sell' && (!input.account ||
    await withRpcOrigin('server.pons_routes.L217',()=>client.readContract({ address: coin, abi: ERC20_ABI, functionName: 'allowance', args: [recipient, s.curve], blockNumber: block })) < amountIn);
  const tx: UnsignedTx = { chainId: 4663, to: s.curve, value: input.side === 'buy' ? amountIn.toString() : '0',
    data: ponsTradeCall({ side: input.side, amountIn, minOut, recipient }) };
  const feeWei = await sources.networkFeeWei(tx, PONS_GAS_ESTIMATE, block);
  if (feeWei === null || feeWei < 0n) throw new ChainQuoteError('sim_unavailable', 'Total network fee estimate unavailable');
  const taxPct = Number(s.creatorTaxBps) / 100;
  return {
    amountIn: amountIn.toString(), valueWei: tx.value, expectedOut: expectedOut.toString(), minOut: minOut.toString(),
    networkFeeUsd: Number(formatUnits(feeWei, 18)) * ethUsd, priceImpactBps: impactBps,
    // Construction alone is never an accepted probe or account-bound preflight.
    route: { venue: 'pons_curve', poolId: s.curve, executable: false },
    // Pons curve trades carry no terminal fee and no EKO fee leg (FACTS §5b, 072).
    fee: { bps: 0, usd: 0, destination: null },
    approvals: approvalNeeded ? [{ token: coin, spender: s.curve, amount: amountIn.toString(), kind: 'erc20' }] : [],
    asOfBlock: Number(block), expiresAt: new Date(quotedAt + 20_000).toISOString(), tx,
    state: s, costs: { buyTaxPct: taxPct, sellTaxPct: taxPct, exitCostPct },
  };
}

/**
 * The actual fill of a retained curve order from its receipt. Exactly one CurveBuy/CurveSell from the quoted curve by
 * and to the wallet proves execution; the wallet's coin Transfer logs measure the tokens it actually received or sent
 * (any transfer tax included). A buy's input is the event's quoteIn (a clamped buy's refund excluded); a sell's output
 * is the event's quoteOut, the native ETH paid to the wallet after curve fee and creator tax. Anything else is null.
 */
export function decodePonsFill(retained: RetainedTrade, receipt: TradeReceipt): ActualFill | null {
  const q = retained.quote, b = retained.checked?.order.execution;
  if (!b || q.route.venue !== 'pons_curve' || !q.route.executable || !q.route.poolId || !same(b.tx.to, q.route.poolId)) return null;
  const terms = ponsCallTerms(b.tx.data);
  if (!terms || terms.side !== q.side || !same(terms.recipient, b.account)) return null;
  const curve = q.route.poolId;
  type Leg = { party: Address; recipient: Address; tokens: bigint; quote: bigint };
  const buys: Leg[] = [], sells: Leg[] = [];
  let received = 0n, sent = 0n;
  for (const log of receipt.logs) {
    if (log.removed || log.transactionHash !== receipt.transactionHash || log.blockHash !== receipt.blockHash) return null;
    try {
      if (same(log.address, curve)) {
        const ev = decodeEventLog({ abi: PONS_CURVE_ABI, data: log.data, topics: log.topics });
        if (ev.eventName === 'CurveBuy') buys.push({ party: ev.args.buyer, recipient: ev.args.recipient, tokens: ev.args.tokensOut, quote: ev.args.quoteIn });
        if (ev.eventName === 'CurveSell') sells.push({ party: ev.args.seller, recipient: ev.args.recipient, tokens: ev.args.tokensIn, quote: ev.args.quoteOut });
      } else if (same(log.address, q.coin)) {
        const ev = decodeEventLog({ abi: ERC20_ABI, data: log.data, topics: log.topics });
        if (ev.eventName === 'Transfer') {
          if (same(ev.args.to, b.account)) received += ev.args.value;
          if (same(ev.args.from, b.account)) sent += ev.args.value;
        }
      }
    } catch { /* unrelated event; absence of the required event refuses the fill */ }
  }
  const legs = q.side === 'buy' ? buys : sells;
  if (legs.length !== 1 || buys.length + sells.length !== 1) return null;
  const leg = legs[0]!;
  if (!same(leg.party, b.account) || !same(leg.recipient, b.account) || leg.tokens <= 0n || leg.quote <= 0n) return null;
  if (q.side === 'buy') {
    if (leg.quote > BigInt(b.tx.value) || received <= sent || received - sent > leg.tokens) return null;
    return { filledIn: leg.quote.toString(), filledOut: (received - sent).toString() };
  }
  if (sent <= received || sent - received < leg.tokens) return null;
  return { filledIn: (sent - received).toString(), filledOut: leg.quote.toString() };
}
