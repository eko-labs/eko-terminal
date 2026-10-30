import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Agent, Approval, JournalEntry } from '@eko/shared';
import { IconAlert, IconCheck, IconPause, IconShield, IconX, IconBolt, IconFeed } from '../../components/icons';
import { useDialog } from '../../components/onboarding/useDialog';
import { ADVISORY, ENFORCED_ONCHAIN, ONCHAIN_ADVISORY, APPROVAL_UNAVAILABLE } from '../../copy';
import { decideApproval } from '../../lib/mission';
import { ApiError, fetchParsed } from '../../lib/api';
import { VerdictSchema } from '@eko/shared';
import { VerdictChip } from '../../components/ui';
import { ApprovalSchema } from '@eko/shared';
import { serverNow } from '../../lib/clock';
import { Link } from '../../lib/Link';
import type { JournalPayload } from '../../mocks/demo/mission';

export const money = (n: number, dp?: number) => `${n < 0 ? '−' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: dp ?? (n % 1 && Math.abs(n) < 1000 ? 2 : 0), maximumFractionDigits: dp ?? (Math.abs(n) < 1000 ? 2 : 0) })}`;
export const signed = (n: number) => n > 0 ? `+${money(n, 2)}` : n < 0 ? money(n, 2) : '$0.00';
export const agoText = (sec: number) => sec < 5 ? 'just now' : sec < 60 ? `${Math.round(sec)}s ago` : sec < 3600 ? `${Math.floor(sec / 60)}m ago` : sec < 86400 ? `${Math.floor(sec / 3600)}h ${Math.floor(sec % 3600 / 60)}m ago` : `${Math.floor(sec / 86400)}d ago`;
export const statusClass = (a: Agent) => a.status === 'soft_killed' ? 'paused' : a.status === 'disconnected' ? 'revoked' : 'active';
export const isEnforced = (a: Agent) => a.kind === 'onchain' && a.guardrails === 'enforced';
export function guardLine(a: Agent) { return isEnforced(a) ? ENFORCED_ONCHAIN : a.kind === 'onchain' ? ONCHAIN_ADVISORY : a.kind === 'perp_venue' ? 'Advisory: your agent is instructed to check this policy before every order. EKO can’t block orders on the perp venue itself.' : ADVISORY; }
export function GuardBadge({ agent }: { agent: Agent }) { return <span className="tag mc-guard" title={guardLine(agent)}>{isEnforced(agent) && <IconShield />}{isEnforced(agent) ? 'Enforced' : 'Advisory'}</span>; }
export function StatusPill({ agent }: { agent: Agent }) {
  return <span className={`mc-pill ${statusClass(agent)}`}>{agent.status === 'soft_killed' ? <IconPause /> : agent.status === 'disconnected' ? <IconX /> : <i className="mc-pill-dot" aria-hidden="true" />}{agent.status === 'soft_killed' ? 'Paused' : agent.status === 'disconnected' ? 'Disconnected' : agent.lastSeen ? 'Running' : 'Waiting for first call'}</span>;
}
export interface Counts { total: number; allowed: number; denied: number; approval: number }
export function PreflightBar({ c, height = 6 }: { c: Counts; height?: number }) {
  const total = c.allowed + c.denied + c.approval || 1;
  return <div className="mc-pbar" style={{ height }} role="img" aria-label={`${c.allowed} allowed, ${c.approval} needed approval, ${c.denied} denied`}><i className="allow" style={{ width: `${c.allowed / total * 100}%` }} /><i className="ask" style={{ width: `${c.approval / total * 100}%` }} /><i className="deny" style={{ width: `${c.denied / total * 100}%` }} /></div>;
}
export function OutcomeKey({ c }: { c: Counts }) { return <ul className="mc-okey"><li className="allow"><IconCheck /><b className="num">{c.allowed}</b> allowed</li><li className="deny"><IconX /><b className="num">{c.denied}</b> blocked</li><li className="ask"><IconAlert /><b className="num">{c.approval}</b> sent to you</li></ul>; }
export function Decision({ decision }: { decision?: string }) {
  if (!decision) return null;
  const label = ({ allow: 'Allowed', deny: 'Blocked', needs_approval: 'Needs approval', approved: 'Approved', denied: 'Denied', expired: 'Expired' } as Record<string, string>)[decision];
  if (!label) return null;
  const blocked = ['deny', 'denied', 'expired'].includes(decision), ask = decision === 'needs_approval';
  return <span className={`mc-dec ${blocked ? 'deny' : ask ? 'ask' : 'allow'}`}>{blocked ? <IconX /> : ask ? <IconAlert /> : <IconCheck />}{label}</span>;
}
// Agent payloads are unknown. Read only typed scalar fields, never interpret HTML or instructions.
export function payloadOf(entry: JournalEntry): JournalPayload {
  const p = entry.payload;
  if (!p || typeof p !== 'object' || Array.isArray(p)) return { text: String(p ?? '').slice(0, 2048) };
  const raw = p as Record<string, unknown>, out: Record<string, unknown> = {};
  for (const key of ['kind', 'side', 'symbol', 'decision', 'text', 'detail', 'rule', 'fill', 'venue']) if (typeof raw[key] === 'string') out[key] = raw[key].slice(0, 2048);
  for (const key of ['usd', 'lev', 'policyVersion']) if (typeof raw[key] === 'number' && Number.isFinite(raw[key])) out[key] = raw[key];
  if (Array.isArray(raw.reasons)) out.reasons = raw.reasons.filter((x): x is string => typeof x === 'string').slice(0, 20).map((x) => x.slice(0, 2048));
  const senses = raw.senses && typeof raw.senses === 'object' ? (raw.senses as Record<string, unknown>).verdict : undefined;
  const candidate = raw.verdict ?? senses;
  const level = candidate && typeof candidate === 'object' ? (candidate as Record<string, unknown>).level : candidate;
  const parsed = VerdictSchema.shape.level.safeParse(level);
  if (parsed.success) out.verdict = parsed.data;
  return out as JournalPayload;
}
export function JournalLine({ entry, agent, compact = true }: { entry: JournalEntry; agent?: Agent; compact?: boolean }) {
  const p = payloadOf(entry), isCheck = entry.kind === 'decision', Icon = isCheck ? IconShield : entry.kind === 'order' ? IconBolt : IconFeed;
  const title = p.symbol ? `${p.side === 'sell' ? entry.kind === 'order' ? 'Sold' : 'Sell' : entry.kind === 'order' ? 'Bought' : 'Buy'} ${p.usd === undefined ? '' : money(p.usd)} ${entry.kind === 'order' ? 'of ' : ''}${p.symbol}${p.lev ? ` at ${p.lev}×` : ''}` : p.text || entry.kind.replace('_', ' ');
  return <li className={`jl ${p.decision === 'deny' ? 'is-deny' : ''}${compact ? '' : ' recent-line'}`}><time className="num" dateTime={entry.ts}>{new Date(entry.ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</time><span className="jl-ic"><Icon /></span><span className="jl-t">{agent && <span className="jl-agent"><Link to={`/mission/agents/${agent.id}`}>{agent.name}</Link> · {isCheck ? 'Check' : entry.kind === 'order' ? 'Order' : 'Agent note'}</span>}{title}{p.decision && p.decision !== 'allow' && <span className="jl-why">{p.reasons?.[0]}</span>}{p.rule === 'approval_unavailable' && <span className="jl-why">{APPROVAL_UNAVAILABLE}</span>}{!compact && <><span className="jl-why">{p.reasons?.slice(p.decision === 'allow' ? 0 : 1).join(' · ')}</span><span className="jl-meta">{p.venue} {p.policyVersion ? `· Limits v${p.policyVersion}` : ''}</span><details className="jl-proof"><summary>Details</summary><span>Private commitment: {entry.commitment || 'Pending'}</span><span>{entry.share ? 'Shared' : 'Private'}</span></details></>}</span>{p.verdict && <VerdictChip level={p.verdict} />}{p.kind === 'unchecked' ? <span className="tag warn">Flagged</span> : <Decision decision={p.decision} />}</li>;
}
export function useApprovalDecision(a: Approval, now: number, onUpdated: (a: Approval) => void) {
  const [confirm, setConfirm] = useState<'approved' | 'denied' | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const key = useRef<string | null>(null), left = Math.max(0, Math.ceil((Date.parse(a.expiresAt) - now) / 1000));
  const run = async () => {
    if (!confirm || busy || left === 0 || a.status !== 'pending') return;
    setBusy(true); setError(''); key.current ??= crypto.randomUUID();
    try { onUpdated(await decideApproval(a.id, confirm, key.current)); setConfirm(null); }
    catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        try { onUpdated(await fetchParsed(`/approvals/${encodeURIComponent(a.id)}`, ApprovalSchema)); setConfirm(null); } catch (reload) { setError((reload as Error).message); }
      } else setError((e as Error).message);
    } finally { setBusy(false); }
  };
  return { confirm, setConfirm: (v: 'approved' | 'denied' | null) => { key.current = null; setConfirm(v); }, busy, error, left, run };
}
export function ApprovalRow({ approval: a, agent, now, onUpdated }: { approval: Approval; agent?: Agent; now: number; onUpdated: (a: Approval) => void }) {
  const { confirm, setConfirm, busy, error, left, run } = useApprovalDecision(a, now, onUpdated), order = a.detail?.order;
  return <li className="ibx"><span className="ibx-ic"><IconAlert /></span><div className="ibx-body"><b>{order ? <>{`${agent?.name ?? 'Agent'} wants to ${order.side} ${money(order.notionalUsd ?? a.detail?.notionalUsd ?? 0)} of `}<span className="ibx-sym">{order.instrument}</span></> : a.summary}</b><span>{a.detail?.reasons.join('. ')}.</span>{error && <span role="alert">{error}</span>}</div><div className="ibx-acts">{a.status !== 'pending' || !left ? <span className="ibx-note">{a.status === 'pending' ? 'Expired. The agent was told no.' : `Decided elsewhere: ${a.status}.`}</span> : confirm ? <><span className="ibx-ask">{confirm === 'approved' ? 'Approve' : 'Deny'} {order?.instrument}?</span><button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setConfirm(null)}>Back</button><button className={`btn btn-sm ${confirm === 'approved' ? 'btn-primary' : 'btn-danger'}`} autoFocus disabled={busy} onClick={() => void run()}>{busy ? 'Working…' : confirm === 'approved' ? 'Confirm' : 'Confirm deny'}</button></> : <><span className="ibx-left num" title="If you don’t answer in time, the agent is told no">{Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')} left</span><span className="ibx-buttons"><Link to="/mission/approvals" className="btn btn-sm btn-ghost">Details</Link><button className="btn btn-sm" onClick={() => { setConfirm('denied'); }} aria-label={`Deny: ${agent?.name}, ${order?.instrument}`}>Deny</button><button className="btn btn-sm btn-primary" onClick={() => { setConfirm('approved'); }} aria-label={`Approve: ${agent?.name}, ${order?.instrument}`}>Approve</button></span></>}</div></li>;
}
export function MissionDialog({ title, close, children, footer }: { title: string; close: () => void; children: ReactNode; footer: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null); useDialog(ref, { onEscape: close });
  return <div className="mc-modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) close(); }}><div className="mc-modal" ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="mission-dialog-title"><h2 id="mission-dialog-title">{title}</h2>{children}<div className="mc-modal-footer">{footer}</div></div></div>;
}
export const TERMS = [
  ['Check (preflight)', 'What an agent sends EKO before an order: what, how much and where. EKO answers allowed, blocked, or needs your approval.'],
  ['Limits (policy)', 'The rules checks are measured against: order size, daily loss and which verdicts to block. Start from a preset.'],
  ['Needs approval', 'An order above your approval limit. It waits for you here; if you don’t answer before it expires, the agent is told no.'],
  ['Advisory or enforced', 'Advisory: the agent is expected to follow EKO’s answer. Enforced: an on-chain session-key policy enforces the limits.'],
  ['Order without a check', 'An order the agent reported that never asked EKO first. Worth a look: it means the agent skipped the step.'],
  ['Pause or disconnect', 'Pause makes every preflight return deny until you resume. Disconnect revokes the agent’s EKO keys. Robinhood-connected agents must also be disconnected in Robinhood.'],
  ['Activity log (Flight Recorder)', 'Every check, order and decision, kept private to you and committed on-chain as a hash.'],
];
export function useNow() { const [now, setNow] = useState(serverNow); useEffect(() => { const timer = setInterval(() => setNow(serverNow()), 1000); return () => clearInterval(timer); }, []); return now; }
