import { useEffect, useState } from 'react';
import { CensusSchema, censusGateAccepted, type Census } from '@eko/shared';
import { fetchParsed } from '../lib/api';
import { serverNow } from '../lib/clock';
import { Link } from '../lib/Link';
import { UntrustedText } from '../components/ui';
import { AnalysisPolicyNotice } from '../components/PolicyLinks';
import './census.css';

const pct=(value:number)=>`${value.toFixed(1)}%`;
export function CensusView({data,now=serverNow(),status,watching=false,onWatch=()=>{},onRetry=()=>{}}:{
  data:Census|null;now?:number;status?:'loading'|'error';watching?:boolean;onWatch?:(watch:boolean)=>void;onRetry?:()=>void;
}) {
  const published=!!data&&!data.gated&&censusGateAccepted(data.gate,now);
  const coins=published?data.coins.filter(row=>row.flow.modelVersion===data.gate.modelVersion&&!row.flow.beta
    &&!row.unavailable?.includes('flow')):[];
  return <div className="shell-page census-page">
    <header className="page-head"><span className="eyebrow">Public record</span><h1>Agent Census</h1>
      <p>{published?'Wallet-labelled buy flow on Elysium.':'Census numbers publish once wallet-label precision passes 90%.'}</p>
      <label className="census-watch"><input type="checkbox" checked={watching} onChange={event=>onWatch(event.target.checked)} />Watch updates on this page</label>
    </header>
    {status==='loading'&&<p role="status">Checking publication evidence…</p>}
    {status==='error'&&<p role="status">Census evidence is unavailable. <button className="btn" onClick={onRetry}>Retry</button></p>}
    {published&&<section aria-labelledby="census-results">
      <h2 id="census-results">Chain-wide buy share</h2>
      <p>Per our research, the first agent-flow metric published for Elysium.</p>
      <p>Buy volume from wallets labelled as declared or likely agents, using finalized blocks. These shares describe buy volume, not a count of traders.</p>
      <div className="census-windows">{data.chain.map(row=><article key={row.window} className="census-window">
        <h3>{row.window}</h3><p className="census-share">{pct(row.agentPct)} labelled agent buys</p>
        <p>Crew {pct(row.crewPct)} · Human {pct(row.humanPct)}</p><p>Finalized block {row.asOfBlock}</p>
      </article>)}</div>
      {/* TODO(spec): GET /census supplies window aggregates, not trend samples or coin volume. Do not invent a trend or volume from those fields. */}
      <p>Trend history is unavailable in the current Census response.</p>
      <h3>By coin</h3>
      {coins.length?<div className="census-table"><table><thead><tr><th>Coin</th><th>Window</th><th>Agent</th><th>Crew</th><th>Human</th><th>Volume</th></tr></thead>
        <tbody>{coins.map(row=><tr key={row.address}><th><Link to={`/coin/${row.address}`}><UntrustedText value={row.symbol} /></Link></th><td>{row.flow.window}</td>
          <td>{pct(row.flow.agentPct)}</td><td>{pct(row.flow.crewPct)}</td><td>{pct(row.flow.humanPct)}</td><td>Unavailable</td></tr>)}</tbody></table></div>
        :<p>Finalized by-coin coverage is unavailable.</p>}
      <div className="census-evidence"><h3>Publication evidence</h3><p>Accepted model version: <code>{data.gate.modelVersion}</code></p>
        <p>Likely-agent precision {pct(data.gate.value!*100)} · Wilson lower bound (95%) {data.gate.wilsonLower==null?'Unavailable':pct(data.gate.wilsonLower*100)} · Recall {data.gate.recall==null?'Unavailable':pct(data.gate.recall*100)}</p>
        <p>Evaluated <time dateTime={data.gate.evaluatedAt!}>{data.gate.evaluatedAt}</time> · Data as of <time dateTime={data.asOf}>{data.asOf}</time></p>
        <p>Model hash <code>{data.gate.modelHash}</code></p><p>Dataset hash <code>{data.gate.datasetHash}</code></p>
        <p><a href="#methodology">Methodology and limitations</a></p>
      </div>
    </section>}
    <section id="methodology" aria-labelledby="census-method"><h2 id="census-method">Methodology</h2>
      <p>The Census groups on-chain buy volume by wallet label. Published aggregates use finalized, completely ingested blocks and labels valid at each trade’s block. Missing coverage keeps publication unavailable.</p>
      <p>On-chain fingerprints include transaction patterns, account abstraction, router use, trading intervals and repeated order sizes. A label is an inference about a wallet’s behaviour, not proof of the person or software behind it.</p>
      <p>Evaluation uses held-out declared wallets with at least five swaps, plus at least two hundred independently reviewed agent wallets and three hundred human wallets. Each reviewed wallet needs two distinct reviewers; disagreements are excluded before checking those minimums. Training wallets are excluded.</p>
      <p>The publication gate measures precision of likely-agent predictions in the high and medium confidence tiers. The Wilson lower bound accompanies precision; recall is reported but does not decide the gate. Model and dataset hashes identify each evaluation.</p>
      <p>Numbers require a passing evaluation for the current model and current evidence. An expired evaluation or a model change keeps numbers unpublished until new evidence passes. Guard buyer-harm labels do not establish agent identity.</p>
      <h3>Label definitions</h3><dl>
        <dt>Declared agent (ERC-8004)</dt><dd>A wallet registered in the agent identity registry. Registration is permissionless and does not verify the operator.</dd>
        <dt>Likely agent</dt><dd>On-chain fingerprints meet the model’s threshold. Only high and medium confidence labels contribute to agent share.</dd>
        <dt>Crew</dt><dd>A group of wallets linked by qualified funding and co-trading evidence. Shared activity does not establish a shared identity or intent.</dd>
        <dt>Human</dt><dd>The remaining wallet label under the model’s rules; it does not prove a wallet is operated manually.</dd>
      </dl><p>Label precedence: declared agent, crew, likely agent, human. Crew evidence can remain attached to a declared wallet.</p>
      <h3>Confidence tiers</h3><p>High: at least ninety percent. Medium: at least seventy-five percent and below ninety percent. Low: at least sixty percent and below seventy-five percent. Confidence describes label evidence, not investment outcomes.</p>
    </section>
    <AnalysisPolicyNotice />
  </div>;
}
export default function CensusPage() {
  const [data,setData]=useState<Census|null>(null),[status,setStatus]=useState<'loading'|'error'|undefined>('loading');
  const [watching,setWatching]=useState(false),[retry,setRetry]=useState(0),[now,setNow]=useState(serverNow());
  useEffect(()=>{
    const controller=new AbortController();let request=0;
    const load=async()=>{
      const generation=++request;
      try {const result=await fetchParsed('/census',CensusSchema,{signal:controller.signal});
        if(!controller.signal.aborted&&generation===request){setData(result);setStatus(undefined);setNow(serverNow());}}
      catch {if(!controller.signal.aborted&&generation===request){setData(null);setStatus('error');}}
    };
    setData(null);setStatus('loading');void load();
    // TODO(spec): No Census subscription target exists in WatchBody. Watch polls only while this page is open; it creates no account subscription.
    const poll=watching?setInterval(()=>void load(),60_000):undefined;
    return()=>{controller.abort();if(poll)clearInterval(poll);};
  },[watching,retry]);
  useEffect(()=>{const timer=setInterval(()=>setNow(serverNow()),1000);return()=>clearInterval(timer);},[]);
  return <CensusView data={data} now={now} status={status} watching={watching} onWatch={setWatching} onRetry={()=>setRetry(value=>value+1)} />;
}
