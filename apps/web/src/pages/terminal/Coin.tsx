import { knownCoinIdentity } from '../../lib/coinIdentity';
import { BlueChipBadge, BlueChipDetails } from '../../components/BlueChip';
import { useOnboarding } from '../../store/onboarding';
import { WatchButton } from '../../components/WatchButton';
import { AnalysisPolicyNotice, AnalysisPolicyScope } from '../../components/PolicyLinks';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { z } from 'zod';
import { AgentSchema, BurnEventSchema, RadarRowSchema, type Agent, type BurnEvent, type ChartMarker, type RadarRow } from '@eko/shared';
import { HeatTag, Tabs, TabPanel, UntrustedText, inertText, VerdictChip, WALLET_LABEL_WORD } from '../../components/ui';
import { ChartStage } from '../../components/chart/ChartStage';
import { IconLab, IconOut } from '../../components/icons';
import { Glyph } from '../../components/chart/FlowLayer';
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
import { FlowBar } from './RadarParts';
import { Decode, Roll } from './radarMotion';
import { age, pct, PLAYBOOK_NAMES, usd } from './radarModel';
import { launchpadLabel } from '../../copy/chain';
import './radar.css';
import './coin.css';
const short=(s:string)=>`${s.slice(0,6)}…${s.slice(-4)}`;
export const RAW_TRADES_NOTE="Individual trades cover recent history. Older activity remains in the chart and coin summaries.";
function Trades({markers}:{markers:ChartMarker[]}){return <div className="coin-table-wrap"><p className="note">{RAW_TRADES_NOTE}</p><table className="table"><thead><tr><th>Time</th><th>Side</th><th>Who</th><th>Wallet</th><th className="r">Size</th></tr></thead><tbody>{markers.slice(-32).reverse().map((m,i)=><tr key={i}><td className="num muted">{new Date(m.ts*1000).toISOString().slice(11,19)}</td><td>{m.side==='buy'?'Buy':'Sell'}</td><td><Glyph label={m.label}/> {WALLET_LABEL_WORD[m.label]}</td><td className="addr">{short(m.wallet)}</td><td className="r num">${m.sizeUsd.toLocaleString('en-US')}</td></tr>)}</tbody></table></div>;}
export default function Coin({params}:{params:Record<string,string>}){return <CoinPage key={params.address} address={params.address}/>;}
function CoinPage({address}:{address:string}){
 const [tf,setTf]=useState<CoinTimeframe>('5m'),[tab,setTab]=useState('Overview'),[evidence,setEvidence]=useState(false),[row,setRow]=useState<RadarRow|null>(null),[agents,setAgents]=useState<Agent[]>([]),[burns,setBurns]=useState<BurnEvent[]>([]),[sheet,setSheet]=useState(false);
 const [fullHistory,setFullHistory]=useState(false);
 const sheetRef=useRef<HTMLElement>(null),[sheetHeight,setSheetHeight]=useState(140);

 const data=useCoin(address,tf,fullHistory),config=useShell(s=>s.config),ws=useShell(s=>s.wsState),delayed=useShell(s=>s.delayedSec),me=useShell(s=>s.me),phone=useMedia('(max-width:700px)'),toast=useApp(s=>s.toast);
 useEffect(()=>{if(!phone||!sheetRef.current)return;const measure=()=>setSheetHeight(sheetRef.current!.getBoundingClientRect().height);measure();const observer=new ResizeObserver(measure);observer.observe(sheetRef.current);return()=>observer.disconnect();},[phone,sheet]);
 const {card,verdict,bars,markers}=data;
 const guardData=useGuardCoin(address);
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
 const stale=ws!=='open'||(!!primaryGuard&&(data.ageSec>30||(card?.freshness.ageSec??0)>30)),delay=me?.entitlements.limits.realtime===false?Math.max(60,delayed):delayed;
 const px=bars.at(-1)?.c??row?.priceUsd;
 // TODO(spec): CoinCard has no price/change fields. Use its RadarRow for 1h/24h; derive the current price from candles/ticks, and hide unavailable changes.

 useEffect(()=>{if((phone||!card?.signal)&&tab==='Signal')setTab('Overview');},[phone,card?.signal,tab]);
 if(data.unknown&&!card&&!verdict&&!guardData.card&&!guardData.assessment)return <div className="shell-page coin-page"><div className="empty"><h1>{NOT_INDEXED}</h1><p>{data.error || CARD_WAIT}</p><button className="btn" onClick={()=>void api(MOCKS ? '/scan' : `/scan?q=${encodeURIComponent(address)}`,MOCKS ? {body:{query:address}} : undefined).then(()=>data.retry()).catch(()=>toast({kind:'error',title:'Could not scan. Try again.'}))}>Scan</button></div><AnalysisPolicyNotice /></div>;
 const top=verdict?.playbooks.find(p=>p.level==='danger')??verdict?.playbooks.find(p=>p.level==='monitor');
 const tabs=phone?[{value:'Overview',label:'Card'},'Flow','Trades']:['Overview',...(card?.signal?['Signal']:[]),'Flow','Trades'];
 const activeValues=tabs.map(t=>typeof t==='string'?t:t.value);
 const showEvidence=()=>{useOnboarding.getState().markStep('open_evidence');setTab('Overview');setEvidence(true);const id=headerGuard&&headerGuard.mode!=='active'?'guard-shadow-evidence':'coin-evidence';requestAnimationFrame(()=>{document.getElementById(id)?.scrollIntoView({block:'nearest'});document.getElementById(id)?.focus();});};
 return <AnalysisPolicyScope><div onClickCapture={e=>{const target=(e.target as HTMLElement).closest('summary')?.parentElement;if(target?.classList.contains('ev'))useOnboarding.getState().markStep('open_evidence');}} className="shell-page coin-page" style={{'--trade-sheet-clearance':`${sheetHeight}px`} as CSSProperties}>{data.error&&<div role="status">{data.error} <button className="btn" onClick={data.retry}>Retry</button></div>}
 <div className="coin-head"><div className="coin-id"><h1 title={`$${identity?inertText(identity.symbol.text):address}`}>{identity?<Decode text={`$${inertText(identity.symbol.text)}`}><span>$<UntrustedText value={identity.symbol}/></span></Decode>:'Coin'}</h1><div><div className="sub"><BlueChipBadge value={card?.blueChip} />{row&&<HeatTag heat={displayHeat({...row,verdict:verdict?.level??row.verdict})}/>} {identity&&<><UntrustedText value={identity.name}/><span className="addr" title={address}>{short(address)} <button className="iconbtn" aria-label="Copy address" onClick={()=>void navigator.clipboard?.writeText(address)}>⧉</button></span><span>{launchpadLabel(identity.launchpad, identity.stage === 'graduated')}</span><span>{identity.stage==='graduated'?'Migrated':identity.stage==='unknown'?'Stage not checked':`Curve ${card?.identity.curvePct??'—'}%`}</span>{row&&<span>{formatAge(row.ageSec)} old</span>}</>}</div><div className="coin-price"><b>{px===undefined || row?.priceUnavailable ? NOT_CHECKED : <Roll value={formatCoinPrice(px)}/>}</b>{row&&<><span className={`num${row.change1hPct>=0?' up':''}`}>{row.unavailable?.includes('change') ? NOT_CHECKED : pct(row.change1hPct)} 1h</span>{row.change24hPct!==undefined&&<span className="num muted">{row.unavailable?.includes('change') ? NOT_CHECKED : pct(row.change24hPct)} 24h</span>}</>}{row&&<span className="muted" title="Fully diluted value: price × total supply, the same figure as Radar">FDV {row.marketCapUsd===undefined||row.unavailable?.includes('marketCap') ? NOT_CHECKED : usd(row.marketCapUsd)}</span>}</div></div></div><div className="coin-actions"><WatchButton kind="coin" target={address}/>{config?.flags.deep_research&&<button className="btn" onClick={()=>void api('/research',{body:{target:address}}).then(()=>toast({kind:'info',title:'Deep Research started'})).catch(()=>toast({kind:'error',title:'Could not start Deep Research.'}))}><IconLab/>Deep Research</button>}<button className="btn" onClick={()=>void navigator.clipboard?.writeText(location.href).then(()=>toast({kind:'ok',title:'Share link copied'})).catch(()=>toast({kind:'error',title:'Could not copy the share link.'}))}><IconOut/>Share</button></div></div>
 <div className="coin-guard-status">{guardData.failed?<p role="status">{guardData.card||guardData.assessment?GUARD_REFRESH_FAILED:GUARD_UNAVAILABLE} <button className="btn btn-sm" onClick={guardData.retry}>Retry Guard</button></p>:null}</div><div className="coin-grid"><div className="coin-center"><ChartStage market={identity?inertText(identity.symbol.text):address} timeframe={tf} onTimeframe={setTf} bars={bars} markers={markers} supply={row?.marketCapUsd&&row.priceUsd?row.marketCapUsd/row.priceUsd:Number(card?.supply.circulating??1)} verdict={headerGuard?<button data-tour="verdict" className="coin-verdict-button" aria-label="Open verdict evidence" onClick={showEvidence}><VerdictChip level="pending" guard={headerGuard} showGaps={false}/></button>:verdict?<button data-tour="verdict" className="coin-verdict-button" aria-label="Open verdict evidence" onClick={showEvidence}><VerdictChip level={verdict.level} guard={primaryGuard} showGaps={false} evaluatedPlaybooks={verdict.evaluatedPlaybooks} meta={card?.meta} detail={top?PLAYBOOK_NAMES[top.id]:undefined}/></button>:<VerdictChip level="pending" verdictPending/>} delayedSec={delay} ownToken={ownToken} burnWallet={config?.wallets.burn} launchTs={launchTs} labelsUnavailable={data.labelsUnavailable || card?.meta?.flow?.unavailable} crewsEnabled={config?.flags.rug_ring_radar}/>
 {(!bars.length||data.candlesUnavailable)&&!data.error&&<p role="status">{data.candlesLoading ? 'Loading indexed candles…' : data.candlesUnavailable ? SUB_MINUTE_UNAVAILABLE : <>{emptyTradeWindow(data.lastTradeTs)} {!fullHistory && data.lastTradeTs!=null && <button className="btn btn-sm" onClick={()=>setFullHistory(true)}>{FULL_HISTORY}</button>}</>}</p>}
 <div className="coin-tabs"><Tabs tabs={tabs} value={tab} onChange={setTab} label="Coin details" id="coin-details"/></div>{activeValues.map((name,i)=><TabPanel key={name} id="coin-details" index={i} active={tab===name}>{name==='Overview'?<>{!!delay&&<span className="tag">Delayed ~{delay} s</span>}{guardData.card?<>{verdict&&!primaryGuard&&<CoinVerdict verdict={verdict} evidenceOpen={evidence}/>}<GuardCard card={guardData.card} assessment={guardData.assessment??undefined} evidenceOpen={evidence}/></>:guardData.assessment?<GuardAssessment guard={guardData.assessment} evidenceOpen={evidence}/>:card&&verdict?<CoinOverview card={card} verdict={verdict} flows={data.flows} evidenceOpen={evidence} ownToken={ownToken} launchBurn={!!launch} ageSec={data.ageSec}/>:verdict?<CoinVerdict verdict={verdict} evidenceOpen={evidence}/>:<div className="skel" aria-label="Loading coin card"/>}</>:name==='Signal'&&card?.signal?<CoinSignalPanel signal={card.signal} series={bars.map(b=>b.c)}/>:name==='Flow'?<div className="ov-grid"><section className="panel"><div className="panel-head"><h3>Who is buying</h3></div><div className="panel-body">{data.flows.map(f=><div className="coin-flow-window" key={f.window}><span>{f.window}</span><FlowBar flow={f} unavailable={card?.meta?.flow?.unavailable} legend/></div>)}<p className="note">Declared labels come from registry data; likely labels from on-chain behaviour. Estimates, not facts.</p></div></section><section className="panel panel-body"><h3>Largest wallets in the last hour</h3><Trades markers={markers.filter(m=>m.ts>=Date.now()/1000-3600).sort((a,b)=>a.sizeUsd-b.sizeUsd).slice(-6)}/></section></div>:<Trades markers={markers}/>}</TabPanel>)}{!guardData.card&&!guardData.assessment&&<p className="foot-meta">As of block {(verdict?.lastChecked?.block??verdict?.asOfBlock??card?.freshness.block??0).toLocaleString()} · rated {age(Math.max(0,data.ageSec))} ago</p>}<BlueChipDetails value={card?.blueChip} criteria={card?.blueChipCriteria} /><AnalysisPolicyNotice page /></div>
 <aside ref={sheetRef} className={`coin-aside${phone?' coin-sheet':''}${sheet?' expanded':''}`}><section className="panel"><div className="panel-head coin-section-head"><h3>Trade</h3>{phone?<button className="btn btn-sm" aria-expanded={sheet} onClick={()=>setSheet(!sheet)}>{sheet?'Collapse':'Expand'}</button>:<span className="muted">Guarded · non-custodial</span>}</div>{stale&&<p role="status" className="coin-stale">Data is stale — trading paused.</p>}<div className="panel-body" hidden={phone&&!sheet} inert={phone&&!sheet}><TradePanel key={address} coin={address} priceUsd={px} priceUnavailable={row?.priceUnavailable} priceFormat={formatCoinPrice} guard={guardData.assessment ?? verdict?.guardV2} stale={stale} visible={!phone||sheet} antiSnipeEndsAt={antiSnipeEndsAt} /></div></section><section className="panel coin-your-agents"><div className="panel-head"><h3>Your agents</h3><Link to="/mission">Mission Control</Link></div><div className="panel-body"><ul className="mine">{agents.map(a=><li key={a.id}><Link to={`/mission/agents/${a.id}`}>{a.name}</Link><span>{a.status.replaceAll('_',' ')}</span></li>)}</ul>{!agents.length&&<p className="muted">No connected on-chain agents.</p>}<p className="note">Connected agents get this same verdict when they call <span className="addr">preflight</span> before an order.</p></div></section></aside></div></div></AnalysisPolicyScope>;
}
