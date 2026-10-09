import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import type { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ApiErrorSchema, FeedItemSchema, JournalPageSchema, WsEventSchema, type FeedItem } from '@eko/shared';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { accounts } from '../src/db/schema.js';
import { FlagService } from '../src/flags/service.js';
import { fixtureRoutes } from '../src/http/v1/fixtures.js';
import { fixtureSchemas, neutralFixture, type FixtureProducers } from '../src/fixtures/producers.js';
import { notFound } from '../src/http/v1/helpers.js';
import { createDemoToken } from '../src/http/v1/demo.js';
import { Hub } from '../src/ws/hub.js';
import * as telemetry from '../src/obs/errors.js';

const placeholder = 'synthetic-fixture-placeholder'.repeat(2), origin = 'https://app.eko.example';
const base = { NODE_ENV:'test', ENABLE_DEV_ROUTES:'true', PGLITE_DIR:':memory:', RUN_WORKER:'false', LEGACY_API:'false',
  SESSION_SECRET:placeholder, DEMO_SECRET:placeholder, PUBLIC_ORIGIN:origin };
const address = `0x${'0'.repeat(39)}1` as const;
const feed: FeedItem = { id:'fixture-feed', ts:1, block:1, kind:'new_pair', coin:address,
  symbol:{text:'Fixture coin', truncated:false, flags:[]} };
async function routes(extra = {}, producers: FixtureProducers = {}, override = '') {
  const app=Fastify();app.setNotFoundHandler((_req,reply)=>notFound(reply));
  const cfg={...loadConfig(base),...extra};
  await fixtureRoutes(app,cfg,new FlagService(async()=>[],override),producers);
  await app.ready();return app;
}
const post=(app:ReturnType<typeof Fastify>, kind:string, data:unknown)=>app.inject({method:'POST',url:`/dev/fixtures/${kind}`,payload:{synthetic:true,data}});

