import type { CoinCard, CoinCardV2, TradeQuote, TradeQuoteRequest } from '@eko/shared';
import { TRADE_COPY as C } from '../../copy/trade';
import { CHAIN_ID } from '@eko/shared';

export interface QuoteSnapshot {
  requestKey: string;
  quote: TradeQuote | null;
  requestedAt: number;
  loading: boolean;
  error: string | null;
  acknowledged: string[];
}
export const tradeRequestKey = (input: TradeQuoteRequest) => JSON.stringify([input.coin.toLowerCase(), input.side, input.amountUsd, input.slippageBps, input.riskMode ?? 'safe', input.account?.toLowerCase() ?? null]);
export const emptyQuote = (): QuoteSnapshot => ({ requestKey: '', quote: null, requestedAt: 0, loading: false, error: null, acknowledged: [] });
export function validTradeInput(input: TradeQuoteRequest) {
  return Number.isFinite(input.amountUsd) && input.amountUsd > 0 && Number.isInteger(input.slippageBps) && input.slippageBps >= 0 && input.slippageBps <= 9999;
}
export function quoteMatches(quote: TradeQuote, input: TradeQuoteRequest) {
  return quote.coin.toLowerCase() === input.coin.toLowerCase() && quote.side === input.side && quote.amountUsd === input.amountUsd &&
    (quote.account?.toLowerCase() ?? null) === (input.account?.toLowerCase() ?? null);
}
export function quoteExpired(snapshot: QuoteSnapshot, now: number) {
  const expiry = Date.parse(snapshot.quote?.expiresAt ?? '');
  return !Number.isFinite(expiry) || now >= expiry || now - snapshot.requestedAt >= 15_000 || now < snapshot.requestedAt;
}
/** Relative legacy clocks are captured once per card; V2 uses the observed absolute end. */
export function antiSnipeDeadline(card: CoinCard | null, rich: CoinCardV2 | null, now: number): number | undefined {
  const end = rich?.tradeability.antiSnipe.value?.endsAt;
  if (end?.status === 'observed') {
    const ms = Number(end.value) * 1000;
    if (Number.isFinite(ms)) return ms;
  }
  if (card?.tradeability.antiSnipe) return now + (card.tradeability.antiSnipe.endsInSec - card.freshness.ageSec) * 1000;
  return undefined;
}
export function tradeErrorText(code: string) {
  switch (code) {
    case 'recovery_pending': case 'recovery_unavailable': return C.recovery;
    case 'user_rejected': return 'Rejected in wallet. No swap was sent.';
    case 'approval_pending': return 'Approval confirmation is pending.';
    case 'approval_required': return 'Approve the exact amount in your wallet first. No swap was sent.';
    case 'scanning': return 'EKO is still scanning this coin. Try again in a moment.';
    case 'trading_paused': return C.paused;
    case 'not_allowlisted': return C.not_allowlisted;
    case 'trade_cap_exceeded': return C.trade_cap_exceeded;
    case 'sanctioned': return C.sanctioned;
    case 'wallet_auth_required': return C.connect;
    case 'wallet_mismatch': return C.wallet_mismatch;
    case 'guard_refused': return C.refused;
    case 'stale_data': return C.stale;
    case 'quote_expired': return C.expired;
    case 'no_route': return C.quoteOnly;
    default: return C.unavailable;
  }
}
export interface PanelGate {
  input: TradeQuoteRequest; snapshot: QuoteSnapshot; now: number;
  liveEnabled?: boolean; cap?: number; stale: boolean; signerAvailable: boolean;
  wallet?: { address: string; chainId?: number } | null;
}
/** Display gating only. Accepted acquisition and current order admission remain server-owned. */
export function panelBlock(g: PanelGate): string | null {
  const { input, snapshot: s } = g, q = s.quote;
  if (!validTradeInput(input)) return C.invalid;
  if (g.liveEnabled === false) return C.paused;
  if (g.cap !== undefined && input.amountUsd > g.cap) return C.cap(g.cap);
  if (g.stale) return C.stale;
  if (g.liveEnabled === undefined) return C.config;
  if (s.error) return tradeErrorText(s.error);
  if (!q || !quoteMatches(q, input) || s.requestKey !== tradeRequestKey(input)) return C.loading;
  const refusals = q.guard.checks.filter(c => c.status === 'refuse');
  // Not scanned yet, or a rescan is running: retryable, unlike a Guard refusal.
  if (refusals.length && refusals.every(c => c.code === 'scanning')) return tradeErrorText('scanning');
  const admissionCodes = ['trading_paused', 'not_allowlisted', 'trade_cap_exceeded', 'sanctioned', 'wallet_mismatch', 'wallet_auth_required'];
  if (refusals.some(c => !admissionCodes.includes(c.code))) return C.refused;
  if (refusals.length) {
    const code = refusals[0].code;
    if (!input.account && ['wallet_auth_required', 'not_allowlisted'].includes(code)) return C.connect;
    return tradeErrorText(code);
  }
  if (q.guard.decision === 'refuse') return C.refused;
  if (!q.route.executable) return C.quoteOnly;
  if (quoteExpired(s, g.now)) return C.expired;
  if (s.loading) return C.refresh;
  if (!input.account) return C.connect;
  if (g.wallet && g.wallet.address.toLowerCase() !== input.account.toLowerCase()) return C.wallet_mismatch;
  if (g.wallet && g.wallet.chainId !== CHAIN_ID) return C.wrongNetwork;
  if (!q.binding) return C.indicative;
  if ((q.fee.bps === 0 && (q.fee.destination !== null || q.fee.usd !== 0)) || (q.fee.bps > 0 && q.fee.destination !== 'burn_wallet')) return C.unavailable;
  if (!g.signerAvailable) return C.signingUnavailable;
  return null;
}

