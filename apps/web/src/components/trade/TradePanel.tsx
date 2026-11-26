import { Suspense, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useAmountSlots, useTradeModes } from './tradeSlots';
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
import { panelBlock, quoteMatches, tradeRequestKey, tradeErrorText, emptyQuote, type PanelGate, type QuoteSnapshot,
  formatNative, formatUsdShort, GAS_RESERVE, maxBuyNative, nativePriceText, nativeToUsd, quickBuyStep, rawToUnits, SELL_PRESETS, sellTokens, usdToNative,
  type AmountUnit, type BuyPresets } from './tradePanelModel';
import { learnNativeUsd, useNativeUsd } from './nativePrice';
import { useTradePrefs } from './tradePrefs';
import { BUILD_NETWORK } from '../../lib/deployment';
import { CHAIN_KEY } from '../../lib/chain';
import { IconBolt } from '../icons';
import { useTradeQuote } from './useTradeQuote';
import { useTradeExecution, type TradeAdapter } from './TradeContext';
import { useWalletState } from '../../lib/walletState';
import { WalletButton } from '../WalletSlot';
import { TradeWalletVerification } from './TradeWalletVerification';
import { useReconnecting } from '../../lib/useReconnecting';
import { shortTokens, useHolding, useNativeBalance, type Holding } from './useHolding';
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
  /** A buy amount in dollars chosen outside the panel: applied each time it changes (converted to the native coin
   *  when the panel takes amounts in it). */
  amountRequest?: { usd: number; at: number };
  /** The coin's symbol, for "of your 1.2M FROG". */
  symbol?: string;
}
/**
 * How a buy is entered: in the native coin (GMGN style: 0.001 / 0.005 / 0.01 / 0.05 ETH) or in dollars, with the
 * trader's presets, the wallet's balance (MAX) and Quick buy. Without it a buy is entered in dollars, as before.
 */
