import type { CoinSignal, CoinSignalV2, GuardAssessmentV2 } from '@eko/shared';
import { Spark } from '../../components/ui/charts';
import { ROLES } from './RadarParts';
import { Roll } from './radarMotion';

/** V2 is prepared for negotiated consumers; mounting it does not activate the adapter. */
export function CoinSignalPanel({ signal, series = [], guard }: {
 series?: number[];
} & ({signal: CoinSignal; guard?: never} | {signal: CoinSignalV2; guard: GuardAssessmentV2})) {
 const v2 = 'schemaVersion' in signal && signal.schemaVersion === 'signal-2';
 const unavailable = (r: typeof ROLES[number]) => v2 && signal.lowData?.includes(r);
 const high = v2 && guard?.level === 'high';
 return <section aria-label="Signal · five readings">
  <h2>Signal · five readings <span className="tag">Beta</span>{v2 && <span className="tag">Shadow adapter</span>}</h2>
  {high && <p role="status" className="note">High risk · {guard?.mode === 'active' ? 'buys refused' : 'shadow assessment'}.</p>}
  <div className="sig-grid"><div>
   {series.length > 1 && <Spark series={series} height={250} label="Price over the selected interval"/>}
   <table className="readings"><thead><tr><th>Reading</th><th>Activity</th><th>Weight</th><th>Score</th></tr></thead><tbody>
    {ROLES.map(r => <tr key={r}><td>{r[0].toUpperCase() + r.slice(1)}
     {signal.lowData?.includes(r) && <span className="tag">{unavailable(r) ? 'Unavailable' : 'Low data'}</span>}
    </td><td>{unavailable(r) ? '—' : <div className="mbar"><i style={{width:`${signal.readings[r]}%`}}/></div>}</td>
     <td className="num muted">{Math.round(signal.weights[r]*100)}%</td><td className="score">{unavailable(r) ? '—' : signal.readings[r]}</td></tr>)}
   </tbody></table>
  </div><aside className="comp panel panel-body"><span className="eyebrow">Signal{v2 ? ' · version 2' : ''}</span>
   {high ? <div className="comp-score"><b>High risk</b></div> : <div className="comp-score"><b><Roll value={String(signal.composite)}/></b><span>/ 100</span></div>}
   <h3>How we got this</h3><table className="comp-receipt"><tbody>
    {ROLES.map(r => <tr key={r}><td>{r[0].toUpperCase()+r.slice(1)}</td>
     <td>{unavailable(r) ? 'Unavailable' : `${signal.readings[r]} × ${Math.round(signal.weights[r]*100)}%`}</td>
     <td>{unavailable(r) ? '—' : (signal.readings[r]*signal.weights[r]).toFixed(1)}</td></tr>)}
   </tbody><tfoot><tr><td>Composite</td><td/><td>{high ? 'High risk' : signal.composite}</td></tr></tfoot></table>
   {v2 && signal.lowData.length > 0 && <p className="note">Unavailable readings use 50 only in the numeric calculation.</p>}
   <p className="note">Descriptive activity only, never a recommendation. The verdict determines the guard’s checks; this signal never feeds the guard.</p>
   <p className="muted">As of block {v2 ? BigInt(signal.asOfBlock).toLocaleString() : Number(signal.asOfBlock).toLocaleString()}</p>
   {v2 && <p className="muted">Guard receipt: {signal.guardReceiptId}<br/>Input methods: {ROLES.map(r => `${r} ${signal.inputMethodVersions[r]}`).join(' · ')}</p>}
  </aside></div>
 </section>;
}
