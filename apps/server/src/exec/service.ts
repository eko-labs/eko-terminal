import { rpcPauseRetryAt } from '@eko/chain';
import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import type { Address, Hex } from 'viem';
import {
  NETWORK_FOR_MODE,
  PAPER_QUOTE_ASSET,
  getMarket,
  sellQuantity,
  type InstantOrder,
  type Order,
  type OrderStatus,
  type Quote,
  type QuoteRequest,
  type TradingMode,
  type TradeQuoteRequest,
} from '@eko/shared';
import type { Db } from '../db/client.js';
import { auditLog, fills, orders, paperBalances } from '../db/schema.js';
import type { MarketDataService } from '../market/service.js';
import { reportError } from '../obs/errors.js';
import { metrics } from '../obs/metrics.js';
import { ChainQuoteError } from './chain.js';
import type { ExecutionAdapter } from './types.js';
import { applyFillToPosition, type PortfolioService } from './portfolio.js';
import type { QuoteStore } from './quotes.js';
import { ScreeningError, type SanctionsService } from '../sanctions/service.js';
import { TradeService, type TradeOwner, type TradeOrderInput } from './trades.js';
import { TradeAccessError, type TradeAccessService } from './trade-access.js';

export class ExecError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 422,
    readonly order?: Order,
  ) {
    super(message);
  }
}

type OrderRow = typeof orders.$inferSelect;

export function rowToOrder(r: OrderRow): Order {
  return {
    id: r.id,
    mode: r.mode,
    market: r.market,
    side: r.side,
    signalId: r.signalId,
    botId: r.botId,
    network: r.network,
    venue: r.venue,
    assetIn: r.assetIn,
    assetOut: r.assetOut,
    amountIn: r.amountIn,
    expectedOut: r.expectedOut,
    minOut: r.minOut,
    quotePrice: r.quotePrice,
    referencePrice: r.referencePrice,
    slippageBps: r.slippageBps,
    status: r.status as OrderStatus,
    txHash: r.txHash,
    approvalTxHash: r.approvalTxHash,
    fillPrice: r.fillPrice,
    filledIn: r.filledIn,
    filledOut: r.filledOut,
    feePaid: r.feePaid,
    feeAsset: r.feeAsset,
    errorCode: r.errorCode,
    errorMessage: r.errorMessage,
    createdAt: r.createdAt.getTime(),
    submittedAt: r.submittedAt?.getTime() ?? null,
    settledAt: r.settledAt?.getTime() ?? null,
  };
}

export interface ExecHooks {
  onOrder(accountId: string, o: Order): void;
  onPortfolio(accountId: string, mode: TradingMode): void;
}

const STALE_PRICE_MS = 15_000;
const PAPER_QUOTE_TTL_MS = 15_000;

/**
 * Quotes and orders for all modes.
 *  paper   — simulated fills against live market data, recorded separately from real activity.
 *  testnet — Robinhood Chain Testnet: no verified venue, so execution is refused with the reason.
 *  live    — Robinhood Chain mainnet via Uniswap v3. The server never signs: it builds and
 *            simulates the transaction, the user's wallet signs, and the reconciler confirms.
 */
export class ExecutionService {
  private timer: NodeJS.Timeout | null = null;

  /**
   * Wire storage, market/portfolio/cache, unsigned adapters, access/sanctions configuration, hooks
   * and clock. Host-only construction; no caller auth, signing or reconciliation starts until
   * methods run.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Unsigned execution and current admission invariants}
   */
  constructor(
    private db: Db,
    private market: MarketDataService,
    private portfolio: PortfolioService,
    private quotes: QuoteStore,
    private chain: { testnet: ExecutionAdapter; live: ExecutionAdapter },
    private cfg: { liveEnabled: boolean; paperFeeBps: number; tradeAccess?: TradeAccessService; sanctions?: Pick<SanctionsService, 'assertWallet'>; trades?: TradeService },
    private hooks: ExecHooks,
    private now: () => number = Date.now,
  ) {}

  /**
   * Delegate quote acquisition to the installed TradeService; throw sim_unavailable if absent.
   * Caller supplies the authenticated owner; this wrapper does not authenticate.
   */
  async tradeQuote(owner: TradeOwner, input: TradeQuoteRequest) {
    if (!this.cfg.trades) throw new ExecError('sim_unavailable', 'Trade acquisition unavailable', 503);
    return this.cfg.trades.quote(owner, input);
  }
  /**
   * Delegate owner-scoped unsigned order preparation; throw sim_unavailable if TradeService is
   * absent. Caller authenticates the wallet; TradeService rechecks admission and retained
   * evidence.
   */
  async tradeOrder(owner: TradeOwner, input: TradeOrderInput) {
    if (!this.cfg.trades) throw new ExecError('sim_unavailable', 'Trade acquisition unavailable', 503);
    return this.cfg.trades.order(owner, input);
  }

