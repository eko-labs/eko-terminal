import { z } from 'zod';
import { keccak256, toHex } from 'viem';
import { AddressSchema, Bytes32Schema, GuardCursorSchema, AvailabilityCutSchema, compareGuardCursors, guardKnownBy } from '@eko/shared';
import type { AvailabilityCut, GuardCursor } from '@eko/shared';

const uint = z.string().regex(/^(0|[1-9]\d*)$/);
const address = AddressSchema.transform(a => a.toLowerCase() as `0x${string}`);
const evidence = z.array(Bytes32Schema).min(1);
const interval = { effectiveFrom: GuardCursorSchema, effectiveUntil: GuardCursorSchema.nullable(), knownAt: AvailabilityCutSchema };
export const ServiceRegistryEntrySchema = z.strictObject({
  chainId: z.number().int().positive(), address, codeHash: Bytes32Schema, implementation: address.nullable(), ...interval,
  kind: z.enum(['exchange', 'bridge', 'mixer', 'market', 'router', 'entrypoint', 'paymaster', 'relayer', 'distributor', 'custodian', 'shared_tool']),
  independentCallers: z.array(address).min(2), perUserConfigurationEvidence: evidence, reviewEvidence: evidence,
});
export type ServiceRegistryEntry = z.infer<typeof ServiceRegistryEntrySchema>;
export const ServiceRegistrySchema = z.strictObject({ version: z.string().regex(/^\d+\.\d+\.\d+$/), entries: z.array(ServiceRegistryEntrySchema) });
export type ServiceRegistry = z.infer<typeof ServiceRegistrySchema>;
function intervalContains(record: z.infer<z.ZodObject<typeof interval>>, at: AvailabilityCut) {
  return guardKnownBy(record.knownAt, at) && compareGuardCursors(record.effectiveFrom, at.cursor) <= 0 &&
    (record.effectiveUntil === null || compareGuardCursors(at.cursor, record.effectiveUntil) < 0);
}
export const ServiceResolutionSchema = z.strictObject({
  status: z.enum(['confirmed', 'candidate', 'unresolved']), registryHash: Bytes32Schema, registryVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  cursor: GuardCursorSchema, knownAt: AvailabilityCutSchema, effectiveCursor: GuardCursorSchema,
  address, codeHash: Bytes32Schema.nullable(), implementation: address.nullable(),
  launches: z.number().int().nonnegative(), principals: z.number().int().nonnegative(), pairs: z.number().int().nonnegative(), pairDenominator: z.number().int().nonnegative(), launchCoverageComplete: z.boolean(),
  principalCoverageComplete: z.boolean(), pairCoverageComplete: z.boolean(),
  degree: z.number().int().nonnegative().nullable(), degreeStatus: z.enum(['unknown', 'observed', 'lower_bound']), hub: z.enum(['review', 'below_threshold', 'unknown']),
  degreeCoverage: z.strictObject({ fromSec: uint, throughSec: uint, complete: z.boolean(), evidenceIds: z.array(Bytes32Schema) }).nullable(),
  stopControlExpansion: z.boolean(), aggregateInfrastructureHistory: z.literal(false), preserveEconomicExposure: z.literal(true), reviewEvidence: z.array(Bytes32Schema),
});
/** Order-independent manifest hash; no abbreviated research examples are seeded. */
export function serviceRegistryHash(raw: ServiceRegistry) {
  const registry = ServiceRegistrySchema.parse(raw);
  const entries = registry.entries.map(e => ({ ...e, independentCallers: [...new Set(e.independentCallers)].sort(),
    perUserConfigurationEvidence: [...new Set(e.perUserConfigurationEvidence)].sort(), reviewEvidence: [...new Set(e.reviewEvidence)].sort() }));
  if (entries.some(e => e.independentCallers.length < 2 || e.chainId !== e.effectiveFrom.chainId || e.chainId !== e.knownAt.cursor.chainId ||
    (e.effectiveUntil && compareGuardCursors(e.effectiveFrom, e.effectiveUntil) >= 0))) throw new Error('Invalid service review interval/callers');
  return keccak256(toHex(JSON.stringify({ version: registry.version, entries: entries.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) })));
}
export interface ServiceLaunchObservation {
  id: string; service: string; codeHash: string; implementation: string | null;
  cursor: GuardCursor; knownAt: AvailabilityCut; principal: string | null; authenticated: boolean; feeRecipient: string | null;
}
export interface DegreeObservation {
  fromSec: string; throughSec: string; counterparties: readonly string[];
  complete: boolean; knownAt: AvailabilityCut; evidenceIds: readonly string[];
}
/** CALIBRATE §§2.2/9: lower-bound qualification only, never failure-to-qualify => one operator. */
export function resolveService(input: {
  registry: ServiceRegistry; address: string; codeHash: string | null; implementation: string | null; at: AvailabilityCut;
  launches: readonly ServiceLaunchObservation[]; launchCoverageComplete: boolean; degree?: DegreeObservation;
}) {
  const registryHash = serviceRegistryHash(input.registry), subject = address.parse(input.address), at = AvailabilityCutSchema.parse(input.at);
  const matches = input.registry.entries.map(e => ServiceRegistryEntrySchema.parse(e)).filter(e => e.chainId === at.cursor.chainId && e.address === subject &&
    e.codeHash === input.codeHash && e.implementation === input.implementation && intervalContains(e, at));
  const through = BigInt(at.cursor.timestampSec), start = through - 86400n;
  const observations = input.launches.filter(l => address.parse(l.service) === subject && l.codeHash === input.codeHash && l.implementation === input.implementation &&
    l.cursor.chainId === at.cursor.chainId && BigInt(l.cursor.timestampSec) > start && BigInt(l.cursor.timestampSec) <= through && compareGuardCursors(l.cursor, at.cursor) <= 0 && guardKnownBy(l.knownAt, at));
  const unique = new Map<string, ServiceLaunchObservation>();
  for (const l of observations) { const previous = unique.get(l.id); if (previous && JSON.stringify(previous) !== JSON.stringify(l)) throw new Error('Conflicting service launch'); unique.set(l.id, l); }
  const launches = [...unique.values()], authenticated = launches.filter(l => l.authenticated && l.principal !== null);
  const principals = new Set(authenticated.map(l => address.parse(l.principal))).size;
  const pairs = new Set(authenticated.filter(l => l.feeRecipient !== null).map(l => `${address.parse(l.principal)}:${address.parse(l.feeRecipient)}`)).size;
  const candidate = input.launchCoverageComplete && input.codeHash !== null && launches.length >= 20 && principals >= 10 && BigInt(pairs) * 100n >= BigInt(launches.length) * 80n;
  const degree = input.degree;
  const degreeUsable = !!degree && degree.evidenceIds.length > 0 && degree.evidenceIds.every(id => Bytes32Schema.safeParse(id).success) && guardKnownBy(degree.knownAt, at) && uint.safeParse(degree.fromSec).success && uint.safeParse(degree.throughSec).success &&
    BigInt(degree.throughSec) === through && BigInt(degree.fromSec) === (start < 0n ? 0n : start);
  const count = degreeUsable ? new Set(degree!.counterparties.map(a => address.parse(a))).size : null;
  const hub = count !== null && count >= 500 ? 'review' : degreeUsable && degree!.complete ? 'below_threshold' : 'unknown';
  const status = matches.length === 1 ? 'confirmed' : matches.length > 1 ? 'unresolved' : candidate ? 'candidate' : 'unresolved';
  return ServiceResolutionSchema.parse({ status, registryHash, registryVersion: input.registry.version, address: subject, codeHash: input.codeHash, implementation: input.implementation,
    cursor: at.cursor, knownAt: at, effectiveCursor: matches.length === 1 ? matches[0].effectiveFrom : at.cursor,
    launches: launches.length, principals, pairs, pairDenominator: launches.length, launchCoverageComplete: input.launchCoverageComplete,
    principalCoverageComplete: input.launchCoverageComplete && authenticated.length === launches.length,
    pairCoverageComplete: input.launchCoverageComplete && authenticated.length === launches.length && authenticated.every(l => l.feeRecipient !== null),
    degree: count, degreeStatus: count === null ? 'unknown' : degree!.complete ? 'observed' : 'lower_bound', hub,
    degreeCoverage: degreeUsable ? { fromSec: degree!.fromSec, throughSec: degree!.throughSec, complete: degree!.complete, evidenceIds: degree!.evidenceIds } : null,
    stopControlExpansion: status === 'confirmed' || status === 'candidate' || hub === 'review',
    // Unresolved infrastructure is not eligible for history; it is also not proof of independence.
    aggregateInfrastructureHistory: false, preserveEconomicExposure: true,
    reviewEvidence: matches.length === 1 ? matches[0].reviewEvidence : [],
  });
}
export type ServiceResolution = ReturnType<typeof resolveService>;

