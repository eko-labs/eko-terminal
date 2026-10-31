import { rememberCoinIdentity } from '../../lib/coinIdentity';
import { BlueChipBadge } from '../../components/BlueChip';
import { DANGER_ACCEPTED_TITLE, IN_POOL_TITLE, REFUSED_TITLE, TRADING_PAUSED_TITLE, runUpTitle } from '../../copy/availability';
import { CompactVerdictChip, GuardLegend } from '../../components/GuardCompact';
import { AnalysisPolicyNotice } from '../../components/PolicyLinks';
import { CHECK_LEGEND, NEAR_GRAD, SELL_FAILS, SELL_FAILS_TITLE } from '../../copy/availability';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PairRow } from '@eko/shared';
import { HeatTag, Info, Seg, UnavailableValue, UntrustedText, VerdictChip } from '../../components/ui';
import { Spark } from '../../components/ui/charts';
import { fetchParsed, isRateLimited, MOCKS } from '../../lib/api';
import { useRealtime } from '../../lib/RealtimeContext';
import { useMedia } from '../../lib/useMedia';
import { installDither } from '../../lib/dither';
import { displayHeat, heatOf, marking, markClass } from '../../lib/heat';
import { runUpScore } from '../../lib/runUp';
import { useShell } from '../../store/shell';
import { useUi } from '../../store/ui';
import { refused } from './radarModel';
import { TradePanel } from '../../components/trade/TradePanel';
import { CoinInspector, FlowBar, HeatLegend } from './RadarParts';
import { Decode, Roll } from './radarMotion';
import { formatAge } from '../../lib/format';
import { retainCompactGuard, exitText, pct, PLAYBOOK_NAMES, scanDelayed } from './radarModel';
import { antiSnipeLeft, antiSnipeTax, applyPairEvents, COLUMNS, firstScanText, pairColumns, PairResponseSchema, pairTradeDisabled, receivedAt, type PairsToday } from './pairsFeedModel';
import { serverNow } from '../../lib/clock';
import { useTerminalWindow } from './terminalWindow';
import type { ChannelEvent } from '../../lib/realtime';
import { launchpadLabel } from '../../copy/chain';
import './radar.css';
import './secondary.css';

