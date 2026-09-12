import type { Policy } from '@eko/shared';

// TODO(spec): presets.yaml served by GET /policy-presets.
export const PRESETS = {
  safe: { blockPlaybookLevel: 'monitor', maxRoundTripCostPct: 5, minLiquidityUsd: 50_000,
    approvalAboveUsd: 500, maxLeverage: 1, earningsBlackoutDays: 2 },
  balanced: { blockPlaybookLevel: 'danger', maxRoundTripCostPct: 10, minLiquidityUsd: 10_000,
    approvalAboveUsd: 2_000, maxLeverage: 3, earningsBlackoutDays: 1 },
  degen: { blockPlaybookLevel: 'danger', maxRoundTripCostPct: 25, minLiquidityUsd: 2_000,
    maxLeverage: 5, earningsBlackoutDays: 0 },
} as const satisfies Record<Policy['mode'], Partial<Policy>>;

export type PolicyInput = Pick<Policy, 'mode' | 'killed' | 'version'> & Partial<Policy>;

/** Undefined means unset; null, zero, false and empty lists are user choices.
 * @remarks
 * Merge preset defaults with supplied policy, preserving explicit overrides; select Guard defaults
 * only when the trusted v2 switch is enabled. Pure typed-input projection without wallet auth; it
 * does not schema-validate or authorize policy edits.
 * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../docs/security/INVARIANTS.md | Guard, policy and approval invariants}
 */
export function applyPreset(policy: PolicyInput, guardPolicyV2 = false): Policy {
  const set = Object.fromEntries(Object.entries(policy).filter(([, value]) => value !== undefined));
  return { ...PRESETS[policy.mode], ...set, mode: policy.mode, killed: policy.killed,
    version: policy.version, ...(guardPolicyV2 ? { guardPolicyVersion: 2 } : {}) } as Policy;
}
