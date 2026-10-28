import { GAS_RESERVE_ETH, NETWORKS, NETWORK_FOR_MODE, formatQty, formatUsd, priceDecimals, sellQuantity, type Order, type Quote, type RouteDef } from '@eko/shared';
import { ApiError, type api } from './api';
import { isUserRejection } from './trade';

/**
 * The one-tap live flow, free of React: quote →
 * (exact approval) → order → wallet signature → submitted → confirmed. Every side effect (server,
 * wallet, order stream) comes in through `LiveEnv`, so the flows are tested with fakes.
 * `instant.ts` wires them to the app.
 */

export type InstantSide = 'buy' | 'sell';

export interface InstantRequest {
  market: string;
  side: InstantSide;
  /** USD value to trade. Sells convert at the bid and are capped at the holding ("Sell all"). */
  usd: number;
  /** Sell the whole holding (a position's Close); `usd` is ignored. */
  all?: boolean;
  /** Live: the user has confirmed a trade above `preferences.confirmLargeTradeUsd`. */
  confirmed?: boolean;
}

export type InstantPhase = 'idle' | 'quoting' | 'approving' | 'signing' | 'submitted' | 'filled' | 'confirmed' | 'failed';

export type InstantResult = { ok: true; order: Order; message: string } | { ok: false; code: string; message: string };
type Failure = Extract<InstantResult, { ok: false }>;

/** Live sells are sized to 8 dp (ETH), keeping GAS_RESERVE_ETH in the wallet. */
const LIVE_QTY_DECIMALS = 8;

export const SUBMITTED_MESSAGE = 'Submitted — waiting for confirmation';

/** Short, human versions of server and wallet error codes; anything else keeps the server's own words. */
const FRIENDLY: Record<string, string> = {
  stale_price: 'Market data is stale — trading paused',
  no_price: 'No price yet — try again in a moment',
  signal_expired: 'That signal has expired — nothing was traded',
  quote_expired: 'The price moved on — tap again',
  slippage_exceeded: 'The price moved too far — nothing was traded',
  network: 'Can’t reach EKO — check your connection',
  rpc_unavailable: 'Elysium isn’t responding — try again shortly',
  no_liquidity: 'Not enough liquidity for that size right now',
  live_disabled: 'Live trading is off on this server',
  wallet_required: 'Connect your wallet to trade live',
  wallet_auth_required: 'Sign in with your wallet first',
  wallet_mismatch: 'Switch back to the wallet you signed in with',
  approval_pending: 'Your approval hasn’t landed yet — tap again in a moment',
  simulation_failed: 'This swap would fail right now — nothing was sent',
  user_rejected: 'Cancelled in your wallet — nothing was sent',
  reverted: 'Failed on-chain — no trade happened (gas was spent)',
  bad_amount: 'Pick an amount first',
};

function fail(code: string, message?: string): Failure {
  return { ok: false, code, message: FRIENDLY[code] ?? message ?? 'Something went wrong' };
}

/** Any thrown error → a result: wallet cancellations, server refusals, then wallet/network errors. */
export function failureFrom(err: unknown): Failure {
  if (isUserRejection(err)) return fail('user_rejected');
  if (err instanceof ApiError) return fail(err.code, err.message);
  const e = err as { shortMessage?: string; message?: string };
  return fail('error', e?.shortMessage ?? e?.message);
}

const qtyText = (v: number) => (v >= 1 ? formatQty(v) : v.toLocaleString('en-US', { maximumSignificantDigits: 4 }));

/** "Bought 0.03765 ETH at $2,656.12", "Sold all 0.05 ETH at $2,655.90". */
export function fillMessage(o: Order, all = false): string {
  const buying = o.side === 'buy';
  const qty = (buying ? o.filledOut : o.filledIn) ?? (buying ? o.expectedOut : o.amountIn);
  const px = o.fillPrice ?? o.quotePrice;
  return `${buying ? 'Bought' : all ? 'Sold all' : 'Sold'} ${qtyText(qty)} ${buying ? o.assetOut : o.assetIn} at ${formatUsd(px, priceDecimals(px))}`;
}

type Tx = NonNullable<Quote['tx']>;

/** Everything the live flow needs from outside: app state, the server, the wallet and the order stream. */
export interface LiveEnv {
  mode: 'live' | 'testnet';
  /** This market's on-chain route in `mode` (null: paper-only). */
  route: RouteDef | null;
  liveEnabled: boolean;
  /** The connected wallet and the chain it is on. */
  wallet: { address: string; chainId: number | undefined } | null;
  /** The session's SIWE-verified wallet (lowercase), if any. */
  verifiedWallet: string | null;
  /** Live bid (USD per base) used to size sells. */
  bid: number | null;
  slippageBps: number;
  confirmLargeTradeUsd: number;
  api: typeof api;
  ensureChain(chainId: number): Promise<void>;
  /** Sign-In With Ethereum, then refresh the session. */
  signIn(chainId: number): Promise<void>;
  /** Exact-amount approval; resolves once it is confirmed. */
  approve(q: Quote): Promise<unknown>;
  /** Wallet sends the server-built swap; the hash is reported (and kept for replay if that fails). */
  signAndSubmit(order: Order, tx: Tx): Promise<{ order: Order }>;
  /** Resolves when the order stream shows the order confirmed, failed, rejected or expired. */
  settled(orderId: string): Promise<Order>;
  /** Progress. At 'submitted' it carries the interim result: the caller can stop blocking there. */
  onPhase(phase: InstantPhase, interim?: InstantResult): void;
  onOrder(o: Order): void;
}

