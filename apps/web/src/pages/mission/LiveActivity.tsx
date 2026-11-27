import { useEffect, useRef, useState } from 'react';
import type { AgentActivity, AgentCall } from '@eko/shared';
import { ApiError } from '../../lib/api';
import { loadActivity } from '../../lib/mission';
import { applyCall, BAND_LABEL, callLine, emptyActivity, linkStatus, localMidnight } from '../../lib/agentActivity';
import { useShell } from '../../store/shell';
import { LedMatrix } from '../../components/ui/Led';
import { UntrustedText, VerdictChip } from '../../components/ui';
import { AGENT_LIVE as LIVE } from '../../copy/mission';
import { Decision } from './parts';

/** A new row's sparkle plays this long, then the row is like the others. */
const FRESH_MS = 4000;

/** The status line: a blue pulse while the agent is calling (last call under a minute ago), a still dot when idle. */
export function LinkLine({ lastCallAt, now }: { lastCallAt: string | null; now: number }) {
  const s = linkStatus(lastCallAt, now);
  return <p className={`mc-link-status is-${s.state}`} role="status">{s.state === 'connected' ? <LedMatrix pattern="pulse" size={14} /> : <i className="mc-link-dot" aria-hidden="true" />}<span>{s.label}</span></p>;
}

function CallRow({ call, fresh }: { call: AgentCall; fresh: boolean }) {
  const line = callLine(call), c = call.coin;
  return <li className={`mc-call${call.ok ? '' : ' is-error'}${fresh ? ' is-fresh' : ''}`} data-call-id={call.id}>
    <time className="num" dateTime={call.ts}>{new Date(call.ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
    <span className="mc-call-led">{fresh ? <LedMatrix pattern="sparkle" size={14} cycles={3} /> : <i aria-hidden="true" />}</span>
    <span className="mc-call-body">
      <span className="mc-call-top"><code className="mc-call-tool">{call.tool}</code><b>{line.title}</b></span>
      {c && <span className="mc-call-coin">{c.symbol ? <span className="mc-call-sym">$<UntrustedText value={c.symbol} /></span> : <span className="mc-call-sym addr">{c.address.slice(0, 6)}…{c.address.slice(-4)}</span>}
        {c.score !== undefined && c.band && <span className={`mc-score band-${c.band}`}>{LIVE.score(c.score, BAND_LABEL[c.band] ?? c.band)}</span>}
        {c.verdict && <VerdictChip level={c.verdict} />}</span>}
      {line.detail && <span className="mc-call-why">{line.detail}</span>}
      {call.journal?.text && <span className="mc-call-note"><UntrustedText value={call.journal.text} /></span>}
    </span>
    {call.preflight && <Decision decision={call.preflight.decision} />}
  </li>;
}

const COUNTS: [keyof AgentActivity['today'], string][] = [['calls', LIVE.calls], ['checks', LIVE.checks], ['allowed', LIVE.allowed], ['denied', LIVE.denied], ['needsApproval', LIVE.needsApproval], ['prepared', LIVE.prepared], ['notes', LIVE.notes]];

/** The live activity panel itself (pure: the loader below feeds it). */
export function LiveActivityPanel({ activity, now, fresh = new Set(), unavailable = false }: { activity: AgentActivity; now: number; fresh?: ReadonlySet<string>; unavailable?: boolean }) {
  return <section className="panel mc-liveact" aria-label={LIVE.live}>
    <div className="panel-head"><h3>{LIVE.live}</h3><LinkLine lastCallAt={activity.lastCallAt} now={now} /></div>
    <div className="panel-body">
      <p className="note">{unavailable ? LIVE.unavailable : LIVE.liveNote}</p>
      <dl className="mc-today" aria-label={LIVE.today}>{COUNTS.map(([k, label]) => <div key={k}><dt>{label}</dt><dd className="num">{activity.today[k]}</dd></div>)}</dl>
      {activity.calls.length ? <ol className="mc-calls">{activity.calls.slice(0, 30).map((c) => <CallRow key={c.id} call={c} fresh={fresh.has(c.id)} />)}</ol> : !unavailable && <p className="mc-calls-empty">{LIVE.none}</p>}
    </div>
  </section>;
}

/** Loads the agent's activity since local midnight, then folds in every call its owner's `agents` socket pushes. */
export function LiveActivity({ agentId, now }: { agentId: string; now: number }) {
  const rt = useShell((s) => s.realtime);
  const [activity, setActivity] = useState<AgentActivity>(() => emptyActivity(localMidnight(Date.now())));
  const [unavailable, setUnavailable] = useState(false), [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => () => { for (const t of timers.current) clearTimeout(t); }, []);
  useEffect(() => {
    const c = new AbortController(), since = localMidnight(Date.now());
    const load = async () => {
      try {
        const page = await loadActivity(agentId, since, c.signal);
        if (!c.signal.aborted) { setActivity((old) => old.calls.reduce(applyCall, page)); setUnavailable(false); }
      } catch (e) {
        if (c.signal.aborted || (e as Error).name === 'AbortError') return;
        if (e instanceof ApiError && e.status === 404) setUnavailable(true);
      }
    };
    void load();
    const off = rt?.subscribe('agents', (e) => {
      if (e.kind !== 'call' || e.data.agentId !== agentId) return;
      const id = e.data.id;
      setActivity((a) => applyCall(a, e.data));
      setFresh((s) => new Set(s).add(id));
      const t = setTimeout(() => { timers.current.delete(t); setFresh((s) => { const n = new Set(s); n.delete(id); return n; }); }, FRESH_MS);
      timers.current.add(t);
    }, load);
    return () => { c.abort(); off?.(); };
  }, [rt, agentId]);
  return <LiveActivityPanel activity={activity} now={now} fresh={fresh} unavailable={unavailable} />;
}
