import { describe, expect, it } from 'vitest';
import { evaluate } from '@eko/policy';
import { ActualOrderBindingSchema } from '@eko/shared';
import type { GuardAssessmentV2, Policy } from '@eko/shared';
import { agent as actualAgent, actualRequest, binding, observationFor, stateFor, deps as actualDeps } from '../../policy/test/actual-fixtures.js';
import { evaluateGuardV2, CONFIG_GUARD_V2 } from '../src/index.js';
import { input, observation as o, gap } from './scoring-fixtures.js';
import { agent, policy, request, deps, verdict, ASSET } from '../../policy/test/fixtures.js';

// Supply actual-order evidence at the scoring fixture's captured clock, without changing score inputs.
function actualPolicy(g: GuardAssessmentV2, p: Policy, costBps = 100) {
  const now = Number(BigInt(g.cursor.timestampSec) * 1000n);
  const b = ActualOrderBindingSchema.parse({ ...binding(p), cursor: g.cursor, profileHash: g.profileHash, guardReceiptId: g.receipt.id });
  const state = { ...stateFor(b), observedAtMs: now, criticalCheckedAtMs: now };
  const q = { ...observationFor(b), state, quotedAtMs: now, refreshedAtMs: now, expiresAtMs: now + 15000 };
  q.returned = (BigInt(q.spent) * BigInt(10000 - costBps) / 10000n).toString();
  const req = actualRequest(p); req.context!.reportedAt = new Date(now).toISOString(); req.order.execution = b;
  return evaluate(req, p, actualAgent, { ...actualDeps, now: () => now, verdictFor: () => ({ ...verdict, guardV2: g }),
    actualStateFor: () => state, actualOrderFor: () => ({ status: 'ready', observation: q }) });
}

// Release-shaped registry ONLY for synthetic policy invariants; production stays shadow.
const released={...CONFIG_GUARD_V2,mode:'active',lowerEnabled:true,
  checks:CONFIG_GUARD_V2.checks.map(c=>({...c,status:'released',acceptanceArtifact:'synthetic-fixture'})),
  factors:CONFIG_GUARD_V2.factors.map(f=>({...f,status:'released',acceptanceArtifact:'synthetic-fixture'})),
  decisive:CONFIG_GUARD_V2.decisive.map(d=>({...d,status:'released',acceptanceArtifact:'synthetic-fixture'}))};
describe('033 scored Safe/High/missing-data invariants; no candidate policy influence',()=>{
  for(const mode of ['safe','balanced','degen'] as const) {
    it(`${mode}: High and critical gap deny, lower-tier gap denies only Safe`,()=>{
      for(const kind of ['high','critical','lower_gap','complete'] as const) {
        const i=input(kind==='high'?[o('arbitrary_control',1)]:[]); i.coin=ASSET; i.mode='active';
        if(kind==='critical')gap(i,'reference_exit'); if(kind==='lower_gap')gap(i,'recent_funding');
        const g=evaluateGuardV2(i,released).assessment;
        const r=actualPolicy(g,{...policy,mode,blockPlaybookLevel:null});
        expect(r.decision).toBe(kind==='high'||kind==='critical'||kind==='lower_gap'&&mode==='safe'?'deny':'allow');
      }
    });
    it(`${mode}: stored shadow High cannot change the legacy result`,()=>{
      const i=input([o('arbitrary_control',1)]); i.coin=ASSET; const g=evaluateGuardV2(i).assessment;
      const baseline=evaluate(request,{...policy,mode},agent,{...deps,verdictFor:()=>verdict});
      const shadow=evaluate(request,{...policy,mode},agent,{...deps,verdictFor:()=>({...verdict,guardV2:g})});
      expect({...shadow,senses:baseline.senses}).toEqual(baseline);
      expect(evaluate(request,{...policy,mode},agent,{...deps,guardPolicyV2:true,verdictFor:()=>({...verdict,guardV2:g})}).reasons).toContain('guard_incomplete: no active Guard assessment for this chain and asset');
    });
  }
  it('Lower cost9.75 does not bypass Safe actual-order cost ceiling5',()=>{
    const i=input([o('execution_cost',9.75)]); i.coin=ASSET; i.mode='active'; const g=evaluateGuardV2(i,released).assessment; expect(g.level).toBe('lower');
    const r=actualPolicy(g,{...policy,mode:'safe',maxRoundTripCostPct:5},975);
    expect(r.decision).toBe('deny');
    expect(r.reasons).toContain('round_trip_cost: exit cost above your maximum');
  });
});
