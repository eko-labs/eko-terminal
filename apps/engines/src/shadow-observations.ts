import { appendControlProfileObservations } from './control-observations.js';
import { GuardScoreObservationSchema, SupplySnapshotV2Schema, LotMetricsSnapshotSchema, compareGuardCursors, guardKnownBy } from '@eko/shared';
import { evaluateGuardFactor } from '@eko/playbooks';
import type { GuardScoreInput, GuardScoreObservation, SupplySnapshotV2, LotMetricsSnapshot, GuardStoredRole, Metric } from '@eko/shared';

/** Existing 030/031 normalized snapshots, not legacy percentage/label projections.
 * Internal leaf references remain in captured content; scoring references its stored
 * envelope, whose dependencies preserve the actual source chain. */
export function appendSnapshotObservations(input:GuardScoreInput, content:unknown, evidenceId:`0x${string}`,
  principal:GuardStoredRole|null):void {
  appendControlProfileObservations(input, content, evidenceId);
  const supply=SupplySnapshotV2Schema.safeParse(content), lots=LotMetricsSnapshotSchema.safeParse(content);
  const snapshot=supply.success?supply.data:lots.success?lots.data:null;
  if(!snapshot)return;
  if(!guardKnownBy(snapshot.knownAt,input.availabilityCut))return;
  if(snapshot.coin!==input.coin || compareGuardCursors(snapshot.cursor,input.cursor)!==0)throw new Error('Guard snapshot context mismatch');
  const bind=<T>(m:Metric<T>):Metric<T>=>({...m,evidenceIds:[evidenceId]});
  const add=(raw:unknown)=>{const o=GuardScoreObservationSchema.parse(raw);if(input.observations.some(x=>x.id===o.id))throw new Error('Duplicate captured Guard snapshot factor');input.observations.push(o);};
  const base={secondary:null,qualification:null,participants:null,windowSec:null,controlKind:null,mechanism:null};
  if(supply.success) {
    const s:SupplySnapshotV2=supply.data, m=bind(s.supply.top10RawPct);
    input.checks.push({...s.check,evidenceIds:[evidenceId]});
    if(s.floatState==='stable' && m.value!==null)add({...base,id:'top10_float',primary:m,reason:{code:'TOP_HOLDERS',factorId:'top10_float',
      parameters:{holderCount:s.supply.rawTop10.length,rawPct:m.value,groupPct:null},evidenceIds:[evidenceId]}});
    if(s.floatState==='stable' && principal?.status==='verified' && principal.role==='launch_principal' && guardKnownBy(principal.knownAt,input.availabilityCut)) {
      const held=s.holdings.find(h=>h.address===principal.address);
      if(held?.floatPct.value!==null && held?.floatPct.value!==undefined && held.liquid.value && held.supplyPct.value!==null) {
        const q:Metric<boolean>={...held.floatPct,id:'principal',unit:'boolean',numerator:null,denominator:null,denominatorKind:null,
          knownAt:s.knownAt,status:'observed',value:true,failureCode:null,evidenceIds:[evidenceId, ...principal.evidenceIds]};
        add({...base,id:'operator_hold',primary:bind(held.floatPct),qualification:q,
          reason:{code:'GROUP_HELD',factorId:'operator_hold',parameters:{groupType:'principal',liquidUnits:held.liquid.value,
            supplyPct:held.supplyPct.value,floatPct:held.floatPct.value,linkClass:'control'},evidenceIds:[evidenceId,...principal.evidenceIds]}});
      }
    }
  }
  if(lots.success) {
    const s:LotMetricsSnapshot=lots.data;
    // Only complete full trailing windows enter Ff. Sale harm and control are NOT
    // inferred from origin, disposition, price decline, or a legacy dump label.
    const campaigns=s.campaigns.filter(c=>c.through.blockNumber===input.cursor.blockNumber &&
      c.through.blockHash===input.cursor.blockHash && c.soldFloatPct.value!==null && c.pressure.value!==null &&
      c.soldFloatPct.coverage.complete && c.pressure.coverage.complete);
    const choices=campaigns.map(c=>GuardScoreObservationSchema.parse({...base,id:'campaign_pressure',primary:bind(c.soldFloatPct),secondary:bind(c.pressure),windowSec:c.windowSec,
      mechanism:{id:c.id,key:'episode_action',proven:true},reason:{code:'SELL_PRESSURE',factorId:'campaign_pressure',parameters:{sellerClass:c.attribution,
        soldPct:c.soldFloatPct.value,pressurePct:c.pressure.value,windowSec:c.windowSec,attributionStatus:c.attribution},evidenceIds:[evidenceId]}}))
      .filter(o=>[o.primary,o.secondary].every(m=>m && guardKnownBy(m.knownAt,input.availabilityCut) && compareGuardCursors(m.cursor,input.cursor)===0 &&
        m.fromSec===(BigInt(input.cursor.timestampSec)-BigInt(o.windowSec!)).toString()));
    // Same exact BigInt comparisons as the evaluator, never floating-point boundaries.
    choices.sort((a,b)=>evaluateGuardFactor('campaign_pressure',b).eligiblePoints-evaluateGuardFactor('campaign_pressure',a).eligiblePoints ||
      a.windowSec!-b.windowSec! || a.mechanism!.id.localeCompare(b.mechanism!.id));
    if(choices[0])add(choices[0]);
    const origin=s.principalOriginOverhang;
    if(origin.floatPct.value!==null && origin.supplyPct.value!==null && origin.liquid.value)add({...base,id:'principal_origin_hold',primary:bind(origin.floatPct),
      reason:{code:'GROUP_HELD',factorId:'principal_origin_hold',parameters:{groupType:'origin',liquidUnits:origin.liquid.value,supplyPct:origin.supplyPct.value,
        floatPct:origin.floatPct.value,linkClass:'origin'},evidenceIds:[evidenceId]}}); // Separate gift/distribution qualification remains unknown.
  }
}
