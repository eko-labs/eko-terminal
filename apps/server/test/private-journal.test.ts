import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { Db } from '../src/db/client.js';
import * as schema from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ChainDb, FileJournalDestructionLedger, ReceiptOutbox } from '@eko/db';
import { JournalPageSchema } from '@eko/shared';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { accounts, agentKeys, agents } from '../src/db/schema.js';
import { JournalService } from '../src/harness/journal.js';
import { HarnessService } from '../src/harness/service.js';
import { createDemoToken } from '../src/http/v1/demo.js';
import * as telemetry from '../src/obs/errors.js';

const origin='https://app.eko.example',placeholder='fixture-journal-placeholder'.repeat(2),kek=randomBytes(32),kekId='fixture-kek-v1';
let built:Awaited<ReturnType<typeof buildApp>>,dir:string,path:string;
beforeAll(async()=>{
  dir=await mkdtemp(join(tmpdir(),'eko-private-journal-'));path=join(dir,'destruction.log');
  await writeFile(path,'eko-journal-destruction-v1\n',{mode:0o600});
  built=await buildApp(loadConfig({NODE_ENV:'test',PGLITE_DIR:':memory:',LEGACY_API:'false',PUBLIC_ORIGIN:origin,
    SESSION_SECRET:placeholder,DEMO_SECRET:placeholder,HARNESS_KEY_PEPPER:placeholder,LAUNCH_WEEK_AGENT_LIMIT:'10',
    JOURNAL_KEK:kek.toString('hex'),JOURNAL_KEK_ID:kekId,JOURNAL_TOMBSTONE_PATH:path}),{startBackground:false});
});
afterAll(async()=>{await built?.close();await rm(dir,{recursive:true,force:true});});
const call=(cookie:string,method:'GET'|'PUT'|'DELETE',url:string,payload?:object)=>built.app.inject({method,url:`/v1${url}`,headers:{cookie,origin},...(payload?{payload}:{})});
async function owner() {
  const [account]=await built.ctx.dbh.db.insert(accounts).values({kind:'wallet'}).returning();
  const token=await built.ctx.auth.createSession(account!.id),cookie=`eko_sid=${encodeURIComponent(built.app.signCookie(token))}`;
  const agent=await built.ctx.harness.create(account!.id,{name:'Sample journal agent',kind:'other',preset:'balanced'},10);
  return {id:account!.id,cookie,agent};
}
const input=(text='private-fixture-note',share=false)=>({kind:'note',payload:{text},share});
const optIn=(cookie:string)=>call(cookie,'PUT','/me/journal-consent',{optedIn:true});

