import { describe, expect, it } from 'vitest';
import { GuardScoreResultSchema, GUARD_FACTOR_IDS } from '@eko/shared';
import type { FactorId } from '@eko/shared';
import { evaluateGuardV2, CONFIG_GUARD_V2, GUARD_PARAMETERS_HASH, RULES_VERSION } from '../src/index.js';
import { input, observation as o, metric, gap, hash } from './scoring-fixtures.js';
import { fixture, clone } from './history-fixtures.js';

const score = (...observations: ReturnType<typeof o>[]) => evaluateGuardV2(input(observations)).assessment;
const points = (id: FactorId, v: string | number, secondary = '0', qualified = true) => score(o(id, v, secondary, qualified)).factors.find(f => f.id === id)!.eligiblePoints;
const boundaries: [FactorId, number[], number[]][] = [
  ['execution_cost', [5,10,25,50], [10,20,40,60]], ['operator_hold', [5,10,20], [20,35,50]],
  ['coordinated_hold', [15,30,50], [20,35,50]], ['coordinated_union', [15,30,50], [20,35,50]],
  ['top10_float', [40,60,80], [20,35,50]], ['launch_linked_hold', [10,20,30], [20,35,50]],
  ['principal_origin_hold', [10,20,30], [20,35,50]], ['early_origin_hold', [20,50], [10,20]],
  ['persistent_sniper_hold', [30], [35]], ['authenticated_dominance', [70], [60]],
  ['horizon_release', [5,10,20], [20,35,50]], ['removable_depth', [50], [35]], ['exercised_control', [25], [40]],
];
describe('033 exact factor table', () => {
  for (const [id, cuts, awards] of boundaries) cuts.forEach((cut, j) => {
    it(`${id} ${cut}: immediately below / equality / above`, () => {
      expect(points(id, cut - 0.001)).toBe(j ? awards[j-1] : 0);
      expect(points(id, cut)).toBe(awards[j]); expect(points(id, cut + 0.001)).toBe(awards[j]);
    });
  });
  it.each([[10000,0,10],[2000,10,20],[500,20,40]])('depth strict %s', (cut, at, below) => {
    expect(points('thin_depth',cut)).toBe(at); expect(points('thin_depth',cut - 0.001)).toBe(below);
  });
  it.each(['current_sell_pressure','campaign_pressure'] as const)('%s requires BOTH boundaries', id => {
    for (const [sold, pressure, award] of [[5,10,20],[15,30,40]]) {
      expect(points(id,sold,String(pressure))).toBe(award);
      expect(points(id,sold - 0.001,String(pressure))).toBe(award === 40 ? 20 : 0);
      expect(points(id,sold,String(pressure - 0.001))).toBe(award === 40 ? 20 : 0);
    }
    const day = o(id,15,'30'); if (id === 'campaign_pressure') {
      day.windowSec = 86400; day.primary!.fromSec = day.secondary!.fromSec = String(Number(day.primary!.throughSec)-86400);
      expect(score(day).familyPoints.Ff).toBe(40);
    }
  });
  it.each(['harmful_selling','operator_dump','arbitrary_control'] as const)('%s inclusive recent/reachable horizon and qualified proof', id => {
    expect(points(id,3600)).toBe(id === 'harmful_selling' ? 40 : 60); expect(points(id,3601)).toBe(0);
    expect(points(id,1,'0',false)).toBe(0);
  });
  it('separate bounded tax/mint caps and horizon denominator', () => {
    for (const kind of ['tax','mint'] as const) for (const [v, expected] of [[5,0],[5.001,20],[kind === 'tax' ? 30 : 20,20],[kind === 'tax' ? 30.001 : 20.001,35]]) {
      const obs=o('mutable_control',v); obs.controlKind=kind; obs.primary!.denominatorKind=kind==='mint'?'S':'other'; expect(score(obs).familyPoints.C).toBe(expected);
    }
    expect(points('mutable_control',80,'3601')).toBe(0); expect(points('horizon_release',80,'3601')).toBe(0);
    const release=o('horizon_release',20); release.primary!.denominatorKind='F'; expect(()=>score(release)).toThrow('denominator');
  });
  it('reviewed cycling volume/window and text predicate; MM/arbitrage negatives', () => {
    expect(points('cycling',50,'10000')).toBe(5); expect(points('cycling',80,'10000')).toBe(10);
    expect(points('cycling',80,'9999')).toBe(0); expect(points('cycling',80,'20000',false)).toBe(0);
    expect(points('agent_instruction',0)).toBe(10); expect(points('agent_instruction',0,'0',false)).toBe(0);
    expect(points('principal_origin_hold',80,'0',false)).toBe(0);
    const pair=o('coordinated_hold',80); pair.participants=2; expect(score(pair).familyPoints.O).toBe(0);
    expect(GUARD_FACTOR_IDS.every(id=>score().factors.some(f=>f.id===id))).toBe(true);
  });
  it('invalid execution qualification, irrelevant size and role/units do not create High',()=>{
    expect(score(o('execution_cost',60,'0',false))).toMatchObject({baseScore:0,decisiveIds:[]});
    const large=o('execution_cost',60); if(large.reason.code==='EXIT_COST')large.reason.parameters.sizeUsd=10000; expect(()=>score(large)).toThrow('reference size');
    const negative=o('execution_cost',-1); expect(score(negative).familyPoints.E).toBe(0);
    const top=o('top10_float',40); if(top.reason.code==='TOP_HOLDERS')top.reason.parameters.groupPct='80'; expect(()=>score(top)).toThrow('maximum');
  });
  it('exact raw ratios beyond Number precision govern thresholds', () => {
    const obs=o('operator_hold', '5'); obs.primary!.numerator='499999999999999999999999999999999999'; obs.primary!.denominator='10000000000000000000000000000000000000';
    expect(score(obs).familyPoints.O).toBe(0); obs.primary!.numerator='500000000000000000000000000000000000'; expect(score(obs).familyPoints.O).toBe(20);
  });
  it('bounds and error intervals retain proved lower points without invented precision', () => {
    const obs=o('operator_hold',12); obs.primary!.status='lower_bound'; expect(score(obs).familyPoints.O).toBe(35);
    obs.primary!.status='upper_bound'; expect(score(obs).familyPoints.O).toBe(0); expect(score(obs).factors.find(f=>f.id===obs.id)!.state).toBe('unknown');
    const cost=o('execution_cost',5);
    cost.primary!.errorBounds={lower:{numerator:'-1',denominator:'1000'},upper:{numerator:'1',denominator:'1000'}};
    expect(score(cost).familyPoints.E).toBe(0); expect(score(cost).factors.find(f=>f.id===cost.id)!.state).toBe('unknown');
  });
});

