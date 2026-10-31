import { RatingPriceFact } from '../../components/GuardCompact';
import { useEffect, useRef, useState } from 'react';
import { ScoreboardResponseSchema, type ScoreboardKind, type ScoreboardResponse, type ScoreboardRow } from '@eko/shared';
import { fetchParsed } from '../../lib/api';
import { Link } from '../../lib/Link';
import { DYOR } from '../../copy';
import { availabilityMessage, collapsePendingCalls, counterText, gradeText, NOT_CHECKED, receiptPath, recordTime, RECORD_NOT_STARTED, rowAnchor, safePostMortem, SCOREBOARD_TABS, shortCoin } from './scoreboardModel';
import { GradeOutcomesPanel } from './GradeOutcomes';
import './trust.css';

function useScoreboard(kind: ScoreboardKind, revision: number) {
  const [data, setData] = useState<ScoreboardResponse | null>(null), [error, setError] = useState(false), [busy, setBusy] = useState(false);
  const generation = useRef(0), cursor = useRef<string | null>(null);
  useEffect(() => {
    const ac = new AbortController(), run = ++generation.current;
    setData(null); cursor.current = null; setError(false); setBusy(true);
    void fetchParsed(`/scoreboard?kind=${kind}`, ScoreboardResponseSchema, { signal: ac.signal }).then(value => {
      if (!ac.signal.aborted) { setData(value); cursor.current = value.cursor; }
    }).catch(() => { if (!ac.signal.aborted) setError(true); }).finally(() => { if (!ac.signal.aborted) setBusy(false); });
    return () => { ac.abort(); if (generation.current === run) generation.current++; };
  }, [kind, revision]);
  const more = async () => {
    if (!cursor.current || busy) return;
    const run = generation.current, next = cursor.current; setBusy(true); setError(false);
    try {
      const value = await fetchParsed(`/scoreboard?kind=${kind}&cursor=${encodeURIComponent(next)}`, ScoreboardResponseSchema);
      if (run !== generation.current) return;
      if (value.cursor === next) throw new Error('Cursor did not advance');
      setData(old => {
        if (!old || old.snapshot !== value.snapshot) { setError(true); return old; }
        cursor.current = value.cursor;
        return { ...old, cursor: value.cursor, rows: [...old.rows, ...value.rows.filter(row => !old.rows.some(prior => prior.id === row.id))] };
      });
    } catch { if (run === generation.current) setError(true); }
    finally { if (run === generation.current) setBusy(false); }
  };
  return { data, error, busy, more };
}
export function ScoreboardHeadlines({ data }: { data: ScoreboardResponse | null }) {
  // Until either counter is measured, one explanation replaces two empty figures.
  if (!data || (data.availability.refused.status !== 'observed' && data.availability.missed.status !== 'observed')) {
    const status = data?.availability.refused;
    return <section className="scoreboard-headlines" aria-label="The record"><div className="scoreboard-counter scoreboard-explainer"><h2>Honeypots refused and missed</h2>
      <p>{RECORD_NOT_STARTED}</p>{status && <p className="muted">{availabilityMessage(status)}</p>}</div></section>;
  }
  return <section className="scoreboard-headlines" aria-label="The record">{(['refused', 'missed'] as const).map(metric => {
    const status = data?.availability[metric];
    const since = status?.status === 'observed' ? status.since ?? data?.counters.since : null;
    return <div className="scoreboard-counter" key={metric}><h2>Honeypots {metric}</h2><b className="scoreboard-figure num">{counterText(data, metric)}</b>
      <p>{status ? availabilityMessage(status) : 'Monitoring data is loading or unavailable.'}</p>{since && <p>{data?.counters[metric] === 0 && metric === 'missed' ? '0 missed since' : 'Since'} {since}</p>}</div>;
  })}</section>;
}
export function RecordRows({ rows }: { rows: ScoreboardRow[] }) {
  const collapsed = collapsePendingCalls(rows);
  const ordered = [...collapsed.rows].sort((a, b) => Number(b.kind === 'calls' && b.grade === 'miss') - Number(a.kind === 'calls' && a.grade === 'miss'));
  return <ol className="scoreboard-records">{ordered.map(row => {
    // TODO(spec): CA-15 correctionOf may name a verdict or row, with no receipt lookup by revision.
    // Link receipts when their original is loaded; otherwise retain its identity as text.
    const original = rows.find(prior => prior.id === row.detail.correctionOf || prior.detail.revisionId === row.detail.correctionOf);
    const corrections = rows.filter(next => next.detail.correctionOf === row.id || (row.detail.revisionId !== undefined && next.detail.correctionOf === row.detail.revisionId));
    return <li key={row.id} id={rowAnchor(row.id)}><div className="scoreboard-record-head"><time dateTime={row.ts}>{recordTime(row.ts)}</time>{row.coin && <Link to={`/coin/${row.coin}`} title={row.coin}>{shortCoin(row.coin)}</Link>}
      {row.level && <><b>{row.level === 'clear' ? 'no flags' : row.level}</b><RatingPriceFact move={{downFromPeakPct:typeof row.detail.downFromPeakPct==='number' ? row.detail.downFromPeakPct : undefined,downSinceRatedPct:typeof row.detail.downSinceRatedPct==='number' ? row.detail.downSinceRatedPct : undefined}}/></>}{row.kind === 'calls' && <span>Grade: {gradeText(row)}</span>}{row.coin && collapsed.earlier.get(row.coin) ? <span className="muted">+{collapsed.earlier.get(row.coin)} earlier ungraded {collapsed.earlier.get(row.coin) === 1 ? 'call' : 'calls'}</span> : null}</div>
      {typeof row.detail.event === 'string' && <p>{row.detail.event.replaceAll('_', ' ')}</p>}
      {row.detail.counterEffect === 'retracted' && <p>Retracted from the counter: source block changed.</p>}
      <div className="scoreboard-links">{row.receiptId && <Link to={receiptPath(row.receiptId)}>{row.detail.correctionOf ? 'Correction receipt' : 'Original receipt'}</Link>}
        {typeof row.detail.correctionOf === 'string' && (original?.receiptId ? <Link to={receiptPath(original.receiptId)}>Original receipt</Link> : <span>Original record: {row.detail.correctionOf}</span>)}
        {corrections.map(next => next.receiptId ? <Link key={next.id} to={receiptPath(next.receiptId)}>Correction receipt</Link> : <a key={next.id} href={`#${rowAnchor(next.id)}`}>Correction record</a>)}
        {safePostMortem(row.detail.postMortemUrl) ? <Link to={row.detail.postMortemUrl}>Read the post-mortem</Link> : row.kind === 'honeypots_missed' && <span>Post-mortem pending</span>}
        {row.txHash && /^0x[0-9a-fA-F]{64}$/.test(row.txHash) && <a href={`https://elysium.kinetiq.xyz/explorer/tx/${row.txHash}`} target="_blank" rel="noopener noreferrer">Transaction ↗</a>}
      </div></li>;
  })}</ol>;
}
export function CohortRows({ rows }: { rows: ScoreboardRow[] }) {
  return <div className="scoreboard-cohorts">{rows.map(row => {
    const d = row.detail;
    return <article className="panel" key={row.id}><div className="panel-body"><h3>{d.week} · {d.group === 'clear' ? 'No flags cohort' : 'All launches'}</h3>
      <dl className="receipt-metadata"><dt>Eligible coins</dt><dd>{d.eligible}</dd><dt>Evaluated</dt><dd>{d.evaluated}</dd><dt>Immature</dt><dd>{d.immature}</dd><dt>Censored</dt><dd>{d.censored}</dd><dt>Ungraded</dt><dd>{d.ungraded}</dd>
        <dt>Rug rate</dt><dd>{d.rugRateStatus === 'observed' && typeof d.rugRatePct === 'number' ? `${d.rugRatePct.toFixed(2)}%` : NOT_CHECKED} · denominator {d.rugDenominator}</dd>
        <dt>Median outcome</dt><dd>{d.medianStatus === 'observed' && typeof d.medianOutcomePct === 'number' ? `${d.medianOutcomePct.toFixed(2)}%` : NOT_CHECKED} · denominator {d.medianDenominator}</dd>
        <dt>Horizon</dt><dd>{d.horizonSec} seconds</dd><dt>Membership hash</dt><dd className="num">{d.membershipHash}</dd><dt>Outcome version</dt><dd>{d.outcomeVersion}</dd><dt>Identity version</dt><dd>{d.identityVersion}</dd><dt>Cut block</dt><dd>{d.cutBlock}</dd>
      </dl><p>Measured cohorts. Immature, censored and ungraded coins are shown separately. No flags is not a recommendation.</p></div></article>;
  })}</div>;
}
export default function Scoreboard() {
  const [kind, setKind] = useState<ScoreboardKind>('calls'), [revision, setRevision] = useState(0), [receiptId, setReceiptId] = useState('');
  const misses = useScoreboard('honeypots_missed', revision), selected = useScoreboard(kind, revision);
  const data = kind === 'honeypots_missed' ? misses.data : selected.data;
  const availabilityKey = kind === 'calls' ? 'grades' : kind === 'honeypots_refused' ? 'refused' : kind === 'honeypots_missed' ? 'missed' : kind;
  return <div className="shell-page trust-page"><div className="page-head"><div><h1>Scoreboard</h1><p>The public record. Misses come first; measurements keep their original receipts and corrections.</p></div><button className="btn" onClick={() => setRevision(n => n + 1)}>Refresh record</button></div>
    <GradeOutcomesPanel revision={revision} />
    <ScoreboardHeadlines data={misses.data} />
    <section className="panel"><div className="panel-head"><h2>Misses first</h2></div><div className="panel-body">
      {misses.error ? <p role="alert">Misses are unavailable. Refresh to retry.</p> : !misses.data ? <p role="status">Loading misses…</p> : <>{!misses.data.rows.length && <p>{misses.data.availability.missed.status === 'observed' ? 'No misses in this record.' : availabilityMessage(misses.data.availability.missed)}</p>}<RecordRows rows={misses.data.rows} />
        {misses.data.cursor && <button className="btn" disabled={misses.busy} onClick={() => void misses.more()}>More misses</button>}</>}
    </div></section>
    <nav className="scoreboard-tabs" aria-label="Scoreboard records">{SCOREBOARD_TABS.map(([value, label]) => <button className="btn" key={value} aria-pressed={kind === value} onClick={() => setKind(value)}>{label}</button>)}</nav>
    <section className="panel"><div className="panel-head"><h2>{SCOREBOARD_TABS.find(([value]) => value === kind)![1]}</h2></div><div className="panel-body">
      {kind === 'honeypots_missed' ? <p>Misses and their post-mortems are listed first, above.</p> : selected.error ? <p role="alert">This record is unavailable. Refresh to retry.</p> : !data ? <p role="status">Loading record…</p> : <><p>{availabilityMessage(data.availability[availabilityKey])}</p>
        {kind === 'calls' && <p>{availabilityMessage(data.availability.forecasts)}</p>}
        {!data.rows.length && <p>No accepted records to show.</p>}{kind === 'cohort' ? <CohortRows rows={data.rows} /> : <RecordRows rows={data.rows} />}
        {data.cursor && <button className="btn" disabled={selected.busy} onClick={() => void selected.more()}>Load more records</button>}</>}
    </div></section>
    <section className="panel"><div className="panel-body"><h2>Verify a receipt</h2><label>Receipt ID <input className="input" value={receiptId} onChange={e => setReceiptId(e.target.value)} spellCheck={false} /></label>{receiptId.trim() && <Link className="btn" to={receiptPath(receiptId.trim())}>Open receipt</Link>}</div></section>
    <p className="note">{DYOR} No flags is not a recommendation.</p>
  </div>;
}
