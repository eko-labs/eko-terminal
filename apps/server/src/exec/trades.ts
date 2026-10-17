import { rpcPauseRetryAt, safeError } from '@eko/chain';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, lt, or, isNull, sql } from 'drizzle-orm';
import { canonicalize, PreflightRequestSchema, TradeQuoteRequestSchema, TradeQuoteSchema, TradeOrderSchema,
  type ErrorCode, type PreflightRequest, type TradeQuote, type TradeQuoteRequest, type TradeOrder } from '@eko/shared';
import { orderHash, QUOTE_MAX_AGE_MS } from '@eko/policy';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { tradeQuotes, tradeOrders } from '../db/schema.js';
import type { SanctionsService } from '../sanctions/service.js';
import { ActualOrderService, type ActualOrderProbe, type CapturedExecution } from './actual-order.js';
import { ChainQuoteError } from './v3-routes.js';
import { ActualFillSchema, PostFillEvidenceSchema, type TradeReconciliationBackend, type TradeReceipt, type ActualFill, type PostFillEvidence } from './trade-reconcile.js';
import { IncidentService } from '../obs/incidents.js';
import type { TradeAccessService } from './trade-access.js';
import type { SellGuard } from './sell-guard.js';

export const TradeInputSchema = TradeQuoteRequestSchema.extend({
  amountUsd: z.number().positive().finite(), slippageBps: z.number().int().min(0).max(9999),
}).strict();
export const TradeOrderInputSchema = z.strictObject({
  quoteId: z.string().uuid(), idempotencyKey: z.string().min(8).max(80),
  acknowledged: z.array(z.string().min(1).max(100)).max(50),
});
export type TradeOrderInput = z.infer<typeof TradeOrderInputSchema>;
export type RetainedTrade = typeof tradeQuotes.$inferSelect;
export interface TradeOwner { id: string; wallet: string | null }
/** Trusted adapter/acquisition handoff. Never accepted from an HTTP request. Implementations use
 * existing quoteTrade/Pons adapters and accepted account probes, without signing or custody. */
export interface TradeBackend {
  quote(owner: TradeOwner, input: TradeQuoteRequest, id: string): Promise<{ quote: TradeQuote; checked: PreflightRequest | null }>;
  capture(retained: RetainedTrade): Promise<CapturedExecution>;
  probe: ActualOrderProbe;
  reconciliation?: TradeReconciliationBackend;
}
export class TradeError extends Error {
  /**
   * Carry a bounded trade error code and caller-supplied message. Construction performs no
   * authorization or trading operation.
   */
  constructor(readonly code: ErrorCode, message: string) { super(message); }
}
// CA-8 has a bounded error vocabulary; detailed finite Guard denial codes stay on quote checks.
/**
 * Map preparation denial strings into the bounded trade API error vocabulary; unmatched codes
 * become guard_refused. Pure mapping; detailed Guard codes remain on quote checks.
 */
export function preparationError(code: string): ErrorCode {
  if (['trading_paused', 'not_allowlisted', 'trade_cap_exceeded', 'sanctioned', 'quote_expired', 'approval_required', 'wallet_mismatch'].includes(code)) return code as ErrorCode;
  if (code === 'token_approval_required' || code === 'approval_missing' || code === 'approval_pending') return 'approval_required';
  if (/changed|mismatch/.test(code)) return 'quote_changed';
  // The coin is still being scanned: retry shortly (current-verdict admission, exec/live-trade.ts).
  if (code === 'scanning' || /stale|receipt/.test(code)) return 'stale_data';
  if (/unavailable|queued|unsupported|missing/.test(code)) return 'sim_unavailable';
  return 'guard_refused';
}

/** Durable ownership and inputs; each delivery of unsigned bytes goes through 052 again. */
export class TradeService {
  /**
   * Wire durable trade storage, admission/sanctions checks, optional trusted acquisition and
   * lifecycle callbacks. Host construction performs no authentication, signing or provider
   * request; missing backend prevents quote acquisition.
   */
  constructor(private readonly db: Db, private readonly access: TradeAccessService,
    private readonly sanctions: Pick<SanctionsService, 'assertWallet'>, private readonly backend?: TradeBackend,
    private readonly now: () => number = Date.now,
    private readonly lifecycle: { incidents?: IncidentService; onOrder?: (accountId: string, order: TradeOrder) => void;
      /** When installed, every buy quote first re-runs the sell check at its size; a failed sell is a hard refusal. */
      sellGuard?: Pick<SellGuard, 'check' | 'refused'>;
      /** Refusal message while no acquisition backend is installed (for example, the simulation host is unset). */
      unavailable?: string;
      /** Live admission: every buy needs a sellable reading, so a missing sell guard refuses instead of skipping. */
      requireSellCheck?: boolean } = {}) {}