describe('CA-27 isolated producer registration',()=>{
  it('never registers in production or without ENABLE_DEV_ROUTES, even with producers',async()=>{
    const inject=vi.fn(async(input:FeedItem)=>input);
    for(const extra of [{NODE_ENV:'production'}, {ENABLE_DEV_ROUTES:false}]) {
      const app=await routes(extra,{feed:{owner:'api',storage:'isolated-dev',inject}});
      try {
        expect(app.hasRoute({method:'POST',url:'/dev/fixtures/feed'})).toBe(false);
        const unknown=await post(app,'unknown',{});
        expect((await post(app,'feed',feed)).body).toBe(unknown.body);
      } finally {await app.close();}
    }
    expect(inject).not.toHaveBeenCalled();
    expect(()=>loadConfig({...base,NODE_ENV:'production',DATABASE_URL:'postgresql://example.invalid/fixture'})).toThrow('ENABLE_DEV_ROUTES');
  });
  it('rejects non-isolated storage and execution/ingestion contexts before writing',async()=>{
    const inject=vi.fn(async(input:FeedItem)=>input);
    for(const extra of [{DATABASE_URL:'postgresql://example.invalid/fixture'},{PGLITE_DIR:'.data/pglite'},
      {APP_ROLE:'dev'},{APP_ROLE:'worker'},{RUN_WORKER:true},{LIVE_TRADING_ENABLED:true},{MARKET_DATA_SOURCE:'onchain'}]) {
      const app=await routes(extra,{feed:{owner:'api',storage:'isolated-dev',inject}});
      try {expect((await post(app,'feed',feed)).statusCode).toBe(403);} finally {await app.close();}
    }
    expect(inject).not.toHaveBeenCalled();
  });
  it('validates schemas and neutral synthetic data before dispatch',async()=>{
    const inject=vi.fn(async(input:FeedItem)=>input);
    const app=await routes({}, {feed:{owner:'api',storage:'isolated-dev',inject}});
    try {
      for(const data of [{}, {...feed,coin:'bad'}, {...feed,extra:true}, {...feed,symbol:{...feed.symbol,text:'untrusted arbitrary text'}},
        {...feed,coin:`0x${'a'.repeat(40)}`}])expect((await post(app,'feed',data)).statusCode).toBe(422);
      for(const payload of [{data:feed}, {synthetic:false,data:feed}, {synthetic:true,data:feed,accountId:'fixture-owner'}])
        expect((await app.inject({method:'POST',url:'/dev/fixtures/feed',payload})).statusCode).toBe(422);
      expect((await app.inject({method:'POST',url:'/dev/fixtures/feed',headers:{'content-type':'application/json'},payload:'{"synthetic":'})).statusCode).toBe(422);
      expect(inject).not.toHaveBeenCalled();
      const ok=await post(app,'feed',feed);
      expect(ok.statusCode).toBe(200);expect(ok.headers['cache-control']).toBe('private, no-store');
      expect(ok.json()).toEqual({synthetic:true,kind:'feed',data:feed});
    } finally {await app.close();}
    expect(neutralFixture({payload:{email:'demo@example.invalid'}})).toBe(false);
    expect(neutralFixture({payload:{text:'unbounded arbitrary text'}})).toBe(false);
    expect(neutralFixture({payload:{side:{text:'Sample arbitrary nested field'}}})).toBe(false);
    expect(Object.keys(fixtureSchemas)).toEqual(['card','verdict','marker','pair','feed','journal','approval','order','burn']);
  });
  it('reports missing capability, hides D0 kinds with flags off and does not accept wrong ownership',async()=>{
    const app=await routes();
    try {
      const result=await post(app,'feed',feed);
      expect(result.statusCode).toBe(503);expect(ApiErrorSchema.parse(result.json()).message).toContain('capability is unavailable: feed');
      for(const kind of ['approval','burn','unknown'])expect((await post(app,kind,{})).body).toBe((await post(app,'unknown',{})).body);
    } finally {await app.close();}
    const flagged=await routes({}, {}, 'd0');
    try {for(const kind of ['approval','burn'])expect((await post(flagged,kind,{})).statusCode).toBe(422);} finally {await flagged.close();}
    const wrong=await routes({}, {feed:{owner:'indexer',storage:'isolated-dev',inject:vi.fn()}} as unknown as FixtureProducers);
    try {expect((await post(wrong,'feed',feed)).statusCode).toBe(503);} finally {await wrong.close();}
  });
  it('validates every shared fixture shape without inventing an unavailable producer',async()=>{
    const source=JSON.parse(readFileSync(new URL('../../../packages/shared/test/fixtures/contracts/v1.json',import.meta.url),'utf8'));
    const neutral=(value:unknown):unknown=>Array.isArray(value) ? value.map(neutral) : value && typeof value==='object'
      ? Object.fromEntries(Object.entries(value).map(([k,v])=>[k,neutral(v)]))
      : typeof value==='string' && /^0x[0-9a-f]{40}$/.test(value) ? address : value==='fixture' ? 'Fixture coin' : value;
    const data={card:neutral(source.CoinCard),verdict:neutral(source.Verdict),pair:neutral(source.PairRow),feed:neutral(source.FeedItem),
      marker:{coin:address,marker:neutral(source.ChartMarker)},order:neutral(source.TradeOrder),approval:neutral(source.Approval),burn:neutral(source.BurnEvent),
      journal:{agentId:'00000000-0000-4000-8000-000000000001',entry:{kind:'note',payload:{text:'Synthetic fixture note'}}}};
    const app=await routes({}, {}, 'd0');
    try {
      for(const [kind,input] of Object.entries(data)) {
        const result=await post(app,kind,input);
        expect(result.statusCode,`${kind}: ${result.body}`).toBe(503);
        expect(result.json().message).toContain(`capability is unavailable: ${kind}`);
        expect((await post(app,kind,{})).statusCode,kind).toBe(422);
      }
      const engine=await post(app,'burn',{...(data.burn as object),kind:'engine',signer:'engine'});
      expect(engine.statusCode).toBe(404);
    } finally {await app.close();}
  });
  it('propagates schema-valid WS only from the owning producer after persistence',async()=>{
    const hub=new Hub(),socket=new EventEmitter() as EventEmitter & {readyState:number;bufferedAmount:number;send:(message:string)=>void};
    const messages:unknown[]=[];socket.readyState=1;socket.bufferedAmount=0;socket.send=message=>messages.push(JSON.parse(message));
    hub.addV1(socket as unknown as WebSocket);socket.emit('message',JSON.stringify({op:'sub',ch:['feed']}));
    const stored:FeedItem[]=[];
    const app=await routes({}, {feed:{owner:'api',storage:'isolated-dev',async inject(input) {
      const item=FeedItemSchema.parse(input);stored.push(item);hub.publish<'feed','item'>('feed','item',item);return item;
    }}});
    try {
      expect((await post(app,'feed',{})).statusCode).toBe(422);expect(stored).toEqual([]);
      expect((await post(app,'feed',feed)).statusCode).toBe(200);expect(stored).toEqual([feed]);
      const event=WsEventSchema.parse(messages.at(-1));expect(event).toMatchObject({ch:'feed',kind:'item',seq:1,data:feed});
      expect(messages.filter(m=>(m as {t:string}).t==='ev')).toHaveLength(1);
    } finally {await app.close();socket.emit('close');}
  });
});