  /**
   * Delegate an owner-bound transaction-hash report to TradeService. Caller authenticates owner
   * and installs the service; the report does not confirm a fill.
   */
  async tradeSubmitted(owner: TradeOwner, id: string, hash: string) { return this.cfg.trades!.submitted(owner, id, hash); }
  /**
   * Delegate the finite wallet rejection/signing outcome to the installed TradeService. Caller
   * supplies authenticated owner; only awaiting-signature orders can change.
   */
  async tradeRejected(owner: TradeOwner, id: string, code: 'user_rejected' | 'signing_failed') { return this.cfg.trades!.rejected(owner, id, code); }
  /**
   * Read paginated orders through the installed TradeService for the authenticated owner supplied
   * by the caller. Storage/cursor ownership failures propagate.
   */
  async tradeHistory(owner: TradeOwner, limit: number, cursor?: string) { return this.cfg.trades!.history(owner, limit, cursor); }
  /**
   * Read one owned order through the installed TradeService. Caller supplies authenticated owner;
   * absent or foreign orders reject as not_found.
   */
  async tradeDetail(owner: TradeOwner, id: string) { return this.cfg.trades!.detail(owner, id); }

  /**
   * Schedule reconciliation every 1.5 seconds and report asynchronous failures through the error
   * reporter. Host worker call, no wallet authentication; repeated calls create additional timers.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Unsigned execution and current admission invariants}
   */
  start() {
    this.timer = setInterval(() => void this.reconcile().catch((err) => reportError(err, { where: 'reconcile' })), 1500);
  }
  /**
   * Clear the retained reconciliation timer. Host lifecycle call, no wallet authentication; an in-
   * flight reconciliation is not cancelled or awaited.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Unsigned execution and current admission invariants}
   */
  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  // ───────────────────────── quotes ─────────────────────────

  /**
   * Prepare an account-attributed paper or unsigned chain quote; live quotes require sanctions data
   * and remove transaction bytes when admission refuses. Caller authenticates account/wallet.
   * Unknown market, bad amount, missing screening/route, provider and database failures reject;
   * quote creation is not order authorization.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Unsigned execution and current admission invariants}
   */
  async quote(accountId: string, req: QuoteRequest): Promise<Quote> {
    const def = getMarket(req.market);
    if (!def) throw new ExecError('unknown_market', 'Unknown market', 404);
    const amountIn = Number(req.amountIn);
    if (!(amountIn > 0)) throw new ExecError('bad_amount', 'Amount must be positive');
    const id = this.quotes.newId();
    const last = this.market.lastPrice(req.market);
    if (req.mode === 'paper') {
      const q = await this.paperQuote(accountId, id, req, amountIn);
      this.quotes.put(q, accountId);
      return q;
    }
    if (req.mode === 'live') await this.assertScreened(req.account);
    const adapter = this.chain[req.mode];
    try {
      const q = await adapter.quote({
        id,
        market: req.market,
        side: req.side,
        amountIn,
        slippageBps: req.slippageBps,
        account: req.account as Address | undefined,
        referenceMid: last?.price ?? 0,
        mode: req.mode,
      });
      if (req.mode === 'live') await this.assertScreened(q.account);
      this.quotes.put(q, accountId);
      if (req.mode === 'live') {
        const refusal = await this.liveRefusal(q.account, q);
        if (refusal) return { ...q, tx: undefined, warnings: [`${refusal.code}: ${refusal.message}. Quotes are informational.`, ...q.warnings] };
        return { ...q, tx: undefined, warnings: ['guard_refused: Request a guarded v1 trade quote.', ...q.warnings] };
      }
      return q;
    } catch (err) {
      if (err instanceof ExecError) throw err;
      if (err instanceof ChainQuoteError) throw new ExecError(err.code, err.message, 422);
      throw new ExecError('quote_failed', `Quote failed: ${(err as Error).message.slice(0, 200)}`, 502);
    }
  }

  private priceState(market: string) {
    const t = this.market.ticker(market);
    const last = this.market.lastPrice(market);
    if (!last) throw new ExecError('no_price', 'No market price available yet', 503);
    const at = t?.time ?? last.at;
    const age = this.now() - at;
    const health = this.market.health();
    if (age > STALE_PRICE_MS || health.status === 'down' || health.status === 'reconnecting') {
      throw new ExecError('stale_price', `Market data is stale (${Math.round(age / 1000)}s since last update, feed ${health.status}). Fills are paused until data resumes.`, 503);
    }
    const px = t?.price ?? last.price;
    const bid = t?.bid ?? px * (1 - 0.0001);
    const ask = t?.ask ?? px * (1 + 0.0001);
    return { mid: (bid + ask) / 2, bid, ask, at };
  }

