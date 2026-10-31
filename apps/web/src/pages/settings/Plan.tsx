import { useEffect, useState } from 'react';
import { ReferralsSchema, type Me, type PublicConfig, type Referrals } from '@eko/shared';
import { fetchParsed } from '../../lib/api';
import { serverNow } from '../../lib/clock';
import { Link } from '../../lib/Link';
import { referralLink, useSettingsSession } from '../../lib/settings';
import { useShell } from '../../store/shell';
import { PLAN_COPY as C } from '../../copy/settings';
import { SettingsConnect } from '../Settings';
import './settings.css';

export function trialCountdown(endsAt: string, now: number) {
  const seconds = Math.max(0, Math.ceil((Date.parse(endsAt) - now) / 1000));
  if (!Number.isFinite(seconds) || !seconds) return C.trialEnded;
  return `${C.trial} · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
export function PlanStatus() {
  const config = useShell(s => s.config), me = useShell(s => s.me), { owner } = useSettingsSession();
  const [now, setNow] = useState(serverNow);
  useEffect(() => { const timer = setInterval(() => setNow(serverNow()), 500); return () => clearInterval(timer); }, []);
  if (!config) return <p role="status">{C.loading}</p>;
  const endsAt = owner && config.flags.trial ? me?.entitlements.trial?.endsAt ?? (me?.trial.status === 'active' ? me.trial.endsAt : undefined) : undefined;
  return <p className="tag">{config.phase === 'launch_week' ? C.launch : config.phase === 'token_live' ? C.tokenLive : config.flags.tiers_active && owner && me ? endsAt ? trialCountdown(endsAt, now) : C.tierNames[me.entitlements.tier] : C.tiers}</p>;
}
export function FeeDisclosure() {
  const config = useShell(s => s.config), me = useShell(s => s.me), { owner } = useSettingsSession();
  if (!config) return null;
  const bps = config.phase === 'launch_week' ? 0 : config.flags.tiers_active && owner && me ? me.entitlements.feeBps : 50;
  return <div className="note">{config.phase === 'launch_week' ? <p>{C.feeLaunch}</p> : bps === 0 ? <p>{C.feeUniswapZero}</p> : <p>{`${C.fee}: ${bps / 100}% ${C.feeUniswap}.`}</p>}<p>{C.feeCurve}</p></div>;
}
export default function Plan() {
  const config = useShell(s => s.config), me = useShell(s => s.me), { owner } = useSettingsSession();
  return <div className="shell-page settings-page"><header className="page-head"><h1>{C.title}</h1><Link to="/settings">{C.back}</Link></header><PlanStatus />{config?.phase === 'launch_week' && <p>{C.launchNote}</p>}<FeeDisclosure />
    {config?.flags.tiers_active && config.phase === 'tiers' && <TierDetails config={config} me={owner ? me : null} />}
    {owner ? <><Trial me={me} enabled={!!config?.flags.trial && !!config?.flags.tiers_active && config?.phase === 'tiers'} /><ReferralCard key={owner} bonuses={!!config?.flags.referrals && !!config?.flags.tiers_active && config?.phase === 'tiers'} /></> : <SettingsConnect />}
  </div>;
}
export function TierDetails({ config, me }: { config: PublicConfig; me: Me | null }) {
  return <section className="section panel panel-body"><h2>{C.tiers}</h2>{me && <><p>{C.tierNames[me.entitlements.tier]}</p><dl><dt>{C.minHeld}</dt><dd>{me.holdings.minBalance24h ?? C.unavailable}</dd></dl></>}
    <p>{C.amountsNote}</p><div className="settings-plan-table"><table className="table"><thead><tr><th>{C.tiers}</th><th>{C.minHeld}</th><th>{C.fee}</th><th>{C.agents}</th></tr></thead><tbody>{config.tiers.map(tier => <tr key={tier.tier}><th>{C.tierNames[tier.tier]}</th><td>{tier.minBalance === null ? C.unavailable : `${C.requirement} ${tier.minBalance} ${C.hold}`}</td><td>{tier.feeBps / 100}%</td><td>{tier.limits.agents}</td></tr>)}</tbody></table></div>
  </section>;
}
function Trial({ me, enabled }: { me: Me | null; enabled: boolean }) {
  const [now, setNow] = useState(serverNow);
  useEffect(() => { if (!enabled) return; const timer = setInterval(() => setNow(serverNow()), 500); return () => clearInterval(timer); }, [enabled]);
  if (!enabled || !me || (me.trial.status === 'not_open' && !me.entitlements.trial)) return null;
  const endsAt = me.entitlements.trial?.endsAt ?? me.trial.endsAt;
  return <section className="section panel panel-body"><h2>{C.trial}</h2><p>{(me.entitlements.trial || me.trial.status === 'active') && endsAt ? trialCountdown(endsAt, now) : me.trial.status === 'eligible' ? C.eligible : me.trial.status === 'used' ? C.used : C.ineligible}</p></section>;
}
export function ReferralDetails({ data, bonuses }: { data: Referrals; bonuses: boolean }) {
  const [message, setMessage] = useState<string | null>(null);
  const link = referralLink(data.link, data.code);
  if (!link) return <p role="alert">{C.referralError}</p>;
  return <><p><a href={link}>{link}</a></p><div className="settings-links"><button className="btn" onClick={() => {
    void (async () => { try { await navigator.clipboard.writeText(link); setMessage(C.copied); } catch { setMessage(C.copyError); } })();
  }}>{C.copy}</button><a className="btn" target="_blank" rel="noreferrer" href={`https://twitter.com/intent/tweet?url=${encodeURIComponent(link)}`}>{C.shareX}</a><a className="btn" target="_blank" rel="noreferrer" href={`https://t.me/share/url?url=${encodeURIComponent(link)}`}>{C.shareTelegram}</a></div>
    <dl><dt>{C.referred}</dt><dd>{data.referred}</dd>{bonuses && <><dt>{C.qualified}</dt><dd>{data.qualified}</dd><dt>{C.bonus}</dt><dd>{data.bonusMinutes}</dd></>}</dl>{message && <p role="status">{message}</p>}</>;
}
function ReferralCard({ bonuses }: { bonuses: boolean }) {
  const [data, setData] = useState<Referrals | null>(null), [error, setError] = useState(false), [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setError(false);
    void fetchParsed('/referrals', ReferralsSchema, { signal: controller.signal }).then(value => { if (!controller.signal.aborted) setData(value); }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [revision]);
  return <section className="section panel panel-body"><h2>{C.referralTitle}</h2><p>{bonuses ? C.referralBonus : C.referralNote}</p>{data ? <ReferralDetails data={data} bonuses={bonuses} /> : error ? <p role="alert">{C.referralError} <button className="btn" onClick={() => setRevision(s => s + 1)}>{C.retry}</button></p> : <p role="status">{C.referralLoading}</p>}</section>;
}
