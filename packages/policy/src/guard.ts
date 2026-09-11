import { GuardAssessmentV2Schema } from '@eko/shared';
import type { Policy, Verdict } from '@eko/shared';
import { GUARD_MAX_AGE_MS } from './actual-order.js';

/** Guard §§1, 5.3: consume a cached released assessment, never promote a candidate score.
 * @remarks
 * Require a matching released active Guard assessment with buy-critical completeness, acceptable
 * level and snapshot age; preserve factual honeypot refusal independently. Trusted policy caller
 * binds chain/asset; no wallet auth or acquisition. Missing/malformed/mismatched/stale assessments
 * return denial reasons; unchecked malformed outer verdict data can still throw.
 * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../docs/security/INVARIANTS.md | Guard, policy and approval invariants}
 */
export function guardBuyGate(verdict: Verdict | undefined, policy: Policy, asset: string, chainId: number, requestClockMs: number): {
  deny: string[]; warn: string[];
} {
  const parsed = GuardAssessmentV2Schema.safeParse(verdict?.guardV2);
  const guard = parsed.success && parsed.data.mode === 'active' && parsed.data.coin === asset &&
    parsed.data.chainId === chainId ? parsed.data : undefined;
  const warn = guard?.completeness.missing.length
    ? [`guard_gaps: not fully checked: ${guard.completeness.missing.join(', ')}`] : [];

  // Preserve existing confirmed factual hard refusals independently of coverage/threshold choices.
  if (verdict?.playbooks.some(m => m.id === 'honeypot' && m.level === 'danger'))
    return { deny: ['honeypot: the sell simulation fails'], warn };
  if (!guard) return { deny: ['guard_incomplete: no active Guard assessment for this chain and asset'], warn };
  if (guard.level === 'high') return { deny: ['guard_high: buys are refused at High risk'], warn };
  const snapshotMs = Number(BigInt(guard.cursor.timestampSec) * 1000n);
  if (snapshotMs > requestClockMs || requestClockMs - snapshotMs > GUARD_MAX_AGE_MS)
    return { deny: ['guard_stale: Guard snapshot is older than 30 seconds'], warn };
  if (!guard.completeness.buyCriticalComplete || guard.level === 'incomplete')
    return { deny: [`guard_incomplete: unresolved buy-critical checks: ${guard.checks
      .filter(c => c.tier === 'buy_critical' && c.status !== 'complete' && c.status !== 'not_applicable')
      .map(c => `${c.id} (${c.status})`).join(', ')}`], warn };
  if (guard.level === 'elevated' && (policy.mode === 'safe' || policy.blockPlaybookLevel === 'monitor'))
    return { deny: ['guard_elevated: Elevated risk exceeds your buyer-level policy'], warn };
  return { deny: [], warn };
}
