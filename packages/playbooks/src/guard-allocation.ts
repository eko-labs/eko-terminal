import type { GuardFactor } from '@eko/shared';
import { CONFIG_GUARD_V2 } from '../config/guard-v2.js';

export const GUARD_FAMILY_ORDER = ['E', 'Ff', 'O', 'C', 'I'] as const;
export interface GuardCompatibility {
  readonly version: string; readonly default: string; readonly proofRequired: boolean;
  readonly prohibitedSameMechanism: readonly { readonly key: string; readonly factors: readonly string[] }[];
  readonly allocation: string;
}
export interface MechanismProof { id: string; key: string; proven: boolean }
export function familyMaxima(factors: readonly GuardFactor[]) {
  return Object.fromEntries(GUARD_FAMILY_ORDER.map(f => [f, Math.max(0, ...factors.filter(x => x.family === f).map(x => x.assignedPoints))])) as Record<GuardFactor['family'], number>;
}
/** Exact finite search over incompatible assignments. Compatible family members stay visible. */
export function allocateGuardFactors(factors: GuardFactor[], proofs: ReadonlyMap<string, MechanismProof>,
  compatibility: GuardCompatibility = CONFIG_GUARD_V2.compatibility): GuardFactor[] {
  const positive = factors.filter(f => f.eligiblePoints > 0 && f.suppressionCode !== 'unreleased')
    .sort((a, b) => GUARD_FAMILY_ORDER.indexOf(a.family) - GUARD_FAMILY_ORDER.indexOf(b.family) || a.id.localeCompare(b.id));
  const conflicts = (a: GuardFactor, b: GuardFactor) => {
    const left = proofs.get(a.id), right = proofs.get(b.id);
    return left?.proven && right?.proven && left.id === right.id && left.key === right.key &&
      compatibility.prohibitedSameMechanism.some(g => g.key === left.key && g.factors.includes(a.id) && g.factors.includes(b.id));
  };
  let best: GuardFactor[] = [], bestSum = -1, bestKey = '';
  const key = (chosen: GuardFactor[]) => {
    const maxima = familyMaxima(chosen);
    return GUARD_FAMILY_ORDER.flatMap((family, i) => {
      const winner = chosen.filter(f => f.family === family && f.eligiblePoints === maxima[family]).sort((a, b) => a.id.localeCompare(b.id))[0];
      return winner ? [`${i}:${winner.id}`] : [];
    }).join('|');
  };
  const search = (index: number, chosen: GuardFactor[]) => {
    if (index === positive.length) {
      const sum = Object.values(familyMaxima(chosen)).reduce((a, b) => a + b, 0), serialized = key(chosen);
      if (sum > bestSum || sum === bestSum && serialized < bestKey) { best = [...chosen]; bestSum = sum; bestKey = serialized; }
      return;
    }
    const factor = positive[index];
    if (!chosen.some(other => conflicts(factor, other))) search(index + 1, [...chosen, { ...factor, assignedPoints: factor.eligiblePoints }]);
    if (positive.some(other => other !== factor && conflicts(factor, other))) search(index + 1, chosen);
  };
  search(0, []);
  const selected = new Set(best.map(f => f.id)), maxima = familyMaxima(best);
  return factors.map(f => {
    if (f.eligiblePoints === 0 || f.suppressionCode === 'unreleased') return f;
    if (!selected.has(f.id)) return { ...f, assignedPoints: 0, suppressionCode: 'duplicate_mechanism' };
    // Keep only the deterministic greatest factor in each family in assigned points.
    const winner = best.filter(x => x.family === f.family && x.eligiblePoints === maxima[f.family]).sort((a, b) => a.id.localeCompare(b.id))[0];
    return { ...f, assignedPoints: winner.id === f.id ? f.eligiblePoints : 0, suppressionCode: winner.id === f.id ? null : 'family_max' };
  });
}
