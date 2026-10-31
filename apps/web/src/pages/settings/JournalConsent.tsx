import { useEffect, useState } from 'react';
import { journalConsent, setJournalConsent } from '../../lib/settings';
import { useApp } from '../../store/app';
import { SETTINGS_COPY as C } from '../../copy/settings';

/** The owner's explicit journal opt-in. Never inferred from agent calls; agents are told to ask for it. */
export function JournalConsentSetting({ owner }: { owner: string }) {
  const [optedIn, setOptedIn] = useState<boolean | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    journalConsent(abort.signal).then(r => setOptedIn(r.optedIn)).catch(() => { if (!abort.signal.aborted) setError(true); });
    return () => abort.abort();
  }, [owner]);
  const change = (next: boolean) => {
    if (busy || optedIn === null || useApp.getState().account?.id !== owner) return;
    setBusy(true); setError(false);
    void setJournalConsent(next).then(r => { if (useApp.getState().account?.id === owner) setOptedIn(r.optedIn); })
      .catch(() => setError(true)).finally(() => setBusy(false));
  };
  return <div className="panel panel-body journal-consent">
    <h3>{C.journalTitle}</h3><p>{C.journalNote}</p>
    <label><input type="checkbox" checked={optedIn === true} disabled={busy || optedIn === null}
      onChange={e => change(e.target.checked)} /> {C.journalToggle}</label>
    <p className="note" role="status">{optedIn === null ? error ? '' : C.journalLoading : optedIn ? C.journalOn : C.journalOff}</p>
    {error && <p role="alert">{C.journalError}</p>}
  </div>;
}
