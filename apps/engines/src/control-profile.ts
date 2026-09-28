import { z } from 'zod';
import { canonicalize } from '@eko/policy';
import { keccak256, stringToHex } from 'viem';
import { AddressSchema, Bytes32Schema, GuardCursorSchema, AvailabilityCutSchema, CoinCardV2Schema,
  GuardAssessmentCheckSchema, GuardCardMeasurementSchema, FeeComponentsSchema, GUARD_CAPABILITIES, compareGuardCursors, guardKnownBy } from '@eko/shared';
import type { Metric, MetricId, PowerAssessment } from '@eko/shared';

const uint = z.string().regex(/^(0|[1-9]\d*)$/);
const proof = z.array(Bytes32Schema).min(1);
const capability = z.enum(GUARD_CAPABILITIES);
const pin = z.strictObject({ status: z.enum(['verified', 'absent', 'unknown']), address: AddressSchema.nullable(),
  codeHash: Bytes32Schema.nullable(), evidenceIds: z.array(Bytes32Schema) }).superRefine((p, ctx) => {
  if (p.status !== 'unknown' && (!p.evidenceIds.length || (p.status === 'verified' ? !p.address || !p.codeHash : p.address !== null || p.codeHash !== null)))
    ctx.addIssue({ code: 'custom', message: 'Pin requires code or proved absence' });
});
const pins = z.strictObject({ token: pin, curve: pin, proxy: pin, implementation: pin, hook: pin, locker: pin,
  authorityHash: Bytes32Schema.nullable(), authorityEvidenceIds: z.array(Bytes32Schema) });
const configuration = z.strictObject({ launchConfigId: uint.nullable(), launchedAtSec: uint.nullable(), decayEndSec: uint.nullable(),
  decayPolicyHash: Bytes32Schema.nullable(), feePolicyHash: Bytes32Schema.nullable(), recipientScheduleHash: Bytes32Schema.nullable(),
  configurationHash: Bytes32Schema.nullable(), evidenceIds: z.array(Bytes32Schema) });
const probe = z.strictObject({ stateFingerprint: Bytes32Schema, capability, authority: AddressSchema, permissionPathHash: Bytes32Schema,
  boundCode: z.enum(['bounded', 'unrestricted', 'absent']), bound: uint.nullable(), delaySec: uint,
  earliestExecutionSec: uint, revocable: z.boolean().nullable(), queued: z.boolean(), releaseUnits: uint.nullable(),
  success: z.boolean(), beforeHash: Bytes32Schema, afterHash: Bytes32Schema, transactionHash: Bytes32Schema,
  // A rejected setter only corroborates an exhaustive reviewed absence; it never establishes absence alone.
  absenceReviewed: z.boolean(), evidenceIds: proof });
const charge = z.strictObject({ stateFingerprint: Bytes32Schema, direction: z.enum(['buy', 'sell']), account: AddressSchema,
  accountClass: z.enum(['eoa', 'smart_account']), sizeQuoteUnits: uint, quoteAsset: AddressSchema,
  // Buy: debit = reserve credit + recipient payouts. Sell: reserve debit = proceeds + payouts.
  quoteDebitUnits: uint, reserveDeltaUnits: uint, quoteCreditUnits: uint,
  payouts: z.array(z.strictObject({ recipient: AddressSchema, units: uint })),
  breakdown: z.strictObject({ ordinary: uint.nullable(), creator: uint.nullable(), temporary: uint.nullable(), hook: uint.nullable() }),
  evidenceIds: proof });
// TODO(spec): §7.1 has no acquisition envelope for profiles; this closed normalizer-local candidate is versioned independently.
export const PonsControlInputSchema = z.strictObject({ schemaVersion: z.literal('pons-control-input-2'),
  origin: z.enum(['fixture', 'measured']), coin: AddressSchema, launchpad: z.enum(['pons', 'other']), decimals: z.number().int().min(0).max(255),
  cursor: GuardCursorSchema, knownAt: AvailabilityCutSchema, pins, configuration,
  getters: z.strictObject({ creatorTaxBps: uint.nullable(), feeBps: uint.nullable(), currentSnipeTaxBps: uint.nullable(),
    launchedAtSec: uint.nullable(), evidenceIds: z.array(Bytes32Schema) }),
  permissionCoverageComplete: z.boolean(), probes: z.array(probe), charges: z.array(charge), evidenceIds: proof });
