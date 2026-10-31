import type { Flow } from '@eko/shared';
import { NOT_CHECKED } from '../../copy/availability';

/** Agent/crew/human flow bar. Kept free of trade and wallet imports so lightweight pages (Scan landing, results) can use it. */
export function FlowBar({ flow, unavailable = false, legend = false, compact = false }: { flow: Flow; unavailable?: boolean; legend?: boolean; compact?: boolean }) {
  if (unavailable || flow.meta?.unavailable) return <span className="muted availability">{NOT_CHECKED}</span>;
  const parts = flow.declaredAgentPct !== undefined && flow.likelyAgentPct !== undefined
    ? [{ name: 'Declared agents', className: 'agent', value: flow.declaredAgentPct }, { name: 'Likely agents', className: 'likely', value: flow.likelyAgentPct }]
    : [{ name: 'Agents', className: 'agent', value: flow.agentPct }];
  parts.push({ name: 'Crews', className: 'crew', value: flow.crewPct }, { name: 'Humans', className: 'human', value: flow.humanPct });
  return <div className="radar-flow"><div className="flowbar" role="img" aria-label={parts.map((p) => `${p.name} ${Math.round(p.value)}%`).join(', ')}>{parts.map((p) => <i key={p.name} className={p.className} style={{ width: `${p.value}%` }} />)}{flow.washEstPct > 0 && <i className="wash" style={{ width: `${flow.washEstPct}%` }} />}</div>
    {flow.beta && !compact && <span className="flow-beta"><span className="tag">Beta</span> {flow.confidence === undefined ? 'Confidence unavailable' : `${Math.round(flow.confidence * 100)}% confidence`}</span>}
    {legend && <div className="legend">{parts.map((p) => <span key={p.name}><i className={p.className} />{p.name}<b className="num">{Math.round(p.value)}%</b></span>)}{flow.washEstPct > 0 && <span><i className="wash" />Wash estimate {Math.round(flow.washEstPct)}%</span>}</div>}
  </div>;
}
