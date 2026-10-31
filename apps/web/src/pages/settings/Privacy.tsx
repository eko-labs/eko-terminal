import { useState } from 'react';
import { deleteHarnessData } from '../../lib/settings';
import { useApp } from '../../store/app';
import { DEFAULT_PREFERENCES } from '@eko/shared';
import { SETTINGS_COPY as C } from '../../copy/settings';

export function PrivacySettings({ owner }: { owner: string }) {
  const [confirming, setConfirming] = useState(false), [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false), [deletedAt, setDeletedAt] = useState<string | null>(null), [error, setError] = useState(false);
  return <div className="panel panel-body">
    <h3>{C.sharing}</h3><p>{C.sharingUnavailable}</p>
    {/* TODO(spec): CA-10 has no default journal-sharing field or endpoint. Keep the setting unavailable rather than equating it with journal recording consent. */}
    <h3>{C.deleteTitle}</h3><p>{C.deleteNote}</p>
    {deletedAt ? <p role="status">{C.deleted} <time dateTime={deletedAt}>{deletedAt}</time></p> : confirming ? <form aria-label={C.deleteTitle} onSubmit={e => {
      e.preventDefault(); if (busy || confirmation !== C.deleteWord || useApp.getState().account?.id !== owner) return;
      setBusy(true); setError(false);
      void deleteHarnessData(confirmation).then(result => {
        if (useApp.getState().account?.id !== owner) return;
        setDeletedAt(result.deletedAt); setConfirmation('');
        useApp.setState({ preferences: DEFAULT_PREFERENCES });
        void useApp.getState().refreshSession().catch(() => undefined);
      }).catch(() => setError(true)).finally(() => setBusy(false));
    }}><label>{C.deletePrompt}<input className="input" autoComplete="off" value={confirmation} disabled={busy} onChange={e => setConfirmation(e.target.value)} /></label><div className="settings-links"><button className="btn" type="button" disabled={busy} onClick={() => { setConfirming(false); setConfirmation(''); setError(false); }}>{C.cancel}</button><button className="btn danger" type="submit" disabled={busy || confirmation !== C.deleteWord}>{busy ? C.deleting : C.deleteTitle}</button></div>{error && <p role="alert">{C.deleteError}</p>}</form> : <button className="btn danger" onClick={() => setConfirming(true)}>{C.deleteTitle}</button>}
  </div>;
}
