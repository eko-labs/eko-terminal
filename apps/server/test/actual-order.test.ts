import { describe, expect, it, vi } from 'vitest';
import { ActualOrderService, type CapturedExecution, type ActualAccountRevalidationInput } from '../src/exec/actual-order.js';
import { actualBindingHash, orderHash, resolveRepeat } from '@eko/policy';
import { agent, actualRequest, binding, deps, h, observationFor, stateFor } from '../../../packages/policy/test/actual-fixtures.js';
import { NOW, policy, approval } from '../../../packages/policy/test/fixtures.js';
import { cachedGuard, guardFixture } from '../../../packages/policy/test/guard-fixtures.js';
import type { ActualOrderBinding } from '@eko/shared';
import type { Hex } from 'viem';
const capture = (b = binding()): CapturedExecution => ({ request: { ...actualRequest(), order: { ...actualRequest().order,
  execution:b,side:b.side,tx:{to:b.tx.to,data:b.tx.data,value:b.tx.value} } }, policy, agent, deps, admission:{status:'allowed'}, state:stateFor(b), quoteClocks:{quotedAtMs:NOW,expiresAtMs:NOW+15000} });
const probe = { observe: vi.fn(async (b:ActualOrderBinding) => observationFor(b)) };
const clocks={quotedAtMs:NOW,expiresAtMs:NOW+15000};
const handoff = (b=binding()):ActualAccountRevalidationInput => ({...b,requestClockMs:NOW,...clocks,
  unsigned:{tx:b.tx,approval:b.approval,refundRecipient:b.side==='buy'?b.account:null},
  guardReceiptId:b.guardReceiptId as Hex,orderHash:orderHash(capture(b).request.order)});

