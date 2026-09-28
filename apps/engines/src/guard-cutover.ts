import { z } from 'zod';
import { referenceDigest } from '@eko/chain';
import { GUARD_CHECK_IDS, GUARD_CHECK_TIERS, GUARD_FACTOR_IDS, GUARD_DECISIVE_IDS,
  Bytes32Schema, GuardAssessmentV2Schema, GuardReceiptRevisionKeySchema,
  GuardVerdictRevisionInputSchema, type Policy } from '@eko/shared';
import { GUARD_GATE_IDS } from '@eko/playbooks';

export const GUARD_CUTOVER_VERSION = 'guard-cutover-063.1' as const;
export const GUARD_RELEASE_CONSUMERS = ['api', 'cache', 'web', 'bot', 'policy', 'ws', 'mcp',
  'radar', 'pair', 'alert', 'bags', 'scan', 'badge', 'widget', 'og', 'research', 'pack'] as const;
export const GUARD_RELEASE_VENUES = ['pons_curve', 'uniswap_v3', 'uniswap_v4', 'other'] as const;
const hash = Bytes32Schema;
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const version = z.string().regex(/^2\.\d+\.\d+$/);
const checks = z.array(z.enum(GUARD_CHECK_IDS));
const pins = z.strictObject({ sourceRevision: hash, codeHash: hash, parametersHash: hash,
  serviceRegistryHash: hash, profileHash: hash, calibrationManifestHash: hash,
  datasetHash: hash, labelSetHash: hash, rulesVersion: version, identityVersion: version,
  measurementVersion: version, outcomeVersion: version });
const cohort = z.strictObject({ venue: z.enum(GUARD_RELEASE_VENUES), sizeUsd: z.union([z.literal(100), z.literal(1000)]),
  accountClass: z.enum(['eoa', 'smart_account']), status: z.enum(['supported', 'incomplete']),
  checks, profileHash: hash.nullable(), evidenceHash: hash.nullable(), gaps: checks });

// TODO(spec): §7.2 specifies one active manifest, but no cutover wire format or
// atomic publisher. These closed, pure preparation records require an externally
// verified acceptance inventory and authorization; they perform no release I/O.
export const GuardReleaseManifestSchema = z.strictObject({
  version: z.literal(GUARD_CUTOVER_VERSION), kind: z.literal('guard'), origin: z.literal('measured'),
  status: z.literal('accepted'), chainId: z.literal(4663), pins,
  acceptanceHash: hash, lockedTestHash: hash, liveShadowHash: hash,
  compatibility: z.strictObject({ legacyReadProofHash: hash, policyReplayHash: hash,
    consumers: z.array(z.strictObject({ consumer: z.enum(GUARD_RELEASE_CONSUMERS), artifactHash: hash })) }),
  attributionMethod: z.literal('qualified_control_v2'),
  lowerEnabled: z.boolean(), historyEnabled: z.boolean(), bucketsEnabled: z.literal(false),
  factors: z.array(z.enum(GUARD_FACTOR_IDS)), decisive: z.array(z.enum(GUARD_DECISIVE_IDS)), checks,
  gates: z.array(z.strictObject({ id: z.enum(GUARD_GATE_IDS), passed: z.literal(true), artifactHash: hash })),
  coverage: z.array(cohort).length(16),
  live: z.strictObject({ coveredDurationSec: count.min(604800), launches: count.min(5000),
    pendingEntrants: z.literal(0), requiredFollowupComplete: z.literal(true),
    pilotTargetsAccepted: z.literal(true), budgetAccepted: z.literal(true) }),
}).superRefine((m, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (m.compatibility.consumers.length !== GUARD_RELEASE_CONSUMERS.length ||
      new Set(m.compatibility.consumers.map(c => c.consumer)).size !== GUARD_RELEASE_CONSUMERS.length)
    fail('Every consumer requires accepted compatibility evidence');
  for (const values of [m.factors, m.decisive, m.checks, m.gates.map(g => g.id)])
    if (new Set(values).size !== values.length) fail('Duplicate released registry entry');
  const slices = m.coverage.map(c => `${c.venue}:${c.sizeUsd}:${c.accountClass}`);
  if (new Set(slices).size !== 16) fail('Every venue/primary size/account slice must be declared exactly once');
  const required = new Set<string>(['contracts', 'measurement_fidelity', 'restrictions', 'operations', 'parity', 'live_shadow']);
  if (m.factors.length) for (const g of ['factor_promotion', 'high_precision', 'harm_recall']) required.add(g);
  if (m.lowerEnabled) required.add('lower_harm');
  if (m.historyEnabled || m.factors.some(f => ['operator_hold', 'operator_dump', 'authenticated_dominance',
    'coordinated_hold', 'coordinated_union', 'principal_origin_hold', 'horizon_release'].includes(f)) ||
    m.checks.some(c => GUARD_CHECK_TIERS[c] === 'lower_tier') || m.decisive.includes('liquidity_withdrawn')) required.add('attribution');
  if (m.factors.includes('agent_instruction')) required.add('instruction');
  if (m.decisive.includes('severe_cost')) required.add('factor_promotion');
  for (const g of required) if (!m.gates.some(row => row.id === g)) fail(`Missing accepted gate: ${g}`);
  if (!m.coverage.some(c => c.status === 'supported')) fail('No supported shipping slice');
  for (const c of m.coverage) {
    if (new Set(c.checks).size !== c.checks.length || new Set(c.gaps).size !== c.gaps.length ||
        c.checks.some(id => !m.checks.includes(id) || c.gaps.includes(id))) fail('Invalid slice check registry');
    if (c.status === 'supported' && (!c.profileHash || !c.evidenceHash ||
        GUARD_CHECK_IDS.some(id => (m.lowerEnabled || GUARD_CHECK_TIERS[id] === 'buy_critical') && !c.checks.includes(id))))
      fail('Shipping slice lacks accepted profile/evidence/check coverage');
    if (c.status === 'incomplete' && !c.gaps.some(id => GUARD_CHECK_TIERS[id] === 'buy_critical'))
      fail('Incomplete slice must name a buy-critical gap');
    if (GUARD_CHECK_IDS.some(id => !c.checks.includes(id) && !c.gaps.includes(id))) fail('Slice hides check gaps');
  }
  if (m.lowerEnabled && GUARD_CHECK_IDS.some(id => !m.checks.includes(id))) fail('Lower requires both released tiers');
  if (m.historyEnabled && !m.checks.includes('operator_history')) fail('History requires released history check');
});
export type GuardReleaseManifest = z.infer<typeof GuardReleaseManifestSchema>;
export const SignalReleaseManifestSchema = z.strictObject({ version: z.literal(GUARD_CUTOVER_VERSION),
  kind: z.literal('signal'), origin: z.literal('measured'), status: z.literal('accepted'), adapterVersion: z.literal(2),
  guardManifestHash: hash, adapterCodeHash: hash, sourceRevision: hash, acceptanceHash: hash,
  checksHash: hash, refreshSec: z.literal(15), legacyInputsPreserved: z.literal(true) });