export type PonsControlInput = z.infer<typeof PonsControlInputSchema>;
export type ControlProbe = PonsControlInput['probes'][number];
export const ReviewedPonsTemplateSchema = z.strictObject({ schemaVersion: z.literal('pons-template-2'),
  coin: AddressSchema, origin: z.enum(['fixture', 'measured']), sourceRevision: Bytes32Schema,
  stateFingerprint: Bytes32Schema, reviewed: z.literal(true), evidenceIds: proof });
export type ReviewedPonsTemplate = z.infer<typeof ReviewedPonsTemplateSchema>;
export const PonsControlSnapshotSchema = z.strictObject({ schemaVersion: z.literal('pons-control-2'), methodVersion: z.literal('2.0.0'),
  origin: z.enum(['fixture', 'measured']), coin: AddressSchema, cursor: GuardCursorSchema, knownAt: AvailabilityCutSchema,
  profileHash: Bytes32Schema, stateFingerprint: Bytes32Schema, templateRevision: Bytes32Schema.nullable(), pins, configuration,
  getters: PonsControlInputSchema.shape.getters, probes: z.array(probe), chargeObservations: z.array(charge),
  permissionCoverageComplete: z.boolean(), horizonSec: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), control: CoinCardV2Schema.shape.control,
  charges: z.array(z.strictObject({ direction: z.enum(['buy', 'sell']), account: AddressSchema,
    accountClass: z.enum(['eoa', 'smart_account']), sizeQuoteUnits: uint, quoteAsset: AddressSchema, fees: FeeComponentsSchema })),
  checks: z.array(GuardAssessmentCheckSchema), evidenceIds: proof });
export type PonsControlSnapshot = z.infer<typeof PonsControlSnapshotSchema>;
export const controlProfileHash = (value: unknown) => keccak256(stringToHex(canonicalize(value)));
/** Exact token/curve, implementation, authority, config, hook and custody binding. No codehash-only inheritance. */
export const controlStateFingerprint = (input: PonsControlInput) => controlProfileHash({ coin: input.coin, launchpad: input.launchpad,
  cursor: input.cursor, pins: input.pins, configuration: input.configuration, getters: input.getters });

export function controlEvidenceIds(i: PonsControlInput, t?: ReviewedPonsTemplate) {
  return [...new Set([...i.evidenceIds, ...i.getters.evidenceIds, ...i.configuration.evidenceIds,
    ...i.pins.authorityEvidenceIds, ...[i.pins.token, i.pins.curve, i.pins.proxy, i.pins.implementation, i.pins.hook, i.pins.locker].flatMap(p => p.evidenceIds),
    ...i.probes.flatMap(p => p.evidenceIds), ...i.charges.flatMap(p => p.evidenceIds), ...(t?.evidenceIds ?? [])])].sort();
}

