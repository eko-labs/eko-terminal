import { describe,it,expect } from 'vitest';
import { SupplySnapshotV2Schema,LotMetricsSnapshotSchema } from '@eko/shared';
import { evaluateGuardV2 } from '@eko/playbooks';
import { guardSamples } from '../../../packages/shared/test/fixtures/contracts/guard-v2.js';
import { input,metric,hash,address,NOW } from '../../../packages/playbooks/test/scoring-fixtures.js';
import { appendSnapshotObservations } from '../src/shadow-observations.js';

const supply=()=>{
  const i=input(); const s=SupplySnapshotV2Schema.parse(guardSamples.SupplySnapshotV2);
  s.coin=i.coin;s.cursor=i.cursor;s.knownAt=i.availabilityCut;s.floatState='stable';s.issues=[];
  s.check={...i.checks.find(c=>c.id==='supply_float')!};
  s.supply.top10RawPct={...metric('60'),id:'topAddress10'}; s.supply.rawTop10=[];
  return s;
};
describe('033 existing-data normalization bridge, no legacy labels or inferred sale harm',()=>{
  it('measured stable float/top10 yields O35, same stored envelope is the scoring evidence',()=>{
    const i=input();i.checks=[];appendSnapshotObservations(i,supply(),hash(90),null);
    expect(evaluateGuardV2(i).assessment).toMatchObject({baseScore:35,familyPoints:{O:35},level:'incomplete'});
    expect(i.observations[0].primary!.evidenceIds).toEqual([hash(90)]);expect(i.checks[0].id).toBe('supply_float');
  });
  it('partial/unknown snapshot supplies a gap without invented zero or guessed ownership',()=>{
    const s=supply();s.supply.top10RawPct={...s.supply.top10RawPct,status:'unknown',value:null,numerator:null,denominator:null,denominatorKind:null,failureCode:'missing',coverage:{...s.check.coverage,complete:false,gaps:['missing']}};
    s.floatState='unknown';s.check={...s.check,status:'missing',failureCode:'missing',coverage:{...s.check.coverage,complete:false,gaps:['missing']}};
    const i=input();i.checks=[];appendSnapshotObservations(i,s,hash(90),null);
    expect(i.observations).toEqual([]);expect(evaluateGuardV2(i).assessment.baseScore).toBe(0);
  });
  it('captured authenticated principal bag uses liquid F and never substitutes exemption/factory role',()=>{
    const s=supply(), raw={asset:address(1),decimals:0,raw:'10'};
    s.supply.top10RawPct={...metric('0'),id:'topAddress10'};
    s.holdings=[{address:address(2),bucket:'external',raw:{...metric('0','decimal'),unit:'raw',value:raw} as any,
      liquid:{...metric('0','decimal'),unit:'raw',value:raw} as any,locked:{...metric('0','decimal'),unit:'raw',value:{...raw,raw:'0'}} as any,
      supplyPct:metric('1'),floatPct:metric('10')}];
    const role={chainId:4663,coin:address(1),manifestId:hash(1),sourceItemId:'principal',sourceRevision:hash(2),cursor:s.cursor,knownAt:s.knownAt,
      acquiredAt:'2026-10-02T00:00:00.000Z',methodVersion:'2.0.0',dependencyIds:[],role:'launch_principal' as const,address:address(2),status:'verified' as const,evidenceIds:[hash(99)],payloadHash:hash(3),objectRef:hash(3)};
    const i=input();i.checks=[];appendSnapshotObservations(i,s,hash(90),role);expect(evaluateGuardV2(i).assessment.familyPoints.O).toBe(35);
    const other=input();other.checks=[];appendSnapshotObservations(other,s,hash(90),{...role,role:'exempt'});expect(evaluateGuardV2(other).assessment.familyPoints.O).toBe(0);
  });
  it('complete lot campaigns survive sold-out holders without becoming own-side dumps/history',()=>{
    const i=input(), s=LotMetricsSnapshotSchema.parse(guardSamples.LotMetricsSnapshot), sample=(guardSamples.CampaignMeasurement as any);
    s.coin=i.coin;s.cursor=i.cursor;s.knownAt=i.availabilityCut;
    const m=(value:string,window=3600)=>({...metric(value),fromSec:String(NOW-window)});
    s.campaigns=[{...sample,id:hash(81),sideId:hash(82),from:{...i.cursor,timestampSec:String(NOW-3600)},through:i.cursor,
      windowSec:3600,attribution:'non_operator',coverage:i.checks[0].coverage,evidenceIds:[],soldFloatPct:m('15'),pressure:m('30')}];
    appendSnapshotObservations(i,s,hash(90),null);const a=evaluateGuardV2(i).assessment;
    expect(a).toMatchObject({familyPoints:{Ff:40,O:0},history:{badMature:0},historyPoints:0});
    expect(a.factors.find(f=>f.id==='operator_dump')!.state).toBe('unknown');
    const future=input();s.knownAt={...s.knownAt,acquisitionSequence:'2'};appendSnapshotObservations(future,s,hash(90),null);expect(future.observations).toEqual([]);
  });
  it('origin inventory retains its independent gift gate and cannot establish a sale',()=>{
    const i=input(),s=LotMetricsSnapshotSchema.parse(guardSamples.LotMetricsSnapshot),raw={asset:i.coin,decimals:0,raw:'30'};
    s.coin=i.coin;s.cursor=i.cursor;s.knownAt=i.availabilityCut;
    s.principalOriginOverhang={...s.principalOriginOverhang,floatPct:metric('30'),supplyPct:metric('3'),liquid:{...metric('0','decimal'),unit:'raw',value:raw} as any};
    appendSnapshotObservations(i,s,hash(90),null);const a=evaluateGuardV2(i).assessment;
    expect(a.baseScore).toBe(0);expect(a.factors.find(f=>f.id==='principal_origin_hold')!.state).toBe('unknown');expect(a.familyPoints.Ff).toBe(0);
  });
});
