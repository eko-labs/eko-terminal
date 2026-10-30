import { version } from '../../package.json';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { DEFAULT_PREFERENCES, PreferencesSchema, type Preferences } from '@eko/shared';
import { NotificationSettings } from '../components/NotificationSettings';
import { InstallSettings } from '../components/Pwa';
import { IconClose, IconPlus } from '../components/icons';
import { Link } from '../lib/Link';
import { navigate } from '../lib/router';
import { useApp } from '../store/app';
import { useUi } from '../store/ui';
import { useOnboarding } from '../store/onboarding';
import { ADVISORY, BUILT_ON, NON_AFFILIATION } from '../copy';
import { SETTINGS_COPY as C } from '../copy/settings';
import { useSettingsSession } from '../lib/settings';
import { PrivacySettings } from './settings/Privacy';
import { JournalConsentSetting } from './settings/JournalConsent';
import { PlanStatus, FeeDisclosure } from './settings/Plan';
import './settings/settings.css';

export function Settings() {
  const { identity, owner, address, chainId } = useSettingsSession();
  const [signingOut, setSigningOut] = useState(false), [logoutError, setLogoutError] = useState(false);
  return <div className="shell-page settings-page"><header className="page-head"><h1>{C.title}</h1><p>{C.subtitle}</p></header>
    <nav className="settings-links" aria-label={C.sections}>{(['trading', 'wallet', 'notifications', 'plan', 'display', 'privacy', 'about'] as const).map(section => <a key={section} href={`#set-${section}`}>{C[section]}</a>)}</nav>
    <Section id="trading" title={C.trading}>{identity ? <PresetsForm key={identity} /> : <SettingsConnect />}<FeeDisclosure /><p className="note">{ADVISORY}</p></Section>
    <Section id="wallet" title={C.wallet}><div className="panel panel-body"><p>{owner ? C.verified : C.unverified}</p>{address && <p className="addr">{address}</p>}<p>{C.chain} {chainId ?? '—'}</p><button className="btn" onClick={openSettingsWallet}>{owner ? C.manageWallet : C.connect}</button>{owner && <button className="btn" disabled={signingOut} onClick={() => {
      setSigningOut(true); setLogoutError(false);
      void useApp.getState().signOut().catch(() => setLogoutError(true)).finally(() => setSigningOut(false));
    }}>{signingOut ? C.signingOut : C.signOut}</button>}{logoutError && <p role="alert">{C.logoutError}</p>}</div></Section>
    <Section id="notifications" title={C.notifications}>{owner ? <NotificationSettings key={owner} /> : <SettingsConnect />}</Section>
    <Section id="plan" title={C.plan}><div className="panel panel-body"><PlanStatus /><Link className="btn" to="/settings/plan">{C.viewPlan}</Link></div></Section>
    <Section id="display" title={C.display}><Display /><InstallSettings /></Section>
    <Section id="privacy" title={C.privacy}>{owner ? <><JournalConsentSetting key={`journal-${owner}`} owner={owner} /><PrivacySettings key={owner} owner={owner} /></> : <SettingsConnect />}</Section>
    <Section id="about" title={C.about}><div className="panel panel-body"><button className="btn" onClick={() => { navigate('/radar'); useOnboarding.getState().startTour(); }}>{C.replayTour}</button><p>{C.version} {version}</p><div className="settings-links">{['terms', 'privacy', 'risk', 'ai'].map(doc => <Link key={doc} to={`/legal/${doc}`}>{C.legal[doc as keyof typeof C.legal]}</Link>)}</div><p>{BUILT_ON}</p><p>{NON_AFFILIATION}</p></div></Section>
  </div>;
}
export function openSettingsWallet() { window.dispatchEvent(new Event('eko:open-wallet')); }
export function SettingsConnect() { return <div className="connect-card"><p>{C.connectNote}</p><button className="btn" onClick={openSettingsWallet}>{C.connect}</button></div>; }
function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) { return <section className="section settings-section" id={`set-${id}`} aria-labelledby={`set-${id}-title`}><h2 className="section-title" id={`set-${id}-title`}>{title}</h2>{children}</section>; }

function Display() {
  const density = useUi(s => s.density), reducedMotion = useUi(s => s.reducedMotion), humanMarkers = useUi(s => s.humanMarkers);
  return <div className="panel set-form"><SettingRow title={C.density} desc={C.deviceOnly}><select className="input" aria-label={C.density} value={density} onChange={e => useUi.getState().set({ density: e.target.value as typeof density })}><option value="comfortable">{C.comfortable}</option><option value="compact">{C.compact}</option></select></SettingRow>
    <SettingRow title={C.motion} desc={C.deviceOnly}><select className="input" aria-label={C.motion} value={reducedMotion} onChange={e => useUi.getState().set({ reducedMotion: e.target.value as typeof reducedMotion })}>{(['system', 'on', 'off'] as const).map(value => <option key={value} value={value}>{C.motionOptions[value]}</option>)}</select></SettingRow>
    <SettingRow title={C.humanMarkers} desc={C.deviceOnly}><input type="checkbox" aria-label={C.humanMarkers} checked={humanMarkers} onChange={e => useUi.getState().set({ humanMarkers: e.target.checked })} /></SettingRow></div>;
}
function SettingRow({ title, desc, error, children }: { title: string; desc: string; error?: string; children: ReactNode }) {
  return <div className={`set-row ${error ? 'has-error' : ''}`}><div className="set-row-label"><strong>{title}</strong><p>{desc}</p></div><div className="set-row-control">{children}{error && <span className="lx-err" role="alert">{error}</span>}</div></div>;
}

