import { decodeFunctionResult, encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, toHex, zeroAddress, type Address, type Hex } from 'viem';
import type { V4PoolKey } from '@eko/chain';
import { notTraders, tradeWallets } from '../../flow-stats.js';
import { launchInsiders, linkedToDev, ROLE_ORDER, type InsiderOptions } from '../../insiders.js';
import { priceHypeFromSqrt } from '../../market.js';
import { PONS_CURVE_ABI, ponsSellOut, type PonsCurveState } from '../../chains/robinhood/trade.js';
import type { CoinState, Rpc } from '../../tracker.js';

/**
 * The dump test's math (flag dump_test): who holds a coin's insider tokens now, and what the price would do if each
 * group sold everything it holds at once. Pure except `readCurve` and `quoterDump`, each one Multicall3 eth_call.
 *
 * Groups, each wallet counted once, in its first group in this order (insiders.ts names the roles):
 * - dev: the deployer.
 * - linked ("dev-funded"): a wallet whose traced first funding came from the deployer or the deployer's funder
 *   (linkedToDev), looked up for the LINK_LOOKUPS largest holders.
 * - bundle: a wallet in a launch bundle (bundles.ts, or a shared funder in bundle_dump's window).
 * - sniper: a net buyer in the chain's launch window (snipers.ts).
 * - early: any other wallet that bought in the first EARLY_SEC seconds (holders.ts' early-buyer cohort) and still holds.
 * Balances are the sums of the coin's transfers (no RPC), so they are only whole on a history from launch: the caller
 * gives no figure otherwise.
 *
 * "Price change" is the venue's marginal price after the sell against before, fees aside (a fee is a cost, not a price
 * move). "Your $100" is what a $100 holding at today's price would sell for right after the dump, the venue's sell fee
 * and tax taken off: the figure a holder keeps.
 */
export const GROUPS = ['dev', 'linked', 'bundle', 'sniper', 'early'] as const;
export type GroupId = (typeof GROUPS)[number];
/** Holders' early-buyer cohort (holders.ts flowStats cohortSec). */
export const EARLY_SEC = 60;
/** Largest holders whose funding is looked up for a tie to the deployer. */
export const LINK_LOOKUPS = 300;
/**
 * The Pons hook's after-swap cut on a sell, taken from the ETH out. Measured at ~2.95% each way on the fork
 * (chains/robinhood/trade.ts robinhoodQuote); docs/robinhood/CHAIN-FACTS.md lists its size as not measured on chain.
 * It only sets "your $100", never the price change (the cut does not touch the pool's reserves).
 */
export const PONS_HOOK_SELL_FEE = 0.0295;

const multicallAbi = parseAbi(['struct Call3 { address target; bool allowFailure; bytes callData; }', 'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[] returnData)']);
export const quoterAbi = parseAbi([
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }',
  'function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)',
]);
type Call = { target: Address; allowFailure: boolean; callData: Hex };
/** One eth_call through Multicall3; each part may fail on its own (null). Read-only: nothing is signed or sent. */
export async function multicall(rpc: Rpc, multicall3: Address, calls: Call[]): Promise<(Hex | null)[]> {
  const out = await rpc.request({ method: 'eth_call', params: [{ to: multicall3, data: encodeFunctionData({ abi: multicallAbi, functionName: 'aggregate3', args: [calls] }), gas: toHex(30_000_000n) }, 'latest'] }) as Hex;
  return decodeFunctionResult({ abi: multicallAbi, functionName: 'aggregate3', data: out }).map(r => r.success ? r.returnData : null);
}
/** USD to wei at `ethUsd`, as the trade quote converts an amount. */
export const weiFor = (usd: number, ethUsd: number) => BigInt(Math.floor((usd / ethUsd) * 1e6)) * 10n ** 12n;
const notMeasured = (message: string) => Object.assign(new Error(message), { code: 'not_measured' });

