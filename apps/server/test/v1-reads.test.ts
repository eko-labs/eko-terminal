import { EventEmitter } from 'node:events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { binary, InProcessBus } from '@eko/db';
import { BarSchema, CoinCardSchema, FeedItemSchema, FlowSchema, PairRowSchema, RadarRowSchema, ScanResultSchema, VerdictSchema, WsServerSchema } from '@eko/shared';
import type { WebSocket } from 'ws';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { ReadLive } from '../src/read/live.js';
import { Hub } from '../src/ws/hub.js';
import { seedReadFixture, sampleAddress } from './read-fixture.js';
const envelope=<T>(schema:z.ZodType<T>)=>z.object({rows:z.array(schema),cursor:z.string().nullable(),delayedSec:z.literal(0),unavailable:z.array(z.string()).optional()});
class Socket extends EventEmitter {
  readyState=1;bufferedAmount=0;messages:unknown[]=[];
  send(raw:string){this.messages.push(JSON.parse(raw));}
  close(){this.emit('close');}
}
let built:Awaited<ReturnType<typeof buildApp>>,card:import('@eko/shared').CoinCard;
const now=Date.now();
beforeAll(async()=>{
  built=await buildApp(loadConfig({NODE_ENV:'test',PGLITE_DIR:':memory:',SESSION_SECRET:'test-only-placeholder'.repeat(2),LEGACY_API:'false',RUN_WORKER:'false',MARKET_DATA_SOURCE:'onchain'}),{startBackground:false});
  built.ctx.reads.store.now=()=>now;
  card=await seedReadFixture(built.ctx.dbh.chain,now);
});
afterAll(async()=>{await built.close();});
describe('v1 indexed read routes',()=>{
  it('parses every route, reports measured gaps, and never uses RPC',async()=>{
    const routes=[['/v1/radar',envelope(RadarRowSchema)],['/v1/pairs?stage=new',envelope(PairRowSchema)],['/v1/feed',envelope(FeedItemSchema)],
      [`/v1/coins/${card.identity.address}`,CoinCardSchema],[`/v1/coins/${card.identity.address}/verdict`,VerdictSchema],
      [`/v1/coins/${card.identity.address}/candles?tf=5m&from=${Math.floor(now/1000)-86400}&to=${Math.floor(now/1000)}`,z.object({bars:z.array(BarSchema),tf:z.literal('5m'),asOfBlock:z.number()})],
      [`/v1/coins/${card.identity.address}/flow?window=5m`,FlowSchema],[`/v1/scan?q=${card.identity.address}`,ScanResultSchema]] as const;
    const before=JSON.stringify(built.ctx.chains.meter.usage());
    for(const [url,schema] of routes){const res=await built.app.inject(url);expect(res.statusCode,url).toBe(200);expect(schema.safeParse(res.json()).success,url).toBe(true);}
    expect(JSON.stringify(built.ctx.chains.meter.usage())).toBe(before);
    const radar=(await built.app.inject('/v1/radar')).json().rows[0];
    // Exit cost and flow have no reading yet; the money in the coin's curve or pool is read from indexed rows.
    expect(radar.unavailable).toEqual(expect.arrayContaining(['exitCost','flow']));
    if(!radar.unavailable.includes('liquidity'))expect(radar.liquidityUsd).toBeGreaterThanOrEqual(0);
    expect(radar.unavailable).not.toContain('change');expect(radar.priceUsd).toBeGreaterThan(0);expect(radar.change1hPct).toBe(0);expect(radar.change24hPct).toBeUndefined();
    const feedResponse=(await built.app.inject('/v1/feed')).json();expect(feedResponse.unavailable).toEqual(['agent_trade','crew_trade','clone','swarm','burn']);const feedRows=feedResponse.rows;expect(feedRows[0].ts).toBeGreaterThan(now-86400000);
    expect(radar.verdict).toBe('pending');expect(radar.verdictPending).toBe(false);
    const flow=(await built.app.inject(`/v1/coins/${card.identity.address}/flow?window=24h`)).json();expect(flow.meta.unavailable).toBe(true);
    const markers=await built.app.inject(`/v1/coins/${card.identity.address}/markers?from=1&to=2`);expect(markers.json()).toEqual({rows:[],markers:[],cursor:null,unavailable:['labels'],delayedSec:0});
    for(const tf of ['1m','15m','1h','4h','1d','1s','15s'])expect((await built.app.inject(`/v1/coins/${card.identity.address}/candles?tf=${tf}&from=1&to=2`)).statusCode).toBe(200);
    const feed=(await built.app.inject('/v1/feed')).json().rows;expect(feed.some((r:{kind:string})=>r.kind==='verdict')).toBe(true);expect(feed.find((r:{kind:string})=>r.kind==='verdict').firstVerdictMs).toBe(0);
  });
  it('uses last checked time for API freshness, preserves the original receipt block, and exposes live price facts',async()=>{
    const db=built.ctx.dbh.chain,coin=card.identity.address;
    await db.sql.query('UPDATE coin_rating_checks SET checked_at=$2,checked_block=$3 WHERE coin=$1',[binary(coin),new Date(now-60_000),card.verdict.asOfBlock]);
    const response=(await built.app.inject(`/v1/coins/${coin}`)).json();
    expect(response.freshness.ageSec).toBe(60);expect(response.verdict.asOfBlock).toBe(card.verdict.asOfBlock);
    expect(response.verdict.lastChecked.at).toBe(new Date(now-60_000).toISOString());
    const prices=(await db.sql.query('SELECT * FROM coin_rating_prices WHERE coin=$1',[binary(coin)])).rows[0];
    if(!prices)throw new Error('Fixture must include a priced trade');
    await db.sql.query('UPDATE coin_rating_prices SET price=peak*0.15 WHERE coin=$1',[binary(coin)]);
    const verdict=(await built.app.inject(`/v1/coins/${coin}/verdict`)).json();
    expect(verdict.priceMove.downFromPeakPct).toBe(85);
    expect((await built.ctx.reads.store.rows(coin))[0].row.priceMove?.downFromPeakPct).toBe(85);
    expect((await built.ctx.reads.store.rows(coin))[0].row.ratingAgeSec).toBe(60);
    expect(verdict.level).toBe(card.verdict.level);
    await db.sql.query('UPDATE coin_rating_prices SET price=$2 WHERE coin=$1',[binary(coin),prices.price]);
  });
  it('keeps identity-only tokens pending in search and never fabricates a card',async()=>{
    const db=built.ctx.dbh.chain;
    await db.insert('tokens',{address:binary(sampleAddress(801)),first_block:'1',block:'1',name:'Pool sample',symbol:'POOL',launchpad:'other'});
    const scan=ScanResultSchema.parse((await built.app.inject('/v1/scan?q=$POOL')).json());expect(scan.status).toBe('pending');expect(scan.card).toBeUndefined();expect(scan.candidates?.[0].verdictPending).toBe(true);
    for(const url of ['/v1/radar','/v1/pairs?stage=migrated'])expect((await built.app.inject(url)).json().rows.some((r:{address:string})=>r.address===sampleAddress(801))).toBe(false);
    const waiting=sampleAddress(802);
    await db.insert('tokens',{address:binary(waiting),deployer:binary(sampleAddress(804)),curve:binary(sampleAddress(803)),launchpad:'pons',first_block:String(card.verdict.asOfBlock),block:String(card.verdict.asOfBlock),name:'Pending launch',symbol:'WAIT'});
    for(const url of ['/v1/radar','/v1/pairs?stage=new']) {const row=(await built.app.inject(url)).json().rows.find((r:{address:string})=>r.address===waiting);expect(row.verdictPending).toBe(true);expect(row.verdict).toBe('pending');}
    expect((await built.app.inject(`/v1/coins/${waiting}`)).statusCode).toBe(404);
    await db.sql.query('DELETE FROM tokens WHERE address=$1',[binary(waiting)]);
    const coin=await built.app.inject(`/v1/coins/${sampleAddress(801)}`);expect(coin.statusCode).toBe(404);expect(coin.json().message).toContain('No coin card');
    expect((await built.app.inject(`/v1/scan?q=${sampleAddress(999)}`)).json().status).toBe('pending');
    expect((await built.app.inject(`/v1/coins/${sampleAddress(999)}`)).statusCode).toBe(404);
    for(const url of ['/v1/radar?cursor=invalid','/v1/pairs?stage=wrong','/v1/feed?kinds=wrong','/v1/coins/not-an-address','/v1/scan?q=','/v1/coins/'+card.identity.address+'/candles?tf=bad&from=2&to=1'])expect((await built.app.inject(url)).statusCode,url).toBe(422);
  });
  it('ranks by measured last-hour volume then address whatever the grade, paginates, and drops idle coins',async()=>{
    const db=built.ctx.dbh.chain;
    for(let i=0;i<104;i++) {
      const address=sampleAddress(1000+i),level=(['clear','monitor','pending','danger'] as const)[i%4];
      const copy=structuredClone(card);copy.identity.address=address;copy.identity.createdAt=new Date(now).toISOString();copy.identity.curvePct=i===0?75:20;copy.verdict={...copy.verdict,coin:address,level};
      const id=`synthetic-${i}`;
      await db.insert('tokens',{address:binary(address),deployer:binary(sampleAddress(2000+i)),curve:binary(sampleAddress(3000+i)),launchpad:'pons',first_block:String(card.verdict.asOfBlock),block:String(card.verdict.asOfBlock),name:'Sample',symbol:'DEMO'});
      await db.sql.query('INSERT INTO coin_cards(id,coin,valid_from_block,hash,data) VALUES($1,$2,$3,$4,$5)',[id,binary(address),card.verdict.asOfBlock,id,copy]);
      await db.sql.query('INSERT INTO coin_card_latest(coin,card_id,as_of_block,data) VALUES($1,$2,$3,$4)',[binary(address),id,card.verdict.asOfBlock,copy]);
      await db.sql.query('INSERT INTO verdicts(id,coin,valid_from_block,rules_version,signature,data) VALUES($1,$2,$3,$4,$5,$6)',[id,binary(address),card.verdict.asOfBlock,'test',id,copy.verdict]);
    }
    for(const [address,volume] of [[sampleAddress(1000),100],[sampleAddress(1004),200]] as const) {
      await db.sql.query('UPDATE tokens SET total_supply=100,decimals=0 WHERE address=$1',[binary(address)]);
      for(const [offset,price] of [[25*3600,2],[2*3600,4],[600,8]])await db.sql.query('INSERT INTO bars_1m(coin,minute,open,high,low,close,volume_usd,trades,first_block,last_block) VALUES($1,$2,$3,$3,$3,$3,$4,1,$5,$5)',[binary(address),new Date(Math.floor((now/1000-offset)/60)*60000),price,volume,card.verdict.asOfBlock]);
    }
    await db.sql.query('INSERT INTO bars_1m(coin,minute,open,high,low,close,volume_usd,trades,first_block,last_block) VALUES($1,$2,1,1,1,1,1,1,$3,$3)',[binary(sampleAddress(1008)),new Date(now-2*3600000),card.verdict.asOfBlock]);
    const hourOnly=(await built.app.inject('/v1/radar')).json().rows.find((r:{address:string})=>r.address===sampleAddress(1008));expect(hourOnly.unavailable).not.toContain('change');expect(hourOnly.change24hPct).toBeUndefined();
    const measured=RadarRowSchema.parse((await built.app.inject('/v1/radar')).json().rows.find((r:{address:string})=>r.address===sampleAddress(1000)));
    // Last hour: the bar ten minutes ago. Usual hour: the bar two hours ago over the 23 earlier hours of the last day.
    expect(measured).toMatchObject({volume1hUsd:100,trades1h:1});expect(measured.volumeBaselineUsd).toBeCloseTo(100/23,6);
    expect(measured.priceUsd).toBe(8);expect(measured.change1hPct).toBe(100);expect(measured.change24hPct).toBe(300);expect(measured.marketCapUsd).toBe(800);expect(measured.unavailable).not.toContain('change');expect(measured.unavailable).not.toContain('marketCap');
    const bars=(await built.app.inject(`/v1/coins/${sampleAddress(1000)}/candles?tf=5m&from=${Math.floor(now/1000)-26*3600}&to=${Math.floor(now/1000)}`)).json().bars;
    expect(bars.map((b:{c:number})=>b.c)).toEqual([2,4,8]);
    const empty=(await built.app.inject(`/v1/coins/${card.identity.address}/candles?tf=5m&from=${Math.floor(now/1000)-3600}&to=${Math.floor(now/1000)}`)).json();
    expect(empty.bars).toEqual([]);expect(empty.lastTradeTs).toBe(Math.floor(now/1000)-7200);expect(empty.firstTradeTs).toBe(empty.lastTradeTs);
    await db.sql.query('UPDATE tokens SET graduated_block=$2 WHERE address=$1',[binary(sampleAddress(1001)),card.verdict.asOfBlock+10]);
    await db.sql.query('UPDATE tokens SET graduated_block=$2 WHERE address=$1',[binary(sampleAddress(1005)),card.verdict.asOfBlock+20]);
    expect((await built.app.inject('/v1/pairs?stage=migrated')).json().rows.map((r:{address:string})=>r.address)).toEqual([sampleAddress(1005),sampleAddress(1001)]);
    await built.ctx.reads.store.currentModels();await built.ctx.reads.radar.refreshTotals();
    const global=(await built.app.inject('/v1/radar')).json().totals;expect(global.coins).toBe(105);expect(global.danger).toBe(26);expect(global.pending).toBe(27);
    // A run counts when its card was written (created_at, 0191), not at its block time: the fixture's run is for a block
    // two hours ago but was written now, so it is "scanned today" and lands in the newest of the 24 hourly buckets.
    expect(global.evaluatedToday).toBe(1);
    // Hourly series cover the last 24 hours, oldest first, from the same runs and verdicts.
    expect(global.evaluatedByHour).toHaveLength(24);expect(global.dangerByHour).toHaveLength(24);
    expect(global.evaluatedByHour.indexOf(1)).toBe(23);expect(global.evaluatedByHour.reduce((a:number,b:number)=>a+b,0)).toBe(1);
    // Rows written before 0191 have no created_at and count by their block time: two hours ago is the 22nd bucket.
    await db.sql.query('UPDATE engine_runs SET created_at=NULL');
    await built.ctx.reads.radar.refreshTotals();
    const legacy=(await built.app.inject('/v1/radar')).json().totals;
    expect(legacy.evaluatedToday).toBe(now%86400000>=7200000 ? 1 : 0);expect(legacy.evaluatedByHour.indexOf(1)).toBe(21);
    const first=envelope(RadarRowSchema).parse((await built.app.inject('/v1/radar')).json());expect(first.rows).toHaveLength(100);expect(first.rows[0].address).toBe(sampleAddress(1004));expect(first.rows[1].address).toBe(sampleAddress(1000));expect(first.cursor).not.toBeNull();
    const second=envelope(RadarRowSchema).parse((await built.app.inject(`/v1/radar?cursor=${first.cursor}`)).json());expect(second.cursor).toBeNull();
    const rows=[...first.rows,...second.rows];
    expect(new Set(rows.map(r=>r.address)).size).toBe(rows.length);
    // Most traded first across pages; the grades are mixed, not grouped.
    const volumes=rows.map(r=>r.volume1hUsd ?? 0);
    expect(volumes).toEqual([...volumes].sort((a,b)=>b-a));
    expect(new Set(first.rows.slice(0,20).map(r=>r.verdict)).size).toBeGreaterThan(1);
    expect((await built.app.inject('/v1/scan?q=$DEMO')).json().status).toBe('ambiguous');
    const feedPage=envelope(FeedItemSchema).parse((await built.app.inject('/v1/feed?kinds=new_pair')).json());expect(feedPage.rows).toHaveLength(100);expect(feedPage.cursor).not.toBeNull();
    const feedNext=envelope(FeedItemSchema).parse((await built.app.inject(`/v1/feed?kinds=new_pair&cursor=${feedPage.cursor}`)).json());expect(feedNext.rows.length).toBeGreaterThan(0);expect(feedNext.rows.every(r=>r.kind==='new_pair')).toBe(true);
    const near=envelope(PairRowSchema).parse((await built.app.inject('/v1/pairs?stage=near_grad')).json());expect(near.rows.map(r=>r.address)).toContain(sampleAddress(1000));
    built.ctx.reads.store.now=()=>now+8*86400000;
    expect((await built.app.inject('/v1/radar')).json().rows).toHaveLength(0); // identity-only tokens are searchable, never live plays
    built.ctx.reads.store.now=()=>now;
  });
  it('orders typed live events, coalesces reranks/ticks, and signals backpressure',async()=>{
    const socket=new Socket(),hub=new Hub(),bus=new InProcessBus();hub.addV1(socket as unknown as WebSocket);
    socket.emit('message',JSON.stringify({op:'sub',ch:['radar','pairs','feed',`coin:${card.identity.address}`]}));
    const live=new ReadLive(built.ctx.reads,hub);await live.start(bus);
    try {
      const id=(await built.ctx.dbh.chain.sql.query<{card_id:string}>('SELECT card_id FROM coin_card_latest WHERE coin=$1',[binary(card.identity.address)])).rows[0].card_id;
      bus.publish({topic:'card_updated',ids:{id}});bus.publish({topic:'card_updated',ids:{id}});await live.drain();
      const db=built.ctx.dbh.chain;
      const tx=`0x${'1'.repeat(64)}`;
      await db.insert('swaps',{ts:new Date(now),block:card.verdict.asOfBlock,tx_hash:binary(tx),log_index:0,venue:'pons_curve',pool_id:binary(card.identity.address),coin:binary(card.identity.address),quote_asset:binary(sampleAddress(0)),trader:binary(sampleAddress(2)),tx_from:binary(sampleAddress(2)),tx_to:binary(card.identity.address),side:1,amount_coin:'1000000000000000000',amount_quote:'1',price_quote:1,usd:10,priced_block:card.verdict.asOfBlock});
      const prices=(await db.sql.query<{price:number}>('SELECT price FROM coin_rating_prices WHERE coin=$1',[binary(card.identity.address)])).rows[0];
      const publications=(await db.sql.query('SELECT count(*) AS n FROM receipt_publications')).rows;
      await db.sql.query('UPDATE coin_rating_prices SET price=peak*0.15 WHERE coin=$1',[binary(card.identity.address)]);
      bus.publish({topic:'swap',ids:{txHash:tx,logIndex:0}});bus.publish({topic:'swap',ids:{txHash:tx,logIndex:0}});await live.drain();
      await new Promise(resolve=>setTimeout(resolve,1100));await live.drain();
      const events=socket.messages.flatMap(m=>{const parsed=WsServerSchema.parse(m);return parsed.t==='ev' ? [parsed] : [];});
      expect(events.filter(e=>e.kind==='verdict').at(-1)?.data).toMatchObject({level:card.verdict.level,priceMove:{downFromPeakPct:85},lastChecked:{at:new Date(now-60_000).toISOString()}});
      expect((await db.sql.query('SELECT count(*) AS n FROM receipt_publications')).rows).toEqual(publications);
      await db.sql.query('UPDATE coin_rating_prices SET price=$2 WHERE coin=$1',[binary(card.identity.address),prices.price]);
      expect(events.filter(e=>e.kind==='card')).toHaveLength(2);expect(events.filter(e=>e.kind==='tick')).toHaveLength(1);expect(events.filter(e=>e.kind==='rerank')).toHaveLength(1);
      const seq=events.filter(e=>e.ch==='radar').map(e=>e.seq);expect(seq).toEqual(seq.map((_,i)=>i+1));
      const sent=socket.messages.length;
      socket.bufferedAmount=3*1024*1024;hub.publish<'radar','rerank'>('radar','rerank',{order:[]});hub.publish<'radar','rerank'>('radar','rerank',{order:[]});
      // Every reply obeys MAX_BUFFER, including resync; deliver the notification after draining.
      expect(socket.messages).toHaveLength(sent);
      socket.bufferedAmount=0;hub.publish<'radar','rerank'>('radar','rerank',{order:[]});
      expect(socket.messages.filter(m=>(m as {t:string}).t==='resync')).toHaveLength(1);
      expect(socket.messages).toHaveLength(sent+1);
      hub.publish<'radar','rerank'>('radar','rerank',{order:[]});
      expect(socket.messages.at(-1)).toMatchObject({t:'ev',ch:'radar',kind:'rerank'});
      expect(socket.messages.filter(m=>(m as {t:string}).t==='resync')).toHaveLength(1);
    } finally {await live.close();hub.closeAll();}
  });
});
