import { useEffect, useRef, useState } from 'react';
import { SCAN_COPY as C } from '../../copy/scan';
import { navigate } from '../../lib/router';
export function ScanInput({ examples = [] }: { examples?: string[] }) {
  const [query, setQuery] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  async function submit(value: string) {
    if (active.current) return;
    const ac = new AbortController(); active.current = ac; setBusy(true); setError('');
    try { const { submitScan, validScanQuery } = await import('./scanModel'); if (!validScanQuery(value)) { setError(C.invalid); return; } const result = await submitScan(value, ac.signal); if (!ac.signal.aborted) navigate(`/scan/${encodeURIComponent(result.id)}`); }
    catch { if (!ac.signal.aborted) setError(C.submitError); }
    finally { if (!ac.signal.aborted) { active.current = null; setBusy(false); } }
  }
  return <div className="scan-input"><form data-tour="scan" onSubmit={e => { e.preventDefault(); void submit(query); }}>
    <label htmlFor="landing-scan">{C.prompt}</label><div className="scan-input-row"><input id="landing-scan" value={query} onChange={e => { setQuery(e.target.value); setError(''); }}
      enterKeyHint="go" autoComplete="off" spellCheck={false} maxLength={42} aria-invalid={!!error} aria-describedby={error ? 'scan-input-error' : undefined} disabled={busy} />
      <button className="btn btn-primary" disabled={busy || !query.trim()}>{busy ? C.pending : C.submit}</button></div>
    {error && <p id="scan-input-error" role="alert">{error}</p>}
  </form><div className="scan-examples">{examples.length ? examples.slice(0, 3).map(address => <button className="btn btn-sm" key={address} disabled={busy} title={address} onClick={() => { setQuery(address); void submit(address); }}>{address.slice(0, 6)}…{address.slice(-4)}</button>) : <span className="muted">{C.scope}</span>}</div></div>;
}