/** A Pons curve's pricing state in one call (the reads and checks of readPonsCurve). Throws for a closed or invalid curve. */
export async function readCurve(rpc: Rpc, multicall3: Address, route: { curve: Address; token: Address }): Promise<PonsCurveState> {
  const fns = ['graduated', 'readyToGraduate', 'token', 'pairToken', 'getReserves', 'sellableTokens', 'realQuoteReserve', 'feeBps', 'creatorTaxBps', 'currentSnipeTaxBps'] as const;
  const data = (fn: (typeof fns)[number]) => fn === 'currentSnipeTaxBps'
    ? encodeFunctionData({ abi: PONS_CURVE_ABI, functionName: fn, args: [route.token] }) : encodeFunctionData({ abi: PONS_CURVE_ABI, functionName: fn } as never);
  const raw = await multicall(rpc, multicall3, fns.map(fn => ({ target: route.curve, allowFailure: true, callData: data(fn) })));
  if (raw.some(r => r === null)) throw notMeasured('The curve could not be read.');
  const read = <T>(i: number) => decodeFunctionResult({ abi: PONS_CURVE_ABI, functionName: fns[i], data: raw[i]! } as never) as T;
  const graduated = read<boolean>(0), readyToGraduate = read<boolean>(1), token = read<Address>(2), pair = read<Address>(3);
  if (token.toLowerCase() !== route.token.toLowerCase() || pair !== zeroAddress) throw notMeasured('Not a native-ETH curve of this coin.');
  if (graduated || readyToGraduate) throw notMeasured('The curve has closed.');
  const [quoteReserve, tokenReserve] = read<readonly [bigint, bigint]>(4);
  const s: PonsCurveState = { quoteReserve, tokenReserve, sellable: read<bigint>(5), realQuote: read<bigint>(6), feeBps: read<bigint>(7), creatorTaxBps: read<bigint>(8),
    snipeTaxBps: read<bigint>(9), graduated, readyToGraduate };
  if (s.feeBps + s.snipeTaxBps + s.creatorTaxBps >= 10_000n || quoteReserve <= 0n || tokenReserve <= 0n || s.sellable > tokenReserve || s.realQuote > quoteReserve)
    throw notMeasured('The curve state is not valid.');
  return s;
}

export interface GroupHolding { wallets: number; tokens: bigint }
export interface Holdings {
  groups: Record<GroupId, GroupHolding>;
  all: GroupHolding;
  /** Every insider wallet (lowercase), holding or not: a transfer touching one makes the figure due early. */
  insiders: Set<string>;
}

/** The coin's insiders' holdings now, by group (each wallet in its first group), from the coin's transfers. */
export function insiderHoldings(coin: CoinState, o: InsiderOptions): Holdings {
  const skip = notTraders(coin, o.excluded), balance = new Map<string, bigint>();
  for (const f of coin.flows) {
    balance.set(f.from, (balance.get(f.from) ?? 0n) - f.value);
    balance.set(f.to, (balance.get(f.to) ?? 0n) + f.value);
  }
  const launch = launchInsiders(coin, o), creator = coin.creator.toLowerCase();
  const role = new Map<string, GroupId>();
  for (const [w, roles] of launch) { const r = ROLE_ORDER.find(x => roles.has(x)); if (r) role.set(w, r); }
  // Dev-funded: the largest holders not already named, looked up one by one (the store answers from memory or SQLite).
  if (o.funding) {
    const ranked = [...balance].filter(([w, v]) => v > 0n && !skip.has(w) && w !== creator).sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0));
    for (const [w] of ranked.slice(0, LINK_LOOKUPS)) {
      const now = role.get(w);
      if (now === 'dev') continue;
      if (linkedToDev(coin, w, o.funding)) role.set(w, 'linked');
    }
  }
  // Early buyers: the wallet behind each buy in the first EARLY_SEC seconds.
  const early = coin.trades.filter(t => t.side === 'buy' && t.ts - coin.ts < EARLY_SEC);
  if (early.length) {
    const wallets = tradeWallets(coin, new Set(early.map(t => t.tx.toLowerCase())), o.excluded);
    for (const t of early) { const w = wallets.get(t.tx.toLowerCase())?.buy; if (w && !role.has(w)) role.set(w, 'early'); }
  }
  const groups = Object.fromEntries(GROUPS.map(g => [g, { wallets: 0, tokens: 0n }])) as Record<GroupId, GroupHolding>;
  const all: GroupHolding = { wallets: 0, tokens: 0n }, insiders = new Set<string>();
  for (const [w, g] of role) {
    if (skip.has(w) && w !== creator) continue;
    insiders.add(w);
    const held = balance.get(w) ?? 0n;
    if (held <= 0n) continue;
    groups[g].wallets++; groups[g].tokens += held; all.wallets++; all.tokens += held;
  }
  return { groups, all, insiders };
}