  private async paperQuote(accountId: string, id: string, req: QuoteRequest, amountIn: number): Promise<Quote> {
    const t0 = performance.now();
    const def = getMarket(req.market)!;
    const p = this.priceState(req.market);
    const fee = this.cfg.paperFeeBps / 10_000;
    const buying = req.side === 'buy';
    const price = buying ? p.ask : p.bid;
    const expectedOut = buying ? (amountIn * (1 - fee)) / price : amountIn * price * (1 - fee);
    const minOut = expectedOut * (1 - req.slippageBps / 10_000);
    const balances = await this.portfolio.paperBalances(accountId);
    const bal = (a: string) => balances.find((b) => b.asset === a)?.amount ?? 0;
    const warnings: string[] = ['Paper trade: simulated fill against live market data. Price impact is not modelled.'];
    if (buying && bal(PAPER_QUOTE_ASSET) < amountIn) warnings.push(`insufficient_balance: paper cash is $${bal(PAPER_QUOTE_ASSET).toFixed(2)}`);
    if (!buying && bal(def.base) < amountIn) warnings.push(`insufficient_balance: paper ${def.base} balance is ${bal(def.base)}`);
    const quotedAt = this.now();
    const latencyMs = performance.now() - t0;
    metrics.observe('quote.latency_ms', latencyMs, { venue: 'paper', mode: 'paper' });
    return {
      id,
      mode: 'paper',
      market: req.market,
      side: req.side,
      network: 'paper',
      venue: 'paper',
      venueName: 'Paper simulator',
      assetIn: buying ? PAPER_QUOTE_ASSET : def.base,
      assetOut: buying ? def.base : PAPER_QUOTE_ASSET,
      amountIn,
      expectedOut,
      minOut,
      price,
      referenceMid: p.mid,
      priceImpactBps: 0,
      slippageBps: req.slippageBps,
      fees: [{ label: `Modelled fee (${(this.cfg.paperFeeBps / 100).toFixed(2)}%)`, amount: buying ? amountIn * fee : amountIn * price * fee, asset: PAPER_QUOTE_ASSET, estimated: true }],
      quotedAt,
      expiresAt: quotedAt + PAPER_QUOTE_TTL_MS,
      latencyMs,
      priceSource: `${this.market.source} best ${buying ? 'ask' : 'bid'}${this.market.simulated ? ' (simulated data)' : ''}`,
      simulated: true,
      warnings,
    };
  }

  // ───────────────────────── orders ─────────────────────────

  private async byIdem(accountId: string, key: string) {
    const [r] = await this.db.select().from(orders).where(and(eq(orders.accountId, accountId), eq(orders.idempotencyKey, key)));
    return r ?? null;
  }

  private async liveRefusal(wallet: string | null | undefined, quote: Quote) {
    if (!this.cfg.liveEnabled || !this.cfg.tradeAccess) return new TradeAccessError('trading_paused', 'Live trading paused');
    // Heritage ETH/USDG input: buys spend quote dollars; sells value owned ETH at the quote price.
    const amountUsd = quote.side === 'buy' ? quote.amountIn : quote.amountIn * quote.price;
    return this.cfg.tradeAccess.refusal(wallet, amountUsd);
  }

  private async assertScreened(wallet?: string | null) {
    if (!this.cfg.sanctions) throw new ExecError('stale_data', 'Trading checks are unavailable. Try again later.');
    try { await this.cfg.sanctions.assertWallet(wallet); }
    catch (error) {
      const refusal = error instanceof ScreeningError ? error : new ScreeningError('stale_data');
      throw new ExecError(refusal.code, refusal.message, refusal.statusCode);
    }
  }

  private async assertLiveOrder(wallet: string | null, quote: Quote) {
    await this.assertScreened(wallet);
    if (quote.account && quote.account.toLowerCase() !== wallet?.toLowerCase()) await this.assertScreened(quote.account);
    const refusal = await this.liveRefusal(wallet, quote);
    if (refusal) throw new ExecError(refusal.code, refusal.message, refusal.code === 'not_allowlisted' ? 403 : 422);
    if (!wallet) throw new ExecError('wallet_auth_required', 'Wallet sign-in required', 401);
    if (!quote.account || quote.account.toLowerCase() !== wallet.toLowerCase())
      throw new ExecError('wallet_mismatch', 'Quote wallet differs from the signed-in wallet', 409);
    // Heritage quotes have no actual-account binding or per-quote warning acknowledgements.
    throw new ExecError('guard_refused', 'Request a guarded v1 trade quote before placing a live order.', 422);
  }

