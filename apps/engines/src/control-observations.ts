import { GuardScoreObservationSchema, compareGuardCursors, guardKnownBy } from '@eko/shared';
import type { GuardScoreInput } from '@eko/shared';
import { PonsControlSnapshotSchema, controlProfileHash } from './control-profile.js';

/** Captured measured profiles only. Fixtures never complete a stored shadow check. */
export function appendControlProfileObservations(input: GuardScoreInput, content: unknown, evidenceId: `0x${string}`) {
  const parsed = PonsControlSnapshotSchema.safeParse(content); if (!parsed.success) return;
  const s = parsed.data;
  if (s.origin !== 'measured' || !guardKnownBy(s.knownAt, input.availabilityCut)) return;
  const { profileHash, ...body } = s;
  if (controlProfileHash(body) !== profileHash) throw new Error('Control profile content hash mismatch');
  if (s.coin !== input.coin || compareGuardCursors(s.cursor, input.cursor) !== 0) throw new Error('Control profile context mismatch');
  if (input.checks.some(c => c.id === 'controls_hooks' || c.id === 'effective_fees')) throw new Error('Ambiguous current control profile');
  input.profileHash = s.profileHash;
  input.checks.push(...s.checks.map(c => ({ ...c, evidenceIds: [evidenceId] })));
  const severe = s.control.powers.filter(p => p.reachable.value === true && p.boundCode === 'unrestricted' &&
    ['mint', 'blacklist', 'sell_pause', 'transfer_upgrade'].includes(p.capability) && p.earliestExecution.value !== null)
    .sort((a, b) => BigInt(a.earliestExecution.value!) < BigInt(b.earliestExecution.value!) ? -1 :
      BigInt(a.earliestExecution.value!) > BigInt(b.earliestExecution.value!) ? 1 : a.capability.localeCompare(b.capability))[0];
  if (!severe) return;
  const seconds = BigInt(severe.earliestExecution.value!) - BigInt(s.cursor.timestampSec);
  const primary = { ...severe.delaySec, id: 'controlDelay', value: seconds.toString(), evidenceIds: [evidenceId], unit: 'seconds' };
  input.observations.push(GuardScoreObservationSchema.parse({ id: 'arbitrary_control', primary, secondary: null, qualification: { ...severe.reachable, evidenceIds: [evidenceId] },
    participants: null, windowSec: null, controlKind: null,
    mechanism: { id: controlProfileHash({ implementation: severe.implementationHash, capability: severe.capability,
      effectiveConfig: severe.configurationHash }), key: 'implementation_capability_effective_config', proven: true },
    reason: { code: 'CONTROL', factorId: 'arbitrary_control', parameters: { authorityRole: 'controller', capability: severe.capability,
      codeHash: severe.implementationHash, boundCode: severe.boundCode, executionTime: severe.earliestExecution.value }, evidenceIds: [evidenceId] } }));
}
