import { describe, expect, it } from 'vitest';
import { evaluate, applyPreset } from '../src/index.js';
import { request, policy, agent, deps } from './fixtures.js';
describe('optional Blue chips only admission',()=>{
  const p={...policy,blueChipsOnly:true};
  it('refuses a non-member buy with a named reason',()=>{
    const result=evaluate(request,p,agent,{...deps,blueChipEnabled:true,blueChipFor:()=>false});
    expect(result.decision).toBe('deny');expect(result.reasons).toContain('blue_chips_only: this coin is not a Blue chip member');
  });
  it('allows a member buy',()=>expect(evaluate(request,p,agent,{...deps,blueChipEnabled:true,blueChipFor:()=>true}).decision).toBe('allow'));
  it('never blocks a sell or queries its membership',()=>{
    const result=evaluate({...request,order:{...request.order,side:'sell'}},p,agent,{...deps,blueChipEnabled:true,blueChipFor:()=>{throw new Error('sell must not check membership');}});
    expect(result.decision).toBe('allow');
  });
  it('leaves disabled evaluations byte-identical and preserves preset overrides',()=>{
    expect(JSON.stringify(evaluate(request,p,agent,{...deps,blueChipEnabled:false}))).toBe(JSON.stringify(evaluate(request,policy,agent,deps)));
    for(const mode of ['safe','balanced','degen'] as const) {
      expect(applyPreset({...p,mode}).blueChipsOnly).toBe(true);
      expect(applyPreset({...policy,mode}).blueChipsOnly).toBeUndefined();
    }
  });
});