  private async screen(wallet: string | null | undefined) {
    if (!wallet) return;
    try { await this.sanctions.assertWallet(wallet); }
    catch (error) { throw new TradeError((error as { code?: string }).code === 'sanctioned' ? 'sanctioned' : 'stale_data', 'Wallet screening unavailable or refused'); }
  }
  /** BACKEND §12: "the sell fails (honeypot)" refuses in every mode, and a sell check that cannot run refuses too
   * (`sim_unavailable`, fail closed). A refusal never reaches route acquisition or the wallet. */
  private async sellCheck(input: TradeQuoteRequest) {
    const guard = this.lifecycle.sellGuard;
    if (input.side !== 'buy') return;
    if (!guard) {
      if (this.lifecycle.requireSellCheck) throw new TradeError('sim_unavailable', 'The sell check could not run, so the guard refuses this buy');
      return;
    }
    let result: Awaited<ReturnType<SellGuard['check']>>;
    try { result = await guard.check(input.coin, input.amountUsd); }
    catch (error) {
      console.error(JSON.stringify({ level: 50, event: 'trade_sell_check_failed', coin: input.coin, errorClass: error instanceof Error ? error.constructor.name : typeof error, error: safeError(error) }));
      throw new TradeError('sim_unavailable', 'The sell check could not run, so the guard refuses this buy');
    }
    if (result.status === 'refused') {
      // The refusal stands even if counting it fails.
      try { await guard.refused(result, input.amountUsd); } catch { /* counter write is best effort */ }
      throw new TradeError('guard_refused', 'The sell check failed: in simulation this coin could not be sold back, so the guard refuses this buy');
    }
    if (result.status === 'buy_failed') throw new TradeError('guard_refused', 'The buy did not go through in simulation');
    if (result.status !== 'sellable') {
      console.error(JSON.stringify({ level: 50, event: 'trade_sell_check_unusable', coin: input.coin, status: result.status, block: result.block, requests: result.requests }));
      throw new TradeError('sim_unavailable', 'The sell check could not run, so the guard refuses this buy');
    }
  }
  private async admission(owner: TradeOwner, input: TradeQuoteRequest) {
    await this.screen(owner.wallet);
    const denial = await this.access.refusal(owner.wallet, input.amountUsd);
    if (denial) throw new TradeError(denial.code, denial.message);
  }
  private async prepare(retained: RetainedTrade) {
    if (!this.backend || !retained.checked) return { status: 'unavailable' as const, code: 'actual_order_binding_missing' };
    const checked = PreflightRequestSchema.parse(retained.checked);
    let measuredUsd = retained.input.amountUsd;
    const service = new ActualOrderService(async () => {
      const captured = await this.backend!.capture(retained);
      // The host must scope current policy/approvals to the persisted owner, not a caller agent ID.
      if (captured.agent.wallet?.toLowerCase() !== retained.wallet || captured.policy.mode !== retained.input.riskMode)
        return { ...captured, admission: { status: 'denied', code: 'quote_changed' } };
      try { await this.admission({ id: retained.accountId, wallet: retained.wallet }, { ...retained.input, amountUsd: measuredUsd }); }
      catch (error) { return { ...captured, admission: { status: 'denied', code: error instanceof TradeError ? error.code : 'stale_data' } }; }
      return captured;
    }, { observe: async (binding, state, clock) => {
      const observation = await this.backend!.probe.observe(binding, state, clock);
      measuredUsd = Math.max(retained.input.amountUsd, observation.notionalUsd);
      return observation;
    } }, this.now);
    return service.prepare(checked, { quotedAtMs: retained.quotedAt.getTime(), expiresAtMs: retained.expiresAt.getTime() });
  }
  private assertChecked(input: TradeQuoteRequest, quote: TradeQuote, checked: PreflightRequest | null) {
    if (quote.id.length === 0 || quote.coin !== input.coin || quote.side !== input.side || quote.amountUsd !== input.amountUsd || quote.account !== input.account)
      throw new TradeError('quote_changed', 'Adapter quote does not match the request');
    if (!checked) return;
    const b = checked.order.execution;
    if (!b || b.chainId !== 4663 || b.account !== input.account || b.recipient !== input.account || b.coin !== input.coin || b.side !== input.side ||
      b.amountIn !== quote.amountIn || b.minOut !== quote.minOut || b.tx.value !== quote.valueWei || b.slippageBps !== input.slippageBps ||
      Number(b.cursor.blockNumber) !== quote.asOfBlock || checked.order.venue !== 'rhc' || checked.order.instrument.toLowerCase() !== input.coin ||
      checked.order.side !== input.side || checked.order.notionalUsd !== input.amountUsd ||
      canonicalize(checked.order.tx) !== canonicalize({ to: b.tx.to, data: b.tx.data, value: b.tx.value }) ||
      quote.approvals.some(a => a.amount !== quote.amountIn)) throw new TradeError('quote_changed', 'Checked execution does not match the quote');
  }
  /**
   * Validate quote input and any account against the supplied signed-in wallet, screen it and
   * retain the adapter quote under this owner. Reject mismatched bindings and fee-bearing routes;
   * cap original expiry and revalidate executable account quotes. Failed preparation leaves an
   * informational refusal; route/storage failures reject. Caller authenticates owner.
   */
  async quote(owner: TradeOwner, raw: TradeQuoteRequest): Promise<TradeQuote> {
    const input = { ...TradeInputSchema.parse(raw), riskMode: raw.riskMode ?? 'safe' as const };
    if (input.account && (!owner.wallet || input.account !== owner.wallet.toLowerCase())) throw new TradeError('wallet_mismatch', 'Quote account differs from the signed-in wallet');
    await this.screen(input.account);
    await this.sellCheck(input);
    if (!this.backend) throw new TradeError('sim_unavailable', this.lifecycle.unavailable || 'Actual-account trade acquisition is unavailable');
    const id = randomUUID(), quotedAt = this.now();
    let result: Awaited<ReturnType<TradeBackend['quote']>>;
    try { result = await this.backend.quote(owner, input, id); }
    catch (error) {
      if (error instanceof TradeError) throw error;
      if (error instanceof ChainQuoteError && ['bad_request', 'no_route', 'stale_data', 'sim_unavailable', 'quote_changed'].includes(error.code))
        throw new TradeError(error.code as ErrorCode, 'Route quote unavailable or refused');
      // Unexpected failures used to vanish here; log the redacted cause (never URLs or keys) so they are diagnosable.
      console.error(JSON.stringify({ level: 50, event: 'trade_quote_failed', venueError: error instanceof Error ? error.constructor.name : typeof error, error: safeError(error) }));
      throw new TradeError('sim_unavailable', 'Trade acquisition is unavailable');
    }
    let quote = TradeQuoteSchema.parse(result.quote);
    const checked = result.checked ? PreflightRequestSchema.parse(result.checked) : null;
    this.assertChecked(input, quote, checked);
    if (quote.id !== id || !Number.isFinite(Date.parse(quote.expiresAt))) throw new TradeError('quote_changed', 'Invalid adapter quote identity or expiry');
    // Original clock includes acquisition latency. Neither adapters nor callers can renew it.
    const expiresAt = Math.min(Date.parse(quote.expiresAt), quotedAt + QUOTE_MAX_AGE_MS);
    quote = { ...quote, binding: Boolean(input.account && checked && quote.route.executable && quote.guard.decision !== 'refuse' && !quote.guard.checks.some(c => c.status === 'refuse')), expiresAt: new Date(expiresAt).toISOString() };
    if (quote.fee.bps !== 0 || quote.fee.usd !== 0 || quote.fee.destination !== null)
      throw new TradeError('no_route', 'Fee-bearing execution requires accepted fee legs');
    const retained: RetainedTrade = { id, accountId: owner.id, wallet: input.account ?? null, input, quote, checked,
      quotedAt: new Date(quotedAt), expiresAt: new Date(expiresAt), createdAt: new Date(this.now()) };
    if (input.account && checked && quote.route.executable && quote.guard.decision !== 'refuse') {
      const prepared = await this.prepare(retained);
      // Show the exit cost the buy is judged on: the measured round trip at this size, unless the route models it exactly.
      if (prepared.roundTrip && quote.side === 'buy' && quote.exitCostPct === 0) {
        const spent = BigInt(prepared.roundTrip.spent), returned = BigInt(prepared.roundTrip.returned);
        quote = { ...quote, exitCostPct: returned >= spent ? 0 : Number((spent - returned) * 1_000_000n / spent) / 10_000 };
      }
      // Every other check passed and only the wallet's exact approval is missing: the quote stays binding and its
      // listed approval is the next step. Orders keep refusing (approval_required) until the allowance is on chain.
      const approvalOnly = prepared.status !== 'validated' && prepared.code === 'token_approval_required' && quote.approvals.length > 0;
      if (prepared.status !== 'validated' && !approvalOnly) quote = { ...quote, binding: false, guard: { decision: 'refuse', checks: [...quote.guard.checks,
        { code: prepared.code, status: 'refuse', label: prepared.code === 'scanning' ? 'EKO is still scanning this coin; try again shortly'
          : prepared.code === 'round_trip_cost' ? 'Exit cost at this size is above your risk mode’s maximum'
          : 'Current execution checks refused or are unavailable',
          // The exit cost the buy was judged on, shown with the refusal.
          ...(prepared.code === 'round_trip_cost' && quote.exitCostPct > 0 ? { value: quote.exitCostPct } : {}) }] } };
    }
    quote = await this.access.informationalQuote(quote);
    retained.quote = quote;
    await this.db.insert(tradeQuotes).values(retained);
    return quote;
  }
  /**
   * Require an authenticated wallet owner, owned unexpired quote, matching idempotency body and
   * all warning acknowledgements. Recheck admission and current account evidence before returning
   * retained unsigned bytes; serialize quote consumption. Denials, reused intent conflicts and
   * non-awaiting-signature retries reject; no signature or broadcast occurs.
   */
  async order(owner: TradeOwner, raw: TradeOrderInput): Promise<{ order: TradeOrder; tx: NonNullable<PreflightRequest['order']['execution']>['tx']; duplicate: boolean }> {
    const input = TradeOrderInputSchema.parse(raw);
    if (!owner.wallet) throw new TradeError('wallet_auth_required', 'Wallet sign-in required');
    const body = canonicalize(input);
    const find = async () => (await this.db.select().from(tradeOrders).where(and(eq(tradeOrders.accountId, owner.id), eq(tradeOrders.idempotencyKey, input.idempotencyKey))))[0];
    const existing = await find();
    if (existing && existing.requestBody !== body) throw new TradeError('conflict', 'Idempotency key was used with a different body');
    const [retained] = await this.db.select().from(tradeQuotes).where(eq(tradeQuotes.id, input.quoteId));
    if (!retained) throw new TradeError('not_found', 'Quote not found');
    if (retained.accountId !== owner.id) throw new TradeError('forbidden', 'Quote belongs to another account');
    if (retained.wallet && retained.wallet !== owner.wallet.toLowerCase()) throw new TradeError('wallet_mismatch', 'Quote wallet differs from the signed-in wallet');
    await this.admission(owner, retained.input);
    const quote = retained.quote;
    if (this.now() > retained.expiresAt.getTime() || this.now() - retained.quotedAt.getTime() > QUOTE_MAX_AGE_MS)
      throw new TradeError('quote_expired', 'Quote expired; request a fresh quote');
    if (!quote.route.executable) throw new TradeError('no_route', 'Route is quote-only');
    if (!retained.wallet) throw new TradeError('quote_changed', 'An account-bound quote is required');
    if (quote.guard.decision === 'refuse' || quote.guard.checks.some(c => c.status === 'refuse')) throw new TradeError('guard_refused', 'Quote checks refused the trade');
    if (!quote.binding || !retained.checked) throw new TradeError('quote_changed', 'An account-bound quote is required');
    const warnings = quote.guard.checks.filter(c => c.status === 'warn').map(c => c.code);
    if (input.acknowledged.some(code => !warnings.includes(code)) || new Set(input.acknowledged).size !== input.acknowledged.length)
      throw new TradeError('bad_request', 'Acknowledgements must name warnings on this quote');
    if (warnings.some(code => !input.acknowledged.includes(code))) throw new TradeError('guard_refused', 'Acknowledge every warning on this quote');
    const prepared = await this.prepare(retained);
    if (prepared.status !== 'validated') throw new TradeError(preparationError(prepared.code), 'Current execution checks refused or are unavailable');
    await this.admission(owner, retained.input);
    if (this.now() > retained.expiresAt.getTime()) throw new TradeError('quote_expired', 'Quote expired during checks');
    const tx = retained.checked.order.execution!.tx;
    // Serialize consumption on the durable quote; unique constraints also serialize equal keys on different quotes.
    const saved = await this.db.transaction(async db => {
      await db.execute(sql`select id from trade_quotes where id = ${retained.id} for update`);
      const [used] = await db.select().from(tradeOrders).where(eq(tradeOrders.quoteId, retained.id));
      if (used && (used.idempotencyKey !== input.idempotencyKey || used.requestBody !== body)) throw new TradeError('conflict', 'Quote was already used');
      const [inserted] = await db.insert(tradeOrders).values({ accountId: owner.id, quoteId: retained.id,
        idempotencyKey: input.idempotencyKey, requestBody: body, orderHash: orderHash(retained.checked!.order),
        coin: quote.coin, side: quote.side, feeBps: quote.fee.bps, createdAt: new Date(this.now()) }).onConflictDoNothing().returning();
      return inserted ? { row: inserted, duplicate: false } : null;
    });
    const row = saved?.row ?? await find();
    if (!row || row.requestBody !== body) throw new TradeError('conflict', 'Idempotency key was used with a different body');
    if (row.status !== 'awaiting_signature') throw new TradeError('conflict', 'Order is no longer awaiting a signature');
    await this.admission(owner, retained.input);
    if (this.now() > retained.expiresAt.getTime()) throw new TradeError('quote_expired', 'Quote expired while persisting the order');
    if (saved) this.emit(row);
    return { order: this.publicOrder(row), tx, duplicate: saved?.duplicate ?? true };
  }

