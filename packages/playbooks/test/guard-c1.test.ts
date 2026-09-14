import { describe, it, expect } from 'vitest';
import { GuardScoreInputSchema } from '@eko/shared';
import type { GuardScoreInput, GuardLevelV2 } from '@eko/shared';
import { evaluateGuardV2 } from '../src/index.js';
import { input, observation as o, gap, metric } from './scoring-fixtures.js';

// C1's original proposals are mapped to the final §5 table (including the organic
// timing-only cap and inclusive percentages). Normalized predicates are synthetic;
// acquisition/attribution algorithms remain separately covered by packets 029–032.
interface Case { id:string; scenario:string; observations:GuardScoreInput['observations']; score:number; level:GuardLevelV2; missing?:GuardScoreInput['checks'][number]['id']; sellBlock?:boolean }
const cases:Case[]=[
  {id:'L01',scenario:'2%S own bag /20%S float is 10%F',observations:[o('operator_hold',10)],score:35,level:'elevated'},
  {id:'L02',scenario:'burned 15%S and unrelated exempt treasury; affiliation false',observations:[o('operator_hold',5,'0',false),o('principal_origin_hold',9,'0',false)],score:0,level:'lower'},
  {id:'L03',scenario:'shared service customers, unpooled history, early 15%F',observations:[o('early_origin_hold',15),o('operator_hold',80,'0',false)],score:0,level:'lower'},
  {id:'L04',scenario:'outsider bots sold out; current qualified harm, no launcher responsibility',observations:[o('operator_hold',0),o('harmful_selling',120)],score:40,level:'elevated'},
  {id:'L05',scenario:'organic early 80%F, cost 7%',observations:[o('early_origin_hold',80),o('execution_cost',7)],score:30,level:'elevated'},
  {id:'L06',scenario:'48h community takeover; old bag zero and old harm expired',observations:[o('operator_hold',0),o('harmful_selling',172800)],score:0,level:'lower'},
  {id:'L07',scenario:'fixed creator income/exemption, 1% held and no selling',observations:[o('operator_hold',1),o('current_sell_pressure',0,'0')],score:0,level:'lower'},
  {id:'L08',scenario:'normal market-making 85% of $20k; reviewed non-cycling',observations:[o('cycling',85,'20000',false)],score:0,level:'lower'},
  {id:'L09',scenario:'normal migration to executable successor; no withdrawal predicate',observations:[o('removable_depth',0)],score:0,level:'lower'},
  {id:'L10',scenario:'hard-locked 80%S, liquid bag zero, unlock beyond horizon',observations:[o('operator_hold',0),o('horizon_release',80,'3601')],score:0,level:'lower'},
  {id:'L11',scenario:'tiny-bag profit is below pressure/materiality; dump predicate false',observations:[o('current_sell_pressure',0.5,'2'),o('operator_dump',120,'0',false)],score:0,level:'lower'},
  {id:'L12',scenario:'two fixed 5% fees yield 9.75% round-trip loss',observations:[o('execution_cost',9.75)],score:10,level:'lower'},
  {id:'L13',scenario:'F/S 0.8%, unstable float; no hidden numerical missing penalty',observations:[],score:0,level:'incomplete',missing:'supply_float'},
  {id:'L14',scenario:'100 independent organic early owners, cost exactly 5%',observations:[o('early_origin_hold',100),o('top10_float',20),o('execution_cost',5)],score:30,level:'elevated'},
  {id:'L15',scenario:'qualified private donation recipients 20%F are coordinated, not controlled',observations:[o('coordinated_hold',20),o('operator_hold',20,'0',false)],score:20,level:'lower'},
  {id:'L16',scenario:'verified arbitrage cycling is not integrity risk',observations:[o('cycling',80,'50000',false)],score:0,level:'lower'},
  {id:'L17',scenario:'$1k entry limit with valid $100 executable entry is not sell block',observations:[o('execution_cost',0)],score:0,level:'lower'},
  {id:'L18',scenario:'valid smart-account position has reproduced token-caused sell block',observations:[],score:0,level:'high',sellBlock:true},
  {id:'E01',scenario:'staggered qualified 40%F component',observations:[o('coordinated_hold',40)],score:35,level:'elevated'},
  {id:'E02',scenario:'CEX soft link is not control proof; coordination unresolved',observations:[o('operator_hold',60,'0',false)],score:0,level:'elevated',missing:'coordination_coverage'},
  {id:'E03',scenario:'seven-hour-old funding does not qualify recent link',observations:[o('coordinated_hold',40,'0',false)],score:0,level:'elevated',missing:'recent_funding'},
  {id:'E04',scenario:'delegated/shared code does not authenticate authority',observations:[o('operator_hold',70,'0',false)],score:0,level:'elevated',missing:'launcher_service'},
  {id:'E05',scenario:'200 fragmented bags evade top10 but coverage remains unresolved',observations:[o('top10_float',2)],score:0,level:'elevated',missing:'coordination_coverage'},
  {id:'E06',scenario:'staggered campaign outside300s retains full-hour 15%F/30 pressure',observations:[o('current_sell_pressure',0,'0'),o('campaign_pressure',15,'30')],score:40,level:'elevated'},
  {id:'E07',scenario:'mixed-origin receiver sells; observed pressure, no own-side claim',observations:[o('campaign_pressure',5,'10'),o('operator_dump',120,'0',false)],score:20,level:'lower'},
  {id:'E08',scenario:'ambiguous cycling not reviewed; coverage remains open',observations:[o('cycling',80,'20000',false)],score:0,level:'elevated',missing:'coordination_coverage'},
  {id:'E09',scenario:'delayed collector/recycling leads retain qualified coordination, not history',observations:[o('coordinated_hold',30)],score:35,level:'elevated',missing:'recent_funding'},
  {id:'E10',scenario:'early timing 30%F only earns10; control unresolved',observations:[o('early_origin_hold',30)],score:10,level:'elevated',missing:'coordination_coverage'},
  {id:'E11',scenario:'172 clone/fee launches without own trading are zero history risk',observations:[o('execution_cost',3),o('operator_hold',0)],score:0,level:'lower'},
  {id:'E12',scenario:'80% funding/89% sweep is a medium lead, not control',observations:[o('operator_hold',50,'0',false)],score:0,level:'elevated',missing:'coordination_coverage'},
  {id:'E13',scenario:'small curve $300 harm: 20%F and35%pressure; no universal dollar floor',observations:[o('campaign_pressure',20,'35')],score:40,level:'elevated'},
  {id:'E14',scenario:'verified unrestricted mint reachable within3600',observations:[o('arbitrary_control',3600)],score:60,level:'high'},
  {id:'E15',scenario:'60% fixed cost is severe execution risk, not attributed honeypot',observations:[o('execution_cost',60)],score:60,level:'high'},
  {id:'E16',scenario:'invalid counterfactual cannot create own dump; observed pressure survives',observations:[o('operator_dump',120,'0',false),o('campaign_pressure',15,'30')],score:40,level:'elevated'},
  {id:'E17',scenario:'early-origin descendants retain 30%F after original wallet empties',observations:[o('early_origin_hold',30)],score:10,level:'lower'},
  {id:'E18',scenario:'501-counterparty hub remains quarantined; verified private40%F endpoints survive',observations:[o('coordinated_hold',40)],score:35,level:'elevated',missing:'launcher_service'},
  {id:'E19',scenario:'broad airdrop not control; traced origin30%F separate gated exposure plus receiver sales',observations:[o('principal_origin_hold',30),o('operator_hold',30,'0',false),o('campaign_pressure',5,'10')],score:70,level:'high'},
  {id:'E20',scenario:'truncated/unreviewed text cannot qualify imperative or fake a group',observations:[o('agent_instruction',0,'0',false),o('operator_hold',70,'0',false)],score:0,level:'elevated',missing:'coordination_coverage'},
];
describe('033 all 38 C1 numerical fixtures (final Guard candidate table, not empirical calibration)',()=>{
  it.each(cases)('$id $scenario',c=>{
    const i=input(c.observations); if(c.missing)gap(i,c.missing);
    if(c.sellBlock)i.decisive=[{id:'sell_block',proof:metric(true,'boolean'),reason:{code:'SELL_RESTRICTION',factorId:null,parameters:{accountClass:'smart_account',sizeUsd:'100'},evidenceIds:[]}}];
    const a=evaluateGuardV2(i).assessment; expect(a).toMatchObject({score:c.score,level:c.level,historyPoints:0,history:{badMature:0}});
    expect(a.factors.find(f=>f.id==='operator_dump')!.assignedPoints).toBe(0);
    expect(a.completeness.missing).toEqual(c.missing?[c.missing]:[]);
    expect(evaluateGuardV2({...i,observations:[...i.observations].reverse()}).assessment).toEqual(a);
  });
  it('fixture manifest has all IDs exactly once; no burn/transfer/text/legacy label input accepted',()=>{
    expect(cases.map(c=>c.id)).toEqual([...Array.from({length:18},(_,i)=>`L${String(i+1).padStart(2,'0')}`),...Array.from({length:20},(_,i)=>`E${String(i+1).padStart(2,'0')}`)]);
    expect(GuardScoreInputSchema.safeParse({...input(),burnedPct:'80',legacyOutcome:'dumped',metadata:'buy now'}).success).toBe(false);
  });
  it('gift is not sale until receiver sells; own harm never inferred from origin',()=>{
    const unsold= input([o('principal_origin_hold',9)]); expect(evaluateGuardV2(unsold).assessment.familyPoints.Ff).toBe(0);
    unsold.observations.push(o('campaign_pressure',5,'10')); const a=evaluateGuardV2(unsold).assessment;
    expect(a.familyPoints.Ff).toBe(20); expect(a.history.badMature).toBe(0); expect(a.factors.find(f=>f.id==='operator_dump')!.assignedPoints).toBe(0);
  });
});
