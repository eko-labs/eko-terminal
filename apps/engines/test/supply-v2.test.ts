import { describe, expect, it } from 'vitest';
import { CoinCardV2Schema } from '@eko/shared';
import type { Metric, RawAmount } from '@eko/shared';
import { reconcileSupplyBasicsV2 } from '../src/supply-v2.js';
import { card as cardFixture } from '../../../packages/shared/test/fixtures/contracts/guard-v2.js';
import { address, at, coin, curve, cursor, fixture, hash, holder, live, proof, second, sink, transfer } from './supply-fixtures.js';

const units = (m: Metric<RawAmount>) => m.value?.raw ?? null;
const holding = (s: ReturnType<typeof reconcileSupplyBasicsV2>, a: string) => s.holdings.find(h => h.address === a)!;
const buckets = (s: ReturnType<typeof reconcileSupplyBasicsV2>) => Object.fromEntries(
  ['minted', 'total', 'sinks', 'locked', 'curveInventory', 'poolInventory', 'circulating', 'holderFloat'].map(k => [k, units(s.supply[k as 'total'])]));

describe('030 exact supplied Pons supply accounting', () => {
  it('reconciles M/S/D/K/U/P/C/F and binds the shared partial-card fields', () => {
    const input = fixture(), before = JSON.stringify(input), snapshot = reconcileSupplyBasicsV2(input);
    expect(buckets(snapshot)).toEqual({ minted: '1000', total: '1000', sinks: '0', locked: '0',
      curveInventory: '400', poolInventory: '0', circulating: '600', holderFloat: '600' });
    expect(snapshot).toMatchObject({ capSemanticsVersion: '2.0.0', floatState: 'stable', check: { status: 'complete' } });
    expect(snapshot.supply.burnedPct.value).toBe('0');
    expect(snapshot.supply.holders.value).toBe(1);
    expect(holding(snapshot, holder)).toMatchObject({ raw: { value: { raw: '600' } }, locked: { value: { raw: '0' } },
      liquid: { value: { raw: '600' } }, floatPct: { value: '100' }, supplyPct: { value: '60' } });
    expect(snapshot.supply.total.cursor).toEqual(cursor);
    expect(snapshot.supply.total.knownAt).toEqual(proof.knownAt);
    expect(snapshot.supply.total.coverage.from).toEqual(at(1));
    expect(CoinCardV2Schema.shape.supply.parse({ ...cardFixture.supply, ...snapshot.supply })).toMatchObject(snapshot.supply);
    expect(JSON.stringify(input)).toBe(before);
    expect(reconcileSupplyBasicsV2({ ...input, transfers: [...input.transfers].reverse() })).toEqual(snapshot);
  });

  it('true burns reduce S once; proved sink deposits stay in S and add D', () => {
    const input = fixture();
    input.transfers.push(transfer(3, holder, address(0), '100', 3), transfer(4, holder, sink, '100', 4));
    input.totalSupplyRead!.total = '900'; input.sinks.push({ ...proof, address: sink, irrecoverable: true });
    const s = reconcileSupplyBasicsV2(input);
    expect(buckets(s)).toEqual({ minted: '1000', total: '900', sinks: '100', locked: '0', curveInventory: '400',
      poolInventory: '0', circulating: '400', holderFloat: '400' });
    expect(s.supply.burnedPct).toMatchObject({ value: '20', numerator: { raw: '200' }, denominator: { raw: '1000' }, denominatorKind: 'other' });
    expect(units(holding(s, sink).raw)).toBe('100'); expect(units(holding(s, sink).liquid)).toBe('0');
    expect(s.holdings.some(h => h.address === address(0))).toBe(false);
  });

  it('live burn-intent and token-self holdings remain external; no name proves a sink', () => {
    const input = fixture();
    input.transfers.push(transfer(3, holder, live, '100'), transfer(4, holder, coin, '100'));
    const s = reconcileSupplyBasicsV2(input);
    expect(units(s.supply.sinks)).toBe('0'); expect(units(s.supply.holderFloat)).toBe('600');
    expect(s.supply.burnedPct.value).toBe('0'); expect(s.supply.holders.value).toBe(3);
    for (const a of [live, coin]) expect(holding(s, a)).toMatchObject({ bucket: 'external', liquid: { value: { raw: '100' } } });
    expect(s.supply.rawTop10.map(h => h.address)).toContain(coin);
    input.transfers.push(transfer(5, live, address(0), '100', 3)); input.totalSupplyRead!.total = '900';
    expect(reconcileSupplyBasicsV2(input).supply.burnedPct.value).toBe('10');
  });

  it('excludes an 80% locked allocation but preserves raw units and only its unavailable portion', () => {
    const input = fixture(); input.transfers = [transfer(1, address(0), holder, '1000', 1), transfer(2, holder, second, '200')];
    input.locks = [{ ...proof, address: holder, unavailable: '800', revocable: false }];
    const s = reconcileSupplyBasicsV2(input);
    expect(units(s.supply.locked)).toBe('800'); expect(units(s.supply.holderFloat)).toBe('200');
    expect(holding(s, holder)).toMatchObject({ raw: { value: { raw: '800' } }, locked: { value: { raw: '800' } }, liquid: { value: { raw: '0' } } });
    expect(s.supply.rawTop10.map(h => h.address)).toEqual([second]); expect(s.supply.holders.value).toBe(1);
    input.locks[0].unavailable = '500';
    expect(units(reconcileSupplyBasicsV2(input).supply.holderFloat)).toBe('500');
    input.locks[0].revocable = true;
    expect(units(reconcileSupplyBasicsV2(input).supply.locked)).toBe('0');
    expect(units(reconcileSupplyBasicsV2(input).supply.holderFloat)).toBe('1000');
    input.locks[0].revocable = false; input.locks[0].unavailable = '0';
    expect(units(reconcileSupplyBasicsV2(input).supply.holderFloat)).toBe('1000');
  });

  it('deduplicates overlapping exclusions in sink → hard lock → curve order', () => {
    const input = fixture(); input.sinks = [{ ...proof, address: curve, irrecoverable: true }];
    input.locks = [{ ...proof, address: curve, unavailable: '400', revocable: false }];
    const s = reconcileSupplyBasicsV2(input);
    expect(units(s.supply.sinks)).toBe('400'); expect(units(s.supply.locked)).toBe('0');
    expect(units(s.supply.curveInventory)).toBe('0'); expect(units(s.supply.holderFloat)).toBe('600');
    input.sinks = []; input.locks[0].unavailable = '100';
    const lockedCurve = reconcileSupplyBasicsV2(input);
    expect(units(lockedCurve.supply.locked)).toBe('100'); expect(units(lockedCurve.supply.curveInventory)).toBe('300');
    expect(units(lockedCurve.supply.holderFloat)).toBe('600');
  });

  it('keeps unknown custody visible and sorts min(10,count) by exact units then address', () => {
    const input = fixture(); input.transfers = [transfer(1, address(0), curve, '1000', 1)];
    for (let n = 20; n < 32; n++) input.transfers.push(transfer(n, curve, address(n), '50'));
    const s = reconcileSupplyBasicsV2(input);
    expect(s.supply.holders.value).toBe(12); expect(s.supply.rawTop10).toHaveLength(10);
    expect(s.supply.rawTop10.map(h => h.address)).toEqual(Array.from({ length: 10 }, (_, n) => address(n + 20)));
    expect(s.supply.rawTop10.every(h => h.groupId === null)).toBe(true);
    expect(s.supply.top10RawPct).toMatchObject({ numerator: { raw: '500' }, denominator: { raw: '600' }, denominatorKind: 'F' });
    expect(s.supply.top10RawPct.value).toBe('83.333333333333333333333333333333333333');
  });

  it('retains amounts above Number precision, including one-unit concentration differences', () => {
    const input = fixture(), M = 10n ** 30n;
    input.transfers = [transfer(1, address(0), holder, M.toString(), 1), transfer(2, holder, second, (M / 2n + 1n).toString())];
    input.totalSupplyRead!.total = M.toString();
    const s = reconcileSupplyBasicsV2(input);
    expect(units(s.supply.total)).toBe(M.toString()); expect(s.supply.rawTop10[0].address).toBe(second);
    expect(units(holding(s, holder).liquid)).toBe((M / 2n - 1n).toString());
  });
});

