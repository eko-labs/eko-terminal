import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { RadarRow } from '@eko/shared';
import { PixelGauge } from '../../components/GlanceTile';
import { sortByPlace, useCoinRowPlaces } from '../../components/placeSlots';
import { HeatTag, UntrustedText } from '../../components/ui';
import { Spark } from '../../components/ui/charts';
import { fetchParsed, isRateLimited, MOCKS } from '../../lib/api';
import { rememberCoinIdentity } from '../../lib/coinIdentity';
import { installDither } from '../../lib/dither';
import { formatCoinPrice } from '../../lib/format';
import { displayHeat, heatOf, markClass, marking } from '../../lib/heat';
import { Link } from '../../lib/Link';
import { useRealtime } from '../../lib/RealtimeContext';
import { Decode, Roll } from '../../pages/terminal/radarMotion';
import { RadarResponseSchema, applyRadarEvents, hotMetrics, hottest, usd, type HotWindow } from '../../pages/terminal/radarModel';
import { useSimple } from './choice';
import { LENSES, SORTS, isSort, matches, sortRows, trenchTags } from './trench';
import { answerOf, dollars, moveText, type Answer } from './model';
import { AnswerChip, CoinSearch, Ticker } from './parts';
import { LIST_FINISH, LIST_WALK, Walkthrough } from './Walkthrough';
import '../../pages/terminal/radar.css';
import '../../pages/terminal/coin.css';
import './simple.css';

const answerFor = (r: RadarRow): Answer => answerOf({ level: r.verdict, pending: r.verdictPending, historyPartial: r.historyPartial, guard: r.guardV2 });
/** An update that leaves out a row's trading counts keeps the last ones measured (they are refreshed with the list). */
function keepTrading(old: readonly RadarRow[], next: RadarRow[]): RadarRow[] {
  const before = new Map(old.map(r => [r.address, r]));
  return next.map(r => {
    const prev = before.get(r.address);
    return prev && r.volume1hUsd === undefined && prev.volume1hUsd !== undefined && !r.unavailable?.includes('volume')
      ? { ...r, volume1hUsd: prev.volume1hUsd, trades1h: prev.trades1h, volumeBaselineUsd: prev.volumeBaselineUsd, volume24hUsd: prev.volume24hUsd, trades24h: prev.trades24h } : r;
  });
}
const changeOf = (r: RadarRow) => (r.unavailable?.includes('change') ? null : r.change1hPct);

/** Busy right now: Full's Hot cards, in plain words. The last hour's busiest, else the day's when the hour is quiet. */
function Busy({ rows }: { rows: RadarRow[] }) {
  const { coins, window } = useMemo(() => {
    const hour = hottest(rows, 3, '1h');
    return hour.length ? { coins: hour, window: '1h' as HotWindow } : { coins: hottest(rows, 3, '24h'), window: '24h' as HotWindow };
  }, [rows]);
  if (!coins.length) return null;
  return <section className="hot-strip sv-busy" aria-labelledby="sv-busy-h">
    <div className="sec-head"><h2 id="sv-busy-h">Busy right now</h2><span className="sub hot-description">The coins people are trading most {window === '1h' ? 'this hour' : 'today'}. Busy is not the same as safe.</span></div>
    <div className="hot-grid">{coins.map(c => {
      const { volume, change } = hotMetrics(c, window);
      return <Link key={c.address} to={`/coin/${c.address}`} className={`htile ${markClass(marking(c))}`}>
        <span className="htile-top"><span className="htile-sym"><Ticker symbol={c.symbol} address={c.address} /></span><AnswerChip answer={answerFor(c)} /></span>
        <span className="htile-spark">{c.spark8h && c.spark8h.length > 1 && <Spark series={c.spark8h} height={46} />}</span>
        <span className="htile-facts">
          <span>Traded<b className="num">{volume === undefined ? '—' : dollars(volume)}</b></span>
          <span>Price<b className="num"><Roll value={formatCoinPrice(c.priceUsd)} /></b></span>
          <span>Moved<b className={`num${(change ?? 0) > 0 ? ' up' : ''}`}>{change === undefined ? '—' : moveText(change, '')}</b></span>
        </span>
      </Link>;
    })}</div>
  </section>;
}

