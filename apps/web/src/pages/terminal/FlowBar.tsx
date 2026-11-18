import type { Flow, FlowActivity } from '@eko/shared';
import { NOT_CHECKED } from '../../copy/availability';

/** Compact USD for flow figures: $0, <$1, $640, $4.2K, $38K, $1.25M. */
export function flowUsd(v: number) {
  const a = Math.abs(v), sign = v < 0 ? '−' : '';
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `${sign}$${Math.round(a / 1000)}K`;
  if (a >= 1000) return `${sign}$${(a / 1000).toFixed(1)}K`;
  if (a >= 1) return `${sign}$${Math.round(a)}`;
  return a > 0 ? `${sign}<$1` : '$0';
}
/** Buys as a share of the window's volume, or null when nothing traded. */
export function buyShare(a: FlowActivity) { const total = a.buyUsd + a.sellUsd; return total > 0 ? Math.round((a.buyUsd / total) * 100) : null; }
export const WINDOW_WORD: Record<Flow['window'], string> = { '5m': '5 minutes', '1h': 'hour', '24h': '24 hours' };
export const FLOW_SHARE_TITLE = 'Buys as a share of the last hour’s traded volume, measured from on-chain trades';
/** The short figure beside a flow bar: the buy share when trading is measured, else the agent share. */
export function flowFigure(flow: Flow, labelsUnavailable = false): string | null {
  if (flow.activity) { const share = buyShare(flow.activity); return share === null ? 'No trades' : `${share}% buys`; }
  return labelsUnavailable ? null : `${Math.round(flow.agentPct)}% agents`;
}

const BUY = 'var(--up)', SELL = 'var(--down)';
/** Buy vs sell volume in a window, measured from the coin's trades: no wallet labels involved. */
function ActivityBar({ flow, activity: a, legend, compact }: { flow: Flow; activity: FlowActivity; legend: boolean; compact: boolean }) {
  const total = a.buyUsd + a.sellUsd, buyPct = total > 0 ? (a.buyUsd / total) * 100 : 0, when = WINDOW_WORD[flow.window];
  const label = total > 0 ? `Buys ${flowUsd(a.buyUsd)} (${a.buys}), sells ${flowUsd(a.sellUsd)} (${a.sells}) in the last ${when}` : `No trades in the last ${when}`;
  return <div className="radar-flow flow-activity">
    <div className="flowbar" role="img" aria-label={label} title={compact ? label : undefined}>{total > 0 && <><i className="buy" style={{ width: `${buyPct}%`, background: BUY }} /><i className="sell" style={{ width: `${100 - buyPct}%`, background: SELL }} /></>}</div>
    {legend && (total > 0 ? <div className="legend flow-legend">
      <span><i style={{ background: BUY }} />Buys<b className="num">{flowUsd(a.buyUsd)}</b><span className="num">{a.buys} · {a.buyers} {a.buyers === 1 ? 'wallet' : 'wallets'}</span></span>
      <span><i style={{ background: SELL }} />Sells<b className="num">{flowUsd(a.sellUsd)}</b><span className="num">{a.sells} · {a.sellers} {a.sellers === 1 ? 'wallet' : 'wallets'}</span></span>
      <span>Net<b className={`num${a.netUsd > 0 ? ' up' : ''}`}>{a.netUsd > 0 ? '+' : ''}{flowUsd(a.netUsd)}</b></span>
    </div> : <p className="legend flow-legend muted">No trades in the last {when}.</p>)}
  </div>;
}

/**
 * Flow bar. With measured trading (`flow.activity`) it shows buy vs sell volume; the agent / crew / human split shows
 * only when wallet labels are measured (`unavailable` false). Kept free of trade and wallet imports so lightweight
 * pages (Scan landing, results) can use it.
 */
export function FlowBar({ flow, unavailable = false, legend = false, compact = false }: { flow: Flow; unavailable?: boolean; legend?: boolean; compact?: boolean }) {
  const labelsOff = unavailable || !!flow.meta?.unavailable;
  if (flow.activity && labelsOff) return <ActivityBar flow={flow} activity={flow.activity} legend={legend} compact={compact} />;
  if (labelsOff) return <span className="muted availability">{NOT_CHECKED}</span>;
  const parts = flow.declaredAgentPct !== undefined && flow.likelyAgentPct !== undefined
    ? [{ name: 'Declared agents', className: 'agent', value: flow.declaredAgentPct }, { name: 'Likely agents', className: 'likely', value: flow.likelyAgentPct }]
    : [{ name: 'Agents', className: 'agent', value: flow.agentPct }];
  parts.push({ name: 'Crews', className: 'crew', value: flow.crewPct }, { name: 'Humans', className: 'human', value: flow.humanPct });
  return <div className="radar-flow"><div className="flowbar" role="img" aria-label={parts.map((p) => `${p.name} ${Math.round(p.value)}%`).join(', ')}>{parts.map((p) => <i key={p.name} className={p.className} style={{ width: `${p.value}%` }} />)}{flow.washEstPct > 0 && <i className="wash" style={{ width: `${flow.washEstPct}%` }} />}</div>
    {flow.beta && !compact && <span className="flow-beta"><span className="tag">Beta</span> {flow.confidence === undefined ? 'Confidence unavailable' : `${Math.round(flow.confidence * 100)}% confidence`}</span>}
    {legend && <div className="legend">{parts.map((p) => <span key={p.name}><i className={p.className} />{p.name}<b className="num">{Math.round(p.value)}%</b></span>)}{flow.washEstPct > 0 && <span><i className="wash" />Wash estimate {Math.round(flow.washEstPct)}%</span>}</div>}
    {legend && flow.activity && <ActivityBar flow={flow} activity={flow.activity} legend compact={false} />}
  </div>;
}
