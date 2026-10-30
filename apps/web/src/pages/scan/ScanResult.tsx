import { useEffect, useRef, useState } from 'react';
import type { ScanResult as Result, CoinCard } from '@eko/shared';
import { GuardCompact } from '../../components/GuardCompact';
import { AnalysisPolicyNotice } from '../../components/PolicyLinks';
import { UntrustedText } from '../../components/ui';
import { SCAN_COPY as C } from '../../copy/scan';
import { missingChecks } from '../../copy/availability';
import { Link } from '../../lib/Link';
import { navigate } from '../../lib/router';
import { track } from '../../lib/telemetry';
import { CoinVerdict } from '../terminal/CoinCard';
import { GuardCard } from '../terminal/GuardCard';
import { FlowBar } from '../terminal/FlowBar';
import { exitText } from '../terminal/radarModel';
import { ScanInput } from './ScanInput';
import { pollScan, shareLinks, submissionFor, submitScan, takeScanTiming, type ScanView } from './scanModel';
import './scan.css';
import '../terminal/coin.css';
import '../terminal/radar.css';
import { useOnboarding } from '../../store/onboarding';
import { age } from '../terminal/radarModel';

function Candidates({ result }: { result: Result }) {
  const active = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(false);
  useEffect(() => () => active.current?.abort(), []);
  async function select(address: string) {
    if (active.current) return;
    const ac = new AbortController(); active.current = ac; setBusy(true); setError(false);
    try { const scan = await submitScan(address, ac.signal); if (!ac.signal.aborted) navigate(`/scan/${encodeURIComponent(scan.id)}`); }
    catch { if (!ac.signal.aborted) setError(true); }
    finally { if (!ac.signal.aborted) { active.current = null; setBusy(false); } }
  }
  return <><h2>{C.ambiguous}</h2>{error && <p role="alert">{C.submitError}</p>}<ul className="scan-candidates">{result.candidates?.map(candidate => <li key={candidate.address}>
    <button className="btn" disabled={busy} onClick={() => void select(candidate.address)}><UntrustedText value={candidate.symbol} /> · <UntrustedText value={candidate.name} /></button>
    <p className="scan-address">{candidate.address}</p><p>{candidate.ageSec > 0 ? age(candidate.ageSec) : C.ageUnavailable} · {candidate.launchpad}</p>
  </li>)}</ul></>;
}

