import type { AgentActivity, AgentCall } from '@eko/shared';

/**
 * Mission Control's live activity for one agent: the calls it made to EKO's MCP server with its key, newest first, as
 * GET /v1/agents/:id/activity returns them and as the owner's `agents` socket pushes each new one (kind `call`). Pure:
 * the agent page keeps an AgentActivity in state and folds every pushed call in with `applyCall`.
 */
export const ACTIVITY_CAP = 100;
/** An agent that called within this long reads as connected; after it, idle. */
export const CONNECTED_MS = 60_000;
export type Today = AgentActivity['today'];
export const emptyToday = (): Today => ({ calls: 0, checks: 0, allowed: 0, denied: 0, needsApproval: 0, prepared: 0, notes: 0 });
export const emptyActivity = (since: string): AgentActivity => ({ calls: [], lastCallAt: null, since, today: emptyToday() });

/** The viewer's local midnight, as the `since` the counts for today start from. */
export function localMidnight(now: number): string {
  const d = new Date(now); d.setHours(0, 0, 0, 0); return d.toISOString();
}

/** Calls from both lists, each once (by id), newest first, at most `cap`. */
export function mergeCalls(list: readonly AgentCall[], incoming: readonly AgentCall[], cap = ACTIVITY_CAP): AgentCall[] {
  const byId = new Map<string, AgentCall>();
  for (const c of [...incoming, ...list]) if (!byId.has(c.id)) byId.set(c.id, c);
  return [...byId.values()].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts)).slice(0, cap);
}

/** Today's counts with one more call added. */
export function countCall(today: Today, call: AgentCall): Today {
  const next = { ...today, calls: today.calls + 1 };
  if (call.tool === 'preflight' && call.preflight) {
    next.checks++;
    if (call.preflight.decision === 'allow') next.allowed++;
    else if (call.preflight.decision === 'deny') next.denied++;
    else next.needsApproval++;
  }
  if (call.tool === 'trade_prepare' && call.trade?.status === 'ready') next.prepared++;
  if (call.tool === 'journal' && call.ok) next.notes++;
  return next;
}

/** The activity with a pushed call folded in: a call already listed changes nothing; one from before `since` is listed but not counted. */
export function applyCall(a: AgentActivity, call: AgentCall): AgentActivity {
  if (a.calls.some((c) => c.id === call.id)) return a;
  const last = a.lastCallAt && Date.parse(a.lastCallAt) > Date.parse(call.ts) ? a.lastCallAt : call.ts;
  return { ...a, calls: mergeCalls(a.calls, [call]), lastCallAt: last, today: Date.parse(call.ts) >= Date.parse(a.since) ? countCall(a.today, call) : a.today };
}

const ago = (sec: number) => sec < 2 ? 'just now' : sec < 60 ? `${Math.round(sec)}s ago` : sec < 3600 ? `${Math.floor(sec / 60)}m ago` : sec < 86400 ? `${Math.floor(sec / 3600)}h ago` : `${Math.floor(sec / 86400)}d ago`;
export type LinkState = 'connected' | 'idle' | 'waiting';
/** "Connected · last call 4s ago" within a minute of the last call, "Idle · last call 3m ago" after it, or waiting for the first. */
export function linkStatus(lastCallAt: string | null, now: number): { state: LinkState; label: string } {
  if (!lastCallAt) return { state: 'waiting', label: 'Waiting for the first call' };
  const ms = Math.max(0, now - Date.parse(lastCallAt)), when = `last call ${ago(ms / 1000)}`;
  return ms < CONNECTED_MS ? { state: 'connected', label: `Connected · ${when}` } : { state: 'idle', label: `Idle · ${when}` };
}

/** What each tool is, in plain words. */
export const TOOL_LABEL: Readonly<Record<string, string>> = {
  coin_verdict: 'Checked a coin', coin_card: 'Read a coin card', playbook_match: 'Read the risk checks', deployer_history: 'Looked up a dev',
  new_launches: 'Listed new launches', coins: 'Listed coins', watch: 'Watched for events', preflight: 'Asked before an order',
  trade_prepare: 'Prepared a trade', journal: 'Wrote to the journal',
};
const usd = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: n < 100 ? 2 : 0 })}`;
const DECISION: Record<string, string> = { allow: 'allowed', deny: 'blocked', needs_approval: 'sent to you for approval' };

/** One call as a title and an optional plain detail line (coin names are shown beside it, as untrusted text). */
export function callLine(call: AgentCall): { title: string; detail?: string } {
  const base = TOOL_LABEL[call.tool] ?? call.tool.replaceAll('_', ' ');
  if (!call.ok) return { title: `${base}: failed`, ...(call.error ? { detail: call.error } : {}) };
  if (call.preflight) {
    const p = call.preflight;
    return { title: `${p.side === 'buy' ? 'Buy' : 'Sell'} ${usd(p.notionalUsd)}: ${DECISION[p.decision] ?? p.decision}`, ...(p.reasons.length ? { detail: p.reasons.slice(0, 2).join(' · ') } : {}) };
  }
  if (call.trade) {
    const t = call.trade;
    return t.status === 'approve_first'
      ? { title: `Prepared ${t.approvals ?? 1} approval${(t.approvals ?? 1) === 1 ? '' : 's'} for a ${usd(t.amountUsd)} ${t.side}`, detail: 'Unsigned. The agent signs and sends from its own wallet.' }
      : { title: `Prepared a ${usd(t.amountUsd)} ${t.side}`, detail: 'Unsigned transaction. EKO never signs or sends.' };
  }
  if (call.journal) return { title: call.journal.kind === 'session_start' ? 'Started a session' : call.journal.kind === 'outcome' ? 'Wrote an outcome' : 'Wrote a note' };
  if (call.results !== undefined) return { title: `${base}: ${call.results} ${call.tool === 'watch' ? `event${call.results === 1 ? '' : 's'}` : `coin${call.results === 1 ? '' : 's'}`}` };
  return { title: base };
}

/** The score's band in the site's words. */
export const BAND_LABEL: Readonly<Record<string, string>> = { ok: 'OK', careful: 'Careful', danger: 'Danger' };