describe('052 isolated acquisition queue and separate execution preparation',()=>{
  it('returns a named unavailable status when no actual-account worker is installed',async()=>{
    const service=new ActualOrderService(async()=>capture(),undefined,()=>NOW);
    expect(service.lookup(binding(),stateFor(binding()),NOW)).toEqual({status:'unavailable',code:'actual_account_probe_unavailable'});
    expect(await service.prepare(actualRequest(),clocks)).toEqual({status:'unavailable',code:'actual_account_probe_unavailable'});
  });
  it('deduplicates async misses, caches exact bindings, and queues refresh after five seconds',async()=>{
    let at=NOW;const worker={observe:vi.fn(async(b:ActualOrderBinding,s:CapturedExecution['state'],t:number)=>({...observationFor(b),state:s,quotedAtMs:t,refreshedAtMs:t,expiresAtMs:t+15000}))};
    const service=new ActualOrderService(async()=>capture(),worker,()=>at);
    expect(service.lookup(binding(),stateFor(binding()),at).status).toBe('queued');
    expect(service.lookup(binding(),stateFor(binding()),at).status).toBe('queued');
    await service.drain();expect(worker.observe).toHaveBeenCalledOnce();
    const hit=service.lookup(binding(),stateFor(binding()),at);
    expect(hit.status).toBe('ready');
    if(hit.status==='ready')hit.observation.returned='0';
    expect(service.lookup(binding(),stateFor(binding()),at)).toMatchObject({status:'ready',observation:{returned:observationFor(binding()).returned}});
    at+=5000;expect(service.lookup(binding(),stateFor(binding()),at).status).toBe('ready');
    at++;expect(service.lookup(binding(),stateFor(binding()),at)).toMatchObject({status:'queued',code:'actual_account_refresh_queued'});
    await service.drain();
    service.invalidate(()=>true);expect(service.lookup(binding(),stateFor(binding()),at).status).toBe('queued');await service.drain();
  });
  it('does not repopulate an invalidated cache from an in-flight observation',async()=>{
    let release!:(q:ReturnType<typeof observationFor>)=>void;
    const worker={observe:vi.fn(()=>new Promise<ReturnType<typeof observationFor>>(r=>{release=r;}))};
    const service=new ActualOrderService(async()=>capture(),worker,()=>NOW);
    expect(service.lookup(binding(),stateFor(binding()),NOW).status).toBe('queued');await Promise.resolve();
    service.invalidate(()=>true);release(observationFor(binding()));await service.drain();
    expect(service.lookup(binding(),stateFor(binding()),NOW).status).toBe('queued');await Promise.resolve();
    release(observationFor(binding()));await service.drain();
    expect(service.lookup(binding(),stateFor(binding()),NOW).status).toBe('ready');
  });
  it('bounds queue size and isolates provider failure details',async()=>{
    let release!:()=>void;
    const worker={observe:vi.fn(async()=>{await new Promise<void>(r=>{release=r;});throw new Error('provider-private-details');})};
    const service=new ActualOrderService(async()=>capture(),worker,()=>NOW,1);
    expect(service.lookup(binding(),stateFor(binding()),NOW).status).toBe('queued');
    await Promise.resolve();
    const other={...binding(),minOut:'2'};
    expect(service.lookup(other,stateFor(other),NOW)).toEqual({status:'unavailable',code:'actual_account_queue_full'});
    release();await service.drain();
    expect(service.lookup(binding(),stateFor(binding()),NOW).status).toBe('queued');await Promise.resolve();release();await service.drain();
  });
  it('separately probes actual bytes on every preparation while final replay remains unchanged',async()=>{
    const worker={observe:vi.fn(async(b:ActualOrderBinding)=>observationFor(b))};
    const service=new ActualOrderService(async()=>capture(),worker,()=>NOW),req=actualRequest(),hash=orderHash(req.order);
    const stored={preflightId:'p',journalId:'j',decision:'allow' as const,reasons:[],policyVersion:1};
    expect(resolveRepeat({orderHash:hash,result:stored},hash,()=>{throw new Error('Must replay');})).toBe(stored);
    // The measured round trip the buy was judged on travels with the result, so the quote can show its exit cost.
    const o=observationFor(req.order.execution!);
    expect(await service.prepare(req,clocks)).toEqual({status:'validated',orderHash:hash,evidenceIds:[h],roundTrip:{spent:o.spent,returned:o.returned}});
    expect(await service.prepare(req,clocks)).toMatchObject({status:'validated'});expect(worker.observe).toHaveBeenCalledTimes(2);
    expect(stored.decision).toBe('allow');
  });
  it.each(['killed','high','critical_stale','policy_changed'] as const)('stored allow cannot override fresh %s',async kind=>{
    const service=new ActualOrderService(async()=>{
      const c=capture();
      if(kind==='killed')c.policy={...policy,killed:true};
      if(kind==='high')c.deps={...deps,verdictFor:()=>cachedGuard(guardFixture('high'))};
      if(kind==='critical_stale')c.state={...c.state,criticalCheckedAtMs:NOW-5001};
      if(kind==='policy_changed')c.policy={...policy,version:2};
      return c;
    },probe,()=>NOW);
    expect(await service.prepare(actualRequest(),clocks)).toMatchObject({status:'unavailable',code:
      kind==='killed'?'killed':kind==='high'?'guard_high':kind==='critical_stale'?'critical_state_stale':'execution_policy_changed'});
  });
  it('requires admission/sanctions before probing and rechecks them after acquisition',async()=>{
    const worker={observe:vi.fn(async(b:ActualOrderBinding)=>observationFor(b))};
    const denied={...capture(),admission:{status:'denied' as const,code:'trading_paused'}};
    const service=new ActualOrderService(async()=>denied,worker,()=>NOW);
    expect(await service.prepare(actualRequest(),clocks)).toEqual({status:'unavailable',code:'trading_paused'});
    expect(worker.observe).not.toHaveBeenCalled();
    let count=0;const raced=new ActualOrderService(async()=>count++?{...capture(),admission:{status:'denied',code:'sanctions_blocked'}}:capture(),worker,()=>NOW);
    expect(await raced.prepare(actualRequest(),clocks)).toEqual({status:'unavailable',code:'sanctions_blocked'});
  });
  it('rechecks state after async observation and refuses a raced fee update',async()=>{
    let captures=0;
    const service=new ActualOrderService(async()=>{const c=capture();if(captures++)c.state={...c.state,feeHash:`0x${'22'.repeat(32)}`};return c;},probe,()=>NOW);
    expect(await service.prepare(actualRequest(),clocks)).toEqual({status:'unavailable',code:'actual_order_state_changed'});
  });
  it('refuses expiry during acquisition and original expiry even if worker issues a new quote',async()=>{
    let now=NOW;
    const worker={observe:vi.fn(async(b:ActualOrderBinding)=>{now+=15001;return observationFor(b);})};
    const service=new ActualOrderService(async()=>capture(),worker,()=>now);
    expect(await service.prepare(actualRequest(),clocks)).toEqual({status:'unavailable',code:'quote_expired'});
    expect(await service.prepare(actualRequest(),clocks)).toEqual({status:'unavailable',code:'quote_expired'});
    expect(worker.observe).toHaveBeenCalledOnce();
  });
  it('requires actual token approval confirmation and rechecks sells without buyer gates',async()=>{
    const b={...binding(),side:'sell' as const,tx:{...binding().tx,value:'0'}};
    const worker={observe:vi.fn(async()=>({...observationFor(b),allowanceBefore:'0'}))};
    const service=new ActualOrderService(async()=>capture(b),worker,()=>NOW);
    expect(await service.prepare(capture(b).request,clocks)).toEqual({status:'unavailable',code:'token_approval_required'});
    worker.observe.mockImplementation(async()=>observationFor(b));
    expect(await service.prepare(capture(b).request,clocks)).toMatchObject({status:'validated'});
  });
  it('requires the paying token allowance for buys paid in a token, never for native-value buys',async()=>{
    const tokenPaid={...binding(),tx:{...binding().tx,value:'0'}};
    const worker={observe:vi.fn(async(b:ActualOrderBinding)=>({...observationFor(b),allowanceBefore:'0'}))};
    const service=new ActualOrderService(async()=>capture(tokenPaid),worker,()=>NOW);
    const paid=observationFor(tokenPaid);
    expect(await service.prepare(capture(tokenPaid).request,clocks)).toEqual({status:'unavailable',code:'token_approval_required',roundTrip:{spent:paid.spent,returned:paid.returned}});
    worker.observe.mockImplementation(async(b:ActualOrderBinding)=>observationFor(b));
    expect(await service.prepare(capture(tokenPaid).request,clocks)).toMatchObject({status:'validated'});
    // Native ETH pays a native-value buy: the probe's allowance reading is irrelevant there.
    const native=new ActualOrderService(async()=>capture(),{observe:async(b:ActualOrderBinding)=>({...observationFor(b),allowanceBefore:'0'})},()=>NOW);
    expect(await native.prepare(actualRequest(),clocks)).toMatchObject({status:'validated'});
  });
  it('implements the 072 structural handoff and refuses changed hashes, bytes and stale request clocks',async()=>{
    const service=new ActualOrderService(async()=>capture(),probe,()=>NOW),input=handoff();
    expect(await service.revalidate(input)).toMatchObject({status:'validated',orderHash:input.orderHash});
    for(const patch of [{orderHash:h},{minOut:'2'},{requestClockMs:NOW-5001},{unsigned:{...input.unsigned,refundRecipient:null}}])
      expect(await service.revalidate({...input,...patch})).toMatchObject({status:'unavailable'});
    expect(actualBindingHash(binding())).toMatch(/^0x/);
  });
  it('keeps approval scope bound to the captured agent and client order reference',async()=>{
    const service=new ActualOrderService(async()=>capture(),probe,()=>NOW);
    for(const patch of [{agentId:'different-agent'},{clientOrderRef:'different-order'}])
      expect(await service.prepare({...actualRequest(),...patch},clocks)).toEqual({status:'unavailable',code:'order_mismatch'});
    let captures=0;const raced=new ActualOrderService(async()=>{const c=capture();if(captures++)c.request={...c.request,clientOrderRef:'different-order'};return c;},probe,()=>NOW);
    expect(await raced.prepare(actualRequest(),clocks)).toEqual({status:'unavailable',code:'actual_order_state_changed'});
  });
  it('refuses caller-renewed quote clocks against the retained quote',async()=>{
    const service=new ActualOrderService(async()=>capture(),probe,()=>NOW+1000);
    expect(await service.prepare(actualRequest(),{quotedAtMs:NOW+1000,expiresAtMs:NOW+16000})).toMatchObject({status:'unavailable',code:'quote_clock_mismatch'});
  });
  it('re-evaluates owner approval under current depth/cost policy',async()=>{
    const p={...policy,approvalAboveUsd:50};
    const b=binding(p),c:CapturedExecution={...capture(b),policy:p,deps:{...deps,approvalFor:()=>({...approval,status:'approved' as const})}};
    const service=new ActualOrderService(async()=>c,probe,()=>NOW);
    expect(await service.prepare(c.request,clocks)).toMatchObject({status:'validated'});
    c.deps={...c.deps,approvalFor:()=>({...approval,status:'expired' as const})};
    expect(await service.prepare(c.request,clocks)).toMatchObject({status:'unavailable',code:'approval_expired'});
  });
});