function quoteBlocker(q: Quote): Failure | null {
  const has = (code: string) => q.warnings.some((w) => w.startsWith(code));
  if (has('live_disabled')) return fail('live_disabled');
  if (has('insufficient_balance'))
    return fail('insufficient_balance', q.side === 'buy' ? `Not enough ${q.assetIn} in your wallet` : `Not enough ${q.assetIn} — ${GAS_RESERVE_ETH} ETH stays for gas`);
  if (has('simulation_failed')) return fail('simulation_failed');
  return null;
}

/**
 * Live (Elysium): size → confirm-if-large → right chain → SIWE → quote → exact approval
 * (then re-quote) → order → wallet signature → submitted → resolves when confirmed or failed.
 * Nothing is signed before the checks pass, and nothing reaches the wallet for a trade the
 * user still has to confirm.
 */
export async function runLive(req: InstantRequest, idempotencyKey: string, env: LiveEnv): Promise<InstantResult> {
  const net = NETWORKS[NETWORK_FOR_MODE[env.mode]];
  const base = req.market.split('-')[0]!;
  const route = env.route;
  if (!route) return fail('no_route', env.mode === 'testnet' ? `${net.name} has no verified venue — trade on Paper` : `${base} trades on Paper only — Live supports ETH ⇄ USDG`);
  if (env.mode === 'live' && !env.liveEnabled) return fail('live_disabled');
  if (!env.wallet) return fail('wallet_required');
  if (!req.all && !(req.usd > 0)) return fail('bad_amount');
  const { address } = env.wallet;
  try {
    let amountIn = req.usd;
    let usd = req.usd;
    let all = false;
    if (req.side === 'sell') {
      if (!env.bid) return fail('no_price');
      const { balances } = await env.api<{ balances: { symbol: string; amount: number }[] }>(`/api/chain/balances?mode=${env.mode}&address=${address}`);
      const inWallet = balances.find((b) => b.symbol === route.base.symbol)?.amount ?? 0;
      const held = inWallet - (route.base.native ? GAS_RESERVE_ETH : 0);
      const size = sellQuantity(req.all ? Infinity : req.usd, env.bid, held, LIVE_QTY_DECIMALS);
      if (!(size.qty > 0))
        return held > 0 ? fail('amount_too_small', `That’s less than the smallest ${base} amount you can sell`) : fail('nothing_to_sell', `No ${base} to sell${route.base.native ? ` (${GAS_RESERVE_ETH} ${base} stays for gas)` : ''}`);
      amountIn = size.qty;
      all = size.all;
      usd = size.qty * env.bid;
    }
    if (usd > env.confirmLargeTradeUsd && !req.confirmed) return fail('confirm_required', `${formatUsd(usd)} is over your ${formatUsd(env.confirmLargeTradeUsd, 0)} limit — confirm to trade`);

    if (env.wallet.chainId !== net.chainId) {
      env.onPhase('signing');
      await env.ensureChain(net.chainId);
    }
    if (env.verifiedWallet !== address.toLowerCase()) {
      env.onPhase('signing');
      await env.signIn(net.chainId);
    }

    const getQuote = async () =>
      (
        await env.api<{ quote: Quote }>('/api/quotes', {
          body: { market: req.market, side: req.side, mode: env.mode, amountIn: amountIn.toFixed(req.side === 'buy' ? 6 : LIVE_QTY_DECIMALS), slippageBps: env.slippageBps, account: address },
        })
      ).quote;
    env.onPhase('quoting');
    let quote = await getQuote();
    const early = quoteBlocker(quote);
    if (early) return early;
    if (quote.tx?.approval) {
      env.onPhase('approving');
      await env.approve(quote);
      env.onPhase('quoting');
      quote = await getQuote();
      if (quote.tx?.approval) return fail('approval_pending');
      const late = quoteBlocker(quote);
      if (late) return late;
    }
    if (!quote.tx) return fail('no_route', `No executable route for ${req.market}`);

    const placed = await env.api<{ order: Order; tx: Tx }>('/api/orders', { body: { quoteId: quote.id, idempotencyKey } });
    env.onOrder(placed.order);
    env.onPhase('signing');
    let submitted = placed.order;
    try {
      submitted = (await env.signAndSubmit(placed.order, placed.tx)).order;
      env.onOrder(submitted);
    } catch (err) {
      // An ApiError here means the wallet broadcast the swap but reporting the hash failed: the hash
      // is kept and replayed on reconnect, so the trade is still on its way.
      if (!(err instanceof ApiError)) throw err;
    }
    env.onPhase('submitted', { ok: true, order: submitted, message: SUBMITTED_MESSAGE });

    const final = await env.settled(submitted.id);
    if (final.status === 'confirmed') return { ok: true, order: final, message: fillMessage(final, all) };
    return fail(final.errorCode ?? final.status, final.errorMessage ?? 'The transaction failed');
  } catch (err) {
    return failureFrom(err);
  }
}
