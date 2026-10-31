import { useRealtime } from '../../lib/RealtimeContext';
import { BlueChipBadge } from '../../components/BlueChip';
import { DANGER_ACCEPTED_TITLE, REFUSED_TITLE, TRADING_PAUSED_TITLE } from '../../copy/availability';
import { useShell } from '../../store/shell';
import { useUi } from '../../store/ui';
import { WatchButton } from '../../components/WatchButton';
import { useGuardCoin } from './useGuardCoin';
import { antiSnipeDeadline } from '../../components/trade/tradePanelModel';
import { serverNow } from '../../lib/clock';
import { TradePanel } from '../../components/trade/TradePanel';
import { CompactVerdictChip, GuardCompact, RatingPriceFact } from '../../components/GuardCompact';
import { AnalysisPolicyNotice } from '../../components/PolicyLinks';
import { SCANNING, SCAN_DELAYED, NOT_CHECKED, NOT_FULLY_CHECKED, RUN_UP_LEGEND, SELL_CHECK_TEXT, SELL_FAILS, SELL_FAILS_TITLE, runUpTitle } from '../../copy/availability';
import { runUpScore } from '../../lib/runUp';
import { exitMeasured, sellCheckOf } from '../../lib/sellCheck';
import { memo, useEffect, useMemo, useRef, type ReactNode } from 'react';
import type { CoinCard, CoinSignal, RadarRow, Flow } from '@eko/shared';
import { HeatTag, Info, UnavailableValue, UntrustedText, VerdictChip } from '../../components/ui';
import { MiniBars, Spark } from '../../components/ui/charts';
import { activityRatio, displayHeat, heatOf, marking, markClass, type HeatRow } from '../../lib/heat';
import { fetchParsed, isRateLimited } from '../../lib/api';
import { CoinCardSchema } from '@eko/shared';
import { useState } from 'react';
import { useMedia } from '../../lib/useMedia';
import { expandTo } from '../../lib/expand';
import { Link } from '../../lib/Link';
import { Decode, Roll } from './radarMotion';
import { age, exitText, pct, PLAYBOOK_NAMES, price, refused, usd } from './radarModel';
import { formatAge, formatCoinPrice } from '../../lib/format';
import { launchpadLabel } from '../../copy/chain';
import { FlowBar } from './FlowBar';

export { FlowBar };