export type SignalReleaseManifest = z.infer<typeof SignalReleaseManifestSchema>;

/** Trusted, redacted inventory supplied only by the existing authorized release
 * process, never by an API request, tool context, fixture report or demo flag.
 * A JSON accepted=true is insufficient: exact content hashes must be admitted. */
export const GuardReleaseInventorySchema = z.strictObject({
  accepted: z.array(z.strictObject({ manifestHash: hash, acceptanceHash: hash, candidateRevision: hash,
    released: z.boolean() })),
  revoked: z.array(hash),
  authorizations: z.array(z.strictObject({ operation: z.enum(['cutover', 'rollback', 'signal']),
    targetHash: hash.nullable(), expectedGeneration: count, authorizationHash: hash })),
});
export type GuardReleaseInventory = z.infer<typeof GuardReleaseInventorySchema>;
export const GuardSwitchStateSchema = z.discriminatedUnion('mode', [
  z.strictObject({ version: z.literal(GUARD_CUTOVER_VERSION), generation: count, mode: z.literal('inactive'),
    guardManifestHash: z.null(), signalManifestHash: z.null(), guardPolicyVersion: z.literal(1) }),
  z.strictObject({ version: z.literal(GUARD_CUTOVER_VERSION), generation: count, mode: z.literal('active'),
    guardManifestHash: hash, signalManifestHash: hash.nullable(), guardPolicyVersion: z.literal(2) }),
  z.strictObject({ version: z.literal(GUARD_CUTOVER_VERSION), generation: count, mode: z.literal('critical_incomplete'),
    guardManifestHash: z.null(), signalManifestHash: z.null(), guardPolicyVersion: z.literal(2) }),
]);
export type GuardSwitchState = z.infer<typeof GuardSwitchStateSchema>;
export const INACTIVE_GUARD_SWITCH: GuardSwitchState = Object.freeze({ version: GUARD_CUTOVER_VERSION,
  generation: 0, mode: 'inactive', guardManifestHash: null, signalManifestHash: null, guardPolicyVersion: 1 });