/** What one sell does: the price change (percent, negative), what $100 held keeps, and whether the venue runs dry. */
export interface DumpOutcome { changePct: number; usd100: number; drains: boolean }

const round1 = (n: number) => Math.round(n * 10) / 10, round2 = (n: number) => Math.round(n * 100) / 100;
const ratioOf = (a: bigint, b: bigint) => b > 0n ? Number((a * 10n ** 12n) / b) / 1e12 : 0;
const outcome = (priceRatio: number, keep: number, drains = false): DumpOutcome => {
  const fall = round1(Math.min(100, Math.max(0, (1 - priceRatio) * 100)));
  return { changePct: fall === 0 ? 0 : -fall, usd100: round2(Math.max(0, Math.min(100, keep * 100))), drains };
};

/**
 * A Pons curve (constant product on its reserves, virtual ETH included): selling t tokens pays gross = t·Q/(T+t), so
 * the price Q/T moves to (Q−g)/(T+t), (T/(T+t))² of before. The curve can pay out only its real ETH: past that the
 * sells stop, at the t whose gross is all of it, and the curve is left with no ETH to pay anyone (`drains`, $100 → $0).
 * "Your $100" sells, on the curve as the dump leaves it, the tokens $100 buys at today's price (ponsSellOut: fee,
 * snipe tax and creator tax off the ETH).
 */
export function curveDump(s: PonsCurveState, tokens: bigint, ethUsd: number | null): DumpOutcome {
  const Q = s.quoteReserve, T = s.tokenReserve;
  let sold = tokens > 0n ? tokens : 0n, gross = sold * Q / (T + sold), drains = false;
  if (gross > s.realQuote) {
    drains = true;
    sold = Q > s.realQuote ? s.realQuote * T / (Q - s.realQuote) : sold;
    gross = sold * Q / (T + sold);
    if (gross > s.realQuote) gross = s.realQuote;
  }
  const after: PonsCurveState = { ...s, quoteReserve: Q - gross, tokenReserve: T + sold, realQuote: s.realQuote - gross, sellable: s.sellable + sold };
  const price = ratioOf(after.quoteReserve * T, Q * after.tokenReserve);
  const v0 = ethUsd && ethUsd > 0 ? weiFor(100, ethUsd) : 10n ** 17n, mine = v0 * T / Q;
  const back = ponsSellOut(after, mine);
  return outcome(price, back.capacity && !drains ? ratioOf(back.out, v0) : 0, drains);
}

/** A full-range pool's reserves now, in whole units: the probe's (ETH held, price) give L = x/√p; the price now moves them. */
export function fullRangeReserves(probe: { native: number; price: number }, sqrtPriceX96Now: bigint | null): { eth: number; tokens: number } | null {
  if (!(probe.native > 0) || !(probe.price > 0)) return null;
  const L = probe.native / Math.sqrt(probe.price), now = sqrtPriceX96Now && sqrtPriceX96Now > 0n ? priceHypeFromSqrt(sqrtPriceX96Now) : probe.price;
  if (!(now > 0) || !Number.isFinite(now)) return null;
  return { eth: L * Math.sqrt(now), tokens: L / Math.sqrt(now) };
}

/**
 * A full-range v4 pool (constant product x·y = L²; a Pons graduate's pool is one locked full-range position): selling
 * X tokens leaves the price at (y/(y+X))² of before. "Your $100" sells $100 of tokens at today's price on the pool as
 * the dump leaves it, the hook's cut off the ETH.
 */