function pct(n: bigint, d: bigint) {
  const scaled = n * 100n * 10n ** 18n / d, fraction = (scaled % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
  return `${scaled / 10n ** 18n}${fraction ? `.${fraction}` : ''}`;
}
/** Pure captured-input evaluation. Selector/no-op/getter/zero-owner evidence does not establish a power. */
export function assessPonsControlProfile(raw: PonsControlInput, reviewed?: ReviewedPonsTemplate, horizonSec = 3600): PonsControlSnapshot {
  const i = PonsControlInputSchema.parse(raw), { cursor, knownAt } = i;
  if (!Number.isSafeInteger(horizonSec) || horizonSec < 0 || cursor.chainId !== 4663 || cursor.boundary !== 'block_end' ||
    compareGuardCursors(cursor, knownAt.cursor) > 0 || !guardKnownBy({ cursor, acquisitionSequence: '0' }, knownAt)) throw new Error('Invalid profile capture boundary');
  if (i.pins.token.address !== i.coin) throw new Error('Profile token pin mismatch');
  if (new Set(i.probes.map(p => p.capability)).size !== i.probes.length) throw new Error('Duplicate capability probe');
  const stateFingerprint = controlStateFingerprint(i), t = reviewed ? ReviewedPonsTemplateSchema.parse(reviewed) : null;
  const matched = i.launchpad === 'pons' && t?.coin === i.coin && t.origin === i.origin && t.stateFingerprint === stateFingerprint;
  const allPins = Object.values(i.pins).filter((p): p is z.infer<typeof pin> => typeof p === 'object' && p !== null && 'status' in p);
  const pinned = allPins.every(p => p.status !== 'unknown') && i.pins.token.status === 'verified' &&
    i.pins.curve.status === 'verified' && i.pins.implementation.status === 'verified' &&
    i.pins.authorityHash !== null && i.pins.authorityEvidenceIds.length > 0;
  const c = i.configuration;
  const scheduled = Object.values(c).every(v => v !== null) && c.evidenceIds.length > 0 && i.getters.evidenceIds.length > 0 &&
    i.getters.launchedAtSec === c.launchedAtSec && BigInt(c.decayEndSec!) >= BigInt(c.launchedAtSec!) &&
    [i.getters.creatorTaxBps, i.getters.feeBps, i.getters.currentSnipeTaxBps].every(v => v !== null && BigInt(v) <= 10000n);
  const trusted = matched && pinned && scheduled;
  const evidenceIds = controlEvidenceIds(i, matched ? t! : undefined);
  const coverage = (complete: boolean, scopeId: string) => ({ scopeId, from: cursor, through: cursor, complete,
    gaps: complete ? [] : ['unsupported' as const], methodVersion: '2.0.0', coveredUnits: null, excludedUnits: null,
    topLevelNative: false, internalNative: false, firstEverEstablished: false, sourceHashes: evidenceIds });
  const metric = <T>(id: MetricId, value: T | null, unit: Metric<T>['unit'], ids = evidenceIds): Metric<T> => ({
    id, unit, cursor, knownAt, numerator: null, denominator: null, denominatorKind: null, fromSec: null, throughSec: cursor.timestampSec,
    coverage: coverage(value !== null, id), methodVersion: '2.0.0', evidenceIds: ids,
    ...(value === null ? { status: 'unknown', value: null, failureCode: 'unsupported' } : { status: 'observed', value, failureCode: null }),
  } as Metric<T>);
  const horizon = BigInt(cursor.timestampSec) + BigInt(horizonSec);
  const verified = (p: ControlProbe) => p.stateFingerprint === stateFingerprint && trusted && i.permissionCoverageComplete &&
    (p.boundCode === 'absent' ? p.absenceReviewed && !p.success && p.beforeHash === p.afterHash :
      p.revocable !== null && p.success && p.beforeHash !== p.afterHash && (p.boundCode !== 'bounded' || p.bound !== null)) &&
    BigInt(p.earliestExecutionSec) >= BigInt(cursor.timestampSec) + BigInt(p.delaySec);
  const powers: PowerAssessment[] = GUARD_CAPABILITIES.map(cap => {
    const p = i.probes.find(p => p.capability === cap), valid = !!p && verified(p), ids = valid ? p.evidenceIds : evidenceIds;
    return { capability: cap, reachable: metric('powers', valid ? p.boundCode !== 'absent' : null, 'boolean', ids),
      authority: metric('currentController', valid ? p.authority : null, 'address', ids), boundCode: valid ? p.boundCode : 'unknown',
      bound: metric('controlBound', valid ? p.bound : null, 'decimal', ids), delaySec: metric('controlDelay', valid ? p.delaySec : null, 'seconds', ids),
      earliestExecution: metric('earliestExecution', valid ? p.earliestExecutionSec : null, 'seconds', ids),
      implementationHash: i.pins.implementation.codeHash, configurationHash: c.configurationHash, evidenceIds: ids };
  });
  const controlsComplete = trusted && i.permissionCoverageComplete && powers.every(p => p.reachable.value !== null);
  const queued = i.probes.filter(p => verified(p) && p.queued && p.boundCode !== 'absent');
  const releasesKnown = controlsComplete && queued.filter(p => p.capability === 'unlock' || p.capability === 'mint').every(p => p.releaseUnits !== null);
  const release = releasesKnown ? queued.filter(p => BigInt(p.earliestExecutionSec) <= horizon && ['unlock', 'mint'].includes(p.capability))
    .reduce((sum, p) => sum + BigInt(p.releaseUnits!), 0n).toString() : null;
  let feesComplete = trusted && powers.find(p => p.capability === 'tax_raise')?.reachable.value !== null && i.charges.length > 0;
  const charges = i.charges.map(q => {
    const debit = BigInt(q.quoteDebitUnits), reserve = BigInt(q.reserveDeltaUnits), credit = BigInt(q.quoteCreditUnits);
    const payouts = q.payouts.reduce((n, p) => n + BigInt(p.units), 0n), base = q.direction === 'buy' ? debit : reserve;
    const reconciled = q.stateFingerprint === stateFingerprint && trusted && base > 0n && BigInt(q.sizeQuoteUnits) > 0n &&
      (q.direction === 'buy' ? debit === reserve + payouts && credit === 0n : reserve === credit + payouts && debit === 0n);
    const parts = Object.values(q.breakdown), breakdownKnown = parts.every(v => v !== null);
    const knownParts = parts.reduce<bigint>((n, v) => n + BigInt(v ?? '0'), 0n);
    const breakdownValid = breakdownKnown ? knownParts === payouts : knownParts <= payouts;
    feesComplete &&= reconciled && breakdownValid;
    const fee = (units: string | null): Metric<string> => {
      if (!reconciled || !breakdownValid || units === null) return metric<string>('feeTotal', null, 'pct', q.evidenceIds);
      return { ...metric('feeTotal', pct(BigInt(units), base), 'pct', q.evidenceIds), numerator: units, denominator: base.toString(), denominatorKind: 'quote_cost',
        errorBounds: { lower: { numerator: '0', denominator: '1' }, upper: { numerator: '1', denominator: (10n ** 18n).toString() } } };
    };
    return { direction: q.direction, account: q.account, accountClass: q.accountClass, sizeQuoteUnits: q.sizeQuoteUnits, quoteAsset: q.quoteAsset,
      fees: { total: fee(payouts.toString()), ordinary: { ...fee(q.breakdown.ordinary), id: 'feeOrdinary' }, creator: { ...fee(q.breakdown.creator), id: 'feeCreator' },
        temporary: { ...fee(q.breakdown.temporary), id: 'feeTemporary' }, hook: { ...fee(q.breakdown.hook), id: 'feeHook' }, eko: metric<string>('feeEko', null, 'pct'), gas: metric<string>('feeGas', null, 'pct') } };
  });
  // Per-account/size totals never imply a complete untested direction or account class.
  feesComplete &&= ['eoa', 'smart_account'].every(a => charges.some(q => q.accountClass === a)) &&
    charges.every(q => ['buy', 'sell'].every(d => charges.some(other => other.direction === d && other.account === q.account &&
      other.accountClass === q.accountClass && other.sizeQuoteUnits === q.sizeQuoteUnits && other.quoteAsset === q.quoteAsset)));
  if (new Set(i.charges.map(q => `${q.direction}:${q.account}:${q.accountClass}:${q.sizeQuoteUnits}:${q.quoteAsset}`)).size !== i.charges.length)
    throw new Error('Duplicate effective charge scope');
  const checks = (['controls_hooks', 'effective_fees'] as const).map(id => {
    const complete = id === 'controls_hooks' ? controlsComplete : feesComplete;
    return { id, tier: 'buy_critical' as const, status: complete ? 'complete' as const : 'unsupported' as const,
      coverage: coverage(complete, id), evidenceIds, failureCode: complete ? null : 'unsupported' as const };
  });
  const controller = [...new Set(i.probes.filter(verified).filter(p => p.boundCode !== 'absent').map(p => p.authority))];
  const snapshot = { schemaVersion: 'pons-control-2', methodVersion: '2.0.0', origin: i.origin, coin: i.coin, cursor, knownAt,
    stateFingerprint, templateRevision: matched ? t!.sourceRevision : null, pins: i.pins, configuration: c, getters: i.getters, probes: i.probes, chargeObservations: i.charges, permissionCoverageComplete: i.permissionCoverageComplete, horizonSec,
    control: { powers, currentController: metric('currentController', controller.length === 1 ? controller[0]! : null, 'address'),
      releasableByHorizon: metric('releasableByHorizon', release === null ? null : { asset: i.coin, decimals: i.decimals, raw: release }, 'raw'),
      queuedChanges: queued.map(p => ({ id: controlProfileHash(p), capability: p.capability,
        authority: metric('currentController', p.authority, 'address', p.evidenceIds),
        earliestExecution: metric('earliestExecution', p.earliestExecutionSec, 'seconds', p.evidenceIds),
        units: metric('releasableByHorizon', p.releaseUnits === null ? null : { asset: i.coin, decimals: i.decimals, raw: p.releaseUnits }, 'raw', p.evidenceIds),
        bound: metric('controlBound', p.bound, 'decimal', p.evidenceIds), evidenceIds: p.evidenceIds })) }, charges, checks, evidenceIds };
  return PonsControlSnapshotSchema.parse({ ...snapshot, profileHash: controlProfileHash(snapshot) });
}

/** Existing packet-035 card envelope, with no account/size fee aggregation or invented reference-exit results. */
export function controlCardMeasurements(raw: PonsControlSnapshot) {
  const s = PonsControlSnapshotSchema.parse(raw);
  if (s.origin !== 'measured') throw new Error('Fixture profile cannot complete a card measurement');
  return GuardCardMeasurementSchema.parse({ schemaVersion: 'guard-card-measurements-2', coin: s.coin, cursor: s.cursor,
    knownAt: s.knownAt, control: s.control,
    collectionCoverage: { queuedChanges: s.checks.find(c => c.id === 'controls_hooks')!.coverage } });
}
