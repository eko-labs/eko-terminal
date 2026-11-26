import type { CoinCard, CoinCardV2, TradeQuote, TradeQuoteRequest } from '@eko/shared';
import { TRADE_COPY as C } from '../../copy/trade';
import { BUILD_CHAIN_ID } from '../../lib/chain';

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
    case 'not_traded': return C.notTraded;
    default: return C.unavailable;
  }
}
export interface PanelGate {
  input: TradeQuoteRequest; snapshot: QuoteSnapshot; now: number;
  liveEnabled?: boolean; cap?: number; stale: boolean; reconnecting?: boolean; signerAvailable: boolean;
  wallet?: { address: string; chainId?: number } | null;
  /** A buy entered in the native coin while its USD price is not known yet: the symbol (ETH), so the panel says so. */
  nativeUnknown?: string;
}
/** Display gating only. Accepted acquisition and current order admission remain server-owned. */
export function panelBlock(g: PanelGate): string | null {
  const { input, snapshot: s } = g, q = s.quote;
  // An amount in the native coin before its USD price is known is not wrong, only early: said after pause and config.
  const priceWait = !!g.nativeUnknown && !Number.isFinite(input.amountUsd);
  if (!validTradeInput(priceWait ? { ...input, amountUsd: 1 } : input)) return C.invalid;
  // A coin EKO never trades says so first: unlike a pause, it will not change on its own.
  if (s.error === 'not_traded') return C.notTraded;
  if (g.liveEnabled === false) return C.paused;
  if (g.cap !== undefined && input.amountUsd > g.cap) return C.cap(g.cap);
  if (g.stale) return g.reconnecting ? C.reconnecting : C.stale;
  if (g.liveEnabled === undefined) return C.config;
  if (priceWait) return nativePriceText(g.nativeUnknown!);
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
  if (g.wallet && g.wallet.chainId !== BUILD_CHAIN_ID) return C.wrongNetwork;
  if (!q.binding) return C.indicative;
  if ((q.fee.bps === 0 && (q.fee.destination !== null || q.fee.usd !== 0)) || (q.fee.bps > 0 && q.fee.destination !== 'burn_wallet')) return C.unavailable;
  if (!g.signerAvailable) return C.signingUnavailable;
  return null;
}

/** Latest-request ownership, per-quote acknowledgement and bounded visible refreshes. */
/** How often an open trade panel refreshes its quote (a quote holds for 15 s; every request counts against the
 *  per-address quote limit, which a second tab or a shared mobile IP also draws on). */
export const QUOTE_POLL_MS = 10_000;
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
    // A background tab asks for nothing; it checks again in a while and refreshes once it is in front.
    if (typeof document !== 'undefined' && document.hidden) { if (this.poll) clearTimeout(this.poll); this.poll = setTimeout(() => void this.refresh(), QUOTE_POLL_MS); return; }
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
      this.poll = setTimeout(() => void this.refresh(), QUOTE_POLL_MS);
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
      // A pool EKO does not trade stays that way: no retry loop (a new visible session asks once more).
      if (code !== 'rate_limited' && code !== 'not_traded') this.poll = setTimeout(() => void this.refresh(), this.nextRequest - this.now());
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

/* ---- Amounts in the chain's native coin (GMGN style), balances and quick buy. ------------------------------------ */

