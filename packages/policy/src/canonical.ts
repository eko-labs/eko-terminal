import { keccak256, stringToHex } from 'viem';
import type { PreflightRequest } from '@eko/shared';

import { canonicalize } from '@eko/shared';
export { canonicalize } from '@eko/shared';

/**
 * Canonical-keccak hash the complete order after dropping top-level undefined optional fields
 * absent on the JSON wire. Pure public binding operation without auth; canonicalization/encoding
 * failures throw. Approval callers bind this hash to authenticated agent and client reference;
 * calldata is included when present.
 * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../docs/security/INVARIANTS.md | Guard, policy and approval invariants}
 */
export function orderHash(order: PreflightRequest['order']): `0x${string}` {
  // TODO(spec): omit undefined optional order fields before JCS; they are absent on the JSON wire.
  const jsonOrder = Object.fromEntries(Object.entries(order).filter(([, value]) => value !== undefined));
  return keccak256(stringToHex(canonicalize(jsonOrder)));
}
