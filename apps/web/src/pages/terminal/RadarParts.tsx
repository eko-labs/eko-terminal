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
import { NOT_CHECKED, NOT_FULLY_CHECKED, RUN_UP_LEGEND, SELL_CHECK_NOT_AVAILABLE, SELL_CHECK_TEXT, SELL_FAILS, SELL_FAILS_TITLE } from '../../copy/availability';
import { runUpScore } from '../../lib/runUp';
import { exitMeasured, sellCheckNotAvailable, sellCheckOf } from '../../lib/sellCheck';
import { memo, Suspense, useEffect, useMemo, useRef, type ReactNode } from 'react';
import type { PlaceSlots } from '../../features';
import type { CoinCard, RadarRow, Flow } from '@eko/shared';
import { HeatTag, Info, Seg, UnavailableValue, UntrustedText, VerdictChip } from '../../components/ui';
import { MiniBars, Spark } from '../../components/ui/charts';
import { activityRatio, displayHeat, heatOf, marking, markClass, type HeatRow } from '../../lib/heat';
import { fetchParsed, isRateLimited } from '../../lib/api';
import { CoinCardSchema } from '@eko/shared';
import { useState } from 'react';
import { useMedia } from '../../lib/useMedia';
import { expandTo } from '../../lib/expand';
import { Link } from '../../lib/Link';
import { featureLink } from '../../features';
import { Decode, Roll } from './radarMotion';
import { age, exitText, sentences, hotMetrics, isLifeless, marketCapOf, noMatchLabel, pct, playbookName, price, refused, usd, type HotWindow } from './radarModel';
import { formatAge, formatCoinPrice } from '../../lib/format';
import { launchpadLabel, quotedIn } from '../../copy/chain';
import { FlowBar, FLOW_SHARE_TITLE, buyShare, flowFigure } from './FlowBar';
import { PaneResizer } from '../../components/shell/PaneResizer';
import { EKO_SCORE_BAND_LABEL } from '@eko/shared';
import { SCORE_TITLE, SCORE_VERDICT, ScoreCell, ScoreMini, ScoreParts, scoreWhy } from './CoinScore';

export { FlowBar };

