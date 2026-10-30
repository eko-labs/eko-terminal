import { MISSION_LABELS as L, MISSION_TEXT as T } from '../../copy/mission';
import { useCallback, useEffect, useState } from 'react';
import { AgentDetailSchema, ApprovalSchema, type AgentDetail, type Approval, type Flags } from '@eko/shared';
import { fetchParsed, MOCKS } from '../../lib/api';
import { AgentsResponse, ApprovalsResponse } from '../../lib/mission';
import { useShell } from '../../store/shell';
import { Link } from '../../lib/Link';
import { Tabs, TabPanel, VerdictChip } from '../../components/ui';
import { IconAlert, IconShield } from '../../components/icons';
import { MISSION_COPY as C } from '../../copy/mission';
import { Decision, GuardBadge, guardLine, money, useApprovalDecision, useNow } from './parts';
import { loadMockAlertSettings } from './mock-alert-settings';
import './mission.css';
import './mission-screens.css';

export function ApprovalCard({ approval: a, agent, now, onUpdated }: { approval: Approval; agent?: AgentDetail; now: number; onUpdated: (a: Approval) => void }) {
  const { confirm, setConfirm, busy, error, left, run } = useApprovalDecision(a, now, onUpdated), d = a.detail, o = d?.order, expired = a.status === 'expired' || (a.status === 'pending' && !left);
  return <article className={`mc-ap${expired ? ' expired' : ''}`} data-approval-id={a.id}><header className="mc-ap-head"><div><Link to={`/mission/agents/${a.agentId}`} className="mc-ap-agent">{agent?.name ?? L.agent}</Link><span className="mc-ap-meta">{o?.venue}</span></div>{agent && <GuardBadge agent={agent} />}<span className="mc-ap-exp">{expired ? L.expired : a.status === 'pending' ? <>{L.expiresIn}<b className="num">{Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}</b></> : a.status}</span></header><div className="mc-ap-drain" aria-hidden="true"><i style={{ width: `${Math.min(100, left / 1800 * 100)}%` }} /></div>
    <div className="mc-ap-body"><div className="mc-ap-order"><div className="mc-ap-line"><span className="mc-ap-side">{o?.side === 'sell' ? L.sell : L.buy}</span><b>{money(o?.notionalUsd ?? d?.notionalUsd ?? 0)}</b><span className="mc-ap-sym">{o?.instrument}</span>{d?.verdict && <VerdictChip level={d.verdict.level} />}</div><p className="mc-ap-sum">{a.summary}</p><dl className="kv mc-ap-kv">{d?.usualSizeUsd && <><dt>{L.usualOrder}</dt><dd>{money(d.usualSizeUsd)} {L.thisOneIs}{' '}{((o?.notionalUsd ?? d.notionalUsd ?? 0) / d.usualSizeUsd).toFixed(1)}×</dd></>}<dt>{L.ruleHit}</dt><dd className="mc-rule">{L.approvalaboveusd}{d && ` · ${money(d.approvalAboveUsd)}`}</dd><dt>{L.preflight}</dt><dd className="addr">{a.preflightId} {L.policyV}{d?.policyVersion ?? '—'}</dd></dl>{agent && <p className="note">{guardLine(agent)}</p>}<Link className="mc-link" to={`/approve/${encodeURIComponent(a.id)}`}>{L.openApproval}</Link></div>
    <div className="tp-guard mc-ap-guard"><div className="tp-guard-head"><IconShield />{L.preflightChecks}</div><ul className="tp-checks">{d?.reasons.map((reason, i) => <li key={i} className="warn"><span className="tp-ic"><IconAlert /></span><span><b>{reason}</b></span></li>)}</ul></div></div>
    <footer className="mc-ap-foot">{expired ? <span>{L.expiredTheAgentWasToldNo}</span> : a.status !== 'pending' ? <span>{L.decidedElsewhere}{' '}<Decision decision={a.status} /></span> : confirm ? <><span className="mc-ap-ask">{confirm === 'approved' ? T.approve(agent?.name ?? L.agent, o?.side ?? '', money(o?.notionalUsd ?? 0), o?.instrument ?? '') : T.deny(agent?.name ?? L.agent, o?.instrument ?? '')}</span><button className="btn btn-ghost" disabled={busy} onClick={() => setConfirm(null)}>{L.back}</button><button className={`btn ${confirm === 'approved' ? 'btn-primary' : 'btn-danger'}`} disabled={busy} autoFocus onClick={() => void run()}>{busy ? L.working : confirm === 'approved' ? L.confirmApprove : L.confirmDeny}</button></> : <><button className="btn btn-primary" onClick={() => setConfirm('approved')}>{L.approve}</button><button className="btn" onClick={() => setConfirm('denied')}>{L.deny}</button><span className="muted mc-ap-hint">{agent?.kind === 'robinhood_mcp' ? L.robinhoodAsksYouAgainIfItsTrade : L.theAgentGetsYourAnswerOnIts}</span></>}{error && <p role="alert">{error}</p>}</footer>
  </article>;
}
export function ApprovalNotifications({ mock = MOCKS }: { mock?: boolean }) {
  const [settings, setSettings] = useState<{ push: boolean; telegram: boolean } | null>(null);
  useEffect(() => {
    if (!mock) return;
    let active = true;
    void loadMockAlertSettings().then((store) => { if (active) setSettings(store.read()); });
    return () => { active = false; };
  }, [mock]);
  const save = async (channel: 'push' | 'telegram', enabled: boolean) => {
    setSettings((old) => old && { ...old, [channel]: enabled });
    const store = await loadMockAlertSettings();
    setSettings(store.save(channel, enabled));
  };
  return <><div>{mock ? (['push', 'telegram'] as const).map((channel) => <label className="mc-notif" key={channel}><span><b>{channel === 'push' ? 'Web push' : 'Telegram DM'}</b><span className="muted">{channel === 'push' ? 'This browser' : 'A ping with a link back here'}</span></span><span><input type="checkbox" aria-label={channel === 'push' ? 'Web push' : 'Telegram DM'} disabled={!settings} checked={settings?.[channel] ?? false} onChange={(e) => void save(channel, e.target.checked)} /><span className="switch" aria-hidden="true" /></span></label>) : <Link to="/settings">{L.notificationSettings}</Link>}</div><p className="note">{L.notificationsOnlyTellYouSomethingIsWaiting}</p></>;
}
// TODO(spec): Approval has no decision timestamp, response duration or structured
// checks. History labels expiresAt as expiry; omit median/response metrics and
// render only the supplied reasons instead of manufacturing passed checks.
export function ApprovalsScreen({ approvals, agents, flags, now, onUpdated }: { approvals: Approval[]; agents: AgentDetail[]; flags: Partial<Flags>; now: number; onUpdated: (a: Approval) => void }) {
  const [tab, setTab] = useState<string>(L.pending);
  if (!flags.approvals) return null;
  const pending = approvals.filter((a) => a.status === 'pending').sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt)), history = approvals.filter((a) => a.status !== 'pending').sort((a, b) => Date.parse(b.expiresAt) - Date.parse(a.expiresAt));
  return <div className="page mc mission-screen"><div className="page-head"><div><h1>{L.approvals}</h1><p>{C.approvalsIntro}</p></div><div className="mc-inline"><span><b className="num">{pending.filter((a) => Date.parse(a.expiresAt) > now).length}</b> {L.waiting}</span><span><b className="num">{history.filter((a) => now - Date.parse(a.expiresAt) < 7 * 86400000).length}</b> {L.decidedIn7Days}</span></div></div><div className="mc-tabs"><Tabs tabs={[L.pending, L.history]} value={tab} onChange={setTab} label={L.approvals} id="approvals" /></div><div className="mc-split"><div className="mc-approval-main"><TabPanel id="approvals" index={0} active={tab === L.pending}>{pending.length ? pending.map((a) => <ApprovalCard key={a.id} approval={a} agent={agents.find((agent) => agent.id === a.agentId)} now={now} onUpdated={onUpdated} />) : <div className="panel mc-empty"><b>{L.nothingWaitingYourAgentsAreInsideTheir}</b><Link className="btn btn-sm" to="/mission">{L.backToAgents}</Link></div>}</TabPanel><TabPanel id="approvals" index={1} active={tab === L.history}><section className="panel"><div className="panel-head"><h3>{L.recentDecisions}</h3></div><div className="panel-body mc-scroll-x"><table className="table mc-hist"><thead><tr><th>{L.expiry}</th><th>{L.agent}</th><th>{L.order}</th><th>{L.rule}</th><th>{L.decision}</th></tr></thead><tbody>{history.map((a) => <tr key={a.id}><td>{new Date(a.expiresAt).toLocaleDateString('en-US')}</td><td><Link to={`/mission/agents/${a.agentId}`}>{agents.find((agent) => agent.id === a.agentId)?.name}</Link></td><td>{a.summary}</td><td className="mc-rule">{L.approvalaboveusd}</td><td><Decision decision={a.status} /></td></tr>)}</tbody></table>{!history.length && <p>{L.noDecisionsYet}</p>}</div></section></TabPanel></div><aside className="mc-aside"><section className="panel"><div className="panel-head"><h3>{L.approvalLimits}</h3><span className="muted">{L.perAgentPolicy}</span></div><div className="panel-body"><ul className="mc-limits">{agents.map((a) => <li key={a.id}><div><Link to={`/mission/agents/${a.id}`}>{a.name}</Link><span className="muted">{a.policy.mode}</span></div><div className="num">{L.above2}{money(a.policy.approvalAboveUsd ?? 0)}</div><Link to={`/mission/agents/${a.id}?tab=policy`} className="mc-link">{flags.policy_editor ? L.edit : L.presets}</Link></li>)}</ul></div></section><section className="panel"><div className="panel-head"><h3>{L.howApprovalsReachYou}</h3></div><div className="panel-body"><ApprovalNotifications /></div></section></aside></div></div>;
}
export default function Approvals({ params }: { params: Record<string, string> }) {
  const flags = useShell((s) => s.config?.flags) ?? ({} as Partial<Flags>), rt = useShell((s) => s.realtime), now = useNow(), [approvals, setApprovals] = useState<Approval[]>([]), [agents, setAgents] = useState<AgentDetail[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const id = params.id;
  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!flags.approvals) return;
    const [rows, list] = await Promise.all([id ? fetchParsed(`/approvals/${encodeURIComponent(id)}`, ApprovalSchema, { signal }).then((a) => [a]) : fetchParsed('/approvals', ApprovalsResponse, { signal }).then((p) => p.rows), fetchParsed('/agents', AgentsResponse, { signal })]);
    const details = await Promise.all(list.agents.map((a) => fetchParsed(`/agents/${encodeURIComponent(a.id)}`, AgentDetailSchema, { signal })));
    if (!signal?.aborted) { setApprovals(rows); setAgents(details); setLoading(false); setError(''); }
  }, [flags.approvals, id]);
  useEffect(() => { const c = new AbortController(); setLoading(true); void refresh(c.signal).catch((e: Error) => { if (e.name !== L.aborterror) { setError(e.message); setLoading(false); } }); return () => c.abort(); }, [refresh]);
  const update = useCallback((a: Approval) => setApprovals((old) => id && a.id !== id ? old : [a, ...old.filter((row) => row.id !== a.id)]), [id]);
  useEffect(() => { if (!rt || !flags.approvals) return; return rt.subscribe('approvals', (e) => update(e.data), async () => refresh()); }, [rt, flags.approvals, refresh, update]);
  if (!flags.approvals) return null;
  if (error) return <div className="page mc"><h1>{L.approvals}</h1><p role="alert">{error}</p><button className="btn" onClick={() => void refresh().catch((e: Error) => setError(e.message))}>{L.retry}</button></div>;
  if (loading) return <div className="page mc"><div className="skel" style={{ height: 240 }} role="status" aria-label={L.loadingApprovals} /></div>;
  if (id) return <div className="page mc mission-screen"><nav className="mc-crumb"><Link to="/mission/approvals">{L.approvals}</Link><span>/</span><span>{id}</span></nav><h1>{L.reviewApproval}</h1>{approvals.map((a) => <ApprovalCard key={a.id} approval={a} agent={agents.find((agent) => agent.id === a.agentId)} now={now} onUpdated={update} />)}</div>;
  return <ApprovalsScreen approvals={approvals} agents={agents} flags={flags} now={now} onUpdated={update} />;
}
