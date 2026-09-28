import { z } from 'zod';
import { AddressSchema, Bytes32Schema, GuardCursorSchema, AvailabilityCutSchema, compareGuardCursors, guardKnownBy } from '@eko/shared';
import { referenceDigest, removalDepth, type LocalDepthRoute, type ValidatedDepthPosition } from '@eko/chain';
import { PonsControlSnapshotSchema, controlProfileHash } from './control-profile.js';

const uint = z.string().regex(/^(0|[1-9]\d*)$/);
const signed = z.string().regex(/^(0|-?[1-9]\d*)$/);
const proof = { cursor: GuardCursorSchema, knownAt: AvailabilityCutSchema, evidenceIds: z.array(Bytes32Schema).min(1) };
const custody = z.strictObject({ owner: AddressSchema, controller: AddressSchema.nullable(), locker: AddressSchema.nullable(), lockerCodeHash: Bytes32Schema.nullable(),
  reviewed: z.boolean(), revocable: z.boolean().nullable(), unlockAtSec: uint.nullable() });
const position = z.strictObject({ id: Bytes32Schema, poolId: Bytes32Schema, lowerTick: z.number().int(), upperTick: z.number().int(),
  liquidity: uint, custody, evidenceIds: z.array(Bytes32Schema).min(1) });
const pool = z.strictObject({ ...proof, id: Bytes32Schema, manager: AddressSchema, managerCodeHash: Bytes32Schema,
  token: AddressSchema, quoteAsset: AddressSchema, hook: AddressSchema.nullable(), hookCodeHash: Bytes32Schema.nullable(), venue: z.enum(['uniswap_v3', 'uniswap_v4']),
  // Tradable inventory and fees are different claims on custody. Never infer either from manager-wide balances.
  inventorySource: z.enum(['per_pool_settlement', 'manager_balance']), tokenInventory: uint, quoteInventory: uint,
  tokenFees: uint, quoteFees: uint, settlementReviewed: z.boolean(), positionsComplete: z.boolean(),
  migrationCredit: z.strictObject({ transactionHash: Bytes32Schema, tokens: uint, quote: uint }).nullable(),
  tickSpacing: z.number().int().positive().max(887272), currentTick: z.number().int().min(-887272).max(887272), activeLiquidity: uint,
  ticks: z.array(z.strictObject({ tick: z.number().int(), liquidityNet: signed })), positions: z.array(position),
  exit: z.strictObject({ status: z.enum(['executed', 'inaccessible', 'unknown']), buyerReachable: z.boolean().nullable(),
    accountClass: z.enum(['eoa', 'smart_account']), sizeUsd: z.literal(100), tokenInput: uint, netQuoteOutput: uint,
    evidenceIds: z.array(Bytes32Schema) }) });

// TODO(spec): no deployed migration/locker fixture or acquisition envelope is supplied. This local reviewed-input
// boundary is not an event decoder; raw calls/logs, settlement and custody review must accompany measured inputs.
export const GraduationInventoryInputSchema = z.strictObject({ schemaVersion: z.literal('graduation-input-1'),
  origin: z.enum(['fixture', 'measured']), coin: AddressSchema, cursor: GuardCursorSchema, knownAt: AvailabilityCutSchema,
  profile: PonsControlSnapshotSchema, routeDiscoveryComplete: z.boolean(), inventoryCoverageComplete: z.boolean(),
  migration: z.strictObject({ ...proof, reviewed: z.boolean(), transactionHash: Bytes32Schema, factory: AddressSchema,
    factoryCodeHash: Bytes32Schema, sourceRevision: Bytes32Schema, oldCurve: AddressSchema, quoteAsset: AddressSchema, successorPoolId: Bytes32Schema,
    positionId: Bytes32Schema, mintedLiquidity: uint, depositedTokens: uint, depositedQuote: uint,
    tokenPayouts: uint, quotePayouts: uint }),
  before: z.strictObject({ ...proof, tokenInventory: uint, realQuoteReserve: uint, sellableTokens: uint, readyToGraduate: z.boolean() }),
  after: z.strictObject({ ...proof, tokenInventory: uint, realQuoteReserve: uint, sellableTokens: uint, readyToGraduate: z.boolean() }),
  excess: z.strictObject({ ...proof, address: AddressSchema, units: uint, custody }),
  pools: z.array(pool),
});
export type GraduationInventoryInput = z.infer<typeof GraduationInventoryInputSchema>;
const same = (a: GraduationInventoryInput['cursor'], b: GraduationInventoryInput['cursor']) => referenceDigest(a) === referenceDigest(b);

