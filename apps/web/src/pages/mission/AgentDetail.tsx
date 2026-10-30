import { riskModeLabel } from '../../copy/shell';
import { MISSION_LABELS as L, MISSION_TEXT as T } from '../../copy/mission';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AgentDetailSchema, AgentSchema, type AgentDetail as Detail, type ApiKeyInfo, type Flags, type JournalEntry, type Policy } from '@eko/shared';
import type { demoConnections } from '../../mocks/demo/mission';
import type { z } from 'zod';
import { fetchParsed, MOCKS } from '../../lib/api';
import { JournalResponse, UncheckedResponse, loadJournal, loadKeys, loadPolicy, loadPresets, type MissionAction, type PresetsResponse } from '../../lib/mission';
import { useShell } from '../../store/shell';
import { navigate, useSearch } from '../../lib/router';
import { Link } from '../../lib/Link';
import { Tabs, TabPanel } from '../../components/ui';
import { IconPause, IconPlay, IconStop, IconCopy } from '../../components/icons';
import { MISSION_COPY as C } from '../../copy/mission';
import { countsOf, KillConfirm, type Metrics } from './Agents';
import { GuardBadge, OutcomeKey, PreflightBar, StatusPill, agoText, guardLine, money, signed, useNow } from './parts';
import PolicyEditor from './PolicyEditor';
import Connection from './Connection';
import Performance from './Performance';
import { JournalTimeline } from './Journal';
import './mission.css';
import './mission-screens.css';
import './connect.css';

