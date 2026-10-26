import { useCallback, useEffect, useState } from 'react';
import { GhostReportListSchema, ghostReportFindings, ghostReportShare, formatGuardReason,
  GUARD_CHECK_LABELS, DYOR, NON_AFFILIATION, type GhostReportRecord } from '@eko/shared';
import { fetchParsed, isRateLimited, MOCKS } from '../lib/api';
import { Link } from '../lib/Link';

export function GhostReportView({ record }: { record: GhostReportRecord }) {
  const d = record.draft;
  return <article className="panel" aria-label="Reviewed Ghost Report">
    <div className="panel-head"><b>Ghost Report</b><span>{record.status === 'verified' ? 'Facts verified' : record.status === 'correction_needed' ? 'Correction required' : 'Facts reviewed · partial evidence'}</span></div>
    <div className="panel-body">
      {d.preRelease && <p>From our pre-release engine</p>}
      <p><Link to={`/coin/${d.assessment.coin}`}>Contract: {d.assessment.coin}</Link> · block {d.assessment.cursor.blockNumber} · rules {d.assessment.rulesVersion}</p>
      <ul>{ghostReportFindings(d).slice(0, 3).map((reason, index) => <li key={index}>{formatGuardReason(reason)}</li>)}</ul>
      {d.assessment.completeness.missing.length > 0 && <p>Not fully checked: {d.assessment.completeness.missing.map(id => GUARD_CHECK_LABELS[id]).join(', ')}</p>}
      {!record.receiptAnchored && <p>Receipt anchor verification pending</p>}
      {record.assessmentChanged && <p>Guard assessment updated; this report retains its original snapshot.</p>}
      <Link to={`/receipt/${d.assessment.receipt.id}`}>Verify receipt</Link>
      {d.supersedes && <p><a href={`/v2/ghost-reports/${d.supersedes}`}>Prior report</a></p>}
      {record.corrections.map(id => <p key={id}><a href={`/v2/ghost-reports/${id}`}>Reviewed correction</a></p>)}
      <details><summary>All reasons, coverage, evidence and corrections</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{ghostReportShare(record)}</pre></details>
      <p className="note">{DYOR}<br />{NON_AFFILIATION}</p>
    </div>
  </article>;
}

/** Reviewed public records only. An empty response never generates demo findings. */
export function GhostReports({ limit = 50, coins }: { limit?: number; coins?: string[] }) {
  const [records, setRecords] = useState<GhostReportRecord[]>([]), [failed, setFailed] = useState(false);
  const load = useCallback(async (signal?: AbortSignal) => {
    if (MOCKS) return;
    try {
      const data = await fetchParsed('/v2/ghost-reports', GhostReportListSchema, { signal });
      if (!signal?.aborted) { setRecords(data.records); setFailed(false); }
    } catch (error) { if ((error as Error).name !== 'AbortError' && !isRateLimited(error)) setFailed(true); }
  }, []);
  useEffect(() => { const ac = new AbortController(); void load(ac.signal); return () => ac.abort(); }, [load]);
  const shown = records.filter(r => !coins || coins.includes(r.draft.assessment.coin)).slice(0, limit);
  if (failed) return <p role="status">Ghost Report evidence unavailable. <button className="btn btn-sm" onClick={() => void load()}>Retry</button></p>;
  if (!shown.length) return null;
  return <section aria-label="Ghost Reports">{shown.map(record => <GhostReportView key={record.draft.id} record={record} />)}<button className="btn btn-sm" onClick={() => void load()}>Refresh reports</button></section>;
}
