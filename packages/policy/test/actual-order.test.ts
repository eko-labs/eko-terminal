import { describe, expect, it, vi } from 'vitest';
import { ActualOrderBindingSchema, PreflightRequestSchema, type ActualOrderBinding, type ActualOrderState, type Policy } from '@eko/shared';
import { actualBindingHash, evaluate, orderHash, resolveRepeat, executionPolicyHash } from '../src/index.js';
import { agent, actualRequest, binding, deps, h, observationFor, stateFor, wallet } from './actual-fixtures.js';
import { approval, NOW, policy } from './fixtures.js';
import { cachedGuard, guardFixture } from './guard-fixtures.js';
const code = (reasons: string[]) => reasons.map(r => r.split(':')[0]);
const run = (p = policy, b = binding(p), d = deps) => evaluate({ ...actualRequest(p), order: {
  ...actualRequest(p).order, side: b.side, execution: b, tx: { to: b.tx.to, data: b.tx.data, value: b.tx.value },
} }, p, agent, d);
// Match the existing package timing fixture without introducing Node typings.
declare const performance: { now(): number };
declare const console: { info(message: string): void };
const other = `0x${'22'.repeat(32)}` as const;

describe('actual-order cached policy semantics (Guard §§1,3.4,7.2)', () => {
  it('rejects an unbound V2 order even with reference-size liquidity/cost data', () => {
    const req = actualRequest(); delete req.order.execution;
    expect(code(evaluate(req, policy, agent, deps).reasons)).toContain('actual_order_binding_missing');
  });
  it('names asynchronous misses and unavailable acquisition without an allow', () => {
    for (const status of ['queued', 'unavailable'] as const) expect(code(run(policy, binding(), { ...deps,
      actualOrderFor: () => ({ status, code: 'profile_missing' }) }).reasons)).toContain(`actual_order_quote_${status}`);
  });
  it.each([15000, 15001])('quote maximum age at %i ms', age => {
    const b = binding(), q = observationFor(b); q.quotedAtMs = NOW - age; q.expiresAtMs = q.quotedAtMs + 15000;
    const r = run(policy, b, { ...deps, actualOrderFor: () => ({ status: 'ready', observation: q }) });
    expect(r.decision).toBe(age === 15000 ? 'allow' : 'deny');
    if (age > 15000) expect(code(r.reasons)).toContain('quote_expired');
  });
  it.each([5000, 5001])('actual-account refresh at %i ms', age => {
    const b = binding(), q = observationFor(b); q.quotedAtMs = NOW - 10000; q.refreshedAtMs = NOW - age;
    q.expiresAtMs = q.quotedAtMs + 15000;
    const r = run(policy, b, { ...deps, actualOrderFor: () => ({ status: 'ready', observation: q }) });
    expect(r.decision).toBe(age === 5000 ? 'allow' : 'deny');
    if (age > 5000) expect(code(r.reasons)).toContain('quote_refresh_required');
  });
  it.each(['routeFingerprint','profileHash','stateFingerprint','balanceHash','feeHash','controlHash','sourceRevision','semanticHash'] as const)(
    'invalidates %s immediately inside quote age ceilings', field => {
      const b = binding(), state = { ...stateFor(b), [field]: other };
      const r = run(policy, b, { ...deps, actualStateFor: () => state });
      expect(code(r.reasons)).toContain('actual_order_state_changed');
    });
  it.each(['observedAtMs','criticalCheckedAtMs'] as const)('rejects stale %s', field => {
    expect(code(run(policy, binding(), { ...deps, actualStateFor: b => ({ ...stateFor(b), [field]: NOW - 5001 }) }).reasons))
      .toContain('critical_state_stale');
  });
  it('rejects same-height reorg and allows a completed new head with unchanged dependencies', () => {
    const b = binding(), s = stateFor(b);
    expect(code(run(policy, b, { ...deps, actualStateFor: () => ({ ...s, cursor: { ...s.cursor, blockHash: other } }) }).reasons))
      .toContain('actual_order_state_changed');
    expect(run(policy, b, { ...deps, actualStateFor: () => ({ ...s, cursor: { ...s.cursor, blockNumber: '124', blockHash: other } }) }).decision).toBe('allow');
  });
  it.each([30000, 31000])('served Guard snapshot age %i ms', age => {
    const g = guardFixture(); g.cursor.timestampSec = String((NOW - age) / 1000);
    expect(run(policy, binding(), { ...deps, verdictFor: () => cachedGuard(g) }).decision).toBe(age === 30000 ? 'allow' : 'deny');
  });
  it('uses actual size, signed Q/R and separately priced network fees; never interpolates', () => {
    const p = { ...policy, maxRoundTripCostPct: 5 }, b = binding(p), q = observationFor(b);
    q.returned = (BigInt(q.spent) * 95n / 100n - 1n).toString();
    expect(code(run(p,b,{...deps,actualOrderFor:()=>({status:'ready',observation:q})}).reasons)).toContain('round_trip_cost');
    q.returned = (BigInt(q.spent) * 95n / 100n).toString(); q.entryNetworkFee = q.spent; q.exitNetworkFee = q.spent;
    expect(run(p,b,{...deps,actualOrderFor:()=>({status:'ready',observation:q})}).decision).toBe('allow');
    q.returned = (BigInt(q.spent) + 1n).toString();
    expect(run(p,b,{...deps,actualOrderFor:()=>({status:'ready',observation:q})}).decision).toBe('allow');
  });
  describe('a bonding-curve buy is judged by its exact round-trip cost, not by depth (owner decision 2026-10-06)', () => {
    // A fresh curve: ~$70 of ±2% depth (far below every preset floor) and a 7% measured round trip (fee, tax, impact).
    const curveBuy = (mode: Policy['mode'], costPct: bigint, curve: boolean) => {
      const p: Policy = { mode, blockPlaybookLevel: null, killed: false, version: 1 }, b = binding(p), q = observationFor(b);
      q.depthUsdLower = 70; q.returned = (BigInt(q.spent) * (100n - costPct) / 100n).toString();
      return code(run(p, b, { ...deps, actualOrderFor: () => ({ status: 'ready', observation: q }), ...(curve ? { lockedLiquidityRoute: () => true } : {}) }).reasons);
    };
    it('refuses in Careful (5%) and admits in Balanced (10%) and Degen (25%) at a 7% round trip', () => {
      expect(curveBuy('safe', 7n, true)).toEqual(['round_trip_cost']);
      expect(curveBuy('balanced', 7n, true)).toEqual([]);
      expect(curveBuy('degen', 7n, true)).toEqual([]);
    });
    it('still refuses a curve whose round trip exceeds the mode’s ceiling', () => {
      expect(curveBuy('balanced', 11n, true)).toEqual(['round_trip_cost']);
      expect(curveBuy('degen', 26n, true)).toEqual(['round_trip_cost']);
      expect(curveBuy('degen', 24n, true)).toEqual([]);
    });
    it('keeps every depth floor for pools (no curve statement, or a host that says false)', () => {
      for (const mode of ['safe', 'balanced', 'degen'] as const) expect(curveBuy(mode, 1n, false)).toEqual(['thin_liquidity']);
      const p: Policy = { mode: 'degen', blockPlaybookLevel: null, killed: false, version: 1 }, b = binding(p), q = observationFor(b);
      q.depthUsdLower = 70;
      expect(code(run(p, b, { ...deps, actualOrderFor: () => ({ status: 'ready', observation: q }), lockedLiquidityRoute: () => false }).reasons)).toEqual(['thin_liquidity']);
    });
  });
  it('compares very small policy ceilings written in exponent notation', () => {
    const p={...policy,maxRoundTripCostPct:1e-7},b=binding(p),q=observationFor(b);q.returned=q.spent;
    expect(run(p,b,{...deps,actualOrderFor:()=>({status:'ready',observation:q})}).decision).toBe('allow');
  });
  it('binds declared slippage to the actual minimum, including native price checks after refunds', () => {
    const b={...binding(),minOut:'1'},q=observationFor(b);
    expect(code(run(policy,b,{...deps,actualOrderFor:()=>({status:'ready',observation:q})}).reasons)).toContain('actual_order_slippage_mismatch');
    const sell={...binding(),side:'sell' as const,tx:{...binding().tx,value:'0'}},s=observationFor(sell);s.returned='1';
    expect(code(run(policy,sell,{...deps,actualOrderFor:()=>({status:'ready',observation:s})}).reasons)).toContain('actual_order_slippage_exceeded');
  });
  it('uses pinned actual valuation for exposure/approval despite a smaller caller notional', () => {
    const p = { ...policy, maxPositionUsd: 500, approvalAboveUsd: 500 }, b = binding(p), q = observationFor(b); q.notionalUsd = 2001;
    const r = run(p,b,{...deps,actualOrderFor:()=>({status:'ready',observation:q})});
    expect(code(r.reasons)).toContain('position_cap');
    const approved = vi.fn(() => ({ ...approval, status: 'approved' as const }));
    expect(run({...p,maxPositionUsd:3000},binding({...p,maxPositionUsd:3000}),{...deps,approvalFor:approved,
      actualOrderFor: b => ({status:'ready',observation:{...observationFor(b),notionalUsd:2001}})}).decision).toBe('allow');
    expect(approved).toHaveBeenCalledOnce();
  });
  it('rejects fixture provenance, incomplete probes, wrong mode and held quantity', () => {
    const b = binding(), q = observationFor(b);
    for (const patch of [{origin:'fixture' as const},{status:'unsupported' as const},{mode:'sell_only' as const},{evidenceIds:[]}])
      expect(run(policy,b,{...deps,actualOrderFor:()=>({status:'ready',observation:{...q,...patch}})}).decision).toBe('deny');
    const sell = {...b,side:'sell' as const,tx:{...b.tx,value:'0'}};
    expect(code(run(policy,sell,{...deps,actualOrderFor:()=>({status:'ready',observation:{...observationFor(sell),heldBefore:'0'}})}).reasons))
      .toContain('actual_order_amounts_invalid');
  });
  it.each(['safe','balanced','degen'] as const)('%s sells require sell-only execution and bypass buyer-level gates', mode => {
    const p = {...policy,mode,blockPlaybookLevel:null}, b = {...binding(p),side:'sell' as const}; b.tx={...b.tx,value:'0'};
    const noBuy = vi.fn(() => { throw new Error('Sell must not buy or fetch buyer assessment'); });
    expect(run(p,b,{...deps,verdictFor:noBuy}).decision).toBe('allow');
    expect(noBuy).not.toHaveBeenCalled();
    expect(code(run(p,b,{...deps,actualStateFor:b=>({...stateFor(b),routeAvailable:false})}).reasons)).toEqual(['sell_route_unavailable']);
  });
  it('preserves final idempotent replay while current execution policy denies', () => {
    const req = actualRequest(), hash=orderHash(req.order), stored={preflightId:'p',journalId:'j',policyVersion:1,decision:'allow' as const,reasons:[]};
    expect(resolveRepeat({orderHash:hash,result:stored},hash,()=>{throw new Error('Replay changed');})).toBe(stored);
    expect(run({...policy,killed:true}).decision).toBe('deny');
  });
  it.each(['safe','balanced','degen'] as const)('%s owner approval cannot override High or missing critical checks with null', mode => {
    const p={...policy,mode,blockPlaybookLevel:null,approvalAboveUsd:0};
    for(const g of [guardFixture('high'),guardFixture('lower',['reference_exit'],'stale')]) {
      const approve=vi.fn(()=>({...approval,status:'approved' as const}));
      expect(run(p,binding(p),{...deps,verdictFor:()=>cachedGuard(g),approvalFor:approve}).decision).toBe('deny');
      expect(approve).not.toHaveBeenCalled();
    }
  });
  it('Safe with null still rejects Elevated', () => {
    const p={...policy,mode:'safe' as const,blockPlaybookLevel:null};
    expect(code(run(p,binding(p),{...deps,verdictFor:()=>cachedGuard(guardFixture('elevated'))}).reasons)).toContain('guard_elevated');
  });
  it('includes every actual binding field and raw integers in orderHash; rejects malformed wire bindings', () => {
    const req=actualRequest(), baseline=orderHash(req.order), b=binding();
    const patches: Partial<ActualOrderBinding>[]=[{account:`0x${'ef'.repeat(20)}`},{recipient:`0x${'ef'.repeat(20)}`},
      {coin:`0x${'ef'.repeat(20)}`},{side:'sell'},{amountIn:(BigInt(b.amountIn)+1n).toString()},{minOut:'2'},
      {slippageBps:101},{routeFingerprint:other},{profileHash:other},{stateFingerprint:other},{policyHash:other},{guardReceiptId:'next'},
      {cursor:{...b.cursor,blockHash:other}},{tx:{...b.tx,data:'0xcd'}},{tx:{...b.tx,value:'1'}},
      {approval:{token:b.coin,spender:wallet,amount:b.amountIn,kind:'erc20',tx:{chainId:4663,to:b.coin,data:'0xab',value:'0'}}}];
    for(const patch of patches)expect(orderHash({...req.order,execution:{...b,...patch}})).not.toBe(baseline);
    for(const patch of [{amountIn:'1e18'},{amountIn:'0'},{amountIn:(2n**256n).toString()},{slippageBps:10000},{chainId:8453}])
      expect(ActualOrderBindingSchema.safeParse({...b,...patch}).success).toBe(false);
    expect(PreflightRequestSchema.parse(req)).toEqual(req);
    expect(actualBindingHash(b)).toMatch(/^0x[0-9a-f]{64}$/);
  });
  it('reports local cached p95 against the 150ms operational target', () => {
    const timings:number[]=[], req=actualRequest();
    for(let i=0;i<100;i++)evaluate(req,policy,agent,deps);
    for(let i=0;i<500;i++){const t=performance.now();expect(evaluate(req,policy,agent,deps).decision).toBe('allow');timings.push(performance.now()-t);}
    const p95=timings.sort((a,b)=>a-b)[Math.ceil(timings.length*.95)-1];
    console.info(`052 fixture cached evaluate: n=500 p95_ms=${p95.toFixed(3)} upstream_requests=0`);
    expect(p95).toBeLessThan(150);
  });
});
