import { riskModeLabel } from '../../copy/shell';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { AgentDetailSchema, HardKillSchema, type Agent, type Approval, type Flags, type Policy, type ApiKeyInfo } from '@eko/shared';
import { Collapsible, Seg, Tabs, TabPanel } from '../../components/ui';
import { MiniBars, Spark, useWidth } from '../../components/ui/charts';
import { ChartPlate } from '../../components/ui/ChartPlate';
import { IconPlus, IconStop, IconPause, IconPlay, IconCopy, IconCheck, IconX, IconChevron, IconExpand, IconKey } from '../../components/icons';
import { useDialog } from '../../components/onboarding/useDialog';
import { useShell } from '../../store/shell';
import { useMedia } from '../../lib/useMedia';
import { Link } from '../../lib/Link';
import { expandTo } from '../../lib/expand';
import { ApiError, fetchParsed, MOCKS } from '../../lib/api';
import { emptyMission, loadMission, loadKeys, loadPolicy, mutateMission, type MissionSnapshot, type MissionAction } from '../../lib/mission';
import type { demoMetrics } from '../../mocks/demo/mission';
import { ApprovalRow, GuardBadge, JournalLine, MissionDialog, OutcomeKey, PreflightBar, StatusPill, TERMS, agoText, guardLine, money, payloadOf, signed, statusClass, useNow, type Counts } from './parts';
import { MISSION_COPY } from '../../copy/mission';
import './mission.css';