  private async recordRejected(accountId: string, quote: Quote, key: string, code: string, message: string, status: OrderStatus = 'rejected') {
    const [row] = await this.db
      .insert(orders)
      .values({
        accountId,
        mode: quote.mode,
        market: quote.market,
        side: quote.side,
        signalId: null,
        botId: null,
        network: quote.network,
        venue: quote.venue,
        assetIn: quote.assetIn,
        assetOut: quote.assetOut,
        amountIn: quote.amountIn,
        expectedOut: quote.expectedOut,
        minOut: quote.minOut,
        quotePrice: quote.price,
        referencePrice: null,
        slippageBps: quote.slippageBps,
        quote,
        status,
        idempotencyKey: key,
        errorCode: code,
        errorMessage: message,
      })
      .onConflictDoNothing()
      .returning();
    const order = row ? rowToOrder(row) : undefined;
    if (order) this.hooks.onOrder(accountId, order);
    return order;
  }

  /**
   * Resolve account-scoped idempotency or a retained owned unconsumed unexpired quote. Live retries
   * recheck screening/access/wallet and awaiting-signature expiry; new live orders also require
   * route, simulation and no pending approval. Caller supplies authenticated identity. ExecError
   * reports refusal; storage failures reject. Paper mode fills simulated balances; chain mode
   * returns unsigned bytes.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Unsigned execution and current admission invariants}
   */
  async place(
    accountId: string,
    wallet: string | null,
    input: { quoteId: string; idempotencyKey: string; clientLatency?: { clickToSubmitMs?: number } },
  ): Promise<{ order: Order; duplicate: boolean; tx?: Quote['tx'] }> {
    const t0 = performance.now();
    const existing = await this.byIdem(accountId, input.idempotencyKey);
    if (existing) {
      const quote = existing.quote as Quote;
      if (quote.mode === 'live') {
        await this.assertLiveOrder(wallet, quote);
        if (!wallet || quote.account?.toLowerCase() !== wallet.toLowerCase()) throw new ExecError('wallet_mismatch', 'Quote wallet differs from the signed-in wallet', 422);
        if (existing.status === 'awaiting_signature' && this.now() > quote.expiresAt) throw new ExecError('quote_expired', 'Quote expired. Request a fresh quote.', 422);
      }
      return { order: rowToOrder(existing), duplicate: true, ...(existing.status === 'awaiting_signature' ? { tx: quote.tx } : {}) };
    }

    const stored = this.quotes.get(input.quoteId);
    if (!stored || stored.accountId !== accountId) throw new ExecError('quote_not_found', 'Quote not found. Request a fresh quote.', 404);
    const quote = stored.quote;
    if (stored.consumed) throw new ExecError('quote_used', 'This quote was already used. Request a fresh quote.', 409);
    if (this.now() > quote.expiresAt) {
      const o = await this.recordRejected(accountId, quote, input.idempotencyKey, 'quote_expired', 'Quote expired before submission.', 'expired');
      throw new ExecError('quote_expired', 'Quote expired before submission. Refresh the quote and try again.', 409, o);
    }
    if (input.clientLatency?.clickToSubmitMs !== undefined) metrics.observe('ui.click_to_submit_ms', input.clientLatency.clickToSubmitMs, { mode: quote.mode });

    if (quote.mode === 'live') await this.assertLiveOrder(wallet, quote);
    this.quotes.consume(quote.id);
    const result = quote.mode === 'paper' ? await this.fillPaper(accountId, quote, input.idempotencyKey, input.clientLatency) : await this.createChainOrder(accountId, wallet, quote, input.idempotencyKey, input.clientLatency);
    metrics.observe('order.submit_server_ms', performance.now() - t0, { mode: quote.mode });
    return result;
  }