export function HeatLegend() {
  return <div className="heat-legend" aria-label="How rows are marked">{['Hot', 'Normal', 'Fading', 'Danger'].map((word, i) => <span key={word}><i className={`sw ${['hot', 'normal', 'fading', 'avoid'][i]}`} />{word}</span>)}<Info label="How rows are marked">A blue-white shimmer grows from warming (3%+ in an hour, agents 25%+, momentum 60+) to Hot (momentum 70+, rising, agents 30%+) to surging (10%+, agents 40%+). A dark ember marks falling activity (down 8%+, momentum under 65), Danger, and red flags (honeypot, 75%+ exit cost, or a Danger match at 97%+ confidence). Danger always wins. Momentum is the EKO score's momentum part; without it, only price and flow predicates apply. The marks describe activity; they are not a reason to buy. {RUN_UP_LEGEND}</Info></div>;
}
/** A coin's ticker; a coin with no name yet (seconds after launch) shows its short address, never a lone "$". */
function CoinTicker({ c }: { c: { symbol: RadarRow['symbol']; address: string } }) {
  if (!c.symbol.text.trim()) return <span className="noname" title={c.address}>{`${c.address.slice(0, 6)}…${c.address.slice(-4)}`}</span>;
  return <Decode text={`$${c.symbol.text}`}><span>$<UntrustedText value={c.symbol} /></span></Decode>;
}
/** Features' figures in each row (placeSlots.tsx coinRow), as columns after the verdict. */
type CoinRowPlace = NonNullable<PlaceSlots['coinRow']>;
const NO_COLS: readonly CoinRowPlace[] = [];
export const RadarRowView = memo(function RadarRowView({ c, cols = NO_COLS, selected, select, trade, pulse, confidence, stateLabel = noMatchLabel(c), scanDelayed = false }: { c: RadarRow; cols?: readonly CoinRowPlace[]; selected: boolean; select: (c: RadarRow, el: HTMLElement) => void; trade: (c: RadarRow, el: HTMLElement) => void; pulse: number; confidence?: number; stateLabel?: string; scanDelayed?: boolean }) {
  const tradingLive = useShell((st) => st.config?.trading.liveEnabled !== false);
  const el = useRef<HTMLTableRowElement>(null);
  useEffect(() => { const row = el.current; if (!pulse || !row) return; row.classList.remove('pulse'); void row.offsetWidth; row.classList.add('pulse'); }, [pulse]);
  const score = c.verdictPending || c.verdict === 'pending' ? undefined : runUpScore(c);
  const riskMode = useUi((st) => st.riskMode), no = refused(c, riskMode);
  return <tr ref={el} data-address={c.address} className={`h-${heatOf(c)} ${markClass(marking(c))}${selected ? ' sel' : ''}`} onClick={(e) => select(c, e.currentTarget.querySelector<HTMLButtonElement>('[data-pick]')!)}>
    <td className="c-coin"><button data-pick className="rt-pick" aria-pressed={selected} aria-controls={selected ? 'radar-inspector' : undefined} onClick={(e) => { e.stopPropagation(); select(c, e.currentTarget); }}><span className="rt-top"><span className="rt-sym" title={`$${c.symbol.text}`}><CoinTicker c={c} /></span><BlueChipBadge value={c.blueChip} /><HeatTag heat={displayHeat(c)} />{c.ekoScore && <ScoreMini score={c.ekoScore} />}</span><span className="rt-name"><UntrustedText value={c.name} /> · <span className="rt-pad">{launchpadLabel(c.launchpad, c.stage === 'graduated')}{c.quoteSymbol ? ` ${quotedIn(c.quoteSymbol)}` : ''}</span> · {age(c.ageSec)}</span></button></td>
    <td className="c-guard"><CompactVerdictChip priceMove={c.priceMove} level={c.verdict} guard={c.guardV2} failed={c.guardRefreshFailed} pending={c.verdictPending} scanDelayed={scanDelayed} evaluatedPlaybooks={c.evaluatedPlaybooks} missing={c.missingChecks} stateLabel={stateLabel} runUp={score} historyPartial={c.historyPartial} /></td>
    {cols.map(col => { const Cell = col.cell; return <td key={col.id} className="c-place r num"><Suspense fallback={null}><Cell row={c} /></Suspense></td>; })}
    <td className="c-watch">{c.topPlaybook ? <><span className="rt-play">{playbookName(c.topPlaybook, c.verdict)}</span>{confidence !== undefined && <span className="rt-conf">{Math.round(confidence * 100)}% confidence</span>}</> : null}</td>
    <td className="c-sig r">{c.ekoScore && <ScoreCell score={c.ekoScore} />}</td>
    <td className="c-beta r">{c.beta && <span className="rt-sig"><span className="tag">Beta</span>{c.beta.apeScore !== undefined && <b className="num">{c.beta.apeScore}</b>}{c.beta.setupGrade && <span>{c.beta.setupGrade}</span>}</span>}</td>
    <td className="c-price r num">{c.priceUnavailable ? <UnavailableValue /> : <Roll value={formatCoinPrice(c.priceUsd)} />}</td>
    <td className="c-mcap r num">{c.unavailable?.includes('marketCap') || c.marketCapUsd === undefined ? <UnavailableValue /> : <Roll value={usd(c.marketCapUsd)} />}</td>
    <td className={`c-1h r num${c.change1hPct > 0 && c.verdict !== 'danger' ? ' up' : ''}`}>{c.unavailable?.includes('change') ? <UnavailableValue /> : <Roll value={pct(c.change1hPct)} />}</td>
    <td className="c-spark">{c.unavailable?.includes('spark') ? <UnavailableValue /> : c.spark8h && <div className="rt-spark"><Spark series={c.spark8h} height={28} /></div>}</td>
    <td className="c-flow">{c.unavailable?.includes('flow') && !c.flow.activity ? <UnavailableValue /> : <div className="rt-flow" title={c.flow.activity ? FLOW_SHARE_TITLE : undefined}><FlowBar flow={c.flow} unavailable={c.unavailable?.includes('flow')} compact /><span className="num">{c.flow.activity ? (s => s === null ? '—' : `${s}%`)(buyShare(c.flow.activity)) : `${Math.round(c.flow.agentPct)}%`}</span></div>}</td>
    <td className="c-liq r num">{c.unavailable?.includes('liquidity') ? <UnavailableValue /> : usd(c.liquidityUsd)}</td><td className={`c-exit r num${c.sellCheck?.status === 'refused' || (!c.unavailable?.includes('exitCost') && c.exitCost1kPct > 15) ? ' bad' : ''}`} title={c.sellCheck?.status === 'refused' ? SELL_FAILS_TITLE : undefined}>{c.sellCheck?.status === 'refused' ? SELL_FAILS : c.unavailable?.includes('exitCost') ? <UnavailableValue /> : exitText(c.exitCost1kPct)}</td>
    <td className="c-act r"><button className={`btn btn-sm${no || !tradingLive || c.verdict === 'danger' || isLifeless(stateLabel) ? '' : ' btn-primary'}`} disabled={c.verdictPending || no || !tradingLive} title={no ? REFUSED_TITLE(riskMode, c.hardDanger === true) : c.verdict === 'danger' ? DANGER_ACCEPTED_TITLE : !tradingLive ? TRADING_PAUSED_TITLE : undefined} aria-label={no ? 'Refused by the guard' : !tradingLive ? `Trade $${c.symbol.text}: ${TRADING_PAUSED_TITLE}` : `Trade $${c.symbol.text}`} onClick={(e) => { e.stopPropagation(); trade(c, e.currentTarget); }}>{no ? 'Refused' : 'Trade'}</button></td>
  </tr>;
});
const HOT_WINDOWS = ['1h', '24h'] as const;
export function HotStrip({ coins, window, onWindowChange, selected, select, loading = false }: {
  coins: RadarRow[]; window: HotWindow; onWindowChange: (window: HotWindow) => void;
  selected: string | null; select: (c: RadarRow, el: HTMLElement) => void; loading?: boolean;
}) {
  const day = window === '24h';
  return <section className="hot-strip" aria-labelledby="hot-h" aria-busy={loading}>
    <div className="sec-head">
      <h2 id="hot-h">Hot right now</h2>
      <Seg options={HOT_WINDOWS} value={window} onChange={(value) => onWindowChange(value === '24h' ? '24h' : '1h')} label="Hot trading window" />
      <span className="sub hot-description">
        <span aria-hidden={day}>Unusual trading in the last hour against each coin's usual hour, then the most active. Not a recommendation.</span>
        <span aria-hidden={!day}>Trading in the last 24 hours ranked by volume and price change. Not a recommendation.</span>
      </span>
    </div>
    <div className="hot-grid">{coins.length ? coins.map((c) => {
      const { volume, change } = hotMetrics(c, window);
      const cap = marketCapOf(c);
      const ratio = activityRatio(c);
      return <button type="button" key={c.address} className={`htile ${markClass(marking(c))}${selected === c.address ? ' sel' : ''}`} aria-pressed={selected === c.address} onClick={(e) => select(c, e.currentTarget)}>
        <span className="htile-top"><span className="htile-sym" title={`$${c.symbol.text}`}><CoinTicker c={c} /></span><span className="htile-tags"><BlueChipBadge value={c.blueChip} /><HeatTag heat={heatOf(c)} /><CompactVerdictChip priceMove={c.priceMove} linked={false} level={c.verdict} stateLabel={noMatchLabel(c)} guard={c.guardV2} failed={c.guardRefreshFailed} pending={c.verdictPending} evaluatedPlaybooks={c.evaluatedPlaybooks} missing={c.missingChecks} historyPartial={c.historyPartial} /></span></span>
        <span className="htile-spark">{c.spark8h && <Spark series={c.spark8h} height={46} />}</span>
        <span className="htile-facts">
          {c.ekoScore && <span className={`htile-score score-${c.ekoScore.band}`} title={`${SCORE_TITLE} ${scoreWhy(c.ekoScore)}`}>Score<b className="num">{c.ekoScore.value}</b><small className="score-word">{EKO_SCORE_BAND_LABEL[c.ekoScore.band]}</small></span>}
          <span>Vol {window}<b className="num">{volume === undefined ? <UnavailableValue /> : usd(volume)}</b>
            {!day && <small className="htile-usual">{c.volumeBaselineUsd === undefined ? 'new coin' : `${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)}× usual`}</small>}
          </span>
          <span>Market cap<b className="num">{cap === undefined ? <UnavailableValue /> : usd(cap)}</b></span>
          <span>{window}<b className="num up">{change === undefined ? <UnavailableValue /> : <Roll value={pct(change)} />}</b></span>
        </span>
      </button>;
    }) : loading
      ? [0, 1, 2].map((i) => <div key={i} className="htile htile-skel skel" aria-hidden="true" />)
      : <p className="htile htile-empty muted">Nothing unusual in the last {day ? '24 hours' : 'hour'}.</p>}
    </div>
  </section>;
}
function Section({ title, figure, children }: { title: string; figure?: ReactNode; children: ReactNode }) { return <section className="insp-sec"><h3>{title}{figure}</h3>{children}</section>; }
export function InspectorGuard({ card, href, mark = '' }: { card: CoinCard; href: string; mark?: string }) {
  const top = card.playbooks.find(p => p.level === 'danger') ?? card.playbooks.find(p => p.level === 'monitor');
  return <div className={`insp-box insp-guard${card.verdict.level === 'danger' ? ' danger' : ''} ${mark}`}><div className="insp-guard-top"><b>{card.verdict.level === 'pending' ? NOT_FULLY_CHECKED : top ? `Watch for: ${playbookName(top.id, top.level)}` : 'No scam playbooks matched'}</b><Link to={href} className="insp-link">Evidence</Link></div><p>{sentences(card.verdict.reasons)}{top?.history && ` Deployer: ${top.history.deployerRuns} prior flagged runs.`}</p><AnalysisPolicyNotice /></div>;
}
export function CoinInspector({ row, close, onCard, formatRowAge = age, stale = false, tradeVisible = true }: { row: HeatRow; close: () => void; onCard: (card: CoinCard) => void; formatRowAge?: typeof formatAge; stale?: boolean; tradeVisible?: boolean }) {
  const guard = useGuardCoin(row.address),rt=useRealtime();
  const wide = useMedia('(min-width:1480px)'), panel = useRef<HTMLElement>(null);
  const [card, setCard] = useState<CoinCard | null>(null), [error, setError] = useState(false), [retry, setRetry] = useState(0);
  const antiSnipeEndsAt = useMemo(() => antiSnipeDeadline(card, guard.card, serverNow()), [card, guard.card]);
  useEffect(() => { const ac = new AbortController(); setError(false); void fetchParsed(`/coins/${row.address}`, CoinCardSchema, { signal: ac.signal }).then((data) => { if (!ac.signal.aborted) { setCard(data); onCard(data); } }).catch((e) => { if (e.name !== 'AbortError' && !isRateLimited(e)) setError(true); }); return () => ac.abort(); }, [row.address, retry]);
  useEffect(()=>rt?.subscribe<'coin'>(`coin:${row.address}`,event=>{if(event.kind==='card'){setCard(event.data);onCard(event.data);}},()=>setRetry(n=>n+1)),[rt,row.address]);
  useEffect(() => { if (!wide) panel.current?.focus(); }, [wide]);
  const score = card?.ekoScore ?? row.ekoScore, flow = card?.flow;
  const assessment = guard.assessment ?? row.guardV2 ?? undefined;
  const verdict = card?.verdict.level ?? row.verdict;
  const pending = !!row.verdictPending && !card;
  const redFlag = card?.tradeability.honeypot || card?.playbooks.some((m) => m.level === 'danger' && m.confidence >= .97);
  const mk = marking({ ...row, verdict: card?.verdict.level ?? row.verdict }, { redFlag });
  const fullTo = `/coin/${row.address}`;
  // The deployer's line shows only while a feature gives it a page (features.ts): nothing changes otherwise.
  const deployer = card && card.identity.deployer.toLowerCase() !== card.identity.address.toLowerCase() ? card.identity.deployer : null;
  const deployerTo = useShell(s => deployer ? featureLink('deployer', deployer, s.config?.flags) : null);
  // The drag edge sits just outside the pane (the pane scrolls); as an overlay dialog it is the first stop of the focus loop.
  return <><button className="insp-scrim" tabIndex={-1} aria-label="Close details" onClick={close} /><PaneResizer storageKey="coin" controls="radar-inspector" label="Resize coin details" /><aside ref={panel} className="insp radar-insp" id="radar-inspector" tabIndex={-1} role={wide ? undefined : 'dialog'} aria-modal={wide ? undefined : true} aria-label={`$${row.symbol.text} details`} onKeyDown={(e) => {
    if (!wide && e.key === 'Tab') { const edge = document.querySelector<HTMLElement>('.pane-resize[aria-controls="radar-inspector"]'); const nodes = [...(edge ? [edge] : []), ...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled)') ?? [])]; if (!nodes.length) return; const first = nodes[0], last = nodes[nodes.length - 1]; if (e.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); } }
  }}><div className="insp-bar"><span>Coin</span><a className="iconbtn insp-expand" href={fullTo} title="Open the full page" onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; e.preventDefault(); void expandTo(fullTo, panel.current!); }}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3H3v10h10v-3M9 3h4v4M13 3L7 9" /></svg><span>Expand</span></a><button className="iconbtn" onClick={close} aria-label="Close details">×</button></div>
    <div className="insp-id"><h2><Decode text={`$${row.symbol.text}`}><span>$<UntrustedText value={card?.identity.symbol ?? row.symbol} /></span></Decode></h2><span className="tags"><HeatTag heat={displayHeat({ ...row, verdict: card?.verdict.level ?? row.verdict })} /><RatingPriceFact move={row.priceMove}/><VerdictChip guard={assessment} level={verdict} verdictPending={pending} stateLabel={noMatchLabel({ ...row, verdict, verdictPending: pending, guardV2: assessment })} evaluatedPlaybooks={card?.verdict.evaluatedPlaybooks ?? row.evaluatedPlaybooks} meta={card?.meta} missing={row.missingChecks} historyPartial={card ? card.verdict.historyPartial : row.historyPartial} /></span></div><p className="insp-sub"><span><UntrustedText value={card?.identity.name ?? row.name} /> · {launchpadLabel(row.launchpad, row.stage === 'graduated')}{row.quoteSymbol ? ` ${quotedIn(row.quoteSymbol)}` : ''} · {formatRowAge(row.ageSec)} old</span><span className="addr" title={row.address}>{row.address.slice(0, 6)}…{row.address.slice(-4)} <button className="iconbtn" aria-label="Copy address" onClick={() => void navigator.clipboard?.writeText(row.address)}>⧉</button></span></p>
    {/* TODO(spec): CoinCard lacks price/chart fields. Use the selected RadarRow for price/chart and optional market cap. */}
    <div className="insp-price"><b className="num">{row.priceUnavailable ? NOT_CHECKED : price(row.priceUsd)}</b><span className={`num${row.change1hPct > 0 ? ' up' : ''}`}>{row.unavailable?.includes('change') ? NOT_CHECKED : pct(row.change1hPct)} 1h</span>{row.change24hPct !== undefined && <span className={`num${row.change24hPct > 0 ? ' up' : ''}`}>{row.unavailable?.includes('change') ? NOT_CHECKED : pct(row.change24hPct)} 24h</span>}</div>
    {row.spark8h && <div className="insp-chart"><Spark series={row.spark8h} height={120} label={`Price over the last ${age(Math.min(28800, Math.max(60, row.ageSec)))}`} /><MiniBars series={row.spark8h.slice(1).map((v, i) => Math.abs(v - row.spark8h![i]) + 1.5)} height={26} label="Price movement over the same time" /><div className="insp-axis"><span>{age(Math.min(28800, Math.max(60, row.ageSec)))} ago</span><span>{age(Math.min(28800, Math.max(60, row.ageSec)) / 2)}</span><span>Now</span></div></div>}
    {guard.assessment && <GuardCompact verdict={{version:2,assessment:guard.assessment}} />}
    {error ? <div role="status">Could not load coin details. <button className="btn" onClick={() => setRetry((n) => n + 1)}>Retry</button></div> : !card ? <div className="skel" aria-label="Loading coin details" style={{ height: 100 }} /> : <>
      <InspectorGuard card={card} href={fullTo} mark={mk?.kind === 'ember' ? markClass(mk) : ''} />
      {deployer && deployerTo && <Section title="Dev"><p className="insp-dev"><Link to={deployerTo} className="addr" title={deployer}>{deployer.slice(0, 6)}…{deployer.slice(-4)}</Link> · <Link to={deployerTo} className="insp-link">Launch history</Link></p></Section>}
      <Section title="Can you get out?"><dl className="insp-kv">{[['Exit cost at $100', exitMeasured(card, 'usd100') ? exitText(card.tradeability.exitCostPct.usd100) : sellCheckNotAvailable(card) ? SELL_CHECK_NOT_AVAILABLE : NOT_CHECKED], ['Exit cost at $1K', exitMeasured(card, 'usd1k') ? exitText(card.tradeability.exitCostPct.usd1k) : sellCheckNotAvailable(card) ? SELL_CHECK_NOT_AVAILABLE : NOT_CHECKED], ...(sellCheckOf(card) ? [['Sell check', SELL_CHECK_TEXT[sellCheckOf(card)!]]] : sellCheckNotAvailable(card) ? [['Sell check', SELL_CHECK_NOT_AVAILABLE]] : []), ['Liquidity', row.unavailable?.includes('liquidity') ? NOT_CHECKED : usd(row.liquidityUsd)], ...(row.marketCapUsd === undefined ? [] : [['FDV', usd(row.marketCapUsd)]])].map(([label, value]) => <div key={label}><dt>{label}</dt><dd className={(label === 'Exit cost at $100' && exitMeasured(card, 'usd100') && card.tradeability.exitCostPct.usd100 > 15) || (label === 'Exit cost at $1K' && exitMeasured(card, 'usd1k') && card.tradeability.exitCostPct.usd1k > 15) || (label === 'Sell check' && sellCheckOf(card) === 'refused') ? 'num bad' : 'num'}>{value}</dd></div>)}</dl></Section>
      {score && <Section title="EKO score" figure={<b className={`num insp-score score-${score.band}`} title={SCORE_TITLE}>{score.value} <span className="score-word">{SCORE_VERDICT[score.band]}</span></b>}><ScoreParts score={score} cells={16} /><p className="insp-score-why">{scoreWhy(score)}</p></Section>}
      {row.unavailable?.includes('flow') && !flow?.activity ? <Section title="Who’s buying">{NOT_CHECKED}</Section> : flow && <Section title="Who’s buying" figure={<b className="num">{flowFigure(flow, row.unavailable?.includes('flow'))}</b>}><FlowBar flow={flow} unavailable={row.unavailable?.includes('flow')} legend /></Section>}
    </>}
    <Section title="Watch"><WatchButton kind="coin" target={row.address} /></Section>
    <Section title="Trade"><div className="insp-box"><TradePanel coin={row.address} priceUsd={row.priceUsd} priceUnavailable={row.priceUnavailable} guard={guard.assessment ?? row.guardV2} stale={stale} visible={tradeVisible} antiSnipeEndsAt={antiSnipeEndsAt} /></div></Section>
  </aside></>;
}
