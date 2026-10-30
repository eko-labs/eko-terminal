import { MISSION_LABELS as L, MISSION_TEXT as T } from '../../copy/mission';
import { useState } from 'react';
import type { Agent, JournalEntry } from '@eko/shared';
import { Seg, UntrustedText, VerdictChip } from '../../components/ui';
import { IconFeed, IconShield, IconBolt, IconSearch } from '../../components/icons';
import { APPROVAL_UNAVAILABLE } from '../../copy';
import { MISSION_COPY as C } from '../../copy/mission';
import { Decision, guardLine, money, payloadOf } from './parts';

// Text-only, bounded traversal; agent input never becomes markup, links or instructions.
export function PayloadTree({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (typeof value === 'string') return <UntrustedText value={{ text: value.slice(0, 2048), truncated: value.length > 2048, flags: [] }} />;
  if (!value || typeof value !== 'object') return <span>{JSON.stringify(value) ?? 'null'}</span>;
  if (depth >= 6) return <span>…</span>;
  const entries = Object.entries(value).slice(0, 100);
  return <dl className="mc-payload">{entries.map(([key, v]) => <div key={key}><dt><UntrustedText value={{ text: key.slice(0, 2048), truncated: key.length > 2048, flags: [] }} /></dt><dd><PayloadTree value={v} depth={depth + 1} /></dd></div>)}</dl>;
}
export function JournalEntryRow({ entry: e, agent }: { entry: JournalEntry; agent: Agent }) {
  const p = payloadOf(e), check = e.kind === 'decision', Icon = check ? IconShield : e.kind === 'order' ? IconBolt : IconFeed;
  const title = p.symbol ? `${p.side === 'sell' ? e.kind === 'order' ? L.sold : L.sell : e.kind === 'order' ? L.bought : L.buy} ${p.usd === undefined ? '' : money(p.usd)} ${e.kind === 'order' ? L.of : ''}${p.symbol}${p.lev ? T.leverage(p.lev) : ''}` : p.text ?? e.kind.replace('_', ' ');
  return <li className={`mc-jr k-${p.kind ?? e.kind}${p.decision === 'deny' ? ' is-deny' : ''}`} data-journal-id={e.id}>
    <time className="mc-jr-time num" dateTime={e.ts}>{new Date(e.ts).toLocaleTimeString('en-GB')}</time><span className="mc-jr-node"><Icon /></span>
    <div className="mc-jr-body"><div className="mc-jr-head"><span className="mc-jr-kind">{e.kind === 'session_start' ? L.sessionStarted : check ? L.check : e.kind === 'order' ? L.order : L.agentNote}</span><span className="mc-jr-title">{title}</span><span className="mc-jr-dec"><Decision decision={p.decision} />{p.verdict && <VerdictChip level={p.verdict} />}</span></div>
      {p.reasons?.length ? <ul className="mc-jr-why">{p.reasons.map((reason, i) => <li key={i}>{reason}</li>)}</ul> : null}
      {(p.rule === 'approval_unavailable' || p.reasons?.includes('approval_unavailable')) && <p className="mc-jr-text">{APPROVAL_UNAVAILABLE}</p>}
      {p.detail && <p className="mc-jr-text">{p.detail}</p>}
      {check && <p className="mc-jr-text">{guardLine(agent)}</p>}
      <div className="mc-jr-meta"><span>{p.venue}</span>{p.policyVersion !== undefined && <span>{L.policyV2}{p.policyVersion}</span>}{e.preflightId && <span className="addr">{e.preflightId}</span>}</div>
      <details className="mc-jr-details"><summary>{L.details}</summary><p>{e.commitment ? L.committedOnChainAsAPrivateHash : L.privateCommitmentPending}</p><dl className="kv"><dt>{L.commitment}</dt><dd className="addr">{e.commitment || L.pending}</dd><dt>{L.sharing}</dt><dd>{e.share ? L.shared : L.privateToYou}</dd></dl><PayloadTree value={e.payload} /></details>
    </div>
  </li>;
}
const FILTERS = [L.all, L.checks, L.blocked, L.orders, L.approvals, L.warnings];
export function JournalTimeline({ entries, agent, loadMore, hasMore, busy = false }: { entries: JournalEntry[]; agent: Agent; loadMore: () => void; hasMore: boolean; busy?: boolean }) {
  const [kind, setKind] = useState<string>(L.all), [query, setQuery] = useState('');
  const rows = entries.filter((e) => { const p = payloadOf(e); return (kind === L.all || (kind === L.checks && e.kind === 'decision') || (kind === L.blocked && p.decision === 'deny') || (kind === L.orders && e.kind === 'order') || (kind === L.approvals && (p.kind === 'approval' || p.decision === 'needs_approval')) || (kind === L.warnings && ['unchecked', 'kill', 'revoke'].includes(p.kind ?? ''))) && (!query.trim() || (p.symbol ?? '').toLowerCase().includes(query.trim().toLowerCase().replace(/^\$/, ''))); });
  return <div><div className="mc-toolbar"><Seg options={FILTERS} value={kind} onChange={setKind} label={L.showJournalEntries} /><label className="mc-search"><IconSearch /><input placeholder={L.symbol} aria-label={L.filterBySymbol} value={query} onChange={(e) => setQuery(e.target.value)} /></label><span className="mc-live">{agent.status === 'active' ? L.liveNewEntriesAppearAtTheTop : agent.status === 'soft_killed' ? L.pausedNoNewEntries : L.disconnectedLogKept}</span></div>
    <section className="panel"><div className="panel-body" style={{ paddingTop: rows.length ? 14 : 0, paddingBottom: 6 }}><ol className="mc-journal">{rows.map((e) => <JournalEntryRow key={e.id} entry={e} agent={agent} />)}</ol>{!rows.length && <div className="empty">{L.noEntriesInThisWindow}</div>}{hasMore && <button className="btn btn-sm" disabled={busy} onClick={loadMore}>{busy ? L.loading : L.olderEntries}</button>}</div></section><p className="note">{L.showingTheLatest}{' '}{entries.length} {L.entries}{' '}{C.journalNote}</p></div>;
}
