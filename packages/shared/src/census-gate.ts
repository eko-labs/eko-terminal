import type { Census } from './contracts/api.js';

// TODO(spec): Gate expiry is unspecified. Use seven days, matching the weekly fingerprint refit, until a reviewed policy supplies another lifetime.
export const CENSUS_GATE_MAX_AGE_MS = 7 * 86400_000;
export function censusGateAccepted(gate: Census['gate'], now = Date.now()): boolean {
  const evaluated = Date.parse(gate.evaluatedAt ?? ''), expires = Date.parse(gate.expiresAt ?? '');
  const evidence = gate.evidence;
  return !!gate.modelVersion && gate.value !== null && Number.isFinite(gate.value) && gate.value >= Math.max(0.90, gate.threshold)
    && gate.value <= 1 && Number.isFinite(gate.threshold)
    && gate.wilsonLower != null && Number.isFinite(gate.wilsonLower) && gate.wilsonLower >= 0 && gate.wilsonLower <= 1
    && gate.recall != null && Number.isFinite(gate.recall) && gate.recall >= 0 && gate.recall <= 1
    && Number.isFinite(evaluated) && evaluated <= now && Number.isFinite(expires)
    && expires > now && expires <= evaluated + CENSUS_GATE_MAX_AGE_MS
    && /^[a-f0-9]{64}$/.test(gate.modelHash ?? '') && /^[a-f0-9]{64}$/.test(gate.datasetHash ?? '')
    // TODO(spec): The held-out declared cohort has no stated size; require at least one eligible wallet in addition to both reviewed minima.
    && !!evidence && evidence.declared >= 1 && evidence.agents >= 200 && evidence.humans >= 300 && evidence.predictedAgents > 0;
}
