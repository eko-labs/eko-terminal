import { RatingPriceFact } from '../../components/GuardCompact';
import { AnalysisPolicyNotice } from '../../components/PolicyLinks';
import { formatGuardReason } from '../../copy/guard';
import { HOLDERS_NOT_COUNTED, NOT_CHECKED, NOT_FULLY_CHECKED, NO_DEPLOYER_TITLE, NO_FLAGS_NOTE, SELL_CHECK_NOT_AVAILABLE, SELL_CHECK_TEXT, SELL_FAILS_TITLE, runUpDetail, sellCheckNotAvailableNote } from '../../copy/availability';
import { launchpadLabel, quoteLabel } from '../../copy/chain';
import { runUpMultiple, runUpScore } from '../../lib/runUp';
import { exitMeasured, sellCheckNotAvailable, sellCheckOf, tradeabilityGap } from '../../lib/sellCheck';
import { type ReactNode } from 'react';
import { PixelGauge } from '../../components/GlanceTile';
import type { CoinCard, Verdict, Flow, CoinCardMeta } from '@eko/shared';
import { UntrustedText, VerdictChip } from '../../components/ui';
import { serverNow } from '../../lib/clock';
import { Link } from '../../lib/Link';
import { featureLink } from '../../features';
import { useShell } from '../../store/shell';
import { FlowWindows } from './CoinFlow';
import { coinVerdictActivity, exitText, noMatchLabel, playbookName, sentences, usd, type VerdictActivity } from './radarModel';
const short=(v:string)=>`${v.slice(0,6)}…${v.slice(-4)}`;
function Section({title,children,id}:{title:string;children:ReactNode;id?:string}){return <div className="sec" id={id} tabIndex={id?-1:undefined}><h4>{title}</h4>{children}</div>;}
/** One plain sentence first; the full table folds under it (closed until asked for). */
function Fold({lead,label='All details',children}:{lead:ReactNode;label?:string;children:ReactNode}){return <><p className="sec-lead">{lead}</p><details className="sec-fold"><summary>{label}</summary>{children}</details></>;}
function KV({rows}:{rows:[string,ReactNode][]}){return <dl className="kv">{rows.map(([k,v])=><div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>;}
/** A measured value in the evidence list: whole numbers grouped, fractions to four significant digits (a stat's ref is
 *  an internal id, never shown in its place). */
export const evidenceValue=(v:number|string)=>typeof v==='string'?v:Number.isInteger(v)?v.toLocaleString('en-US'):Math.abs(v)>=1?v.toLocaleString('en-US',{maximumFractionDigits:2}):v.toPrecision(4).replace(/\.?0+$/,'');
/** The deployer's record, once for the verdict (every check carries the same one). */
function deployerRecord(playbooks: Verdict['playbooks']) {
  const runs = playbooks.find(p => p.history)?.history?.deployerRuns;
  return runs === undefined ? null : <p className="pb-hist">{runs ? `Deployer: ${runs} prior flagged ${runs === 1 ? 'run' : 'runs'}.` : 'Deployer: no prior flagged runs.'}</p>;
}
export function CoinVerdict({verdict,evidenceOpen=false,meta,identity,activity}:{meta?:CoinCardMeta;verdict:Verdict;evidenceOpen?:boolean;identity?:CoinCard['identity'];activity?:VerdictActivity}){
 // The run-up score belongs to the first rule set's grade on a coin still on its curve; never beside a pending grade.
 const waitingOnSell=verdict.level==='pending' && !verdict.guardV2 && verdict.evaluatedPlaybooks && !verdict.evaluatedPlaybooks.includes('honeypot') && !verdict.reasons.some(r=>r.startsWith('Waiting on a sell check'));
 const score=verdict.level==='pending' || verdict.guardV2?.mode==='active' ? undefined : identity && runUpScore(identity);
 const stateLabel=noMatchLabel({...identity,...activity,verdict:verdict.level,guardV2:verdict.guardV2});
 return <section data-tour="verdict" className="panel coin-card-panel" id="coin-evidence" tabIndex={-1}><div className="panel-head coin-section-head"><h3>Verdict</h3><RatingPriceFact move={verdict.priceMove}/><VerdictChip level={verdict.level} guard={verdict.guardV2?.mode === 'active' ? verdict.guardV2 : undefined} size="lg" evaluatedPlaybooks={verdict.evaluatedPlaybooks} meta={meta} stateLabel={stateLabel} runUp={score} historyPartial={verdict.historyPartial}/></div><div className="panel-body">{(()=>{
  // One sentence to read at a glance (the strongest reason); the rest of the reasoning, the run-up arithmetic and the
  // deployer's record wait in a fold under it.
  const reasons=[...(waitingOnSell?['Waiting on a sell check: the buy-then-sell simulation has not completed']:[]),...(verdict.guardV2 ? verdict.guardV2.reasons.map(formatGuardReason) : verdict.reasons)];
  const [lead,...rest]=reasons, record=deployerRecord(verdict.playbooks);
  const more=[...(rest.length?[<p key="r" className="verdict-reasons">{sentences(rest)}</p>]:[]),...(score!==undefined?[<p key="s" className="muted">{runUpDetail(score,runUpMultiple(identity!.curvePct!))}</p>]:[]),...(meta&&sellCheckNotAvailable({meta})?[<p key="n" className="muted">{sellCheckNotAvailableNote(identity?.quoteSymbol)}</p>]:[]),...(record?[<div key="d">{record}</div>]:[])];
  return <>{lead&&<p className="sec-lead verdict-lead">{sentences([lead])}</p>}{more.length>0&&<details className="sec-fold verdict-more" open={evidenceOpen||undefined}><summary>{lead?'Why EKO says this':'Details'}</summary>{more}</details>}</>;
 })()}{!verdict.playbooks.length?<p className="muted">{verdict.level === 'pending' ? NOT_FULLY_CHECKED : `No playbook matches at the latest block. ${NO_FLAGS_NOTE}`}</p>:<ul data-tour="playbooks" className="pb-list">{verdict.playbooks.map((m,i)=><li key={`${m.id}:${i}`}><div className="pb-row"><b>{playbookName(m.id,m.level)}</b><span className="tags pb-tags"><span className="muted num" title="How sure the rule is of this match">{Math.round(m.confidence*100)}% sure</span><VerdictChip level={m.level}/></span></div>{m.history?.crewRuns!==undefined&&<p className="pb-hist">Crew: {m.history.crewRuns} prior runs.</p>}<details className="ev" open={evidenceOpen||undefined}><summary>Evidence</summary><ul>{m.evidence.map((e,j)=><li key={j}>{e.label??e.kind} · {e.kind==='stat'&&e.value!==undefined?<span className="num">{evidenceValue(e.value)}</span>:<span className="addr">{e.ref}</span>}</li>)}<li>Checked at block {(verdict.lastChecked?.block ?? verdict.asOfBlock).toLocaleString()} · rules {verdict.schemaVersion}</li></ul></details></li>)}</ul>}{!verdict.guardV2&&<p className="muted pb-rules">Graded by rule set 1.0.x</p>}<AnalysisPolicyNotice /></div></section>;
}
export function CoinOverview({card,verdict,flows,evidenceOpen,ownToken=false,launchBurn=false,ageSec=0}:{card:CoinCard;verdict:Verdict;flows:Flow[];evidenceOpen:boolean;ownToken?:boolean;launchBurn?:boolean;ageSec?:number}){
 const t=card.tradeability,s=card.supply,c=card.control,id=card.identity;
 // Shares the card names missing read "not checked"; on a partial history (EKO started following late) none is counted.
 const supplyGap=(field:string)=>!!card.meta?.supply?.missing?.includes(field),partlyHeld=!!card.meta?.supply?.flags?.includes('history_partial');
 // A feature that is on may give the deployer its own page (features.ts); otherwise the deployer history.
 const deployerTo=useShell(st=>featureLink('deployer',id.deployer,st.config?.flags))??`/deployer/${id.deployer}`;
 // Live sell-check readings measure exit cost and sellability only; taxes and timing stay named as not checked.
 const sell=sellCheckOf(card),taxGap=tradeabilityGap(card,'taxes','buyTax','sellTax');
 const anti=t.antiSnipe&&Math.max(0,t.antiSnipe.endsInSec-Math.max(0,ageSec-card.freshness.ageSec));
 return <div data-tour="coin-card" className="ov-grid ov-compact"><div className="ov-col"><CoinVerdict verdict={verdict} meta={card.meta} identity={card.identity} activity={coinVerdictActivity(card,serverNow())} evidenceOpen={evidenceOpen}/><section className="panel coin-card-panel ov-tile ov-exit"><div className="panel-body"><Section title="Round trip" id="coin-tradeability">{sellCheckNotAvailable(card) ? <KV rows={[['Sell check',SELL_CHECK_NOT_AVAILABLE],['Exit cost',SELL_CHECK_NOT_AVAILABLE]]}/> : card.meta?.tradeability?.unavailable ? <p className="coin-empty">{NOT_CHECKED}</p> : <><ExitFigure card={card} sell={sell}/><Fold lead={tradeLead(card,sell,taxGap,ownToken)} label="All tradeability checks"><KV rows={[["Exit cost at $100 / $1K / $10K",(['usd100','usd1k','usd10k'] as const).map(size=>exitMeasured(card,size)?exitText(t.exitCostPct[size]):NOT_CHECKED).join(' / ')],...(sell?[['Sell check',<span className={sell==='refused'?'bad':undefined} title={sell==='refused'?SELL_FAILS_TITLE:undefined}>{SELL_CHECK_TEXT[sell]}</span>] as [string,ReactNode]]:[]),['Taxes',ownToken?'Fixed 1% creator tax (immutable) · Pons 1% standard fee':taxGap?NOT_CHECKED:`${t.buyTaxPct}% buy · ${t.sellTaxPct}% sell · ${c.canChangeTax?'owner can change':'fixed'}`],...(sell&&!t.honeypot?[]:[['Honeypot',t.honeypot?'Yes':'No'] as [string,ReactNode]]),['Max transaction',t.limits?.maxTxUsd===undefined?'Not reported':usd(t.limits.maxTxUsd)],['Max wallet',t.limits?.maxWalletPct===undefined?'Not reported':`${t.limits.maxWalletPct}%`],['Hook fee',t.hookFeePct===undefined?'Not reported':`${t.hookFeePct}%`],['Anti-snipe',tradeabilityGap(card,'antiSnipeTiming')?NOT_CHECKED:anti?`${t.antiSnipe!.taxPct}% tax → ends in ${anti} s`:'None active'],['Depth ±2%',card.meta?.liquidity?.unavailable||card.meta?.liquidity?.missing?.includes('depthUsd')?NOT_CHECKED:usd(card.liquidity.depthUsd.pct2)],['Venue',`${id.launchpad} · ${id.stage==='curve'?`curve ${id.curvePct??'—'}%`:'graduated'}`]]}/></Fold>{!taxGap&&!c.canChangeTax&&t.buyTaxPct<=5&&t.sellTaxPct<=5&&<p className="coin-fact"><VerdictChip level="info"/><span>Fixed tax of 5% or less</span></p>}</>}</Section></div></section></div><div className="ov-col"><section className="panel coin-card-panel ov-tile ov-hold"><div className="panel-body"><Section title="Who holds it" id="coin-supply">{card.meta?.supply?.unavailable ? <p className="coin-empty">{NOT_CHECKED}</p> : <>{supplyGap('top10Pct') ? <p className="coin-empty">{partlyHeld ? HOLDERS_NOT_COUNTED : NOT_CHECKED}</p> : <Figure gauge={s.top10Pct} value={`${Math.round(s.top10Pct)}%`} caption="of supply sits in the 10 largest wallets" tone={s.top10Pct>50?'bad':s.top10Pct>25?'watch':'good'}/>}{[['Bundles',supplyGap('bundlesHeldPct') ? null : s.bundlesHeldPct],['Exempt wallets',partlyHeld ? null : s.exemptWalletsHeldPct],['Fresh wallets',supplyGap('freshWalletsPct') ? null : s.freshWalletsPct],['Dev',supplyGap('devPct') ? null : s.devPct],['Burned',s.burnedPct]].filter(([,v])=>!(partlyHeld&&v===null)).map(([name,v])=><div className="supply-row" key={name}><span>{name}</span>{v===null?<span className="supply-na">{NOT_CHECKED}</span>:<><PixelGauge pct={Number(v)} tone={Number(v)>40?'bad':'good'} height={14} columns={48}/><span className="num">{`${v}%`}</span></>}</div>)}<p className="coin-circ"><span className="muted">Circulating</span> <span className="num">{Number(s.circulating).toLocaleString()}</span></p>{launchBurn&&<p>dev buy → burned</p>}</>}</Section></div></section><section className="panel coin-card-panel ov-tile ov-liq"><div className="panel-body"><Section title="Liquidity" id="coin-liquidity">{card.meta?.liquidity?.unavailable ? <p className="coin-empty">{NOT_CHECKED}</p> : <><LiquidityFigure card={card}/><Fold lead={liquidityLead(card)}><KV rows={[["Depth ±2% / ±5% / ±10%",card.meta?.liquidity?.missing?.includes('depthUsd') ? <span className="muted">{NOT_CHECKED}</span> : Object.values(card.liquidity.depthUsd).map(usd).join(' / ')],['LP status',card.meta?.liquidity?.missing?.includes('lpStatus') ? <span className="muted">{NOT_CHECKED}</span> : card.liquidity.lpStatus.replaceAll('_',' ')],['Fee tiers',card.liquidity.feeTiers.length ? card.liquidity.feeTiers.map(v=><span key={v} className={v>=15&&v<=95?'bad':undefined}>{v}%{v>=15&&v<=95?' · Fee-trap pool':''} </span>) : <span className="muted">Not reported</span>]]}/></Fold></>}</Section></div></section><section className="panel coin-card-panel ov-tile ov-own"><div className="panel-body"><Section title="Owner powers">{card.meta?.control?.unavailable ? <p className="coin-empty">{NOT_CHECKED}</p> : <><p className="sec-lead">{ownerLead(c)}</p><OwnerChips c={c}/></>}</Section></div></section><section className="panel coin-card-panel ov-flow"><div className="panel-body"><Section title="Trading flow"><details className="sec-fold"><summary>Agents, crews and humans</summary><FlowWindows flows={flows} labelsUnavailable={card.meta?.flow?.unavailable} compact/></details></Section></div></section></div><div className="ov-wide"><section className="panel coin-card-panel"><div className="panel-body"><details className="sec-fold sec-fold-top"><summary>Coin details and receipt</summary><div className="ov-pair"><Section title="Identity"><KV rows={[["Name",<UntrustedText value={id.name}/>],['Symbol',<UntrustedText value={id.symbol}/>],['Address',<span className="addr" title={id.address}>{short(id.address)}</span>],['Deployer',id.deployer.toLowerCase()===id.address.toLowerCase() ? <span title={NO_DEPLOYER_TITLE}>Not identified</span> : <Link to={deployerTo}>{short(id.deployer)} · History</Link>],['Launchpad',launchpadLabel(id.launchpad)],['Stage',id.launchpad==='pons' ? id.stage : 'Uniswap pool'],['Quote asset',quoteLabel(id.quoteAsset,id.quoteSymbol)],['Pools',id.pools.length?id.pools.map((p,i)=><span key={i} className="addr" title={p.address??p.poolId}>{p.address??(p.poolId?short(p.poolId):'')} </span>):'No indexed pools']]}/>{card.clone?.isClone&&<p className="bad">Clone notice{card.clone.originalAddress&&<> · <Link to={`/coin/${card.clone.originalAddress}`}>Original coin</Link></>}</p>}</Section><div><Section title="Receipt"><div className="receipt-line"><span className="addr" title={verdict.receipt.hash}>{short(verdict.receipt.hash)}</span><span className="muted">block {verdict.asOfBlock.toLocaleString()}</span><Link to={`/receipt/${verdict.receipt.id}`} className="btn btn-sm">Verify</Link></div></Section>{verdict.beta&&<Section title="Swarm"><span className="tag">Beta</span><KV rows={[["Ape score",verdict.beta.apeScore??'Not available'],['Setup grade',verdict.beta.setupGrade??'Not available']]}/></Section>}</div></div></details></div></section></div></div>;
}

/** Tradeability in one sentence: can it be sold, what $1K costs to get out, and the tax. */
function tradeLead(card:CoinCard,sell:ReturnType<typeof sellCheckOf>,taxGap:boolean,ownToken:boolean):string{
 const t=card.tradeability;
 if(t.honeypot||sell==='refused')return 'A sell failed in simulation: buys are refused.';
 // The figure above says what $1K costs to get out; the sentence says the rest.
 const exit=exitMeasured(card,'usd1k')?(sell==='sellable'?'':'Selling works in simulation'):'The exit cost has not been measured yet';
 const tax=ownToken?'a fixed 1% creator tax':taxGap?'tax not checked':t.buyTaxPct||t.sellTaxPct?`${t.buyTaxPct}% buy and ${t.sellTaxPct}% sell tax`:'no tax';
 const head=sell==='sellable'?'Sells go through':exit;
 return `${head||'Sells go through'}, with ${tax}.`;
}
/** Liquidity in one sentence: how much moves the price 2%, and whether the liquidity can be pulled. */
function liquidityLead(card:CoinCard):string{
 const l=card.liquidity,depth=card.meta?.liquidity?.missing?.includes('depthUsd')?null:l.depthUsd.pct2;
 const lp=card.meta?.liquidity?.missing?.includes('lpStatus')?'its liquidity lock is not checked':l.lpStatus==='removable'?'its liquidity can be pulled':l.lpStatus==='pons_locked'?'its liquidity is locked by Pons':`its liquidity is ${l.lpStatus.replaceAll('_',' ')}`;
 const trap=l.feeTiers.some(v=>v>=15&&v<=95)?' It trades in a fee-trap pool.':'';
 const said=lp.replace(/^its/,'Its');
 return depth===null?`Depth is not measured yet, and ${lp}.${trap}`:`${said}.${trap}`;
}
/** Owner powers in one sentence: the ones that are on, or none. */
function ownerLead(c:CoinCard['control']):string{
 const on=([['canMint','mint more'],['canBlacklist','block wallets'],['canChangeTax','change the tax'],['canPause','pause trading'],['upgradeable','change the code']] as const).filter(([k])=>c[k]).map(([,w])=>w);
 return on.length?`The owner can ${on.length>1?`${on.slice(0,-1).join(', ')} and ${on.at(-1)}`:on[0]}.`:'The owner has none of these powers.';
}

/** One big figure with a plain caption: what a block says before its details. */
function Figure({value,caption,tone='neutral',gauge}:{value:ReactNode;caption:ReactNode;tone?:'good'|'watch'|'bad'|'neutral';gauge?:number}){
 // The gauge: the radar's pixel bars, lit as far as the share the figure states.
 return <div className={`ov-figure ov-${tone}`}><b>{value}</b>{gauge!==undefined&&<PixelGauge pct={gauge} tone={tone}/>}<span>{caption}</span></div>;
}
/** What getting out costs: the $1K exit as the figure, and the three sizes as bars on one scale. */
function ExitFigure({card,sell}:{card:CoinCard;sell:ReturnType<typeof sellCheckOf>}){
 const t=card.tradeability;
 if(t.honeypot||sell==='refused')return <Figure value="Can't sell" caption="a sell failed in simulation" tone="bad"/>;
 if(!exitMeasured(card,'usd1k'))return null;
 const sizes=(['usd100','usd1k','usd10k'] as const).filter(k=>exitMeasured(card,k)),name={usd100:'$100',usd1k:'$1K',usd10k:'$10K'};
 const cost=t.exitCostPct.usd1k,tone=cost>30?'bad':cost>10?'watch':'good';
 return <><Figure gauge={cost} value={`${Math.round(cost*10)/10}%`} caption={<>lost buying $1,000 and selling it straight back: about <b>{usd(1000*(1-cost/100))}</b> comes back</>} tone={tone}/>
  {sizes.length>1&&<div className="ov-bars" role="list" aria-label="Exit cost by size">{sizes.map(k=><div role="listitem" key={k} className="ov-bar"><span>{name[k]}</span><PixelGauge pct={t.exitCostPct[k]} tone={t.exitCostPct[k]>30?'bad':t.exitCostPct[k]>10?'watch':'good'} height={14} columns={48}/><em>{Math.round(t.exitCostPct[k]*10)/10}%</em></div>)}</div>}</>;
}
/** Liquidity: how many dollars move the price 2%. */
function LiquidityFigure({card}:{card:CoinCard}){
 if(card.meta?.liquidity?.missing?.includes('depthUsd'))return null;
 const d=card.liquidity.depthUsd.pct2;
 return <Figure value={usd(d)} caption="moves the price 2%" tone={d<1000?'bad':d<10000?'watch':'good'}/>;
}
/** Owner powers as switches: lit when the owner has it. */
function OwnerChips({c}:{c:CoinCard['control']}){
 const rows=([['canMint','Mint more'],['canBlacklist','Block wallets'],['canChangeTax','Change tax'],['canPause','Pause trading'],['upgradeable','Change code']] as const);
 return <ul className="ov-chips">{rows.map(([k,w])=><li key={k} className={c[k]?'on':undefined}><i aria-hidden="true"/>{w}<span className="sr-only">{c[k]?': yes':': no'}</span></li>)}</ul>;
}
