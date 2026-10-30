import { useEffect, useState } from 'react';
import { RadarResponseSchema, type RadarRow } from '@eko/shared';
import { CompactVerdictChip } from '../../components/GuardCompact';
import { AnalysisPolicyNotice, PolicyLinks } from '../../components/PolicyLinks';
import { UntrustedText } from '../../components/ui';
import { BUILT_ON, DYOR, NON_AFFILIATION } from '../../copy';
import { SCAN_COPY as C } from '../../copy/scan';
import { fetchParsed, MOCKS } from '../../lib/api';
import { Link } from '../../lib/Link';
import { FlowBar } from '../terminal/FlowBar';
import { exitText, age } from '../terminal/radarModel';
import { ScanCountersSchema, type ScanCounters } from './scanModel';
import { launchpadLabel } from '../../copy/chain';
import { RECORD_NOT_STARTED } from '../trust/scoreboardModel';
import './scan.css';
import '../terminal/radar.css';

export function ProofCounters({ counters }: { counters: ScanCounters }) {
  const measured = !!counters?.since;
  // Same wording as the Scoreboard: one explanation instead of two empty figures until counting starts.
  if (!measured) return <section className="scan-proof" aria-label="Observation counters"><p>{RECORD_NOT_STARTED}</p><Link to="/scoreboard">Scoreboard</Link></section>;
  return <section className="scan-proof" aria-label="Observation counters"><div className="scan-counter-grid">{(['refused', 'missed'] as const).map(kind =>
    <div className="scan-counter" key={kind}><strong className="num">{measured && counters?.[kind] != null ? counters[kind].toLocaleString() : C.unavailable}</strong><span>{C[kind]}</span></div>)}</div>
    <p className="muted">{measured ? `${C.since} ${counters!.since}` : C.countersUnavailable}</p><Link to="/scoreboard">Scoreboard</Link></section>;
}
export function RadarPreview({ rows, delayedSec }: { rows: RadarRow[]; delayedSec: number }) {
  return <div className="scan-radar-grid">{rows.slice(0, 6).map(row => <article className="panel scan-preview" key={row.address}>
    <Link to={`/coin/${row.address}`}><b>$<UntrustedText value={row.symbol} /></b><p><UntrustedText value={row.name} /></p></Link>
    <p className="muted">{C.radarDelay}: {delayedSec} s · {age(row.ageSec)} · {launchpadLabel(row.launchpad, row.stage === 'graduated')}</p>
    <CompactVerdictChip priceMove={row.priceMove} level={row.verdict} guard={row.guardV2} failed={row.guardRefreshFailed} pending={row.verdictPending} evaluatedPlaybooks={row.evaluatedPlaybooks} missing={row.missingChecks} />
    <p>{C.exit}: {row.unavailable?.includes('exitCost') ? C.notChecked : exitText(row.exitCost1kPct)}</p>
    <FlowBar flow={row.flow} unavailable={row.unavailable?.includes('flow')} legend />
  </article>)}</div>;
}
export default function LandingDetails() {
  const [rows, setRows] = useState<RadarRow[]>([]), [delay, setDelay] = useState(0);
  const [counters, setCounters] = useState<ScanCounters>(null), [radar, setRadar] = useState<'loading' | 'ready' | 'error'>('loading'), [retry, setRetry] = useState(0);
  useEffect(() => {
    const ac = new AbortController();
    void fetchParsed(MOCKS ? '/radar' : '/v2/radar', RadarResponseSchema, { signal: ac.signal }).then(data => { if (!ac.signal.aborted) { setRows(data.rows); setDelay(data.delayedSec); setRadar('ready'); } }).catch(() => { if (!ac.signal.aborted) setRadar('error'); });
    void fetchParsed('/scoreboard?kind=honeypots_refused', ScanCountersSchema, { signal: ac.signal }).then(data => { if (!ac.signal.aborted) setCounters(data.counters); }).catch(() => { if (!ac.signal.aborted) setCounters(null); });
    return () => ac.abort();
  }, [retry]);
  return <>
    <ProofCounters counters={counters} />
    <section><div className="scan-section-head"><h2>{C.radar}</h2><Link to="/radar">{C.openRadar}</Link></div>
      {radar === 'loading' ? <div className="skel" aria-label={C.radar} style={{ height: 180 }} /> : radar === 'error' ? <p role="status">{C.radarError} <button className="btn" onClick={() => setRetry(n => n + 1)}>{C.retry}</button></p> : rows.length ? <RadarPreview rows={rows} delayedSec={delay} /> : <p>{C.radarEmpty}</p>}</section>
    <section className="panel scan-pitch"><h2>{C.harness}</h2><p>{C.harnessBody}</p><Link className="btn" to="/mission/connect">{C.connect}</Link></section>
    <section className="scan-pitch"><h2>{C.drops}</h2><p>{C.dropsBody}</p><Link to="/drops">{C.drops}</Link></section>
    <footer><AnalysisPolicyNotice /><PolicyLinks /></footer></>;
}
