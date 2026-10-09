import { EventEmitter } from 'node:events';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { binary, readFlows, readCensus, readMarkers } from '@eko/db';
import { EngineWorker, refreshCoinFlow, refreshCensus, refreshFlows, FP_MODEL, type FlowOptions } from '@eko/engines';
import { CensusSchema, FlowSchema, ChartMarkerSchema, FeedItemSchema, WsServerSchema } from '@eko/shared';
import type { WebSocket } from 'ws';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { seedReadFixture, sampleAddress } from './read-fixture.js';
import { Hub } from '../src/ws/hub.js';
import { ReadLive } from '../src/read/live.js';
const hash=(n:number)=>`0x${n.toString(16).padStart(64,'0')}`;
let built:Awaited<ReturnType<typeof buildApp>>,coin:ReturnType<typeof sampleAddress>;
const sec=1790985600,now=(sec+1000)*1000;
const crewAt:NonNullable<FlowOptions['crewAt']>=async(address)=>({status:'available',member:address===sampleAddress(4)?{status:'qualified',crewId:'crew_fixture',confidence:0.95,evidence:[]}:null});
const options:FlowOptions={crewAt};
async function label(wallet:number,block:number,kind='human',confidence=0.9,model=FP_MODEL.version) {
  await built.ctx.dbh.chain.sql.query('INSERT INTO wallet_labels VALUES($1,$2,$3,$4,$5,$6,NULL,$7,$8,$9)',[`label-${wallet}-${block}-${model}`,binary(sampleAddress(wallet)),kind,confidence,confidence>=0.9?'high':'medium','fingerprint',{},model,block]);
}
async function swap(n:number,wallet:number,time:number,changes:Record<string,unknown>={}) {
  const db=built.ctx.dbh.chain;
  await db.insert('swaps',{ts:new Date(time*1000),block:n,tx_hash:binary(hash(n)),log_index:0,venue:'pons_curve',pool_id:binary(coin),coin:binary(coin),quote_asset:binary(sampleAddress(0)),trader:binary(sampleAddress(wallet)),tx_from:binary(sampleAddress(wallet)),tx_to:binary(coin),side:1,amount_coin:'100',amount_quote:'1',price_quote:1,usd:100,priced_block:n,...changes});
}
beforeAll(async()=>{
  vi.spyOn(Date,'now').mockReturnValue(now);
  built=await buildApp(loadConfig({NODE_ENV:'test',PGLITE_DIR:':memory:',SESSION_SECRET:'test-only-placeholder'.repeat(2),LEGACY_API:'false',RUN_WORKER:'false',MARKET_DATA_SOURCE:'onchain'}),{startBackground:false});
  built.ctx.reads.store.now=()=>now;coin=(await seedReadFixture(built.ctx.dbh.chain,now)).identity.address;
  const db=built.ctx.dbh.chain;await db.ensurePartitions(new Date(sec*1000));
  // This isolated fixture keeps the card/read projection and replaces its sample trades.
  await db.sql.query('DELETE FROM swaps WHERE coin=$1',[binary(coin)]);
  for(const [n,time] of [[1,sec],[2,sec+800],[3,sec+900],[4,sec+950],[5,sec+990],[6,sec+1000],[7,sec+1010],[8,sec+1020]])await db.insert('chain_blocks',{number:n,block:n,hash:binary(hash(100+n)),parent_hash:binary(hash(99+n)),ts:new Date(time*1000)});
  await label(2,1,'declared_agent',0.99);await label(3,1,'likely_agent',0.8);await label(4,1);await label(5,1);
  await swap(2,2,sec+800);await swap(3,3,sec+900);await swap(4,4,sec+950);await swap(5,5,sec+990);
});
afterAll(async()=>{await built.close();vi.restoreAllMocks();});
describe('flow/Census indexed API',()=>{
  it('serves measured windows, cards/lists, historical markers and structured Feed events',async()=>{
    await refreshCoinFlow(built.ctx.dbh.chain,coin,6,options);
    const flow=FlowSchema.parse((await built.app.inject(`/v1/coins/${coin}/flow?window=5m`)).json());
    expect(flow).toMatchObject({agentPct:50,crewPct:25,humanPct:25,declaredAgentPct:25,likelyAgentPct:25,beta:true,confidence:1,modelVersion:FP_MODEL.version});expect(flow.meta?.unavailable).toBe(false);
    for(const route of ['/v1/radar','/v1/pairs?stage=new']) {const row=(await built.app.inject(route)).json().rows.find((r:{address:string})=>r.address===coin);expect(row.flow.agentPct).toBe(50);expect(row.unavailable).not.toContain('flow');expect(row.flow.beta).toBe(true);expect(row.flow.confidence).toBe(1);}
    const card=(await built.app.inject(`/v1/coins/${coin}`)).json();expect(card.flow.agentPct).toBe(50);expect(card.meta.flow.unavailable).toBe(false);
    const response=(await built.app.inject(`/v1/coins/${coin}/markers?from=${sec}&to=${sec+1001}`)).json();expect(response.markers).toHaveLength(4);for(const marker of response.markers)expect(ChartMarkerSchema.parse(marker).beta).toBe(true);
    const feed=(await built.app.inject('/v1/feed?kinds=agent_trade,crew_trade')).json();expect(feed.unavailable).not.toContain('agent_trade');expect(feed.rows).toHaveLength(3);for(const row of feed.rows){const event=FeedItemSchema.parse(row);expect(event.side).toBe('buy');expect(event.wallet).toBeDefined();expect(event.sizeUsd).toBe(100);expect(event.beta).toBe(true);expect(event.confidence).toBeGreaterThanOrEqual(0.75);}
  });
  it('hides stale enrichment, then rebuilds instead of treating unresolved mass as human',async()=>{
    const db=built.ctx.dbh.chain;
    await swap(6,5,sec+1000,{senders_pending:true,pricing_pending:true,usd:null});
    expect((await readFlows(db,[coin])).size).toBe(0);expect((await readMarkers(db,coin,sec,sec+1001)).unavailable).toContain('labels');
    await refreshCoinFlow(db,coin,6,options);
    let flow=(await readFlows(db,[coin],'5m')).get(coin)!;expect(flow.meta?.unavailable).toBe(true);expect(flow.meta?.flags).toEqual(expect.arrayContaining(['price']));
    await db.sql.query('UPDATE swaps SET senders_pending=false,pricing_pending=false,usd=100 WHERE tx_hash=$1',[binary(hash(6))]);
    await refreshCoinFlow(db,coin,6,options);flow=(await readFlows(db,[coin],'5m')).get(coin)!;expect(flow.humanPct).toBe(40);expect(flow.agentPct).toBe(40);expect(flow.meta?.unavailable).toBe(false);
  });
  it('keeps labels at original marker blocks while window labels change at the requested cut',async()=>{
    await label(5,7,'likely_agent',0.8);
    await refreshCoinFlow(built.ctx.dbh.chain,coin,7,options);
    expect((await readFlows(built.ctx.dbh.chain,[coin],'5m')).get(coin)?.likelyAgentPct).toBe(60);
    const markers=await readMarkers(built.ctx.dbh.chain,coin,sec,sec+1011);expect(markers.markers.filter(m=>m.wallet===sampleAddress(5)).every(m=>m.label==='human')).toBe(true);
    await refreshCoinFlow(built.ctx.dbh.chain,coin,6,options);expect((await readFlows(built.ctx.dbh.chain,[coin],'5m')).get(coin)?.likelyAgentPct).toBe(20);
    await refreshCoinFlow(built.ctx.dbh.chain,coin,7);expect((await readFlows(built.ctx.dbh.chain,[coin],'5m')).get(coin)?.meta?.flags).toContain('crew_membership');
    const events=await readMarkers(built.ctx.dbh.chain,coin,sec,sec+1011);expect(events.markers.every(m=>m.label==='declared_agent')).toBe(true);expect(events.unavailable).toContain('labels');
  });
  it('uses the latest current-model gate, suppresses every headline while gated and requires finalized coverage',async()=>{
    const db=built.ctx.dbh.chain;
    let census=CensusSchema.parse((await built.app.inject('/v1/census')).json());expect(census.gated).toBe(true);expect(census.chain).toEqual([]);expect(census.coins).toEqual([]);expect(census.gate.modelVersion).toBe(FP_MODEL.version);
    await db.sql.query("INSERT INTO eval_gates(id,metric,model_version,value,wilson_lower,recall,evaluated_at) VALUES('other','likely_agent_precision','fp-other',1,0.98,0.9,$1)",[new Date(now)]);
    expect((await readCensus(db,now)).gate.value).toBeNull();
    await db.sql.query("INSERT INTO eval_gates(id,metric,model_version,value,wilson_lower,recall,evaluated_at) VALUES('pass','likely_agent_precision',$1,0.90,0.85,0.8,$2)",[FP_MODEL.version,new Date(now-1000)]);
    // Synthetic publication metadata; no independently reviewed precision is claimed.
    await db.sql.query("UPDATE eval_gates SET expires_at=$1,model_hash=$2,dataset_hash=$3,evidence=$4 WHERE id='pass'",
      [new Date(now+86400_000),'a'.repeat(64),'b'.repeat(64),JSON.stringify({declared:1,agents:200,humans:300,disagreements:0,predictedAgents:200})]);
    expect((await readCensus(db,now)).gated).toBe(true);expect((await readCensus(db,now)).chain).toEqual([]);
    expect(await refreshCensus(db,options)).toEqual({status:'unavailable'});
    await refreshCoinFlow(db,coin,7,options);await refreshCensus(db,{...options,finalized:{status:'available',block:6}});
    census=await readCensus(db,now);expect(census.gated).toBe(false);expect(census.chain.map(r=>r.asOfBlock)).toEqual([6,6]);expect(census.chain[0].agentPct).toBe(40);expect((await readFlows(db,[coin])).get(coin)?.beta).toBe(false);
    await db.sql.query("INSERT INTO eval_gates(id,metric,model_version,value,wilson_lower,recall,evaluated_at) VALUES('fail','likely_agent_precision',$1,0.89,0.84,0.8,$2)",[FP_MODEL.version,new Date(now)]);
    census=await readCensus(db,now);expect(census.gated).toBe(true);expect(census.chain).toEqual([]);expect(census.coins).toEqual([]);expect((await readFlows(db,[coin])).get(coin)?.beta).toBe(true);
  });
  it('coalesces flow WS updates, deduplicates markers and replays Feed with beta/confidence',async()=>{
    class Socket extends EventEmitter {readyState=1;bufferedAmount=0;messages:unknown[]=[];send(raw:string){this.messages.push(JSON.parse(raw));}close(){this.emit('close');}}
    const socket=new Socket(),hub=new Hub();hub.addV1(socket as unknown as WebSocket);socket.emit('message',JSON.stringify({op:'sub',ch:[`flow:${coin}`,'feed']}));
    const db=built.ctx.dbh.chain,live=new ReadLive(built.ctx.reads,hub);await live.start(db.bus);
    try {
      await refreshCoinFlow(db,coin,7,options);await refreshCoinFlow(db,coin,7,options);await live.drain();
      await new Promise(resolve=>setTimeout(resolve,1100));await live.drain();
      const events=socket.messages.flatMap(m=>{const p=WsServerSchema.parse(m);return p.t==='ev'?[p]:[];});
      expect(events.filter(e=>e.kind==='flow')).toHaveLength(1);expect(events.filter(e=>e.kind==='marker')).toHaveLength(5);expect(events.filter(e=>e.kind==='item'&&e.data.kind==='agent_trade')).toHaveLength(2);
      const flow=events.find(e=>e.kind==='flow')!;expect(flow.data).toMatchObject({beta:true,confidence:1,meta:{unavailable:false}});
      const seq=events.filter(e=>e.ch===`flow:${coin}`).map(e=>e.seq);expect(seq).toEqual(seq.map((_,i)=>i+1));
    } finally {await live.close();hub.closeAll();}
  });
  it('invalidates snapshots on correction/reorg and debounces source-driven refreshes',async()=>{
    const db=built.ctx.dbh.chain;await refreshCoinFlow(db,coin,7,options);
    await swap(8,5,sec+1020);expect(await refreshFlows(db,8,options)).toEqual({coins:0});expect((await readFlows(db,[coin])).size).toBe(0);
    await db.sql.query("UPDATE flow_windows SET updated_at=now()-interval '2 seconds' WHERE coin=$1",[binary(coin)]);
    expect(await refreshFlows(db,8,options)).toEqual({coins:1});expect((await readFlows(db,[coin])).size).toBe(1);
    await db.tx(tx=>tx.deleteAbove(6n));expect((await readFlows(db,[coin])).size).toBe(0);expect((await readCensus(db,now)).chain).toEqual([]);
  });
  it('rebuilds historical markers when a late label correction predates the 24-hour window',async()=>{
    const db=built.ctx.dbh.chain,other=sampleAddress(600);
    await db.insert('tokens',{address:binary(other),first_block:9,block:9,name:'History fixture',symbol:'HIST'});
    for(const [n,time] of [[9,sec-90000],[10,sec+1100]])await db.insert('chain_blocks',{number:n,block:n,hash:binary(hash(100+n)),parent_hash:binary(hash(99+n)),ts:new Date(time*1000)});
    await db.insert('swaps',{ts:new Date((sec-90000)*1000),block:9,tx_hash:binary(hash(9)),log_index:0,venue:'pons_curve',pool_id:binary(other),coin:binary(other),quote_asset:binary(sampleAddress(0)),trader:binary(sampleAddress(2)),tx_from:binary(sampleAddress(2)),tx_to:binary(other),side:1,amount_coin:'100',amount_quote:'1',price_quote:1,usd:100,priced_block:9});
    expect((await db.sql.query('SELECT * FROM flow_dirty WHERE coin=$1',[binary(other)])).rows).toMatchObject([{from_sec:sec-90000}]);
    expect((await db.sql.query('SELECT * FROM swaps WHERE coin=$1',[binary(other)])).rows).toHaveLength(1);
    expect((await refreshCoinFlow(db,other,10,options)).swaps).toBe(1);
    expect((await db.sql.query('SELECT data FROM flow_events WHERE coin=$1',[binary(other)])).rows).toHaveLength(1);
    expect((await readMarkers(db,other,sec-90001,sec-89999)).markers[0].label).toBe('declared_agent');
    await label(2,9,'likely_agent',0.8);
    expect((await readMarkers(db,other,sec-90001,sec-89999)).unavailable).toContain('labels');
    await refreshCoinFlow(db,other,10,options);
    expect((await readMarkers(db,other,sec-90001,sec-89999)).markers[0].label).toBe('likely_agent');
  });
  it('carries the worker fingerprint generation into flow and refuses an older-model gate',async()=>{
    const db=built.ctx.dbh.chain,model={...FP_MODEL,version:'fp-fixture-2'};
    await new EngineWorker(db,{fingerprints:{model},flow:options}).replay(6,6);
    const census=await readCensus(db,now);
    expect(census.gate.modelVersion).toBe(model.version);expect(census.gate.value).toBeNull();expect(census.gated).toBe(true);expect(census.chain).toEqual([]);
  });
});