export interface BuyControls {
  unit: AmountUnit; native: string;
  /** The native coin's USD price the panel sizes with (null while unknown). */
  nativeUsd: number | null;
  /** The amount as entered, in `unit`. */
  amount: number;
  presets: number[]; setUnit: (unit: AmountUnit) => void; savePresets: (presets: number[]) => void; pick: (amount: number) => void;
  balance: number | null; max: number | null; reserve: number; fillMax: () => void;
  quick: boolean; setQuick: (on: boolean) => void; quickMsg?: string | null;
}
const LEGACY_PRESETS = [25, 50, 100, 250];
const Pencil = () => <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10.8 2.6l2.6 2.6L5.6 13H3v-2.6z" /><path d="M9.2 4.2l2.6 2.6" /></svg>;
/** Presentational surface exported for offline contract-state fixtures. */
export function TradePanelView({ gate, tier, phase, priceUsd, priceUnavailable, priceFormat = formatCoinPrice, guard, busy = false, result, confirm = false,
  changeSide, changeAmount, changeSlippage, acknowledge, submit, retry, verification, sell, buy, amountNote }: {
  gate: PanelGate; tier?: Entitlements['tier']; phase?: PublicConfig['phase']; priceUsd?: number; priceUnavailable?: boolean; priceFormat?: (value: number) => string; guard?: GuardAssessmentV2 | null;
  busy?: boolean; result?: string | null; confirm?: boolean; changeSide: (side: 'buy' | 'sell') => void; changeAmount: (amount: string) => void; changeSlippage: (percent: string) => void;
  acknowledge: () => void; submit: () => void; retry: () => void;
  verification?: TradeAdapter['verification'];
  /** Selling a share of the wallet's bag: the share, the holding read from the chain, and whether the per-trade cap
   *  cut it. Without it a sell is entered in dollars. */
  sell?: { pct: number; changePct: (pct: string) => void; holding: Holding; symbol?: string; capped: boolean; tokens?: number };
  buy?: BuyControls;
  /** Lines features add under a buy's amount (tradeSlots.tsx), and the largest amount they call sound: buttons above it are marked. */
  amountNote?: { lines: ReactNode; limit: number | null };
}) {
  const [connectOpened, setConnectOpened] = useState(false), [editing, setEditing] = useState<string[] | null>(null);
  const amountId = useId();
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
  // How a buy is entered (the native coin or dollars) and what each amount is in the other unit.
  const native = buy?.native ?? BUILD_NETWORK.nativeSymbol, nativeUsd = buy?.nativeUsd ?? null;
  const unit: AmountUnit = buy?.unit ?? 'usd', presets = buy?.presets ?? LEGACY_PRESETS;
  const entered = buy ? buy.amount : input.amountUsd;
  const presetUsd = (n: number) => unit === 'usd' ? n : nativeToUsd(n, nativeUsd);
  const amountText = (n: number) => unit === 'usd' ? dollars(n) : `${formatNative(n)} ${native}`;
  const sym = sell?.symbol ? ` ${sell.symbol}` : '';
  const held = h && h.tokens !== null && h.tokens > 0 ? h.tokens : null;
  const holdLine = held !== null && <span className="tp-hold-line">You hold <b>{shortTokens(held)}{sym}</b>{priceUsd ? <> ≈ {formatUsdShort(held * priceUsd)}</> : null}</span>;
  const decimals = h?.decimals;
  // The tokens a sell asks for: its share of the bag, or less when the per-trade cap cut it.
  const sellShown = sell ? sell.tokens ?? sellTokens(h!.tokens, sell.pct) : NaN;
  // What the trade gets, from the live quote: tokens for a buy (the coin's decimals read from the chain), the native coin for a sell.
  const out = q ? rawToUnits(q.expectedOut, input.side === 'buy' ? decimals ?? NaN : 18) : NaN;
  const get = q && Number.isFinite(out) && <div className="tp-get" data-side={input.side}>
    <span className="tp-get-k">You get</span>
    <b className="tp-get-v">≈ {input.side === 'buy' ? `${shortTokens(out)}${sym}` : `${formatNative(out)} ${native}`}</b>
    <span className="tp-get-sub">{input.side === 'buy'
      ? <>at least {shortTokens(rawToUnits(q.minOut, decimals!))}{sym} · for {formatNative(rawToUnits(q.valueWei, 18))} {native}</>
      : <>{nativeUsd ? <>≈ {formatUsdShort(out * nativeUsd)} · </> : null}for {shortTokens(rawToUnits(q.amountIn, decimals ?? 18))}{sym}</>}</span>
  </div>;
  const savePresets = () => {
    if (!editing || !buy) return setEditing(null);
    buy.savePresets(editing.map((v, i) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : presets[i]; }));
    setEditing(null);
  };
  const quickOn = !!buy?.quick && input.side === 'buy';
  return <>
    <fieldset disabled={busy}><legend className="sr-only">{L.side}</legend>
      <div className="tp-sides" role="radiogroup" aria-label={L.side}>{(['buy', 'sell'] as const).map(v => <button type="button" key={v} role="radio" aria-checked={input.side === v} className={`tp-${v}`} onClick={() => changeSide(v)}>{v === 'buy' ? L.buy : L.sell}</button>)}</div>
      {selling
        // A sell is a share of the bag; its dollar value follows from the holding and the price.
        ? <><div className="tp-amount-head"><label className="tp-label" htmlFor={amountId}>Share of your bag</label>{holdLine}</div>
          <span className="tp-big tp-big-pct"><input id={amountId} className="input num" type="number" min="0" max="100" step="any" inputMode="decimal" value={Number.isFinite(sell!.pct) ? sell!.pct : ''} onChange={e => sell!.changePct(e.target.value)} /><span className="tp-unit tp-unit-end" aria-hidden="true">%</span></span>
          <div className="tp-amounts">{SELL_PRESETS.map(n => <button type="button" className="btn btn-sm" key={n} aria-pressed={sell!.pct === n} onClick={() => sell!.changePct(String(n))}>{n}%</button>)}</div>
          <p className="tp-hold">{h!.noWallet ? 'Connect a wallet to sell a share of your bag.' : h!.loading ? 'Reading your balance…' : h!.tokens === null ? 'Your balance could not be read.' : h!.tokens === 0 ? 'Your wallet holds none of this coin.'
            : <>Selling <b>{Number.isFinite(sellShown) ? shortTokens(sellShown) : '—'}{sym}</b> ≈ <b>{Number.isFinite(input.amountUsd) ? formatUsdShort(input.amountUsd) : '—'}</b>{!q && nativeUsd && Number.isFinite(input.amountUsd) ? <> · {formatNative(usdToNative(input.amountUsd, nativeUsd))} {native}</> : null}{sell!.capped && gate.cap !== undefined ? ` · capped at ${dollars(gate.cap)} a trade` : ''}</>}</p></>
        : <>{buy && <div className={`tp-quick${quickOn ? ' on' : ''}`}>
            <button type="button" role="switch" aria-checked={buy.quick} className="tp-quick-sw" onClick={() => buy.setQuick(!buy.quick)}><IconBolt size={13} aria-hidden="true" /><span>Quick buy</span><span className="tp-quick-state">{buy.quick ? 'On' : 'Off'}</span></button>
            {quickOn && <span className="tp-quick-note">A tap on an amount quotes it and opens your wallet.</span>}
          </div>}
          <div className="tp-amount-head"><label className="tp-label" htmlFor={amountId}>{L.amount}</label>
            {buy && buy.balance !== null && <button type="button" className="tp-bal" disabled={buy.max === null} title={buy.max === null ? `Not enough ${native} to keep ${formatNative(buy.reserve)} for gas` : `Fill the most you can spend (keeps ${formatNative(buy.reserve)} ${native} for gas)`} onClick={buy.fillMax}>Balance <b>{formatNative(buy.balance)} {native}</b>{buy.max !== null && <span className="tp-bal-max">Max</span>}</button>}</div>
          <span className={`tp-big${buy ? ' tp-big-unit' : ''}`}>{unit === 'usd' && <span className="tp-unit" aria-hidden="true">$</span>}<input id={amountId} className={`input num${unit === 'native' ? ' tp-in-native' : ''}`} type="number" min="0" step="any" inputMode="decimal" value={Number.isFinite(entered) ? entered : ''} onChange={e => changeAmount(e.target.value)} />
            {buy && <span className="tp-unitsw" role="group" aria-label="Enter the amount in">{(['native', 'usd'] as const).map(u => <button type="button" key={u} aria-pressed={unit === u} onClick={() => buy.setUnit(u)}>{u === 'native' ? native : '$'}</button>)}</span>}</span>
          {buy && <div className="tp-sub">{unit === 'native'
            ? <span className="tp-equiv">{nativeUsd === null ? nativePriceText(native) : Number.isFinite(input.amountUsd) ? <>≈ {formatUsdShort(input.amountUsd)}</> : null}</span>
            : <span className="tp-equiv">{nativeUsd !== null && Number.isFinite(input.amountUsd) ? <>≈ {formatNative(usdToNative(input.amountUsd, nativeUsd))} {native}</> : null}</span>}
            {holdLine}</div>}
          <div className={`tp-amounts${buy ? ' tp-amounts-edit' : ''}${quickOn ? ' tp-amounts-quick' : ''}`}>{editing
            ? editing.map((v, i) => <input key={i} className="input num tp-preset-in" type="number" min="0" step="any" inputMode="decimal" aria-label={`Preset ${i + 1} in ${unit === 'usd' ? 'dollars' : native}`} value={v} onChange={e => setEditing(editing.map((x, j) => j === i ? e.target.value : x))} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); savePresets(); } }} />)
            : presets.map((n, i) => { const usd = presetUsd(n); return <button type="button" className={`btn btn-sm${amountNote?.limit != null && usd > amountNote.limit ? ' tp-amount-over' : ''}`} key={`${i}-${n}`} disabled={gate.cap === undefined || usd > gate.cap} title={gate.cap === undefined ? C.config : quickOn ? `Quick buy ${amountText(n)}` : C.cap(gate.cap)} aria-pressed={entered === n} onClick={() => buy ? buy.pick(n) : changeAmount(String(n))}>{quickOn && <IconBolt size={11} aria-hidden="true" />}{unit === 'usd' ? dollars(n) : formatNative(n)}</button>; })}
            {buy && <button type="button" className={`btn btn-sm tp-pencil${editing ? ' on' : ''}`} aria-label={editing ? 'Save presets' : 'Edit presets'} title={editing ? 'Save presets' : 'Edit presets'} onClick={() => editing ? savePresets() : setEditing(presets.map(String))}>{editing ? '✓' : <Pencil />}</button>}</div>
          {buy?.quickMsg && <p className="tp-quick-msg" role="status">{buy.quickMsg}</p>}
          {gate.cap !== undefined && input.amountUsd > gate.cap && <p className="note tp-cap">{C.cap(gate.cap)}</p>}
          {input.side === 'buy' && amountNote?.lines}</>}
    </fieldset>
    {get}
    {q && <FeeKey quote={q} phase={phase} />}
    {q && guardLoud && <QuoteGuard quote={q} mode={input.riskMode ?? 'safe'} />}
    {guard && <GuardCompact verdict={{ version: 2, assessment: guard }} />}
    <p className={`tp-status${!busy && !result && block && block !== C.refused && block !== C.notTraded ? ' sr-only' : ''}`} role={block === C.refused ? 'alert' : 'status'} aria-live={block === C.refused ? 'assertive' : 'polite'}>{busy ? C.busy : result ?? block ?? (needsAck ? C.review : null)}</p>
    {showVerify && <TradeWalletVerification verification={verification} fromTradeConnect={connectOpened} />}
    {!(showVerify && authBlocked) && (block === C.connect && !gate.wallet
      ? connectOpened ? <WalletButton trade /> : <button className="btn tp-submit" onClick={connect}>{C.connect}</button>
      : block ? <button className="btn tp-submit" disabled>{block === C.notTraded ? C.notTradedButton : block}</button>
      : needsAck ? <button className="btn tp-submit" disabled={busy} onClick={acknowledge}>{C.acknowledge}</button>
      : <button data-side={input.side} className={`btn tp-submit${input.side === 'buy' ? ' btn-primary' : ''}`} disabled={busy} onClick={submit}>{confirm ? C.confirm : input.side === 'buy' ? L.buy : L.sell} {selling ? `${sell!.pct}%` : buy ? amountText(buy.amount) : dollars(input.amountUsd)}</button>)}
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
/** A preset's default when the panel opens: the third (0.01 ETH, or $100). */
const startAmount = (p: BuyPresets, unit: AmountUnit) => p[unit][2] ?? p[unit][0];
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
export function TradePanel({ coin, stale = false, visible = true, sideRequest, amountRequest, symbol, ...display }: TradePanelProps) {
  const config = useShell(s => s.config), wallet = useShell(s => s.me?.account.wallet), tier = useShell(s => s.me?.entitlements.tier), ws = useShell(s => s.wsState);
  const mode = useUi(s => s.riskMode), appPrefs = useApp(s => s.preferences), panel = useRef<HTMLDivElement>(null);
  const prefs = useTradePrefs(), native = config?.chain?.native ?? BUILD_NETWORK.nativeSymbol;
  const [side, setSide] = useState<'buy' | 'sell'>('buy'), [amount, setAmount] = useState(() => startAmount(prefs.presets, prefs.unit)), [slippage, setSlippage] = useState(appPrefs.defaultSlippageBps);
  const cap = config?.trading.maxTradeUsd, coinOk = AddressSchema.safeParse(coin).success;
  // The native coin's USD price, learned from buy quotes (nativePrice.ts). A buy entered in the native coin takes it
  // when the amount, unit or side changes, never on every quote: each quote restates it a little differently, and a
  // moving price would resize the trade, re-quote it and drop a pending confirmation each time.
  const nativeLive = useNativeUsd(coin, visible && coinOk, Math.min(25, cap ?? 25));
  const pickNative = useRef<number | null>(null), pickNativeKey = useRef('');
  const nativeKey = `${side}|${prefs.unit}|${amount}`;
  if (pickNativeKey.current !== nativeKey || pickNative.current === null) { pickNativeKey.current = nativeKey; pickNative.current = nativeLive; }
  const nativeUsd = pickNative.current;
  const buyUsd = prefs.unit === 'usd' ? amount : nativeToUsd(amount, nativeUsd);
  // Features' lines under a buy's amount, and the other ways to trade they add beside real trading (tradeSlots.tsx).
  const amountNote = useAmountSlots(coin, buyUsd), modes = useTradeModes(), [modeLabel, setModeLabel] = useState<string | null>(null);
  const altMode = modes.find(m => m.label === modeLabel);
  // Selling is a share of the bag. Its dollar size follows from the holding and the price; 100% asks a little over the
  // bag so the edge sells exactly the balance (it caps a sell at the wallet's balance) and leaves no dust.
  const [sellPct, setSellPct] = useState(50), [heldAt, setHeldAt] = useState(0);
  const signer = useWalletState(s => s.address) ?? wallet;
  const holding = useHolding(coin, signer ?? undefined, display.priceUsd, heldAt);
  const balance = useNativeBalance(signer ?? undefined, heldAt);
  // The price is taken when the share, the side or the balance changes, never on every tick: a live price would
  // resize the trade, re-quote it and drop a pending confirmation each time it moved.
  const pickPrice = useRef<number | undefined>(undefined), pickKey = useRef('');
  const key = `${side}|${sellPct}|${holding.tokens}`;
  if (pickKey.current !== key || pickPrice.current === undefined) { pickKey.current = key; pickPrice.current = display.priceUsd; }
  const bagUsd = holding.tokens !== null && pickPrice.current ? holding.tokens * pickPrice.current : null;
  const sellUsdRaw = bagUsd === null ? NaN : bagUsd * Math.min(100, Math.max(0, sellPct)) / 100 * (sellPct >= 100 ? 1.02 : 1);
  const sellCapped = cap !== undefined && sellUsdRaw > cap;
  const sellUsd = Number.isFinite(sellUsdRaw) ? Math.round(Math.min(sellUsdRaw, cap ?? Infinity) * 100) / 100 : NaN;
  const sellTokensAsked = holding.tokens === null ? NaN : sellCapped && pickPrice.current ? sellUsd / pickPrice.current : sellTokens(holding.tokens, sellPct);
  const [result, setResult] = useState<string | null>(null), [executionError, setExecutionError] = useState<string | null>(null);
  const [review, setReview] = useState<QuoteSnapshot | null>(null), [confirm, setConfirm] = useState(false), [lastOrder, setLastOrder] = useState<string | null>(null);
  const [quickPending, setQuickPending] = useState<{ amount: number; unit: AmountUnit; at: number } | null>(null), [quickMsg, setQuickMsg] = useState<string | null>(null);
  const activeRequest = useRef('');
  const pendingUsd = useRef<number | null>(null);
  const applyUsd = (usd: number) => {
    if (prefs.unit === 'usd') { setAmount(usd); pendingUsd.current = null; }
    else if (nativeLive) { setAmount(round6(usd / nativeLive)); pendingUsd.current = null; }
    else pendingUsd.current = usd;
  };
  useEffect(() => { if (sideRequest) setSide(sideRequest.side); }, [sideRequest]);
  useEffect(() => { if (amountRequest) { setSide('buy'); setQuickPending(null); applyUsd(amountRequest.usd); } }, [amountRequest]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (nativeLive && pendingUsd.current !== null) applyUsd(pendingUsd.current); }, [nativeLive]); // eslint-disable-line react-hooks/exhaustive-deps
  const execution = useTradeExecution();
  const input: TradeQuoteRequest = { coin: coin as TradeQuoteRequest['coin'], side, amountUsd: side === 'sell' ? sellUsd : buyUsd, slippageBps: slippage, riskMode: mode, ...(wallet ? { account: wallet } : {}) };
  activeRequest.current = `${execution.adapter?.identity ?? ''}:${tradeRequestKey(input)}`;
  const quote = useTradeQuote(input, panel, visible && !execution.busy && !review && coinOk, display.antiSnipeEndsAt);
  useEffect(() => { if (quote.snapshot.quote) learnNativeUsd(quote.snapshot.quote); }, [quote.snapshot.quote]);
  const base = review ?? quote.snapshot;
  const snapshot: QuoteSnapshot = executionError ? { ...base, error: executionError } : base;
  // Only the live link being down a moment reads as connecting; data aged by the guard is stale at once.
  const linkBack = useReconnecting(ws), reconnecting = linkBack && !stale;
  const gate: PanelGate = { input, snapshot, now: quote.now, cap, liveEnabled: config?.trading.liveEnabled, stale: stale || ws !== 'open' || !visible, reconnecting, signerAvailable: !!execution.adapter?.wallet, wallet: execution.adapter?.wallet,
    ...(side === 'buy' && prefs.unit === 'native' && nativeUsd === null ? { nativeUnknown: native } : {}) };
  const reset = () => { setResult(null); setExecutionError(null); setReview(null); setConfirm(false); setLastOrder(null); };
  useEffect(reset, [execution.adapter?.identity, input.coin, input.side, input.amountUsd, input.slippageBps, input.riskMode, input.account]);
  useEffect(() => { if (review && (quote.now >= Date.parse(review.quote!.expiresAt) || quote.now - review.requestedAt >= 15000)) { setReview(null); setConfirm(false); } }, [quote.now, review]);
  const submit = async () => {
    if (!execution.adapter) return;
    if (input.amountUsd > appPrefs.confirmLargeTradeUsd && !confirm) { setConfirm(true); setResult(C.confirmLarge); return; }
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
  // Quick buy: once the tapped amount's own quote is in, go to the wallet through the same gate (and lock) as the Buy
  // button; anything the gate or the guard says stops it, with the reason on screen. One tap, one attempt.
  useEffect(() => {
    if (!quickPending || execution.busy) return;
    if (quickPending.amount !== amount || quickPending.unit !== prefs.unit || side !== 'buy' || !prefs.quick) { setQuickPending(null); setQuickMsg(null); return; }
    const step = quickBuyStep(gate);
    if (step.step === 'wait') {
      if (Date.now() - quickPending.at > 20_000) { setQuickPending(null); setQuickMsg('Quick buy stopped: no quote in time. Nothing was sent.'); }
      return;
    }
    setQuickPending(null);
    if (step.step === 'stop') { setQuickMsg(`Quick buy stopped: ${step.reason}`); return; }
    setQuickMsg(null);
    void submit();
  });
  const unitAmount = (n: number) => prefs.unit === 'usd' ? dollars(n) : `${formatNative(n)} ${native}`;
  const max = maxBuyNative(balance, GAS_RESERVE[CHAIN_KEY], cap, nativeUsd ?? nativeLive);
  const buy: BuyControls = {
    unit: prefs.unit, native, nativeUsd: side === 'buy' ? nativeUsd : nativeLive, amount, presets: prefs.presets[prefs.unit],
    setUnit: u => {
      if (u === prefs.unit) return;
      reset(); setQuickPending(null); setQuickMsg(null);
      const price = nativeUsd ?? nativeLive;
      // Keep the trade's size across the switch when the price is known; else start from that unit's default.
      const next = !Number.isFinite(amount) || !price ? startAmount(prefs.presets, u) : u === 'usd' ? Math.round(amount * price * 100) / 100 : round6(amount / price);
      prefs.setUnit(u); setAmount(next);
    },
    savePresets: p => prefs.setPresets({ ...prefs.presets, [prefs.unit]: p }),
    pick: n => {
      reset(); setAmount(n);
      if (prefs.quick && side === 'buy') { setQuickPending({ amount: n, unit: prefs.unit, at: Date.now() }); setQuickMsg(`Quick buy ${unitAmount(n)}: getting the quote…`); }
      else { setQuickPending(null); setQuickMsg(null); }
    },
    balance, max, reserve: GAS_RESERVE[CHAIN_KEY],
    fillMax: () => {
      if (max === null) return;
      const price = nativeUsd ?? nativeLive;
      reset(); setQuickPending(null); setQuickMsg(null); setSide('buy');
      if (prefs.unit === 'native') setAmount(max); else if (price) setAmount(Math.floor(max * price * 100) / 100);
    },
    quick: prefs.quick, setQuick: on => { prefs.setQuick(on); if (!on) { setQuickPending(null); setQuickMsg(null); } },
    quickMsg,
  };
  const feedback = execution.adapter?.feedback;
  const feedbackMatches = feedback?.order?.coin.toLowerCase() === coin.toLowerCase() && (!lastOrder || lastOrder === feedback.order.id);
  const displayedResult = feedbackMatches && feedback?.order && ['confirmed', 'failed', 'rejected', 'expired'].includes(feedback.order.status) ? feedback.message : result ?? (feedbackMatches || !feedback?.order ? feedback?.message : null);
  // TODO(spec): CA-9 has no venue-link allowlist or per-wallet cap field. Do not trust quote.route.linkOut or parse caps from server prose; display the configured cap and current refusal.
  const modeSwitch = modes.length > 0 && <div className="tp-modes" role="radiogroup" aria-label="Trade with">{[null, ...modes.map(m => m.label)].map(l => <button type="button" role="radio" key={l ?? 'real'} aria-checked={modeLabel === l} onClick={() => setModeLabel(l)}>{l ?? 'Real'}</button>)}</div>;
  if (altMode) { const Alt = altMode.panel; return <div data-tour="trade" className="tpanel guarded-trade-panel" ref={panel}>{modeSwitch}<Suspense fallback={null}><Alt coin={coin} {...(symbol ? { symbol } : {})} {...(display.priceUsd !== undefined ? { priceUsd: display.priceUsd } : {})} back={() => setModeLabel(null)} /></Suspense></div>; }
  return <div data-tour="trade" className={`tpanel guarded-trade-panel${prefs.quick && side === 'buy' ? ' tp-quick-on' : ''}`} ref={panel}>{modeSwitch}<TradePanelView amountNote={amountNote} gate={gate} tier={tier} phase={config?.phase} {...display} busy={execution.busy} confirm={confirm} result={displayedResult} verification={visible ? execution.adapter?.verification : undefined}
    changeSide={v => { reset(); setQuickPending(null); setQuickMsg(null); setSide(v); }} changeAmount={v => { reset(); setQuickPending(null); setQuickMsg(null); setAmount(v === '' ? NaN : Number(v)); }} changeSlippage={v => { reset(); setSlippage(v === '' ? NaN : Math.round(Number(v) * 100)); }}
    sell={{ pct: sellPct, changePct: v => { reset(); setSellPct(v === '' ? NaN : Math.min(100, Math.max(0, Number(v)))); }, holding, capped: sellCapped, tokens: sellTokensAsked, ...(symbol ? { symbol } : {}) }} buy={buy}
    acknowledge={() => { setResult(null); if (review) setReview({ ...review, acknowledged: [...new Set(review.quote!.guard.checks.filter(c => c.status === 'warn').map(c => c.code))] }); else quote.acknowledge(); }} submit={() => void submit()} retry={() => { reset(); quote.refresh(); }} /></div>;
}
