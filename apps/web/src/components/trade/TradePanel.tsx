import { useEffect, useRef, useState } from 'react';
import { AddressSchema, type GuardAssessmentV2, type PublicConfig, type TradeQuote, type TradeQuoteRequest, type Entitlements } from '@eko/shared';
import { useShell } from '../../store/shell';
import { useUi } from '../../store/ui';
import { useApp } from '../../store/app';
import { TradeFlowError } from '../../lib/tradeFlow';
import { serverNow } from '../../lib/clock';
import { formatCoinPrice } from '../../lib/format';
import { inertText } from '../ui';
import { GuardCompact } from '../GuardCompact';
import { AnalysisPolicyNotice } from '../PolicyLinks';
import { REAL_FUNDS, FEE_CURVE_ZERO } from '../../copy';
import { TRADE_COPY as C, TRADE_LABELS as L } from '../../copy/trade';
import { NOT_CHECKED } from '../../copy/availability';
import { panelBlock, quoteMatches, tradeRequestKey, tradeErrorText, emptyQuote, type PanelGate, type QuoteSnapshot } from './tradePanelModel';
import { useTradeQuote } from './useTradeQuote';
import { useTradeExecution, type TradeAdapter } from './TradeContext';
import { useWalletState } from '../../lib/walletState';
import { WalletButton } from '../WalletSlot';
import { TradeWalletVerification } from './TradeWalletVerification';
import { useReconnecting } from '../../lib/useReconnecting';
import { shortTokens, useHolding, type Holding } from './useHolding';
import './trade-panel.css';

