// Synthetic normalized facts. Qualification represents independently reviewed adapter proof;
// these fixtures are neither measured accuracy nor factor release artifacts.
import { GuardScoreInputSchema, GuardScoreObservationSchema, GUARD_CHECK_IDS, GUARD_CHECK_TIERS } from '@eko/shared';
import type { FactorId, GuardScoreInput, GuardScoreObservation, GuardReasonV2, Metric } from '@eko/shared';
import { CONFIG_GUARD_V2 } from '../src/index.js';
import { fixture, at, known, coverage, hash, address, NOW } from './history-fixtures.js';
export { hash, address, NOW };
export function metric(value: string | boolean, unit = 'pct', denominatorKind = 'F'): Metric<any> {
  return { id: typeof value === 'boolean' ? 'powers' : 'floatPct', cursor: at(NOW), knownAt: known(NOW), unit: unit as any,
    numerator: unit === 'pct' ? String(value) : null, denominator: unit === 'pct' ? '100' : null, denominatorKind: unit === 'pct' ? denominatorKind as any : null,
    fromSec: null, throughSec: String(NOW), coverage: coverage(NOW, NOW), methodVersion: '2.0.0', evidenceIds: [], failureCode: null, status: 'observed', value };
}
export function observation(id: FactorId, value: number | string, secondary = '0', qualified = true): GuardScoreObservation {
  const v = String(value), entry = CONFIG_GUARD_V2.factors.find(f => f.id === id)!;
  let reason: unknown;
  const coordinated=['coordinated_hold','coordinated_union'].includes(id), origin=['principal_origin_hold'].includes(id), candidate=id==='launch_linked_hold', persistent=id==='persistent_sniper_hold';
  const groupType=origin?'origin':!qualified||candidate?'insider_candidate':coordinated?'coordination':persistent?'persistent':'operator';
  const linkClass=origin?'origin':!qualified?'unknown':coordinated?'coordination':candidate||persistent?'candidate':'control';
  const parameters = entry.family === 'O' ? { groupType, liquidUnits: { asset: address(1), decimals: 0, raw: '1' }, supplyPct: '1', floatPct: v, linkClass } : {};
  switch (id) {
    case 'execution_cost': reason = { code: 'EXIT_COST', parameters: { sizeUsd: 100, returnedUsd: null, snapshotId: 'fixture', costPct: v, gasUsd: null, breakdownStatus: 'unavailable' } }; break;
    case 'thin_depth': reason = { code: 'DEPTH', parameters: { buyDepthUsd: null, sellDepthUsd: v, routeId: 'fixture' } }; break;
    case 'top10_float': reason = { code: 'TOP_HOLDERS', parameters: { holderCount: 10, rawPct: v, groupPct: null } }; break;
    case 'early_origin_hold': reason = { code: 'EARLY_BUYERS', parameters: { grossBoughtPct: v, heldPct: v } }; break;
    case 'current_sell_pressure': case 'campaign_pressure': case 'harmful_selling': reason = { code: 'SELL_PRESSURE', parameters: { sellerClass: 'non_operator', soldPct: id === 'harmful_selling' ? '15' : v, windowSec: id === 'current_sell_pressure' ? 300 : 3600, pressurePct: secondary, attributionStatus: 'non_operator' } }; break;
    case 'operator_dump': reason = { code: 'ATTRIBUTED_DUMP', parameters: { soldPct: '20', denominatorName: 'opening_float', netQuote: { asset: address(0), decimals: 18, amount: '1' }, lossPct: '50', interventionType: 'sell_only', contributionPp: '30' } }; break;
    case 'mutable_control': case 'arbitrary_control': case 'removable_depth': case 'exercised_control': reason = { code: 'CONTROL', parameters: { authorityRole: 'controller', capability: 'mint', codeHash: hash(1), boundCode: 'bounded', executionTime: '0' } }; break;
    case 'cycling': reason = { code: 'CYCLING', parameters: { sharePct: v, volumeUsd: secondary, classificationStatus: 'reviewed' } }; break;
    case 'agent_instruction': reason = { code: 'TEXT_INSTRUCTION', parameters: { actionEnum: 'bypass_checks' } }; break;
    default: reason = { code: 'GROUP_HELD', parameters };
  }
  const seconds = ['arbitrary_control', 'harmful_selling', 'operator_dump'].includes(id);
  const primary = metric(v, seconds ? 'seconds' : id === 'thin_depth' ? 'usd' : 'pct', id === 'horizon_release' ? 'other' : id === 'mutable_control' ? 'S' : 'F');
  const s = ['current_sell_pressure', 'campaign_pressure', 'harmful_selling'].includes(id) ? metric(secondary) : id === 'cycling' ? metric(secondary, 'usd') : ['mutable_control', 'horizon_release'].includes(id) ? metric(secondary, 'seconds') : null;
  const windowSec = id === 'current_sell_pressure' ? 300 : ['campaign_pressure', 'cycling'].includes(id) ? 3600 : null;
  if (windowSec) for (const m of [primary, s]) if (m) m.fromSec = String(NOW - windowSec);
  // Harmful-selling parameters describe the episode, not the closure age.
  if (id === 'harmful_selling') s && (s.unit = 'pct');
  return GuardScoreObservationSchema.parse({ id, primary, secondary: s, qualification: metric(qualified, 'boolean'), participants: 3, windowSec,
    controlKind: 'mint', reason: { ...(reason as object), factorId: id, evidenceIds: [] }, mechanism: null });
}
export function input(observations: GuardScoreObservation[] = []): GuardScoreInput {
  return GuardScoreInputSchema.parse({ coin: address(1), cursor: at(NOW), availabilityCut: known(NOW), mode: 'shadow', observations,
    checks: GUARD_CHECK_IDS.map(id => ({ id, tier: GUARD_CHECK_TIERS[id], status: 'complete', coverage: coverage(NOW, NOW), evidenceIds: [], failureCode: null })),
    decisive: [], informational: [], historySource: fixture(0).source, shadowBooster: false,
    codeHash: hash(1), profileHash: hash(2), serviceRegistryHash: hash(3), calibrationManifestHash: hash(4) });
}
export function gap(i: GuardScoreInput, id: GuardScoreInput['checks'][number]['id']) {
  const c = i.checks.find(c => c.id === id)!; c.status = 'missing'; c.failureCode = 'missing'; c.coverage.complete = false; c.coverage.gaps = ['missing'];
}