/** Simple's coins list, in place of Radar: Full's head, Hot cards and row finish, every coin answered in plain words. */
export default function SimpleCoins() {
  const rt = useRealtime();
  const [rows, setRows] = useState<RadarRow[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState(false);
  const onlyOk = useSimple(s => s.onlyOk), setOnlyOk = useSimple(s => s.setOnlyOk);
  const lens = useSimple(s => s.lens), setLens = useSimple(s => s.setLens), sort = useSimple(s => s.sort), setSort = useSimple(s => s.setSort);
  const lensDef = LENSES.find(l => l.id === lens) ?? LENSES[0]!;
  // Features' figures in each row (placeSlots.tsx coinRow), each also a sort, highest first.
  const places = useCoinRowPlaces(), [placeSort, setPlaceSort] = useState<string | null>(null);
  const byPlace = places.find(p => `place:${p.id}` === placeSort);
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const data = await fetchParsed(`${MOCKS ? '' : '/v2'}/radar`, RadarResponseSchema, signal ? { signal } : {});
      if (signal?.aborted) return;
      data.rows.forEach(rememberCoinIdentity); setRows(data.rows); setError(false);
    } catch (e) { if ((e as Error).name !== 'AbortError' && !isRateLimited(e)) setError(true); }
    finally { if (!signal?.aborted) setLoading(false); }
  }, []);
  useEffect(() => installDither(), []);
  useEffect(() => { const ac = new AbortController(); void load(ac.signal); return () => ac.abort(); }, [load]);
  useEffect(() => rt?.subscribeBatch('radar', (events) => setRows(old => keepTrading(old, applyRadarEvents(old, events))), () => load()), [rt, load]);
  const answers = rows.map(r => ({ row: r, answer: answerFor(r) }));
  const inLens = rows.filter(r => matches(r, lens));
  const shown = (byPlace ? sortByPlace(sortRows(inLens, 'hot'), byPlace.value) : sortRows(inLens, sort)).map(r => answers.find(a => a.row === r)!)
    .filter(a => !onlyOk || a.answer.kind === 'ok');
  const counts = { ok: 0, careful: 0, dont: 0, checking: 0 };
  for (const a of answers) counts[a.answer.kind]++;
  // The walkthrough's first stop: a box over the top three rows (the whole list is taller than a screen).
  const list = useRef<HTMLOListElement>(null), [spot, setSpot] = useState({ top: 0, height: 0 });
  useLayoutEffect(() => {
    const items = list.current?.querySelectorAll<HTMLElement>('.sv-row');
    const firstRow = items?.[0], lastRow = items?.[Math.min(2, items.length - 1)];
    const next = firstRow && lastRow ? { top: firstRow.offsetTop, height: lastRow.offsetTop + lastRow.offsetHeight - firstRow.offsetTop } : { top: 0, height: 0 };
    setSpot(s => (s.top === next.top && s.height === next.height ? s : next));
  });
  return <div className="shell-page radar sv-page sv-coins">
    <div className="page-head">
      <div><h1>Coins</h1><p>New coins on the chain. EKO checks every one, so you can see in a word if it looks safe.</p></div>
      {rows.length > 0 && <dl className="head-stats sv-counts">
        {([['ok', 'Look OK', 'good'], ['careful', 'Be careful', 'watch'], ['dont', "Don't buy", 'bad']] as const).map(([k, label, tone]) =>
          <div key={k}><dt>{label}</dt><dd><span className="num">{counts[k]}</span><PixelGauge pct={counts[k] / rows.length * 100} tone={tone} columns={18} /></dd></div>)}
      </dl>}
    </div>
    <div data-walk="search" className="sv-search-wrap"><CoinSearch /></div>
    <Busy rows={rows} />
    <section aria-labelledby="sv-all-h">
      <div className="sec-head"><h2 id="sv-all-h">All coins</h2>
        <div className="end"><label className="sv-toggle">
          <input type="checkbox" role="switch" checked={onlyOk} onChange={e => setOnlyOk(e.target.checked)} />
          <span className="sv-toggle-track" aria-hidden="true"><i /></span>
          <span>Only coins that look OK</span>
        </label></div>
      </div>
      {/* Quick filters in trench words, each explained in one plain line under the row. */}
      <div className="sv-lens-bar">
        <div className="sv-lenses" role="radiogroup" aria-label="Show">
          {LENSES.map(l => <button type="button" key={l.id} role="radio" aria-checked={lens === l.id} title={l.hint} onClick={() => setLens(l.id)}>{l.label}</button>)}
        </div>
        <label className="sv-sort"><span>Sort</span>
          <select className="input" value={byPlace ? placeSort! : sort} onChange={e => { const v = e.target.value; if (v.startsWith('place:')) setPlaceSort(v); else if (isSort(v)) { setPlaceSort(null); setSort(v); } }}>
            {SORTS.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
            {places.map(p => <option key={p.id} value={`place:${p.id}`}>{p.label}</option>)}
          </select>
        </label>
      </div>
      <p className="sv-lens-hint">{lensDef.hint}</p>
      {error && !rows.length ? <div className="sv-empty"><p>EKO couldn't load the coins just now.</p><button type="button" className="sv-btn sv-btn-quiet" onClick={() => { setLoading(true); void load(); }}>Try again</button></div>
        : <div className={`sv-list-wrap${places.length ? ' has-place' : ''}`}>
          {spot.height > 0 && <div className="sv-walk-spot" data-walk="list" style={{ top: spot.top, height: spot.height }} />}
          <div className="sv-list-head" aria-hidden="true"><span>Coin</span><span>Last 8 hours</span><span>Market cap</span><span>Last hour</span>{places.map(p => <span key={p.id} title={p.title}>{p.label}</span>)}<span>EKO says</span></div>
          <ol ref={list} className="sv-list" aria-busy={loading}>
            {loading && !rows.length && Array.from({ length: 6 }, (_, i) => <li key={i} className="sv-row sv-row-wait" aria-hidden="true"><span className="skel" /></li>)}
            {shown.map(({ row, answer }, i) => {
              const change = changeOf(row);
              return <li key={row.address}>
                <Link to={`/coin/${row.address}`} className={`sv-row sv-row-${answer.kind} h-${heatOf(row)} ${markClass(marking(row))}`}>
                  <span className="sv-row-id"><span className="sv-row-top"><b><Ticker symbol={row.symbol} address={row.address} /></b><HeatTag heat={displayHeat(row)} />{trenchTags(row).map(t => <span key={t} className="tag sv-tag">{t}</span>)}</span><span className="sv-row-name"><UntrustedText value={row.name} /></span></span>
                  <span className="sv-row-spark">{row.spark8h && row.spark8h.length > 1 && !row.unavailable?.includes('spark') && <Spark series={row.spark8h} height={30} />}</span>
                  <span className="sv-row-price num">{row.marketCapUsd !== undefined && !row.unavailable?.includes('marketCap')
                    ? <><Roll value={usd(row.marketCapUsd)} />{!row.priceUnavailable && <small>{formatCoinPrice(row.priceUsd)}</small>}</>
                    : row.priceUnavailable ? '' : <Roll value={formatCoinPrice(row.priceUsd)} />}</span>
                  <span className={`sv-row-move${change !== null && change > 0 ? ' up' : ''}`}>{change === null ? '' : moveText(change, '')}</span>
                  {places.map(p => { const Cell = p.cell; return <span key={p.id} className="sv-row-place num"><Suspense fallback={null}><Cell row={row} /></Suspense></span>; })}
                  <span className="sv-row-answer"><AnswerChip answer={answer} size="md" walk={i === 0 ? 'answer' : undefined} /></span>
                </Link>
              </li>;
            })}
            {!loading && !shown.length && <li className="sv-empty">{lens !== 'all' && rows.length ? `No coins are ${lensDef.label === 'Buyers winning' ? 'seeing more buyers than sellers' : `“${lensDef.label}”`}${onlyOk ? ' and look OK' : ''} right now. EKO keeps checking: look again soon.`
              : onlyOk ? 'No coin looks OK right now. EKO keeps checking: look again soon.' : 'No coins yet. EKO adds them as they launch.'}</li>}
          </ol>
        </div>}
    </section>
    <Walkthrough walk="list" steps={LIST_WALK} ready={shown.length > 0} finish={LIST_FINISH} onFinish={() => { useSimple.setState({ tryFull: true }); useSimple.getState().choose('full'); }} />
  </div>;
}
