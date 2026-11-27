import { describe, expect, it } from 'vitest';
import { AgentActivitySchema, AgentCallSchema, type AgentCall } from '@eko/shared';
import { ACTIVITY_CAP, applyCall, callLine, countCall, emptyActivity, emptyToday, linkStatus, localMidnight, mergeCalls } from './agentActivity';

const T0 = Date.parse('2026-11-27T12:00:00Z');
const COIN = '0xabababababababababababababababababababab';
const call = (n: number, extra: Partial<AgentCall> = {}): AgentCall => AgentCallSchema.parse({ id: `c${n}`, agentId: 'sample-agent', ts: new Date(T0 + n * 1000).toISOString(), tool: 'coin_verdict', ok: true, ...extra });

describe('agent activity model', () => {
  it('merges pushed calls with the loaded page once each, newest first, capped', () => {
    const page = [call(3), call(2), call(1)];
    expect(mergeCalls(page, [call(4), call(2)]).map((c) => c.id)).toEqual(['c4', 'c3', 'c2', 'c1']);
    const many = Array.from({ length: ACTIVITY_CAP + 20 }, (_, i) => call(i));
    const merged = mergeCalls([], many);
    expect(merged).toHaveLength(ACTIVITY_CAP);
    expect(merged[0]!.id).toBe(`c${ACTIVITY_CAP + 19}`);
  });
  it('counts today per kind of call: checks by decision, ready trades, notes', () => {
    let t = emptyToday();
    t = countCall(t, call(1));
    t = countCall(t, call(2, { tool: 'preflight', preflight: { decision: 'allow', side: 'buy', notionalUsd: 25, reasons: [] } }));
    t = countCall(t, call(3, { tool: 'preflight', preflight: { decision: 'deny', side: 'buy', notionalUsd: 900, reasons: ['Over the cap.'] } }));
    t = countCall(t, call(4, { tool: 'preflight', preflight: { decision: 'needs_approval', side: 'buy', notionalUsd: 300, reasons: [] } }));
    t = countCall(t, call(5, { tool: 'trade_prepare', trade: { status: 'ready', side: 'buy', amountUsd: 25 } }));
    t = countCall(t, call(6, { tool: 'trade_prepare', trade: { status: 'approve_first', side: 'sell', amountUsd: 25, approvals: 1 } }));
    t = countCall(t, call(7, { tool: 'journal', journal: { kind: 'note' } }));
    expect(t).toEqual({ calls: 7, checks: 3, allowed: 1, denied: 1, needsApproval: 1, prepared: 1, notes: 1 });
  });
  it('folds a pushed call in once, counting it only from since, and keeps the newest last call', () => {
    const since = new Date(T0).toISOString();
    let a = emptyActivity(since);
    a = applyCall(a, call(5, { tool: 'journal', journal: { kind: 'note' } }));
    expect(AgentActivitySchema.parse(a).today).toMatchObject({ calls: 1, notes: 1 });
    expect(applyCall(a, call(5))).toBe(a);
    const early = applyCall(a, call(-60));
    expect(early.calls.map((c) => c.id)).toEqual(['c5', 'c-60']);
    expect(early.today.calls).toBe(1);
    expect(early.lastCallAt).toBe(call(5).ts);
  });
  it('says connected within a minute of the last call, idle after, waiting before the first', () => {
    expect(linkStatus(null, T0)).toEqual({ state: 'waiting', label: 'Waiting for the first call' });
    expect(linkStatus(new Date(T0 - 4000).toISOString(), T0)).toEqual({ state: 'connected', label: 'Connected · last call 4s ago' });
    expect(linkStatus(new Date(T0 - 180_000).toISOString(), T0)).toEqual({ state: 'idle', label: 'Idle · last call 3m ago' });
    expect(linkStatus(new Date(T0 + 2000).toISOString(), T0).label).toBe('Connected · last call just now');
  });
  it('describes each call in plain words', () => {
    expect(callLine(call(1, { tool: 'preflight', coin: { address: COIN, score: 78, band: 'ok', verdict: 'clear' }, preflight: { decision: 'deny', side: 'buy', notionalUsd: 600, reasons: ['$600 is over the policy\'s $500 cap.'] } })))
      .toEqual({ title: 'Buy $600: blocked', detail: '$600 is over the policy\'s $500 cap.' });
    expect(callLine(call(2, { tool: 'trade_prepare', trade: { status: 'ready', side: 'buy', amountUsd: 25 } })).title).toBe('Prepared a $25 buy');
    expect(callLine(call(3, { tool: 'coins', results: 12 })).title).toBe('Listed coins: 12 coins');
    expect(callLine(call(4, { tool: 'watch', results: 1 })).title).toBe('Watched for events: 1 event');
    expect(callLine(call(5, { ok: false, error: 'coin must be a token address.' }))).toEqual({ title: 'Checked a coin: failed', detail: 'coin must be a token address.' });
    expect(callLine(call(6, { tool: 'journal', journal: { kind: 'session_start' } })).title).toBe('Started a session');
  });
  it('starts today at the viewer\'s local midnight', () => {
    const m = new Date(localMidnight(T0));
    expect(m.getHours()).toBe(0); expect(m.getMinutes()).toBe(0);
    expect(T0 - m.getTime()).toBeLessThan(86_400_000);
  });
});
