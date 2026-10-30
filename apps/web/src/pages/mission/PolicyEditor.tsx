import { useShell } from '../../store/shell';
import { riskModeLabel } from '../../copy/shell';
import { MISSION_LABELS as L, MISSION_TEXT as T } from '../../copy/mission';
import { useEffect, useState } from 'react';
import type { Agent, Flags, Policy } from '@eko/shared';
import { ApiError } from '../../lib/api';
import { loadPolicy, policyDiff, policyErrors, savePolicy, type PresetsResponse } from '../../lib/mission';
import type { z } from 'zod';
import { Seg } from '../../components/ui';
import { IconInfo } from '../../components/icons';
import { APPROVAL_UNAVAILABLE } from '../../copy';
import { MISSION_COPY as C, POLICY_FIELDS } from '../../copy/mission';
import { guardLine, MissionDialog, money } from './parts';

export function PolicyDiff({ saved, draft }: { saved: Policy; draft: Policy }) {
  return <dl className="mc-policy-diff">{policyDiff(saved, draft).map(({ field, before, after }) => <div key={field}><dt>{field}</dt><dd><del>{JSON.stringify(before) ?? L.unset}</del> → <ins>{JSON.stringify(after) ?? L.unset}</ins></dd></div>)}</dl>;
}
// TODO(spec): §3.14 offers presets at T, but BACKEND §21.4 gates policy PUT
// with policy_editor. At T the picker previews values; persistence is D0.
export default function PolicyEditor({ agent, policy, presets, flags, onSaved }: { agent: Agent; policy: Policy; presets: z.infer<typeof PresetsResponse>; flags: Partial<Flags>; onSaved: (p: Policy) => void }) {
  const blueChipEnabled=!!useShell(s=>s.config?.blueChip);
  const [saved, setSaved] = useState(policy), [draft, setDraft] = useState(policy), [confirm, setConfirm] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const changed = policyDiff(saved, draft), errors = policyErrors(draft);
  // A realtime refresh must not discard a draft. Its original version still goes
  // into PUT, so a concurrent edit produces the specified diff/reload conflict.
  useEffect(() => {
    if (policy.version !== saved.version && !policyDiff(saved, draft).length) { setSaved(policy); setDraft(policy); }
  }, [policy, saved, draft]);
  const preset = presets.find((p) => policyDiff({ ...p.policy, version: draft.version, killed: draft.killed }, draft).length === 0)?.name ?? (changed.length ? L.custom : draft.mode[0].toUpperCase() + draft.mode.slice(1));
  const set = (key: keyof Policy, value: unknown) => { setDraft((p) => ({ ...p, [key]: value })); setMessage(''); };
  const save = async () => {
    if (busy || errors.length) return; setBusy(true);
    try { const p = await savePolicy(agent.id, { ...draft, version: saved.version }); setSaved(p); setDraft(p); onSaved(p); setMessage(T.saved(p.version)); setConfirm(false); }
    catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        try { const p = await loadPolicy(agent.id); setSaved(p); setDraft(p); onSaved(p); setConfirm(false); } catch (reload) { setMessage((reload as Error).message); }
        setMessage(L.policyChangedElsewhereReviewAndSaveAgain);
      } else setMessage((e as Error).message);
    } finally { setBusy(false); }
  };
  return <div className="mc-policy"><div className="mc-policy-main">
    <div className="mc-banner"><IconInfo /><p>{guardLine(agent)}</p></div>
    <section className="panel"><div className="panel-head"><h3>{L.preset2}</h3><span className="tag">{riskModeLabel(preset)}</span></div><div className="panel-body mc-preset"><Seg options={presets.map((p) => ({ value: p.name, label: riskModeLabel(p.name) }))} value={preset} label={L.policyPreset} onChange={(name) => { const p = presets.find((p) => p.name === name); if (p) { setDraft({ ...p.policy, killed: saved.killed, version: saved.version }); setMessage(''); } }} /><p>{flags.policy_editor ? L.fillsTheFieldsBelowReviewChangesBefore : C.previewPreset}</p></div></section>
    {flags.policy_editor && <>{[L.sizeAndLoss, L.coinChecks, L.assetsAndTiming].map((group) => <section className="panel" key={group}><div className="panel-head"><h3>{group}</h3></div><div className="panel-body mc-fields">{POLICY_FIELDS.filter((f) => f.group === group).map((f) => <div className="mc-field" key={f.key}><div className="mc-field-l"><label htmlFor={`pol-${f.key}`}>{f.label}</label><p>{f.hint}</p></div><div className="mc-field-r"><div className={`mc-in${errors.includes(f.key) ? ' bad' : ''}`}>{f.unit === '$' && <span>$</span>}<input id={`pol-${f.key}`} className="input num" type="number" step="any" inputMode="decimal" value={draft[f.key] ?? ''} aria-invalid={errors.includes(f.key)} onChange={(e) => set(f.key, e.target.value === '' ? undefined : Number(e.target.value))} />{f.unit !== '$' && <span>{f.unit}</span>}</div>{errors.includes(f.key) && <span className="mc-err">{L.enterANonnegativeNumber}{f.unit === '%' ? ' up to 100%' : ''}.</span>}{f.key === 'approvalAboveUsd' && !flags.approvals && <span className="mc-warnline">{APPROVAL_UNAVAILABLE}</span>}</div></div>)}
    {group === L.coinChecks && blueChipEnabled && <label><input type="checkbox" checked={draft.blueChipsOnly ?? false} onChange={e=>set('blueChipsOnly',e.target.checked)} /> Blue chips only</label>}
    {group === L.coinChecks && <div className="mc-field"><label htmlFor="pol-block">{L.blockedVerdicts}</label><select id="pol-block" className="select" value={draft.blockPlaybookLevel ?? 'none'} onChange={(e) => set('blockPlaybookLevel', e.target.value === 'none' ? null : e.target.value)}><option value="danger">{L.danger}</option><option value="monitor">{L.monitorAndDanger}</option><option value="none">{L.none}</option></select></div>}
    {group === L.assetsAndTiming && (['allowAssets', 'blockAssets'] as const).map((key) => <div className="mc-field" key={key}><label htmlFor={`pol-${key}`}>{key === 'allowAssets' ? L.allowedAssets : L.blockedAssets}</label><div><input id={`pol-${key}`} className="input" value={(draft[key] ?? []).join(', ')} placeholder={L.commaSeparatedAssets} onChange={(e) => set(key, e.target.value.split(',').map((v) => v.trim()).filter(Boolean))} /><div className="mc-chips">{draft[key]?.map((asset) => <span className="tag" key={asset}>{asset}</span>)}</div></div></div>)}
    </div></section>)}{changed.length > 0 && <div className="mc-savebar" aria-label={L.unsavedPolicyChanges}><span><b>{changed.length} {L.unsavedChanges}</b> {L.savesAsV}{saved.version + 1}</span><button className="btn btn-ghost" onClick={() => setDraft(saved)}>{L.discard}</button><button className="btn btn-primary" disabled={errors.length > 0} onClick={() => setConfirm(true)}>{L.savePolicy}</button></div>}</>}
    {message && <p role="status">{message}</p>}
  </div><aside className="mc-policy-aside"><section className="panel"><div className="panel-head"><h3>{L.whatPreflightChecks}</h3><span className="num">{L.v}{saved.version}{changed.length ? ' → draft' : ''}</span></div><div className="panel-body"><pre className="mc-code" aria-label={L.policySummary}>{JSON.stringify(draft, null, 2)}</pre><dl className="kv"><dt>{L.largestOrder}</dt><dd>{draft.maxPositionUsd === undefined ? L.unset : money(draft.maxPositionUsd)}</dd></dl><p className="note">{L.preflightAnswersAgainstYourPolicyAndJournals}</p></div></section></aside>
  {confirm && flags.policy_editor && <MissionDialog title={L.reviewPolicyChanges} close={busy ? () => {} : () => setConfirm(false)} footer={<><button className="btn btn-ghost" disabled={busy} onClick={() => setConfirm(false)}>{L.back}</button><button className="btn btn-primary" disabled={busy || errors.length > 0} onClick={() => void save()}>{busy ? L.saving : L.confirmSave}</button></>}><PolicyDiff saved={saved} draft={draft} /><p>{guardLine(agent)}</p>{message && <p role="alert">{message}</p>}</MissionDialog>}
  </div>;
}