export type Metrics = typeof demoMetrics;
// TODO(spec): CA-18 lacks client/venue/note, hourly history, previous checks, rule totals and
// performance/positions. Use prototype metadata only in mocks; live views show missing data explicitly.
export function countsOf(a: Agent, data: MissionSnapshot, metrics?: Metrics): Counts {
  const m = metrics?.[a.id];
  if (m) return { total: m.preflights24h, allowed: m.allowed, denied: m.denied, approval: m.needsApproval };
  const checks = (data.journals[a.id] ?? []).filter((e) => e.kind === 'decision' && Date.parse(e.ts) > Date.now() - 86400000).map(payloadOf);
  const allowed = checks.filter((p) => p.decision === 'allow').length, denied = checks.filter((p) => p.decision === 'deny').length, approval = checks.filter((p) => p.decision === 'needs_approval').length;
  return { total: allowed + denied + approval, allowed, denied, approval };
}
function hourlyOf(a: Agent, data: MissionSnapshot, metrics?: Metrics) {
  if (metrics?.[a.id]) return metrics[a.id].hourly;
  const out = Array<number>(24).fill(0), now = Date.now();
  for (const e of data.journals[a.id] ?? []) { const i = 23 - Math.floor((now - Date.parse(e.ts)) / 3600000); if (e.kind === 'decision' && i >= 0 && i < 24) out[i]++; }
  return out;
}
export function onListKeys(e: KeyboardEvent<HTMLUListElement>) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
  const list = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[data-pick]')], i = list.indexOf(document.activeElement as HTMLButtonElement);
  if (i < 0) return;
  e.preventDefault();
  const j = e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : Math.max(0, Math.min(list.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
  list[j]?.focus(); list[j]?.click();
}
export function AgentRow({ agent: a, data, metrics, selected, select, index }: { agent: Agent; data: MissionSnapshot; metrics?: Metrics; selected: boolean; select: (id: string) => void; index: number }) {
  const c = countsOf(a, data, metrics), m = metrics?.[a.id], policy = data.details[a.id]?.policy;
  const unchecked = data.unchecked.some((u) => u.agentId === a.id) && a.status !== 'disconnected';
  return <li><button data-pick className={`arow ${statusClass(a)}${selected ? ' sel' : ''}`} aria-pressed={selected} aria-controls={selected ? 'insp' : undefined} onClick={() => select(a.id)} aria-label={`${a.name}, ${a.status === 'active' ? a.lastSeen ? 'running' : 'waiting for first call' : a.status === 'soft_killed' ? 'paused' : 'disconnected'}, ${c.total} checks, ${c.denied} blocked${m ? `, ${money(m.exposureUsd)} at work` : ''}`}>
    <span className="arow-id"><b>{a.name}</b><span>{m?.client ?? ({ robinhood_mcp: 'Robinhood (MCP)', onchain: 'On-chain', perp_venue: 'Perp venue', other: 'MCP agent' })[a.kind]} · {policy?.mode ? riskModeLabel(policy.mode) : 'Limits'}</span></span><span className="arow-st"><StatusPill agent={a} /><GuardBadge agent={a} /></span>
    <span className="arow-checks"><span className="arow-line"><b className="num">{c.total}</b> checks{c.denied > 0 && <> · <span className="num">{c.denied}</span> blocked</>}{unchecked && <span className="bad"> · {a.uncheckedOrders24h} unchecked</span>}</span><PreflightBar c={c} height={5} /></span>
    <span className="arow-spark"><MiniBars series={hourlyOf(a, data, metrics)} height={26} tone={a.status !== 'active' ? 'dim' : undefined} delay={index * 90 + 200} label={`${a.name}: checks per hour, last 24 hours`} /></span>
    <span className="arow-fig"><b className="num">{m ? money(m.exposureUsd) : '—'}</b><span>at work</span></span><span className="arow-fig"><b className={`num${m && m.pnl24hUsd > 0 ? ' up' : ''}`}>{m ? signed(m.pnl24hUsd) : '—'}</b><span>today</span></span><IconChevron className="arow-chev" />
  </button></li>;
}
function HourlyChart({ series }: { series: readonly number[] }) {
  const [ref, width] = useWidth<HTMLDivElement>(), peak = Math.max(4, Math.ceil(Math.max(...series) / 2) * 2), height = 96;
  const L = 34, R = 34, T = 14, B = height - 26, x = (i: number) => L + (i + .5) * (width - L - R) / series.length, y = (v: number) => B - v / peak * (B - T);
  const geometry = { W: width, H: height, L, R, T, B, lo: 0, series, y };
  const [hover, setHover] = useState<number | null>(null);
  return <div ref={ref} className="mc-hourly" style={{ height }}>
    {width > 0 && <><ChartPlate kind="bars" geometry={geometry} label="Checks per hour, last 24 hours" /><svg viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      {[0, peak].map((v) => <g key={v}><line x1={L} x2={width - R} y1={y(v)} y2={y(v)} stroke="var(--rule)" /><text x={L - 8} y={y(v) + 3.5} textAnchor="end">{v}</text></g>)}
      {[0, 12, 23].map((i, k) => <text key={i} x={x(i)} y={height - 8} textAnchor={k === 0 ? 'start' : k === 2 ? 'end' : 'middle'}>{i === 23 ? 'Now' : `${23 - i}h ago`}</text>)}
      {hover !== null && <g><line x1={x(hover)} x2={x(hover)} y1={T - 6} y2={B} stroke="var(--lit)" opacity=".35" /><circle cx={x(hover)} cy={y(series[hover])} r="3.5" fill="#fff" stroke="var(--plate)" strokeWidth="2" /></g>}
      <rect x={L} y="0" width={Math.max(0, width - L - R)} height={B} fill="transparent" style={{ cursor: 'crosshair' }} onPointerLeave={() => setHover(null)} onPointerMove={(e) => setHover(Math.max(0, Math.min(23, Math.floor((e.clientX - e.currentTarget.ownerSVGElement!.getBoundingClientRect().left - L) / Math.max(1, width - L - R) * 24))))} />
    </svg></>}{hover !== null && <span className="mc-hourly-tip">{hover === 23 ? 'Now' : `${23 - hover}h ago`}: {Math.round(series[hover])} checks that hour</span>}
  </div>;
}
function Inspector({ agent: a, data, metrics, flags, now, close, act }: { agent: Agent; data: MissionSnapshot; metrics?: Metrics; flags: Partial<Flags>; now: number; close: () => void; act: (action: MissionAction) => void }) {
  const [tab, setTab] = useState('Activity'), [policy, setPolicy] = useState<Policy | null>(null), [keys, setKeys] = useState<ApiKeyInfo[]>([]), [tabError, setTabError] = useState('');
  const ref = useRef<HTMLElement>(null), wide = useMedia('(min-width:1480px)');
  useDialog(ref, { active: !wide, onEscape: close, restore: false });
  useEffect(() => { const key = (e: globalThis.KeyboardEvent) => { if (wide && e.key === 'Escape' && !document.querySelector('[aria-modal="true"], .info-pop')) close(); }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key); }, [wide, close]);
  useEffect(() => {
    const controller = new AbortController(); setTabError('');
    if (tab === 'Limits') void loadPolicy(a.id, controller.signal).then(setPolicy).catch((e: Error) => { if (e.name !== 'AbortError') setTabError(e.message); });
    if (tab === 'Connection') void loadKeys(a.id, controller.signal).then((p) => setKeys(p.keys)).catch((e: Error) => { if (e.name !== 'AbortError') setTabError(e.message); });
    return () => controller.abort();
  }, [tab, a.id]);
  const m = metrics?.[a.id], c = countsOf(a, data, metrics), perf = m?.performance, recent = (data.journals[a.id] ?? []).filter((e) => e.kind !== 'session_start').slice(0, 6), tabs = ['Activity', 'Limits', 'Performance', 'Connection'];
  const p = policy ?? data.details[a.id]?.policy;
  const limits: [string, number | undefined][] = [['Largest order', p?.maxPositionUsd], ...(flags.approvals ? [['Ask me above', p?.approvalAboveUsd] as [string, number | undefined]] : []), ['Stop for the day after losing', p?.maxDailyLossUsd]];
  return <><button className="insp-scrim" tabIndex={-1} aria-label="Close details" onClick={close} /><aside className="insp mission-insp" id="insp" ref={ref} tabIndex={-1} role={wide ? undefined : 'dialog'} aria-modal={wide ? undefined : true} aria-label={`${a.name} details`}>
    <div className="insp-bar"><span>Agent</span><a href={`/mission/agents/${a.id}`} className="iconbtn insp-expand" title="Open the full page" aria-label={`Expand: ${a.name} details`} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; e.preventDefault(); void expandTo(`/mission/agents/${a.id}`, ref.current ?? undefined); }}><IconExpand /><span>Expand</span></a><button className="iconbtn" onClick={close} aria-label="Close details"><IconX /></button></div>
    <div className="insp-id"><h2 className="ains-name">{a.name}</h2><span className="tags"><StatusPill agent={a} /></span></div><p className="insp-sub"><span>{m ? `${m.client} · ${m.venue}` : a.kind.replace('_', ' ')}</span><span>{a.status === 'disconnected' ? 'Disconnected' : a.lastSeen ? `Active ${agoText((now - Date.parse(a.lastSeen)) / 1000)}` : 'Waiting for first call'}</span></p>
    <div className="ains-acts">{flags.mission_kill && <>{a.status === 'active' ? <button className="btn btn-sm" onClick={() => act({ kind: 'pause', agent: a })}><IconPause />Pause</button> : a.status === 'soft_killed' ? <button className="btn btn-sm btn-primary" onClick={() => act({ kind: 'resume', agent: a })}><IconPlay />Resume</button> : <Link to="/mission/connect" className="btn btn-sm btn-primary">Reconnect</Link>}</>}{flags.policy_editor && <Link to={`/mission/agents/${a.id}?tab=limits`} className="btn btn-sm btn-ghost">Edit limits</Link>}{flags.mission_kill && a.status !== 'disconnected' && <button className="btn btn-sm btn-ghost ains-kill" onClick={() => act({ kind: 'disconnect', agent: a })}>Disconnect…</button>}</div>
    {m && <p className="ains-note">{m.note}</p>}{flags.unchecked_orders && data.unchecked.some((u) => u.agentId === a.id) && <p className="ag-flag">{a.uncheckedOrders24h} order placed without a check today</p>}
    <section className="insp-sec"><h3>Checks in the last 24 hours <b className="num">{c.total}</b></h3><PreflightBar c={c} /><OutcomeKey c={c} /><HourlyChart series={hourlyOf(a, data, metrics)} /></section>
    <div className="ains-tabs"><Tabs tabs={tabs} value={tab} onChange={setTab} label="Agent details" id={`agent-${a.id}`} /></div>{tabError && <p role="alert">{tabError}</p>}
    <TabPanel id={`agent-${a.id}`} index={0} active={tab === 'Activity'}><div className="ains-pane">{recent.length ? <ol className="jl-list">{recent.map((e) => <JournalLine key={e.id} entry={e} />)}</ol> : <p className="muted">No activity yet.</p>}<Link to={`/mission/agents/${a.id}`} className="insp-link">Open the full activity log</Link></div></TabPanel>
    <TabPanel id={`agent-${a.id}`} index={1} active={tab === 'Limits'}><div className="ains-pane"><p className="ains-lead"><b>{p?.mode ? riskModeLabel(p.mode) : 'Current'}</b> limits. {p?.blockPlaybookLevel === 'monitor' ? 'Danger and Monitor coins are blocked.' : p?.blockPlaybookLevel === 'danger' ? 'Danger coins are blocked.' : ''}</p><dl className="ains-kv">{limits.filter(([, v]) => v !== undefined).map(([label, v]) => <div key={label}><dt>{label}</dt><dd>{money(v!)}</dd></div>)}{policy?.maxRoundTripCostPct !== undefined && <div><dt>Highest exit cost</dt><dd>{policy.maxRoundTripCostPct}%</dd></div>}{policy?.minLiquidityUsd !== undefined && <div><dt>Lowest liquidity</dt><dd>{money(policy.minLiquidityUsd)}</dd></div>}{policy?.maxLeverage !== undefined && a.kind === 'perp_venue' && <div><dt>Highest leverage</dt><dd>{policy.maxLeverage}×</dd></div>}{policy?.earningsBlackoutDays !== undefined && a.kind === 'robinhood_mcp' && <div><dt>No trades before earnings</dt><dd>{policy.earningsBlackoutDays} days</dd></div>}<div><dt>Version</dt><dd>v{p?.version}</dd></div></dl>{flags.policy_editor && <Link to={`/mission/agents/${a.id}?tab=limits`} className="insp-link">Edit limits</Link>}</div></TabPanel>
    <TabPanel id={`agent-${a.id}`} index={2} active={tab === 'Performance'}><div className="ains-pane">{perf ? <><dl className="insp-kv"><div><dt>P&amp;L, 30 days</dt><dd className={perf.pnl30 >= 0 ? 'up' : ''}>{signed(perf.pnl30)}</dd></div><div><dt>Closed in profit</dt><dd>{perf.profitPct}% <span className="ains-of">of {perf.trades}</span></dd></div><div><dt>Average hold</dt><dd>{perf.hold}</dd></div><div><dt>Deepest drawdown</dt><dd>{signed(perf.maxDrawdown)}</dd></div></dl><ul className="ains-pos">{perf.positions.map((x) => <li key={x.symbol}><span>{x.symbol}</span><span className="num">{money(x.usd)}</span><span className={`num${x.pnl >= 0 ? ' up' : ''}`}>{signed(x.pnl)}</span></li>)}</ul></> : <p className="muted">Performance has not been reported.</p>}<p className="note">Past results don’t predict future ones. Not financial advice.</p><Link to={`/mission/agents/${a.id}?tab=performance`} className="insp-link">Open performance</Link></div></TabPanel>
    <TabPanel id={`agent-${a.id}`} index={3} active={tab === 'Connection'}><div className="ains-pane"><div className="insp-box ains-prot"><GuardBadge agent={a} /><p>{guardLine(a)}</p></div><dl className="ains-kv">{keys.map((key) => <div key={key.keyId}><dt>{key.kind === 'oauth' ? 'Signed in through' : 'Harness key'}</dt><dd>{key.revokedAt ? 'Revoked' : key.kind === 'oauth' ? key.clientName?.text ?? 'OAuth grant' : `${key.prefix}••••`}</dd></div>)}{keys[0]?.lastUsedAt && <div><dt>Last used</dt><dd>{agoText((now - Date.parse(keys[0].lastUsedAt)) / 1000)}</dd></div>}{m && <div><dt>Connected</dt><dd>{m.connectedOn}</dd></div>}</dl><Link to={`/mission/agents/${a.id}?tab=connection`} className="insp-link"><IconKey /> Manage keys</Link></div></TabPanel>
  </aside></>;
}
// TODO(spec): CA-18 does not freeze a hard kill-all response. Stop all uses reversible
// soft kill; individual hard stops follow the typed deeplink / confirmed transaction response.
export function KillConfirm({ action, close, refresh }: { action: MissionAction; close: () => void; refresh: () => Promise<void> }) {
  const [typed, setTyped] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [deeplink, setDeeplink] = useState<string | null>(null);
  const hard = action.kind === 'disconnect', a = action.kind !== 'stop-all' ? action.agent : undefined;
  const allowed = !hard || typed.trim().toLowerCase() === a?.name.toLowerCase();
  const run = async () => {
    if (!allowed || busy) return; setBusy(true); setError('');
    try {
      const result = await mutateMission(action);
      if (hard) {
        const response = HardKillSchema.parse(result);
        if (response.kind === 'deeplink') {
          const detail = await fetchParsed(`/agents/${encodeURIComponent(a!.id)}`, AgentDetailSchema);
          if (detail.status !== 'disconnected') throw new Error('Keys have not been revoked yet. Check the agent status and try again.');
          await refresh(); setDeeplink(response.url);
        }
        else {
          const [{ sendTransaction, waitForTransactionReceipt }, { wagmiConfig, walletChainId }] = await Promise.all([import('wagmi/actions'), import('../../lib/wallet')]);
          const chainId = walletChainId(response.tx.chainId);
          const hash = await sendTransaction(wagmiConfig, { ...response.tx, value: BigInt(response.tx.value), chainId });
          const receipt = await waitForTransactionReceipt(wagmiConfig, { hash, chainId });
          if (receipt.status !== 'success') throw new Error('Revocation reverted. The agent has not been disconnected.');
          await refresh(); close();
        }
      } else { await refresh(); close(); }
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return <MissionDialog title={deeplink ? 'Harness keys revoked' : action.kind === 'stop-all' ? 'Stop all agents' : `${action.kind === 'pause' ? 'Pause' : action.kind === 'resume' ? 'Resume' : 'Disconnect'} ${a?.name}`} close={busy ? () => {} : close} footer={deeplink ? <><a className="btn" href={deeplink} target="_blank" rel="noreferrer">{a?.kind === 'robinhood_mcp' ? 'Open Robinhood' : 'Open connection settings'}</a><button className="btn btn-primary" onClick={close}>{a?.kind === 'robinhood_mcp' ? 'I’ve disconnected it in Robinhood' : 'Done'}</button></> : <><button className="btn btn-ghost" disabled={busy} onClick={close}>Cancel</button><button className="btn btn-danger" disabled={!allowed || busy} onClick={() => void run()}>{busy ? 'Working…' : action.kind === 'stop-all' ? 'Pause all agents' : hard ? 'Revoke keys' : action.kind === 'pause' ? 'Confirm pause' : 'Confirm resume'}</button></>}>
    {deeplink ? <p>{a?.kind === 'robinhood_mcp' ? 'Harness keys revoked. Open Robinhood to disconnect this agent there too. Your confirmation is a note for you; EKO can’t see Robinhood’s side.' : a?.kind === 'perp_venue' ? 'Harness keys revoked. Delete the agent’s trade-only key in the perp venue to stop it trading there too.' : 'Harness keys revoked. This agent is disconnected from EKO.'}</p> : <>{hard ? <><p>EKO revokes this agent’s harness keys. {a?.kind === 'onchain' ? 'If on-chain permission must be revoked, your wallet signs a transaction. It is complete only after confirmation.' : a?.kind === 'perp_venue' ? 'Delete its trade-only key in the perp venue to stop it trading there too.' : 'This doesn’t disconnect the agent from Robinhood. You’ll do that in Robinhood next.'}</p><label className="field"><span>Type {a?.name} to confirm</span><input className="input" autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} /></label></> : <p>{action.kind === 'resume' ? 'Preflights will be checked against this agent’s limits again.' : 'Every preflight will return deny, and the agent will be told to stop. Pause is reversible; resume agents whenever you like.'}</p>}{a && <p className="note">{guardLine(a)}</p>}{action.kind === 'stop-all' && <p className="note">Advisory agents must follow the instruction. EKO can’t block orders sent directly to Robinhood or a perp venue.</p>}</>}{error && <p role="alert">{error}</p>}
  </MissionDialog>;
}

export function MissionOverview({ data, flags, metrics, previousChecks, onRefresh = async () => {}, onApproval = () => {} }: { data: MissionSnapshot; flags: Partial<Flags>; metrics?: Metrics; previousChecks?: number; onRefresh?: () => Promise<void>; onApproval?: (a: Approval) => void }) {
  const now = useNow(), wide = useMedia('(min-width:1480px)'), [filter, setFilter] = useState('All'), [action, setAction] = useState<MissionAction | null>(null);
  const limit = useShell((s) => s.me?.entitlements.limits.agents);
  const [selected, setSelected] = useState<string | null>(() => { if (typeof matchMedia === 'undefined' || !matchMedia('(min-width:1480px)').matches) return null; try { const v = localStorage.getItem('eko.mc.sel'); return v === 'none' ? null : v ?? data.agents[0]?.id ?? null; } catch { return data.agents[0]?.id ?? null; } });
  const rows = useRef<HTMLUListElement>(null), select = (id: string | null) => { if (wide) { try { localStorage.setItem('eko.mc.sel', id ?? 'none'); } catch { /* optional storage */ } } setSelected(id); };
  const close = useCallback(() => { const back = rows.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]'); if (wide) { try { localStorage.setItem('eko.mc.sel', 'none'); } catch { /* optional */ } } setSelected(null); requestAnimationFrame(() => back?.focus()); }, [wide]);
  const agent = data.agents.find((a) => a.id === selected), running = data.agents.filter((a) => a.status === 'active' && !!a.lastSeen).length, paused = data.agents.filter((a) => a.status === 'soft_killed'), waiting = flags.approvals ? data.approvals.filter((a) => a.status === 'pending').sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt)) : [];
  const unchecked = flags.unchecked_orders ? data.unchecked.filter((u) => data.agents.find((a) => a.id === u.agentId)?.status !== 'disconnected') : [], uncheckedIds = [...new Set(unchecked.map((u) => u.agentId))];
  const n = waiting.length + uncheckedIds.length + paused.length, summary = [waiting.length && `${waiting.length} approval${waiting.length === 1 ? '' : 's'}`, uncheckedIds.length && `${uncheckedIds.length} order${uncheckedIds.length === 1 ? '' : 's'} without a check`, paused.length && `${paused.length} paused`].filter(Boolean).join(' · ');
  const counts = data.agents.map((a) => countsOf(a, data, metrics)), total = counts.reduce((n, c) => n + c.total, 0), denied = counts.reduce((n, c) => n + c.denied, 0), hours = Array.from({ length: 24 }, (_, h) => data.agents.reduce((n, a) => n + hourlyOf(a, data, metrics)[h], 0)), blockedHours = Array.from({ length: 24 }, (_, h) => data.agents.reduce((n, a) => { const c = countsOf(a, data, metrics); return n + hourlyOf(a, data, metrics)[h] * c.denied / Math.max(1, c.total); }, 0));
  const moneyReported = data.agents.every((a) => !!metrics?.[a.id]), exposure = data.agents.reduce((n, a) => n + (metrics?.[a.id]?.exposureUsd ?? 0), 0), pnl = data.agents.reduce((n, a) => n + (metrics?.[a.id]?.pnl24hUsd ?? 0), 0), pnl30 = Array.from({ length: 30 }, (_, d) => data.agents.reduce((n, a) => n + (metrics?.[a.id]?.performance.cumul[d] ?? 0), 0));
  const shown = data.agents.filter((a) => filter === 'All' || (filter === 'Running' ? a.status === 'active' : a.status === 'soft_killed'));
  const recent = Object.values(data.journals).flat().filter((e) => e.kind !== 'session_start').sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts)).slice(0, 6);
  const [copyMessage, setCopyMessage] = useState('');
  const copy = async (a: Agent) => { try { await navigator.clipboard.writeText(`Before every order, call EKO preflight with what you want to buy or sell, how much, and where. Follow the decision. If it needs approval, wait for the owner’s decision and re-check the same order. Report every order to the Flight Recorder. Agent: ${a.id}.`); setCopyMessage(`Instructions copied. Paste them into a new message to ${a.name}.`); } catch { setCopyMessage('Could not copy instructions. Check clipboard permissions and try again.'); } };
  return <div className={`with-insp${agent ? ' open' : ''}`}><div className="page mc mc3"><div className="page-head"><div><h1>Mission Control</h1><p>{MISSION_COPY.overviewIntro}</p></div><div className="mc-head-actions">{limit !== undefined && data.agents.filter(a => a.status !== 'disconnected').length >= limit ? <div className="mc-gate" role="note">Agent limit reached ({limit}). <Link to="/settings/plan">View your plan</Link></div> : <Link to="/mission/connect" className="btn btn-primary"><IconPlus />Connect an agent</Link>}{flags.mission_kill && <button className="btn mc-btn-kill" onClick={() => setAction({ kind: 'stop-all' })}><IconStop />Stop all agents</button>}</div></div>
    {!!data.unavailableJournals?.length && <p role="status">Activity journal is unavailable. Check counts are not reported.</p>}
    {data.agents.length === 0 ? <div className="mc-empty"><IconShieldGhost /><p>Connect your first agent.</p><Link to="/mission/connect" className="btn btn-primary">Connect an agent</Link></div> : <><div className="mc3-stack"><Collapsible id="mc-need" title="Needs you" count={n} summary={n ? summary : 'All clear'} className="mc-need">{n ? <ul className="ibx-list">{waiting.map((a) => <ApprovalRow key={a.id} approval={a} agent={data.agents.find((x) => x.id === a.agentId)} now={now} onUpdated={onApproval} />)}{uncheckedIds.map((id) => { const a = data.agents.find((a) => a.id === id)!, u = unchecked.find((u) => u.agentId === id)!; return <li key={id} className="ibx warn"><span className="ibx-ic"><IconX /></span><div className="ibx-body"><b>{a.name} placed an order without checking</b><span>{u.side === 'buy' ? 'Buy' : 'Sell'} {money(u.notionalUsd ?? 0)} of {u.instrument} at {metrics ? '10:41 ET today' : new Date(u.placedAt).toLocaleTimeString()}. Send it the instructions again{flags.mission_kill ? ', or pause it' : ''}.</span></div><div className="ibx-acts"><Link to={`/mission/agents/${id}`} className="btn btn-sm btn-ghost">Details</Link><button className="btn btn-sm" onClick={() => void copy(a)}><IconCopy />Copy instructions</button></div></li>; })}{paused.map((a) => <li key={a.id} className="ibx"><span className="ibx-ic"><IconPause /></span><div className="ibx-body"><b>{a.name} is paused</b><span>{flags.mission_kill ? 'Every order it asks about is blocked until you resume it.' : 'Every order it asks about is blocked while it is paused.'}</span></div>{flags.mission_kill && <div className="ibx-acts"><button className="btn btn-sm" onClick={() => setAction({ kind: 'resume', agent: a })} aria-label={`Resume ${a.name}`}><IconPlay />Resume</button></div>}</li>)}</ul> : <div className="ibx-clear"><IconCheck /><span><b>Nothing needs you.</b> Your agents are inside their limits.</span></div>}</Collapsible>
    <Collapsible id="mc-how" title="How Mission Control works" summary="Your agent asks · EKO checks · you decide" className="mc-how"><ol className="mc-how-steps"><li><span className="mc-how-n">1</span><div><b>Your agent asks first</b><p>Before every order it sends EKO a check: what it wants to buy or sell, how much, and where.</p></div></li><li><span className="mc-how-n">2</span><div><b>EKO checks your limits</b><p>The coin’s verdict, your order size and loss limits, and the venue.</p></div></li><li><span className="mc-how-n">3</span><div><b>You stay in charge</b><p>{flags.approvals ? 'Each check is allowed, blocked, or sent to you to approve.' : 'Each check is allowed or blocked.'}{flags.mission_kill ? ' You can pause any agent, or stop them all.' : ' You set the limits your agent checks against.'}</p></div></li></ol></Collapsible></div>
    {copyMessage && <p role="status">{copyMessage}</p>}
    <dl className="kband" aria-label="Last 24 hours"><div><dt>Agents running</dt><dd className="num">{running}<span className="kband-of"> of {limit ?? data.agents.length}</span></dd><dd className="kband-c">{paused.length ? `${paused.length} paused` : 'None paused'}</dd><dd className="kband-v" aria-hidden="true"><span className="kband-agents">{data.agents.map((a) => <i key={a.id} className={statusClass(a)} title={a.name} />)}</span></dd></div><div><dt>Checks, 24h</dt><dd className="num">{data.unavailableJournals?.length ? '—' : total.toLocaleString('en-US')}</dd><dd className="kband-c">{previousChecks ? <><span className="up">{Math.round((total / previousChecks - 1) * 100) >= 0 ? '+' : '−'}{Math.abs(Math.round((total / previousChecks - 1) * 100))}%</span> vs the day before</> : 'From the activity log'}</dd><dd className="kband-v"><MiniBars series={hours} height={30} label="Checks per hour, last 24 hours" /></dd></div><div><dt>Blocked</dt><dd className="num">{data.unavailableJournals?.length ? '—' : denied}</dd><dd className="kband-c">{Math.round(denied / Math.max(1, total) * 100)}% of checks{metrics ? ' · mostly Danger coins' : ''}</dd><dd className="kband-v"><MiniBars series={blockedHours} height={30} tone="warm" delay={120} label="Estimated blocked checks per hour, last 24 hours" /></dd></div><div><dt>Money at work</dt><dd className="num">{moneyReported ? money(exposure) : '—'}</dd><dd className="kband-c">{moneyReported ? <><span className={pnl >= 0 ? 'up' : ''}>{signed(pnl)}</span> today</> : 'Not reported'}</dd><dd className="kband-v">{moneyReported && <Spark series={pnl30} height={30} delay={240} label="Combined profit and loss, last 30 days" />}</dd></div></dl>
    <div className="sec-head"><h2 id="mc-agents-h">Your agents</h2><span className="sub">Select one to see its activity and limits</span><div className="end"><Seg options={['All', 'Running', 'Paused']} value={filter} onChange={setFilter} label="Show agents" /></div></div>{shown.length ? <ul className="alist" ref={rows} aria-labelledby="mc-agents-h" onKeyDown={onListKeys}>{shown.map((a, i) => <AgentRow key={a.id} agent={a} data={data} metrics={metrics} selected={a.id === selected} select={select} index={i} />)}</ul> : <div className="empty panel">No agents are {filter.toLowerCase()}.</div>}
    <div className="mc3-stack" style={{ marginTop: 32 }}><Collapsible id="mc-recent" title="Recent activity" summary="All agents, newest first" className="mc-recent"><div className="mc-recent-body">{recent.length ? <ol className="jl-list">{recent.map((e) => <JournalLine key={e.id} entry={e} agent={data.agents.find((a) => a.id === e.agentId)} compact={false} />)}</ol> : <p>No activity yet.</p>}</div></Collapsible><Collapsible id="mc-terms" title="What the terms mean" summary="Checks, limits, approvals, pause and disconnect" defaultOpen={false}><dl className="mc-terms">{TERMS.map(([term, definition]) => <div key={term}><dt>{term}</dt><dd>{definition}</dd></div>)}</dl></Collapsible></div></>}
    {action && flags.mission_kill && <KillConfirm action={action} close={() => setAction(null)} refresh={onRefresh} />}
  </div>{agent && <Inspector key={agent.id} agent={agent} data={data} flags={flags} metrics={metrics} now={now} close={close} act={setAction} />}</div>;
}
function IconShieldGhost() { return <svg className="mc-ghost" viewBox="0 0 80 80" role="img" aria-label="EKO ghost"><path d="M16 68V34a24 24 0 0 1 48 0v34l-8-6-8 6-8-6-8 6-8-6Z" fill="none" stroke="currentColor" /><circle cx="32" cy="33" r="2" fill="currentColor" /><circle cx="48" cy="33" r="2" fill="currentColor" /></svg>; }
export default function Agents() {
  const flags = useShell((s) => s.config?.flags), realtime = useShell((s) => s.realtime), [data, setData] = useState<MissionSnapshot>(emptyMission), [metrics, setMetrics] = useState<Metrics>(), [previous, setPrevious] = useState<number>(), [loading, setLoading] = useState(true), [error, setError] = useState(''), [authRequired, setAuthRequired] = useState(false);
  const refresh = useCallback(async () => { if (!flags) return; const snapshot = await loadMission(flags); setData(snapshot); setError(''); }, [flags]);
  useEffect(() => {
    if (!flags) return;
    const controller = new AbortController(); setLoading(true);
    void Promise.all([loadMission(flags, controller.signal), MOCKS ? import('../../mocks/demo/mission') : Promise.resolve(null)]).then(([snapshot, demo]) => { if (controller.signal.aborted) return; setData(snapshot); if (demo) { setMetrics(demo.demoMetrics); setPrevious(demo.previousChecks); } setError(''); }).catch((e: Error) => { if (e.name !== 'AbortError') { setError(e.message); setAuthRequired(e instanceof ApiError && e.status === 401); } }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [flags]);
  useEffect(() => {
    if (!realtime || !flags) return;
    const resync = async () => { await refresh(); };
    const off = realtime.subscribe('agents', (e) => {
      if (e.kind === 'agent') setData((s) => ({ ...s, agents: s.agents.some((a) => a.id === e.data.id) ? s.agents.map((a) => a.id === e.data.id ? e.data : a) : [...s.agents, e.data] }));
      if (e.kind === 'journal') setData((s) => ({ ...s, journals: { ...s.journals, [e.data.agentId]: [e.data, ...(s.journals[e.data.agentId] ?? []).filter((j) => j.id !== e.data.id)] } }));
      if (e.kind === 'preflight') {
        setData((s) => ({ ...s, agents: s.agents.map((a) => a.id === e.data.agentId && a.status === 'active' ? { ...a, lastSeen: new Date(e.ts).toISOString() } : a) }));
        setMetrics((s) => {
          if (!s?.[e.data.agentId]) return s;
          const m = s[e.data.agentId], hourly = [...m.hourly]; hourly[23]++;
          return { ...s, [e.data.agentId]: { ...m, hourly, preflights24h: m.preflights24h + 1,
            allowed: m.allowed + (e.data.decision === 'allow' ? 1 : 0), denied: m.denied + (e.data.decision === 'deny' ? 1 : 0),
            needsApproval: m.needsApproval + (e.data.decision === 'needs_approval' ? 1 : 0) } };
        });
        void refresh().catch((e: Error) => setError(e.message));
      }
    }, resync);
    const offApprovals = flags.approvals ? realtime.subscribe('approvals', (e) => setData((s) => ({ ...s, approvals: [e.data, ...s.approvals.filter((a) => a.id !== e.data.id)] })), resync) : () => {};
    return () => { off(); offApprovals(); };
  }, [flags, realtime, refresh]);
  useEffect(() => { if (!flags?.mission_kill) return; const key = (e: globalThis.KeyboardEvent) => { if (e.shiftKey && e.key.toLowerCase() === 'k' && !(e.target instanceof HTMLElement && e.target.closest('input,textarea,[contenteditable], [role="dialog"]'))) { e.preventDefault(); document.querySelector<HTMLButtonElement>('.mc-btn-kill')?.click(); } }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key); }, [flags?.mission_kill]);
  if (loading) return <div className="page mc mc3"><div className="skel" style={{ height: 240 }} role="status" aria-label="Loading agents" /></div>;
  // Signed out, the shell's connect card is the one action; a Retry button would only repeat the 401.
  if (error && !data.agents.length) return <div className="page mc mc3"><div className="page-head"><div><h1>Mission Control</h1><p>{MISSION_COPY.overviewIntro}</p></div></div>{!authRequired && <><p role="alert">{error}</p><button className="btn" onClick={() => void refresh().catch((e: Error) => setError(e.message))}>Retry</button></>}</div>;
  return <>{error && <p role="alert">{error}</p>}<MissionOverview data={data} flags={flags ?? {}} metrics={metrics} previousChecks={previous} onRefresh={refresh} onApproval={(a) => { setData((s) => ({ ...s, approvals: s.approvals.map((x) => x.id === a.id ? a : x) })); void refresh().catch((e: Error) => setError(e.message)); }} /></>;
}