  private publicOrder(row: typeof tradeOrders.$inferSelect): TradeOrder {
    return TradeOrderSchema.parse({ id: row.id, quoteId: row.quoteId, status: row.status, coin: row.coin,
      side: row.side, feeBps: row.feeBps, createdAt: row.createdAt.toISOString(),
      ...(row.txHash ? { txHash: row.txHash } : {}), ...(row.filledIn !== null ? { filledIn: row.filledIn } : {}),
      ...(row.filledOut !== null ? { filledOut: row.filledOut } : {}), ...(row.errorCode ? { errorCode: row.errorCode } : {}) });
  }
  private emit(row: typeof tradeOrders.$inferSelect) { this.lifecycle.onOrder?.(row.accountId, this.publicOrder(row)); }
  private async own(owner: TradeOwner, id: string) {
    const [row] = await this.db.select().from(tradeOrders).where(and(eq(tradeOrders.id, id), eq(tradeOrders.accountId, owner.id)));
    if (!row) throw new TradeError('not_found', 'Order not found');
    return row;
  }
  /**
   * Return a public projection of an order belonging to the caller-supplied authenticated account.
   * Missing or foreign orders throw not_found; SQL/schema failures propagate.
   */
  async detail(owner: TradeOwner, id: string) { return this.publicOrder(await this.own(owner, id)); }
  /**
   * Read descending creation/id order history scoped to the supplied authenticated account, using
   * an owned order as the optional cursor. Caller bounds limit; return a next cursor when more
   * rows exist. Foreign cursors and storage failures reject.
   */
  async history(owner: TradeOwner, limit = 50, cursor?: string) {
    const before = cursor ? await this.own(owner, cursor) : null;
    const rows = await this.db.select().from(tradeOrders).where(and(eq(tradeOrders.accountId, owner.id),
      before ? or(lt(tradeOrders.createdAt, before.createdAt), and(eq(tradeOrders.createdAt, before.createdAt), lt(tradeOrders.id, before.id))) : undefined))
      .orderBy(desc(tradeOrders.createdAt), desc(tradeOrders.id)).limit(limit + 1);
    return { rows: rows.slice(0, limit).map(r => this.publicOrder(r)), cursor: rows.length > limit ? rows[limit - 1]!.id : null };
  }
  /**
   * Record a valid hash for an owned wallet-bound intent under row and hash locks, allowing the
   * documented one-hour late-report grace. Equal hashes are idempotent; changed/reused hashes or
   * invalid states reject. Caller authenticates owner; reporting does not prove inclusion or a
   * fill.
   */
  async submitted(owner: TradeOwner, id: string, hash: string) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new TradeError('bad_request', 'Invalid transaction hash');
    hash = hash.toLowerCase();
    const saved = await this.db.transaction(async db => {
      await db.execute(sql`select id from trade_orders where id = ${id} and account_id = ${owner.id} for update`);
      const [row] = await db.select().from(tradeOrders).where(and(eq(tradeOrders.id, id), eq(tradeOrders.accountId, owner.id)));
      if (!row) throw new TradeError('not_found', 'Order not found');
      const [quote] = await db.select().from(tradeQuotes).where(eq(tradeQuotes.id, row.quoteId));
      if (!owner.wallet || owner.wallet.toLowerCase() !== quote?.wallet) throw new TradeError('wallet_mismatch', 'Order wallet differs from the signed-in wallet');
      if (row.txHash) {
        if (row.txHash !== hash) throw new TradeError('conflict', 'Order already has a different transaction');
        return null;
      }
      // TODO(spec): retain the existing reconciler's one-hour late-hash grace after unsigned expiry.
      const grace = row.status === 'expired' && this.now() - row.createdAt.getTime() < 3_600_000;
      if (row.status !== 'awaiting_signature' && !grace) throw new TradeError('conflict', 'Order cannot be submitted in its current state');
      // Global uniqueness prevents the same chain transaction filling another intent.
      await db.execute(sql`select pg_advisory_xact_lock(hashtext(${hash}))`);
      const [used] = await db.select().from(tradeOrders).where(eq(tradeOrders.txHash, hash));
      if (used) throw new TradeError('conflict', 'Transaction is already assigned to an order');
      const [next] = await db.update(tradeOrders).set({ status: 'submitted', txHash: hash,
        submittedAt: new Date(this.now()), errorCode: null }).where(eq(tradeOrders.id, id)).returning();
      return next!;
    });
    if (saved) this.emit(saved);
    return this.detail(owner, id);
  }
  /**
   * For the supplied authenticated owner, change only awaiting-signature orders to rejected or
   * failed using the finite wallet outcome. Emit changed rows and return current owned order;
   * missing ownership/storage failures reject.
   */
  async rejected(owner: TradeOwner, id: string, code: 'user_rejected' | 'signing_failed') {
    await this.own(owner, id);
    const [row] = await this.db.update(tradeOrders).set({ status: code === 'user_rejected' ? 'rejected' : 'failed',
      errorCode: code, settledAt: new Date(this.now()) }).where(and(eq(tradeOrders.id, id),
        eq(tradeOrders.accountId, owner.id), eq(tradeOrders.status, 'awaiting_signature'))).returning();
    if (row) this.emit(row);
    return this.detail(owner, id);
  }

  /** Called only by ExecutionService's existing worker loop; no second timer. */
  async reconcile() {
    const stale = await this.db.update(tradeOrders).set({ status: 'expired', errorCode: 'not_signed' })
      .where(and(eq(tradeOrders.status, 'awaiting_signature'), lt(tradeOrders.createdAt, new Date(this.now() - 180_000)))).returning();
    for (const row of stale) this.emit(row);
    const backend = this.backend?.reconciliation;
    if (!backend) return;
    const rows = await this.db.select().from(tradeOrders).where(or(eq(tradeOrders.status, 'submitted'),
      and(eq(tradeOrders.status, 'confirmed'), eq(tradeOrders.side, 'buy'),
        or(isNull(tradeOrders.postFillEvidence), sql`${tradeOrders.postFillEvidence}->>'status' = 'unavailable'`))));
    for (const row of rows) {
      // Provider failures leave the durable work retryable and never manufacture a fill or a guard miss.
      try { await this.reconcileOne(row, backend); } catch(error) { if(rpcPauseRetryAt(error)!==undefined)throw error; /* retry on the next worker tick */ }
    }
  }
  private async reconcileOne(row: typeof tradeOrders.$inferSelect, backend: TradeReconciliationBackend) {
    const [retained] = await this.db.select().from(tradeQuotes).where(eq(tradeQuotes.id, row.quoteId));
    const b = retained?.checked?.order.execution;
    if (!retained || !b || !row.txHash || !backend.supports(retained)) return;
    const hash = row.txHash as `0x${string}`;
    const receipt = await backend.receipt(hash);
    if (!receipt) return;
    const tx = await backend.transaction(hash);
    const same = (a: string | null | undefined, c: string) => a?.toLowerCase() === c.toLowerCase();
    if (!tx || !same(tx.hash, hash) || !same(receipt.transactionHash, hash) || tx.chainId !== b.chainId ||
      !same(tx.from, retained.wallet!) || !same(tx.to, b.tx.to) || !same(tx.input, b.tx.data) ||
      tx.value !== BigInt(b.tx.value) || !same(tx.blockHash, receipt.blockHash)) {
      await this.fail(row, 'tx_mismatch'); return;
    }
    if (receipt.status !== 'success') { await this.fail(row, 'reverted'); return; }
    const decoded = ActualFillSchema.safeParse(await backend.decodeFill(retained, receipt));
    if (!decoded.success || BigInt(decoded.data.filledIn) <= 0n) {
      await this.fail(row, 'missing_swap_logs'); return;
    }
    const fill = decoded.data;
    const evidence = row.side === 'buy' ? await this.sellEvidence(retained, receipt, fill, backend) : null;
    const result = await this.db.transaction(async db => {
      await db.execute(sql`select id from trade_orders where id = ${row.id} for update`);
      const [current] = await db.select().from(tradeOrders).where(eq(tradeOrders.id, row.id));
      if (!current || current.status !== 'submitted' && current.status !== 'confirmed' ||
        current.status === 'confirmed' && (current.side !== 'buy' ||
          current.filledIn !== fill.filledIn || current.filledOut !== fill.filledOut ||
          current.postFillEvidence?.blockHash !== receipt.blockHash) ||
        current.postFillEvidence && current.postFillEvidence.status !== 'unavailable') return null;
      const [next] = await db.update(tradeOrders).set({ status: 'confirmed', ...fill,
        errorCode: null, settledAt: new Date(this.now()), postFillEvidence: evidence }).where(eq(tradeOrders.id, row.id)).returning();
      const incident = evidence?.status === 'failed'
        ? await (this.lifecycle.incidents ?? new IncidentService(this.db)).recordTradeMiss(db, row.accountId, row.id, {
          coin: row.coin, txHash: hash, guardReceiptId: b.guardReceiptId, calldata: b.tx.data,
          quote: retained.quote, fill, evidence,
          transaction: { chainId: tx.chainId, from: tx.from, to: tx.to, input: tx.input, value: tx.value.toString() },
          receipt: { txHash: receipt.transactionHash, blockHash: receipt.blockHash, blockNumber: receipt.blockNumber.toString(),
            status: receipt.status, logs: receipt.logs.map(log => ({ address: log.address, topics: log.topics, data: log.data, logIndex: log.logIndex })) },
        }) : null;
      return { row: next!, incident, changed: current.status === 'submitted' };
    });
    if (result?.changed) this.emit(result.row);
    if (result?.incident) await (this.lifecycle.incidents ?? new IncidentService(this.db)).deliver(row.accountId, result.incident);
  }
  private async sellEvidence(retained: RetainedTrade, receipt: TradeReceipt, fill: ActualFill,
    backend: TradeReconciliationBackend): Promise<PostFillEvidence> {
    const expected = { chainId: 4663 as const, account: retained.wallet! as `0x${string}`, txHash: receipt.transactionHash.toLowerCase(),
      blockHash: receipt.blockHash.toLowerCase(), blockNumber: receipt.blockNumber.toString(), amount: fill.filledOut };
    try {
      const evidence = PostFillEvidenceSchema.parse(await backend.postFillSell(retained, receipt, fill));
      if (canonicalize({ chainId: evidence.chainId, account: evidence.account, txHash: evidence.txHash,
        blockHash: evidence.blockHash, blockNumber: evidence.blockNumber, amount: evidence.amount }) === canonicalize(expected)) return evidence;
    } catch { /* Unavailable replay is not an observed sell failure. */ }
    return { ...expected, status: 'unavailable', origin: 'unavailable', code: 'sim_unavailable',
      checkedAt: new Date(this.now()).toISOString(), evidenceIds: [] };
  }
  private async fail(row: typeof tradeOrders.$inferSelect, errorCode: string) {
    const [next] = await this.db.update(tradeOrders).set({ status: 'failed', errorCode, settledAt: new Date(this.now()) })
      .where(and(eq(tradeOrders.id, row.id), eq(tradeOrders.status, 'submitted'))).returning();
    if (next) this.emit(next);
  }
}
