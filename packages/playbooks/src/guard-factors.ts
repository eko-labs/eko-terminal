import { GuardFactorSchema } from '@eko/shared';
import type { FactorId, GuardFactor, GuardScoreObservation, Metric, CheckId } from '@eko/shared';
import { CONFIG_GUARD_V2 } from '../config/guard-v2.js';

export const factorCheck = (id: FactorId): CheckId => id === 'execution_cost' || id === 'thin_depth' ? 'reference_exit' :
  ['mutable_control', 'arbitrary_control', 'removable_depth', 'exercised_control'].includes(id) ? 'controls_hooks' : 'coordination_coverage';
type Fraction = { n: bigint; d: bigint };
const fraction = (s: string): Fraction => { const [whole, tail = ''] = s.split('.'); return { n: BigInt(whole + tail), d: 10n ** BigInt(tail.length) }; };
const compare = (a: Fraction, b: Fraction) => a.n * b.d < b.n * a.d ? -1 : a.n * b.d > b.n * a.d ? 1 : 0;
export const compareGuardDecimals = (a:string,b:string) => compare(fraction(a),fraction(b));
const plus = (a: Fraction, b: Fraction) => ({ n: a.n * b.d + b.n * a.d, d: a.d * b.d });
const rational = (v: { numerator: string; denominator: string }) => ({ n: BigInt(v.numerator), d: BigInt(v.denominator) });
function value(m: Metric<string>): Fraction {
  if (m.unit === 'pct' && m.numerator !== null && m.denominator !== null) {
    const raw = (n: string | { raw: string }) => fraction(typeof n === 'string' ? n : n.raw);
    const n = raw(m.numerator), d = raw(m.denominator);
    return { n: n.n * d.d * 100n, d: n.d * d.n };
  }
  return fraction(m.value!);
}
/** Bounds can establish only their directed inequality; uncertain numerical comparisons stay unknown. */
function test(m: Metric<string> | null, cut: number, operator: '>=' | '>' | '<' | '<='): boolean | null {
  if (!m || m.status === 'unknown' || m.status === 'not_applicable') return null;
  if (!m.coverage.complete && m.status === 'observed') return null;
  const v = value(m), threshold = fraction(String(cut));
  if (v.d <= 0n) return null;
    const low = m.errorBounds ? plus(v, rational(m.errorBounds.lower)) : v;
  const high = m.errorBounds ? plus(v, rational(m.errorBounds.upper)) : v;
  const match = (v: Fraction) => { const c = compare(v, threshold); return operator === '>=' ? c >= 0 : operator === '>' ? c > 0 : operator === '<' ? c < 0 : c <= 0; };
  if(m.status==='lower_bound')return ['>=','>'].includes(operator)?match(low)?true:null:match(low)?null:false;
  if(m.status==='upper_bound')return ['<','<='].includes(operator)?match(high)?true:null:match(high)?null:false;
  return match(low) === match(high) ? match(low) : null;
}
const qualification = (o: GuardScoreObservation) => o.qualification?.status === 'observed' && o.qualification.coverage.complete ? o.qualification.value : null;
export function evaluateGuardFactor(id: FactorId, observation: GuardScoreObservation | undefined): GuardFactor {
  const entry = CONFIG_GUARD_V2.factors.find(f => f.id === id)!;
  const o = observation;
  let points: number | null = null, na = o?.primary?.status === 'not_applicable';
  const tier = (cuts: readonly number[], awards: readonly number[], op: '>=' | '<' = '>=') => {
    let result = 0;
    for (let i = 0; i < cuts.length; i++) { const match = test(o!.primary, cuts[i], op); if (match === null) return result || null; if (match) result = awards[i]; }
    return result;
  };
  if (o && !na) {
    const qualified = qualification(o);
    const gated = !['top10_float', 'early_origin_hold', 'current_sell_pressure', 'campaign_pressure', 'mutable_control'].includes(id);
    if (gated && qualified !== true) points = ['execution_cost','thin_depth'].includes(id) ? null : qualified === false ? 0 : null;
    else if (id === 'agent_instruction') points = qualified ? 10 : 0;
    else if (id === 'mutable_control') {
      const soon = test(o.secondary, 3600, '<=');
      if (qualified === false || soon === false) points = 0;
      else if (qualified === true && soon === true && o.controlKind) {
        const aboveLow=test(o.primary,5,'>'), aboveHigh=test(o.primary,o.controlKind==='tax'?30:20,'>');
        points=aboveLow===true ? aboveHigh===true?35:20 : test(o.primary,5,'<=')===true?0:null;
      }
    } else if (id === 'arbitrary_control') points = test(o.primary, 3600, '<=') === true ? 60 : test(o.primary, 3600, '<=') === false ? 0 : null;
    else if (id === 'harmful_selling' || id === 'operator_dump') points = test(o.primary, 3600, '<=') === true ? id === 'operator_dump' ? 60 : 40 : test(o.primary, 3600, '<=') === false ? 0 : null;
    else if (id === 'cycling') {
      const volume = test(o.secondary, 10000, '>='); points = volume === false ? 0 : volume === true && o.windowSec === 3600 ? tier([50, 80], [5, 10]) : null;
    } else if (id === 'current_sell_pressure' || id === 'campaign_pressure') {
      if (o.windowSec !== (id === 'current_sell_pressure' ? 300 : 3600) && !(id === 'campaign_pressure' && o.windowSec === 86400)) points = null;
      else {
        points = 0;
        for (const [sold, pressure, award] of [[5, 10, 20], [15, 30, 40]]) {
          const a = test(o.primary, sold, '>='), b = test(o.secondary, pressure, '>=');
          if ((a === null || b === null) && a !== false && b !== false) { points = points || null; break; } if (a && b) points = award;
        }
      }
    } else if (id === 'coordinated_hold' || id === 'coordinated_union') points = o.participants === null ? null : o.participants < 3 ? 0 : tier([15, 30, 50], [20, 35, 50]);
    else if (id === 'horizon_release') {
      const soon = test(o.secondary, 3600, '<='); points = soon === false ? 0 : soon === true ? tier([5, 10, 20], [20, 35, 50]) : null;
    } else {
      const cuts = entry.cuts as readonly number[], awards = entry.points as readonly number[];
      points = tier(cuts, awards, id === 'thin_depth' ? '<' : '>=');
    }
  }
  const reason = o?.reason ?? { code: 'INCOMPLETE' as const, factorId: id,
    parameters: { checkNames: [factorCheck(id)], coverageCode: 'missing' as const, retryCode: 'coverage_available' as const }, evidenceIds: [] };
  return GuardFactorSchema.parse({ id, family: entry.family, mechanismId: o?.mechanism?.proven ? o.mechanism.id : null,
    state: na ? 'not_applicable' : points === null ? 'unknown' : points > 0 ? 'matched' : 'not_matched',
    eligiblePoints: points ?? 0, assignedPoints: points ?? 0, suppressionCode: null,
    metricIds: [...new Set([o?.primary?.id, o?.secondary?.id, o?.qualification?.id].filter((x): x is NonNullable<typeof x> => x !== undefined))],
    evidenceIds: [...new Set([...(o?.primary?.evidenceIds ?? []), ...(o?.secondary?.evidenceIds ?? []), ...(o?.qualification?.evidenceIds ?? []), ...reason.evidenceIds])].sort(),
    template: reason.code, parameters: reason.parameters, calibration: 'shadow' });
}