export const EMPTY_GUARD_RELEASE_INVENTORY: GuardReleaseInventory = Object.freeze({ accepted: [], revoked: [], authorizations: [] });

function admitted(manifest: GuardReleaseManifest | SignalReleaseManifest, inventory: GuardReleaseInventory, released: boolean) {
  const digest = referenceDigest(manifest);
  const revision = manifest.kind === 'guard' ? manifest.pins.sourceRevision : manifest.sourceRevision;
  if (inventory.revoked.includes(digest) || !inventory.accepted.some(row => row.manifestHash === digest &&
      row.acceptanceHash === manifest.acceptanceHash && row.candidateRevision === revision && (!released || row.released)))
    throw new Error('No accepted release manifest in trusted inventory');
  return digest;
}
function authorize(inventory: GuardReleaseInventory, operation: 'cutover' | 'rollback' | 'signal', targetHash: string | null, generation: number) {
  if (!inventory.authorizations.some(a => a.operation === operation && a.targetHash === targetHash && a.expectedGeneration === generation))
    throw new Error('Missing explicit candidate/generation-bound release authorization');
}

/** Pure compare-and-set preparation. The authorized publisher must persist this
 * entire next state once, conditional on expectedStateHash; no per-consumer flips. */
export function prepareGuardSwitch(raw: { current: GuardSwitchState; expectedGeneration: number;
  operation: 'cutover' | 'rollback' | 'signal'; manifest: unknown | null; inventory: GuardReleaseInventory;
  acknowledgements: unknown }) {
  const current = GuardSwitchStateSchema.parse(raw.current), inventory = GuardReleaseInventorySchema.parse(raw.inventory);
  if (raw.expectedGeneration !== current.generation || current.generation === Number.MAX_SAFE_INTEGER)
    throw new Error('Stale or exhausted switch generation');
  let next: GuardSwitchState;
  if (raw.operation === 'signal') {
    if (current.mode !== 'active') throw new Error('Signal requires an active accepted Guard manifest');
    const m = SignalReleaseManifestSchema.parse(raw.manifest), target = admitted(m, inventory, false);
    if (m.guardManifestHash !== current.guardManifestHash || inventory.revoked.includes(current.guardManifestHash) ||
        !inventory.accepted.some(r => r.manifestHash === current.guardManifestHash && r.released))
      throw new Error('Signal is bound to a different or unreleased Guard manifest');
    authorize(inventory, raw.operation, target, current.generation);
    next = { ...current, generation: current.generation + 1, signalManifestHash: target };
  } else {
    if (raw.manifest === null) {
      if (raw.operation !== 'rollback' || current.mode === 'inactive') throw new Error('Cutover requires an accepted release manifest');
      authorize(inventory, raw.operation, null, current.generation);
      next = { version: GUARD_CUTOVER_VERSION, generation: current.generation + 1, mode: 'critical_incomplete',
        guardManifestHash: null, signalManifestHash: null, guardPolicyVersion: 2 };
    } else {
      const m = GuardReleaseManifestSchema.parse(raw.manifest), target = admitted(m, inventory, raw.operation === 'rollback');
      if (raw.operation === 'rollback' && (current.mode === 'inactive' || target === current.guardManifestHash))
        throw new Error('Rollback requires a previous released V2 configuration');
      authorize(inventory, raw.operation, target, current.generation);
      next = { version: GUARD_CUTOVER_VERSION, generation: current.generation + 1, mode: 'active',
        guardManifestHash: target, signalManifestHash: null, guardPolicyVersion: 2 };
    }
  }
  verifyGuardConsumerAcks(next, raw.acknowledgements);
  return { prepared: true, released: false, expectedStateHash: referenceDigest(current),
    next: GuardSwitchStateSchema.parse(next), nextStateHash: referenceDigest(next),
    consumers: GUARD_RELEASE_CONSUMERS.map(consumer => ({ consumer, ...guardConsumerSwitch(next) })) };
}

/** Every consumer derives negotiation and cache namespace from the same snapshot. */
export function guardConsumerSwitch(raw: GuardSwitchState) {
  const s = GuardSwitchStateSchema.parse(raw);
  return { stateHash: referenceDigest(s), manifestHash: s.guardManifestHash,
    schema: s.mode === 'inactive' ? 'verdict-1' : 'guard-2',
    v1Transport: s.mode === 'inactive' ? 'verdict-1' : 'verdict-1+guard-2',
    guardPolicyVersion: s.guardPolicyVersion, signalVersion: s.signalManifestHash ? 2 : 1,
    cacheNamespace: referenceDigest(s), fallback: s.mode === 'critical_incomplete' };
}
export const GuardConsumerAckSchema = z.strictObject({ consumer: z.enum(GUARD_RELEASE_CONSUMERS),
  stateHash: hash, manifestHash: hash.nullable(), schema: z.enum(['verdict-1', 'guard-2']),
  v1Transport: z.enum(['verdict-1', 'verdict-1+guard-2']), guardPolicyVersion: z.union([z.literal(1), z.literal(2)]),
  signalVersion: z.union([z.literal(1), z.literal(2)]), cacheNamespace: hash, fallback: z.boolean() });
