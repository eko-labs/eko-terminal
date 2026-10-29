import { z } from 'zod';
import { AddressSchema, TradeOrderSchema, TradeQuoteSchema, UnsignedTxSchema, type PublicConfig, type TradeOrder, type TradeQuote, type UnsignedTx } from '@eko/shared';
import type { TradeHandoff } from '../components/trade/TradeContext';
import { panelBlock, emptyQuote, quoteExpired, tradeRequestKey } from '../components/trade/tradePanelModel';
import { isUserRejection, newIdempotencyKey } from './trade';
import { CHAIN_ID } from '@eko/shared';

export type GuardedPhase = 'idle' | 'quoting' | 'needs_ack' | 'refused' | 'approving' | 'signing' | 'submitted' | 'confirmed' | 'failed';
export type Sent = 'none' | 'approval' | 'swap' | 'unknown';
export interface TradeClient {
  quote(input: TradeHandoff['input']): Promise<TradeQuote>;
  order(body: { quoteId: string; idempotencyKey: string; acknowledged: string[] }): Promise<{ order: TradeOrder; tx: UnsignedTx }>;
  submitted(id: string, txHash: string): Promise<TradeOrder>;
  rejected(id: string, code: 'user_rejected' | 'wallet_error'): Promise<TradeOrder>;
  detail(id: string): Promise<TradeOrder>;
}
export interface GuardedEnv {
  current(): { wallet: { address: string; chainId?: number } | null; accountId: string | null; verifiedWallet: string | null; config: PublicConfig | null };
  client: TradeClient;
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  now(): number;
  approve(step: TradeQuote['approvals'][number], account: string, check: () => void): Promise<string>;
  send(tx: UnsignedTx, account: string, check: () => void): Promise<string>;
  onPhase(phase: GuardedPhase, message: string): void;
  onOrder(order: TradeOrder): void;
  mismatch(): void;
}
export class TradeFlowError extends Error {
  constructor(readonly code: string, readonly sent: Sent, readonly quote?: TradeQuote, readonly requestedAt?: number) {
    const message = sent === 'swap' ? 'Swap sent. Reporting or confirmation is pending.' : sent === 'approval' ? 'An approval was sent. No swap was sent.' : sent === 'unknown' ? 'Wallet request started. Submission is unknown; check order history before trading again.' : 'Nothing was sent.';
    super(message); this.name = 'TradeFlowError';
  }
}
const JournalSchema = z.object({
  scope: z.string(), inputKey: z.string(), idempotencyKey: z.string(), quote: TradeQuoteSchema, requestedAt: z.number(),
  acknowledged: z.array(z.string()), order: TradeOrderSchema.optional(),
  stage: z.enum(['creating', 'ready', 'signing', 'submitted', 'rejected']), txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
  rejection: z.enum(['user_rejected', 'wallet_error']).optional(), sent: z.enum(['none', 'approval', 'swap', 'unknown']), at: z.number(),
});
type Journal = z.infer<typeof JournalSchema>;
const KEY = 'eko.pendingGuardedTrade';
const journalKey = (scope: string) => `${KEY}:${scope}`;
const warnings = (q: TradeQuote) => [...new Set(q.guard.checks.filter(c => c.status === 'warn').map(c => c.code))];
const addressEqual = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const raw = (value: string) => /^(0|[1-9]\d*)$/.test(value);
/** A Pons-curve quote trades on its coin's own curve: the only extra target (and, for a sell, approval spender) the
 * flow accepts beyond the configured routers, and only the curve this quote names. */