function custodyStatus(c: z.infer<typeof custody>, now: string) {
  if (!c.reviewed || c.revocable === null || c.controller === null || (c.locker !== null) !== (c.lockerCodeHash !== null)) return 'unknown' as const;
  if (c.locker !== null && !c.revocable && c.unlockAtSec === null) return 'unknown' as const;
  if (c.locker !== null && c.owner === c.locker && !c.revocable && c.unlockAtSec !== null && BigInt(c.unlockAtSec) > BigInt(now)) return 'locked' as const;
  // Expired/revocable locks are liquid; no address or locked position is described as burned.
  return 'removable' as const;
}

/** Pure observed-checkpoint reconciliation. No reserve fractions, price-threshold graduation or RPC search. */
export function reconcileGraduationInventory(raw: GraduationInventoryInput) {
  const i = GraduationInventoryInputSchema.parse(raw), { cursor, knownAt, migration: m, profile } = i;
  if (cursor.chainId !== 4663 || cursor.boundary !== 'block_end' || compareGuardCursors(cursor, knownAt.cursor) > 0)
    throw new Error('Invalid graduation capture');
  const available = (p: { cursor: typeof cursor; knownAt: typeof knownAt }) => compareGuardCursors(p.cursor, cursor) <= 0 &&
    compareGuardCursors(p.cursor, p.knownAt.cursor) <= 0 && guardKnownBy(p.knownAt, knownAt);
  for (const p of [m, i.before, i.after, i.excess, profile, ...i.pools]) if (!available(p)) throw new Error('Graduation evidence exceeds capture');
  if (![i.after, i.excess, ...i.pools].every(p => same(p.cursor, cursor)) || !same(i.before.cursor, profile.cursor) ||
    compareGuardCursors(i.before.cursor, m.cursor) >= 0) throw new Error('Graduation state pin mismatch');
  const { profileHash, ...body } = profile;
  if (controlProfileHash(body) !== profileHash) throw new Error('Graduation profile digest mismatch');
  if (profile.coin !== i.coin || profile.origin !== i.origin || profile.pins.curve.address !== m.oldCurve)
    throw new Error('Graduation profile binding mismatch');
  if (new Set(i.pools.map(p => p.id)).size !== i.pools.length || new Set(i.pools.flatMap(p => p.positions.map(q => q.id))).size !== i.pools.flatMap(p => p.positions).length)
    throw new Error('Duplicate graduation pool/position');
  const gaps: string[] = [];
  const invalid: string[] = [];
  if (!m.reviewed || profile.templateRevision === null || profile.checks.some(c => c.status !== 'complete')) gaps.push('unreviewed_migration_profile');
  if (!i.inventoryCoverageComplete || !i.routeDiscoveryComplete) gaps.push('route_inventory_coverage');
  if (!i.before.readyToGraduate || i.before.sellableTokens !== '0' || !i.after.readyToGraduate || i.after.sellableTokens !== '0') invalid.push('graduation_readiness');
  if (BigInt(i.before.tokenInventory) !== BigInt(i.after.tokenInventory) + BigInt(m.depositedTokens) + BigInt(i.excess.units) + BigInt(m.tokenPayouts) ||
    BigInt(i.before.realQuoteReserve) !== BigInt(i.after.realQuoteReserve) + BigInt(m.depositedQuote) + BigInt(m.quotePayouts)) invalid.push('handoff_conservation');
  // This bounded adapter accepts only an emptied old curve, never silently treats a residual as U or K.
  if (i.after.tokenInventory !== '0' || i.after.realQuoteReserve !== '0') gaps.push('old_curve_residual');
  const successor = i.pools.find(p => p.id === m.successorPoolId);
  const minted = successor?.positions.find(p => p.id === m.positionId);
  if (!successor || successor.venue !== 'uniswap_v4' || !minted) gaps.push('successor_position_missing');
  else {
    if (successor.quoteAsset !== m.quoteAsset) invalid.push('successor_quote_binding');
    if (successor.migrationCredit?.transactionHash !== m.transactionHash || successor.migrationCredit.tokens !== m.depositedTokens ||
      successor.migrationCredit.quote !== m.depositedQuote) invalid.push('successor_settlement_binding');
    const max = Math.floor(887272 / successor.tickSpacing) * successor.tickSpacing;
    if (minted.lowerTick !== -max || minted.upperTick !== max || minted.liquidity !== m.mintedLiquidity || minted.liquidity === '0') invalid.push('successor_full_range');
    if (profile.pins.locker.status !== 'verified' || minted.custody.locker !== profile.pins.locker.address || minted.custody.owner !== minted.custody.locker)
      gaps.push('locker_binding');
    if (minted.custody.lockerCodeHash !== profile.pins.locker.codeHash || successor.hook !== profile.pins.hook.address ||
      successor.hookCodeHash !== profile.pins.hook.codeHash || profile.pins.hook.status === 'unknown') gaps.push('successor_code_binding');
  }
  const positions = i.pools.flatMap(p => p.positions.map(q => ({ ...q, custodyStatus: custodyStatus(q.custody, cursor.timestampSec) })));
  for (const p of i.pools) {
    if (p.token !== i.coin || p.quoteAsset === i.coin) invalid.push('pool_asset_binding');
    if (p.inventorySource !== 'per_pool_settlement' || !p.settlementReviewed) gaps.push('per_pool_inventory');
    if (!p.positionsComplete) gaps.push('position_coverage');
    if (p.positions.some(q => q.poolId !== p.id || q.lowerTick >= q.upperTick || Math.abs(q.lowerTick) > 887272 || Math.abs(q.upperTick) > 887272 ||
      q.lowerTick % p.tickSpacing !== 0 || q.upperTick % p.tickSpacing !== 0)) invalid.push('position_binding');
    const ticks = new Map<number, bigint>();
    let active = 0n;
    for (const q of p.positions) {
      ticks.set(q.lowerTick, (ticks.get(q.lowerTick) ?? 0n) + BigInt(q.liquidity));
      ticks.set(q.upperTick, (ticks.get(q.upperTick) ?? 0n) - BigInt(q.liquidity));
      if (q.lowerTick <= p.currentTick && p.currentTick < q.upperTick) active += BigInt(q.liquidity);
    }
    const supplied = new Map(p.ticks.map(t => [t.tick, BigInt(t.liquidityNet)]));
    if (supplied.size !== p.ticks.length || active !== BigInt(p.activeLiquidity) ||
      [...new Set([...ticks.keys(), ...supplied.keys()])].some(t => (ticks.get(t) ?? 0n) !== (supplied.get(t) ?? 0n))) invalid.push('tick_position_reconciliation');
  }
  if (positions.some(p => p.custodyStatus === 'unknown')) gaps.push('position_custody');
  const excessStatus = custodyStatus(i.excess.custody, cursor.timestampSec);
  if (i.excess.units !== '0' && (excessStatus === 'unknown' || i.excess.custody.owner !== i.excess.address ||
    i.excess.custody.locker !== profile.pins.locker.address || i.excess.custody.lockerCodeHash !== profile.pins.locker.codeHash)) gaps.push('excess_custody');
  const inventoryComplete = gaps.length === 0 && invalid.length === 0;
  const poolInventory = inventoryComplete ? i.pools.reduce((n, p) => n + BigInt(p.tokenInventory), 0n).toString() : null;
  const marketByAddress = inventoryComplete ? [...new Set(i.pools.map(p => p.manager))].map(address => ({ address,
    units: i.pools.filter(p => p.manager === address).reduce((n, p) => n + BigInt(p.tokenInventory), 0n).toString(),
    feeUnits: i.pools.filter(p => p.manager === address).reduce((n, p) => n + BigInt(p.tokenFees), 0n).toString() })) : [];
  const reachable = (p: GraduationInventoryInput['pools'][number]) => p.exit.status === 'executed' && p.exit.buyerReachable === true &&
    p.exit.evidenceIds.length > 0 && BigInt(p.exit.tokenInput) > 0n && BigInt(p.exit.netQuoteOutput) > 0n;
  const reachableSuccessor = !!successor && reachable(successor);
  const alternatives = i.pools.filter(p => p.id !== m.successorPoolId && reachable(p)).map(p => p.id).sort();
  const evidenceIds = [...new Set([m, i.before, i.after, i.excess, profile, ...i.pools].flatMap(p => p.evidenceIds)
    .concat(i.pools.flatMap(p => [...p.exit.evidenceIds, ...p.positions.flatMap(q => q.evidenceIds)])))].sort();
  // 040/041 do not validate v4 execution or its removal-depth math. Supplied exit observations remain visible,
  // but cannot complete the measured executable/custody check or prove token-wide no-exit/withdrawal.
  const unsupported = ['v4_execution_unvalidated', 'v4_removal_depth_unsupported'];
  const result = { schemaVersion: 'graduation-inventory-1' as const, methodVersion: '1.0.0', coin: i.coin, origin: i.origin, cursor, knownAt,
    profileHash, migration: m, inventoryComplete, criticalComplete: false as const, gaps: [...new Set(gaps)].sort(), invalid: [...new Set(invalid)].sort(), unsupported,
    curveInventory: inventoryComplete ? '0' : null, poolInventory, marketByAddress,
    excess: { address: i.excess.address, units: i.excess.units, lockedUnits: inventoryComplete ? excessStatus === 'locked' ? i.excess.units : '0' : null },
    pools: i.pools, positions, reachableSuccessor, alternativeExecutableRoutes: alternatives,
    oldCurveSellStatus: i.after.readyToGraduate && i.after.sellableTokens === '0' ? 'closed_ready_to_graduate' as const : 'unknown' as const,
    disposition: inventoryComplete && reachableSuccessor ? 'migration' as const : 'unassessed' as const,
    noExitProved: false as const, liquidityWithdrawn: null, evidenceIds };
  return { ...result, id: referenceDigest(result) };
}
export type GraduationInventory = ReturnType<typeof reconcileGraduationInventory>;

