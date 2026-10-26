import { useEffect, useState, type FormEvent } from 'react';
import { z } from 'zod';
import { AlertSettingsSchema, type AlertSettings } from '@eko/shared';
import { fetchParsed } from '../lib/api';
import { useWatch } from '../store/watch';
import { useShell } from '../store/shell';
import { ConnectWatch } from './WatchButton';
import '../pages/terminal/watch.css';

export const TelegramLinkSchema = z.object({ url: z.string().url().refine(value => {
  const url = new URL(value);
  return url.protocol === 'https:' && url.hostname === 't.me' && !url.username && !url.password && !url.port && /^\/[A-Za-z0-9_]+$/.test(url.pathname) && !!url.searchParams.get('start');
}), expiresAt: z.string().datetime() });
export function NotificationSettings() {
  const owner = useWatch(s => s.owner), settings = useWatch(s => s.settings), saving = useWatch(s => s.saving), loading = useWatch(s => s.loading), error = useWatch(s => s.error), crews = useShell(s => !!s.config?.flags.rug_ring_radar);
  if (!owner) return <ConnectWatch />;
  if (!settings) return error ? <p role="alert">{error} <button className="btn" onClick={() => void useWatch.getState().refresh().catch(() => {})}>Retry</button></p> : <p role="status">{loading ? 'Loading notification settings…' : 'Notification settings are unavailable.'}</p>;
  return <NotificationForm key={owner} initial={settings} crews={crews} saving={saving} save={async draft => { await useWatch.getState().save(draft); }} />;
}
export function NotificationForm({ initial, crews, saving, save }: { initial: AlertSettings; crews: boolean; saving: boolean; save: (draft: AlertSettings) => Promise<void> }) {
  const [draft, setDraft] = useState(initial), [message, setMessage] = useState<string | null>(null);
  const [link, setLink] = useState<z.infer<typeof TelegramLinkSchema> | null>(null), [linking, setLinking] = useState(false), [linkError, setLinkError] = useState(false);
  const [unlinkMessage, setUnlinkMessage] = useState<string | null>(null);
  useEffect(() => { if (!link) return; const timer = setTimeout(() => setLink(null), Math.max(0, Date.parse(link.expiresAt) - Date.now())); return () => clearTimeout(timer); }, [link]);
  const kind = (value: AlertSettings['kinds'][number], enabled: boolean) => setDraft(s => ({ ...s, kinds: enabled ? [...new Set([...s.kinds, value])] : s.kinds.filter(k => k !== value) }));
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setMessage(null);
    const parsed = AlertSettingsSchema.safeParse(draft);
    if (!parsed.success) { setMessage('Enter a valid threshold and UTC hours between 0 and 23.'); return; }
    try { await save(parsed.data); setMessage('Notification settings saved.'); }
    catch { setMessage('Could not save notification settings. Your changes are still here.'); }
  };
  return <div className="watch-settings"><form onSubmit={e => void submit(e)} aria-label="Notification settings"><fieldset disabled={saving}>
    <legend>Alert thresholds</legend>
    <label><input type="checkbox" checked={draft.kinds.includes('verdict_change')} onChange={e => kind('verdict_change', e.target.checked)} /> Verdict changes</label>
    <label><input type="checkbox" checked={draft.kinds.includes('playbook')} onChange={e => kind('playbook', e.target.checked)} /> Playbook alerts</label>
    {crews && <label><input type="checkbox" checked={draft.kinds.includes('crew_active')} onChange={e => kind('crew_active', e.target.checked)} /> Crew active</label>}
    <label>Minimum verdict level <select className="input" value={draft.minLevel} onChange={e => setDraft(s => ({ ...s, minLevel: e.target.value as AlertSettings['minLevel'] }))}>{['clear','info','monitor','danger','pending'].map(level => <option key={level} value={level}>{level === 'pending' ? 'Not fully checked' : level[0].toUpperCase() + level.slice(1)}</option>)}</select></label>
    <label>Agent trades above USD <input className="input" type="number" min="0" step="any" placeholder="Off" value={draft.agentTradeAboveUsd ?? ''} onChange={e => setDraft(s => ({ ...s, agentTradeAboveUsd: e.target.value === '' ? undefined : e.target.valueAsNumber }))} /></label>
    <p className="muted">Declared or likely agent trades on watched coins. Leave blank to turn this alert off.</p>
    <label><input type="checkbox" checked={!!draft.quietHoursUtc} onChange={e => setDraft(s => ({ ...s, quietHoursUtc: e.target.checked ? [22, 7] : undefined }))} /> Quiet hours (UTC)</label>
    {draft.quietHoursUtc && <div className="watch-inline">{['Start hour UTC', 'End hour UTC'].map((name, i) => <label key={name}>{name}<input className="input" type="number" min="0" max="23" step="1" value={Number.isFinite(draft.quietHoursUtc![i]) ? draft.quietHoursUtc![i] : ''} onChange={e => setDraft(s => ({ ...s, quietHoursUtc: i === 0 ? [e.target.valueAsNumber, s.quietHoursUtc![1]] : [s.quietHoursUtc![0], e.target.valueAsNumber] }))} /></label>)}</div>}
    <label><input type="checkbox" checked={draft.telegram} onChange={e => setDraft(s => ({ ...s, telegram: e.target.checked }))} /> Telegram notifications</label>
    <button className="btn" type="submit">{saving ? 'Saving…' : 'Save notifications'}</button>
  </fieldset>{message && <p role="status">{message}</p>}</form>
  <section className="panel panel-body"><h3>Telegram</h3><p>Link your Telegram account in a direct message. Telegram only notifies; open EKO to review an alert.</p>
    <button className="btn" disabled={linking} onClick={() => {
      setLinking(true); setLinkError(false); setLink(null); setUnlinkMessage(null);
      void fetchParsed('/telegram/link', TelegramLinkSchema, { method: 'POST' }).then(result => { if (Date.parse(result.expiresAt) <= Date.now()) throw new Error('Expired link'); setLink(result); }).catch(() => setLinkError(true)).finally(() => setLinking(false));
    }}>{linking ? 'Creating link…' : 'Link Telegram'}</button>
    <button className="btn" disabled={linking} onClick={() => {
      setLinking(true); setLinkError(false); setLink(null); setUnlinkMessage(null);
      void fetchParsed('/telegram/link', z.object({ ok: z.literal(true) }), { method: 'DELETE' })
        .then(() => setUnlinkMessage('Telegram unlinked. Pending notifications cancelled.'))
        .catch(() => setUnlinkMessage('Could not unlink Telegram. Try again.')).finally(() => setLinking(false));
    }}>Unlink Telegram</button>
    {unlinkMessage && <p role="status">{unlinkMessage}</p>}
    {link && <p><a className="btn" href={link.url} target="_blank" rel="noreferrer">Open Telegram</a> <span className="muted">Expires {new Date(link.expiresAt).toISOString().slice(11,19)} UTC</span></p>}
    {linkError && <p role="alert">Telegram linking is unavailable. Try again later.</p>}
  </section>
  {/* TODO(spec): Web push follows the D0 approvals flag (§21.4), but production subscription routes/readiness are not implemented here. Keep push unavailable until that dependency is accepted. */}
  </div>;
}
