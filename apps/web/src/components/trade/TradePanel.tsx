import { useEffect, useRef, useState } from 'react';
import { AddressSchema, type GuardAssessmentV2, type PublicConfig, type TradeQuote, type TradeQuoteRequest, type Entitlements } from '@eko/shared';
import { useShell } from '../../store/shell';
import { useUi } from '../../store/ui';
import { useApp } from '../../store/app';
import { TradeFlowError } from '../../lib/tradeFlow';
import { serverNow } from '../../lib/clock';
import { formatCoinPrice } from '../../lib/format';
import { Seg, inertText } from '../ui';
import { GuardCompact } from '../GuardCompact';
import { AnalysisPolicyNotice } from '../PolicyLinks';
import { REAL_FUNDS, FEE_CURVE_ZERO } from '../../copy';
import { TRADE_COPY as C, TRADE_LABELS as L } from '../../copy/trade';
import { NOT_CHECKED } from '../../copy/availability';
import { panelBlock, quoteMatches, tradeRequestKey, tradeErrorText, emptyQuote, type PanelGate, type QuoteSnapshot } from './tradePanelModel';
import { useTradeQuote } from './useTradeQuote';
import { useTradeExecution } from './TradeContext';
import './trade-panel.css';

const dollars = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 20 })}`;
const modes = { safe: 'Careful', balanced: 'Balanced', degen: 'Degen' };
export function FeeLines({ quote: q, tier, phase }: { quote: TradeQuote; tier?: Entitlements['tier']; phase?: PublicConfig['phase'] }) {
  // TODO(spec): CA-7 has raw quantities but no output asset/decimals. Label raw units explicitly rather than manufacture token amounts.
  const fee = `${q.fee.bps / 100}% (${dollars(q.fee.usd)})`;
  return <dl data-tour="fee-lines" className="tp-quote">
    <dt>{L.pay}</dt><dd>{dollars(q.amountUsd)}</dd>
    <dt>{L.input}</dt><dd>{q.amountIn}</dd><dt>{L.value}</dt><dd>{q.valueWei}</dd>
    <dt>{L.receive}</dt><dd>{q.expectedOut}</dd><dt>{L.minimum}</dt><dd>{q.minOut}</dd>
    <dt>{L.route}</dt><dd>{L.venues[q.route.venue]}{q.route.poolId && <> · {inertText(q.route.poolId)}</>}</dd>
    <dt>{L.fee}</dt><dd>{q.fee.bps === 0 ? `${fee}${q.route.venue === 'pons_curve' ? ` · ${FEE_CURVE_ZERO}` : phase === 'launch_week' ? ` · ${C.zeroLaunch}` : ''}` : fee}</dd>
    {tier && <><dt>{L.tier}</dt><dd>{tier}</dd></>}
    <dt>{L.buyTax}</dt><dd>{q.buyTaxPct}%</dd><dt>{L.sellTax}</dt><dd>{q.sellTaxPct}%</dd>
    <dt>{L.exit}</dt><dd>{q.exitCostPct}%</dd><dt>{L.impact}</dt><dd>{q.priceImpactBps / 100}%</dd>
    <dt>{L.network}</dt><dd>{dollars(q.networkFeeUsd)}</dd><dt>{L.block}</dt><dd>{q.asOfBlock}</dd>
  </dl>;
}
export function QuoteGuard({ quote: q, mode }: { quote: TradeQuote; mode: NonNullable<TradeQuoteRequest['riskMode']> }) {
  // TODO(spec): CA-7 GuardCheck has no threshold field. Show the supplied label/value and selected mode; never infer a threshold or re-evaluate Guard locally.
  const refused = q.guard.decision === 'refuse' || q.guard.checks.some(c => c.status === 'refuse');
  return <section className={`tp-guard ${refused ? 'refuse' : q.guard.decision}`}>
    <div className="tp-guard-head">{L.guard}<span className="tag">{refused ? 'Refused' : L.checks(q.guard.checks.filter(c => c.status === 'pass').length)}</span></div>
    {q.guard.checks.some(c => c.status === 'warn') && <p className="tp-warning">{C.warnings(modes[mode])}</p>}
    <details open={refused || q.guard.decision === 'warn'}><summary>{L.guard}</summary><ul className="tp-checks">{q.guard.checks.map((c, i) => <li key={`${c.code}-${i}`}><span className="tp-ic">{{ pass: '✓', warn: '!', refuse: '×' }[c.status]}</span><span><b>{inertText(c.label)}</b><span>{c.status}{c.value !== undefined && ` · ${c.value}`}</span></span></li>)}</ul></details>
  </section>;
}
export interface TradePanelProps {
  coin: string; priceUsd?: number; priceUnavailable?: boolean; priceFormat?: (value: number) => string;
  stale?: boolean; visible?: boolean; guard?: GuardAssessmentV2 | null; antiSnipeEndsAt?: number;
}
/** Presentational surface exported for offline contract-state fixtures. */
export function TradePanelView({ gate, tier, phase, priceUsd, priceUnavailable, priceFormat = formatCoinPrice, guard, busy = false, result, confirm = false,
  changeSide, changeAmount, changeSlippage, acknowledge, submit, retry }: {
  gate: PanelGate; tier?: Entitlements['tier']; phase?: PublicConfig['phase']; priceUsd?: number; priceUnavailable?: boolean; priceFormat?: (value: number) => string; guard?: GuardAssessmentV2 | null;
  busy?: boolean; result?: string | null; confirm?: boolean; changeSide: (side: 'buy' | 'sell') => void; changeAmount: (amount: string) => void; changeSlippage: (percent: string) => void;
  acknowledge: () => void; submit: () => void; retry: () => void;
}) {
  const { input, snapshot } = gate, q = snapshot.quote && quoteMatches(snapshot.quote, input) && snapshot.requestKey === tradeRequestKey(input) ? snapshot.quote : null;
  const block = panelBlock(gate), warnings = q?.guard.checks.filter(c => c.status === 'warn') ?? [];
  const needsAck = warnings.some(c => !snapshot.acknowledged.includes(c.code));
  return <>
    <fieldset disabled={busy}><legend className="sr-only">{L.side}</legend>
      <div className="tp-side"><Seg options={[{ value: 'buy', label: L.buy }, { value: 'sell', label: L.sell }]} value={input.side} onChange={v => changeSide(v as 'buy' | 'sell')} label={L.side} /><span>{L.mode} <b>{modes[input.riskMode ?? 'safe']}</b></span></div>
      <div className="tp-amounts">{[25, 50, 100, 250].map(n => <button type="button" className="btn btn-sm" key={n} disabled={gate.cap === undefined || n > gate.cap} title={gate.cap === undefined ? C.config : C.cap(gate.cap)} aria-pressed={input.amountUsd === n} onClick={() => changeAmount(String(n))}>{dollars(n)}</button>)}
        <label><span className="sr-only">{L.amount}</span><input className="input num" type="number" min="0" step="any" inputMode="decimal" value={Number.isFinite(input.amountUsd) ? input.amountUsd : ''} onChange={e => changeAmount(e.target.value)} /></label></div>
      {gate.cap !== undefined && <p className="note">{C.cap(gate.cap)}</p>}
      <label className="tp-slippage">{L.slippage}<input className="input num" type="number" min="0" max="99.99" step="0.01" inputMode="decimal" value={Number.isFinite(input.slippageBps) ? input.slippageBps / 100 : ''} onChange={e => changeSlippage(e.target.value)} /></label>
    </fieldset>
    {priceUsd !== undefined && <dl className="tp-quote"><dt>{L.price}</dt><dd>{priceUnavailable ? NOT_CHECKED : priceFormat(priceUsd)}</dd></dl>}
    {q && <><FeeLines quote={q} tier={tier} phase={phase} /><QuoteGuard quote={q} mode={input.riskMode ?? 'safe'} />{!q.binding && <p className="note">{C.indicative}</p>}</>}
    {guard && <GuardCompact verdict={{ version: 2, assessment: guard }} />}
    <p className="tp-status" role={block === C.refused ? 'alert' : 'status'} aria-live={block === C.refused ? 'assertive' : 'polite'}>{busy ? C.busy : result ?? block ?? (needsAck ? C.review : null)}</p>
    {block === C.connect ? <button className="btn tp-submit" onClick={() => window.dispatchEvent(new Event('eko:open-wallet'))}>{C.connect}</button> : block ? <button className="btn tp-submit" disabled>{block}</button> : needsAck ? <button className="btn tp-submit" disabled={busy} onClick={acknowledge}>{C.acknowledge}</button> : <button className={`btn tp-submit${input.side === 'buy' ? ' btn-primary' : ''}`} disabled={busy} onClick={submit}>{confirm ? C.confirm : input.side === 'buy' ? L.buy : L.sell} {dollars(input.amountUsd)}</button>}
    {snapshot.error && <button className="btn tp-retry" disabled={busy} onClick={retry}>{C.retry}</button>}
    <p className="note">{REAL_FUNDS}</p><AnalysisPolicyNotice />
  </>;
}
export function TradePanel({ coin, stale = false, visible = true, ...display }: TradePanelProps) {
  const config = useShell(s => s.config), wallet = useShell(s => s.me?.account.wallet), tier = useShell(s => s.me?.entitlements.tier), ws = useShell(s => s.wsState);
  const mode = useUi(s => s.riskMode), presets = useApp(s => s.preferences), panel = useRef<HTMLDivElement>(null);
  const [side, setSide] = useState<'buy' | 'sell'>('buy'), [amount, setAmount] = useState(100), [slippage, setSlippage] = useState(presets.defaultSlippageBps);
  const [result, setResult] = useState<string | null>(null), [executionError, setExecutionError] = useState<string | null>(null);
  const [review, setReview] = useState<QuoteSnapshot | null>(null), [confirm, setConfirm] = useState(false), [lastOrder, setLastOrder] = useState<string | null>(null);
  const activeRequest = useRef('');
  const execution = useTradeExecution();
  const input: TradeQuoteRequest = { coin: coin as TradeQuoteRequest['coin'], side, amountUsd: amount, slippageBps: slippage, riskMode: mode, ...(wallet ? { account: wallet } : {}) };
  activeRequest.current = `${execution.adapter?.identity ?? ''}:${tradeRequestKey(input)}`;
  const quote = useTradeQuote(input, panel, visible && !execution.busy && !review && AddressSchema.safeParse(coin).success, display.antiSnipeEndsAt);
  const base = review ?? quote.snapshot;
  const snapshot: QuoteSnapshot = executionError ? { ...base, error: executionError } : base;
  const gate: PanelGate = { input, snapshot, now: quote.now, cap: config?.trading.maxTradeUsd, liveEnabled: config?.trading.liveEnabled, stale: stale || ws !== 'open' || !visible, signerAvailable: !!execution.adapter?.wallet, wallet: execution.adapter?.wallet };
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
      if (order) { setLastOrder(order.id); setResult(C.statuses[order.status]); quote.refresh(); }
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
  return <div data-tour="trade" className="tpanel guarded-trade-panel" ref={panel}><TradePanelView gate={gate} tier={tier} phase={config?.phase} {...display} busy={execution.busy} confirm={confirm} result={displayedResult}
    changeSide={v => { reset(); setSide(v); }} changeAmount={v => { reset(); setAmount(v === '' ? NaN : Number(v)); }} changeSlippage={v => { reset(); setSlippage(v === '' ? NaN : Math.round(Number(v) * 100)); }}
    acknowledge={() => { setResult(null); if (review) setReview({ ...review, acknowledged: [...new Set(review.quote!.guard.checks.filter(c => c.status === 'warn').map(c => c.code))] }); else quote.acknowledge(); }} submit={() => void submit()} retry={() => { reset(); quote.refresh(); }} /></div>;
}