describe('033 family allocation and provenance', () => {
  it('default parameter commitment uses the existing frozen registry hash',()=>{
    expect(score().parametersHash).toBe(GUARD_PARAMETERS_HASH);
  });
  it('M E40/Ff40 plus independent N E20 maximizes justified total to 60', () => {
    const m=o('execution_cost',25), f=o('campaign_pressure',15,'30'), n=o('thin_depth',1500);
    m.mechanism=f.mechanism={id:hash(7),key:'episode_action',proven:true}; n.mechanism={id:hash(8),key:'episode_action',proven:true};
    const registry={...CONFIG_GUARD_V2,compatibility:{...CONFIG_GUARD_V2.compatibility,prohibitedSameMechanism:[{key:'episode_action',factors:['execution_cost','campaign_pressure']}]}};
    const r=evaluateGuardV2(input([m,f,n]),registry);
    expect(r.assessment).toMatchObject({baseScore:60,familyPoints:{E:20,Ff:40},level:'high'});
    expect(r.assessment.factors.find(f=>f.id==='execution_cost')).toMatchObject({eligiblePoints:40,assignedPoints:0,suppressionCode:'duplicate_mechanism'});
    expect(r.allocation.selectedIds).toEqual(['thin_depth','campaign_pressure']);
    expect(evaluateGuardV2(input([n,f,m]),registry)).toEqual(r);
    expect(evaluateGuardV2(input([m,f,n])).assessment.baseScore).toBe(80); // default matrix deliberately leaves cost/pressure distinct
    f.mechanism.proven=false; expect(evaluateGuardV2(input([m,f,n]),registry).assessment.baseScore).toBe(80);
  });
  it('config duplicates use maximum assignment; deterministic E-before-C tie; family maxima retain all details', () => {
    const cost=o('execution_cost',25), hook=o('exercised_control',25), mint=o('mutable_control',40);
    for (const obs of [cost,hook,mint]) obs.mechanism={id:hash(9),key:'implementation_capability_effective_config',proven:true};
    const r=score(hook,mint,cost); expect(r.baseScore).toBe(40); expect(r.familyPoints.E).toBe(40); expect(r.familyPoints.C).toBe(0);
    expect(r.factors.find(f=>f.id==='exercised_control')!.suppressionCode).toBe('duplicate_mechanism');
    const same=score(o('operator_hold',20),o('top10_float',80)); expect(same.baseScore).toBe(50);
    expect(same.factors.filter(f=>f.family==='O' && f.eligiblePoints===50).map(f=>f.assignedPoints)).toEqual([50,0]);
    expect(same.reasons.map(r=>r.factorId)).toContain('top10_float');
  });
  it('unqualified leads and qualified coordination cannot create operator/control reason claims',()=>{
    const candidate=o('operator_hold',70,'0',false); const a=score(candidate);
    expect(a.factors.find(f=>f.id==='operator_hold')).toMatchObject({parameters:{groupType:'insider_candidate',linkClass:'unknown'},state:'not_matched'});
    expect(a.reasons.some(r=>r.factorId==='operator_hold')).toBe(false);
    for(const rejected of [o('operator_dump',120,'0',false),o('operator_dump',3601),o('agent_instruction',0,'0',false),o('cycling',85,'20000',false)])
      expect(score(rejected).reasons.some(r=>r.factorId===rejected.id)).toBe(false);
    if(candidate.reason.code==='GROUP_HELD')candidate.reason.parameters.groupType='operator'; expect(()=>score(candidate)).toThrow('Unqualified');
    const coordinated=score(o('coordinated_hold',40)); expect(coordinated.reasons.find(r=>r.factorId==='coordinated_hold')).toMatchObject({parameters:{groupType:'coordination',linkClass:'coordination'}});
  });
  it('full cursor and acquisition sequence exclude future facts; stale metrics fail; input is immutable', () => {
    const i=input([o('operator_hold',70)]), before=JSON.stringify(i); evaluateGuardV2(i); expect(JSON.stringify(i)).toBe(before);
    i.observations[0].primary!.knownAt.acquisitionSequence='2'; expect(evaluateGuardV2(i).assessment.baseScore).toBe(0);
    i.observations[0].primary!.knownAt.acquisitionSequence='1'; i.observations[0].primary!.throughSec='3999999'; expect(()=>evaluateGuardV2(i)).toThrow('Stale');
    const forged=o('operator_hold',70); forged.reason={...forged.reason, parameters:{...forged.reason.parameters,floatPct:'0'}} as typeof forged.reason; expect(()=>score(forged)).toThrow('reason value');
  });
  it('candidate never activates the unreleased registry; active uses released entries only', () => {
    const i=input([o('execution_cost',60),o('operator_hold',70)]); i.mode='active'; expect(()=>evaluateGuardV2(i)).toThrow('Unreleased');
    const registry={...CONFIG_GUARD_V2,mode:'active',checks:CONFIG_GUARD_V2.checks.map(c=>({...c,status:'released',acceptanceArtifact:'synthetic-artifact'})),
      factors:CONFIG_GUARD_V2.factors.map(f=>({...f,status:f.id==='operator_hold'?'released':'shadow',acceptanceArtifact:f.id==='operator_hold'?'synthetic-artifact':null}))};
    const r=evaluateGuardV2(i,registry).assessment; expect(r.baseScore).toBe(50); expect(r.familyPoints.E).toBe(0); expect(r.decisiveIds).toEqual([]);
    expect(r.factors.find(f=>f.id==='execution_cost')).toMatchObject({eligiblePoints:60,assignedPoints:0,suppressionCode:'unreleased',calibration:'shadow'});
    i.mode='candidate'; expect(evaluateGuardV2(i).assessment.mode).toBe('candidate'); expect(CONFIG_GUARD_V2.mode).toBe('shadow'); expect(RULES_VERSION).toBe('1.0.2');
  });
});

