import { describe, expect, it } from 'vitest';
import type { Metric, RawAmount } from '@eko/shared';
import { GroupedCoverageEngine, measureGroupedCoverageV2 } from '../src/grouped-coverage.js';
import type { GroupedCoverageInput } from '../src/grouped-coverage-input.js';
import { reconcileSupplyBasicsV2 } from '../src/supply-v2.js';
import { qualifyGraphsV2 } from '../src/qualified-graphs.js';
import { address, at, coverage, fixture, hash, holder, coin, curve, transfer } from './supply-fixtures.js';

// Conserved synthetic states; these are neither acquired chain data nor release/calibration evidence.
const units = (m: Metric<RawAmount>) => m.value?.raw ?? null;
function input(rows: [number, string][], total = '10000'): GroupedCoverageInput {
  const s = fixture();
  s.transfers = [transfer(1, address(0), curve, total, 1), ...rows.map(([n, amount], j) => transfer(j + 2, curve, address(n), amount))];
  s.totalSupplyRead!.total = total;
  const supply = reconcileSupplyBasicsV2(s), cut = supply.knownAt;
  const graph = structuredClone(qualifyGraphsV2({ at: cut, coin, principal: holder, launchedAtSec: '1001',
    valuationUnit: { asset: address(90), decimals: 0 }, firstBuysComplete: true, acquisitions: [], sales: [], flows: [], paths: [],
    permissions: [], authorities: [], services: [], loopMethodAccepted: false, canonicalBlocks: [{ blockNumber: cut.cursor.blockNumber, blockHash: hash(10) }],
    originLots: [], origin: [], soft: [] }));
  return { supply, graph, principal: holder, launchedAtSec: '1001', firstTradeSec: '1002',
    acquisitions: rows.map(([n], j) => ({ id: hash(100 + j), recipient: address(n), kind: 'buy', cursor: at(2), knownAt: cut, evidenceIds: [hash(900 + j)] })),
    acquisitionCoverage: coverage, originCoverage: coverage, actorCoverage: coverage, releaseCoverage: coverage,
    lots: rows.map(([n, raw], j) => ({ id: hash(1000 + j), owner: address(n), origin: address(n), originAlternatives: [address(n)],
      acquiredAt: at(2), units: { asset: coin, decimals: 18, raw }, state: 'liquid', basis: null, basisPayer: null, evidenceIds: [hash(1000 + j)] })),
    investigations: rows.map(([n]) => ({ address: address(n), cursor: supply.cursor, knownAt: cut, coverage, evidenceIds: [hash(99)] })),
    unresolvedCustody: [], exclusions: [], releases: [], principalOriginScoringAccepted: false };
}
function group(i: GroupedCoverageInput, id: number, members: number[], kind: 'control' | 'coordination' = 'coordination', accepted = true) {
  const memberIds = members.map(address).sort(), participants = memberIds.map(address => ({ address, roles: ['buy_recipient' as const] }));
  const edge = { id: hash(id), kind, evidenceClass: kind === 'control' ? 'authenticated_control' as const : 'private_payer' as const,
    status: accepted ? 'qualified' as const : 'candidate' as const, memberIds, participants, evidenceIds: [hash(id + 20000)], sourceIds: [hash(id + 30000)],
    fundingRatio: null, collectionRatio: null, fastCollection: null, launchBundle: false, historyEligible: kind === 'control' };
  i.graph.edges.push(edge);
  if (accepted) i.graph.components.push({ id: hash(id + 10000), kind, memberIds, edgeIds: [edge.id], graphVersion: i.graph.graphVersion,
    supersedes: [], participants, groupScoringEligible: kind === 'coordination' && members.length >= 3, historyEligible: kind === 'control', diagnostics: [] });
  return hash(id + 10000);
}
function assertMeasured(i: GroupedCoverageInput) {
  const s = measureGroupedCoverageV2(i);
  expect(s.mode).toBe('shadow'); expect(s.coverage.check.status).toBe('complete');
  return s;
}

