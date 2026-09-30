import { z } from 'zod';
import { AddressSchema, Bytes32Schema, GuardCursorSchema, AvailabilityCutSchema, GuardCoverageSchema,
  SupplySnapshotV2Schema, compareGuardCursors, guardKnownBy } from '@eko/shared';
import type { Address, Metric, RawAmount, SupplySnapshotV2, MetricId } from '@eko/shared';
import { LaunchRoleSnapshotSchema } from '@eko/chain';
import { GraduationInventoryInputSchema, reconcileGraduationInventory } from './graduation-inventory.js';

export const SUPPLY_METHOD_VERSION = '2.0.0' as const;
const uint = z.string().regex(/^(0|[1-9]\d*)$/);
const proof = { cursor: GuardCursorSchema, knownAt: AvailabilityCutSchema, evidenceIds: z.array(Bytes32Schema).min(1) };
// TODO(spec): the supplied-input envelope is not specified; keep it local until the source collector binds it.
export const SupplyBasicsInputSchema = z.strictObject({
  coin: AddressSchema, decimals: z.number().int().min(0).max(255), cursor: GuardCursorSchema, knownAt: AvailabilityCutSchema,
  launch: LaunchRoleSnapshotSchema,
  transfers: z.array(z.strictObject({ ...proof, id: z.string().min(1), from: AddressSchema, to: AddressSchema, amount: uint })),
  transferCoverage: GuardCoverageSchema, fromDeployment: z.boolean(), semantics: z.enum(['standard_erc20', 'unsupported']),
  totalSupplyRead: z.strictObject({ ...proof, total: uint }).optional(),
  classificationCoverage: GuardCoverageSchema,
  sinks: z.array(z.strictObject({ ...proof, address: AddressSchema, irrecoverable: z.literal(true) })),
  locks: z.array(z.strictObject({ ...proof, address: AddressSchema, unavailable: uint, revocable: z.boolean() })),
  inventory: z.strictObject({ ...proof, stage: z.enum(['curve', 'graduated', 'unknown']), curve: AddressSchema.nullable(),
    curveOnly: z.boolean(), graduation: GraduationInventoryInputSchema.optional() }),
});
export type SupplyBasicsInput = z.infer<typeof SupplyBasicsInputSchema>;
const zero: Address = `0x${'0'.repeat(40)}`;
const sameState = (a: SupplyBasicsInput['cursor'], b: SupplyBasicsInput['cursor']) => compareGuardCursors(a, b) === 0;

/** Bounded decimal presentation; exact numerator/denominator remain on every ratio. No Number conversion of units. */
function percent(n: bigint, d: bigint): string {
  const scaled = n * 100n * 10n ** 36n / d;
  const fraction = (scaled % (10n ** 36n)).toString().padStart(36, '0').replace(/0+$/, '');
  return `${scaled / (10n ** 36n)}${fraction ? `.${fraction}` : ''}`;
}