describe('092 private journal: offline PGlite, synthetic keys, HTTP injection only',()=>{
  it('requires persisted explicit consent, binds writes to the owner and enforces 16 KB',async()=>{
    const a=await owner(),b=await owner();
    expect((await call(a.cookie,'GET','/me/journal-consent')).json()).toEqual({optedIn:false});
    await expect(built.ctx.journal.append(a.id,a.agent.id,input())).rejects.toMatchObject({code:'forbidden'});
    expect((await optIn(a.cookie)).json()).toEqual({optedIn:true});
    const reloaded=new JournalService(built.ctx.dbh.chain,new FileJournalDestructionLedger(path),{kek,id:kekId});
    expect(await reloaded.consent(a.id)).toEqual({optedIn:true});
    await expect(reloaded.append(b.id,a.agent.id,input())).rejects.toMatchObject({code:'not_found'});
    const entry=await reloaded.append(a.id,a.agent.id,input());
    const row=(await built.ctx.dbh.chain.sql.query<{ciphertext:Uint8Array;salt_ct:Uint8Array}>('SELECT * FROM harness_journal WHERE id=$1',[entry.id])).rows[0]!;
    expect(Buffer.from(row.ciphertext).toString()).not.toContain('private-fixture-note');
    expect(Buffer.from(row.salt_ct).length).toBe(60);
    expect((await built.ctx.dbh.chain.sql.query('SELECT * FROM ground_truth_shared')).rows).toEqual([]);
    await expect(reloaded.append(a.id,a.agent.id,{kind:'note',payload:{text:'é'.repeat(8192)}})).rejects.toMatchObject({code:'bad_request'});
    await expect(reloaded.append(a.id,a.agent.id,{kind:'note',payload:{value:Infinity}})).rejects.toMatchObject({code:'bad_request'});
    await expect(reloaded.append(a.id,a.agent.id,{kind:'note',payload:{},accountId:b.id})).rejects.toMatchObject({code:'bad_request'});
    await reloaded.append(a.id,a.agent.id,{kind:'note',payload:{text:'a'.repeat(16373)}});
    expect((await call(a.cookie,'PUT','/me/journal-consent',{optedIn:false})).statusCode).toBe(200);
    await expect(reloaded.append(a.id,a.agent.id,input())).rejects.toMatchObject({code:'forbidden'});
    expect((await call(a.cookie,'GET',`/agents/${a.agent.id}/journal`)).statusCode).toBe(200);
  });
  it('supports stable owner-only keyset pagination and kind filters without cross-account cursors',async()=>{
    const a=await owner(),b=await owner();await optIn(a.cookie);await optIn(b.cookie);
    const entries=[];
    for(let i=0;i<5;i++)entries.push(await built.ctx.journal.append(a.id,a.agent.id,{kind:i%2?'order':'note',payload:{index:i}}));
    // Exercise equal timestamp pagination, with UUID tie-breaking.
    await built.ctx.dbh.chain.sql.query('UPDATE harness_journal SET ts=$1 WHERE account_id=$2',['2026-10-02T00:00:00Z',a.id]);
    const first=await call(a.cookie,'GET',`/agents/${a.agent.id}/journal?limit=2`);
    expect(first.headers['cache-control']).toBe('private, no-store');
    const p1=JournalPageSchema.parse(first.json());expect(p1.rows).toHaveLength(2);expect(p1.cursor).not.toBeNull();
    const p2=JournalPageSchema.parse((await call(a.cookie,'GET',`/agents/${a.agent.id}/journal?limit=2&cursor=${p1.cursor}`)).json());
    const p3=JournalPageSchema.parse((await call(a.cookie,'GET',`/agents/${a.agent.id}/journal?limit=2&cursor=${p2.cursor}`)).json());
    expect(new Set([...p1.rows,...p2.rows,...p3.rows].map(row=>row.id)).size).toBe(5);expect(p3.cursor).toBeNull();
    const orders=JournalPageSchema.parse((await call(a.cookie,'GET',`/agents/${a.agent.id}/journal?kind=order`)).json());
    expect(orders.rows).toHaveLength(2);expect(orders.rows.every(row=>row.kind==='order')).toBe(true);
    expect((await call(b.cookie,'GET',`/agents/${a.agent.id}/journal`)).statusCode).toBe(404);
    expect((await call(b.cookie,'GET',`/agents/${b.agent.id}/journal?cursor=${p1.cursor}`)).statusCode).toBe(422);
    for(const query of ['limit=101','limit=0','kind=invalid','cursor=invalid'])expect((await call(a.cookie,'GET',`/agents/${a.agent.id}/journal?${query}`)).statusCode).toBe(422);
  });
  it('rejects guest/missing/bearer management, foreign origins and demo deletion/consent writes',async()=>{
    const a=await owner(),guest=await built.ctx.auth.createGuest(),guestCookie=`eko_sid=${encodeURIComponent(built.app.signCookie(guest.token))}`;
    for(const session of ['',guestCookie,'eko_sid=invalid'])for(const [method,url] of [['GET',`/agents/${a.agent.id}/journal`],['DELETE','/me/data']] as const)
      expect((await call(session,method,url)).statusCode).toBe(401);
    const demo=`${a.cookie}; eko_demo=${createDemoToken([],placeholder)}`;
    expect((await call(demo,'DELETE','/me/data')).statusCode).toBe(403);
    expect((await call(demo,'PUT','/me/journal-consent',{optedIn:true})).statusCode).toBe(403);
    for(const from of [undefined,'https://foreign.example'])expect((await built.app.inject({method:'DELETE',url:'/v1/me/data',headers:{cookie:a.cookie,...(from?{origin:from}:{})}})).statusCode).toBe(403);
    expect((await built.app.inject({method:'DELETE',url:'/v1/me/data',headers:{origin,authorization:'Bearer fixture-bearer'}})).statusCode).toBe(401);
  });
  it('reports no private data to telemetry on ciphertext swap, wrong KEK or unavailable state',async()=>{
    const a=await owner();await optIn(a.cookie);
    const first=await built.ctx.journal.append(a.id,a.agent.id,input('fixture-sensitive-marker-a'));
    const second=await built.ctx.journal.append(a.id,a.agent.id,input('fixture-sensitive-marker-b'));
    await built.ctx.dbh.chain.sql.query('UPDATE harness_journal SET ciphertext=(SELECT ciphertext FROM harness_journal WHERE id=$2) WHERE id=$1',[first.id,second.id]);
    const report=vi.spyOn(telemetry,'reportError');
    try {
      const response=await call(a.cookie,'GET',`/agents/${a.agent.id}/journal`);
      expect(response.statusCode).toBe(500);expect(response.json()).toEqual({error:'internal_error',message:'Journal storage is unavailable'});expect(report).not.toHaveBeenCalled();
      const wrong=new JournalService(built.ctx.dbh.chain,new FileJournalDestructionLedger(path),{kek:randomBytes(32),id:kekId});
      await expect(wrong.page(a.id,a.agent.id)).rejects.toMatchObject({code:'internal_error',message:'Journal storage is unavailable'});
      const missing=new JournalService(built.ctx.dbh.chain);
      await expect(missing.append(a.id,a.agent.id,input())).rejects.toMatchObject({code:'internal_error'});
      expect(response.body).not.toContain(first.id);expect(response.body).not.toContain('fixture-sensitive-marker');
    } finally {report.mockRestore();}
  });
  it('shares only enum facts and bucketed amounts via the declared writer and rolls back on writer failure',async()=>{
    const a=await owner();await optIn(a.cookie);
    const entry=await built.ctx.journal.append(a.id,a.agent.id,{kind:'order',share:true,payload:{side:'buy',qty:123.45,notionalUsd:987.65,
      externalId:'fixture-external-order',instrument:'SAMPLE',accountId:a.id,nested:{wallet:'fixture-wallet'},text:'fixture-sensitive-marker'}});
    expect(entry.share).toBe(true);
    const shared=(await built.ctx.dbh.chain.sql.query<{data:unknown}>('SELECT data FROM ground_truth_shared')).rows;
    expect(shared).toEqual([{data:{kind:'order',side:'buy',quantityBucket:'positive:10^2',notionalBucket:'positive:10^2'}}]);
    const failed=new JournalService(built.ctx.dbh.chain,new FileJournalDestructionLedger(path),{kek,id:kekId},
      {writer:'mcp',async write(){throw new Error('fixture-sensitive-marker');}});
    await expect(failed.append(a.id,a.agent.id,{...input(),share:true})).rejects.toMatchObject({message:'Journal storage is unavailable'});
    expect((await built.ctx.journal.page(a.id,a.agent.id)).rows).toHaveLength(1);
  });
  it('shreds before cleanup, retries after failure, revokes credentials and preserves only public commitments',async()=>{
    const a=await owner(),b=await owner();await optIn(a.cookie);await optIn(b.cookie);
    const key=await built.ctx.harness.createKey(a.id,a.agent.id),otherKey=await built.ctx.harness.createKey(b.id,b.agent.id);
    const entry=await built.ctx.journal.append(a.id,a.agent.id,input('private-deleted-note',true));
    // Real consent and token lifecycle tables, without enabling OAuth.
    await built.ctx.dbh.db.insert(schema.oauthGrants).values({ id:a.agent.id, accountId:a.id, agentId:a.agent.id,
      clientId:'sample-client', wallet:'0x1111111111111111111111111111111111111111',
      scopes:['senses:read','preflight','journal'], resource:'https://mcp.eko.example/mcp' });
    await built.ctx.dbh.db.insert(schema.oauthTokens).values({ grantId:a.agent.id, accessPrefix:'sample-access', accessHash:'a'.repeat(64),
      refreshPrefix:'sample-refresh', refreshHash:'b'.repeat(64), accessExpiresAt:new Date(Date.now()+3600_000), refreshExpiresAt:new Date(Date.now()+86400_000) });
    await built.ctx.dbh.db.insert(schema.oauthCodes).values({ requestId:a.agent.id, grantId:a.agent.id, accountId:a.id,
      clientId:'sample-client', hash:'a'.repeat(64), redirectUri:'https://connector.example/callback', codeChallenge:'A'.repeat(43),
      codeChallengeMethod:'S256', resource:'https://mcp.eko.example/mcp', scopes:['senses:read','preflight','journal'], expiresAt:new Date(Date.now()+60_000) });
    const [oauthKey]=await built.ctx.dbh.db.insert(agentKeys).values({agentId:a.agent.id,kind:'oauth',oauthGrantId:a.agent.id,
      prefix:'sample-oauth-prefix',hash:'b'.repeat(64)}).returning();
    const failing=new JournalService(built.ctx.dbh.chain,new FileJournalDestructionLedger(path),{kek,id:kekId},undefined,
      {async cleanup(tx,accountId){expect((await tx.sql.query<{wrapped_dek:unknown}>('SELECT wrapped_dek FROM user_keys WHERE account_id=$1',[accountId])).rows[0]!.wrapped_dek).toBeNull();throw new Error('cleanup fixture crash');}});
    await expect(failing.deleteData(a.id)).rejects.toMatchObject({code:'internal_error'});
    expect(await built.ctx.harness.authenticate(key.secret)).toBeNull();
    await expect(built.ctx.journal.page(a.id,a.agent.id)).rejects.toMatchObject({code:'forbidden'});
    await expect(built.ctx.journal.append(a.id,a.agent.id,input())).rejects.toMatchObject({code:'forbidden'});
    const first=await call(a.cookie,'DELETE','/me/data'),second=await call(a.cookie,'DELETE','/me/data');
    expect(first.statusCode).toBe(200);expect(second.json()).toEqual(first.json());
    const state=(await built.ctx.dbh.chain.sql.query<{wrapped_dek:unknown;destroyed_at:Date}>('SELECT * FROM user_keys WHERE account_id=$1',[a.id])).rows[0]!;
    expect(state.wrapped_dek).toBeNull();expect(new Date(state.destroyed_at).toISOString()).toBe(first.json().deletedAt);
    expect(await built.ctx.dbh.db.select().from(agents).where(eq(agents.accountId,a.id))).toEqual([]);
    expect(await built.ctx.dbh.db.select().from(agentKeys).where(eq(agentKeys.id,key.keyId))).toEqual([]);
    expect(await built.ctx.dbh.db.select().from(agentKeys).where(eq(agentKeys.id,oauthKey!.id))).toEqual([]);
    expect((await built.ctx.dbh.chain.sql.query('SELECT * FROM harness_journal WHERE account_id=$1',[a.id])).rows).toEqual([]);
    for(const table of ['oauth_grants','oauth_tokens','oauth_codes'])expect((await built.ctx.dbh.chain.sql.query(`SELECT * FROM ${table}`)).rows).toEqual([]);
    expect(await built.ctx.harness.authenticate(otherKey.secret)).toMatchObject({accountId:b.id});
    // Deletion before enqueue cannot discard its public salted commitment.
    const outbox=new ReceiptOutbox(built.ctx.dbh.chain);await outbox.enqueue(entry.id);await outbox.enqueue(entry.id);
    expect(await outbox.getPrivate(entry.id)).toEqual({id:entry.id,kind:'harness_private',hash:entry.commitment});
    const publication=(await built.ctx.dbh.chain.sql.query('SELECT * FROM receipt_items WHERE id=$1',[entry.id])).rows[0]!;
    for(const marker of ['private-deleted-note',a.id,a.agent.id,'salt','payload.orders'])expect(JSON.stringify(publication)).not.toContain(marker);
    expect((await built.ctx.dbh.chain.sql.query('SELECT * FROM ground_truth_shared')).rows).toHaveLength(2);
    expect((await call(a.cookie,'PUT','/me/journal-consent',{optedIn:true})).statusCode).toBe(403);
  });
  it('makes an actual pre-deletion database backup unreadable through the restored application and denies restored keys',async()=>{
    const a=await owner();await optIn(a.cookie);
    await built.ctx.journal.append(a.id,a.agent.id,input('backup-private-note'));
    const key=await built.ctx.harness.createKey(a.id,a.agent.id);
    const backup=await (built.ctx.dbh.chain.sql as unknown as PGlite).dumpDataDir();
    const restored=new PGlite({loadDataDir:backup});
    const db=new ChainDb(restored,fn=>restored.transaction(tx=>fn(tx)),()=>restored.close());
    try {
      const ledger=new FileJournalDestructionLedger(path),service=new JournalService(db,ledger,{kek,id:kekId});
      expect((await service.page(a.id,a.agent.id)).rows[0]!.payload).toEqual({text:'backup-private-note'});
      const restoredHarness=new HarnessService(drizzle(restored,{schema}) as unknown as Db,placeholder,undefined,id=>!!ledger.destroyedAt(id));
      expect(await restoredHarness.authenticate(key.secret)).toMatchObject({accountId:a.id});
      expect((await call(a.cookie,'DELETE','/me/data')).statusCode).toBe(200);
      expect((await db.sql.query('SELECT wrapped_dek FROM user_keys WHERE account_id=$1',[a.id])).rows[0]!.wrapped_dek).not.toBeNull();
      await expect(service.page(a.id,a.agent.id)).rejects.toMatchObject({code:'forbidden'});
      await expect(service.append(a.id,a.agent.id,input())).rejects.toMatchObject({code:'forbidden'});
      expect(await restoredHarness.authenticate(key.secret)).toBeNull();
      // Restored cleanup is idempotent and can run without decrypting any entry.
      expect(await service.deleteData(a.id)).toHaveProperty('deletedAt');
      expect((await db.sql.query('SELECT * FROM harness_journal WHERE account_id=$1',[a.id])).rows).toEqual([]);
    } finally {await db.close();}
    expect((await built.ctx.chains.meter.usage()).sessionUnits).toBe(0);
  });
});