describe('033 independent tier overlay, dispatch and six required archetypes', () => {
  it.each([['clone farm', [o('top10_float',45),o('execution_cost',3),o('thin_depth',20000)],20,'lower'],
    ['shared tool',[o('coordinated_hold',32),o('thin_depth',1500)],55,'elevated'],
    ['outsider bots',[o('persistent_sniper_hold',32),o('current_sell_pressure',15,'35')],75,'high'],
    ['tiny profit',[o('current_sell_pressure',0.5,'2')],0,'lower'],
    ['verified ring',[o('coordinated_hold',55),o('thin_depth',1800)],70,'high'],
    ['organic opening',[o('early_origin_hold',100),o('top10_float',20),o('execution_cost',5)],30,'elevated']] as const)('%s', (_,obs,total,level)=>{
      const a=score(...obs); expect(a).toMatchObject({score:total,level,historyPoints:0,history:{badMature:0}}); expect(GuardScoreResultSchema.safeParse(evaluateGuardV2(input([...obs]))).success).toBe(true);
    });
  it('current qualified own dump plus separate held bag and complete recent 4/5 history caps at 100',()=>{
    const i=input([o('operator_dump',120),o('operator_hold',12)]); i.historySource=fixture(5,4).source; i.shadowBooster=true;
    expect(evaluateGuardV2(i).assessment).toMatchObject({baseScore:95,historyPoints:15,score:100,level:'high'});
    i.observations=[]; expect(evaluateGuardV2(i).assessment).toMatchObject({baseScore:0,historyPoints:0,score:0});
  });
  it.each(['reference_exit','effective_fees','controls_hooks','supply_float','recent_funding','coordination_coverage','launcher_service','operator_history'] as const)('gap %s adds zero and never hides High', id=>{
    const i=input([o('top10_float',45)]); if(id==='operator_history')i.historySource=null;else gap(i,id);
    const a=evaluateGuardV2(i).assessment; expect(a.score).toBe(20); expect(a.level).toBe(['reference_exit','effective_fees','controls_hooks','supply_float'].includes(id)?'incomplete':'elevated'); expect(a.completeness.missing).toContain(id);
    i.observations=[o('arbitrary_control',1)]; expect(evaluateGuardV2(i).assessment.level).toBe('high');
  });
  it('all gaps remain named; missing is not zero evidence; severe cost is not a honeypot',()=>{
    const i=input(); i.checks=[]; i.historySource=null; const a=evaluateGuardV2(i).assessment;
    expect(a).toMatchObject({baseScore:0,level:'incomplete',observedLevel:'lower',scoreIsLowerBound:true}); expect(a.completeness.missing).toHaveLength(8); expect(a.factors.every(f=>f.state==='unknown')).toBe(true);
    i.observations=[o('execution_cost',60)]; const severe=evaluateGuardV2(i).assessment; expect(severe.level).toBe('high'); expect(severe.decisiveIds).toEqual(['severe_cost']); expect(severe.reasons[0].code).toBe('EXIT_COST');
  });
  it.each(['sell_block','confiscatory_return','no_sell_capacity','liquidity_withdrawn'] as const)('only complete observed qualified %s proof dispatches',id=>{
    const i=input(); i.checks=[]; i.decisive=[{id,proof:metric(true,'boolean'),reason:id==='liquidity_withdrawn'?{code:'CONTROL',factorId:null,parameters:{authorityRole:'operator',capability:'liquidity_remove',codeHash:hash(1),boundCode:'unrestricted',executionTime:'0'},evidenceIds:[]}:{code:'SELL_RESTRICTION',factorId:null,parameters:{accountClass:'smart_account',sizeUsd:'100'},evidenceIds:[]}}];
    expect(evaluateGuardV2(i).assessment).toMatchObject({level:'high',observedLevel:'high',score:0});
    i.decisive[0].proof.value=false; expect(evaluateGuardV2(i).assessment.level).toBe('incomplete');
    i.decisive[0].proof.value=true; i.decisive[0].proof.coverage.complete=false; i.decisive[0].proof.coverage.gaps=['failed']; expect(evaluateGuardV2(i).assessment.decisiveIds).toEqual([]);
  });
});