const ponsCurve = (q: TradeQuote) => q.route.venue === 'pons_curve' && q.route.poolId && AddressSchema.safeParse(q.route.poolId).success ? q.route.poolId : null;
export function materiallyChanged(a: TradeQuote, b: TradeQuote) {
  const moved = (x: number, y: number) => Math.abs(x - y) > Math.abs(x) * .25;
  return a.fee.bps !== b.fee.bps || moved(a.exitCostPct, b.exitCostPct) || moved(a.priceImpactBps, b.priceImpactBps) ||
    a.route.venue !== b.route.venue || a.route.poolId !== b.route.poolId || a.buyTaxPct !== b.buyTaxPct || a.sellTaxPct !== b.sellTaxPct;
}
/** Durable one-order journal. Reloads replay callbacks, never a wallet request. */
export class GuardedTradeFlow {
  private busy = false;
  private prepared: { quote: TradeQuote; requestedAt: number; inputKey: string; sent: Sent } | null = null;
  constructor(private env: GuardedEnv) {}
  clear() { this.prepared = null; }
  private identity() {
    const c = this.env.current();
    if (!c.wallet || !AddressSchema.safeParse(c.wallet.address).success || !c.accountId || !addressEqual(c.wallet.address, c.verifiedWallet)) throw new TradeFlowError('wallet_mismatch', 'none');
    if (c.wallet.chainId !== CHAIN_ID) throw new TradeFlowError('wrong_network', 'none');
    return `${c.accountId}:${c.wallet.address.toLowerCase()}:${CHAIN_ID}`;
  }
  private check(scope: string) {
    if (scope !== this.identity()) { this.clear(); throw new TradeFlowError('wallet_mismatch', 'none'); }
    const c = this.env.current();
    if (!c.config?.trading.liveEnabled) throw new TradeFlowError('trading_paused', 'none');
    return c;
  }
  private read(): Journal | null {
    try { const value = this.env.storage.getItem(journalKey(this.identity())); return value ? JournalSchema.parse(JSON.parse(value)) : null; }
    catch { throw new TradeFlowError('recovery_unavailable', 'unknown'); }
  }
  private save(j: Journal) {
    try { this.env.storage.setItem(journalKey(j.scope), JSON.stringify(j)); }
    catch { throw new TradeFlowError('recovery_unavailable', j.sent); }
  }
  private gate(h: TradeHandoff, requestedAt: number, scope: string) {
    const c = this.check(scope);
    if (quoteExpired({ ...emptyQuote(), quote: h.quote, requestedAt }, this.env.now())) throw new TradeFlowError('quote_expired', 'none');
    const block = panelBlock({ input: h.input, snapshot: { ...emptyQuote(), quote: h.quote, requestedAt, requestKey: tradeRequestKey(h.input) }, now: this.env.now(),
      liveEnabled: c.config!.trading.liveEnabled, cap: c.config!.trading.maxTradeUsd, stale: false, signerAvailable: true, wallet: c.wallet });
    if (block) throw new TradeFlowError('guard_refused', 'none');
    if (warnings(h.quote).some(code => !h.acknowledged.includes(code))) throw new TradeFlowError('needs_ack', 'none', h.quote, requestedAt);
  }
  private approvals(q: TradeQuote, scope: string) {
    const c = this.check(scope);
    for (const step of q.approvals) {
      if (!AddressSchema.safeParse(step.token).success || !raw(step.amount) || step.amount !== q.amountIn || BigInt(step.amount) <= 0n) throw new TradeFlowError('calldata_mismatch', 'none');
      if (step.kind === 'permit2') {
        // Uniswap v4 sells settle through Permit2: an exact, short-lived (at most 30 minutes) allowance on the quote's own
        // coin to a configured router, sent to the configured Permit2. Anything else is refused before the wallet.
        const nowSec = Math.floor(this.env.now() / 1000), t = c.config!.trading;
        if (!t.permit2 || !addressEqual(step.token, q.coin) || !t.routers.some(a => addressEqual(a, step.spender)) || step.expiration === undefined ||
          !Number.isInteger(step.expiration) || step.expiration <= nowSec || step.expiration > nowSec + 1800 || BigInt(step.amount) >= (1n << 160n) - 1n)
          throw new TradeFlowError('no_route', 'none');
        continue;
      }
      if (!(c.config!.trading.spenders.some(a => addressEqual(a, step.spender)) || (addressEqual(step.spender, ponsCurve(q)) && addressEqual(step.token, q.coin))) ||
        BigInt(step.amount) >= (1n << 256n) - 1n) throw new TradeFlowError('calldata_mismatch', 'none');
      if (step.kind !== 'erc20' || step.expiration !== undefined) throw new TradeFlowError('no_route', 'none');
    }
  }
  private transaction(tx: UnsignedTx, q: TradeQuote, scope: string) {
    const c = this.check(scope);
    if (!UnsignedTxSchema.safeParse(tx).success || !(c.config!.trading.routers.some(a => addressEqual(a, tx.to)) || addressEqual(tx.to, ponsCurve(q))) || !/^0x(?:[0-9a-fA-F]{2})+$/.test(tx.data) ||
      !raw(tx.value) || BigInt(tx.value) >= (1n << 256n) || tx.value !== q.valueWei) {
      this.env.mismatch(); throw new TradeFlowError('calldata_mismatch', 'none');
    }
  }
  private validateOrder(order: TradeOrder, j: Journal) {
    if ((j.order && order.id !== j.order.id) || order.quoteId !== j.quote.id || !addressEqual(order.coin, j.quote.coin) || order.side !== j.quote.side ||
      order.feeBps !== j.quote.fee.bps || (j.txHash && order.txHash && order.txHash !== j.txHash)) throw new TradeFlowError('calldata_mismatch', j.sent);
  }
  private acceptOrder(order: TradeOrder) { this.env.onOrder(order); }
  reconcile(order: TradeOrder): boolean {
    const j = this.read();
    if (!j?.order || j.order.id !== order.id) return false;
    this.validateOrder(order, j);
    const rank = (o: TradeOrder) => o.status === 'awaiting_signature' ? 0 : o.status === 'submitted' ? 1 : 2;
    if (rank(order) < rank(j.order)) return false;
    j.order = order;
    if (j.stage === 'signing' && order.status === 'awaiting_signature') this.env.onPhase('failed', new TradeFlowError('recovery_pending', j.sent).message);
    else this.acceptOrder(order);
    if (rank(order) === 2) this.env.storage.removeItem(journalKey(j.scope)); else { if (order.status === 'submitted') j.stage = 'submitted'; this.save(j); }
    return true;
  }
  async recover(): Promise<TradeOrder | null> {
    const scope = this.identity(), j = this.read();
    if (!j || j.scope !== scope) return null;
    // Expired unknown wallet requests are retained: time alone cannot prove that nothing was broadcast.
    if (!j.order) throw new TradeFlowError('recovery_pending', j.sent);
    let order: TradeOrder;
    try {
      if (j.txHash && j.order.status === 'awaiting_signature') order = await this.env.client.submitted(j.order.id, j.txHash);
      else if (j.rejection) order = await this.env.client.rejected(j.order.id, j.rejection);
      else order = await this.env.client.detail(j.order.id);
    } catch { throw new TradeFlowError('recovery_pending', j.sent); }
    if (scope !== this.identity()) return null;
    // A reconnect snapshot can finish after the wallet or stream advanced the journal.
    // Apply against the current journal; never restore an older signing stage or terminal intent.
    const latest = this.read();
    if (!latest || latest.idempotencyKey !== j.idempotencyKey) return null;
    this.validateOrder(order, latest);
    const rank = (o: TradeOrder) => o.status === 'awaiting_signature' ? 0 : o.status === 'submitted' ? 1 : 2;
    if (latest.order && rank(order) < rank(latest.order)) return latest.order;
    this.reconcile(order);
    if (latest.stage === 'signing' && order.status === 'awaiting_signature') throw new TradeFlowError('recovery_pending', latest.sent);
    return order;
  }
  async execute(h: TradeHandoff): Promise<TradeOrder> {
    if (this.busy) throw new TradeFlowError('busy', 'none');
    this.busy = true;
    let sent: Sent = 'none';
    try {
      const scope = this.identity(), inputKey = tradeRequestKey(h.input);
      const existing = this.read();
      let j: Journal;
      if (existing && existing.scope === scope) {
        sent = existing.sent;
        if (existing.inputKey !== inputKey) throw new TradeFlowError('recovery_pending', sent);
        if (existing.stage !== 'creating' && existing.stage !== 'ready') {
          const order = await this.recover();
          if (order && order.status !== 'awaiting_signature') return order;
          throw new TradeFlowError('recovery_pending', sent);
        }
        j = existing;
        h = { input: h.input, quote: j.quote, acknowledged: j.acknowledged };
      } else {
        const initialAt = h.requestedAt ?? this.env.now();
        this.gate(h, initialAt, scope);
        let q = h.quote, requestedAt = initialAt;
        const prepared = this.prepared;
        if (prepared?.quote.id === q.id && prepared.inputKey === inputKey) { requestedAt = prepared.requestedAt; sent = prepared.sent; }
        else {
          this.env.onPhase('quoting', 'Refreshing wallet-bound quote…');
          requestedAt = this.env.now(); q = await this.env.client.quote(h.input);
          this.gate({ ...h, quote: q, acknowledged: warnings(q).length ? [] : h.acknowledged }, requestedAt, scope);
        }
        // Any refreshed warnings are acknowledged only on the new quote, including unchanged codes.
        if (materiallyChanged(h.quote, q)) {
          this.prepared = { quote: q, requestedAt, inputKey, sent };
          throw new TradeFlowError('quote_changed', sent, q, requestedAt);
        }
        this.approvals(q, scope);
        for (const step of q.approvals) {
          this.gate({ ...h, quote: q }, requestedAt, scope);
          this.env.onPhase('approving', 'Confirm the exact approval in your wallet…');
          const beforeApproval = sent;
          sent = 'unknown';
          try { await this.env.approve(step, h.input.account!, () => { this.gate({ ...h, quote: q }, requestedAt, scope); this.approvals(q, scope); }); }
          catch (error) { if (isUserRejection(error)) sent = beforeApproval; throw error; }
          sent = 'approval';
        }
        if (q.approvals.length) {
          requestedAt = this.env.now(); const refreshed = await this.env.client.quote(h.input);
          this.prepared = { quote: refreshed, requestedAt, inputKey, sent };
          this.gate({ ...h, quote: refreshed, acknowledged: [] }, requestedAt, scope);
          if (refreshed.approvals.length) throw new TradeFlowError('approval_pending', sent, refreshed, requestedAt);
          if (materiallyChanged(q, refreshed)) throw new TradeFlowError('quote_changed', sent, refreshed, requestedAt);
          q = refreshed;
        }
        this.gate({ ...h, quote: q }, requestedAt, scope);
        j = { scope, inputKey, idempotencyKey: newIdempotencyKey(), quote: q, requestedAt, acknowledged: warnings(q), stage: 'creating', sent, at: this.env.now() };
        this.save(j); this.prepared = null;
      }
      this.gate(h = { input: h.input, quote: j.quote, acknowledged: j.acknowledged }, j.requestedAt, scope);
      const placed = await this.env.client.order({ quoteId: j.quote.id, idempotencyKey: j.idempotencyKey, acknowledged: j.acknowledged });
      this.check(scope);
      if (placed.order.quoteId !== j.quote.id || !addressEqual(placed.order.coin, j.quote.coin) || placed.order.side !== j.quote.side || placed.order.feeBps !== j.quote.fee.bps || (j.order && placed.order.id !== j.order.id)) throw new TradeFlowError('calldata_mismatch', sent);
      j.order = placed.order; this.acceptOrder(placed.order);
      if (placed.order.status !== 'awaiting_signature') { this.save(j); await this.recover(); return placed.order; }
      j.stage = 'ready'; this.save(j);
      this.transaction(placed.tx, j.quote, scope);
      this.gate(h, j.requestedAt, scope);
      // Persist before opening the wallet. Reload can inspect this order, but cannot sign it again.
      const beforeSwap = sent;
      j.stage = 'signing'; j.sent = sent = 'unknown'; this.save(j);
      this.env.onPhase('signing', 'Confirm the swap in your wallet…');
      let hash: string;
      try { hash = await this.env.send(placed.tx, h.input.account!, () => { this.gate(h, j.requestedAt, scope); this.transaction(placed.tx, j.quote, scope); }); }
      catch (error) {
        // A non-rejection transport error cannot prove the wallet did not broadcast.
        if (!isUserRejection(error)) throw error;
        j.sent = sent = beforeSwap === 'approval' ? 'approval' : 'none';
        j.stage = 'rejected'; j.rejection = 'user_rejected'; this.save(j);
        const rejected = await this.env.client.rejected(j.order.id, 'user_rejected');
        this.validateOrder(rejected, j);
        if (scope === this.identity()) this.acceptOrder(rejected);
        throw new TradeFlowError('user_rejected', sent);
      }
      if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new TradeFlowError('recovery_pending', 'unknown');
      j.txHash = hash; j.stage = 'submitted'; j.sent = sent = 'swap'; this.save(j);
      // Retain hash across identity changes; replay only in its original authenticated scope.
      if (scope !== this.identity()) throw new TradeFlowError('wallet_mismatch', sent);
      this.env.onPhase('submitted', 'Submitted — waiting for confirmation.');
      const order = await this.env.client.submitted(j.order.id, hash);
      this.validateOrder(order, j);
      if (scope === this.identity()) { const latest = this.read(); if (latest?.idempotencyKey === j.idempotencyKey) this.reconcile(order); }
      return order;
    } catch (error) {
      if (error instanceof TradeFlowError && error.quote && (error.quote.id !== h.quote.id || this.prepared?.quote.id === error.quote.id)) this.prepared = { quote: error.quote, requestedAt: error.requestedAt!, inputKey: tradeRequestKey(h.input), sent };
      const e = error instanceof TradeFlowError ? new TradeFlowError(error.code, sent === 'none' ? error.sent : sent, error.quote, error.requestedAt) : new TradeFlowError(isUserRejection(error) ? 'user_rejected' : (error as { code?: string }).code ?? 'internal_error', sent);
      if (e.code === 'quote_expired') { const j = this.read(); if (j?.stage === 'creating' || j?.stage === 'ready') this.env.storage.removeItem(journalKey(j.scope)); }
      this.env.onPhase(e.code === 'needs_ack' ? 'needs_ack' : 'failed', e.message); throw e;
    } finally { this.busy = false; }
  }
}