const TABS = [L.activity, L.limits, L.performance, L.connection];
export const TAB_ALIASES: Record<string, string> = { journal: L.activity, activity: L.activity, policy: L.limits, limits: L.limits, performance: L.performance, keys: L.connection, connection: L.connection };
// TODO(spec): CA-18 has no performance history, positions, root block/proof,
// or client/venue/note fields. Reuse overview demo metadata only in mocks;
// live views omit unsupported values and never simulate proof verification.
interface DetailData { agent: Detail; policy: Policy; journals: JournalEntry[]; journalUnavailable?: boolean; cursor: string | null; keys: ApiKeyInfo[]; unchecked: z.infer<typeof UncheckedResponse>['rows']; presets: z.infer<typeof PresetsResponse>; metrics?: Metrics[string]; connection?: typeof demoConnections[keyof typeof demoConnections] }
export function AgentScreen({ data, flags, tab = L.activity, setTab, refresh, onData, loadMore, moreBusy = false }: { data: DetailData; flags: Partial<Flags>; tab?: string; setTab: (tab: string) => void; refresh: () => Promise<void>; onData: (data: DetailData) => void; loadMore: () => void; moreBusy?: boolean }) {
  const a = data.agent, m = data.metrics, now = useNow(), [action, setAction] = useState<MissionAction | null>(null), [rename, setRename] = useState(false), [name, setName] = useState(a.name), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const c = countsOf(a, { agents: [a], details: { [a.id]: a }, journals: { [a.id]: data.journals }, approvals: [], unchecked: data.unchecked }, m ? { [a.id]: m } : undefined);
  const saveName = async () => { if (busy || !name.trim()) return; setBusy(true); setError(''); try { await fetchParsed(`/agents/${encodeURIComponent(a.id)}`, AgentSchema, { method: 'PATCH', body: { name: name.trim() } }); await refresh(); setRename(false); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  return <div className="page mc mission-screen"><nav className="mc-crumb" aria-label={L.breadcrumb}><Link to="/mission">{L.missionControl}</Link><span>/</span><span aria-current="page">{a.name}</span></nav>
    <div className="page-head mc-ahead"><div className="mc-ahead-id"><h1>{a.name}</h1><p className="mc-ahead-sub"><StatusPill agent={a} /><GuardBadge agent={a} /><span>{m ? T.clientVenue(m.client, m.venue) : a.kind === 'robinhood_mcp' ? L.robinhoodMcp : a.kind === 'onchain' ? L.onChainAgent : a.kind === 'perp_venue' ? L.perpVenue : L.mcpAgent}</span><span>{a.lastSeen ? T.lastActive(agoText((now - Date.parse(a.lastSeen)) / 1000)) : L.waitingForFirstCall}</span></p>{m && <p className="mc-ahead-note">{m.note}</p>}</div><div className="mc-ahead-actions">{flags.mission_kill && a.status !== 'disconnected' && <><button className={`btn${a.status === 'soft_killed' ? ' btn-primary' : ''}`} onClick={() => setAction({ kind: a.status === 'soft_killed' ? 'resume' : 'pause', agent: a })}>{a.status === 'soft_killed' ? <IconPlay /> : <IconPause />}{a.status === 'soft_killed' ? L.resumeAgent : L.pauseAgent}</button><button className="btn mc-btn-kill" onClick={() => setAction({ kind: 'disconnect', agent: a })}><IconStop />{L.disconnect}</button></>}{a.status === 'disconnected' && <Link to="/mission/connect" className="btn btn-primary">{L.reconnect}</Link>}</div></div>
    {a.status !== 'active' && <div className={`mc-banner ${a.status === 'soft_killed' ? 'strong' : 'danger'}`}><p>{a.status === 'soft_killed' ? T.paused(a.name) : T.disconnected(a.name, a.kind === 'robinhood_mcp')}</p></div>}
    {flags.unchecked_orders && a.status !== 'disconnected' && data.unchecked.length > 0 && <div className="mc-banner danger"><p><b>{L.anOrderWasPlacedWithoutACheck}</b> {data.unchecked.map((u) => T.order(u.side, money(u.notionalUsd ?? 0), u.instrument)).join(' · ')}. {C.unchecked}</p><button className="btn btn-sm" onClick={() => { void navigator.clipboard.writeText(L.beforeEveryOrderCallEkoPreflightAnd).then(() => setError(L.instructionsCopied)).catch(() => setError(L.couldNotCopyInstructions)); }}><IconCopy />{L.copyInstructions}</button></div>}
    <section className="mc-glance" aria-label={L.atAGlance}><div className="mc-g wide"><span className="label">{L.checksInTheLast24Hours}</span><b className="value num">{data.journalUnavailable ? '—' : c.total}</b>{!data.journalUnavailable && <><PreflightBar c={c} /><OutcomeKey c={c} /></>}</div><div className="mc-g"><span className="label">{L.protection}</span><b className="value"><GuardBadge agent={a} /></b><span className="sub">{guardLine(a)}</span></div><div className="mc-g"><span className="label">{L.limits}</span><b className="value">{riskModeLabel(data.policy.mode)}</b><span className="sub">{flags.approvals ? L.needsApproval : L.denied} {L.above}{money(data.policy.approvalAboveUsd ?? 0)} · <button className="mc-link-btn" onClick={() => setTab(L.limits)}>{flags.policy_editor ? L.edit : L.presets}</button></span></div><div className="mc-g"><span className="label">{L.moneyAtWork}</span><b className="value num">{m ? money(m.exposureUsd) : '—'}</b><span className="sub">{m ? T.today(signed(m.pnl24hUsd)) : L.notReported}</span></div></section>
    {data.journalUnavailable && <p role="status">Activity journal is unavailable. Check counts are not reported.</p>}
    <div className="mc-tabs"><Tabs tabs={TABS} value={tab} onChange={setTab} label={L.agentDetails} id="agent" /></div>
    <TabPanel id="agent" index={0} active={tab === L.activity}>{tab === L.activity && <div className="mc-split"><JournalTimeline entries={data.journals} agent={a} loadMore={loadMore} hasMore={!!data.cursor} busy={moreBusy} /><aside className="mc-aside"><section className="panel"><div className="panel-head"><h3>{L.protection}</h3><GuardBadge agent={a} /></div><div className="panel-body"><p className="mc-p">{guardLine(a)}</p>{flags.unchecked_orders && <p className="note">{L.atEachCheckInTheAgentReports}</p>}</div></section><section className="panel"><div className="panel-head"><h3>{L.aboutThisLog}</h3><span className="muted">{L.privateToYou}</span></div><div className="panel-body"><dl className="kv"><dt>{L.entriesToday}</dt><dd>{data.journals.filter((e) => now - Date.parse(e.ts) < 86400000).length}</dd><dt>{L.nextRoot}</dt><dd>{L.in}{300 - Math.floor(now / 1000) % 300}{L.s}</dd><dt>{L.storage}</dt><dd>{L.appendOnlyEncryptedPerUser}</dd></dl><p className="note">{L.entriesAreCommittedOnChainAsPrivate}</p></div></section>{m && <section className="panel"><div className="panel-head"><h3>{L.limitsHit24h}</h3></div><div className="panel-body"><ul className="mc-rules">{m.rules.map(([rule, count]) => <li key={rule}><span>{rule}</span><b className="num">{count}</b><div className="bar"><i style={{ width: `${Number(count) / Math.max(1, ...m.rules.map((r) => Number(r[1]))) * 100}%`, background: 'var(--danger)' }} /></div></li>)}</ul></div></section>}</aside></div>}</TabPanel>
    <TabPanel id="agent" index={1} active={tab === L.limits}>{tab === L.limits && <PolicyEditor key={a.id} agent={a} policy={data.policy} presets={data.presets} flags={flags} onSaved={(policy) => onData({ ...data, policy })} />}</TabPanel>
    <TabPanel id="agent" index={2} active={tab === L.performance}>{tab === L.performance && <Performance metrics={m} />}</TabPanel>
    <TabPanel id="agent" index={3} active={tab === L.connection}>{tab === L.connection && <><Connection agent={a} keys={data.keys} flags={flags} metadata={data.connection} onKeys={(keys) => onData({ ...data, keys })} /><button className="btn btn-sm btn-ghost" onClick={() => setRename(true)}>{L.renameAgent}</button></>}</TabPanel>
    {error && <p role="status">{error}</p>}
    {rename && <form className="mc-banner" onSubmit={(e) => { e.preventDefault(); void saveName(); }}><label>{L.name}<input className="input" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} autoFocus /></label><button className="btn" disabled={busy || !name.trim()}>{L.saveName}</button><button type="button" className="btn btn-ghost" onClick={() => setRename(false)}>{L.cancel}</button></form>}
    {flags.mission_kill && action && <KillConfirm action={action} close={() => setAction(null)} refresh={refresh} />}
  </div>;
}
export default function AgentDetail({ params }: { params: Record<string, string> }) {
  return <AgentDetailLoader key={params.id} id={params.id} />;
}
function AgentDetailLoader({ id }: { id: string }) {
  const flags = useShell((s) => s.config?.flags) ?? ({} as Partial<Flags>), rt = useShell((s) => s.realtime), search = useSearch(), tab = TAB_ALIASES[search.get('tab') ?? ''] ?? L.activity;
  const [data, setData] = useState<DetailData | null>(null), [error, setError] = useState(''), [moreBusy, setMoreBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null), anchor = useRef<{ id: string; top: number } | null>(null);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const base = `/agents/${encodeURIComponent(id)}`;
    const [agent, policy, journals, keys, unchecked, presets, demo] = await Promise.all([fetchParsed(base, AgentDetailSchema, { signal }), loadPolicy(id, signal), loadJournal(id, undefined, undefined, signal), loadKeys(id, signal), flags.unchecked_orders ? fetchParsed(`${base}/unchecked-orders`, UncheckedResponse, { signal }) : Promise.resolve({ rows: [] }), loadPresets(signal), MOCKS ? import('../../mocks/demo/mission') : Promise.resolve(null)]);
    if (!signal?.aborted) { setData((old) => ({ agent, policy, journalUnavailable: journals.unavailable, journals: old ? [...journals.rows, ...old.journals.filter((e) => !journals.rows.some((n) => n.id === e.id))] : journals.rows, cursor: old ? old.cursor : journals.cursor ?? null, keys: keys.keys, unchecked: unchecked.rows, presets, metrics: demo?.demoMetrics[id], connection: demo?.demoConnections[id as keyof typeof demo.demoConnections] })); setError(''); }
  }, [id, flags.unchecked_orders]);
  useEffect(() => { const c = new AbortController(); void refresh(c.signal).catch((e: Error) => { if (e.name !== L.aborterror) setError(e.message); }); return () => c.abort(); }, [refresh]);
  useEffect(() => {
    if (!rt) return;
    return rt.subscribe('agents', (e) => {
      if (e.kind === 'journal' && e.data.agentId === id) {
        const row = [...(root.current?.querySelectorAll<HTMLElement>('[data-journal-id]') ?? [])].find((el) => el.getBoundingClientRect().top >= 0);
        anchor.current = row ? { id: row.dataset.journalId!, top: row.getBoundingClientRect().top } : null;
        setData((d) => d ? { ...d, journals: [e.data, ...d.journals.filter((j) => j.id !== e.data.id)] } : d);
      }
      if (e.kind === 'agent' && e.data.id === id) { setData((d) => d ? { ...d, agent: { ...d.agent, ...e.data } } : d); void refresh().catch((e: Error) => setError(e.message)); }
      if (e.kind === 'preflight' && e.data.agentId === id) { setData((d) => d ? { ...d, agent: { ...d.agent, lastSeen: new Date(e.ts).toISOString() } } : d); }
    }, async () => refresh());
  }, [rt, id, refresh]);
  useLayoutEffect(() => { const a = anchor.current; if (!a) return; const row = [...(root.current?.querySelectorAll<HTMLElement>('[data-journal-id]') ?? [])].find((el) => el.dataset.journalId === a.id); if (row) window.scrollBy(0, row.getBoundingClientRect().top - a.top); anchor.current = null; }, [data?.journals]);
  const more = async () => { if (!data?.cursor || moreBusy) return; setMoreBusy(true); try { const page = await loadJournal(id, data.cursor); setData((d) => d ? { ...d, journals: [...d.journals, ...page.rows.filter((e) => !d.journals.some((j) => j.id === e.id))], cursor: page.cursor ?? null } : d); } catch (e) { setError((e as Error).message); } finally { setMoreBusy(false); } };
  return <div ref={root}>{error && <div className="page mc"><p role="alert">{error}</p><button className="btn" onClick={() => void refresh().catch((e: Error) => setError(e.message))}>{L.retry}</button></div>}{data ? <AgentScreen data={data} flags={flags} tab={tab} setTab={(tab) => navigate(`/mission/agents/${encodeURIComponent(id)}?tab=${tab.toLowerCase()}`, true)} refresh={refresh} onData={setData} loadMore={() => void more()} moreBusy={moreBusy} /> : !error && <div className="page mc"><div className="skel" style={{ height: 240 }} role="status" aria-label={L.loadingAgent} /></div>}</div>;
}