describe('047 grouped metrics and coverage, synthetic shadow fixtures', () => {
  it('keeps ten 9% groups separate while scoring their 90% deduplicated union', () => {
    const rows: [number, string][] = Array.from({ length: 30 }, (_, j) => [j + 100, '300']); rows.push([500, '1000']);
    const i = input(rows);
    for (let j = 0; j < 10; j++) group(i, j + 1, [100 + j * 3, 101 + j * 3, 102 + j * 3]);
    const s = assertMeasured(i);
    expect(s.coordinatedLargest.value?.floatPct.value).toBe('9'); expect(s.coordinatedUnion.value?.floatPct.value).toBe('90');
    expect(s.top10ControlPct.value).toBe(s.top10RawPct.value); expect(s.top10RawPct.value).toBe('37');
    expect(s.coverage.unresolvedJointPct.value).toBe('90'); expect(s.components).toHaveLength(10);
  });

  it('combines accepted control with singleton holders and ignores medium/soft/origin ownership links', () => {
    const i = input([[3, '2000'], [20, '2000'], [21, '2000'], ...Array.from({ length: 20 }, (_, j): [number, string] => [100 + j, '200'])]);
    group(i, 1, [3, 20], 'control'); group(i, 2, [20, 21], 'coordination', false);
    const s = assertMeasured(i);
    expect(s.controlTop10[0]).toMatchObject({ groupId: hash(10001), units: { value: { raw: '4000' } } });
    expect(s.operator.floatPct.value).toBe('40'); expect(s.principal.floatPct.value).toBe('20');
    expect(s.coordinatedUnion.value?.floatPct.value).toBe('0'); expect(s.top10ControlPct.value).toBe('76');
    expect(s.top10RawPct.value).toBe('74');
  });

  it('queues all 200 late 0.2% wallets and cannot complete from the small-holder screen', () => {
    const i = input([[3, '6000'], ...Array.from({ length: 200 }, (_, j): [number, string] => [100 + j, '20'])]);
    i.launchedAtSec = '0'; i.firstTradeSec = '1'; i.acquisitionCoverage = { ...coverage, from: { ...at(0), timestampSec: '0' } };
    i.investigations = i.investigations.filter(x => x.address === holder);
    const s = measureGroupedCoverageV2(i);
    expect(s.coverage.queue).toHaveLength(200); expect(s.coverage.queue.every(x => x.reasons.includes('late_acquisition'))).toBe(true);
    expect(s.coverage.covered.raw).toBe('6000'); expect(s.coverage.unresolved.raw).toBe('4000');
    expect(s.coverage.unresolvedJointPct.value).toBe('40'); expect(s.coverage.gaps).toContain('float_coverage');
    expect(s.coverage.gaps).toContain('next_coordination_boundary'); expect(s.coverage.check.status).toBe('missing');
    const completed = assertMeasured({ ...i, investigations: input([[3, '6000'], ...Array.from({ length: 200 }, (_, j): [number, string] => [100 + j, '20'])]).investigations });
    expect(completed.coverage.queue).toEqual([]);
  });

  it('requires 95% float and remains incomplete when an unresolved bound reaches the next boundary exactly', () => {
    const i = input([[3, '5000'], [20, '500'], [21, '500'], [22, '490'], [23, '10'], [24, '3500']]);
    group(i, 1, [20, 21, 22]); i.investigations = i.investigations.filter(x => x.address !== address(23));
    const boundary = measureGroupedCoverageV2(i);
    expect(boundary.coverage.covered.raw).toBe('9990'); expect(boundary.coverage.nextBoundaryPct).toBe(15);
    expect(boundary.coverage.unresolvedJointPct.value).toBe('15'); expect(boundary.coverage.gaps).toContain('next_coordination_boundary');
    const below = structuredClone(i);
    // Same reconciled float, one unit moved out of the known union.
    const source = below.supply.holdings.find(h => h.address === address(22))!, dest = below.supply.holdings.find(h => h.address === address(24))!;
    source.raw.value!.raw = source.liquid.value!.raw = '489'; dest.raw.value!.raw = dest.liquid.value!.raw = '3501';
    below.lots.find(l => l.owner === address(22))!.units.raw = '489'; below.lots.find(l => l.owner === address(24))!.units.raw = '3501';
    const s = assertMeasured(below); expect(s.coverage.unresolvedJointPct.value).toBe('14.99');
    const exact95 = input([[3, '9500'], [20, '500']]); exact95.investigations.pop();
    expect(assertMeasured(exact95).coverage.covered.raw).toBe('9500');
    const insufficient = input([[3, '9499'], [20, '501']]); insufficient.investigations.pop();
    expect(measureGroupedCoverageV2(insufficient).coverage.gaps).toContain('float_coverage');
  });

  it('investigates overlapping candidate components of at least 15% without awarding scored groups', () => {
    const i = input([[3, '5000'], [20, '800'], [21, '700'], [22, '1'], [23, '3499']]);
    group(i, 1, [20, 22], 'coordination', false); group(i, 2, [21, 22], 'coordination', false);
    i.investigations = i.investigations.filter(x => x.address !== address(22));
    const s = measureGroupedCoverageV2(i);
    expect(s.coverage.materialCandidates).toHaveLength(1); expect(s.coverage.materialCandidates[0].possibleUnits.raw).toBe('1501');
    expect(s.coverage.gaps).toContain('material_component'); expect(s.coordinatedUnion.value?.liquid.value?.raw).toBe('0');
  });

  it('preserves gifts/wide-airdrop lineage and early origins without owner unions or automatic origin scoring', () => {
    const i = input([[3, '8000'], ...Array.from({ length: 100 }, (_, j): [number, string] => [100 + j, '10']), [500, '1000']]);
    for (const l of i.lots.filter(l => l.owner !== holder)) { l.origin = holder; l.originAlternatives = [holder]; }
    i.exclusions = i.lots.filter(l => l.owner !== holder).map(l => ({ address: l.owner, reason: 'broad_distribution', cursor: i.supply.cursor,
      knownAt: i.supply.knownAt, evidenceIds: [hash(99)] }));
    const s = assertMeasured(i);
    expect(s.principalOriginOverhang.value?.liquid.value?.raw).toBe('10000'); expect(s.earlyOriginOverhang.value?.liquid.value?.raw).toBe('10000');
    expect(s.operator.liquid.value?.raw).toBe('8000'); expect(s.coordinatedUnion.value?.liquid.value?.raw).toBe('0');
    expect(s.principalOriginScoringEligible).toBe(false); expect(s.coverage.excluded.raw).toBe('2000'); expect(s.coverage.excludedCount).toBe(101);
    i.investigations = i.investigations.filter(x => x.address === holder);
    const unresolved = measureGroupedCoverageV2(i); expect(unresolved.coverage.unresolved.raw).toBe('2000');
    expect(unresolved.coverage.check.status).toBe('missing');
  });

  it('preserves origin alternatives as bounds, excludes burns/locks from liquid overhang and enforces release scenario denominator', () => {
    const i = input([[3, '7000'], [20, '2000'], [21, '1000']]);
    i.lots[1].origin = holder; i.lots[1].originAlternatives = [holder, address(20)];
    i.lots[2].origin = holder; i.lots[2].originAlternatives = [holder];
    const uncertain = measureGroupedCoverageV2(i);
    expect(uncertain.principalOriginOverhang.status).toBe('lower_bound');
    expect(uncertain.principalOriginOverhang.value?.liquid.value?.raw).toBe('8000'); expect(uncertain.principalOriginUpper.liquid.value?.raw).toBe('10000');
    const locked = fixture(); locked.locks.push({ address: holder, unavailable: '200', revocable: false,
      cursor: locked.cursor, knownAt: locked.knownAt, evidenceIds: [hash(50)] });
    const j = input([[3, '600']], '1000'); j.supply = reconcileSupplyBasicsV2(locked);
    j.lots[0].units.raw = '400'; j.lots.push({ ...j.lots[0], id: hash(999), units: { ...j.lots[0].units, raw: '200' }, state: 'locked' });
    j.releases = [{ id: hash(1), owner: holder, units: '200', releaseAtSec: String(BigInt(j.supply.cursor.timestampSec) + 3600n),
      cursor: j.supply.cursor, knownAt: j.supply.knownAt, evidenceIds: [hash(1)] }];
    const s = assertMeasured(j);
    expect(s.principalOriginOverhang.value?.liquid.value?.raw).toBe('400'); expect(s.principalOriginOverhang.value?.locked.value?.raw).toBe('200');
    expect(units(s.horizonRelease.releasableByHorizon)).toBe('200'); expect(s.horizonRelease.scenarioPct.value).toBe('33.333333333333333333333333333333333333');
    expect(s.horizonRelease.scenarioPct.denominator).toMatchObject({ raw: '600' }); expect(j.supply.supply.holderFloat.value?.raw).toBe('400');
    j.releases[0].releaseAtSec = String(BigInt(j.releases[0].releaseAtSec) + 1n);
    expect(units(measureGroupedCoverageV2(j).horizonRelease.releasableByHorizon)).toBe('0');
    j.releaseCoverage = { ...coverage, complete: false, gaps: ['missing'] };
    expect(measureGroupedCoverageV2(j).horizonRelease.scenarioPct.status).toBe('unknown');
  });

  it('keeps unknown custody in raw float/top ten and makes group concentration and completion unknown', () => {
    const i = input([[3, '6000'], [20, '4000']]); i.unresolvedCustody.push(address(20));
    const s = measureGroupedCoverageV2(i);
    expect(s.top10RawPct.value).toBe('100'); expect(s.top10ControlPct.status).toBe('unknown');
    expect(s.coverage.unresolved.raw).toBe('4000'); expect(s.coverage.gaps).toContain('unresolved_custody');
    expect(s.rawTop10.some(h => h.address === address(20))).toBe(true);
  });

  it('retains partial-origin bounds and names missing universe/actor coverage without fabricating zero or principal', () => {
    const i = input([[3, '6000'], [20, '4000']]);
    i.lots.pop(); i.actorCoverage = { ...coverage, complete: false, gaps: ['missing'] };
    i.acquisitionCoverage = { ...coverage, from: at(2) }; // Misses the launch boundary.
    const s = measureGroupedCoverageV2(i);
    expect(s.coverage.gaps).toEqual(expect.arrayContaining(['candidate_universe', 'direct_actor', 'current_origin']));
    expect(s.coordinatedUnion.status).toBe('unknown'); expect(s.earlyOriginOverhang.status).toBe('unknown');
    expect(s.principalOriginOverhang.status).toBe('lower_bound'); expect(s.principalOriginUpper.liquid.value?.raw).toBe('10000');
    i.principal = null;
    const unknown = measureGroupedCoverageV2(i);
    expect(unknown.principal.liquid.status).toBe('unknown'); expect(unknown.operator.liquid.status).toBe('unknown');
    expect(unknown.principalOriginOverhang.status).toBe('unknown'); expect(unknown.horizonRelease.scenarioPct.status).toBe('unknown');
  });

  it('uses half-open early-buy lots, excludes mint/gift acquisition and ignores unavailable future observations', () => {
    const i = input([[3, '4000'], [20, '3000'], [21, '3000']]);
    i.firstTradeSec = '1001';
    i.acquisitions[1].cursor = i.lots[1].acquiredAt = at(6); // Exactly tFirst+5.
    i.acquisitions[2].kind = 'mint';
    const future = { ...i.acquisitions[0], id: hash(999), recipient: address(20), cursor: at(11),
      knownAt: { cursor: at(11), acquisitionSequence: '1' }, evidenceIds: [hash(777)] };
    i.acquisitions.push(future);
    i.investigations.find(x => x.address === address(20))!.knownAt = future.knownAt;
    const s = measureGroupedCoverageV2(i);
    expect(s.earlyOriginOverhang.value?.liquid.value?.raw).toBe('4000');
    expect(s.coverage.queue[0]).toMatchObject({ address: address(20), latestAcquisition: at(6) });
    expect(s.earlyOriginOverhang.evidenceIds).not.toContain(hash(777));
  });

  it('includes only accepted operator-controlled horizon locks and rejects duplicate/overallocated release slices', () => {
    const i = input([[3, '6000'], [20, '3000'], [21, '1000']]);
    for (const n of [20, 21]) {
      const h = i.supply.holdings.find(h => h.address === address(n))!;
      h.liquid.value!.raw = n === 20 ? '2000' : '500'; h.locked.value!.raw = n === 20 ? '1000' : '500';
      const l = i.lots.find(l => l.owner === address(n))!, locked = structuredClone(l);
      l.units.raw = h.liquid.value!.raw; locked.id = hash(9000 + n); locked.state = 'locked'; locked.units.raw = h.locked.value!.raw; i.lots.push(locked);
      i.releases.push({ id: hash(n), owner: address(n), units: h.locked.value!.raw, releaseAtSec: '2000', cursor: i.supply.cursor,
        knownAt: i.supply.knownAt, evidenceIds: [hash(n)] });
    }
    i.supply.supply.holderFloat.value!.raw = '8500';
    group(i, 1, [3, 20], 'control'); group(i, 2, [20, 21], 'coordination', false);
    const s = assertMeasured(i); expect(units(s.horizonRelease.releasableByHorizon)).toBe('1000');
    expect(s.horizonRelease.scenarioPct.numerator).toMatchObject({ raw: '1000' });
    expect(s.horizonRelease.scenarioPct.denominator).toMatchObject({ raw: '9500' });
    const duplicate = structuredClone(i); duplicate.releases.push(duplicate.releases[0]);
    expect(() => measureGroupedCoverageV2(duplicate)).toThrow('Duplicate horizon');
    i.releases[0].units = '1001'; expect(() => measureGroupedCoverageV2(i)).toThrow('exceed unavailable');
  });

  it('keeps huge integer balances exact and float scores unavailable for zero/small float', () => {
    const huge = '100000000000000000000000000000000000000';
    const i = input([[3, '40000000000000000000000000000000000000'], [20, '60000000000000000000000000000000000000']], huge);
    group(i, 1, [3, 20], 'control');
    const s = assertMeasured(i); expect(s.top10ControlPct.value).toBe('100'); expect(s.operator.liquid.value?.raw).toBe(huge);
    const small = input([[3, '100']], '10000');
    const sparse = measureGroupedCoverageV2(small); expect(sparse.top10ControlPct.status).toBe('unknown'); expect(sparse.coverage.gaps).toContain('supply_float');
    const zero = measureGroupedCoverageV2(input([], '10000')); expect(zero.top10RawPct.value).toBeNull(); expect(zero.coverage.check.status).toBe('missing');
  });

  it('sorts queue by mass, newest acquisition and address, retaining omitted and excluded mass', () => {
    const i = input([[3, '9000'], [20, '300'], [21, '300'], [22, '300'], [23, '100']]);
    i.acquisitions = i.acquisitions.filter(a => a.recipient !== address(23)); i.lots[4].originAlternatives = [null]; i.lots[4].origin = null;
    i.investigations = i.investigations.filter(a => a.address === holder);
    i.acquisitions.find(a => a.recipient === address(22))!.cursor = at(3);
    i.exclusions.push({ address: address(20), reason: 'service', cursor: i.supply.cursor, knownAt: i.supply.knownAt, evidenceIds: [hash(1)] });
    const s = measureGroupedCoverageV2(i);
    expect(s.coverage.queue.map(a => a.address)).toEqual([address(22), address(20), address(21), address(23)]);
    // All wallets still pass the 1% S priority screen in this fixture; absence of an acquisition never proves independence.
    expect(s.coverage.unresolved.raw).toBe('1000'); expect(s.coverage.excluded.raw).toBe('300');
    const largeSupply = input([[3, '9000'], [20, '300'], [21, '300'], [22, '300'], [23, '100']], '100000');
    const small = measureGroupedCoverageV2({ ...i, supply: largeSupply.supply });
    expect(small.coverage.omitted.raw).toBe('100'); expect(small.coverage.omittedCount).toBe(1);
  });

  it('rejects overlapping accepted groups, unreconciled lots/balances and mismatched captured states', () => {
    const i = input([[3, '5000'], [20, '2500'], [21, '2500']]); group(i, 1, [3, 20], 'control'); group(i, 2, [20, 21], 'control');
    expect(() => measureGroupedCoverageV2(i)).toThrow('Overlapping');
    const lots = input([[3, '10000']]); lots.lots[0].units.raw = '10001'; expect(() => measureGroupedCoverageV2(lots)).toThrow('lots exceed');
    const state = input([[3, '10000']]); state.graph.at.cursor = at(9); expect(() => measureGroupedCoverageV2(state)).toThrow('state/availability');
    const balance = input([[3, '10000']]); balance.supply.holdings[0].liquid.value!.raw = '9999'; expect(() => measureGroupedCoverageV2(balance)).toThrow('reconcile');
  });

  it('incrementally updates only touched sums and replaces split/reorg groups across dependent coins', () => {
    const i = input([[3, '5000'], [20, '1000'], [21, '1000'], [22, '1000'], [23, '1000'], [24, '1000']]);
    const a = group(i, 1, [3, 20], 'control'), b = group(i, 2, [21, 22, 23]);
    const engine = new GroupedCoverageEngine(), first = engine.update(i);
    expect(Object.isFrozen(first)).toBe(true); expect(engine.update(i).incremental.recomputedComponents).toEqual([]);
    const next = structuredClone(i);
    for (const [who, raw] of [[20, '900'], [24, '1100']] as const) {
      const h = next.supply.holdings.find(h => h.address === address(who))!; h.raw.value!.raw = h.liquid.value!.raw = raw;
      next.lots.find(l => l.owner === address(who))!.units.raw = raw;
    }
    const updated = engine.update(next); expect(updated.incremental.recomputedComponents).toEqual([a]);
    expect(updated.components.find(c => c.id === b)!.holdings.liquid.value?.raw).toBe('3000');
    expect(updated.controlTop10).toEqual(measureGroupedCoverageV2(next).controlTop10);
    const other = structuredClone(next), otherCoin = address(9999);
    function port(v: unknown): void {
      if (!v || typeof v !== 'object') return;
      for (const [key, value] of Object.entries(v)) {
        if (value === coin) (v as Record<string, unknown>)[key] = otherCoin; else port(value);
      }
    }
    port(other); engine.update(other);
    expect(engine.affectedCoins(4663, [address(20)])).toEqual([coin, otherCoin]);
    for (const source of [next, other]) {
      source.graph.components = source.graph.components.filter(c => c.id !== a); source.graph.edges = source.graph.edges.filter(e => e.kind !== 'control');
      const s = engine.update(source); expect(s.incremental.retiredComponents).toEqual([a]); expect(s.operator.liquid.value?.raw).toBe('5000');
      expect(s.controlTop10).toEqual(measureGroupedCoverageV2(source).controlTop10);
    }
    const invalid = structuredClone(next); invalid.lots[0].units.raw = '999999';
    const before = engine.snapshot(4663, coin); expect(() => engine.update(invalid)).toThrow(); expect(engine.snapshot(4663, coin)).toBe(before);
  });
});


