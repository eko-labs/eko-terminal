import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Approval, Policy, Verdict } from '@eko/shared';
import { orderHash, type Deps } from '../../../packages/policy/src/index.js';
import { deps as actualDeps } from '../../../packages/policy/test/actual-fixtures.js';
import { HarnessService } from '../../server/src/harness/service.js';
import { accounts } from '../../server/src/db/schema.js';
import { NOW } from '../../../packages/policy/test/fixtures.js';
import { cachedGuard, guardFixture } from '../../../packages/policy/test/guard-fixtures.js';
import { preflightFixture } from '../../server/test/preflight-fixture.js';
import { type CachedPreflightInputs, type PreflightApprovals } from '../../server/src/harness/preflight.js';
import { createMcpRuntime } from '../src/runtime.js';
import { buildMcpApp } from '../src/app.js';
import { EntitlementsService } from '../../server/src/harness/entitlements.js';
import { registerHarnessTools } from '../src/harness.js';
import { ToolRegistry } from '../src/tools.js';

let f: Awaited<ReturnType<typeof preflightFixture>>;
beforeAll(async () => { f = await preflightFixture(); });
afterAll(async () => { await f?.close(); });
const counts = async (agentId: string) => (await f.handle.chain.sql.query<{p:number;j:number;r:number}>(`SELECT
  (SELECT count(*)::int FROM preflights WHERE agent_id=$1) p,
  (SELECT count(*)::int FROM harness_journal WHERE agent_id=$1) j,
  (SELECT count(*)::int FROM receipt_private_publications WHERE id IN (SELECT id::text FROM harness_journal WHERE agent_id=$1)) r`, [agentId])).rows[0];
function approvalAdapter() {
  let current: Approval | undefined;
  const adapter: PreflightApprovals = { available: true,
    current: async (_tx, req, hash) => current?.detail?.clientOrderRef === req.clientOrderRef && current.detail.orderHash === hash ? current : undefined,
    create: async (_tx, req, hash, result) => current = { id: randomUUID(), agentId: req.agentId, preflightId: result.preflightId,
      summary: 'Fixture approval', status: 'pending', expiresAt: new Date(NOW + 60000).toISOString(),
      detail: { clientOrderRef: req.clientOrderRef, order: req.order, orderHash: hash, approvalAboveUsd: 1,
        reasons: result.reasons, policyVersion: result.policyVersion } } };
  return { adapter, set(status: Approval['status']) { current!.status = status; }, expire() { current!.expiresAt = new Date(NOW - 1).toISOString(); } };
}
async function setPolicy(id: string, patch: Partial<Policy>) {
  const p = (await f.handle.chain.sql.query<{policy:Policy}>('SELECT policy FROM policies WHERE agent_id=$1 ORDER BY version DESC LIMIT 1', [id])).rows[0]!.policy;
  const next = { ...p, ...patch, version: p.version + 1 };
  await f.handle.chain.sql.query('INSERT INTO policies(agent_id,version,policy) VALUES($1,$2,$3)', [id,next.version,JSON.stringify(next)]);
}