  private async fillPaper(accountId: string, quote: Quote, key: string, clientLatency?: object) {
    const def = getMarket(quote.market)!;
    let p: ReturnType<ExecutionService['priceState']>;
    try {
      p = this.priceState(quote.market);
    } catch (err) {
      const e = err as ExecError;
      const o = await this.recordRejected(accountId, quote, key, e.code, e.message);
      throw new ExecError(e.code, e.message, e.statusCode, o);
    }
    const fee = this.cfg.paperFeeBps / 10_000;
    const buying = quote.side === 'buy';
    const fillPrice = buying ? p.ask : p.bid;
    const out = buying ? (quote.amountIn * (1 - fee)) / fillPrice : quote.amountIn * fillPrice * (1 - fee);
    if (out < quote.minOut) {
      const msg = `Price moved beyond your ${(quote.slippageBps / 100).toFixed(2)}% slippage tolerance (would receive ${out.toPrecision(6)} < minimum ${quote.minOut.toPrecision(6)}).`;
      const o = await this.recordRejected(accountId, quote, key, 'slippage_exceeded', msg, 'failed');
      throw new ExecError('slippage_exceeded', msg, 409, o);
    }
    const baseQty = buying ? out : quote.amountIn;
    const quoteQty = buying ? quote.amountIn * (1 - fee) : quote.amountIn * fillPrice;
    const feeAmt = buying ? quote.amountIn * fee : quote.amountIn * fillPrice * fee;
    const order = await this.db.transaction(async (tx) => {
      const bals = await tx.select().from(paperBalances).where(eq(paperBalances.accountId, accountId));
      const bal = (a: string) => bals.find((b) => b.asset === a)?.amount ?? 0;
      const spendAsset = buying ? PAPER_QUOTE_ASSET : def.base;
      if (bal(spendAsset) + 1e-9 < quote.amountIn) return null;
      const [row] = await tx
        .insert(orders)
        .values({
          accountId,
          mode: 'paper',
          market: quote.market,
          side: quote.side,
          signalId: null,
          botId: null,
          network: 'paper',
          venue: 'paper',
          assetIn: quote.assetIn,
          assetOut: quote.assetOut,
          amountIn: quote.amountIn,
          expectedOut: quote.expectedOut,
          minOut: quote.minOut,
          quotePrice: quote.price,
          referencePrice: null,
          slippageBps: quote.slippageBps,
          quote,
          status: 'filled',
          idempotencyKey: key,
          fillPrice,
          filledIn: quote.amountIn,
          filledOut: out,
          feePaid: feeAmt,
          feeAsset: PAPER_QUOTE_ASSET,
          latency: { ...(clientLatency ?? {}), quoteToFillMs: this.now() - quote.quotedAt },
          submittedAt: new Date(this.now()),
          settledAt: new Date(this.now()),
        })
        .onConflictDoNothing()
        .returning();
      if (!row) return 'duplicate' as const;
      const upsert = async (asset: string, delta: number) => {
        const next = bal(asset) + delta;
        await tx
          .insert(paperBalances)
          .values({ accountId, asset, amount: next })
          .onConflictDoUpdate({ target: [paperBalances.accountId, paperBalances.asset], set: { amount: next, updatedAt: new Date() } });
      };
      if (buying) {
        await upsert(PAPER_QUOTE_ASSET, -quote.amountIn);
        await upsert(def.base, out);
      } else {
        await upsert(def.base, -quote.amountIn);
        await upsert(PAPER_QUOTE_ASSET, out);
      }
      await tx.insert(fills).values({ orderId: row.id, accountId, mode: 'paper', market: quote.market, side: quote.side, price: fillPrice, baseQty, quoteQty, fee: feeAmt, feeAsset: PAPER_QUOTE_ASSET });
      await applyFillToPosition(tx, accountId, 'paper', quote.market, quote.side, baseQty, quoteQty, buying ? feeAmt : feeAmt);
      return row;
    });
    if (order === null) {
      const msg = buying ? 'Insufficient paper cash for this order.' : `Insufficient ${def.base} — spot sells require owning the asset (no shorting).`;
      const o = await this.recordRejected(accountId, quote, key, 'insufficient_balance', msg);
      throw new ExecError('insufficient_balance', msg, 422, o);
    }
    if (order === 'duplicate') {
      const again = await this.byIdem(accountId, key);
      return { order: rowToOrder(again!), duplicate: true };
    }
    const o = rowToOrder(order);
    this.hooks.onOrder(accountId, o);
    this.hooks.onPortfolio(accountId, 'paper');
    return { order: o, duplicate: false };
  }