it('053 bounds component ownership, evicts reverse dependencies and restores normalized checkpoints', () => {
  const first = input([[3, '5000'], [20, '5000']]);
  group(first, 1, [3, 20], 'control');
  const engine = new GroupedCoverageEngine({ coins: 1, bytes: 1000000, holders: 10, components: 10 });
  const s = engine.update(first), source = '1'.repeat(64), candidate = '2'.repeat(64);
  const cp = engine.checkpoint(source, candidate);
  const restored = GroupedCoverageEngine.restore(JSON.parse(JSON.stringify(cp)), source, candidate);
  expect(restored.snapshot(4663, coin)).toEqual(s);
  expect(restored.affectedCoins(4663, [address(20)])).toEqual([coin]);
  expect(() => GroupedCoverageEngine.restore(cp, '3'.repeat(64), candidate)).toThrow();
  const other = JSON.parse(JSON.stringify(input([[3, '10000']])).replaceAll(coin, address(90))) as GroupedCoverageInput;
  engine.update(other);
  expect(engine.snapshot(4663, coin)).toBeUndefined(); expect(engine.affectedCoins(4663, [address(20)])).toEqual([]);
  expect(engine.stats().coins).toBe(1); engine.evict(4663, address(90)); expect(engine.stats().reverseWallets).toBe(0);
  const tiny = new GroupedCoverageEngine({ coins: 1, bytes: 1, holders: 10, components: 10 });
  expect(tiny.update(first)).toEqual(s); expect(tiny.stats()).toEqual({ coins: 0, bytes: 0, reverseWallets: 0 });
});