type FieldErrors = Partial<Record<keyof Preferences, string>>;

function validate(p: Preferences): FieldErrors {
  const e: FieldErrors = {};
  const list = (k: keyof Preferences, xs: number[], min: number, max: number, lo: number, hi: number, int: boolean, what: string) => {
    if (xs.length < min || xs.length > max) e[k] = C.listLength(min, max);
    else if (xs.some((x) => !Number.isFinite(x) || x < lo || x > hi || (int && !Number.isInteger(x)))) e[k] = what;
  };
  list('quickAmounts', p.quickAmounts, 1, 6, 0.01, 1e9, false, C.invalidAmount);
  list('quickSellPercents', p.quickSellPercents, 1, 6, 1, 100, false, C.invalidPercent);
  list('slippagePresetsBps', p.slippagePresetsBps, 1, 5, 1, 500, true, C.invalidBps);
  if (!Number.isInteger(p.defaultSlippageBps) || p.defaultSlippageBps < 1 || p.defaultSlippageBps > 500) e.defaultSlippageBps = C.invalidBps;
  if (!Number.isFinite(p.confirmLargeTradeUsd) || p.confirmLargeTradeUsd <= 0) e.confirmLargeTradeUsd = C.positive;
  return e;
}

const sortNums = (xs: number[]) => [...xs].sort((a, b) => a - b);