export function poolDump(pool: { eth: number; tokens: number }, sold: number, sellFee: number, ethUsd: number | null): DumpOutcome {
  const x = pool.eth, y = pool.tokens, X = Math.max(0, sold), p0 = x / y;
  const x1 = x * y / (y + X), y1 = y + X;
  const mine = ethUsd && ethUsd > 0 ? 100 / ethUsd / p0 : y * 1e-9;
  const back = x1 * mine / (y1 + mine) * (1 - sellFee);
  return outcome((y / (y + X)) ** 2, back / (mine * p0));
}

/** v4's PoolManager keeps pools in a mapping at slot 6; slot0 is the first word of a pool's state. */
const POOLS_SLOT = 6n;
const managerAbi = parseAbi(['function extsload(bytes32 slot) view returns (bytes32)']);

/**
 * Any other native-ETH v4 pool, through the V4Quoter in one Multicall3 call: slot0 (the price before, fees aside), a
 * small reference sell δ, and per amount X the sells X and X+δ. The marginal price after X is (out(X+δ) − out(X))/δ,
 * against out(δ)/δ before; both carry the same proportional fees, which cancel in the change. "Your $100" is the
 * marginal price after against slot0's, so the pool's and hook's fees come off it. A sell the quoter will not quote
 * gives no figure (null).
 */
export async function quoterDump(rpc: Rpc, multicall3: Address, quoter: Address, manager: Address, key: V4PoolKey, amounts: bigint[], delta: bigint): Promise<(DumpOutcome | null)[]> {
  if (key.currency0 !== zeroAddress) throw notMeasured('Only native-ETH pools are measured.');
  const sell = (amount: bigint) => ({ target: quoter, allowFailure: true, callData: encodeFunctionData({ abi: quoterAbi, functionName: 'quoteExactInputSingle',
    args: [{ poolKey: key, zeroForOne: false, exactAmount: amount, hookData: '0x' }] }) });
  const id = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
    [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]));
  const slot = toHex(BigInt(keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [id, POOLS_SLOT]))), { size: 32 });
  const raw = await multicall(rpc, multicall3, [{ target: manager, allowFailure: true, callData: encodeFunctionData({ abi: managerAbi, functionName: 'extsload', args: [slot] }) },
    sell(delta), ...amounts.flatMap(a => a > 0n ? [sell(a), sell(a + delta)] : [])]);
  const out = (r: Hex | null | undefined) => {
    if (!r) return null;
    try { return decodeFunctionResult({ abi: quoterAbi, functionName: 'quoteExactInputSingle', data: r })[0]; } catch { return null; }
  };
  const word = raw[0] ? BigInt(raw[0]) : 0n, sqrtP = word & ((1n << 160n) - 1n), ref = out(raw[1]);
  if (sqrtP === 0n || ref === null || ref <= 0n) throw notMeasured('The pool would not quote a small sell.');
  // Wei per base unit of the coin: slot0's (fee-free) and the reference sell's (fees in).
  const root = Number(sqrtP) / 2 ** 96, spot = 1 / (root * root), before = Number(ref) / Number(delta);
  let i = 2;
  return amounts.map(a => {
    if (a <= 0n) return outcome(1, before / spot);
    const at = out(raw[i]), plus = out(raw[i + 1]); i += 2;
    if (at === null || plus === null) return null;
    const after = plus > at ? Number(plus - at) / Number(delta) : 0;
    return outcome(after / before, after / spot, after === 0);
  });
}

/** The reference sell δ for the quoter: about 0.0001 ETH of the coin at its last trade's price, else a 10⁻⁷ of supply. */
export function quoterDelta(coin: Pick<CoinState, 'trades' | 'supply'>): bigint {
  const price = coin.trades.at(-1)?.priceHype ?? 0;
  const byPrice = price > 0 && Number.isFinite(price) ? BigInt(Math.max(1, Math.floor(1e-4 / price * 1e18))) : 0n;
  const floor = coin.supply / 10_000_000n;
  return byPrice > floor ? byPrice : floor > 0n ? floor : 10n ** 9n;
}
