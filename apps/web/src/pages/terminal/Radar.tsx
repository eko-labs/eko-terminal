import { rememberCoinIdentity } from '../../lib/coinIdentity';
import { GhostReports } from '../../components/GhostReports';
import { AnalysisPolicyNotice } from '../../components/PolicyLinks';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { CoinCard, RadarRow } from '@eko/shared';
import { CHECK_LEGEND, NO_FLAGS } from '../../copy/availability';
import { GuardLegend } from '../../components/GuardCompact';
import { Seg, UntrustedText } from '../../components/ui';
import { MiniBars } from '../../components/ui/charts';
import { fetchParsed, isRateLimited, MOCKS } from '../../lib/api';
import { useRealtime } from '../../lib/RealtimeContext';
import { useMedia } from '../../lib/useMedia';
import { installDither } from '../../lib/dither';
import { heatOf } from '../../lib/heat';
import { reducedMotion } from '../../lib/phosphor';
import { useUi } from '../../store/ui';
import { useShell } from '../../store/shell';
import { Link } from '../../lib/Link';
import { COLUMNS, COLUMNS_KEY, hiddenColumnClasses, parseColumns, type ColumnId, retainCompactGuard, sortAvailable, ascending, applyRadarEvents, currentAgeSec, filterRows, heatScore, RadarResponseSchema, receivedAt, scanDelayed, SORTS, sortRows, type Sort, hottest } from './radarModel';
import { serverNow } from '../../lib/clock';
import { TradePanel } from '../../components/trade/TradePanel';
import { CoinInspector, HeatLegend, HotStrip, RadarRowView } from './RadarParts';
import { useRadarWindow } from './radarWindow';
import './radar.css';