export const nativePriceText = (symbol: string) => `Reading the ${symbol} price…`;
/** Raw integer units (a quote's amountIn / expectedOut, a balance) to whole units at `decimals`. */
export function rawToUnits(raw: string | bigint, decimals: number): number {
  let n: bigint;
  try { n = typeof raw === 'bigint' ? raw : BigInt(raw); } catch { return NaN; }
  if (n < 0n || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) return NaN;
  const base = 10n ** BigInt(decimals), whole = n / base, frac = n % base;
  return Number(whole) + Number(frac) / Number(base);
}
/** The native coin's USD price a buy quote implies: dollars asked over native paid (the edge sizes amountIn from it). */
export function nativeUsdOfQuote(q: Pick<TradeQuote, 'side' | 'amountUsd' | 'amountIn'>): number | null {
  if (q.side !== 'buy' || !(q.amountUsd > 0)) return null;
  const native = rawToUnits(q.amountIn, 18), usd = q.amountUsd / native;
  return native > 0 && Number.isFinite(usd) && usd > 0 ? usd : null;
}
/** A native amount to the quote request's dollars, to the cent (NaN when the price is not known). */
export function nativeToUsd(native: number, nativeUsd: number | null | undefined): number {
  if (!Number.isFinite(native) || !nativeUsd || !(nativeUsd > 0)) return NaN;
  return Math.round(native * nativeUsd * 100) / 100;
}
export function usdToNative(usd: number, nativeUsd: number | null | undefined): number {
  if (!Number.isFinite(usd) || !nativeUsd || !(nativeUsd > 0)) return NaN;
  return usd / nativeUsd;
}
/** A native amount, short and exact enough to act on: 0.42, 0.00098, 1.205, 12.4. */
export function formatNative(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n === 0) return '0';
  if (n < 0.000001) return '<0.000001';
  if (n >= 1000) return Math.round(n).toLocaleString('en-US');
  if (n >= 1) return String(Number(n.toFixed(3)));
  return String(Number(n.toPrecision(3)));
}
/** Dollars for an "≈" line: cents, commas, and never a small amount shown as $0.00. */
export function formatUsdShort(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n > 0 && n < 0.01) return '<$0.01';
  const whole = n >= 1000;
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 })}`;
}
/** Kept back from MAX so the wallet can still pay gas for this buy (and a later sell). */
export const GAS_RESERVE = { elysium: 0.02, robinhood: 0.0005 } as const;
/**
 * The largest buy a balance allows: the balance less the gas reserve, kept under the per-trade cap, rounded down to a
 * millionth (the edge sizes buys in millionths). Null when there is nothing to spend.
 */
export function maxBuyNative(balance: number | null, reserve: number, capUsd: number | undefined, nativeUsd: number | null): number | null {
  if (balance === null || !Number.isFinite(balance)) return null;
  let max = balance - reserve;
  if (capUsd !== undefined && nativeUsd && nativeUsd > 0) max = Math.min(max, (capUsd - 0.01) / nativeUsd);
  max = Math.floor(max * 1e6) / 1e6;
  return max > 0 ? max : null;
}
/** Tokens in a share of a holding (whole tokens), NaN when the holding or share is unknown. */
export function sellTokens(tokens: number | null, pct: number): number {
  if (tokens === null || !Number.isFinite(pct) || !Number.isFinite(tokens)) return NaN;
  return tokens * Math.min(100, Math.max(0, pct)) / 100;
}
export const SELL_PRESETS = [10, 25, 50, 100] as const;
export const DEFAULT_PRESETS = { native: [0.001, 0.005, 0.01, 0.05], usd: [25, 50, 100, 250] } as const;
export type AmountUnit = 'native' | 'usd';
export interface BuyPresets { native: number[]; usd: number[] }
/** Saved presets, checked: four positive finite amounts per unit, else the defaults for that unit. */
export function parsePresets(raw: unknown): BuyPresets {
  const ok = (v: unknown): v is number[] => Array.isArray(v) && v.length === 4 && v.every(n => typeof n === 'number' && Number.isFinite(n) && n > 0 && n < 1e9);
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return { native: ok(o.native) ? [...o.native] : [...DEFAULT_PRESETS.native], usd: ok(o.usd) ? [...o.usd] : [...DEFAULT_PRESETS.usd] };
}

/**
 * Quick buy: a tapped preset asks for a quote and goes to the wallet as soon as the quote allows it, through the same
 * gate as the Buy button. Waits while the quote is on its way; stops (for the trader to read) on anything else the
 * gate says, and on warnings that need an acknowledgement. Never signs past a refusal.
 */
export type QuickStep = { step: 'wait' } | { step: 'sign' } | { step: 'stop'; reason: string };
export function quickBuyStep(g: PanelGate): QuickStep {
  if (g.input.side !== 'buy') return { step: 'stop', reason: 'Quick buy is for buys.' };
  const block = panelBlock(g);
  if (block === C.loading || block === C.refresh || block === C.expired || (g.nativeUnknown && block === nativePriceText(g.nativeUnknown))) return { step: 'wait' };
  if (block) return { step: 'stop', reason: block };
  const q = g.snapshot.quote!;
  if (q.guard.checks.some(c => c.status === 'warn' && !g.snapshot.acknowledged.includes(c.code))) return { step: 'stop', reason: C.review };
  return { step: 'sign' };
}