/** Bind supported secondary positions to 041's exact route states. V4 residual is explicit, never dropped. */
export function graduationRemovalDepth(s: GraduationInventory, routes: LocalDepthRoute[], validated: ValidatedDepthPosition[], controller: string) {
  const { id, ...body } = s;
  if (referenceDigest(body) !== id) throw new Error('Graduation inventory digest mismatch');
  if (!s.inventoryComplete || routes.some(r => r.coin !== s.coin || r.origin !== s.origin || !same(r.cursor, s.cursor)))
    return { status: 'unknown' as const, reason: 'graduation_inventory', assessedSecondaryPools: [] as string[], unsupportedPools: s.pools.map(p => p.id) };
  const unsupportedPools = s.pools.filter(p => p.venue === 'uniswap_v4').map(p => p.id);
  const secondary = s.pools.filter(p => p.venue === 'uniswap_v3');
  const supported = routes.filter(r => secondary.some(p => p.id === r.poolId));
  // 041 already requires validated sqrt-price ranges. Tick integers alone cannot fabricate those bindings.
  const expected = s.positions.filter(p => secondary.some(pool => pool.id === p.poolId));
  const positionCoverage = expected.length === validated.length && expected.every(p => validated.some(v => v.id === p.id &&
    v.poolId === p.poolId && v.controller === p.custody.controller && v.custody === p.custodyStatus && v.liquidity === BigInt(p.liquidity) &&
    p.evidenceIds.every(id => v.evidenceIds.includes(id))));
  const secondaryDepth = removalDepth(supported, validated, controller, supported.length === secondary.length, positionCoverage);
  return { status: 'unknown' as const, reason: 'v4_removal_depth_unsupported', unsupportedPools,
    assessedSecondaryPools: supported.map(r => r.poolId), secondaryDepth };
}