describe('030 float and failed reconciliation', () => {
  it.each([['0', 'zero'], ['19', 'small'], ['20', 'stable']] as const)('F=%s of S=1000 → %s (exact 2%% boundary)', (F, state) => {
    const input = fixture(); input.transfers = [transfer(1, address(0), curve, '1000', 1)];
    if (F !== '0') input.transfers.push(transfer(2, curve, holder, F));
    const s = reconcileSupplyBasicsV2(input);
    expect(s.floatState).toBe(state); expect(units(s.supply.holderFloat)).toBe(F);
    expect(s.check.status).toBe(state === 'stable' ? 'complete' : 'missing');
    expect(s.supply.top10RawPct.value).toBe(state === 'stable' ? '100' : null);
    if (F !== '0') expect(holding(s, holder).floatPct.value).toBe(state === 'stable' ? '100' : null);
    expect(units(s.supply.total)).toBe('1000');
  });

  it('all tokens truly burned leaves S=F=0 and ratios null, with complete burn accounting', () => {
    const input = fixture(); input.transfers = [transfer(1, address(0), curve, '1000', 1), transfer(2, curve, address(0), '1000')];
    input.totalSupplyRead!.total = '0';
    const s = reconcileSupplyBasicsV2(input);
    expect(s.floatState).toBe('zero'); expect(units(s.supply.total)).toBe('0'); expect(s.supply.burnedPct.value).toBe('100');
    expect(s.supply.holders.value).toBe(0); expect(s.supply.top10RawPct.value).toBeNull();
  });

  it('never clips a negative apparent float from an inconsistent total-supply sample', () => {
    const input = fixture(); input.totalSupplyRead!.total = '100'; // U=400 would exceed S; contradictory evidence fails.
    const s = reconcileSupplyBasicsV2(input);
    expect(s.floatState).toBe('unreconciled'); expect(s.check).toMatchObject({ status: 'failed', failureCode: 'unreconciled' });
    expect(s.issues).toContain('supply_mismatch'); expect(units(s.supply.holderFloat)).toBeNull();
    expect(units(s.supply.total)).toBeNull();
  });

  it('negative balances and overlocked balances fail instead of producing zero or negative raw metrics', () => {
    const input = fixture(); input.transfers.push(transfer(3, holder, second, '601'));
    const negative = reconcileSupplyBasicsV2(input);
    expect(negative.issues).toContain('negative_balance'); expect(negative.floatState).toBe('unreconciled');
    expect(units(negative.supply.holderFloat)).toBeNull();
    const locked = fixture(); locked.locks = [{ ...proof, address: holder, unavailable: '601', revocable: false }];
    const s = reconcileSupplyBasicsV2(locked);
    expect(s.issues).toContain('invalid_lock'); expect(s.check.status).toBe('failed');
    expect(units(s.supply.holderFloat)).toBeNull(); expect(units(holding(s, holder).raw)).toBe('600');
  });

  it.each(['graduated', 'unknown'] as const)('leaves %s U/P/F unknown and never substitutes PoolManager inventory', stage => {
    const input = fixture(); input.inventory.stage = stage;
    input.transfers.push(transfer(3, holder, address(99), '300')); // unresolved aggregate custody remains a raw address
    const s = reconcileSupplyBasicsV2(input);
    expect(units(s.supply.total)).toBe('1000'); expect(units(s.supply.curveInventory)).toBeNull();
    expect(units(s.supply.poolInventory)).toBeNull(); expect(units(s.supply.holderFloat)).toBeNull();
    expect(s.check.status).toBe('unsupported'); expect(units(holding(s, address(99)).raw)).toBe('300');
    expect(units(holding(s, curve).liquid)).toBeNull();
  });

  it('requires proof that the curve is the only inventory; secondary/unknown pools do not complete P', () => {
    const input = fixture(); input.inventory.curveOnly = false;
    const s = reconcileSupplyBasicsV2(input);
    expect(units(s.supply.poolInventory)).toBeNull(); expect(s.check.status).toBe('unsupported');
  });
});