  private async createChainOrder(accountId: string, wallet: string | null, quote: Quote, key: string, clientLatency?: object) {
    const mode = quote.mode as 'testnet' | 'live';
    if (mode === 'live') await this.assertLiveOrder(wallet, quote);
    if (!wallet) throw new ExecError('wallet_auth_required', 'Sign in with your wallet (SIWE) before placing on-chain orders.', 401);
    if (!quote.tx) throw new ExecError('no_route', 'No executable route for this quote.', 422);
    const account = quote.warnings.find((w) => w.startsWith('insufficient_balance'));
    if (account) {
      const o = await this.recordRejected(accountId, quote, key, 'insufficient_balance', account.replace('insufficient_balance: ', 'Insufficient balance: '));
      throw new ExecError('insufficient_balance', o?.errorMessage ?? 'Insufficient balance', 422, o);
    }
    // The calldata pays out to the wallet the quote was built for; it must be the signed-in wallet.
    if (!quote.account || quote.account.toLowerCase() !== wallet.toLowerCase())
      throw new ExecError('wallet_mismatch', 'This quote was built for a different (or no) wallet. Reconnect the signed-in wallet and refresh the quote.', 409);
    if (quote.tx.approval) throw new ExecError('approval_required', 'Token approval must confirm first. Approve, then refresh the quote.', 409);
    const sim = quote.warnings.find((w) => w.startsWith('simulation_failed'));
    if (sim) {
      const o = await this.recordRejected(accountId, quote, key, 'simulation_failed', sim);
      throw new ExecError('simulation_failed', `Transaction simulation failed — not submitting. ${sim.replace('simulation_failed: ', '')}`, 422, o);
    }
    const [row] = await this.db
      .insert(orders)
      .values({
        accountId,
        mode,
        market: quote.market,
        side: quote.side,
        signalId: null,
        botId: null,
        network: quote.network,
        venue: quote.venue,
        walletAddress: wallet.toLowerCase(),
        assetIn: quote.assetIn,
        assetOut: quote.assetOut,
        amountIn: quote.amountIn,
        expectedOut: quote.expectedOut,
        minOut: quote.minOut,
        quotePrice: quote.price,
        referencePrice: null,
        slippageBps: quote.slippageBps,
        quote,
        status: 'awaiting_signature',
        idempotencyKey: key,
        latency: clientLatency ?? {},
      })
      .onConflictDoNothing()
      .returning();
    if (!row) {
      const again = await this.byIdem(accountId, key);
      return { order: rowToOrder(again!), duplicate: true, tx: quote.tx };
    }
    await this.db.insert(auditLog).values({ accountId, action: 'order.created', data: { orderId: row.id, mode, market: quote.market, side: quote.side, amountIn: quote.amountIn } });
    const o = rowToOrder(row);
    this.hooks.onOrder(accountId, o);
    return { order: o, duplicate: false, tx: quote.tx };
  }

  /**
   * One-tap paper trade: quote and fill in one call, through every check of quote → place (stale
   * data, balance, idempotency). Buys spend `amountUsd` of
   * paper cash. Sells convert it to the base asset at the live bid, capped at the holding: a
   * holding worth less than that (or `all`) is sold in full. Idempotent per key.
   * @remarks
   * Prepare and place an idempotent paper trade; sell size is capped by recorded holdings and buys
   * use supplied USD size. Caller authenticates the account; missing/stale price, invalid
   * market/size, balance, slippage or storage failures reject. No real transaction is produced.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Unsigned execution and current admission invariants}
   */
  async instantPaper(
    accountId: string,
    input: Omit<InstantOrder, 'mode' | 'slippageBps'> & { slippageBps: number },
  ): Promise<{ order: Order; duplicate: boolean; all: boolean }> {
    const duplicate = async () => {
      const existing = await this.byIdem(accountId, input.idempotencyKey);
      return existing ? { order: rowToOrder(existing), duplicate: true, all: false } : null;
    };
    const first = await duplicate();
    if (first) return first;
    const def = getMarket(input.market);
    if (!def) throw new ExecError('unknown_market', 'Unknown market', 404);
    let amountIn = input.amountUsd ?? 0;
    let all = false;
    if (input.side === 'sell') {
      const { bid } = this.priceState(input.market);
      const held = (await this.portfolio.paperBalances(accountId)).find((b) => b.asset === def.base)?.amount ?? 0;
      const size = sellQuantity(input.all ? Infinity : amountIn, bid, held, def.qtyDecimals);
      if (!(size.qty > 0)) {
        // A concurrent tap with the same key may just have sold it all.
        const again = await duplicate();
        if (again) return again;
        if (held > 0) throw new ExecError('amount_too_small', `That’s less than the smallest ${def.base} amount you can sell.`);
        throw new ExecError('nothing_to_sell', `You don’t hold any ${def.base} to sell.`, 409);
      }
      amountIn = size.qty;
      all = size.all;
    }
    const req: QuoteRequest = { market: input.market, side: input.side, mode: 'paper', amountIn: String(amountIn), slippageBps: input.slippageBps, };
    const q = await this.paperQuote(accountId, this.quotes.newId(), req, amountIn);
    this.quotes.put(q, accountId);
    const r = await this.place(accountId, null, { quoteId: q.id, idempotencyKey: input.idempotencyKey, });
    return { order: r.order, duplicate: r.duplicate, all: all && !r.duplicate };
  }