const hourly = (seed: number, base: number, swing: number) => { let state = seed; const r = () => { state = (state + 0x6D2B79F5) | 0; let t = Math.imul(state ^ state >>> 15, 1 | state); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; return Array.from({ length: 24 }, (_, i) => Math.round(base * (.55 + .45 * Math.sin(i / 3.2 + seed)) + r() * swing + (i > 17 ? base * .25 : 0))); };
const SCANS = hourly(7, 42, 22), REFUSED = hourly(11, 1.3, 2.2), DANGER = hourly(13, .9, 1.6);
const rememberKey = 'eko.radar.sel';
function remembered() { try { return localStorage.getItem(rememberKey); } catch { return null; } }
function SortTh({ value, sort, setSort, className, children, disabled = false }: { disabled?: boolean; value: Sort; sort: Sort; setSort: (s: Sort) => void; className: string; children: ReactNode }) {
  const on = sort === value;
  return <th className={className} aria-sort={!disabled && on ? ascending(sort) ? 'ascending' : 'descending' : 'none'}><button disabled={disabled} className={`rt-sort${on ? ' on' : ''}`} onClick={() => setSort(on ? 'Rank' : value)}>{children}<span aria-hidden="true">{on ? '▾' : ''}</span></button></th>;
}
const HIDE_REFUSED_KEY = 'eko.radar.hideRefused';
/** The Columns menu: tick the optional columns to show. Saved on this device. */
function ColumnPicker({ columns, setColumns }: { columns: ColumnId[]; setColumns: (next: ColumnId[]) => void }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => { const away = (e: PointerEvent) => { const d = ref.current; if (d?.open && !d.contains(e.target as Node)) d.open = false; }; document.addEventListener('pointerdown', away); return () => document.removeEventListener('pointerdown', away); }, []);
  const toggle = (id: ColumnId) => setColumns(COLUMNS.map(c => c.id).filter(c => c === id ? !columns.includes(id) : columns.includes(c)));
  return <details className="col-pick" ref={ref} onKeyDown={(e) => { if (e.key === 'Escape' && ref.current?.open) { e.stopPropagation(); ref.current.open = false; ref.current.querySelector('summary')?.focus(); } }}>
    <summary className="select">Columns <span className="faint num">{columns.length}/{COLUMNS.length}</span></summary>
    <fieldset className="col-pick-menu"><legend className="sr">Columns to show</legend>
      {COLUMNS.map(c => <label key={c.id}><input type="checkbox" checked={columns.includes(c.id)} onChange={() => toggle(c.id)} /> {c.label}</label>)}
      <button type="button" className="btn btn-sm" onClick={() => setColumns(parseColumns(null))}>Reset</button>
    </fieldset></details>;
}
export default function Radar() {
  const blueChipEnabled = !!useShell(s => s.config?.blueChip), [blueChipOnly, setBlueChipOnly] = useState(false);
  const wide = useMedia('(min-width:1480px)'), rt = useRealtime();
  const wsState = useShell((s) => s.wsState), realtimeAllowed = useShell((s) => s.me?.entitlements.limits.realtime);
  const density = useUi((s) => s.density), setUi = useUi((s) => s.set), riskMode = useUi((s) => s.riskMode);
  const [totals,setTotals]=useState<{danger:number;evaluatedToday:number;evaluatedByHour?:number[];dangerByHour?:number[];honeypotsRefused?:number;refusedByHour?:number[]}|null>(null);
  const [rows, setRows] = useState<RadarRow[]>([]), [cursor, setCursor] = useState<string | null>(null), [delayed, setDelayed] = useState(0);
  const [loading, setLoading] = useState(true), [error, setError] = useState<string | null>(null);
  const [show, setShow] = useState('All'), [stage, setStage] = useState('All'), [sort, setSort] = useState<Sort>('Rank');
  // Remembered on this device: a reader who hides refused coins wants them hidden on the next visit too.
  const [hideRefused, setHideRefused] = useState(() => { try { return localStorage.getItem(HIDE_REFUSED_KEY) === '1'; } catch { return false; } });
  const [columns, setColumnsState] = useState<ColumnId[]>(() => { try { return parseColumns(localStorage.getItem(COLUMNS_KEY)); } catch { return parseColumns(null); } });
  const setColumns = (next: ColumnId[]) => { setColumnsState(next); try { localStorage.setItem(COLUMNS_KEY, JSON.stringify(next)); } catch { /* optional */ } };
  const chooseRefused = (value: string) => { const hide = value === 'Hidden'; setHideRefused(hide); try { localStorage.setItem(HIDE_REFUSED_KEY, hide ? '1' : '0'); } catch { /* optional */ } };
  const [selected, setSelected] = useState<string | null>(null), [tradeRow, setTradeRow] = useState<RadarRow | null>(null);
  const [cards, setCards] = useState<Record<string, CoinCard>>({});
  const [pulses, setPulses] = useState<Record<string, number>>({}), [lastSeen, setLastSeen] = useState(Date.now()), [now, setNow] = useState(Date.now());
  const returnTo = useRef<HTMLElement | null>(null), listEl = useRef<HTMLDivElement>(null), page = useRef<HTMLDivElement>(null), drawer = useRef<HTMLDialogElement>(null);
  const pullStart = useRef<number | null>(null);
  const received = useRef(new Map<string, number>());
  const flashAt = useRef(new Map<string, number>()), selectionInitialized = useRef(false), pointed = useRef<string | null>(null), previousOrder = useRef<string[]>([]);
  const snapshot = useCallback(async (signal?: AbortSignal, append = false, nextCursor?: string) => {
    setError(null);
    const query = new URLSearchParams();
    if(nextCursor) query.set('cursor', nextCursor);
    if(blueChipOnly) query.set('blueChip', 'true');
    try { const data = await fetchParsed(`${MOCKS ? '' : '/v2'}/radar${query.size ? `?${query}` : ''}`, RadarResponseSchema, { signal }); if (signal?.aborted) return;
      data.rows.forEach(rememberCoinIdentity);
      const at = Date.now(); if (!append) received.current.clear(); for (const row of data.rows) if (!append || !received.current.has(row.address)) received.current.set(row.address, at);
      setRows((old) => append ? [...old, ...data.rows.filter((c) => !old.some((r) => r.address === c.address))] : data.rows.map(row => retainCompactGuard(old.find(r=>r.address===row.address),row))); setTotals(data.guardTotals?.status === 'unavailable' ? null : data.totals ?? null); setCursor(data.cursor); setDelayed(data.delayedSec); setLastSeen(Date.now());
    } catch (e) { if ((e as Error).name !== 'AbortError' && !isRateLimited(e)) setError((e as Error).message); } finally { if (!signal?.aborted) setLoading(false); }
  }, [blueChipOnly]);
  useEffect(() => installDither(), []);
  useEffect(() => { const ac = new AbortController(); void snapshot(ac.signal); return () => ac.abort(); }, [snapshot]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => rt?.subscribeBatch('radar', (events) => {
    const at = Date.now(), offset = serverNow() - at;
    // Rows carry their age when sent; "Newest" compares launches on the client clock (see launchedAt).
    for (const event of events) if (event.kind === 'row_upsert') received.current.set(event.data.address, receivedAt(event.ts, at, offset)); else if (event.kind === 'row_remove') received.current.delete(event.data.address);
    events.forEach(e => { if (e.kind === 'row_upsert') rememberCoinIdentity(e.data); });
    setRows((old) => applyRadarEvents(old, events)); setLastSeen(at);
    // Record throttle times once in the event handler; React may replay state updaters.
    const changed: Record<string, number> = {};
    for (const event of events) if (event.kind === 'row_upsert' && at - (flashAt.current.get(event.data.address) ?? -Infinity) >= 2000) {
      flashAt.current.set(event.data.address, at); changed[event.data.address] = at;
    }
    if (Object.keys(changed).length) setPulses((old) => ({ ...old, ...changed }));
  }, () => snapshot()), [rt, snapshot]);
  // Wide displays remember a close as well as a selection. Narrow displays only open after a tap.
  // Switching to a narrow display closes the panel once. Rows arriving later must not close a panel the visitor opened.
  useEffect(() => { if (!wide) { setSelected(null); selectionInitialized.current = false; } }, [wide]);
  useEffect(() => {
    if (!wide) return;
    if (rows.length && !selectionInitialized.current) { const stored = remembered(); setSelected(stored === 'none' ? null : rows.find((c) => c.address === stored)?.address ?? hotFirst(rows)); selectionInitialized.current = true; }
  }, [wide, rows.length]);
  const select = useCallback((c: RadarRow, el: HTMLElement) => { returnTo.current = el; setSelected(c.address); if (wide) { try { localStorage.setItem(rememberKey, c.address); } catch { /* optional */ } } }, [wide]);
  const close = useCallback(() => { setSelected(null); if (wide) { try { localStorage.setItem(rememberKey, 'none'); } catch { /* optional */ } } requestAnimationFrame(() => { const back = returnTo.current; if (back?.isConnected) back.focus(); else listEl.current?.querySelector<HTMLButtonElement>('[data-pick]')?.focus(); }); }, [wide]);
  useEffect(() => { if (!selected || tradeRow) return; const key = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('.info-pop')) { e.preventDefault(); close(); } }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key); }, [selected, close, tradeRow]);
  const list = useMemo(() => {
    const next = sortRows(filterRows(rows.filter(r => !blueChipOnly || r.blueChip?.member), show, stage, hideRefused, riskMode), sort, received.current), pinned = pointed.current;
    const oldIndex = pinned ? previousOrder.current.indexOf(pinned) : -1, newIndex = next.findIndex((c) => c.address === pinned);
    if (oldIndex >= 0 && newIndex >= 0 && oldIndex !== newIndex) { const [row] = next.splice(newIndex, 1); next.splice(Math.min(oldIndex, next.length), 0, row); }
    return next;
  }, [rows, show, stage, sort, hideRefused, riskMode, blueChipOnly]);
  const positions = useRef(new Map<string, number>()), lastFlip = useRef(0);
  useLayoutEffect(() => {
    const at = performance.now(), nodes = listEl.current?.querySelectorAll<HTMLElement>('tr[data-address]');
    const next = new Map<string, number>();
    nodes?.forEach((node) => { const address = node.dataset.address!, y = node.getBoundingClientRect().top; next.set(address, y); const before = positions.current.get(address); if (before !== undefined && before !== y && at - lastFlip.current >= 2000 && !reducedMotion() && node.animate) node.animate([{ transform: `translateY(${before - y}px)` }, { transform: 'translateY(0)' }], { duration: 200, easing: 'ease-out' }); });
    if (at - lastFlip.current >= 2000) lastFlip.current = at;
    positions.current = next; previousOrder.current = list.map((c) => c.address);
  }, [list, density]);
  const rowHeight = density === 'compact' ? 44 : 62;
  const windowed = useRadarWindow(listEl, list.length, rowHeight);
  const hot = useMemo(() => hottest(rows.filter(r => !blueChipOnly || r.blueChip?.member)), [rows, blueChipOnly]);
  const coin = rows.find((c) => c.address === selected);
  useEffect(() => { if (selected && !loading && !coin) close(); }, [selected, loading, coin, close]);
  const onCard = useCallback((card: CoinCard) => setCards((old) => ({ ...old, [card.identity.address]: card })), []);
  const trade = useCallback((c: RadarRow, el: HTMLElement) => { returnTo.current = el; setTradeRow(c); }, []);
  useEffect(() => { if (tradeRow) drawer.current?.showModal(); else if (drawer.current?.open) drawer.current.close(); }, [tradeRow]);
  const closeTrade = () => { setTradeRow(null); requestAnimationFrame(() => returnTo.current?.focus()); };
  const move = (e: KeyboardEvent) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key) || !(e.target instanceof Element) || !e.target.closest('[data-pick]')) return;
    const address = (e.target as Element).closest<HTMLElement>('tr[data-address]')?.dataset.address;
    const index = list.findIndex((c) => c.address === address); if (index < 0) return;
    e.preventDefault(); const next = e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : Math.max(0, Math.min(list.length - 1, index + (e.key === 'ArrowDown' ? 1 : -1)));
    windowed.reveal(next);
    requestAnimationFrame(() => { const button = listEl.current?.querySelector<HTMLButtonElement>(`tr[data-address="${list[next].address}"] [data-pick]`); if (button) { button.scrollIntoView({ block: 'nearest' }); button.focus(); button.click(); } });
  };
  const seen = Math.max(0, Math.floor((now - lastSeen) / 1000)), isDelayed = delayed > 0 || realtimeAllowed === false, stale = seen > (isDelayed ? 150 : 90) || wsState !== 'open';
  // TODO(spec): CA-3 has no refusal totals; RadarTotals carries them additively once quotes run the sell check, else "not checked yet".
  return <div className={`with-insp radar-layout${coin ? ' open' : ''}`}><div className="page radar" ref={page} onTouchStart={(e) => { pullStart.current = window.scrollY <= 0 ? e.touches[0]?.clientY ?? null : null; }} onTouchEnd={(e) => { if (pullStart.current !== null && (e.changedTouches[0]?.clientY ?? 0) - pullStart.current > 80) void snapshot(); pullStart.current = null; }} inert={!wide && !!coin}>
    <div className="page-head"><div><h1>Radar</h1><p>Every Montra launch on Elysium from the last 24 hours, checked by the guard, most traded first.</p></div><dl className="head-stats"><div><dt>Scanned today</dt><dd><span className="num">{MOCKS ? '1,204' : totals?.evaluatedToday.toLocaleString() ?? '—'}</span>{MOCKS ? <MiniBars series={SCANS} height={22} label="Pairs scanned per hour, last 24 hours" /> : totals?.evaluatedByHour && <MiniBars series={totals.evaluatedByHour} height={22} label="Coins scanned per hour, last 24 hours" />}</dd></div><div><dt>Honeypots refused</dt><dd><span className="num">{MOCKS ? '37' : totals?.honeypotsRefused?.toLocaleString() ?? '—'}</span>{!MOCKS && totals?.honeypotsRefused === undefined && <small className="muted">not checked yet</small>}{MOCKS ? <MiniBars series={REFUSED} height={22} tone="warm" label="Honeypots refused per hour, last 24 hours" /> : totals?.refusedByHour && <MiniBars series={totals.refusedByHour} height={22} tone="warm" label="Coins whose buy the guard refused because the sell failed, per hour, last 24 hours" />}</dd></div><div><dt>Danger now</dt><dd><span className="num">{MOCKS ? rows.filter((c) => c.verdict === 'danger').length : totals?.danger.toLocaleString() ?? '—'}</span>{MOCKS ? <MiniBars series={DANGER} height={22} tone="warm" label="Coins marked Danger per hour, last 24 hours" /> : totals?.dangerByHour && <MiniBars series={totals.dangerByHour} height={22} tone="warm" label="Coins given a Danger verdict per hour, last 24 hours" />}</dd></div></dl></div>
    <GhostReports limit={1} />
    <HotStrip coins={hot} selected={selected} select={select} />
    <div className="sec-head"><h2>All coins</h2><span className="sub num">{list.length} of {rows.length}</span><div className="end"><span className="toolbar-live" role="status"><span className={`sb-dot${stale ? ' stale' : ''}`} />{isDelayed ? `Delayed ~${delayed || 60} s` : stale ? 'Stale' : 'Live'} · updated {seen}s ago</span><Seg options={[{ value: 'comfortable', label: 'Comfortable' }, { value: 'compact', label: 'Compact' }]} value={density} onChange={(value) => setUi({ density: value === 'compact' ? 'compact' : 'comfortable' })} label="Row density" /></div></div>
    <div className="toolbar">{blueChipEnabled && <label><input type="checkbox" checked={blueChipOnly} onChange={e=>{setCursor(null);setBlueChipOnly(e.target.checked);}} /> Blue chip</label>}<Seg options={['All', 'Hot', NO_FLAGS, 'Monitor', 'Danger']} value={show} onChange={setShow} label="Show" /><Seg options={['All', 'Curve', 'Migrated', 'Uniswap']} value={stage} onChange={setStage} label="Stage" /><Seg options={[{ value: 'Shown', label: 'Show refused' }, { value: 'Hidden', label: 'Hide refused' }]} value={hideRefused ? 'Hidden' : 'Shown'} onChange={chooseRefused} label="Refused coins" /><label className="toolbar-sort"><span className="muted">Sort</span><select className="select" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>{SORTS.filter((s) => sortAvailable(rows,s)).map((s) => <option key={s}>{s}</option>)}</select></label><ColumnPicker columns={columns} setColumns={setColumns} /><div className="toolbar-end"><HeatLegend /></div></div>
    {/* TODO(spec): RadarRow has topPlaybook but no match confidence; show confidence only after CoinCard supplies it. */}
    {error && <div className="radar-error" role="alert">{error} <button className="btn" onClick={() => void snapshot()}>Retry</button></div>}
    <details className="radar-notes"><summary>About these readings</summary><p className="availability-legend">{CHECK_LEGEND}</p><GuardLegend rows={rows} /></details>{loading ? <div className="skel" style={{ height: 280 }} aria-label="Loading Radar" /> : list.length ? <div ref={listEl} className="rt-wrap" onKeyDown={move} onPointerOver={(e) => { pointed.current = (e.target as Element).closest<HTMLElement>('tr[data-address]')?.dataset.address ?? null; }} onPointerLeave={() => { pointed.current = null; }}><table className={`rt ${density}${rows.some((c) => c.signal || c.unavailable?.includes('signal')) ? '' : ' no-signal'}${rows.some((c) => c.spark8h || c.unavailable?.includes('spark')) ? '' : ' no-spark'}${rows.some((c) => c.beta) ? '' : ' no-beta'}${emptyColumns(rows)}${hiddenColumnClasses(columns)}`}><caption className="sr">All coins on Radar, {sort === 'Rank' ? 'ranked by the guard' : `sorted by ${sort}`}. Select a coin to see its details.</caption><thead><tr><th className="c-coin">Coin</th><th className="c-guard">Guard</th><th className="c-watch">Watch for</th><th className="c-sig r">Signal <span className="tag signal-beta">Beta</span></th><th className="c-beta r">Beta Ape Score</th><SortTh disabled={!sortAvailable(rows,'Price')} value="Price" {...{ sort, setSort }} className="c-price r">Price</SortTh><SortTh disabled={!sortAvailable(rows,'Market cap')} value="Market cap" {...{ sort, setSort }} className="c-mcap r">Mkt cap</SortTh><SortTh disabled={!sortAvailable(rows,'1h move')} value="1h move" {...{ sort, setSort }} className="c-1h r">1h</SortTh><th className="c-spark">Last 8h</th><SortTh disabled={!sortAvailable(rows,'Agent flow')} value="Agent flow" {...{ sort, setSort }} className="c-flow">Who’s buying</SortTh><th className="c-liq r">Liquidity</th><SortTh disabled={!sortAvailable(rows,'Exit cost')} value="Exit cost" {...{ sort, setSort }} className="c-exit r">Exit at $1K</SortTh><th className="c-act"><span className="sr">Trade</span></th></tr></thead><tbody>{windowed.start > 0 && <tr aria-hidden="true" className="rt-spacer"><td colSpan={1} style={{ height: windowed.start * rowHeight }} /></tr>}{list.slice(windowed.start, windowed.end).map((c) => <RadarRowView key={c.address} c={c} selected={selected === c.address} select={select} trade={trade} pulse={pulses[c.address] ?? 0} confidence={cards[c.address]?.playbooks.find((p) => p.id === c.topPlaybook)?.confidence} scanDelayed={scanDelayed(c, currentAgeSec(c, received.current, now))} />)}{windowed.end < list.length && <tr aria-hidden="true" className="rt-spacer"><td colSpan={1} style={{ height: (list.length - windowed.end) * rowHeight }} /></tr>}</tbody></table></div> : !error && <div className="empty panel">Nothing matches this filter right now.</div>}
    {cursor && <button className="btn radar-more" onClick={() => void snapshot(undefined, true, cursor)}>Load more</button>}
    <AnalysisPolicyNotice />
  </div>{coin && <CoinInspector key={coin.address} row={coin} close={close} onCard={onCard} stale={stale} tradeVisible={!tradeRow} />}
    <dialog className="radar-trade-drawer" ref={drawer} onCancel={(e) => { e.preventDefault(); closeTrade(); }} onClick={(e) => { if (e.target === e.currentTarget) closeTrade(); }}><div className="insp-bar"><span>Trade {tradeRow && <>$<UntrustedText value={tradeRow.symbol} /></>}</span><button className="iconbtn" aria-label="Close trade" onClick={closeTrade}>×</button></div>{tradeRow && <TradePanel key={tradeRow.address} coin={tradeRow.address} priceUsd={tradeRow.priceUsd} priceUnavailable={tradeRow.priceUnavailable} guard={tradeRow.guardV2} stale={stale} />}</dialog>
  </div>;
}
/** Hide a column only when no loaded row has its reading, so a table of dashes does not crowd the coins. */
function emptyColumns(rows: RadarRow[]) {
  const none = (field: NonNullable<RadarRow['unavailable']>[number]) => rows.length > 0 && rows.every((c) => c.unavailable?.includes(field));
  return `${none('flow') ? ' no-flow' : ''}${none('exitCost') && !rows.some((c) => c.sellCheck) ? ' no-exit' : ''}${none('liquidity') ? ' no-liq' : ''}`;
}
function hotFirst(rows: RadarRow[]) { return [...rows].filter((c) => heatOf(c) === 'hot').sort((a, b) => heatScore(b) - heatScore(a))[0]?.address ?? rows[0]?.address ?? null; }