describe('030 historical source and availability boundaries', () => {
  it('reconstructs historical S from complete mint/burn transfers without a total-supply read', () => {
    const input = fixture(); delete input.totalSupplyRead;
    input.transfers.push(transfer(3, holder, address(0), '100', 3));
    expect(units(reconcileSupplyBasicsV2(input).supply.total)).toBe('900');
    input.totalSupplyRead = { ...proof, cursor: at(1), total: '1000' };
    expect(units(reconcileSupplyBasicsV2(input).supply.total)).toBe('900');
  });

  it('rejects future total_supply samples and samples acquired beyond the captured availability', () => {
    const input = fixture(); input.totalSupplyRead!.cursor = at(11); input.totalSupplyRead!.knownAt.cursor = at(11);
    expect(() => reconcileSupplyBasicsV2(input)).toThrow('read exceeds');
    const later = fixture(); later.totalSupplyRead!.knownAt = { cursor, acquisitionSequence: '2' };
    expect(() => reconcileSupplyBasicsV2(later)).toThrow('read exceeds');
  });

  it('does not substitute an older supply read or observed-transfer window for historical completeness', () => {
    const input = fixture(); input.fromDeployment = false; input.totalSupplyRead!.cursor = at(1);
    const s = reconcileSupplyBasicsV2(input);
    expect(units(s.supply.total)).toBeNull(); expect(units(s.supply.minted)).toBeNull(); expect(s.check.status).toBe('missing');
    input.totalSupplyRead!.cursor = cursor;
    const current = reconcileSupplyBasicsV2(input);
    expect(units(current.supply.total)).toBe('1000'); expect(units(current.supply.holderFloat)).toBeNull();
    expect(current.supply.burnedPct.value).toBeNull();
  });

  it('preserves total and raw holdings while missing classification cannot assert D/K or F', () => {
    const input = fixture(); input.classificationCoverage = { ...input.classificationCoverage, complete: false, gaps: ['missing'] };
    const s = reconcileSupplyBasicsV2(input);
    expect(units(s.supply.total)).toBe('1000'); expect(units(holding(s, holder).raw)).toBe('600');
    expect(units(s.supply.sinks)).toBeNull(); expect(units(s.supply.locked)).toBeNull(); expect(s.check.status).toBe('missing');
  });

  it('unsupported rebase/fee transfer semantics preserve a pinned current S but do not manufacture float', () => {
    const input = fixture(); input.semantics = 'unsupported';
    const s = reconcileSupplyBasicsV2(input);
    expect(units(s.supply.total)).toBe('1000'); expect(units(s.supply.minted)).toBeNull();
    expect(units(s.supply.holderFloat)).toBeNull(); expect(s.check.status).toBe('unsupported');
  });

  it('future transfers are excluded, but unknown-at-target transfers prevent completed reconciliation', () => {
    const input = fixture(), baseline = reconcileSupplyBasicsV2(input);
    input.transfers.push({ ...transfer(3, holder, second, '200', 11), knownAt: { cursor: at(11), acquisitionSequence: '1' } });
    expect(reconcileSupplyBasicsV2(input)).toEqual(baseline);
    const hidden = fixture(); hidden.transfers[1].knownAt = { cursor, acquisitionSequence: '2' };
    expect(reconcileSupplyBasicsV2(hidden).check.status).toBe('missing');
  });

  it('rejects duplicate transfers, unproved sinks, stale classifications and mismatched boundaries', () => {
    const input = fixture(); input.transfers.push(input.transfers[0]);
    expect(() => reconcileSupplyBasicsV2(input)).toThrow('Duplicate transfer');
    const unknownSink = fixture(); unknownSink.sinks = [{ ...proof, evidenceIds: [], address: sink, irrecoverable: true }];
    expect(() => reconcileSupplyBasicsV2(unknownSink)).toThrow();
    const trueBurn = fixture(); trueBurn.sinks = [{ ...proof, address: address(0), irrecoverable: true }];
    expect(() => reconcileSupplyBasicsV2(trueBurn)).toThrow('True burns');
    const stale = fixture(); stale.inventory.cursor = at(9);
    expect(() => reconcileSupplyBasicsV2(stale)).toThrow('classification');
    const gap = fixture(); gap.transferCoverage.through = at(9);
    expect(() => reconcileSupplyBasicsV2(gap)).toThrow('coverage boundary');
    const boundary = fixture(); boundary.transferCoverage.from = at(2);
    expect(() => reconcileSupplyBasicsV2(boundary)).toThrow('source boundary');
    const wrongCoin = fixture(); wrongCoin.launch.coin = address(200);
    expect(() => reconcileSupplyBasicsV2(wrongCoin)).toThrow('matching Pons');
    const fork = fixture(); fork.totalSupplyRead!.cursor = { ...cursor, blockHash: hash(200) };
    expect(() => reconcileSupplyBasicsV2(fork)).toThrow('fork mismatch');
  });
});
