import type { PreflightResult } from '@eko/shared';

export interface StoredPreflight {
  orderHash: `0x${string}`;
  result: PreflightResult;
}

/** Pure resolution only; the caller owns persistence, compare-and-set and journal writes.
 * @remarks
 * Deny a changed order hash before invoking dependencies; return stored final results unchanged
 * and re-evaluate only needs_approval, preserving preflight/approval ids. Caller authenticates
 * ownership and owns persistence/current execution revalidation. Callback failures propagate; a
 * stored final allow is not fresh execution authorization.
 * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../docs/security/INVARIANTS.md | Guard, policy and approval invariants}
 */
export function resolveRepeat(stored: StoredPreflight, incomingOrderHash: `0x${string}`,
  reevaluate: () => PreflightResult): PreflightResult {
  const result = stored.result;
  if (stored.orderHash !== incomingOrderHash) {
    // TODO(spec): mismatch reuses stored IDs/version; the handler does not replace the row or write a journal entry.
    return { preflightId: result.preflightId, policyVersion: result.policyVersion, journalId: result.journalId,
      ...(result.guardPolicyVersion === undefined ? {} : { guardPolicyVersion: result.guardPolicyVersion }),
      decision: 'deny', reasons: ['order_mismatch: this clientOrderRef was used for a different order'] };
  }
  if (result.decision !== 'needs_approval') return result;
  const next = reevaluate();
  return { ...next, preflightId: result.preflightId, approvalId: result.approvalId };
}