/** Pure supplied-transfer adapter. Legacy cards/holdings/scores and mutable total_supply rows are never rewritten. */
export function reconcileSupplyBasicsV2(raw: SupplyBasicsInput): SupplySnapshotV2 {
  const input = SupplyBasicsInputSchema.parse(raw), { coin, cursor, knownAt } = input;
  if (cursor.boundary !== 'block_end' || compareGuardCursors(cursor, knownAt.cursor) > 0)
    throw new Error('Supply requires a captured completed block-end state');
  if (input.launch.coin !== coin || input.launch.launchpad !== 'pons' || compareGuardCursors(input.launch.cursor, cursor) > 0)
    throw new Error('Supply requires matching Pons launch evidence');
  const available = (source: { cursor: typeof cursor; knownAt: typeof knownAt }) =>
    compareGuardCursors(source.cursor, cursor) <= 0 && compareGuardCursors(source.cursor, source.knownAt.cursor) <= 0 && guardKnownBy(source.knownAt, knownAt);
  const atState = (source: { cursor: typeof cursor; knownAt: typeof knownAt }) => {
    if (!available(source) || !sameState(source.cursor, cursor)) throw new Error('Supply classification is not at the captured state');
  };
  atState(input.inventory);
  for (const source of [...input.sinks, ...input.locks]) atState(source);
  if (input.totalSupplyRead && !available(input.totalSupplyRead)) throw new Error('Supply read exceeds captured state/availability');
  for (const coverage of [input.transferCoverage, input.classificationCoverage]) {
    if (!coverage.through || !sameState(coverage.through, cursor) || coverage.from && compareGuardCursors(coverage.from, cursor) > 0)
      throw new Error('Supply coverage boundary mismatch');
  }
  const issues: SupplySnapshotV2['issues'] = [];
  const transfers = input.transfers.filter(available).slice().sort((a, b) => compareGuardCursors(a.cursor, b.cursor) || a.id.localeCompare(b.id));
  if (new Set(transfers.map(t => t.id)).size !== transfers.length) throw new Error('Duplicate transfer observation');
  if (input.transferCoverage.from && transfers.some(t => compareGuardCursors(t.cursor, input.transferCoverage.from!) < 0))
    throw new Error('Transfer precedes declared source boundary');
  const balances = new Map<Address, bigint>();
  let minted = 0n, burned = 0n;
  let sampledSupply = 0n;
  const supported = input.semantics === 'standard_erc20';
  const hiddenTransfers = input.transfers.some(t => compareGuardCursors(t.cursor, cursor) <= 0 && !available(t));
  const complete = supported && input.fromDeployment && input.transferCoverage.complete && input.transferCoverage.from !== null && !hiddenTransfers;
  if (!supported) issues.push('unsupported_semantics');
  if (!complete) issues.push('incomplete_transfers');
  for (const t of transfers) {
    const amount = BigInt(t.amount);
    if (amount > 0n && t.from === zero && t.to === zero) issues.push('supply_mismatch');
    if (t.from === zero) minted += amount;
    else balances.set(t.from, (balances.get(t.from) ?? 0n) - amount);
    if (t.to === zero) burned += amount;
    else balances.set(t.to, (balances.get(t.to) ?? 0n) + amount);
    if (input.totalSupplyRead && compareGuardCursors(t.cursor, input.totalSupplyRead.cursor) <= 0)
      sampledSupply += (t.from === zero ? amount : 0n) - (t.to === zero ? amount : 0n);
  }
  if ([...balances.values()].some(n => n < 0n)) issues.push('negative_balance');
  let S: bigint | null = complete ? minted - burned : input.totalSupplyRead && sameState(input.totalSupplyRead.cursor, cursor)
    ? BigInt(input.totalSupplyRead.total) : null;
  if (complete && (S! < 0n || input.totalSupplyRead && sampledSupply !== BigInt(input.totalSupplyRead.total))) {
    issues.push('supply_mismatch'); S = null;
  }
  const sinks = new Set(input.sinks.map(s => s.address));
  if (sinks.has(zero)) throw new Error('True burns are absent from total supply, not sink inventory');
  const locks = new Map<Address, bigint>();
  if (new Set(input.locks.map(l => l.address)).size !== input.locks.length) throw new Error('Duplicate lock classification');
  for (const l of input.locks) if (!l.revocable && !sinks.has(l.address)) locks.set(l.address, BigInt(l.unavailable));
  if ([...locks].some(([a, n]) => n > (balances.get(a) ?? 0n))) issues.push('invalid_lock');
  const inventory = input.inventory;
  const curveKnown = inventory.stage === 'curve' && inventory.curve !== null && inventory.curveOnly;
  const graduation = inventory.stage === 'graduated' && inventory.graduation ? reconcileGraduationInventory(inventory.graduation) : null;
  if (graduation && (graduation.coin !== coin || !sameState(graduation.cursor, cursor) || graduation.cursor.blockHash !== cursor.blockHash ||
    !guardKnownBy(graduation.knownAt, knownAt) || graduation.migration.oldCurve !== inventory.curve)) throw new Error('Supply graduation binding mismatch');
  const graduationKnown = graduation?.inventoryComplete === true;
  const market = new Map(graduationKnown ? graduation!.marketByAddress.map(p => [p.address, BigInt(p.units)] as const) : []);
  if (graduationKnown && graduation!.excess.lockedUnits !== '0') {
    const a = graduation!.excess.address, n = BigInt(graduation!.excess.lockedUnits!);
    if (sinks.has(a) || locks.has(a) && locks.get(a) !== n) issues.push('invalid_lock');
    else locks.set(a, n); // Underlying market positions never enter K; only observed non-market excess does.
  }
  if ([...market].some(([a, n]) => sinks.has(a) || n + BigInt(graduation!.marketByAddress.find(p => p.address === a)!.feeUnits) + (locks.get(a) ?? 0n) > (balances.get(a) ?? 0n)) ||
    [...locks].some(([a, n]) => n > (balances.get(a) ?? 0n))) issues.push('invalid_lock');
  if (graduationKnown && (balances.get(inventory.curve!) ?? 0n) !== BigInt(inventory.graduation!.after.tokenInventory)) issues.push('supply_mismatch');
  if (graduation?.invalid.length) issues.push('supply_mismatch');
  if (inventory.stage === 'graduated' && !graduationKnown) issues.push('unsupported_graduation');
  else if (!curveKnown && !graduationKnown) issues.push('unproved_inventory');
  if (!input.classificationCoverage.complete) issues.push('incomplete_classification');
  const invalid = issues.some(i => ['negative_balance', 'supply_mismatch', 'invalid_lock'].includes(i));
  const balancesKnown = complete && !issues.includes('negative_balance');
  const classified = balancesKnown && !invalid && input.classificationCoverage.complete;
  const D = classified ? [...balances].reduce((n, [a, b]) => n + (sinks.has(a) ? b : 0n), 0n) : null;
  const K = classified ? [...locks.values()].reduce((n, v) => n + v, 0n) : null;
  const U = classified && graduationKnown ? 0n : classified && curveKnown ? sinks.has(inventory.curve!) ? 0n : (balances.get(inventory.curve!) ?? 0n) - (locks.get(inventory.curve!) ?? 0n) : null;
  const P = classified && graduationKnown ? BigInt(graduation!.poolInventory!) : classified && curveKnown ? 0n : null;
  let C = S !== null && D !== null && K !== null && U !== null ? S - D - K - U : null;
  let F = C !== null && P !== null ? C - P : null;
  if (C !== null && C < 0n || F !== null && F < 0n) { issues.push('negative_float'); C = F = null; }
  const floatState: SupplySnapshotV2['floatState'] = invalid || issues.includes('negative_float') ? 'unreconciled' :
    F === null || S === null ? 'unknown' : F === 0n ? 'zero' : F * 100n < S * 2n ? 'small' : 'stable';
  const failure = floatState === 'unreconciled' ? 'unreconciled' : !supported || !curveKnown && !graduationKnown ? 'unsupported' : 'missing';
  const checkComplete = floatState === 'stable' && (!graduation || graduation.origin === 'measured');
  const checkFailure = graduation?.origin === 'fixture' && floatState === 'stable' ? 'unsupported' : failure;
  const evidenceIds = [...new Set([...transfers.flatMap(t => t.evidenceIds), ...(input.totalSupplyRead?.evidenceIds ?? []),
    ...input.sinks.flatMap(s => s.evidenceIds), ...input.locks.flatMap(l => l.evidenceIds), ...inventory.evidenceIds, ...(graduation?.evidenceIds ?? [])])].sort();
  const quantity = (n: bigint): RawAmount => ({ asset: coin, decimals: input.decimals, raw: n.toString() });
  function metric<T>(id: MetricId, value: T | null, unit: Metric<T>['unit'], numerator: RawAmount | null = null,
    denominator: RawAmount | null = null, denominatorKind: Metric<T>['denominatorKind'] = null): Metric<T> {
    return { id, unit, cursor, knownAt, numerator, denominator, denominatorKind, fromSec: input.transferCoverage.from?.timestampSec ?? null,
      throughSec: cursor.timestampSec, coverage: { ...input.transferCoverage, scopeId: `supply-${id}`,
        complete: value !== null, gaps: value === null ? [failure] : [] }, methodVersion: SUPPLY_METHOD_VERSION, evidenceIds,
      ...(value === null ? { status: 'unknown' as const, value: null, failureCode: failure } : { status: 'observed' as const, value, failureCode: null }) };
  }
  const units = (id: MetricId, n: bigint | null) => metric(id, n === null ? null : quantity(n), 'raw');
  const ratio = (id: MetricId, n: bigint | null, d: bigint | null, kind: 'S' | 'F' | 'other') => {
    const result = metric(id, n !== null && d !== null && d > 0n ? percent(n, d) : null, 'pct',
      n === null ? null : quantity(n), d !== null && d > 0n ? quantity(d) : null, kind);
    // Presentation truncates downward at 36 decimal places; exact rational inputs drive comparisons.
    return result.status === 'observed' ? { ...result, errorBounds: {
      lower: { numerator: '0', denominator: '1' }, upper: { numerator: '1', denominator: (10n ** 36n).toString() },
    } } : result;
  };
  const holdings = [...balances].filter(([, n]) => n !== 0n).sort(([a], [b]) => a.localeCompare(b)).map(([address, raw]) => {
    const marketUnits = market.get(address) ?? 0n;
    const bucket = sinks.has(address) ? 'sink' as const : marketUnits > 0n && raw === marketUnits ? 'pool' as const :
      inventory.curve === address && !graduationKnown ? 'curve' as const : 'external' as const;
    const locked = classified ? sinks.has(address) ? 0n : locks.get(address) ?? 0n : null;
    const liquid = locked !== null ? bucket === 'sink' || bucket === 'pool' ? 0n : bucket === 'curve' ? curveKnown ? 0n : null : raw - locked - marketUnits : null;
    return { address, bucket, raw: units('raw', balancesKnown ? raw : null), locked: units('locked', locked),
      liquid: units('liquid', liquid), supplyPct: ratio('supplyPct', liquid, S, 'S'),
      floatPct: ratio('floatPct', floatState === 'stable' ? liquid : null, F, 'F') };
  });
  const external = holdings.filter(h => h.bucket === 'external' && h.liquid.status === 'observed' && BigInt(h.liquid.value.raw) > 0n)
    .sort((a, b) => BigInt(a.liquid.value!.raw) === BigInt(b.liquid.value!.raw) ? a.address.localeCompare(b.address) :
      BigInt(a.liquid.value!.raw) > BigInt(b.liquid.value!.raw) ? -1 : 1);
  const top = external.slice(0, 10), topUnits = top.reduce((n, h) => n + BigInt(h.liquid.value!.raw), 0n);
  const supply = { minted: units('minted', complete && !invalid ? minted : null), total: units('total', S),
    sinks: units('sinks', D), locked: units('locked', K), curveInventory: units('curveInventory', U), poolInventory: units('poolInventory', P),
    circulating: units('circulating', C), holderFloat: units('holderFloat', F),
    burnedPct: ratio('burnedPct', complete && !invalid && S !== null && D !== null ? minted - S + D : null, complete ? minted : null, 'other'),
    holders: metric('holders', classified && (curveKnown || graduationKnown) ? external.length : null, 'count'),
    top10RawPct: ratio('topAddress10', floatState === 'stable' ? topUnits : null, F, 'F'),
    rawTop10: top.map(h => ({ address: h.address, groupId: null, units: h.liquid })),
  };
  return SupplySnapshotV2Schema.parse({ schemaVersion: 'supply-2', methodVersion: SUPPLY_METHOD_VERSION, capSemanticsVersion: '2.0.0',
    coin, cursor, knownAt, supply, holdings, floatState, issues,
    check: { id: 'supply_float', tier: 'buy_critical', status: checkComplete ? 'complete' : checkFailure === 'unreconciled' ? 'failed' : checkFailure === 'unsupported' ? 'unsupported' : 'missing',
      coverage: { ...input.transferCoverage, scopeId: 'supply_float', complete: checkComplete, gaps: checkComplete ? [] : [checkFailure] },
      evidenceIds, failureCode: checkComplete ? null : checkFailure } });
}