let built:Awaited<ReturnType<typeof buildApp>>, dir:string;
beforeAll(async()=>{
  dir=await mkdtemp(join(tmpdir(),'eko-dev-fixtures-'));
  const path=join(dir,'destruction.log');await writeFile(path,'eko-journal-destruction-v1\n',{mode:0o600});
  built=await buildApp(loadConfig({...base,HARNESS_KEY_PEPPER:placeholder,LAUNCH_WEEK_AGENT_LIMIT:'10',
    JOURNAL_KEK:randomBytes(32).toString('hex'),JOURNAL_KEK_ID:'fixture-kek',JOURNAL_TOMBSTONE_PATH:path}),{startBackground:false});
});
afterAll(async()=>{await built?.close();if(dir)await rm(dir,{recursive:true,force:true});});
async function owner() {
  const [account]=await built.ctx.dbh.db.insert(accounts).values({kind:'wallet'}).returning();
  const token=await built.ctx.auth.createSession(account!.id),cookie=`eko_sid=${encodeURIComponent(built.app.signCookie(token))}`;
  const agent=await built.ctx.harness.create(account!.id,{name:'Sample fixture agent',kind:'other',preset:'balanced'},10);
  return {id:account!.id,cookie,agent};
}
const entry={kind:'note',payload:{text:'Synthetic fixture note'},share:false};
const journalPost=(cookie:string,agentId:string,extra={})=>built.app.inject({method:'POST',url:'/dev/fixtures/journal',headers:{cookie,origin},
  payload:{synthetic:true,data:{agentId,entry,...extra}}});
describe('owned encrypted journal fixture through the MCP writer',()=>{
  it('requires wallet ownership, explicit consent and uses the existing encrypted writer and receipt outbox',async()=>{
    const a=await owner(),b=await owner();
    expect((await journalPost('',a.agent.id)).statusCode).toBe(401);
    expect((await journalPost(a.cookie,a.agent.id)).statusCode).toBe(403);
    await built.ctx.journal.setConsent(a.id,true);await built.ctx.journal.setConsent(b.id,true);
    expect((await journalPost(b.cookie,a.agent.id)).statusCode).toBe(404);
    expect((await journalPost(a.cookie,a.agent.id,{accountId:b.id})).statusCode).toBe(422);
    const response=await journalPost(a.cookie,a.agent.id);expect(response.statusCode).toBe(200);
    const page=await built.app.inject({url:`/v1/agents/${a.agent.id}/journal`,headers:{cookie:a.cookie}});
    const result=JournalPageSchema.parse(page.json());expect(result.rows).toHaveLength(1);expect(result.rows[0]).toMatchObject(entry);
    const stored=(await built.ctx.dbh.chain.sql.query<{ciphertext:Uint8Array}>('SELECT ciphertext FROM harness_journal WHERE id=$1',[result.rows[0]!.id])).rows[0];
    expect(Buffer.from(stored!.ciphertext).toString()).not.toContain(entry.payload.text);
    expect((await built.ctx.dbh.chain.sql.query('SELECT id FROM receipt_private_publications WHERE id=$1',[result.rows[0]!.id])).rows).toHaveLength(1);
    expect((await built.ctx.dbh.chain.sql.query('SELECT id FROM receipt_items WHERE id=$1',[result.rows[0]!.id])).rows).toEqual([]);
    expect((await built.ctx.dbh.chain.sql.query('SELECT * FROM ground_truth_shared')).rows).toEqual([]);
    // No synthetic chain or launch-observation rows are manufactured.
    expect((await built.ctx.dbh.chain.sql.query('SELECT * FROM chain_blocks')).rows).toEqual([]);
    expect((await built.ctx.dbh.chain.sql.query('SELECT * FROM coin_card_latest')).rows).toEqual([]);
  });
  it('rejects foreign origins/demo writes and contains private writer failures without telemetry',async()=>{
    const a=await owner();await built.ctx.journal.setConsent(a.id,true);
    const payload={synthetic:true,data:{agentId:a.agent.id,entry}};
    for(const from of [undefined,'https://foreign.example'])expect((await built.app.inject({method:'POST',url:'/dev/fixtures/journal',
      headers:{cookie:a.cookie,...(from?{origin:from}:{})},payload})).statusCode).toBe(403);
    expect((await journalPost(`${a.cookie}; eko_demo=${createDemoToken(['approvals'],placeholder)}`,a.agent.id)).statusCode).toBe(403);
    const report=vi.spyOn(telemetry,'reportError'),append=vi.spyOn(built.ctx.journal,'append').mockRejectedValueOnce(new Error('fixture-private-error'));
    try {
      const result=await journalPost(a.cookie,a.agent.id);expect(result.statusCode).toBe(500);
      expect(result.body).not.toContain('fixture-private-error');expect(report).not.toHaveBeenCalled();
    } finally {append.mockRestore();report.mockRestore();}
  });
});
