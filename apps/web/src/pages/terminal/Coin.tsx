import { knownCoinIdentity } from '../../lib/coinIdentity';
import { BlueChipBadge, BlueChipDetails } from '../../components/BlueChip';
import { useOnboarding } from '../../store/onboarding';
import { WatchButton } from '../../components/WatchButton';
import { AnalysisPolicyNotice, AnalysisPolicyScope } from '../../components/PolicyLinks';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { z } from 'zod';
import { AgentSchema, BurnEventSchema, RadarRowSchema, type Agent, type BurnEvent, type RadarRow } from '@eko/shared';
import { HeatTag, Tabs, TabPanel, UntrustedText, inertText, VerdictChip } from '../../components/ui';
import { ChartStage } from '../../components/chart/ChartStage';
import { IconLab, IconOut } from '../../components/icons';
import type { CoinTimeframe } from '../../components/chart/coinMath';
import { fetchParsed, api, MOCKS } from '../../lib/api';
import { formatAge, formatCoinPrice } from '../../lib/format';
import { Link } from '../../lib/Link';
import { useMedia } from '../../lib/useMedia';
import { useShell } from '../../store/shell';
import { useApp } from '../../store/app';
import { NOT_CHECKED, NOT_INDEXED, CARD_WAIT, FULL_HISTORY, SUB_MINUTE_UNAVAILABLE, emptyTradeWindow } from '../../copy/availability';
import { heatOf, displayHeat } from '../../lib/heat';
import { CoinOverview, CoinVerdict } from './CoinCard';
import { CoinSignalPanel } from './CoinSignal';
import { useCoin } from './useCoin';
import { useGuardCoin } from './useGuardCoin';
import { GuardCard, GuardAssessment } from './GuardCard';
import { GUARD_UNAVAILABLE, GUARD_REFRESH_FAILED } from '../../copy/guard';
import { antiSnipeDeadline } from '../../components/trade/tradePanelModel';
import { serverNow } from '../../lib/clock';
import { TradePanel } from '../../components/trade/TradePanel';
import { CoinFlowTab, CoinTrades } from './CoinFlow';
import { Decode, Roll } from './radarMotion';
import { age, pct, coinVerdictActivity, noMatchLabel, playbookName, usd } from './radarModel';
import { TRADE_COPY } from '../../copy/trade';
import { useReconnecting } from '../../lib/useReconnecting';
import { launchpadLabel, quotedIn } from '../../copy/chain';
/** Robinhood Chain launchpads whose coins trade in a Uniswap pool from launch (no curve to show progress on). */
const POOL_LAUNCHPADS: ReadonlySet<string> = new Set(['pangea', 'longxyz', 'unbranded']);
import { coinElsewhere } from '../../lib/coinLinks';
import { CoinDetailScope, CoinSlotScope, TabSections, ToolRow, sectionAnchor, useTabSections } from '../../components/coinSlots';
import { CoinGlance } from './CoinGlance';
import type { CoinDetailTab } from '../../features';
import './radar.css';
import './coin.css';
const short=(s:string)=>`${s.slice(0,6)}…${s.slice(-4)}`;
export { RAW_TRADES_NOTE } from './CoinFlow';
export default function Coin({params}:{params:Record<string,string>}){return <CoinPage key={params.address} address={params.address}/>;}
function CoinPage({address}:{address:string}){
 const [tf,setTf]=useState<CoinTimeframe>('5m'),[tab,setTab]=useState('Overview'),[evidence,setEvidence]=useState(false),[row,setRow]=useState<RadarRow|null>(null),[agents,setAgents]=useState<Agent[]>([]),[burns,setBurns]=useState<BurnEvent[]>([]),[sheet,setSheet]=useState(false);
 const [fullHistory,setFullHistory]=useState(false),[sideRequest,setSideRequest]=useState<{side:'buy'|'sell';at:number}|null>(null);
 const sheetRef=useRef<HTMLElement>(null),[sheetHeight,setSheetHeight]=useState(140);

 const data=useCoin(address,tf,fullHistory),config=useShell(s=>s.config),ws=useShell(s=>s.wsState),delayed=useShell(s=>s.delayedSec),me=useShell(s=>s.me),phone=useMedia('(max-width:700px)'),toast=useApp(s=>s.toast);
 useEffect(()=>{if(!phone||!sheetRef.current)return;const measure=()=>{const el=sheetRef.current;if(el)setSheetHeight(el.getBoundingClientRect().height);};measure();const observer=new ResizeObserver(measure);observer.observe(sheetRef.current);return()=>observer.disconnect();},[phone,sheet]);
 const {card,verdict,bars,markers}=data;
 const guardData=useGuardCoin(address);
 // Detail tabs features fill (features.ts CoinSlots.section): shown only when something fills them.
 const whosIn=useTabSections("Who's in").length>0,odds=useTabSections('Odds').length>0;
 const detail=useMemo(()=>({open:(name:CoinDetailTab,section?:string)=>{setTab(name);if(section)requestAnimationFrame(()=>requestAnimationFrame(()=>{const el=document.getElementById(section)??document.getElementById(sectionAnchor(section));el?.scrollIntoView({block:'start',behavior:'smooth'});(el as HTMLElement|null)?.focus({preventScroll:true});}));}}),[]);
 const antiSnipeEndsAt=useMemo(()=>antiSnipeDeadline(card,guardData.card,serverNow()),[card,guardData.card]);
 const identity=card?.identity??guardData.card?.identity??knownCoinIdentity(address);
 const primaryGuard=guardData.assessment?.mode==='active'?guardData.assessment:verdict?.guardV2?.mode==='active'?verdict.guardV2:undefined;
 const headerGuard=primaryGuard??(!verdict?guardData.assessment??undefined:undefined);
 useEffect(()=>{const ac=new AbortController();void fetchParsed('/radar',z.object({rows:z.array(RadarRowSchema)}),{signal:ac.signal}).then(r=>setRow(r.rows.find(c=>c.address.toLowerCase()===address.toLowerCase())??null)).catch(()=>undefined);if(MOCKS || me?.account.wallet) void fetchParsed('/agents',z.object({agents:z.array(AgentSchema)}),{signal:ac.signal}).then(r=>setAgents(r.agents.filter(a=>a.kind==='onchain'))).catch(()=>undefined);return()=>ac.abort();},[address, me?.account.wallet]);
 // TODO(spec): PublicConfig has no own-token address field. Use an explicit deployment address; never infer it from an untrusted symbol.
 const ownToken=!!import.meta.env.VITE_EKO_TOKEN_ADDRESS&&address.toLowerCase()===String(import.meta.env.VITE_EKO_TOKEN_ADDRESS).toLowerCase();
 useEffect(()=>{if(!ownToken)return;const ac=new AbortController();void fetchParsed('/burn/events',z.object({rows:z.array(BurnEventSchema)}),{signal:ac.signal}).then(r=>setBurns(r.rows)).catch(()=>undefined);return()=>ac.abort();},[ownToken]);
 const launch=burns.find(b=>b.kind==='launch');
 // TODO(spec): ChartMarker has no transaction hash. A launch flame requires the burn event's matching timestamp until CA-17 supplies marker transaction identity.
 const launchTs=launch?Date.parse(launch.ts)/1000:undefined;
 // Stale means the live connection is down. A rating is refreshed after trades, not every block, so its age alone does
 // not pause trading (the server checks the current rating on every quote); under an active Guard 2 release the
 // 30-second snapshot limit still applies here as it does on the server.
 const linkBack=useReconnecting(ws),guardAged=!!primaryGuard&&(data.ageSec>30||(card?.freshness.ageSec??0)>30),reconnecting=linkBack&&!guardAged;
 const stale=ws!=='open'||(!!primaryGuard&&(data.ageSec>30||(card?.freshness.ageSec??0)>30)),delay=me?.entitlements.limits.realtime===false?Math.max(60,delayed):delayed;
 const px=bars.at(-1)?.c??row?.priceUsd;
 // TODO(spec): CoinCard has no price/change fields. Use its RadarRow for 1h/24h; derive the current price from candles/ticks, and hide unavailable changes.

 useEffect(()=>{if((phone||!card?.signal)&&tab==='Signal')setTab('Overview');},[phone,card?.signal,tab]);
 if(data.unknown&&!card&&!verdict&&!guardData.card&&!guardData.assessment)return <div className="shell-page coin-page"><div className="empty"><h1>{NOT_INDEXED}</h1><p>{data.error || CARD_WAIT}</p><button className="btn" onClick={()=>data.retry()}>Check again</button></div><AnalysisPolicyNotice /></div>;
 const top=verdict?.playbooks.find(p=>p.level==='danger')??verdict?.playbooks.find(p=>p.level==='monitor');
 const featureTabs=[...(whosIn?["Who's in"]:[]),...(odds?['Odds']:[])];
 const tabs=phone?['Overview',...featureTabs,'Flow','Trades']:['Overview',...featureTabs,...(card?.signal?['Signal']:[]),'Flow','Trades'];
 const activeValues=tabs;
 const showEvidence=()=>{useOnboarding.getState().markStep('open_evidence');setTab('Overview');setEvidence(true);const id=headerGuard&&headerGuard.mode!=='active'?'guard-shadow-evidence':'coin-evidence';requestAnimationFrame(()=>{document.getElementById(id)?.scrollIntoView({block:'nearest'});document.getElementById(id)?.focus();});};
 const verdictActivity=card?coinVerdictActivity(card,serverNow()):row;
 const stateLabel=verdict?noMatchLabel({...verdictActivity,verdict:verdict.level,guardV2:primaryGuard}):undefined;
 const verdictChip=headerGuard?<button data-tour="verdict" className="coin-verdict-button" aria-label="Open verdict evidence" onClick={showEvidence}><VerdictChip level="pending" guard={headerGuard} showGaps={false}/></button>:verdict?<button data-tour="verdict" className="coin-verdict-button" aria-label="Open verdict evidence" onClick={showEvidence}><VerdictChip level={verdict.level} guard={primaryGuard} showGaps={false} evaluatedPlaybooks={verdict.evaluatedPlaybooks} meta={card?.meta} stateLabel={stateLabel} historyPartial={verdict.historyPartial} detail={top?playbookName(top.id,top.level):undefined}/></button>:<VerdictChip level="pending" verdictPending/>;
 const elsewhere=coinElsewhere(address,identity?.stage);
 const changeText=(v:number)=>row?.unavailable?.includes('change') ? NOT_CHECKED : pct(v);
 const labelsOff=data.labelsUnavailable || card?.meta?.flow?.unavailable;
 const nowSec=Math.floor(Date.now()/1000);
 return <CoinSlotScope coin={address}><CoinDetailScope value={detail}><AnalysisPolicyScope><div onClickCapture={e=>{const target=(e.target as HTMLElement).closest('summary')?.parentElement;if(target?.classList.contains('ev'))useOnboarding.getState().markStep('open_evidence');}} className="shell-page coin-page" style={{'--trade-sheet-clearance':`${sheetHeight}px`} as CSSProperties}>{data.error&&<div role="status" className="coin-error">{data.error} <button className="btn" onClick={data.retry}>Retry</button></div>}
 <header className="coin-head">
  <div className="coin-title-row">
   <div className="coin-id">
    <h1 title={`$${identity?inertText(identity.symbol.text):address}`}>{identity?<Decode text={`$${inertText(identity.symbol.text)}`}><span>$<UntrustedText value={identity.symbol}/></span></Decode>:'Coin'}</h1>
    {identity&&<span className="coin-name"><UntrustedText value={identity.name}/></span>}
   </div>
   <div className="coin-actions"><WatchButton kind="coin" target={address}/>{config?.flags.deep_research&&<button className="btn" onClick={()=>void api('/research',{body:{target:address}}).then(()=>toast({kind:'info',title:'Deep Research started'})).catch(()=>toast({kind:'error',title:'Could not start Deep Research.'}))}><IconLab/>Deep Research</button>}<button className="btn" onClick={()=>void navigator.clipboard?.writeText(location.href).then(()=>toast({kind:'ok',title:'Share link copied'})).catch(()=>toast({kind:'error',title:'Could not copy the share link.'}))}><IconOut/>Share</button></div>
  </div>
  <div className="coin-id-meta">
   <div className="sub coin-tags">{row&&<HeatTag heat={displayHeat({...row,verdict:verdict?.level??row.verdict})}/>}<BlueChipBadge value={card?.blueChip} /><span className="coin-ca"><span className="addr coin-addr" title={address}>{short(address)}</span><button className="iconbtn coin-copy" aria-label="Copy address" title="Copy address" onClick={()=>void navigator.clipboard?.writeText(address).then(()=>toast({kind:'ok',title:'Address copied'})).catch(()=>undefined)}>⧉</button>{elsewhere&&<a className="coin-elsewhere" href={elsewhere.href} target="_blank" rel="noopener noreferrer" title={`Open on ${elsewhere.label}`}>{elsewhere.label}<IconOut/></a>}</span>{(identity||row)&&<span className="coin-facts">{identity&&<><span className="coin-fact">{launchpadLabel(identity.launchpad, identity.stage === 'graduated')}</span>{quotedIn(card?.identity.quoteSymbol??row?.quoteSymbol)&&<span className="coin-fact" title={`Quoted in ${card?.identity.quoteSymbol??row?.quoteSymbol}`}>{quotedIn(card?.identity.quoteSymbol??row?.quoteSymbol)}</span>}<span className="coin-fact">{identity.stage==='graduated'?'Migrated':identity.stage==='unknown'?'Stage not checked':POOL_LAUNCHPADS.has(identity.launchpad)?'Uniswap pool':`Curve ${card?.identity.curvePct??'—'}%`}</span></>}{row&&<span className="coin-fact coin-age">{formatAge(row.ageSec)} old</span>}</span>}</div>
   <dl className="coin-price">
    <div className="coin-stat coin-stat-price"><dt className="sr-only">Price</dt><dd><b>{px===undefined || row?.priceUnavailable ? (!data.card&&!data.verdict&&!data.error ? <span className="glance-wait" aria-label="Loading">—</span> : NOT_CHECKED) : <Roll value={formatCoinPrice(px)}/>}</b></dd></div>
    {row&&<div className="coin-stat"><dt>1h</dt><dd className={`num${row.change1hPct>0?' up':row.change1hPct<0?' down':''}`}>{changeText(row.change1hPct)}</dd></div>}
    {row?.change24hPct!==undefined&&<div className="coin-stat"><dt>24h</dt><dd className={`num${row.change24hPct>0?' up':row.change24hPct<0?' down':''}`}>{changeText(row.change24hPct)}</dd></div>}
    {row&&<div className="coin-stat" title="Fully diluted value: price × total supply, the same figure as Radar"><dt>FDV</dt><dd className="num">{row.marketCapUsd===undefined||row.unavailable?.includes('marketCap') ? NOT_CHECKED : usd(row.marketCapUsd)}</dd></div>}
    {row&&!row.unavailable?.includes('liquidity')&&<div className="coin-stat"><dt>{identity&&identity.launchpad!=='pons'?'In pool':identity?.stage==='curve'?'In curve':'Liquidity'}</dt><dd className="num">{usd(row.liquidityUsd)}</dd></div>}
   </dl>
  </div>
 </header>
 <div className="coin-guard-status">{guardData.failed?<p role="status">{guardData.card||guardData.assessment?GUARD_REFRESH_FAILED:GUARD_UNAVAILABLE} <button className="btn btn-sm" onClick={guardData.retry}>Retry Guard</button></p>:null}</div>
 <CoinGlance card={card} verdict={verdict} row={row} guard={headerGuard} onVerdict={showEvidence}/>
 <div className="coin-grid"><div className="coin-center">
  <ChartStage market={identity?inertText(identity.symbol.text):address} timeframe={tf} onTimeframe={setTf} bars={bars} markers={markers} supply={row?.marketCapUsd&&row.priceUsd?row.marketCapUsd/row.priceUsd:Number(card?.supply.circulating??1)} verdict={headerGuard?verdictChip:undefined} delayedSec={delay} ownToken={ownToken} burnWallet={config?.wallets.burn} launchTs={launchTs} labelsUnavailable={labelsOff} crewsEnabled={config?.flags.rug_ring_radar}/>
  {(!bars.length||data.candlesUnavailable)&&!data.error&&<p role="status" className="coin-chart-status">{data.candlesLoading ? 'Loading indexed candles…' : data.candlesUnavailable ? SUB_MINUTE_UNAVAILABLE : <>{emptyTradeWindow(data.lastTradeTs)} {!fullHistory && data.lastTradeTs!=null && <button className="btn btn-sm" onClick={()=>setFullHistory(true)}>{FULL_HISTORY}</button>}</>}</p>}
  <ToolRow/>
  <section className="coin-findings" aria-labelledby="coin-findings-h">
   <div className="coin-zone-head"><h2 id="coin-findings-h" className="coin-zone-title">What EKO found</h2><span className="coin-zone-sub">Checks, supply and trading flow for this coin. Not a recommendation.</span></div>
   <div className="coin-tabs"><Tabs tabs={tabs} value={tab} onChange={setTab} label="Coin details" id="coin-details"/></div>
   {activeValues.map((name,i)=><TabPanel key={name} id="coin-details" index={i} active={tab===name}>{name==='Overview'?<>{!!delay&&<span className="tag">Delayed ~{delay} s</span>}{guardData.card?<>{verdict&&!primaryGuard&&<CoinVerdict verdict={verdict} identity={card?.identity} activity={verdictActivity??undefined} meta={card?.meta} evidenceOpen={evidence}/>}<GuardCard card={guardData.card} assessment={guardData.assessment??undefined} evidenceOpen={evidence}/></>:guardData.assessment?<GuardAssessment guard={guardData.assessment} evidenceOpen={evidence}/>:card&&verdict?<CoinOverview card={card} verdict={verdict} flows={data.flows} evidenceOpen={evidence} ownToken={ownToken} launchBurn={!!launch} ageSec={data.ageSec}/>:verdict?<CoinVerdict verdict={verdict} identity={card?.identity} activity={verdictActivity??undefined} meta={card?.meta} evidenceOpen={evidence}/>:<div className="skel coin-card-skel" aria-label="Loading coin card"/>}<TabSections tab="Overview"/></>
    :name==="Who's in"?<TabSections tab="Who's in"/>
    :name==='Odds'?<TabSections tab="Odds"/>
    :name==='Signal'&&card?.signal?<CoinSignalPanel signal={card.signal} series={bars.map(b=>b.c)}/>
    :name==='Flow'?<CoinFlowTab flows={data.flows} markers={markers} labelsUnavailable={labelsOff} nowSec={nowSec}/>
    :<CoinTrades markers={markers} flows={data.flows} labelsUnavailable={labelsOff}/>}</TabPanel>)}
   {!guardData.card&&!guardData.assessment&&<p className="coin-asof">As of block {(verdict?.lastChecked?.block??verdict?.asOfBlock??card?.freshness.block??0).toLocaleString()} · rated {data.ageSec<60?'just now':`${age(data.ageSec)} ago`}</p>}
  </section>
  <BlueChipDetails value={card?.blueChip} criteria={card?.blueChipCriteria} /><AnalysisPolicyNotice page /></div>
 <aside ref={sheetRef} className={`coin-aside${phone?' coin-sheet':''}${sheet?' expanded':''}`} aria-label="Trade this coin">
  <section className="panel coin-trade"><div className={`panel-head coin-section-head coin-trade-head${phone&&!sheet?' coin-trade-quick':''}`}>{phone&&!sheet
   // Collapsed on a phone: Buy and Sell are always on screen; either opens the panel on that side.
   ?<><button type="button" className="btn coin-quick-buy" onClick={()=>{setSideRequest({side:'buy',at:Date.now()});setSheet(true);}}>Buy</button><button type="button" className="btn coin-quick-sell" onClick={()=>{setSideRequest({side:'sell',at:Date.now()});setSheet(true);}}>Sell</button></>
   :<><h2>Trade this coin</h2>{phone?<button className="btn btn-sm" aria-expanded={sheet} onClick={()=>setSheet(false)}>Collapse</button>:<span className="coin-trade-meta">Guarded · non-custodial</span>}</>}</div>{stale&&phone&&!sheet&&<p role="status" className="coin-stale">{reconnecting?TRADE_COPY.reconnecting:TRADE_COPY.stale}</p>}<div className="panel-body" hidden={phone&&!sheet} inert={phone&&!sheet}><TradePanel key={address} coin={address} priceUsd={px} priceUnavailable={row?.priceUnavailable} priceFormat={formatCoinPrice} guard={guardData.assessment ?? verdict?.guardV2} stale={stale} visible={!phone||sheet} antiSnipeEndsAt={antiSnipeEndsAt} {...(sideRequest?{sideRequest}:{})} {...(identity?{symbol:inertText(identity.symbol.text)}:{})} /></div></section>
  <section className="panel coin-your-agents"><div className="panel-head coin-section-head"><h3>Your agents</h3><Link to="/mission">Mission Control</Link></div><div className="panel-body"><ul className="mine">{agents.map(a=><li key={a.id}><Link to={`/mission/agents/${a.id}`}>{a.name}</Link><span>{a.status.replaceAll('_',' ')}</span></li>)}</ul>{!agents.length&&<p className="muted">No connected on-chain agents.</p>}<p className="note">Connected agents get this same verdict when they call <span className="addr">preflight</span> before an order.</p></div></section>
 </aside></div></div></AnalysisPolicyScope></CoinDetailScope></CoinSlotScope>;
}
