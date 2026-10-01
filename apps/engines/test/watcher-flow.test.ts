import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { flowMarker, measureFlow, resolveFlowLabel, type ClassifiedSwap } from '../src/watcher/flow.js';
const address=(n:number)=>`0x${n.toString(16).padStart(40,'0')}` as Address;
const model='fp-1.0.0';
const swap=(n:number,changes:Partial<ClassifiedSwap>={}):ClassifiedSwap=>({id:String(n),coin:address(1),block:n,sec:n,side:'buy',usd:100,wallet:address(n),senderPending:false,pricePending:false,label:{label:'human',confidence:0.9},crew:{status:'available',member:null},...changes});
describe('Watcher measured flow',()=>{
  it.each([['5m',300],['1h',3600],['24h',86400]] as const)('honors %s time/block boundaries and future exclusion',(window,duration)=>{
    const sec=100000;
    const data=measureFlow([swap(1,{sec:sec-duration}),swap(2,{sec:sec-duration+1}),swap(3,{sec}),swap(4,{sec:sec+1}),swap(101,{sec})],window,100,sec,model);
    expect(data.buyUsd).toBe(200);expect(data.data.humanPct).toBe(100);expect(data.data.meta?.unavailable).toBe(false);
  });
  it('splits declared/likely, preserves crew attachment and applies precedence without double counting',()=>{
    const crew={status:'available' as const,member:{status:'qualified' as const,crewId:'crew_fixture',confidence:0.95,evidence:[]}};
    const swaps=[swap(1,{label:{label:'declared_agent',confidence:0.99},crew}),swap(2,{label:{label:'likely_agent',confidence:0.8}}),swap(3,{label:{label:'likely_agent',confidence:0.8},crew}),swap(4)];
    const flow=measureFlow(swaps,'5m',4,4,model).data;
    expect(flow).toMatchObject({agentPct:50,declaredAgentPct:25,likelyAgentPct:25,crewPct:25,humanPct:25,confidence:1,beta:true,modelVersion:model});
    expect(flowMarker(swaps[0],model)).toMatchObject({label:'declared_agent',crewId:'crew_fixture',sizeUsd:100,beta:true});
    expect(flowMarker(swaps[2],model)?.label).toBe('crew');
  });
  it('keeps pending sender/price and missing labels unavailable, never filling human or zero USD',()=>{
    for(const changes of [{senderPending:true},{wallet:null},{pricePending:true},{usd:null},{label:null}]) {
      const flow=measureFlow([swap(1),swap(2,changes)],'5m',2,2,model).data;
      expect(flow.meta?.unavailable).toBe(true);expect(flow.meta?.missing).toContain('humanPct');expect(flowMarker(swap(2,changes),model)).toBeNull();
      if(changes.pricePending||changes.usd===null)expect(flow.confidence).toBe(0);
      else expect(flow.humanPct).toBe(50);
    }
    expect(measureFlow([],'1h',1,1,model).data.meta?.flags).toContain('buy_volume');
  });
  it('uses persisted tiers when computing confidence instead of promoting insufficient evidence',()=>{
    const data=measureFlow([swap(1,{label:{label:'human',confidence:1,tier:'low'}}),swap(2)],'5m',2,2,model).data;
    expect(data.confidence).toBe(0.5);
  });
  it('keeps partial qualified crew coverage unavailable without losing declared attribution',()=>{
    const declared=swap(1,{label:{label:'declared_agent',confidence:0.99},crew:{status:'unavailable'}});
    const likely=swap(2,{label:{label:'likely_agent',confidence:0.8},crew:{status:'unavailable'}});
    const flow=measureFlow([declared,likely],'5m',2,2,model).data;
    expect(flow.declaredAgentPct).toBe(50);expect(flow.humanPct).toBe(0);expect(flow.meta?.flags).toContain('crew_membership');
    expect(flowMarker(declared,model)?.label).toBe('declared_agent');expect(flowMarker(likely,model)).toBeNull();
    expect(()=>resolveFlowLabel({label:'human',confidence:0.8},{status:'available',member:{status:'candidate'} as never})).toThrow('Unqualified');
  });
  it('estimates disjoint same-wallet and qualified-crew round trips within 300 seconds',()=>{
    const crew={status:'available' as const,member:{status:'qualified' as const,crewId:'crew_fixture',confidence:0.95,evidence:[]}};
    const trips=[swap(1,{sec:100,wallet:address(10)}),swap(2,{sec:400,wallet:address(10),side:'sell'}),swap(3,{sec:500,crew}),swap(4,{sec:501,crew,side:'sell'}),swap(5,{sec:600}),swap(6,{sec:901,wallet:address(5),side:'sell'})];
    expect(measureFlow(trips,'1h',6,901,model).data.washEstPct).toBeCloseTo(100*400/600);
    expect(measureFlow([swap(1),swap(2,{wallet:address(1),side:'sell',usd:50})],'5m',2,2,model).data.washEstPct).toBe(0);
    // Boundary is strictly less than 10% gross.
    expect(measureFlow([swap(1,{usd:110}),swap(2,{wallet:address(1),side:'sell',usd:90})],'5m',2,2,model).data.washEstPct).toBe(0);
  });
});