function Share({ id }: { id: string }) {
  const [status, setStatus] = useState('');
  const links = shareLinks(id, typeof location === 'undefined' ? 'https://example.invalid' : location.origin);
  return <details className="scan-share"><summary className="btn">{C.share}</summary><div><button className="btn" onClick={async () => {
    try { await navigator.clipboard.writeText(links.url); setStatus(C.copied); } catch { setStatus(C.copyFailed); }
  }}>{C.copy}</button> <a className="btn" href={links.x} target="_blank" rel="noopener noreferrer">X</a> <a className="btn" href={links.telegram} target="_blank" rel="noopener noreferrer">Telegram</a>
    <input aria-label={C.share} readOnly value={links.url} onFocus={e => e.target.select()} /><p role="status">{status}</p></div></details>;
}
function LegacyCosts({ card }: { card: CoinCard }) {
  const section = card.meta?.tradeability;
  return <section className="panel scan-costs"><h2>{C.costs}</h2><dl>{(['usd100', 'usd1k', 'usd10k'] as const).map((size, i) =>
    <div key={size}><dt>{['$100', '$1K', '$10K'][i]}</dt><dd>{section?.unavailable || section?.missing?.some(field => ['exitCosts', 'exitCostPct', `exitCostPct.${size}`, size].includes(field)) ? C.notChecked : exitText(card.tradeability.exitCostPct[size])}</dd></div>)}</dl></section>;
}
export function ScanResultCard({ result }: { result: Result }) {
  const card = result.card, guard = result.guardCard;
  useEffect(() => { if (card || guard) useOnboarding.getState().scanRendered(); }, [card, guard]);
  const address = guard?.identity.address ?? card?.identity.address;
  return <div data-tour="coin-card" onClickCapture={e => {
    const target = (e.target as HTMLElement).closest('summary')?.parentElement;
    if (target?.classList.contains('ev')) useOnboarding.getState().markStep('open_evidence');
  }}>{address && <><h2>$<UntrustedText value={(guard ?? card)!.identity.symbol} /></h2><p className="scan-address">{address}</p><nav className="scan-actions" aria-label={C.result}>
    <Link className="btn btn-primary" to={`/coin/${address}`}>{C.openCoin}</Link><Link className="btn" to="/bags">{C.bags}</Link><Share id={result.id} /></nav></>}
    {card && guard?.verdict?.mode !== 'active' && <><CoinVerdict verdict={card.verdict} meta={card.meta} /><LegacyCosts card={card} /><section className="panel scan-costs"><h2>{C.flow}</h2>
      <FlowBar flow={card.flow} unavailable={card.meta?.flow?.unavailable || !!card.meta?.flow?.missing?.length} legend /></section>
      {!!Object.values(card.meta ?? {}).some(section => section.unavailable || section.missing?.length) && <p className="scan-gaps">{missingChecks(card.verdict.evaluatedPlaybooks, card.meta)}</p>}
      <Link onClick={() => useOnboarding.getState().markStep('open_evidence')} className="btn" to={`/receipt/${encodeURIComponent(card.verdict.receipt.id)}`}>{C.receipt}</Link></>}
    {guard && <><div data-tour="verdict"><GuardCompact verdict={{ version: 2, assessment: guard.verdict }} /></div><GuardCard card={guard} /></>}
    {!card && !guard && <p role="status">{C.unavailable}</p>}
    <AnalysisPolicyNotice /></div>;
}
export function ScanState({ view, retry }: { view: ScanView; retry: () => void }) {
  const result = view.result;
  const snapshotAge = result?.guardCard?.verdict ? Math.max(0, Date.now() / 1000 - Number(result.guardCard.verdict.cursor.timestampSec)) : result?.card ? result.card.freshness.ageSec + Math.max(0, Date.now() - view.receivedAt) / 1000 : 0;
  return <>{result?.status === 'ready' && snapshotAge > 30 && <p className="scan-stale" role="status">{C.stale} · {Math.floor(snapshotAge)} s <button className="btn" onClick={retry}>{C.retry}</button></p>}
    {(view.error || view.timedOut) && <p role="status">{result?.status === 'ready' ? C.refreshFailed : view.timedOut ? C.waiting : C.error} <button className="btn" onClick={retry}>{C.retry}</button></p>}
    {!result && !view.error && !view.timedOut && <div className="skel" aria-label={C.pending} style={{ height: 180 }} />}
    {result?.status === 'pending' && <p role="status" aria-busy={!view.timedOut}>{C.pending}</p>}
    {result?.status === 'not_found' && <><p role="status">{C.notFound}</p><ScanInput /></>}
    {result?.status === 'ambiguous' && <Candidates result={result} />}
    {result?.status === 'ready' && <ScanResultCard result={result} />}</>;
}
function PersistedScan({ id }: { id: string }) {
  const [view, setView] = useState<ScanView>(() => ({ result: submissionFor(id)?.result ?? null, error: false, timedOut: false, receivedAt: Date.now() }));
  const [retry, setRetry] = useState(0), [, tick] = useState(0);
  useEffect(() => pollScan(id, setView, view.result), [id, retry]);
  useEffect(() => { const timer = setInterval(() => tick(n => n + 1), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    if (!view.result || view.result.status !== 'ready') return;
    const frame = requestAnimationFrame(() => { const sample = takeScanTiming(id, view.result!); if (sample) track(sample.metric, sample.value); });
    return () => cancelAnimationFrame(frame);
  }, [id, view.result]);
  return <ScanState view={view} retry={() => setRetry(n => n + 1)} />;
}
export default function ScanResult({ params }: { params: Record<string, string> }) {
  return <div className="scan-page"><div className="scan-section-head"><h1>{C.result}</h1><Link to="/">{C.scanAgain}</Link></div><PersistedScan key={params.id} id={params.id} /></div>;
}