export function verifyGuardConsumerAcks(state: GuardSwitchState, raw: unknown) {
  const acks = z.array(GuardConsumerAckSchema).parse(raw), expected = guardConsumerSwitch(state);
  if (acks.length !== GUARD_RELEASE_CONSUMERS.length || new Set(acks.map(a => a.consumer)).size !== acks.length ||
      acks.some(({ consumer: _, ...ack }) => referenceDigest(ack) !== referenceDigest(expected)))
    throw new Error('Consumer schema/cache/version negotiation mismatch');
  return true;
}

/** Never relabel shadow/candidate receipts as active. Unsupported slices return
 * a named critical-incomplete result, without manufacturing a scored receipt. */
export function selectReleasedGuard(state: GuardSwitchState, manifest: unknown, inventory: GuardReleaseInventory,
  revision: unknown, context: { venue: typeof GUARD_RELEASE_VENUES[number]; sizeUsd: 100 | 1000; accountClass: 'eoa' | 'smart_account' }) {
  const s = GuardSwitchStateSchema.parse(state);
  const unavailable = (reason: string) => ({ status: 'critical_incomplete' as const, assessment: null, reason });
  if (s.mode !== 'active') return unavailable(s.mode === 'inactive' ? 'guard_v2_inactive' : 'guard_rollback_incomplete');
  const m = GuardReleaseManifestSchema.parse(manifest), i = GuardReleaseInventorySchema.parse(inventory);
  if (admitted(m, i, true) !== s.guardManifestHash) return unavailable('guard_manifest_mismatch');
  const slice = m.coverage.find(c => c.venue === context.venue && c.sizeUsd === context.sizeUsd && c.accountClass === context.accountClass);
  if (!slice || slice.status !== 'supported') return unavailable('guard_unsupported_slice');
  const parsed = GuardVerdictRevisionInputSchema.safeParse(revision);
  if (!parsed.success) return unavailable('guard_missing_assessment');
  const stored = parsed.data, a = GuardAssessmentV2Schema.parse(stored.assessment);
  if (stored.sourceRevision !== m.pins.sourceRevision ||
      (stored.context.sizeUsd !== null && stored.context.sizeUsd !== String(context.sizeUsd)) ||
      (stored.context.accountClass !== null && stored.context.accountClass !== context.accountClass) ||
      a.mode !== 'active' || a.chainId !== m.chainId ||
      (['codeHash', 'parametersHash', 'serviceRegistryHash', 'profileHash', 'calibrationManifestHash',
        'rulesVersion', 'identityVersion', 'measurementVersion', 'outcomeVersion'] as const).some(k => a[k] !== m.pins[k]) ||
      a.factors.some(f => f.assignedPoints > 0 && (!m.factors.includes(f.id) || f.calibration !== 'released')) ||
      a.decisiveIds.some(id => !m.decisive.includes(id)) ||
      a.checks.some(c => c.status === 'complete' && !slice.checks.includes(c.id)) ||
      (!m.lowerEnabled && a.level === 'lower') || (!m.historyEnabled && a.historyPoints > 0))
    return unavailable('guard_unreleased_assessment');
  return { status: 'selected' as const, assessment: a, reason: null };
}

export function guardReleaseCacheKey(state: GuardSwitchState, revisionKey: unknown) {
  return referenceDigest({ switch: GuardSwitchStateSchema.parse(state), revision: GuardReceiptRevisionKeySchema.parse(revisionKey) });
}
/** Append a new settings version during authorized publication. Older settings,
 * final preflight replays and their guardPolicyVersion are never rewritten. */
export function prepareGuardPolicySettings(policy: Policy, state: GuardSwitchState): Policy {
  const s = GuardSwitchStateSchema.parse(state);
  if (s.mode === 'inactive' || policy.guardPolicyVersion === 2) return { ...policy };
  if (policy.version === Number.MAX_SAFE_INTEGER) throw new Error('Policy version exhausted');
  return { ...policy, version: policy.version + 1, guardPolicyVersion: 2 };
}
