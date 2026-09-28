import { describe, expect, it } from 'vitest';
import { localRouteStateHash, type ValidatedDepthPosition } from '@eko/chain';
import { reconcileGraduationInventory, graduationRemovalDepth } from '../src/graduation-inventory.js';
import { reconcileSupplyBasicsV2 } from '../src/supply-v2.js';
import { graduationFixture, graduatedSupplyFixture, locker, manager, successorId } from './graduation-fixtures.js';
import { address, at, curve, hash, holder, proof, transfer } from './supply-fixtures.js';
import { route } from '../../../packages/chain/test/directional-depth-fixtures.js';

describe('042 supplied graduation inventory (synthetic, no measured acceptance)', () => {
  it('binds conserved real reserves, full-range v4 mint, locker and successor; empty old curve is migration', () => {
    const i = graduationFixture(), before = JSON.stringify(i), s = reconcileGraduationInventory(i);
    expect(s).toMatchObject({ inventoryComplete: true, criticalComplete: false, disposition: 'migration', poolInventory: '300', curveInventory: '0',
      gaps: [], invalid: [], oldCurveSellStatus: 'closed_ready_to_graduate', noExitProved: false, liquidityWithdrawn: null });
    expect(s.positions[0].custodyStatus).toBe('locked'); expect(s.excess.lockedUnits).toBe('100');
    expect(s.unsupported).toEqual(['v4_execution_unvalidated', 'v4_removal_depth_unsupported']);
    expect(s.migration.transactionHash).toBe(i.pools[0].migrationCredit!.transactionHash);
    expect(JSON.stringify(i)).toBe(before);
  });
  it('moves U to K/P once; locked LP underlying stays circulating and out of external numerators', () => {
    const s = reconcileSupplyBasicsV2(graduatedSupplyFixture());
    expect(s.supply.curveInventory.value?.raw).toBe('0'); expect(s.supply.locked.value?.raw).toBe('100');
    expect(s.supply.poolInventory.value?.raw).toBe('300'); expect(s.supply.circulating.value?.raw).toBe('900');
    expect(s.supply.holderFloat.value?.raw).toBe('600'); expect(s.supply.burnedPct.value).toBe('0');
    expect(s.holdings.find(h => h.address === manager)).toMatchObject({ bucket: 'pool', liquid: { value: { raw: '0' } } });
    expect(s.supply.rawTop10.map(h => h.address)).toEqual([holder]); expect(s.issues).toEqual([]);
    expect(s.check.status).toBe('unsupported'); // Fixture provenance cannot complete a live buy-critical check.
  });
  it.each(['inaccessible', 'unknown'] as const)('keeps %s successor unassessed, never labels withdrawal or no-exit', status => {
    const i = graduationFixture(); i.pools[0].exit.status = status; i.pools[0].exit.buyerReachable = null;
    const s = reconcileGraduationInventory(i);
    expect(s.inventoryComplete).toBe(true); expect(s.disposition).toBe('unassessed'); expect(s.noExitProved).toBe(false);
    expect(s.liquidityWithdrawn).toBeNull(); expect(s.criticalComplete).toBe(false);
  });
  it('expired/revocable LP locks become removable; only unavailable non-market excess enters K', () => {
    const i = graduatedSupplyFixture(); i.inventory.graduation!.pools[0].positions[0].custody.unlockAtSec = at(10).timestampSec;
    i.inventory.graduation!.excess.custody.unlockAtSec = at(10).timestampSec;
    const g = reconcileGraduationInventory(i.inventory.graduation!);
    expect(g.positions[0].custodyStatus).toBe('removable'); expect(g.excess.lockedUnits).toBe('0');
    const s = reconcileSupplyBasicsV2(i);
    expect(s.supply.locked.value?.raw).toBe('0'); expect(s.supply.poolInventory.value?.raw).toBe('300'); expect(s.supply.holderFloat.value?.raw).toBe('700');
    const revocable = graduationFixture(); revocable.pools[0].positions[0].custody.revocable = true;
    expect(reconcileGraduationInventory(revocable).positions[0].custodyStatus).toBe('removable');
  });
  it('rejects PoolManager aggregate substitution and keeps unknown raw custody visible', () => {
    const i = graduatedSupplyFixture(); i.inventory.graduation!.pools[0].inventorySource = 'manager_balance';
    i.inventory.graduation!.pools[0].tokenInventory = '999999';
    const g = reconcileGraduationInventory(i.inventory.graduation!);
    expect(g.gaps).toContain('per_pool_inventory'); expect(g.poolInventory).toBeNull();
    const s = reconcileSupplyBasicsV2(i); expect(s.supply.poolInventory.value).toBeNull(); expect(s.supply.holderFloat.value).toBeNull();
    expect(s.holdings.find(h => h.address === manager)?.raw.value?.raw).toBe('300'); expect(s.check.status).toBe('unsupported');
  });
  it('keeps accrued fees distinct and leaves unrelated manager custody in F', () => {
    const i = graduatedSupplyFixture(); i.transfers.push(transfer(5, holder, manager, '20', 10));
    i.inventory.graduation!.pools[0].tokenFees = '5';
    const s = reconcileSupplyBasicsV2(i);
    expect(s.supply.poolInventory.value?.raw).toBe('300'); expect(s.supply.holderFloat.value?.raw).toBe('600');
    expect(s.holdings.find(h => h.address === manager)?.liquid.value?.raw).toBe('20');
    expect(s.supply.rawTop10.map(h => h.address)).toContain(manager);
  });
  it('retains removable secondary pools and reachable alternatives without claiming a token-wide ratio', () => {
    const i = graduationFixture(), primary = i.pools[0], r = route('uniswap_v3');
    r.coin = i.coin; r.cursor = i.cursor; r.poolId = hash(71); r.verification.stateHash = localRouteStateHash(r);
    if (r.venue !== 'uniswap_v3') throw new Error('Fixture route');
    const secondary = structuredClone(primary); secondary.id = r.poolId as `0x${string}`; secondary.manager = address(71); secondary.venue = 'uniswap_v3';
    secondary.migrationCredit = null; secondary.tokenInventory = '100'; secondary.activeLiquidity = r.state.ranges[0].liquidity.toString();
    const p = secondary.positions[0]; p.id = hash(81); p.poolId = secondary.id; p.liquidity = secondary.activeLiquidity;
    p.custody = { ...p.custody, owner: holder, locker: null, lockerCodeHash: null }; secondary.ticks[0].liquidityNet = p.liquidity; secondary.ticks[1].liquidityNet = `-${p.liquidity}`;
    i.pools.push(secondary); primary.exit.status = 'inaccessible';
    const s = reconcileGraduationInventory(i);
    expect(s.poolInventory).toBe('400'); expect(s.alternativeExecutableRoutes).toEqual([secondary.id]);
    expect(s.positions.find(x => x.id === p.id)?.custodyStatus).toBe('removable');
    const vp: ValidatedDepthPosition = { id: p.id, poolId: p.poolId, controller: p.custody.controller!, cursor: i.cursor, custody: 'removable', validated: true,
      routeStateHash: r.verification.stateHash, origin: 'fixture', evidenceIds: p.evidenceIds, lower: r.state.ranges[0].lower, upper: r.state.ranges[0].upper,
      liquidity: BigInt(p.liquidity) };
    const d = graduationRemovalDepth(s, [r], [vp], p.custody.controller!);
    expect(d.status).toBe('unknown'); expect(d.unsupportedPools).toEqual([successorId]);
    expect(d.secondaryDepth?.status).toBe('bounded'); expect(d.secondaryDepth?.lowerShare).toBe('1'); expect(d.secondaryDepth?.remoteSearchCalls).toBe(0);
    expect(graduationRemovalDepth(s, [r], [], p.custody.controller!).secondaryDepth?.reason).toBe('position_coverage');
  });
  it.each(['reserve', 'readiness', 'position', 'ticks', 'settlement', 'asset', 'quote'] as const)('fails unreconciled %s without clipping quantities', kind => {
    const i = graduationFixture();
    if (kind === 'reserve') i.migration.depositedTokens = '401';
    if (kind === 'readiness') i.before.sellableTokens = '1';
    if (kind === 'position') i.pools[0].positions[0].lowerTick = -887160;
    if (kind === 'ticks') i.pools[0].ticks[0].liquidityNet = '101';
    if (kind === 'settlement') i.pools[0].migrationCredit!.transactionHash = hash(999);
    if (kind === 'asset') i.pools[0].token = address(999);
    if (kind === 'quote') i.pools[0].quoteAsset = address(999);
    const s = reconcileGraduationInventory(i); expect(s.inventoryComplete).toBe(false); expect(s.invalid.length).toBeGreaterThan(0); expect(s.poolInventory).toBeNull();
  });
  it('rejects missing coverage, unreviewed custody and unresolved old-curve residuals', () => {
    const i = graduationFixture(); i.routeDiscoveryComplete = false;
    expect(reconcileGraduationInventory(i).gaps).toContain('route_inventory_coverage');
    i.routeDiscoveryComplete = true; i.pools[0].positions[0].custody.reviewed = false;
    expect(reconcileGraduationInventory(i).gaps).toContain('position_custody');
    const residual = graduationFixture(); residual.after.tokenInventory = '10'; residual.before.tokenInventory = '410';
    expect(reconcileGraduationInventory(residual).gaps).toContain('old_curve_residual');
    const upgrade = graduationFixture(); upgrade.pools[0].positions[0].custody.lockerCodeHash = hash(999);
    expect(reconcileGraduationInventory(upgrade).gaps).toContain('successor_code_binding');
    const schedule = graduationFixture(); schedule.pools[0].positions[0].custody.unlockAtSec = null;
    expect(reconcileGraduationInventory(schedule).positions[0].custodyStatus).toBe('unknown');
    expect(reconcileGraduationInventory(schedule).gaps).toContain('position_custody');
  });
  it('rejects stale/reorg/future evidence, changed profiles and duplicate pools', () => {
    const i = graduationFixture(); i.pools[0].cursor = { ...i.cursor, blockHash: hash(999) };
    expect(() => reconcileGraduationInventory(i)).toThrow('fork mismatch');
    const future = graduationFixture(); future.migration.knownAt = { ...future.migration.knownAt, acquisitionSequence: '2' };
    expect(() => reconcileGraduationInventory(future)).toThrow('exceeds capture');
    const changed = graduationFixture(); changed.profile.pins.locker.codeHash = hash(999);
    expect(() => reconcileGraduationInventory(changed)).toThrow('digest mismatch');
    const dup = graduationFixture(); dup.pools.push(structuredClone(dup.pools[0]));
    expect(() => reconcileGraduationInventory(dup)).toThrow('Duplicate');
  });
  it('cross-checks reconstructed custody balances and forbids double-counted excess', () => {
    const i = graduatedSupplyFixture(); i.transfers = i.transfers.filter(t => t.to !== manager);
    expect(reconcileSupplyBasicsV2(i).check.status).toBe('failed');
    const duplicate = graduatedSupplyFixture(); duplicate.locks.push({ ...proof, address: locker, unavailable: '99', revocable: false });
    expect(reconcileSupplyBasicsV2(duplicate).check.status).toBe('failed');
    const old = graduatedSupplyFixture(); old.transfers = old.transfers.filter(t => t.from !== curve || t.to === holder);
    expect(reconcileSupplyBasicsV2(old).issues).toContain('supply_mismatch');
  });
});