const META = {
  new: { title: 'New', sub: 'Under half way to graduation, newest first', about: 'Every launch on Elysium, from its first block. Nothing on Elysium has a bonding curve: each coin trades in its own Uniswap pool from launch, with its launch liquidity locked.' },
  near_grad: { title: 'About to graduate', sub: NEAR_GRAD, about: "Montra marks graduation as a line in the coin's own pool, at 16.8× its opening price. Nothing migrates when a coin passes it. Launchpads without a line of their own are measured against the same market cap." },
  migrated: { title: 'Graduated', sub: 'Past the graduation line, latest first', about: "Coins past the graduation line: Montra's Graduated event, or the same market cap reached on another launchpad. They keep trading in the same pool." },
};
// One fixed height per column (the list is windowed): identity, three lines of numbers and the action row.
const GRAD_TITLE = 'How far the coin is to the graduation line: 16.8× the opening price on Montra, or the same market cap on other launchpads.';
const PAIR_HEIGHT = 176;
const GUARD_PAIR_HEIGHT = 244;
// A row without a Guard 2 result shows its grade alone, so only a real assessment needs the taller row.
const hasGuardLabels = (row: PairRow) => row.guardV2 != null || !!row.guardRefreshFailed;
/** Dollar amounts on a card keep one decimal under $100K so a coin's liquidity and market cap visibly move. */
export const cardUsd = (v: number) => v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e5 ? `$${Math.round(v / 1000)}K` : v >= 1000 ? `$${(v / 1000).toFixed(1)}K` : `$${Math.round(v)}`;
const share = (v: number) => `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10}%`;
function Metric({ label, children, tone, title }: { label: string; children: React.ReactNode; tone?: 'up' | 'down'; title?: string }) {
  return <div className="pr-m" title={title}><span className="pr-ml">{label}</span><span className={`pr-mv num${tone ? ` ${tone}` : ''}`}>{children}</span></div>;
}
/** Holder share with the lines the rules use: the first is where a check starts watching, the second where it flags Danger. */
function Held({ label, value, watch, danger }: { label: string; value: number | undefined; watch: number; danger: number }) {
  return value === undefined ? null : <span className={value >= danger ? 'bad' : value >= watch ? 'warn' : undefined}>{label} <b className="num">{share(value)}</b></span>;
}
export function PairView({ row, now, at, select, trade, stale }: { row: PairRow; now: number; at: number; select: (r: PairRow, el: HTMLElement) => void; trade: (r: PairRow, el: HTMLElement) => void; stale: boolean }) {
  const tradingLive = useShell((st) => st.config?.trading.liveEnabled !== false), riskMode = useUi((st) => st.riskMode);
  // A Danger pair keeps its Danger tone and is lit as well when its trading is hot.
  const pending = row.verdictPending || row.verdict === 'pending', tone = heatOf(row, { pending }), heat = displayHeat(row, { pending }), no = !pending && refused(row, riskMode);
  const ageNow = row.ageSec + Math.max(0, now - at) / 1000, delayed = scanDelayed(row, ageNow);
  const left = row.antiSnipe ? antiSnipeLeft(row.antiSnipe.endsInSec, at, now) : 0;
  const tax = row.antiSnipe ? antiSnipeTax(row.antiSnipe.taxPct, row.antiSnipe.endsInSec, at, now) : 0;
  const un = (field: NonNullable<PairRow['unavailable']>[number]) => row.unavailable?.includes(field);
  const score = pending ? undefined : runUpScore(row), change = un('change') ? undefined : row.change1hPct;
  return <li className={`prow tone ${tone}${heat === 'hot' ? ' lit' : ''} ${markClass(marking(row, { pending }))}${hasGuardLabels(row) ? ' guard-labels' : ''}`} data-address={row.address} data-pending={pending} onClick={(e) => select(row, e.currentTarget)}>
    <div className="pr-top"><div className="pr-id"><button className="pr-sym tone-sym" title={`$${row.symbol.text}`} data-pick aria-label={`Inspect $${row.symbol.text}`} onClick={(e) => { e.stopPropagation(); select(row, e.currentTarget); }}><Decode text={`$${row.symbol.text}`}><span>$<UntrustedText value={row.symbol} /></span></Decode></button><span className="pr-age num">{formatAge(ageNow)}</span></div><span className="pr-verdict"><BlueChipBadge value={row.blueChip} /><HeatTag heat={heat} /><CompactVerdictChip priceMove={row.priceMove} level={row.verdict} guard={row.guardV2} failed={row.guardRefreshFailed} pending={row.verdictPending} scanDelayed={delayed} evaluatedPlaybooks={row.evaluatedPlaybooks} missing={row.missingChecks} detail={score === undefined ? undefined : String(score)} detailTitle={score === undefined ? undefined : runUpTitle(score)} /></span></div>
    <div className="pr-sub"><span className="pr-name"><UntrustedText value={row.name} /></span><span>·</span><span>{launchpadLabel(row.launchpad, row.column === 'migrated')}</span>{!pending && row.topPlaybook && <span className={`pr-play${row.verdict === 'danger' ? ' bad' : ''}`}>· {PLAYBOOK_NAMES[row.topPlaybook]}</span>}{left > 0 && <span className="pr-snipe num pr-end">{tax}% buy tax → 0 in {left} s</span>}</div>
    <div className="pr-metrics">
      <Metric label="Mkt cap">{row.marketCapUsd === undefined || un('marketCap') ? <UnavailableValue /> : <Roll value={cardUsd(row.marketCapUsd)} />}</Metric>
      <Metric label={row.launchpad !== 'pons' ? 'In pool' : row.column === 'migrated' ? 'Liquidity' : 'In curve'} title={row.launchpad !== 'pons' ? IN_POOL_TITLE : undefined}>{un('liquidity') ? <UnavailableValue /> : <Roll value={cardUsd(row.liquidityUsd)} />}</Metric>
      <Metric label="Vol 1h">{row.volume1hUsd === undefined || un('volume') ? <UnavailableValue /> : <Roll value={cardUsd(row.volume1hUsd)} />}</Metric>
      <Metric label="Trades 1h">{row.trades1h === undefined || un('volume') ? <UnavailableValue /> : <Roll value={row.trades1h.toLocaleString('en-US')} />}</Metric>
      <Metric label="1h" tone={change === undefined || change === 0 ? undefined : change > 0 ? 'up' : 'down'}>{change === undefined ? <UnavailableValue /> : <Roll value={pct(change)} />}</Metric>
    </div>
    <div className="pr-holders">
      <Held label="Top 10" value={row.top10Pct} watch={20} danger={50} /><Held label="Dev" value={row.devPct} watch={5} danger={20} /><Held label="First-minute buyers" value={row.earlyHeldPct} watch={15} danger={30} />
      {!un('buyers') && <span>Buyers <b className="num">{row.buyers.toLocaleString('en-US')}</b></span>}
      {!un('flow') && <span>Agents <b className="num">{Math.round(row.flow.agentPct)}%</b></span>}
    </div>
    <div className="pr-grid tone-dim"><div className="pr-cell">{row.launchpad !== 'pons' ? row.column === 'migrated' ? <span className="pr-l">Graduated</span> : row.graduationPct === undefined ? null : <><span className="pr-l" title={GRAD_TITLE}>Graduation <b className="num">{Math.floor(row.graduationPct)}%</b></span><div className="pr-bar"><div className="bar"><i style={{ width: `${row.graduationPct}%` }} /></div></div></> : row.column === 'migrated' ? <span className="pr-l">Graduated to a pool</span> : <><span className="pr-l">Curve <b className="num">{row.curvePct === undefined ? <UnavailableValue /> : `${Math.floor(row.curvePct)}%`}</b></span><div className="pr-bar" hidden={row.curvePct === undefined}><div className="bar"><i style={{ width: `${row.curvePct ?? 0}%` }} /></div></div></>}</div><div className="pr-cell pr-spark">{row.spark8h && row.spark8h.length > 1 && !un('spark') ? <Spark series={row.spark8h} height={30} /> : null}</div><div className="pr-cell pr-exit"><span className="pr-l">Exit at $100</span><span className={`pr-v num${row.sellCheck?.status === 'refused' || (!un('exitCost') && row.exitCost100Pct > 15) ? ' bad' : ''}`} title={row.sellCheck?.status === 'refused' ? SELL_FAILS_TITLE : undefined}>{row.sellCheck?.status === 'refused' ? SELL_FAILS : un('exitCost') ? <UnavailableValue /> : exitText(row.exitCost100Pct)}</span></div><button className={`btn btn-sm${row.verdict === 'danger' || !tradingLive ? '' : ' btn-primary'}`} disabled={pairTradeDisabled(row, stale, tradingLive, riskMode)} title={row.verdictPending ? "Waiting for the guard's first scan." : stale ? 'Waiting for current data.' : no ? REFUSED_TITLE(riskMode, row.hardDanger === true) : row.verdict === 'danger' ? DANGER_ACCEPTED_TITLE : !tradingLive ? TRADING_PAUSED_TITLE : undefined} aria-label={`Trade $${row.symbol.text}`} onClick={(e) => { e.stopPropagation(); trade(row, e.currentTarget); }}>{no ? 'Refused' : 'Trade'}</button></div>
  </li>;
}
function Column({ column, rows, now, times, select, trade, stale }: { column: PairRow['column']; rows: PairRow[]; now: number; times: Map<string, number>; select: (r: PairRow, el: HTMLElement) => void; trade: (r: PairRow, el: HTMLElement) => void; stale: boolean }) {
  // Guard labels get their own wrapping line; spacers use the same fixed height as the CSS rows.
  const height = rows.some(hasGuardLabels) ? GUARD_PAIR_HEIGHT : PAIR_HEIGHT;
  const ref = useRef<HTMLDivElement>(null), range = useTerminalWindow(ref, rows.length, height, true), meta = META[column];
  return <section className="pcol panel" style={{ '--pair-row-height': `${height}px` } as React.CSSProperties} aria-labelledby={`pcol-${column}`}><header className="pcol-head"><div><h2 id={`pcol-${column}`}>{meta.title}<span className="pcol-count num">{rows.length}</span><Info label={meta.title}>{meta.about}</Info></h2><p>{meta.sub}</p></div><span className="pcol-beta">Flow labels <span className="tag">Beta</span></span></header><div ref={ref} className="pcol-list">{rows.length ? <ul><li aria-hidden="true" style={{ height: range.start * height }} />{rows.slice(range.start, range.end).map((row) => <PairView key={row.address} row={row} now={now} at={times.get(row.address) ?? now} select={select} trade={trade} stale={stale} />)}<li aria-hidden="true" style={{ height: (rows.length - range.end) * height }} /></ul> : <div className="empty">Quiet right now.</div>}</div></section>;
}
export default function Pairs() {
  const blueChipEnabled=!!useShell(s=>s.config?.blueChip),[blueChipOnly,setBlueChipOnly]=useState(false);
  const rt = useRealtime(), narrow = useMedia('(max-width:900px)'), wide = useMedia('(min-width:1480px)'), ws = useShell((s) => s.wsState), riskMode = useUi((s) => s.riskMode);
  const [rows, setRows] = useState<PairRow[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState<string | null>(null), [delayed, setDelayed] = useState(0);
  const [pad, setPad] = useState('All'), [show, setShow] = useState('All'), [tab, setTab] = useState<PairRow['column']>('new'), [today, setToday] = useState<PairsToday | null>(null);
  const [selected, setSelected] = useState<string | null>(null), [tradeRow, setTradeRow] = useState<PairRow | null>(null), [now, setNow] = useState(Date.now()), [seen, setSeen] = useState(Date.now());
  const times = useRef(new Map<string, number>()), back = useRef<HTMLElement | null>(null), drawer = useRef<HTMLDialogElement>(null), snapshotEvents = useRef<ChannelEvent<'pairs'>[] | null>(null);
  const generation = useRef(0);
  const snapshot = useCallback(async (signal?: AbortSignal) => {
    const request = ++generation.current;
    snapshotEvents.current = []; setError(null);
    try {
      const result = await Promise.all(COLUMNS.map((stage) => fetchParsed(`${MOCKS ? '' : '/v2'}/pairs?stage=${stage}${blueChipOnly ? '&blueChip=true' : ''}`, PairResponseSchema, { signal })));
      if (signal?.aborted || request !== generation.current) return;
      result.flatMap(r => r.rows).forEach(rememberCoinIdentity);
      const at = Date.now(), buffered = snapshotEvents.current ?? [];
      result.flatMap((r) => r.rows).forEach((r) => { if (!buffered.some((e) => e.kind === 'pair_upsert' && e.data.address === r.address)) times.current.set(r.address, at); });
      // The updater may run after this function returns; it must not read the ref that is cleared below.
      setRows(old => applyPairEvents(result.flatMap((r) => r.rows).map(row => retainCompactGuard(old.find(r=>r.address===row.address),row)), buffered, times.current)); snapshotEvents.current = null; setDelayed(Math.max(...result.map((r) => r.delayedSec))); setSeen(at);
      const counts = result.find((r) => r.today)?.today; if (counts) setToday(counts);
    } catch (e) { if ((e as Error).name !== 'AbortError' && !isRateLimited(e)) { if (request === generation.current) setError((e as Error).message); throw e; } }
    finally { if (request === generation.current) { snapshotEvents.current = null; if (!signal?.aborted) setLoading(false); } }
  }, [blueChipOnly]);
  useEffect(() => { const ac = new AbortController(); void snapshot(ac.signal).catch(() => {}); return () => ac.abort(); }, [snapshot]);
  useEffect(() => installDither(), []);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  useEffect(() => rt?.subscribeBatch('pairs', (events) => {
    const at = Date.now(), offset = serverNow() - at;
    if (snapshotEvents.current) snapshotEvents.current = [...snapshotEvents.current, ...events].slice(-300);
    // A row's ageSec was measured when the server sent it, not when this batch drained.
    events.forEach((e) => { if (e.kind === 'pair_upsert') times.current.set(e.data.address, receivedAt(e.ts, at, offset)); });
    events.forEach(e => { if (e.kind === 'pair_upsert') rememberCoinIdentity(e.data); });
    setRows((old) => applyPairEvents(old, events, times.current)); setSeen(at);
  }, () => snapshot()), [rt, snapshot]);
  useEffect(() => { const active = new Set<string>(rows.map((r) => r.address)); for (const address of times.current.keys()) if (!active.has(address)) times.current.delete(address); }, [rows]);
  const close = useCallback(() => { setSelected(null); requestAnimationFrame(() => back.current?.focus()); }, []);
  useEffect(() => { if (!selected || tradeRow) return; const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('.info-pop')) close(); }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key); }, [selected, tradeRow, close]);
  useEffect(() => { if (tradeRow) drawer.current?.showModal(); else drawer.current?.close(); }, [tradeRow]);
  const columns = useMemo(() => pairColumns(rows.filter((r) => (!blueChipOnly || r.blueChip?.member) && (pad === 'All' || (pad === 'Montra' ? r.launchpad === 'montra' : r.launchpad !== 'montra')) && (show === 'All' || (show === 'Hot' ? heatOf(r, { pending: r.verdictPending }) === 'hot' : !r.verdictPending && r.verdict !== 'pending' && !refused(r, riskMode)))), times.current), [rows, pad, show, riskMode,blueChipOnly]);
  // FRONTEND §5 stale indicators: Pairs is stale after 60 s without an event (150 s when delayed, as Radar).
  const coin = rows.find((r) => r.address === selected), stale = ws !== 'open' || now - seen > (delayed ? 150000 : 60000);
  const select = (r: PairRow, el: HTMLElement) => { back.current = el; setSelected(r.address); }, trade = (r: PairRow, el: HTMLElement) => { if (!pairTradeDisabled(r, stale, true, riskMode)) { back.current = el; setTradeRow(r); } };
  const closeTrade = () => { setTradeRow(null); requestAnimationFrame(() => back.current?.focus()); };
  const column = (c: PairRow['column']) => <Column key={c} column={c} rows={columns[c]} now={now} times={times.current} select={select} trade={trade} stale={stale} />;
  // TODO(spec): CA-3 has no daily launch/refusal totals or median scan time; prototype totals appear only in the offline demo.
  return <div className={`with-insp pairs-layout${coin ? ' open' : ''}`}><div className="page sec-page pairs-page" inert={!wide && !!coin}><div className="page-head"><div><h1>New pairs</h1><p>Every launch on Elysium gets a Fast Scan before it gets a Trade button.</p></div><div className="stats-inline"><span><b className="num">{MOCKS ? 212 : today ? today.launches.toLocaleString('en-US') : '—'}</b> new pairs today</span><span><b className="num">{MOCKS ? '2.9 s' : today?.medianFirstScanSec != null ? firstScanText(today.medianFirstScanSec) : '—'}</b> median first scan</span><span><VerdictChip level="danger" /><b className="num">{MOCKS ? 38 + rows.filter((r) => r.column === 'new' && !r.verdictPending && r.verdict === 'danger').length : today ? today.refused.toLocaleString('en-US') : '—'}</b> refused at launch</span></div></div><div className="toolbar">{blueChipEnabled && <label><input type="checkbox" checked={blueChipOnly} onChange={e=>{setBlueChipOnly(e.target.checked);}} /> Blue chip</label>}<Seg options={['All', 'Montra', 'Other']} value={pad} onChange={setPad} label="Launchpad" /><Seg options={['All', 'Tradeable', 'Hot']} value={show} onChange={setShow} label="Show" /><div className="toolbar-end"><HeatLegend /><span className="toolbar-live" role="status"><span className={`sb-dot${stale ? ' stale' : ''}`} />{delayed ? `Delayed ~${delayed} s` : stale ? ws === 'reconnecting' ? 'Reconnecting' : 'Stale' : 'Live'} · updated {formatAge((now - seen) / 1000)} ago</span></div></div><p className="availability-legend">{CHECK_LEGEND}</p><GuardLegend rows={rows} />{error && <div className="radar-error" role="alert">{error} <button className="btn" onClick={() => void snapshot().catch(() => {})}>Retry</button></div>}{loading ? <div className="skel" style={{ height: 480 }} aria-label="Loading pairs" /> : narrow ? <><div className="pairs-seg"><Seg label="Column" value={tab} onChange={(v) => setTab(v as PairRow['column'])} options={COLUMNS.map((c) => ({ value: c, label: <>{c === 'near_grad' ? 'Graduating' : META[c].title}<span className="seg-n num">{columns[c].length}</span></> }))} /></div>{column(tab)}</> : <div className="pairs-cols">{COLUMNS.map(column)}</div>}<AnalysisPolicyNotice /></div>{coin && <CoinInspector key={coin.address} row={coin} close={close} onCard={() => {}} formatRowAge={formatAge} stale={stale} tradeVisible={!tradeRow} />}<dialog className="radar-trade-drawer" ref={drawer} onCancel={(e) => { e.preventDefault(); closeTrade(); }} onClick={(e) => { if (e.currentTarget === e.target) closeTrade(); }}><div className="insp-bar"><span>Trade {tradeRow && <>$<UntrustedText value={tradeRow.symbol} /></>}</span><button className="iconbtn" aria-label="Close trade" onClick={closeTrade}>×</button></div>{tradeRow && <TradePanel key={tradeRow.address} coin={tradeRow.address} priceUsd={tradeRow.priceUsd} priceUnavailable={tradeRow.priceUnavailable} guard={tradeRow.guardV2} stale={stale} antiSnipeEndsAt={tradeRow.antiSnipe ? (times.current.get(tradeRow.address) ?? seen) + tradeRow.antiSnipe.endsInSec * 1000 : undefined} />}</dialog></div>;
}
