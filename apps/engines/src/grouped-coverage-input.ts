import { z } from 'zod';
import { AddressSchema, AvailabilityCutSchema, Bytes32Schema, GuardCoverageSchema, GuardCursorSchema,
  GuardLotSchema, SupplySnapshotV2Schema } from '@eko/shared';
import type { QualifiedGraphSnapshot } from './qualified-graphs.js';

const address = AddressSchema.transform(a => a.toLowerCase() as `0x${string}`);
const uint = z.string().regex(/^(0|[1-9]\d*)$/);
const proof = { cursor: GuardCursorSchema, knownAt: AvailabilityCutSchema, evidenceIds: z.array(Bytes32Schema).min(1) };
const participant = z.strictObject({ address, roles: z.array(z.enum(['funder', 'buy_payer', 'buy_recipient',
  'sell_source', 'proceeds_recipient', 'purchaser', 'lot_sender', 'lot_origin', 'lot_holder'])) });
const kind = z.enum(['control', 'coordination', 'origin']);
const ratio = z.strictObject({ numerator: uint, denominator: uint.refine(n => n !== '0') }).nullable();
export const EffectiveGroupedGraphSchema = z.strictObject({
  graphVersion: z.string().min(1), coin: address, at: AvailabilityCutSchema, mode: z.literal('shadow'),
  edges: z.array(z.strictObject({ id: Bytes32Schema, kind, evidenceClass: z.enum(['authenticated_control', 'private_payer',
    'recent_material_funder', 'collector', 'closed_loop', 'bounded_path', 'medium_path', 'consolidation', 'soft_cohort', 'lot_origin']),
    status: z.enum(['qualified', 'candidate']), memberIds: z.array(address), participants: z.array(participant),
    evidenceIds: z.array(Bytes32Schema), sourceIds: z.array(Bytes32Schema), fundingRatio: ratio, collectionRatio: ratio,
    fastCollection: uint.nullable(), launchBundle: z.boolean(), historyEligible: z.boolean() })),
  components: z.array(z.strictObject({ id: Bytes32Schema, kind, memberIds: z.array(address).min(2),
    edgeIds: z.array(Bytes32Schema).min(1), graphVersion: z.string().min(1), supersedes: z.array(Bytes32Schema),
    participants: z.array(participant), groupScoringEligible: z.boolean(), historyEligible: z.boolean(),
    diagnostics: z.array(z.strictObject({ deleted: address, reason: z.enum(['highest_degree', 'unresolved_hub']),
      remaining: z.array(z.array(address)) })) })),
  observedConnections: z.array(z.strictObject({ id: z.string(), from: z.string(), to: z.string(), raw: uint })),
  retired: z.array(Bytes32Schema), issues: z.array(z.string()),
});

// TODO(spec): §§3.2/5.3 do not prescribe an aggregate acquisition/checkpoint envelope.
// Keep these supplied observations local and shadow-only. Investigation covers the current
// candidate's actor, origin and paths; services excluded from link expansion still retain mass.
export const GroupedCoverageInputSchema = z.strictObject({
  supply: SupplySnapshotV2Schema, graph: EffectiveGroupedGraphSchema,
  principal: address.nullable(), launchedAtSec: uint.nullable(), firstTradeSec: uint.nullable(),
  acquisitions: z.array(z.strictObject({ ...proof, id: Bytes32Schema, recipient: address, kind: z.enum(['buy', 'transfer', 'mint']) })),
  acquisitionCoverage: GuardCoverageSchema, originCoverage: GuardCoverageSchema, actorCoverage: GuardCoverageSchema,
  lots: z.array(GuardLotSchema),
  investigations: z.array(z.strictObject({ ...proof, address, coverage: GuardCoverageSchema })),
  unresolvedCustody: z.array(address),
  exclusions: z.array(z.strictObject({ ...proof, address, reason: z.enum(['service', 'broad_distribution']) })),
  releases: z.array(z.strictObject({ ...proof, id: Bytes32Schema, owner: address, units: uint,
    releaseAtSec: uint })),
  releaseCoverage: GuardCoverageSchema,
  // Review/method gate is independent of origin measurement and never grants common control.
  principalOriginScoringAccepted: z.boolean().default(false),
});
export type GroupedCoverageInput = Omit<z.infer<typeof GroupedCoverageInputSchema>, 'graph'> & { graph: QualifiedGraphSnapshot };