  private async own(accountId: string, orderId: string) {
    const [r] = await this.db.select().from(orders).where(and(eq(orders.id, orderId), eq(orders.accountId, accountId)));
    if (!r) throw new ExecError('order_not_found', 'Order not found', 404);
    return r;
  }

  /** Wallet returned a hash. Recorded as SUBMITTED — never as confirmed until the receipt says so.
   * @remarks
   * Store a syntactically valid reported hash on an owned awaiting/submitted order, allowing recent
   * expired orders within the one-hour grace period. Caller authenticates account; conflicting hash
   * or state rejects. This records submission, not confirmation; SQL failures reject.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Unsigned execution and current admission invariants}
   */
  async markSubmitted(accountId: string, orderId: string, txHash: string, clientMs?: number) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new ExecError('bad_hash', 'Invalid transaction hash', 400);
    const r = await this.own(accountId, orderId);
    if (r.txHash && r.txHash !== txHash.toLowerCase()) throw new ExecError('hash_conflict', 'Order already has a different transaction', 409);
    const graceOk = r.status === 'expired' && this.now() - r.createdAt.getTime() < 3_600_000;
    if (r.status !== 'awaiting_signature' && !graceOk && r.status !== 'submitted') throw new ExecError('bad_state', `Order is ${r.status}`, 409);
    if (clientMs !== undefined) metrics.observe('ui.wallet_sign_ms', clientMs, { mode: r.mode });
    const [row] = await this.db
      .update(orders)
      .set({ status: 'submitted', txHash: txHash.toLowerCase(), submittedAt: r.submittedAt ?? new Date(this.now()), updatedAt: new Date() })
      .where(eq(orders.id, orderId))
      .returning();
    const o = rowToOrder(row!);
    this.hooks.onOrder(accountId, o);
    return o;
  }

  /**
   * Update an owned awaiting-signature order to rejected/failed with bounded code/message; return
   * other states unchanged. Caller authenticates account; unknown/nonowned order and SQL failures
   * reject.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Unsigned execution and current admission invariants}
   */
  async markRejected(accountId: string, orderId: string, code: string, message: string) {
    const r = await this.own(accountId, orderId);
    if (r.status !== 'awaiting_signature') return rowToOrder(r);
    const status: OrderStatus = code === 'user_rejected' ? 'rejected' : 'failed';
    const [row] = await this.db
      .update(orders)
      .set({ status, errorCode: code.slice(0, 40), errorMessage: message.slice(0, 300), settledAt: new Date(this.now()), updatedAt: new Date() })
      .where(eq(orders.id, orderId))
      .returning();
    const o = rowToOrder(row!);
    this.hooks.onOrder(accountId, o);
    return o;
  }

  /**
   * List account-scoped orders newest first with optional mode and supplied limit. Caller
   * authenticates account; database failures reject; no additional limit validation occurs here.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Unsigned execution and current admission invariants}
   */
  async list(accountId: string, mode: TradingMode | undefined, limit = 200): Promise<Order[]> {
    const rows = await this.db
      .select()
      .from(orders)
      .where(mode ? and(eq(orders.accountId, accountId), eq(orders.mode, mode)) : eq(orders.accountId, accountId))
      .orderBy(desc(orders.createdAt))
      .limit(limit);
    return rows.map(rowToOrder);
  }

  // ───────────────────────── reconciliation ─────────────────────────

  private reconciling = false;
  private rpcRetryAt = 0;
  /**
   * Serialize reconciliation, expire stale unsigned orders and check submitted transactions against
   * retained sender/router/calldata/value before recording receipt-based fills. Host worker only;
   * database/adapter errors reject. Missing Swap amounts use explicitly marked quote estimates; no
   * finality depth is enforced here.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Unsigned execution and current admission invariants}
   */
  async reconcile() {
    if (this.reconciling || this.now()<this.rpcRetryAt) return;
    this.reconciling = true;
    try {
      await this.cfg.trades?.reconcile();
      const now = this.now();
      // Unsigned orders whose quote lapsed long ago.
      const stale = await this.db
        .select()
        .from(orders)
        .where(and(eq(orders.status, 'awaiting_signature'), lt(orders.createdAt, new Date(now - 3 * 60_000))));
      for (const r of stale) {
        const [row] = await this.db
          .update(orders)
          .set({ status: 'expired', errorCode: 'not_signed', errorMessage: 'No signed transaction was reported. If you did sign, it will be reconciled when reported.', updatedAt: new Date() })
          .where(and(eq(orders.id, r.id), eq(orders.status, 'awaiting_signature')))
          .returning();
        if (row) this.hooks.onOrder(row.accountId, rowToOrder(row));
      }
      const pending = await this.db.select().from(orders).where(and(eq(orders.status, 'submitted'), inArray(orders.mode, ['testnet', 'live'])));
      for (const r of pending) await this.reconcileOne(r);
    } catch(error) {
      const retryAt=rpcPauseRetryAt(error);
      if(retryAt===undefined)throw error;
      this.rpcRetryAt=retryAt;
    } finally {
      this.reconciling = false;
    }
  }

  private async reconcileOne(r: OrderRow) {
    const adapter = this.chain[r.mode as 'testnet' | 'live'];
    const hash = r.txHash as Hex;
    const receipt = await adapter.receipt(hash);
    const now = this.now();
    if (!receipt) {
      if (r.submittedAt && now - r.submittedAt.getTime() > 30 * 60_000) {
        await this.settle(r, 'failed', { errorCode: 'not_found', errorMessage: 'Transaction not found on-chain after 30 minutes (dropped or replaced).' });
      }
      return;
    }
    const quote = r.quote as Quote;
    const tx = await adapter.transaction(hash);
    const sameCall = tx?.input?.toLowerCase() === quote.tx?.swap.data.toLowerCase() && tx?.value === BigInt(quote.tx?.swap.value ?? -1);
    if (!tx || tx.from.toLowerCase() !== r.walletAddress || tx.to?.toLowerCase() !== quote.tx?.swap.to.toLowerCase() || !sameCall) {
      await this.settle(r, 'failed', { errorCode: 'tx_mismatch', errorMessage: 'Reported transaction does not match this order (sender, router or swap calldata differs).' });
      return;
    }
    if (receipt.status !== 'success') {
      await this.settle(r, 'failed', { errorCode: 'reverted', errorMessage: 'Transaction reverted on-chain (e.g. slippage limit or deadline). No trade occurred; gas was spent.' });
      return;
    }
    const parsed = adapter.parseSwap(receipt, r.market);
    const gasEth = Number(receipt.gasUsed * receipt.effectiveGasPrice) / 1e18;
    if (r.submittedAt) metrics.observe('order.confirm_ms', now - r.submittedAt.getTime(), { mode: r.mode });
    await this.db.transaction(async (txn) => {
      const buying = r.side === 'buy';
      const baseQty = parsed?.baseQty ?? (buying ? r.expectedOut : r.amountIn);
      const quoteQty = parsed?.quoteQty ?? (buying ? r.amountIn : r.expectedOut);
      const price = parsed?.price ?? r.quotePrice;
      const [row] = await txn
        .update(orders)
        .set({
          status: 'confirmed',
          fillPrice: price,
          filledIn: buying ? quoteQty : baseQty,
          filledOut: buying ? baseQty : quoteQty,
          feePaid: gasEth,
          feeAsset: 'ETH',
          gasUsed: receipt.gasUsed.toString(),
          settledAt: new Date(now),
          updatedAt: new Date(),
          errorCode: parsed ? null : 'fill_estimated',
          errorMessage: parsed ? null : 'Swap event not found; fill amounts estimated from the quote.',
        })
        .where(and(eq(orders.id, r.id), eq(orders.status, 'submitted')))
        .returning();
      if (!row) return;
      await txn.insert(fills).values({ orderId: r.id, accountId: r.accountId, mode: r.mode, market: r.market, side: r.side, price, baseQty, quoteQty, fee: gasEth, feeAsset: 'ETH', txHash: r.txHash });
      await applyFillToPosition(txn, r.accountId, r.mode, r.market, r.side, baseQty, quoteQty, 0);
      this.hooks.onOrder(r.accountId, rowToOrder(row));
    });
    this.hooks.onPortfolio(r.accountId, r.mode);
  }

  private async settle(r: OrderRow, status: OrderStatus, patch: { errorCode: string; errorMessage: string }) {
    const [row] = await this.db
      .update(orders)
      .set({ status, ...patch, settledAt: new Date(this.now()), updatedAt: new Date() })
      .where(and(eq(orders.id, r.id), eq(orders.status, r.status)))
      .returning();
    if (row) this.hooks.onOrder(row.accountId, rowToOrder(row));
  }

  /**
   * Return the configured network id for live/testnet mode. Pure mapping with no authentication, RPC
   * or admission decision; assumes a typed mode.
   * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
   * @see {@link ../../../../docs/security/INVARIANTS.md | Unsigned execution and current admission invariants}
   */
  modeNetwork(mode: 'testnet' | 'live') {
    return NETWORK_FOR_MODE[mode];
  }
}