/** Latest-request ownership, per-quote acknowledgement and bounded visible refreshes. */
export class TradeQuoteSession {
  snapshot = emptyQuote();
  private controller: AbortController | null = null;
  private generation = 0;
  private visible = false;
  private disposed = false;
  private poll: ReturnType<typeof setTimeout> | null = null;
  private expiry: ReturnType<typeof setTimeout> | null = null;
  private anti: ReturnType<typeof setTimeout> | null = null;
  private nextRequest = 0;
  private failures = 0;
  constructor(private readonly input: TradeQuoteRequest, private readonly quote: (input: TradeQuoteRequest, signal: AbortSignal) => Promise<TradeQuote>,
    private readonly changed: (snapshot: QuoteSnapshot) => void, private readonly now: () => number, private antiSnipeEndsAt?: number) {}
  private publish(patch: Partial<QuoteSnapshot>) { this.snapshot = { ...this.snapshot, ...patch }; this.changed(this.snapshot); }
  setVisible(visible: boolean) {
    if (this.disposed || this.visible === visible) return;
    this.visible = visible;
    if (this.poll) clearTimeout(this.poll);
    if (this.expiry) clearTimeout(this.expiry);
    if (this.anti) clearTimeout(this.anti);
    if (!visible) { this.generation++; this.controller?.abort(); this.publish({ loading: false, acknowledged: [] }); return; }
    void this.refresh();
    if (this.antiSnipeEndsAt !== undefined && this.antiSnipeEndsAt > this.now()) {
      this.anti = setTimeout(() => void this.refresh(), this.antiSnipeEndsAt - this.now());
    }
  }
  setAntiSnipeEndsAt(deadline?: number) {
    if (deadline === this.antiSnipeEndsAt) return;
    this.antiSnipeEndsAt = deadline;
    if (this.anti) clearTimeout(this.anti);
    if (this.visible && !this.disposed && deadline !== undefined && deadline > this.now()) {
      this.anti = setTimeout(() => void this.refresh(), deadline - this.now());
    }
  }
  async refresh() {
    if (!this.visible || this.disposed || !validTradeInput(this.input)) return;
    if (this.snapshot.loading) return;
    if (this.poll) clearTimeout(this.poll);
    if (this.now() < this.nextRequest) { this.poll = setTimeout(() => void this.refresh(), this.nextRequest - this.now()); return; }
    if (this.expiry) clearTimeout(this.expiry);
    const gen = ++this.generation;
    this.controller?.abort();
    const ac = this.controller = new AbortController(), requestedAt = this.now();
    this.nextRequest = requestedAt + 1000;
    this.publish({ loading: true, error: null, acknowledged: [] });
    try {
      const q = await this.quote(this.input, ac.signal);
      if (this.disposed || ac.signal.aborted || gen !== this.generation) return;
      if (!quoteMatches(q, this.input)) throw { code: 'quote_changed' };
      this.publish({ quote: q, requestKey: tradeRequestKey(this.input), requestedAt, loading: false, error: null, acknowledged: [] });
      this.failures = 0;
      this.poll = setTimeout(() => void this.refresh(), 5000);
      if (this.expiry) clearTimeout(this.expiry);
      const remaining = Math.min(Date.parse(q.expiresAt), requestedAt + 15_000) - this.now();
      // An already-expired backend response must not create a zero-delay retry loop.
      if (remaining > 0) this.expiry = setTimeout(() => void this.refresh(), remaining);
    } catch (error) {
      if (this.disposed || ac.signal.aborted || gen !== this.generation) return;
      const code = (error as { code?: string }).code ?? 'internal_error';
      this.nextRequest = Math.max(this.now() + Math.min(60000, 5000 * 2 ** Math.min(this.failures++, 4)), (error as { retryAt?: number }).retryAt ?? 0);
      this.publish({ loading: false, error: code === 'rate_limited' ? null : code, acknowledged: [] });
      // The API already retries a 429 once. A second refusal waits for a new visible session or user action.
      if (code !== 'rate_limited') this.poll = setTimeout(() => void this.refresh(), this.nextRequest - this.now());
    }
  }
  acknowledge() {
    if (!this.snapshot.quote || this.snapshot.loading || this.snapshot.error || quoteExpired(this.snapshot, this.now())) return;
    const q = this.snapshot.quote;
    if (q.guard.decision === 'refuse' || q.guard.checks.some(c => c.status === 'refuse')) return;
    this.publish({ acknowledged: [...new Set(q.guard.checks.filter(c => c.status === 'warn').map(c => c.code))] });
  }
  dispose() {
    this.disposed = true; this.generation++; this.controller?.abort();
    if (this.poll) clearTimeout(this.poll);
    if (this.expiry) clearTimeout(this.expiry);
    if (this.anti) clearTimeout(this.anti);
  }
}
