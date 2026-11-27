import { randomUUID } from 'node:crypto';
import { getAddress, isAddress } from 'viem';
import type { FastifyInstance } from 'fastify';
import type { AgentActivity, AgentCall } from '@eko/shared';
import { toUntrusted } from '@eko/untrusted';
import type { AgentRow, AgentStore } from './agents.js';
import type { Edge } from './service.js';
import { coinSummary } from './views.js';

/**
 * What an owner sees of their agent as it works (Mission Control's live activity): every MCP call made with one of the
 * agent's keys, in a line or two: the tool, the coin it asked about with EKO's verdict and score at that moment,
 * preflight's decision, a prepared trade's sizes, the note it journaled. Pushed at once to the owner's own sockets (the
 * private `agents` channel, kind `call`) and kept for the page's first read: the newest PER_AGENT calls per agent of the
 * MAX_AGENTS most recently active, in memory (a restart forgets them; decisions, orders and notes stay in the journal).
 * Nothing the agent sent is kept beyond that line: no arguments, never a key.
 */
export const PER_AGENT = 100, MAX_AGENTS = 5_000, NOTE_CHARS = 280;

/** Hands an account's event to its open sockets. Set by the realtime socket (ws.ts) once it is up. */
export type AccountDeliver = (accountId: string, ch: string, kind: string, data: unknown) => void;
/**
 * The bridge from the server's routes to the realtime socket's private channels: the server creates it and hangs it on
 * the app (`app.accountPush`), the socket sets `deliver` when it registers. Until then (or without a socket) pushes are
 * dropped and pages catch up over REST.
 */
export class AccountPush { deliver: AccountDeliver | null = null; push(accountId: string, ch: string, kind: string, data: unknown) { this.deliver?.(accountId, ch, kind, data); } }
declare module 'fastify' { interface FastifyInstance { accountPush?: AccountPush } }
/** The app's push bridge, created on first use. */
export function accountPush(app: FastifyInstance): AccountPush {
  if (!app.hasDecorator('accountPush')) app.decorate('accountPush', new AccountPush());
  return app.accountPush!;
}

const clip = (s: string, n: number) => s.length > n ? `${s.slice(0, n - 1)}…` : s;
const obj = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};

export class AgentActivityLog {
  private readonly byAgent = new Map<string, AgentCall[]>();
  constructor(private readonly edge: Edge, private readonly push?: AccountPush, private readonly now: () => number = () => Date.now()) {}

  /** The coin a call was about, with EKO's verdict and score now (memoised checks: no new work for a coin just read). */
  private coin(raw: unknown): AgentCall['coin'] | undefined {
    if (typeof raw !== 'string' || !isAddress(raw, { strict: false })) return undefined;
    const c = this.edge.tracker.coin(raw);
    if (!c) return { address: getAddress(raw) };
    let s: ReturnType<typeof coinSummary> | undefined;
    try { s = coinSummary(c, this.edge.assessment(c.token), this.edge.ctx()); } catch { s = undefined; }
    return { address: getAddress(c.token), ...(s?.symbol.text ? { symbol: s.symbol } : {}), ...(s ? { verdict: s.verdict } : {}),
      ...(s?.ekoScore ? { score: s.ekoScore.value, band: s.ekoScore.band } : {}) };
  }

  /** Summarise one call (never its raw arguments) and keep and push it. */
  record(agent: AgentRow, tool: string, args: Record<string, unknown>, result: { ok: true; out: unknown } | { ok: false; error: string }, ms: number): AgentCall {
    const out = result.ok ? obj(result.out) : {};
    const call: AgentCall = { id: randomUUID(), agentId: agent.id, ts: new Date(this.now()).toISOString(), tool: clip(tool, 40), ok: result.ok, ms: Math.max(0, Math.round(ms)) };
    if (!result.ok) call.error = clip(result.error, 240);
    const coin = this.coin(args.coin);
    if (coin) call.coin = coin;
    if (tool === 'preflight' && result.ok && typeof out.decision === 'string') {
      call.preflight = { decision: out.decision as 'allow', side: args.side === 'sell' ? 'sell' : 'buy', notionalUsd: Number(args.notionalUsd) || 0,
        reasons: (Array.isArray(out.reasons) ? out.reasons : []).slice(0, 5).map(r => clip(String(r), 300)) };
    }
    if (tool === 'trade_prepare' && result.ok && (out.status === 'ready' || out.status === 'approve_first')) {
      const q = obj(out.quote);
      call.trade = { status: out.status, side: args.side === 'sell' ? 'sell' : 'buy', amountUsd: Number(args.amountUsd) || 0,
        ...(typeof q.amountIn === 'string' ? { amountIn: q.amountIn } : {}), ...(typeof q.minOut === 'string' ? { minOut: q.minOut } : {}),
        ...(Array.isArray(out.approvals) ? { approvals: out.approvals.length } : {}) };
    }
    if (tool === 'journal' && result.ok && ['session_start', 'outcome', 'note'].includes(String(args.kind))) {
      const p = obj(args.payload), words = [p.text, p.note, p.reason, p.summary].find(v => typeof v === 'string') as string | undefined;
      call.journal = { kind: args.kind as 'note', ...(words ? { text: toUntrusted(clip(words, NOTE_CHARS), NOTE_CHARS) } : {}) };
    }
    const list = out.coins ?? out.launches ?? out.events ?? out.matches;
    if (Array.isArray(list)) call.results = list.length;
    const rows = this.byAgent.get(agent.id) ?? [];
    this.byAgent.delete(agent.id);
    rows.unshift(call);
    if (rows.length > PER_AGENT) rows.length = PER_AGENT;
    this.byAgent.set(agent.id, rows);
    while (this.byAgent.size > MAX_AGENTS) this.byAgent.delete(this.byAgent.keys().next().value!);
    this.push?.push(agent.accountId, 'agents', 'call', call);
    return call;
  }

  calls(agentId: string): AgentCall[] { return this.byAgent.get(agentId) ?? []; }
  forget(agentId: string) { this.byAgent.delete(agentId); }

  /**
   * The page's first read: the newest calls and the counts since `since` (the owner's midnight; at most 48 hours back).
   * Decisions, prepared trades and notes are counted from the journal, which outlives a restart; calls from memory.
   */
  activity(agents: AgentStore, agent: AgentRow, sinceRaw?: string): AgentActivity {
    const nowMs = this.now(), parsed = Date.parse(sinceRaw ?? ''), floor = nowMs - 48 * 3_600_000;
    const since = Number.isFinite(parsed) ? Math.min(nowMs, Math.max(floor, parsed)) : nowMs - 24 * 3_600_000;
    const calls = this.calls(agent.id), counted = agents.countsSince(agent.id, Math.floor(since / 1000));
    const inWindow = calls.filter(c => Date.parse(c.ts) >= since);
    const lastSeen = agent.lastSeen ? agent.lastSeen * 1000 : null, newest = calls[0] ? Date.parse(calls[0].ts) : null;
    const last = Math.max(lastSeen ?? -Infinity, newest ?? -Infinity);
    return { calls, lastCallAt: Number.isFinite(last) ? new Date(last).toISOString() : null, since: new Date(since).toISOString(),
      today: { calls: Math.max(inWindow.length, counted.checks + counted.prepared + counted.notes), ...counted } };
  }
}