const dollars = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 20 })}`;
const modes = { safe: 'Careful', balanced: 'Balanced', degen: 'Degen' };
export function FeeLines({ quote: q, tier, phase }: { quote: TradeQuote; tier?: Entitlements['tier']; phase?: PublicConfig['phase'] }) {
  // TODO(spec): CA-7 has raw quantities but no output asset/decimals. Label raw units explicitly rather than manufacture token amounts.
  return <div data-tour="fee-lines" className="tp-lines"><FeeKey quote={q} phase={phase} /><FeeDetails quote={q} tier={tier} /></div>;
}
/** A cost share for the key: two decimals under 10%, one above (1.9286 → 1.93, 39.92 → 39.9). */
const costPct = (n: number) => String(Math.round(n * (n < 10 ? 100 : 10)) / (n < 10 ? 100 : 10));
/** A guard check's result in the site's words, shown as a small chip (never the raw status code). */
const CHECK_STATUS = { pass: 'Passed', warn: 'Warning', refuse: 'Refused' } as const;
/** The three costs a trader weighs before pressing, side by side: what the trade moves, the fee, the exit cost. */
export function FeeKey({ quote: q, phase }: { quote: TradeQuote; phase?: PublicConfig['phase'] }) {
  const fee = `${q.fee.bps / 100}% (${dollars(q.fee.usd)})`;
  return <dl className="tp-key">
    <div><dt><span aria-hidden="true">Impact</span><span className="sr-only">{L.impact}</span></dt><dd>{costPct(q.priceImpactBps / 100)}%</dd></div>
    <div><dt><span aria-hidden="true">Fee</span><span className="sr-only">{L.fee}</span></dt><dd>{fee}</dd>{q.fee.bps === 0 && (q.route.venue === 'pons_curve' || phase === 'launch_week') && <dd className="tp-key-note">{q.route.venue === 'pons_curve' ? FEE_CURVE_ZERO : C.zeroLaunch}</dd>}</div>
    <div><dt><span aria-hidden="true">Exit</span><span className="sr-only">{L.exit}</span></dt><dd>{costPct(q.exitCostPct)}%</dd></div>
  </dl>;
}
/** Everything else the quote says (raw quantities, route, taxes, network fee, block), for whoever opens Details. */
export function FeeDetails({ quote: q, tier }: { quote: TradeQuote; tier?: Entitlements['tier'] }) {
  return <dl className="tp-quote">
    <dt>{L.pay}</dt><dd>{dollars(q.amountUsd)}</dd>
    <dt>{L.input}</dt><dd>{q.amountIn}</dd><dt>{L.value}</dt><dd>{q.valueWei}</dd>
    <dt>{L.receive}</dt><dd>{q.expectedOut}</dd><dt>{L.minimum}</dt><dd>{q.minOut}</dd>
    <dt>{L.route}</dt><dd>{L.venues[q.route.venue]}{q.route.poolId && <> · {inertText(q.route.poolId)}</>}</dd>
    {tier && <><dt>{L.tier}</dt><dd>{tier}</dd></>}
    <dt>{L.buyTax}</dt><dd>{q.buyTaxPct}%</dd><dt>{L.sellTax}</dt><dd>{q.sellTaxPct}%</dd>
    <dt>{L.network}</dt><dd>{dollars(q.networkFeeUsd)}</dd><dt>{L.block}</dt><dd>{q.asOfBlock}</dd>
  </dl>;
}
export function QuoteGuard({ quote: q, mode }: { quote: TradeQuote; mode: NonNullable<TradeQuoteRequest['riskMode']> }) {
  // TODO(spec): CA-7 GuardCheck has no threshold field. Show the supplied label/value and selected mode; never infer a threshold or re-evaluate Guard locally.
  const refused = q.guard.decision === 'refuse' || q.guard.checks.some(c => c.status === 'refuse');
  return <section className={`tp-guard ${refused ? 'refuse' : q.guard.decision}`}>
    <div className="tp-guard-head">{L.guard}<span className="tag">{refused ? 'Refused' : L.checks(q.guard.checks.filter(c => c.status === 'pass').length)}</span></div>
    {q.guard.checks.some(c => c.status === 'warn') && <p className="tp-warning">{C.warnings(modes[mode])}</p>}
    <details open={refused || q.guard.decision === 'warn'}><summary>{L.guard}</summary><ul className="tp-checks">{q.guard.checks.map((c, i) => <li key={`${c.code}-${i}`} className={`tp-check tp-check-${c.status}`}><span className="tp-ic" aria-hidden="true">{{ pass: '✓', warn: '!', refuse: '×' }[c.status]}</span><span><b>{inertText(c.label)}</b>{c.value !== undefined && <span>{c.value}</span>}</span><span className="tp-st">{CHECK_STATUS[c.status]}</span></li>)}</ul></details>
  </section>;
}
export interface TradePanelProps {
  coin: string; priceUsd?: number; priceUnavailable?: boolean; priceFormat?: (value: number) => string;
  stale?: boolean; visible?: boolean; guard?: GuardAssessmentV2 | null; antiSnipeEndsAt?: number;
  /** A side chosen outside the panel (the phone sheet's Buy and Sell): applied each time it changes. */
  sideRequest?: { side: 'buy' | 'sell'; at: number };
  /** The coin's symbol, for "of your 1.2M FROG". */
  symbol?: string;
}
/** Presentational surface exported for offline contract-state fixtures. */
export function TradePanelView({ gate, tier, phase, priceUsd, priceUnavailable, priceFormat = formatCoinPrice, guard, busy = false, result, confirm = false,
  changeSide, changeAmount, changeSlippage, acknowledge, submit, retry, verification, sell }: {
  gate: PanelGate; tier?: Entitlements['tier']; phase?: PublicConfig['phase']; priceUsd?: number; priceUnavailable?: boolean; priceFormat?: (value: number) => string; guard?: GuardAssessmentV2 | null;
  busy?: boolean; result?: string | null; confirm?: boolean; changeSide: (side: 'buy' | 'sell') => void; changeAmount: (amount: string) => void; changeSlippage: (percent: string) => void;
  acknowledge: () => void; submit: () => void; retry: () => void;
  verification?: TradeAdapter['verification'];
  /** Selling a share of the wallet's bag: the share, the holding read from the chain, and whether the per-trade cap
   *  cut it. Without it a sell is entered in dollars. */
  sell?: { pct: number; changePct: (pct: string) => void; holding: Holding; symbol?: string; capped: boolean };
}) {
  const [connectOpened, setConnectOpened] = useState(false);
  const connect = () => {
    setConnectOpened(true);
    useWalletState.setState({ requested: true });
  };
  const { input, snapshot } = gate, q = snapshot.quote && quoteMatches(snapshot.quote, input) && snapshot.requestKey === tradeRequestKey(input) ? snapshot.quote : null;
  const block = panelBlock(gate), warnings = q?.guard.checks.filter(c => c.status === 'warn') ?? [];
  const needsAck = warnings.some(c => !snapshot.acknowledged.includes(c.code));
  const authBlocked = block === C.connect || block === C.wallet_mismatch;
  const showVerify = verification && !busy && (authBlocked || connectOpened);
  const selling = input.side === 'sell' && !!sell, h = sell?.holding;
  const guardLoud = !!q && (q.guard.decision !== 'allow' || q.guard.checks.some(c => c.status !== 'pass'));
  const settings = <div className="tp-settings"><span className="tp-mode">{L.mode} <b>{modes[input.riskMode ?? 'safe']}</b></span><label className="tp-slippage"><span className="tp-label">{L.slippage}</span><input className="input num" type="number" min="0" max="99.99" step="0.01" inputMode="decimal" value={Number.isFinite(input.slippageBps) ? input.slippageBps / 100 : ''} onChange={e => changeSlippage(e.target.value)} /></label></div>;
  return <>
    <fieldset disabled={busy}><legend className="sr-only">{L.side}</legend>
      <div className="tp-sides" role="radiogroup" aria-label={L.side}>{(['buy', 'sell'] as const).map(v => <button type="button" key={v} role="radio" aria-checked={input.side === v} className={`tp-${v}`} onClick={() => changeSide(v)}>{v === 'buy' ? L.buy : L.sell}</button>)}</div>
      {selling
        // A sell is a share of the bag; its dollar value follows from the holding and the price.
        ? <><label className="tp-amount tp-amount-big"><span className="tp-label">Share of your bag</span><span className="tp-big tp-big-pct"><input className="input num" type="number" min="0" max="100" step="any" inputMode="decimal" value={Number.isFinite(sell!.pct) ? sell!.pct : ''} onChange={e => sell!.changePct(e.target.value)} /><span className="tp-unit tp-unit-end" aria-hidden="true">%</span></span></label>
          <div className="tp-amounts">{[25, 50, 75, 100].map(n => <button type="button" className="btn btn-sm" key={n} aria-pressed={sell!.pct === n} onClick={() => sell!.changePct(String(n))}>{n}%</button>)}</div>
          <p className="tp-hold">{h!.noWallet ? 'Connect a wallet to sell a share of your bag.' : h!.loading ? 'Reading your balance…' : h!.tokens === null ? 'Your balance could not be read.' : h!.tokens === 0 ? 'Your wallet holds none of this coin.'
            : <>≈ <b>{Number.isFinite(input.amountUsd) ? dollars(Math.round(input.amountUsd * 100) / 100) : '—'}</b> of your {shortTokens(h!.tokens)}{sell!.symbol ? ` ${sell!.symbol}` : ''}{sell!.capped && gate.cap !== undefined ? ` · capped at ${dollars(gate.cap)} a trade` : ''}</>}</p></>
        : <><label className="tp-amount tp-amount-big"><span className="tp-label">{L.amount}</span><span className="tp-big"><span className="tp-unit" aria-hidden="true">$</span><input className="input num" type="number" min="0" step="any" inputMode="decimal" value={Number.isFinite(input.amountUsd) ? input.amountUsd : ''} onChange={e => changeAmount(e.target.value)} /></span></label>
          <div className="tp-amounts">{[25, 50, 100, 250].map(n => <button type="button" className="btn btn-sm" key={n} disabled={gate.cap === undefined || n > gate.cap} title={gate.cap === undefined ? C.config : C.cap(gate.cap)} aria-pressed={input.amountUsd === n} onClick={() => changeAmount(String(n))}>{dollars(n)}</button>)}</div>
          {gate.cap !== undefined && input.amountUsd > gate.cap && <p className="note tp-cap">{C.cap(gate.cap)}</p>}</>}
    </fieldset>
    {q && <FeeKey quote={q} phase={phase} />}
    {q && guardLoud && <QuoteGuard quote={q} mode={input.riskMode ?? 'safe'} />}
    {guard && <GuardCompact verdict={{ version: 2, assessment: guard }} />}
    <p className={`tp-status${!busy && !result && block && block !== C.refused && block !== C.notTraded ? ' sr-only' : ''}`} role={block === C.refused ? 'alert' : 'status'} aria-live={block === C.refused ? 'assertive' : 'polite'}>{busy ? C.busy : result ?? block ?? (needsAck ? C.review : null)}</p>
    {showVerify && <TradeWalletVerification verification={verification} fromTradeConnect={connectOpened} />}
    {!(showVerify && authBlocked) && (block === C.connect && !gate.wallet
      ? connectOpened ? <WalletButton trade /> : <button className="btn tp-submit" onClick={connect}>{C.connect}</button>
      : block ? <button className="btn tp-submit" disabled>{block === C.notTraded ? C.notTradedButton : block}</button>
      : needsAck ? <button className="btn tp-submit" disabled={busy} onClick={acknowledge}>{C.acknowledge}</button>
      : <button data-side={input.side} className={`btn tp-submit${input.side === 'buy' ? ' btn-primary' : ''}`} disabled={busy} onClick={submit}>{confirm ? C.confirm : input.side === 'buy' ? L.buy : L.sell} {selling ? `${sell!.pct}%` : dollars(input.amountUsd)}</button>)}
    {snapshot.error && snapshot.error !== 'not_traded' && <button className="btn tp-retry" disabled={busy} onClick={retry}>{C.retry}</button>}
    {/* Everything else, for whoever wants it: settings, the price, the whole quote and the guard's checks. */}
    <details className="tp-more"><summary>Details</summary>
      {settings}
      {priceUsd !== undefined && <dl className="tp-quote"><dt>{L.price}</dt><dd>{priceUnavailable ? NOT_CHECKED : priceFormat(priceUsd)}</dd></dl>}
      {q && <><FeeDetails quote={q} tier={tier} />{!guardLoud && <QuoteGuard quote={q} mode={input.riskMode ?? 'safe'} />}{!q.binding && <p className="note">{C.indicative}</p>}</>}
    </details>
    <div className="tp-fine"><span>{REAL_FUNDS}</span><AnalysisPolicyNotice /></div>
  </>;
}
export function TradePanel({ coin, stale = false, visible = true, sideRequest, symbol, ...display }: TradePanelProps) {
  const config = useShell(s => s.config), wallet = useShell(s => s.me?.account.wallet), tier = useShell(s => s.me?.entitlements.tier), ws = useShell(s => s.wsState);
  const mode = useUi(s => s.riskMode), presets = useApp(s => s.preferences), panel = useRef<HTMLDivElement>(null);
  const [side, setSide] = useState<'buy' | 'sell'>('buy'), [amount, setAmount] = useState(100), [slippage, setSlippage] = useState(presets.defaultSlippageBps);
  // Selling is a share of the bag. Its dollar size follows from the holding and the price; 100% asks a little over the
  // bag so the edge sells exactly the balance (it caps a sell at the wallet's balance) and leaves no dust.
  const [sellPct, setSellPct] = useState(50), [heldAt, setHeldAt] = useState(0);
  const signer = useWalletState(s => s.address) ?? wallet;
  const holding = useHolding(coin, signer ?? undefined, display.priceUsd, heldAt);
  // The price is taken when the share, the side or the balance changes, never on every tick: a live price would
  // resize the trade, re-quote it and drop a pending confirmation each time it moved.
  const pickPrice = useRef<number | undefined>(undefined), pickKey = useRef('');
  const key = `${side}|${sellPct}|${holding.tokens}`;
  if (pickKey.current !== key || pickPrice.current === undefined) { pickKey.current = key; pickPrice.current = display.priceUsd; }
  const bagUsd = holding.tokens !== null && pickPrice.current ? holding.tokens * pickPrice.current : null;
  const sellUsdRaw = bagUsd === null ? NaN : bagUsd * Math.min(100, Math.max(0, sellPct)) / 100 * (sellPct >= 100 ? 1.02 : 1);
  const cap = config?.trading.maxTradeUsd, sellCapped = cap !== undefined && sellUsdRaw > cap;
  const sellUsd = Number.isFinite(sellUsdRaw) ? Math.round(Math.min(sellUsdRaw, cap ?? Infinity) * 100) / 100 : NaN;
  const [result, setResult] = useState<string | null>(null), [executionError, setExecutionError] = useState<string | null>(null);
  const [review, setReview] = useState<QuoteSnapshot | null>(null), [confirm, setConfirm] = useState(false), [lastOrder, setLastOrder] = useState<string | null>(null);
  const activeRequest = useRef('');
  useEffect(() => { if (sideRequest) setSide(sideRequest.side); }, [sideRequest]);
  const execution = useTradeExecution();
  const input: TradeQuoteRequest = { coin: coin as TradeQuoteRequest['coin'], side, amountUsd: side === 'sell' ? sellUsd : amount, slippageBps: slippage, riskMode: mode, ...(wallet ? { account: wallet } : {}) };
  activeRequest.current = `${execution.adapter?.identity ?? ''}:${tradeRequestKey(input)}`;
  const quote = useTradeQuote(input, panel, visible && !execution.busy && !review && AddressSchema.safeParse(coin).success, display.antiSnipeEndsAt);
  const base = review ?? quote.snapshot;
  const snapshot: QuoteSnapshot = executionError ? { ...base, error: executionError } : base;
  // Only the live link being down a moment reads as connecting; data aged by the guard is stale at once.
  const linkBack = useReconnecting(ws), reconnecting = linkBack && !stale;
  const gate: PanelGate = { input, snapshot, now: quote.now, cap: config?.trading.maxTradeUsd, liveEnabled: config?.trading.liveEnabled, stale: stale || ws !== 'open' || !visible, reconnecting, signerAvailable: !!execution.adapter?.wallet, wallet: execution.adapter?.wallet };
  const reset = () => { setResult(null); setExecutionError(null); setReview(null); setConfirm(false); setLastOrder(null); };
  useEffect(reset, [execution.adapter?.identity, input.coin, input.side, input.amountUsd, input.slippageBps, input.riskMode, input.account]);
  useEffect(() => { if (review && (quote.now >= Date.parse(review.quote!.expiresAt) || quote.now - review.requestedAt >= 15000)) { setReview(null); setConfirm(false); } }, [quote.now, review]);
  const submit = async () => {
    if (!execution.adapter) return;
    if (amount > presets.confirmLargeTradeUsd && !confirm) { setConfirm(true); setResult(C.confirmLarge); return; }
    setConfirm(false);
    const request = activeRequest.current;
    try {
      const order = await execution.lock.run({ ...gate, now: serverNow() }, execution.adapter.execute);
      if (request !== activeRequest.current) return;
      if (order) { setLastOrder(order.id); setResult(C.statuses[order.status]); quote.refresh(); setHeldAt(n => n + 1); }
    } catch (error) {
      if (request !== activeRequest.current) return;
      const code = (error as { code?: string }).code ?? 'internal_error';
      if (error instanceof TradeFlowError) {
        if (error.quote && error.requestedAt !== undefined) {
          setReview({ ...emptyQuote(), quote: error.quote, requestedAt: error.requestedAt, requestKey: tradeRequestKey(input) });
          setResult(code === 'quote_changed' ? C.changed : code === 'needs_ack' ? C.review : `${tradeErrorText(code)} ${error.message}`);
        } else { setExecutionError(error.sent === 'none' ? code : 'recovery_pending'); setResult(error.message); }
      } else { setExecutionError(code); setResult(tradeErrorText(code)); }
    }
  };
  const feedback = execution.adapter?.feedback;
  const feedbackMatches = feedback?.order?.coin.toLowerCase() === coin.toLowerCase() && (!lastOrder || lastOrder === feedback.order.id);
  const displayedResult = feedbackMatches && feedback?.order && ['confirmed', 'failed', 'rejected', 'expired'].includes(feedback.order.status) ? feedback.message : result ?? (feedbackMatches || !feedback?.order ? feedback?.message : null);
  // TODO(spec): CA-9 has no venue-link allowlist or per-wallet cap field. Do not trust quote.route.linkOut or parse caps from server prose; display the configured cap and current refusal.
  return <div data-tour="trade" className="tpanel guarded-trade-panel" ref={panel}><TradePanelView gate={gate} tier={tier} phase={config?.phase} {...display} busy={execution.busy} confirm={confirm} result={displayedResult} verification={visible ? execution.adapter?.verification : undefined}
    changeSide={v => { reset(); setSide(v); }} changeAmount={v => { reset(); setAmount(v === '' ? NaN : Number(v)); }} changeSlippage={v => { reset(); setSlippage(v === '' ? NaN : Math.round(Number(v) * 100)); }}
    sell={{ pct: sellPct, changePct: v => { reset(); setSellPct(v === '' ? NaN : Math.min(100, Math.max(0, Number(v)))); }, holding, capped: sellCapped, ...(symbol ? { symbol } : {}) }}
    acknowledge={() => { setResult(null); if (review) setReview({ ...review, acknowledged: [...new Set(review.quote!.guard.checks.filter(c => c.status === 'warn').map(c => c.code))] }); else quote.acknowledge(); }} submit={() => void submit()} retry={() => { reset(); quote.refresh(); }} /></div>;
}