it('053 maintained holder rankings match an independent sort after ties, touched transfers and checkpoint resume', () => {
  const rows: [number, string][] = Array.from({ length: 64 }, (_, n) => [100 + n, '100']);
  let engine = new GroupedCoverageEngine();
  for (let step = 0; step < 20; step++) {
    const a = step % 64, b = (step * 7 + 1) % 64;
    rows[a][1] = String(BigInt(rows[a][1]) + 3n); rows[b][1] = String(BigInt(rows[b][1]) - 3n);
    const i = input(rows), s = engine.update(i);
    const expected = [...rows].sort((a, b) => BigInt(a[1]) > BigInt(b[1]) ? -1 : BigInt(a[1]) < BigInt(b[1]) ? 1 : a[0] - b[0]).slice(0, 10);
    expect(s.rawTop10.map(r => [r.address, r.units.value?.raw])).toEqual(expected.map(([n, raw]) => [address(n), raw]));
    expect(s.incremental.touchedWallets.length).toBeLessThanOrEqual(step === 0 ? 64 : 2);
    if (step === 10) {
      engine = GroupedCoverageEngine.restore(engine.checkpoint('1'.repeat(64), '2'.repeat(64)), '1'.repeat(64), '2'.repeat(64));
      expect(engine.snapshot(4663, coin)).toEqual(s);
    }
  }
});