export const PermissionObservationSchema = z.strictObject({
  // TODO(spec): Effective-permission review records have no canonical acquisition envelope yet.
  // Require complete acquired state and an independently verified path; matching signers alone is insufficient.
  account: address, codeHash: Bytes32Schema, implementation: address.nullable(), ...interval,
  owners: z.array(address), threshold: z.number().int().positive(), enabledModules: z.array(address), permissionCoverageComplete: z.boolean(),
  paths: z.array(z.strictObject({
    authority: address, kind: z.enum(['owner_quorum', 'module', 'delegated']), signers: z.array(address), module: address.nullable(),
    arbitraryEconomicActions: z.boolean(), verifiedPermission: z.boolean(), evidenceIds: evidence,
  })), evidenceIds: evidence,
});
export type PermissionObservation = z.infer<typeof PermissionObservationSchema>;
/** Effective permission paths, not identical owners, implementations, sponsorship or a shared signer. */
export function resolveEffectiveControl(accounts: readonly string[], authorityInput: string, raw: readonly PermissionObservation[], at: AvailabilityCut) {
  const authority = address.parse(authorityInput), members = [...new Set(accounts.map(a => address.parse(a)))].sort();
  const observations = raw.map(p => PermissionObservationSchema.parse(p));
  const accepted: PermissionObservation[] = [];
  for (const account of members) {
    const current = observations.filter(p => p.account === account && intervalContains(p, at));
    if (current.length !== 1 || !current[0].permissionCoverageComplete) return { status: 'unknown', authority: null, members, evidenceIds: [] } as const;
    const p = current[0], owners = new Set(p.owners), modules = new Set(p.enabledModules);
    if (owners.size !== p.owners.length || modules.size !== p.enabledModules.length || p.threshold > owners.size) return { status: 'unknown', authority: null, members, evidenceIds: [] } as const;
    const paths = p.paths.filter(path => path.authority === authority && path.arbitraryEconomicActions && path.verifiedPermission && (
      path.kind === 'owner_quorum' ? new Set(path.signers.filter(s => owners.has(s))).size >= p.threshold && path.signers.every(s => owners.has(s)) :
      path.kind === 'module' ? path.module !== null && modules.has(path.module) : p.implementation !== null
    ));
    if (!paths.length) return { status: 'unknown', authority: null, members, evidenceIds: [] } as const;
    accepted.push(p);
  }
  if (members.length < 2) return { status: 'unknown', authority: null, members, evidenceIds: [] } as const;
  const evidenceIds = [...new Set(accepted.flatMap(p => [...p.evidenceIds, ...p.paths.filter(path => path.authority === authority).flatMap(path => path.evidenceIds)]))].sort();
  return { status: 'verified', authority, members, evidenceIds } as const;
}