function PresetsForm() {
  const prefs = useApp((s) => s.preferences);
  const setPreferences = useApp((s) => s.setPreferences);
  const toast = useApp((s) => s.toast);
  const [draft, setDraft] = useState<Preferences>(prefs);
  const [saving, setSaving] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(prefs);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    if (!dirtyRef.current) setDraft(prefs);
  }, [prefs]);

  const errs = validate(draft);
  const invalid = Object.keys(errs).length > 0;
  const set = <K extends keyof Preferences>(k: K, v: Preferences[K]) => setDraft((d) => ({ ...d, [k]: v }));

  const save = async () => {
    if (invalid) return;
    const next: Preferences = {
      ...draft,
      quickAmounts: sortNums(draft.quickAmounts),
      quickSellPercents: sortNums(draft.quickSellPercents),
      slippagePresetsBps: sortNums(draft.slippagePresetsBps),
    };
    const parsed = PreferencesSchema.safeParse(next);
    if (!parsed.success) {
      toast({ kind: 'error', title: C.notSaved, body: parsed.error.issues[0]?.message ?? C.invalidValue });
      return;
    }
    const patch: Partial<Preferences> = {};
    for (const k of Object.keys(parsed.data) as (keyof Preferences)[]) {
      if (JSON.stringify(parsed.data[k]) !== JSON.stringify(prefs[k])) (patch as Record<string, unknown>)[k] = parsed.data[k];
    }
    setSaving(true);
    try {
      await setPreferences(patch);
      setDraft(parsed.data);
      toast({ kind: 'ok', title: C.saved, body: C.savedNote(Object.keys(patch).length) });
    } catch (e) {
      toast({ kind: 'error', title: C.notSaved, body: (e as Error).message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      aria-label={C.tradingForm}
      className="panel set-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      noValidate
    >
      <fieldset disabled={saving}>
      <SettingRow title={C.defaultMode} desc={C.defaultModeNote}>
        <select className="input" aria-label={C.defaultMode} value={draft.defaultMode} onChange={e => set('defaultMode', e.target.value as Preferences['defaultMode'])}>{['paper', 'testnet', 'live'].map(mode => <option key={mode} value={mode}>{mode}</option>)}</select>
      </SettingRow>
      <SettingRow title={C.tradeAmounts} desc={C.amountsNote} error={errs.quickAmounts}>
        <NumberList label={C.tradeAmount} values={draft.quickAmounts} onChange={(v) => set('quickAmounts', v)} max={6} step={10} prefix="$" invalid={!!errs.quickAmounts} />
      </SettingRow>
      <SettingRow title={C.sellPresets} desc={C.sellPresetsNote} error={errs.quickSellPercents}>
        <NumberList label={C.sellPreset} values={draft.quickSellPercents} onChange={v => set('quickSellPercents', v)} max={6} step={5} suffix="%" invalid={!!errs.quickSellPercents} />
      </SettingRow>
      <SettingRow title={C.slippagePresets} desc={C.slippagePresetsNote} error={errs.slippagePresetsBps}>
        <NumberList label={C.slippagePreset} values={draft.slippagePresetsBps} onChange={v => set('slippagePresetsBps', v)} max={5} step={10} suffix="bps" invalid={!!errs.slippagePresetsBps} />
      </SettingRow>
      <SettingRow title={C.slippage} desc={C.slippageNote} error={errs.defaultSlippageBps}>
        <div className="set-inline">
          <input
            className="input num set-input-s"
            type="number"
            min={1}
            max={500}
            step={1}
            value={Number.isFinite(draft.defaultSlippageBps) ? draft.defaultSlippageBps : ''}
            onChange={(e) => set('defaultSlippageBps', e.target.valueAsNumber)}
            aria-label={C.slippageLabel}
            aria-invalid={!!errs.defaultSlippageBps}
          />
          <span className="set-unit">bps</span>
          <span className="set-hint num">{Number.isFinite(draft.defaultSlippageBps) ? `= ${(draft.defaultSlippageBps / 100).toFixed(2)}%` : ''}</span>
        </div>
      </SettingRow>
      <SettingRow title={C.confirmation} desc={C.confirmationNote} error={errs.confirmLargeTradeUsd}>
        <div className="set-inline">
          <span className="set-unit">$</span>
          <input
            className="input num set-input-m"
            type="number"
            min={1}
            step={100}
            value={Number.isFinite(draft.confirmLargeTradeUsd) ? draft.confirmLargeTradeUsd : ''}
            onChange={(e) => set('confirmLargeTradeUsd', e.target.valueAsNumber)}
            aria-label={C.confirmationLabel}
            aria-invalid={!!errs.confirmLargeTradeUsd}
          />
        </div>
      </SettingRow>

      <div className={`set-savebar ${dirty ? 'is-dirty' : ''}`}>
        <span className="set-savebar-state">
          {invalid ? (
            <span className="lx-err">{C.fix}</span>
          ) : dirty ? (
            <>
              <span className="dot" aria-hidden /> {C.unsaved}
            </>
          ) : (
            <span className="muted">{C.allSaved}</span>
          )}
        </span>
        <span className="grow" />
        <button type="button" className="btn ghost" onClick={() => setDraft(d => ({ ...d, quickAmounts: DEFAULT_PREFERENCES.quickAmounts, quickSellPercents: DEFAULT_PREFERENCES.quickSellPercents, slippagePresetsBps: DEFAULT_PREFERENCES.slippagePresetsBps, defaultSlippageBps: DEFAULT_PREFERENCES.defaultSlippageBps, defaultMode: DEFAULT_PREFERENCES.defaultMode, confirmLargeTradeUsd: DEFAULT_PREFERENCES.confirmLargeTradeUsd }))}>
          {C.restore}
        </button>
        <button type="button" className="btn" onClick={() => setDraft(prefs)} disabled={!dirty || saving}>
          {C.discard}
        </button>
        <button type="submit" className="btn primary" disabled={!dirty || invalid || saving} aria-busy={saving}>
          {saving ? <span className="spinner" aria-hidden /> : null}
          {C.save}
        </button>
      </div>
      </fieldset>
    </form>
  );
}

function NumberList({ label, values, onChange, max, step, prefix, suffix, invalid }: { label: string; values: number[]; onChange: (v: number[]) => void; max: number; step: number; prefix?: string; suffix?: string; invalid?: boolean }) {
  return (
    <div className="set-list" role="group" aria-label={label + 's'}>
      {values.map((v, i) => (
        <span className={`set-list-item ${invalid && (!Number.isFinite(v) || v <= 0) ? 'is-bad' : ''}`} key={i}>
          {prefix ? <span className="set-affix">{prefix}</span> : null}
          <input
            className="set-list-input num"
            type="number"
            step={step}
            min={0}
            value={Number.isFinite(v) ? v : ''}
            aria-label={`${label} ${i + 1}`}
            onChange={(e) => onChange(values.map((x, j) => (j === i ? e.target.valueAsNumber : x)))}
          />
          {suffix ? <span className="set-affix">{suffix}</span> : null}
          <button type="button" className="set-list-rm" aria-label={C.removeLabel(label, i)} disabled={values.length <= 1} onClick={() => onChange(values.filter((_, j) => j !== i))}>
            <IconClose size={10} />
          </button>
        </span>
      ))}
      {values.length < max ? (
        <button type="button" className="set-list-add" onClick={() => onChange([...values, (values.filter(Number.isFinite).at(-1) ?? 0) + step])} aria-label={C.addLabel(label)}>
          <IconPlus size={11} /> {C.add}
        </button>
      ) : null}
    </div>
  );
}