export const ROLES = ['momentum', 'liquidity', 'holders', 'narrative', 'risk'] as const;
export function SignalBars({ signal }: { signal: CoinSignal }) {
  return <span className="rt-sig"><b className="num">{signal.composite}</b><span className="rt-read" aria-hidden="true">{ROLES.map((role) => <i key={role} style={{ height: `${Math.max(14, signal.readings[role])}%` }} />)}</span></span>;
}
export function HeatLegend() {
  return <div className="heat-legend" aria-label="How rows are marked">{['Hot', 'Normal', 'Fading', 'Danger'].map((word, i) => <span key={word}><i className={`sw ${['hot', 'normal', 'fading', 'avoid'][i]}`} />{word}</span>)}<Info label="How rows are marked">A blue-white shimmer grows from warming (3%+ in an hour, agents 25%+, signal 60+) to Hot (signal 70+, rising, agents 30%+) to surging (10%+, agents 40%+). A dark ember marks falling activity (down 8%+, signal under 65), Danger, and red flags (honeypot, 75%+ exit cost, or a Danger match at 97%+ confidence). Danger always wins. Without signal, only price and flow predicates apply. The marks describe activity; they are not a reason to buy. {RUN_UP_LEGEND}</Info></div>;
}
export const RadarRowView = memo(function RadarRowView({ c, selected, select, trade, pulse, confidence, scanDelayed = false }: { c: RadarRow; selected: boolean; select: (c: RadarRow, el: HTMLElement) => void; trade: (c: RadarRow, el: HTMLElement) => void; pulse: number; confidence?: number; scanDelayed?: boolean }) {
  const tradingLive = useShell((st) => st.config?.trading.liveEnabled !== false);
  const el = useRef<HTMLTableRowElement>(null);
  useEffect(() => { const row = el.current; if (!pulse || !row) return; row.classList.remove('pulse'); void row.offsetWidth; row.classList.add('pulse'); }, [pulse]);
  const score = c.verdictPending || c.verdict === 'pending' ? undefined : runUpScore(c);
  const riskMode = useUi((st) => st.riskMode), no = refused(c, riskMode);
  return <tr ref={el} data-address={c.address} className={`h-${heatOf(c)} ${markClass(marking(c))}${selected ? ' sel' : ''}`} onClick={(e) => select(c, e.currentTarget.querySelector<HTMLButtonElement>('[data-pick]')!)}>
    <td className="c-coin"><button data-pick className="rt-pick" aria-pressed={selected} aria-controls={selected ? 'radar-inspector' : undefined} onClick={(e) => { e.stopPropagation(); select(c, e.currentTarget); }}><span className="rt-top"><span className="rt-sym" title={`$${c.symbol.text}`}><Decode text={`$${c.symbol.text}`}><span>$<UntrustedText value={c.symbol} /></span></Decode></span><BlueChipBadge value={c.blueChip} /><HeatTag heat={displayHeat(c)} /></span><span className="rt-name"><UntrustedText value={c.name} /> · <span className="rt-pad">{launchpadLabel(c.launchpad, c.stage === 'graduated')}</span> · {age(c.ageSec)}</span></button></td>
    <td className="c-guard"><CompactVerdictChip priceMove={c.priceMove} level={c.verdict} guard={c.guardV2} failed={c.guardRefreshFailed} pending={c.verdictPending} scanDelayed={scanDelayed} evaluatedPlaybooks={c.evaluatedPlaybooks} missing={c.missingChecks} detail={score === undefined ? undefined : String(score)} detailTitle={score === undefined ? undefined : runUpTitle(score)} /></td>
    <td className="c-watch">{c.topPlaybook ? <><span className="rt-play">{PLAYBOOK_NAMES[c.topPlaybook]}</span>{confidence !== undefined && <span className="rt-conf">{Math.round(confidence * 100)}% confidence</span>}</> : <span className="faint">{c.verdictPending ? scanDelayed ? SCAN_DELAYED : SCANNING : c.verdict === 'pending' ? NOT_FULLY_CHECKED : 'Nothing matched'}</span>}</td>
    <td className="c-sig r">{c.unavailable?.includes('signal') ? <UnavailableValue /> : c.signal && <SignalBars signal={c.signal} />}</td>
    <td className="c-beta r">{c.beta && <span className="rt-sig"><span className="tag">Beta</span>{c.beta.apeScore !== undefined && <b className="num">{c.beta.apeScore}</b>}{c.beta.setupGrade && <span>{c.beta.setupGrade}</span>}</span>}</td>
    <td className="c-price r num">{c.priceUnavailable ? <UnavailableValue /> : <Roll value={formatCoinPrice(c.priceUsd)} />}</td>
    <td className="c-mcap r num">{c.unavailable?.includes('marketCap') || c.marketCapUsd === undefined ? <UnavailableValue /> : <Roll value={usd(c.marketCapUsd)} />}</td>
    <td className={`c-1h r num${c.change1hPct > 0 && c.verdict !== 'danger' ? ' up' : ''}`}>{c.unavailable?.includes('change') ? <UnavailableValue /> : <Roll value={pct(c.change1hPct)} />}</td>
    <td className="c-spark">{c.unavailable?.includes('spark') ? <UnavailableValue /> : c.spark8h && <div className="rt-spark"><Spark series={c.spark8h} height={28} /></div>}</td>
    <td className="c-flow">{c.unavailable?.includes('flow') ? <UnavailableValue /> : <div className="rt-flow"><FlowBar flow={c.flow} /><span className="num">{Math.round(c.flow.agentPct)}%</span></div>}</td>
    <td className="c-liq r num">{c.unavailable?.includes('liquidity') ? <UnavailableValue /> : usd(c.liquidityUsd)}</td><td className={`c-exit r num${c.sellCheck?.status === 'refused' || (!c.unavailable?.includes('exitCost') && c.exitCost1kPct > 15) ? ' bad' : ''}`} title={c.sellCheck?.status === 'refused' ? SELL_FAILS_TITLE : undefined}>{c.sellCheck?.status === 'refused' ? SELL_FAILS : c.unavailable?.includes('exitCost') ? <UnavailableValue /> : exitText(c.exitCost1kPct)}</td>
    <td className="c-act r"><button className={`btn btn-sm${no || !tradingLive || c.verdict === 'danger' ? '' : ' btn-primary'}`} disabled={c.verdictPending || no || !tradingLive} title={no ? REFUSED_TITLE(riskMode, c.hardDanger === true) : c.verdict === 'danger' ? DANGER_ACCEPTED_TITLE : !tradingLive ? TRADING_PAUSED_TITLE : undefined} aria-label={no ? 'Refused by the guard' : !tradingLive ? `Trade $${c.symbol.text}: ${TRADING_PAUSED_TITLE}` : `Trade $${c.symbol.text}`} onClick={(e) => { e.stopPropagation(); trade(c, e.currentTarget); }}>{no ? 'Refused' : 'Trade'}</button></td>
  </tr>;
});
export function HotStrip({ coins, selected, select }: { coins: RadarRow[]; selected: string | null; select: (c: RadarRow, el: HTMLElement) => void }) {
  if (!coins.length) return null;
  return <section className="hot-strip" aria-labelledby="hot-h"><div className="sec-head" style={{ marginTop: 26 }}><h2 id="hot-h">Hot right now</h2><span className="sub">Unusual trading in the last hour against each coin's usual hour, then the most active. Not a recommendation.</span></div><div className="hot-grid">{coins.map((c) => <button key={c.address} className={`htile ${markClass(marking(c))}${selected === c.address ? ' sel' : ''}`} aria-pressed={selected === c.address} onClick={(e) => select(c, e.currentTarget)}><span className="htile-top"><span className="htile-sym" title={`$${c.symbol.text}`}><Decode text={`$${c.symbol.text}`}><span>$<UntrustedText value={c.symbol} /></span></Decode></span><span className="htile-tags"><BlueChipBadge value={c.blueChip} /><HeatTag heat={heatOf(c)} /><CompactVerdictChip priceMove={c.priceMove} linked={false} level={c.verdict} guard={c.guardV2} failed={c.guardRefreshFailed} pending={c.verdictPending} evaluatedPlaybooks={c.evaluatedPlaybooks} missing={c.missingChecks} /></span></span>{c.spark8h && <span className="htile-spark"><Spark series={c.spark8h} height={46} /></span>}<span className="htile-facts">{c.signal && <span><span className="htile-signal-label">Signal <span className="signal-beta">Beta</span></span><b className="num score">{c.signal.composite}</b></span>}<span>Vol 1h<b className="num">{c.volume1hUsd === undefined ? <UnavailableValue /> : usd(c.volume1hUsd)}</b><small className="htile-usual">{c.volumeBaselineUsd === undefined ? 'new coin' : `${activityRatio(c) >= 10 ? Math.round(activityRatio(c)) : activityRatio(c).toFixed(1)}× usual`}</small></span><span>1h<b className="num up">{c.unavailable?.includes('change') ? <UnavailableValue /> : <Roll value={pct(c.change1hPct)} />}</b></span></span></button>)}</div></section>;
}
function Section({ title, figure, children }: { title: string; figure?: ReactNode; children: ReactNode }) { return <section className="insp-sec"><h3>{title}{figure}</h3>{children}</section>; }
export function InspectorGuard({ card, href, mark = '' }: { card: CoinCard; href: string; mark?: string }) {
  const top = card.playbooks.find(p => p.level === 'danger') ?? card.playbooks.find(p => p.level === 'monitor');
  return <div className={`insp-box insp-guard${card.verdict.level === 'danger' ? ' danger' : ''} ${mark}`}><div className="insp-guard-top"><b>{card.verdict.level === 'pending' ? NOT_FULLY_CHECKED : top ? `Watch for: ${PLAYBOOK_NAMES[top.id]}` : 'No scam playbooks matched'}</b><Link to={href} className="insp-link">Evidence</Link></div><p>{card.verdict.reasons.join(' ')}{top?.history && ` Deployer: ${top.history.deployerRuns} prior flagged runs.`}</p><AnalysisPolicyNotice /></div>;
}
export function CoinInspector({ row, close, onCard, formatRowAge = age, stale = false, tradeVisible = true }: { row: HeatRow; close: () => void; onCard: (card: CoinCard) => void; formatRowAge?: typeof formatAge; stale?: boolean; tradeVisible?: boolean }) {
  const guard = useGuardCoin(row.address),rt=useRealtime();
  const wide = useMedia('(min-width:1480px)'), panel = useRef<HTMLElement>(null);
  const [card, setCard] = useState<CoinCard | null>(null), [error, setError] = useState(false), [retry, setRetry] = useState(0);
  const antiSnipeEndsAt = useMemo(() => antiSnipeDeadline(card, guard.card, serverNow()), [card, guard.card]);
  useEffect(() => { const ac = new AbortController(); setError(false); void fetchParsed(`/coins/${row.address}`, CoinCardSchema, { signal: ac.signal }).then((data) => { if (!ac.signal.aborted) { setCard(data); onCard(data); } }).catch((e) => { if (e.name !== 'AbortError' && !isRateLimited(e)) setError(true); }); return () => ac.abort(); }, [row.address, retry]);
  useEffect(()=>rt?.subscribe<'coin'>(`coin:${row.address}`,event=>{if(event.kind==='card'){setCard(event.data);onCard(event.data);}},()=>setRetry(n=>n+1)),[rt,row.address]);
  useEffect(() => { if (!wide) panel.current?.focus(); }, [wide]);
  const signal = card?.signal, flow = card?.flow;
  const redFlag = card?.tradeability.honeypot || card?.playbooks.some((m) => m.level === 'danger' && m.confidence >= .97);
  const mk = marking({ ...row, verdict: card?.verdict.level ?? row.verdict }, { redFlag });
  const fullTo = `/coin/${row.address}`;
  return <><button className="insp-scrim" tabIndex={-1} aria-label="Close details" onClick={close} /><aside ref={panel} className="insp radar-insp" id="radar-inspector" tabIndex={-1} role={wide ? undefined : 'dialog'} aria-modal={wide ? undefined : true} aria-label={`$${row.symbol.text} details`} onKeyDown={(e) => {
    if (!wide && e.key === 'Tab') { const nodes = panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled)'); if (!nodes?.length) return; const first = nodes[0], last = nodes[nodes.length - 1]; if (e.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); } }
  }}><div className="insp-bar"><span>Coin</span><a className="iconbtn insp-expand" href={fullTo} title="Open the full page" onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; e.preventDefault(); void expandTo(fullTo, panel.current!); }}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3H3v10h10v-3M9 3h4v4M13 3L7 9" /></svg><span>Expand</span></a><button className="iconbtn" onClick={close} aria-label="Close details">×</button></div>
    <div className="insp-id"><h2><Decode text={`$${row.symbol.text}`}><span>$<UntrustedText value={card?.identity.symbol ?? row.symbol} /></span></Decode></h2><span className="tags"><HeatTag heat={displayHeat({ ...row, verdict: card?.verdict.level ?? row.verdict })} /><RatingPriceFact move={row.priceMove}/><VerdictChip guard={guard.assessment ?? row.guardV2 ?? undefined} level={card?.verdict.level ?? row.verdict} verdictPending={row.verdictPending && !card} evaluatedPlaybooks={card?.verdict.evaluatedPlaybooks ?? row.evaluatedPlaybooks} meta={card?.meta} missing={row.missingChecks} /></span></div><p className="insp-sub"><span><UntrustedText value={card?.identity.name ?? row.name} /> · {launchpadLabel(row.launchpad, row.stage === 'graduated')} · {formatRowAge(row.ageSec)} old</span><span className="addr" title={row.address}>{row.address.slice(0, 6)}…{row.address.slice(-4)} <button className="iconbtn" aria-label="Copy address" onClick={() => void navigator.clipboard?.writeText(row.address)}>⧉</button></span></p>
    {/* TODO(spec): CoinCard lacks price/chart fields. Use the selected RadarRow for price/chart and optional market cap. */}
    <div className="insp-price"><b className="num">{row.priceUnavailable ? NOT_CHECKED : price(row.priceUsd)}</b><span className={`num${row.change1hPct > 0 ? ' up' : ''}`}>{row.unavailable?.includes('change') ? NOT_CHECKED : pct(row.change1hPct)} 1h</span>{row.change24hPct !== undefined && <span className={`num${row.change24hPct > 0 ? ' up' : ''}`}>{row.unavailable?.includes('change') ? NOT_CHECKED : pct(row.change24hPct)} 24h</span>}</div>
    {row.spark8h && <div className="insp-chart"><Spark series={row.spark8h} height={120} label={`Price over the last ${age(Math.min(28800, Math.max(60, row.ageSec)))}`} /><MiniBars series={row.spark8h.slice(1).map((v, i) => Math.abs(v - row.spark8h![i]) + 1.5)} height={26} label="Price movement over the same time" /><div className="insp-axis"><span>{age(Math.min(28800, Math.max(60, row.ageSec)))} ago</span><span>{age(Math.min(28800, Math.max(60, row.ageSec)) / 2)}</span><span>Now</span></div></div>}
    {guard.assessment && <GuardCompact verdict={{version:2,assessment:guard.assessment}} />}
    {error ? <div role="status">Could not load coin details. <button className="btn" onClick={() => setRetry((n) => n + 1)}>Retry</button></div> : !card ? <div className="skel" aria-label="Loading coin details" style={{ height: 100 }} /> : <>
      <InspectorGuard card={card} href={fullTo} mark={mk?.kind === 'ember' ? markClass(mk) : ''} />
      <Section title="Can you get out?"><dl className="insp-kv">{[['Exit cost at $100', exitMeasured(card, 'usd100') ? exitText(card.tradeability.exitCostPct.usd100) : NOT_CHECKED], ['Exit cost at $1K', exitMeasured(card, 'usd1k') ? exitText(card.tradeability.exitCostPct.usd1k) : NOT_CHECKED], ...(sellCheckOf(card) ? [['Sell check', SELL_CHECK_TEXT[sellCheckOf(card)!]]] : []), ['Liquidity', row.unavailable?.includes('liquidity') ? NOT_CHECKED : usd(row.liquidityUsd)], ...(row.marketCapUsd === undefined ? [] : [['FDV', usd(row.marketCapUsd)]])].map(([label, value]) => <div key={label}><dt>{label}</dt><dd className={(label === 'Exit cost at $100' && exitMeasured(card, 'usd100') && card.tradeability.exitCostPct.usd100 > 15) || (label === 'Exit cost at $1K' && exitMeasured(card, 'usd1k') && card.tradeability.exitCostPct.usd1k > 15) || (label === 'Sell check' && sellCheckOf(card) === 'refused') ? 'num bad' : 'num'}>{value}</dd></div>)}</dl></Section>
      {signal && <Section title="Signal · five readings" figure={<b className="num">{signal.composite} <span className="tag">Beta</span></b>}><div className="insp-roles">{ROLES.map((role) => <div key={role}><span>{role[0].toUpperCase() + role.slice(1)}</span><i><i style={{ width: `${signal.readings[role]}%` }} /></i><b className="num">{signal.readings[role]}</b></div>)}</div></Section>}
      {row.unavailable?.includes('flow') ? <Section title="Who’s buying">{NOT_CHECKED}</Section> : flow && <Section title="Who’s buying" figure={<b className="num">{Math.round(flow.agentPct)}% agents</b>}><FlowBar flow={flow} legend /></Section>}
    </>}
    <Section title="Watch"><WatchButton kind="coin" target={row.address} /></Section>
    <Section title="Trade"><div className="insp-box"><TradePanel coin={row.address} priceUsd={row.priceUsd} priceUnavailable={row.priceUnavailable} guard={guard.assessment ?? row.guardV2} stale={stale} visible={tradeVisible} antiSnipeEndsAt={antiSnipeEndsAt} /></div></Section>
  </aside></>;
}