describe('095 transactional preflight/journal, offline encrypted fixtures', () => {
  it('serializes concurrent duplicates across service instances and keeps final replay IDs/version unchanged', async () => {
    const a = await f.owner(), req = await f.req(a.agentId);
    const results = await Promise.all(Array.from({ length: 12 }, () => f.service().run(a, req)));
    expect(results[0]!.decision).toBe('allow'); expect(results.every(r => JSON.stringify(r) === JSON.stringify(results[0]))).toBe(true);
    expect(await counts(a.agentId)).toEqual({ p: 1, j: 1, r: 1 });
    const stored = (await f.handle.chain.sql.query<{order_hash:string;policy_version:number;decision:string}>('SELECT * FROM preflights WHERE agent_id=$1', [a.agentId])).rows[0]!;
    expect(stored).toMatchObject({ order_hash: orderHash(req.order), policy_version: 1, decision: 'allow' });
    await f.harness.update(a.accountId,a.agentId,{status:'soft_killed'},10);
    const noEvaluation = vi.fn(() => { throw new Error('Final results must replay'); });
    expect(await f.service(noEvaluation).run(a,req)).toEqual(results[0]); expect(noEvaluation).not.toHaveBeenCalled();
    expect((await f.service().run(a,{...req,clientOrderRef:'fixture-new-killed'})).reasons[0]).toMatch(/^killed:/);
  });
  it('denies conflicting orders including calldata and execution binding without replacing or journaling the result', async () => {
    const a = await f.owner(), req = await f.req(a.agentId), service = f.service(), first = await service.run(a,req);
    for (const order of [{...req.order,notionalUsd:200},{...req.order,tx:{...req.order.tx!,data:'0xac'}},
      {...req.order,execution:{...req.order.execution!,minOut:'1'}}]) {
      expect(await service.run(a,{...req,order})).toMatchObject({ decision:'deny',reasons:['order_mismatch: this clientOrderRef was used for a different order'],journalId:first.journalId });
    }
    expect(await service.run(a,req)).toEqual(first); expect(await counts(a.agentId)).toEqual({p:1,j:1,r:1});
  });
  it('rolls back preflight, first DEK, encrypted journal and commitment on a crash after publication, then retries cleanly', async () => {
    const a = await f.owner(), req = await f.req(a.agentId), append = f.journal.appendInTransaction.bind(f.journal);
    const crash = vi.spyOn(f.journal,'appendInTransaction').mockImplementationOnce(async(...args) => {
      await append(...args); throw new Error('fixture crash after receipt publication');
    });
    await expect(f.service().run(a,req)).rejects.toMatchObject({code:'internal_error',message:'Preflight storage is unavailable'});
    crash.mockRestore();
    expect(await counts(a.agentId)).toEqual({p:0,j:0,r:0});
    expect((await f.handle.chain.sql.query('SELECT * FROM user_keys WHERE account_id=$1',[a.accountId])).rows).toHaveLength(0);
    expect((await f.service().run(a,req)).decision).toBe('allow'); expect(await counts(a.agentId)).toEqual({p:1,j:1,r:1});
  });
  it('requires opt-in before preflight/journal writes or replay; rejects foreign preflight references', async () => {
    const a = await f.owner('balanced',false), b = await f.owner(), req = await f.req(a.agentId);
    await expect(f.service().run(a,req)).rejects.toMatchObject({code:'forbidden'});
    await expect(f.journal.append(a.accountId,a.agentId,{kind:'note',payload:{}})).rejects.toMatchObject({code:'forbidden'});
    expect(await counts(a.agentId)).toEqual({p:0,j:0,r:0});
    await f.journal.setConsent(a.accountId,true); const first = await f.service().run(a,req);
    await expect(f.journal.append(b.accountId,b.agentId,{kind:'note',payload:{},preflightId:first.preflightId})).rejects.toMatchObject({code:'not_found'});
    await expect(f.service().run({...a,accountId:b.accountId},req)).rejects.toMatchObject({code:'not_found'});
    const entry = await f.journal.append(a.accountId,a.agentId,{kind:'note',payload:{text:'fixture-private-note'},preflightId:first.preflightId});
    expect(entry.agentId).toBe(a.agentId); expect(entry.preflightId).toBe(first.preflightId);
    await f.journal.setConsent(a.accountId,false); await expect(f.service().run(a,req)).rejects.toMatchObject({code:'forbidden'});
  });
  it.each(['safe','balanced','degen'] as const)('applies mandatory buyer gates in %s, including explicit null', async mode => {
    const a=await f.owner(mode); await setPolicy(a.agentId,{blockPlaybookLevel:null});
    const cases: [Verdict | 'unavailable' | undefined,string][] = [[cachedGuard(guardFixture('high')),'guard_high'],
      [cachedGuard(guardFixture('lower',['reference_exit'])),'guard_incomplete'],[undefined,'guard_incomplete'],['unavailable','sim_unavailable'],
      [cachedGuard({...guardFixture(),cursor:{...guardFixture().cursor,timestampSec:String((NOW-31000)/1000)}}),'guard_stale'],
      [{...cachedGuard(),playbooks:[{id:'honeypot',level:'danger',confidence:1,evidence:[]}]},'honeypot']];
    for (const [i,[verdict,code]] of cases.entries()) {
      const r=await f.service(()=>({...actualDeps,verdictFor:()=>verdict})).run(a,await f.req(a.agentId,`fixture-gate-${i}`));
      expect(r.decision).toBe('deny'); expect(r.reasons.some(reason=>reason.startsWith(code))).toBe(true); expect(r.guardPolicyVersion).toBe(2);
    }
    const r=await f.service(()=>({...actualDeps,verdictFor:()=>cachedGuard(guardFixture('elevated'))})).run(a,await f.req(a.agentId,'fixture-elevated'));
    expect(r.decision).toBe(mode==='safe'?'deny':'allow');
  });
  it('refuses stale context, stale/missing critical inputs and returns 052 named queue/unavailable states', async () => {
    const a=await f.owner('safe'),req=await f.req(a.agentId),base=f.cached(req,{} as Policy,a.agent,NOW);
    const oldContext=await f.service().run(a,{...req,context:{reportedAt:new Date(NOW-300001).toISOString()}});
    expect(oldContext.reasons.some(r=>r.startsWith('stale_context'))).toBe(true);
    const cases: [Partial<Deps>,string][] = [
      [{actualStateFor:()=>undefined},'actual_state_unavailable'],
      [{actualOrderFor:undefined},'actual_order_quote_queued'],
      [{actualOrderFor:()=>({status:'queued',code:'actual_account_probe_queued'})},'actual_order_quote_queued: actual_account_probe_queued'],
      [{actualOrderFor:()=>({status:'unavailable',code:'actual_account_probe_unavailable'})},'actual_order_quote_unavailable: actual_account_probe_unavailable'],
      [{verdictFor:()=>cachedGuard({...guardFixture(),cursor:{...guardFixture().cursor,timestampSec:String((NOW-31000)/1000)}})},'guard_stale'],
    ];
    for(const [i,[patch,code]] of cases.entries()) {
      const result=await f.service(()=>({...base,...patch})).run(a,{...req,clientOrderRef:`fixture-missing-${i}`});
      expect(result.decision).toBe('deny');expect(result.reasons.some(r=>r.startsWith(code)),JSON.stringify(result.reasons)).toBe(true);
    }
    const missing=await f.service().run(a,{...req,clientOrderRef:'fixture-binding-missing',order:{...req.order,execution:undefined}});
    expect(missing.reasons).toContain('actual_order_binding_missing');
  });
  it('returns approval_unavailable at T and does not create approval state', async () => {
    const a=await f.owner();await setPolicy(a.agentId,{approvalAboveUsd:1});
    const result=await f.service().run(a,await f.req(a.agentId));
    expect(result.decision).toBe('deny');expect(result.reasons[0]).toMatch(/^approval_unavailable:/);expect(result.approvalId).toBeUndefined();
  });
  it.each(['approved','denied','expired','high','killed','policy','stale'] as const)('fully re-evaluates pending approval for %s, journals every evaluation and replays final state', async change => {
    const a=await f.owner();await setPolicy(a.agentId,{approvalAboveUsd:1});
    const req=await f.req(a.agentId),approvals=approvalAdapter();let danger=false;
    const inputs:CachedPreflightInputs=(...args)=>({...f.cached(...args),...(danger?{verdictFor:()=>cachedGuard(guardFixture('high'))}:{})});
    const service=f.service(inputs,approvals.adapter),first=await service.run(a,req),pending=await service.run(a,req);
    expect(first.decision).toBe('needs_approval');expect(pending.preflightId).toBe(first.preflightId);expect(pending.approvalId).toBe(first.approvalId);
    expect(pending.journalId).not.toBe(first.journalId);
    if(change==='denied')approvals.set('denied');else if(change==='expired')approvals.expire();else approvals.set('approved');
    if(change==='high')danger=true;
    if(change==='killed')await f.harness.update(a.accountId,a.agentId,{status:'soft_killed'},10);
    if(change==='policy')await setPolicy(a.agentId,{blockAssets:[req.order.instrument]});
    const next=await service.run(a,change==='stale'?{...req,context:{reportedAt:new Date(NOW-300001).toISOString()}}:req);
    // Balanced stale context warns; all other changed gates deny even with an approval.
    expect(next.decision).toBe(change==='approved'||change==='stale'?'allow':'deny');
    if(change==='stale')expect(next.reasons.some(r=>r.startsWith('stale_context'))).toBe(true);
    expect(next.preflightId).toBe(first.preflightId);expect(next.approvalId).toBe(first.approvalId);
    expect(next.journalId).not.toBe(pending.journalId);expect(await service.run(a,req)).toEqual(next);
    expect(await counts(a.agentId)).toEqual({p:1,j:3,r:3});
  });
  it('rolls back pending re-evaluation and refuses a missing approval without replacing its ID', async () => {
    const a=await f.owner();await setPolicy(a.agentId,{approvalAboveUsd:1});
    const req=await f.req(a.agentId),approvals=approvalAdapter(),service=f.service(f.cached,approvals.adapter);
    const first=await service.run(a,req);approvals.set('approved');
    const append=f.journal.appendInTransaction.bind(f.journal);
    const crash=vi.spyOn(f.journal,'appendInTransaction').mockImplementationOnce(async(...args)=>{await append(...args);throw new Error('fixture crash');});
    await expect(service.run(a,req)).rejects.toMatchObject({code:'internal_error'});crash.mockRestore();
    expect((await f.handle.chain.sql.query<{result:unknown}>('SELECT result FROM preflights WHERE id=$1',[first.preflightId])).rows[0]!.result).toEqual(first);
    expect(await counts(a.agentId)).toEqual({p:1,j:1,r:1});
    const missing={...approvals.adapter,current:async()=>undefined,create:vi.fn(approvals.adapter.create)};
    await expect(f.service(f.cached,missing).run(a,req)).rejects.toMatchObject({code:'internal_error'});
    expect(missing.create).not.toHaveBeenCalled();
    const next=await service.run(a,req);expect(next.decision).toBe('allow');expect(next.approvalId).toBe(first.approvalId);
  });
  it('measures cached server preflight p95 including transaction/encryption, excluding async queue/RPC acquisition', async () => {
    const a=await f.owner(),req=await f.req(a.agentId),service=f.service(),times:number[]=[];
    for(let i=0;i<10;i++)await service.run(a,{...req,clientOrderRef:`fixture-warmup-${i}`});
    for(let i=0;i<100;i++){const start=performance.now();expect((await service.run(a,{...req,clientOrderRef:`fixture-timing-${i}`})).decision).toBe('allow');times.push(performance.now()-start);}
    times.sort((a,b)=>a-b);const p95=times[94]!;
    console.log(JSON.stringify({origin:'offline_fixture',samples:100,warmup:10,p95_ms:p95,includes:'server persistence and encryption',queue_rpc_ms:0,upstream_requests:0,cost_usd:0}));
    expect(p95).toBeLessThan(150);
  });
  it('registers real MCP handlers, forces bearer identity, preserves encryption and makes private receipts commitment-only', async () => {
    const a=await f.owner(),b=await f.owner(),tools=registerHarnessTools(new ToolRegistry(),f.service(),f.journal);
    const app=buildMcpApp({publicUrl:'https://mcp.eko.example/mcp',tools,authenticate:k=>f.harness.authenticate(k),
      entitlements:()=>new EntitlementsService({LAUNCH_WEEK_AGENT_LIMIT:10}).get(),limits:{consume:async()=>({allowed:true,retryAfterSec:60})}});
    const call=(name:string,args:object)=>app.inject({method:'POST',url:'/mcp',headers:{authorization:`Bearer ${a.key.secret}`,accept:'application/json, text/event-stream'},
      payload:{jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}}});
    try {
      const result=(await call('preflight',{...await f.req(a.agentId),agentId:b.agentId})).json().result.structuredContent;
      expect(result.decision).toBe('allow');expect(await counts(b.agentId)).toEqual({p:0,j:0,r:0});
      const entry=(await call('journal',{kind:'note',preflightId:result.preflightId,payload:{text:'fixture-private-note'}})).json().result.structuredContent;
      expect(entry.agentId).toBe(a.agentId);
      const row=(await f.handle.chain.sql.query<{ciphertext:Uint8Array}>('SELECT ciphertext FROM harness_journal WHERE id=$1',[entry.id])).rows[0]!;
      expect(Buffer.from(row.ciphertext).toString()).not.toContain('fixture-private-note');
      expect((await f.handle.chain.sql.query('SELECT * FROM receipt_private_publications WHERE id=$1',[entry.id])).rows[0]).toMatchObject({commitment:entry.commitment});
      expect((await f.journal.page(a.accountId,a.agentId)).rows.find(e=>e.id===result.journalId)?.payload).toMatchObject({decision:'allow',orderHash:orderHash((await f.req(a.agentId)).order)});
      expect((await call('journal',{kind:'note',payload:{},share:true})).json().result.structuredContent.share).toBe(true);
    } finally {await app.close();}
  });
  it.each([true,false])('runtime gates write-tool discovery on encryption/destruction configuration (%s) and keeps D0 tools absent', async enabled => {
    const handle=await import('../../server/src/db/client.js').then(m=>m.openDb({pgliteDir:':memory:'}));
    const {runMigrations}=await import('../../server/src/db/client.js');
    await runMigrations(handle);
    const runtime=await createMcpRuntime({HARNESS_KEY_PEPPER:f.pepper,MCP_PUBLIC_URL:'https://mcp.eko.example/mcp',
      ...(enabled?{JOURNAL_KEK:f.kek.toString('hex'),JOURNAL_KEK_ID:f.keyId,JOURNAL_TOMBSTONE_PATH:f.path}:{}),LAUNCH_WEEK_AGENT_LIMIT:'10'},undefined,async()=>handle);
    try {
      const auth=new HarnessService(handle.db,f.pepper);
      const [owner]=await handle.db.insert(accounts).values({kind:'wallet'}).returning();
      const agent=await auth.create(owner!.id,{name:'Sample runtime agent',kind:'other',preset:'balanced'},1);
      const key=await auth.createKey(owner!.id,agent.id);
      const list=await runtime.app.inject({method:'POST',url:'/mcp',headers:{authorization:`Bearer ${key.secret}`,accept:'application/json, text/event-stream'},
        payload:{jsonrpc:'2.0',id:1,method:'tools/list'}});
      expect(list.statusCode,list.body).toBe(200);
      expect(list.json().result.tools.map((tool:{name:string})=>tool.name)).toEqual(['coin_verdict','coin_card','playbook_match','census_summary','receipts_lookup',...(enabled?['preflight','journal']:[])]);
    }finally{await runtime.app.close();}
  });
});
