import { keccak256, stringToHex } from 'viem';
import { z } from 'zod';
import { canonicalize, compareGuardCursors, guardKnownBy, PositionSharesSchema, createGuardMetric,
  RawAmountSchema, CoinCardV2Schema, GuardAssessmentCheckSchema, AddressSchema, Bytes32Schema } from '@eko/shared';
import type { Address, GuardCursor, Metric, MetricId, PositionShares, RawAmount } from '@eko/shared';
import { GroupedCoverageInputSchema } from './grouped-coverage-input.js';
import type { GroupedCoverageInput } from './grouped-coverage-input.js';

export const GROUPED_COVERAGE_VERSION = '2.0.0';
type Hash = `0x${string}`;
type Balance = { raw: bigint; liquid: bigint; locked: bigint };
const empty = (): Balance => ({ raw: 0n, liquid: 0n, locked: 0n });
const add = (a: Balance, b: Balance): Balance => ({ raw: a.raw + b.raw, liquid: a.liquid + b.liquid, locked: a.locked + b.locked });
const equalBalance = (a: Balance | undefined, b: Balance | undefined) => a?.raw === b?.raw && a?.liquid === b?.liquid && a?.locked === b?.locked;
const hash = (v: unknown): Hash => keccak256(stringToHex(canonicalize(v)));
const sorted = <T extends string>(xs: T[]) => [...new Set(xs)].sort();
const percent = (n: bigint, d: bigint) => {
  const scale = 10n ** 36n, v = n * 100n * scale / d;
  const tail = (v % scale).toString().padStart(36, '0').replace(/0+$/, '');
  return `${v / scale}${tail ? `.${tail}` : ''}`;
};
const sameState = (a: GuardCursor, b: GuardCursor) => compareGuardCursors(a, b) === 0;
function freeze<T>(v: T): T {
  if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v;
}

type RankRow = { key: string; units: bigint };
type RankNode = { row: RankRow; left: RankNode | null; right: RankNode | null; height: number };
type RankCompare = (a: RankRow, b: RankRow) => number;
const height = (n: RankNode | null) => n?.height ?? 0;
const node = (row: RankRow, left: RankNode | null, right: RankNode | null): RankNode => ({ row, left, right, height: 1 + Math.max(height(left), height(right)) });
const rotateLeft = (n: RankNode) => node(n.right!.row, node(n.row, n.left, n.right!.left), n.right!.right);
const rotateRight = (n: RankNode) => node(n.left!.row, n.left!.left, node(n.row, n.left!.right, n.right));
function balance(n: RankNode): RankNode {
  if (height(n.left) - height(n.right) > 1) {
    if (height(n.left!.right) > height(n.left!.left)) n = node(n.row, rotateLeft(n.left!), n.right);
    return rotateRight(n);
  }
  if (height(n.right) - height(n.left) > 1) {
    if (height(n.right!.left) > height(n.right!.right)) n = node(n.row, n.left, rotateRight(n.right!));
    return rotateLeft(n);
  }
  return n;
}
function insertRank(n: RankNode | null, row: RankRow, compare: RankCompare): RankNode {
  if (!n) return node(row, null, null);
  const c = compare(row, n.row);
  return balance(c < 0 ? node(n.row, insertRank(n.left, row, compare), n.right) :
    c > 0 ? node(n.row, n.left, insertRank(n.right, row, compare)) : node(row, n.left, n.right));
}
function removeRank(n: RankNode | null, row: RankRow, compare: RankCompare): RankNode | null {
  if (!n) return null;
  const c = compare(row, n.row);
  if (c < 0) return balance(node(n.row, removeRank(n.left, row, compare), n.right));
  if (c > 0) return balance(node(n.row, n.left, removeRank(n.right, row, compare)));
  if (!n.left) return n.right; if (!n.right) return n.left;
  let successor = n.right; while (successor.left) successor = successor.left;
  return balance(node(successor.row, n.left, removeRank(n.right, successor.row, compare)));
}
const keyOrder: RankCompare = (a,b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
const scoreOrder: RankCompare = (a,b) => a.units > b.units ? -1 : a.units < b.units ? 1 : keyOrder(a,b);
/** Persistent AVL indexes: touched updates O(log holders), top ten O(log holders + 10), clone O(1). */
class Ranking {
  private ranked: RankNode | null = null;
  private keyed: RankNode | null = null;
  clone() { const r = new Ranking(); r.ranked = this.ranked; r.keyed = this.keyed; return r; }
  set(key: string, units: bigint) {
    let found = this.keyed;
    while (found && found.row.key !== key) found = key < found.row.key ? found.left : found.right;
    if (found?.row.units === units) return;
    if (found) { this.ranked = removeRank(this.ranked, found.row, scoreOrder); this.keyed = removeRank(this.keyed, found.row, keyOrder); }
    if (units > 0n) { const row = { key, units }; this.ranked = insertRank(this.ranked, row, scoreOrder); this.keyed = insertRank(this.keyed, row, keyOrder); }
  }
  top() {
    const rows: RankRow[] = [];
    const visit = (n: RankNode | null): void => { if (!n || rows.length === 10) return; visit(n.left); if (rows.length < 10) rows.push(n.row); visit(n.right); };
    visit(this.ranked); return rows;
  }
}
type Cache = { balances: Map<Address, Balance>; sums: Map<Hash, Balance>; members: Map<Hash, Address[]>;
  walletGroups: Map<Address, Set<Hash>>; rawRank: Ranking; controlRank: Ranking; assignments: Map<Address, string> };
const newCache = (): Cache => ({ balances: new Map(), sums: new Map(), members: new Map(), walletGroups: new Map(),
  rawRank: new Ranking(), controlRank: new Ranking(), assignments: new Map() });

export interface GroupedCoverageSnapshot {
  schemaVersion: 'grouped-coverage-2'; methodVersion: string; mode: 'shadow'; coin: Address;
  cursor: GroupedCoverageInput['supply']['cursor']; knownAt: GroupedCoverageInput['supply']['knownAt']; inputHash: Hash;
  principal: PositionShares; operator: PositionShares;
  components: { id: Hash; kind: 'control' | 'coordination'; memberIds: Address[]; holdings: PositionShares; scoringEligible: boolean }[];
  coordinatedLargest: Metric<PositionShares>; coordinatedUnion: Metric<PositionShares>;
  rawTop10: GroupedCoverageInput['supply']['supply']['rawTop10'];
  controlTop10: GroupedCoverageInput['supply']['supply']['rawTop10'];
  top10RawPct: Metric<string>; top10ControlPct: Metric<string>;
  principalOriginOverhang: Metric<PositionShares>; earlyOriginOverhang: Metric<PositionShares>;
  principalOriginUpper: PositionShares; earlyOriginUpper: PositionShares; principalOriginScoringEligible: boolean;
  horizonRelease: { releasableByHorizon: Metric<RawAmount>; scenarioPct: Metric<string>; horizonSec: 3600 };
  coverage: {
    check: ReturnType<typeof GuardAssessmentCheckSchema.parse>; covered: RawAmount; unresolved: RawAmount;
    omitted: RawAmount; omittedCount: number; excluded: RawAmount; excludedCount: number;
    unresolvedJointGroup: Metric<RawAmount>; unresolvedJointPct: Metric<string>;
    nextBoundaryPct: 15 | 30 | 50 | null;
    materialCandidates: { id: Hash; memberIds: Address[]; possibleUnits: RawAmount; assessed: boolean }[];
    queue: { address: Address; liquid: RawAmount; latestAcquisition: GuardCursor | null;
      reasons: ('launch_300s' | 'principal_origin' | 'large_holder' | 'late_acquisition' | 'float_expansion')[] }[];
    gaps: string[];
  };
  incremental: { touchedWallets: Address[]; recomputedComponents: Hash[]; retiredComponents: Hash[] };
}

function evaluate(input: GroupedCoverageInput, prior: Cache): { snapshot: GroupedCoverageSnapshot; cache: Cache } {
  const { supply, graph, principal } = input, { coin, cursor, knownAt } = supply;
  if (cursor.boundary !== 'block_end' || !sameState(cursor, graph.at.cursor) || graph.coin !== coin.toLowerCase() ||
    !guardKnownBy(graph.at, knownAt)) throw new Error('Grouped snapshot scope/state/availability mismatch');
  const available = (p: { cursor: GuardCursor; knownAt: typeof knownAt }) => compareGuardCursors(p.cursor, cursor) <= 0 &&
    compareGuardCursors(p.cursor, p.knownAt.cursor) <= 0 && guardKnownBy(p.knownAt, knownAt);
  const complete = (c: GroupedCoverageInput['actorCoverage']) => c.complete && c.gaps.length === 0 && c.from !== null &&
    c.through !== null && sameState(c.through, cursor) && compareGuardCursors(c.from, cursor) <= 0;
  const quantity = (n: bigint): RawAmount => ({ asset: coin, decimals: supply.supply.total.value?.decimals ??
    supply.supply.holderFloat.value?.decimals ?? 0, raw: n.toString() });
  const amount = (m: Metric<RawAmount>) => {
    if (m.status !== 'observed' || !m.coverage.complete || !sameState(m.cursor, cursor) || !guardKnownBy(m.knownAt, knownAt)) return null;
    if (m.value.asset.toLowerCase() !== coin.toLowerCase() || m.value.decimals !== quantity(0n).decimals) throw new Error('Grouped amount asset mismatch');
    return BigInt(m.value.raw);
  };
  const S = amount(supply.supply.total), float = amount(supply.supply.holderFloat);
  const acquisitionComplete = complete(input.acquisitionCoverage) && input.launchedAtSec !== null &&
    BigInt(input.acquisitionCoverage.from!.timestampSec) <= BigInt(input.launchedAtSec);
  const F = supply.floatState === 'stable' && supply.check.status === 'complete' && float !== null && float > 0n ? float : null;
  const evidenceIds = sorted([...supply.check.evidenceIds, ...graph.edges.flatMap(e => e.evidenceIds),
    ...input.lots.flatMap(l => l.evidenceIds), ...input.investigations.filter(available).flatMap(i => i.evidenceIds),
    ...input.acquisitions.filter(available).flatMap(a => a.evidenceIds), ...input.releases.filter(available).flatMap(r => r.evidenceIds)]);
  function metric<T>(id: MetricId, value: T | null, unit: Metric<T>['unit'], status: 'observed' | 'lower_bound' | 'upper_bound' = 'observed',
    numerator: RawAmount | null = null, denominator: RawAmount | null = null, denominatorKind: Metric<T>['denominatorKind'] = null): Metric<T> {
    const measured = value !== null;
    return { id, cursor, knownAt, unit, numerator, denominator, denominatorKind,
      fromSec: input.actorCoverage.from?.timestampSec ?? null, throughSec: cursor.timestampSec,
      coverage: { ...input.actorCoverage, scopeId: `grouped-${id}`, complete: measured, gaps: measured ? [] : ['missing'] },
      methodVersion: GROUPED_COVERAGE_VERSION, evidenceIds,
      ...(measured ? { status, value, failureCode: status === 'observed' ? null : 'missing' as const } :
        { status: 'unknown' as const, value: null, failureCode: 'missing' as const }) };
  }
  const units = (id: MetricId, n: bigint | null, status: 'observed' | 'lower_bound' | 'upper_bound' = 'observed') =>
    metric(id, n === null ? null : quantity(n), 'raw', status);
  const ratio = (id: MetricId, n: bigint | null, d: bigint | null, status: 'observed' | 'lower_bound' | 'upper_bound' = 'observed', kind: 'S' | 'F' | 'other' = 'F') =>
    metric(id, n !== null && d !== null && d > 0n ? percent(n, d) : null, 'pct', status,
      n === null ? null : quantity(n), d !== null && d > 0n ? quantity(d) : null, kind);
  const shares = (b: Balance | null, status: 'observed' | 'lower_bound' | 'upper_bound' = 'observed'): PositionShares => PositionSharesSchema.parse({
    raw: units('raw', b?.raw ?? null, status), liquid: units('liquid', b?.liquid ?? null, status), locked: units('locked', b?.locked ?? null, status),
    supplyPct: ratio('supplyPct', b?.liquid ?? null, S, status, 'S'), floatPct: ratio('floatPct', b?.liquid ?? null, F, status) });
  const external = new Map<Address, Balance>();
  let balancesKnown = supply.check.status === 'complete';
  const seen = new Set<Address>();
  for (const h of supply.holdings) {
    const a = h.address.toLowerCase() as Address;
    if (seen.has(a)) throw new Error('Duplicate grouped holder'); seen.add(a);
    if (h.bucket !== 'external') continue;
    const raw = amount(h.raw), liquid = amount(h.liquid), locked = amount(h.locked);
    if (raw === null || liquid === null || locked === null) { balancesKnown = false; continue; }
    if (liquid + locked > raw) throw new Error('Unreconciled grouped holding');
    external.set(a, { raw, liquid, locked });
  }
  if (float !== null && balancesKnown && [...external.values()].reduce((n, b) => n + b.liquid, 0n) !== float)
    throw new Error('Grouped holdings do not reconcile to float');
  const edgeMap = new Map(graph.edges.map(e => [e.id, e]));
  if (edgeMap.size !== graph.edges.length || new Set(graph.components.map(c => c.id)).size !== graph.components.length)
    throw new Error('Duplicate grouped graph record');
  const partitions = new Map<string, Set<Address>>();
  for (const c of graph.components) {
    if (c.graphVersion !== graph.graphVersion || new Set(c.memberIds).size !== c.memberIds.length ||
      c.memberIds.join() !== [...c.memberIds].sort().join()) throw new Error('Invalid grouped component');
    const own = c.edgeIds.map(id => edgeMap.get(id));
    if (own.some(e => !e || e.kind !== c.kind || e.status !== 'qualified' || e.memberIds.some(a => !c.memberIds.includes(a))) ||
      sorted(own.flatMap(e => e!.memberIds)).join() !== c.memberIds.join()) throw new Error('Grouped component lacks accepted edges');
    if (!partitions.has(c.kind)) partitions.set(c.kind, new Set());
    const members = partitions.get(c.kind)!;
    for (const a of c.memberIds) { if (members.has(a)) throw new Error('Overlapping same-kind grouped components'); members.add(a); }
    if (c.groupScoringEligible && (c.kind !== 'coordination' ||
      new Set(c.participants.filter(p => p.roles.length && c.memberIds.includes(p.address)).map(p => p.address)).size < 3))
      throw new Error('Coordination needs three economic participants');
  }
  // Copy before changing cache so invalid observations cannot partially replace a checkpoint.
  const cache: Cache = { ...prior, balances: external, sums: new Map(prior.sums), members: new Map(), walletGroups: new Map(),
    rawRank: prior.rawRank.clone(), controlRank: prior.controlRank.clone(), assignments: new Map() };
  const touched = sorted([...new Set([...external.keys(), ...prior.balances.keys()])].filter(a =>
    !equalBalance(external.get(a), prior.balances.get(a))));
  const components = graph.components.filter(c => c.kind !== 'origin');
  for (const c of components) {
    cache.members.set(c.id, c.memberIds);
    for (const a of c.memberIds) {
      if (!cache.walletGroups.has(a)) cache.walletGroups.set(a, new Set()); cache.walletGroups.get(a)!.add(c.id);
    }
  }
  const dirty = new Set<Hash>(components.filter(c => prior.members.get(c.id)?.join() !== c.memberIds.join()).map(c => c.id));
  for (const a of touched) for (const id of cache.walletGroups.get(a) ?? []) dirty.add(id);
  const retired = [...prior.members.keys()].filter(id => !cache.members.has(id));
  for (const id of retired) cache.sums.delete(id);
  for (const id of dirty) {
    if (prior.members.get(id)?.join() !== cache.members.get(id)!.join()) {
      cache.sums.set(id, cache.members.get(id)!.reduce((b, a) => add(b, external.get(a) ?? empty()), empty()));
    } else {
      let b = prior.sums.get(id)!;
      // Membership is unchanged: apply touched-wallet deltas, not a full component rescan.
      for (const a of touched) if (cache.walletGroups.get(a)?.has(id)) {
        const old = prior.balances.get(a) ?? empty(), next = external.get(a) ?? empty();
        b = add(b, { raw: next.raw - old.raw, liquid: next.liquid - old.liquid, locked: next.locked - old.locked });
      }
      cache.sums.set(id, b);
    }
  }
  for (const a of touched) cache.rawRank.set(a, external.get(a)?.liquid ?? 0n);
  const controls = components.filter(c => c.kind === 'control');
  const controlByWallet = new Map(controls.flatMap(c => c.memberIds.map(a => [a, c] as const)));
  for (const a of external.keys()) cache.assignments.set(a, controlByWallet.get(a)?.id ?? a);
  const changedKeys = new Set<string>([...retired, ...dirty]);
  const touchedSet = new Set(touched);
  for (const a of new Set([...touched, ...prior.assignments.keys(), ...cache.assignments.keys()])) {
    const old = prior.assignments.get(a), next = cache.assignments.get(a);
    if (touchedSet.has(a) || old !== next) { if (old) changedKeys.add(old); if (next) changedKeys.add(next); }
  }
  const controlIds = new Set(controls.map(c => c.id));
  for (const key of changedKeys) cache.controlRank.set(key, controlIds.has(key as Hash) ? cache.sums.get(key as Hash)!.liquid :
    cache.assignments.get(key as Address) === key ? external.get(key as Address)?.liquid ?? 0n : 0n);
  const sum = (members: Address[]) => members.reduce((b, a) => add(b, external.get(a) ?? empty()), empty());
  const custody = new Set(input.unresolvedCustody);
  const operatorMembers = principal === null ? null : controlByWallet.get(principal)?.memberIds ?? [principal];
  const operatorKnown = operatorMembers !== null && balancesKnown && !operatorMembers.some(a => custody.has(a));
  const eligible = components.filter(c => c.kind === 'coordination' && c.groupScoringEligible);
  const union = eligible.reduce((b, c) => add(b, cache.sums.get(c.id)!), empty());
  const largest = eligible.reduce<typeof eligible[number] | undefined>((best, c) => {
    if (!best) return c;
    const x = cache.sums.get(c.id)!.liquid, y = cache.sums.get(best.id)!.liquid;
    return x > y || x === y && c.id < best.id ? c : best;
  }, undefined);
  const graphComplete = complete(input.actorCoverage) && acquisitionComplete && complete(input.originCoverage) && graph.issues.length === 0;
  const groupStatus = graphComplete ? 'observed' as const : 'lower_bound' as const;
  const compound = (id: MetricId, b: Balance | null, status: 'observed' | 'lower_bound' | 'upper_bound' = 'observed') =>
    createGuardMetric(PositionSharesSchema).parse(metric(id, b === null ? null : shares(b, status), 'compound', status));
  const coordinatedLargest = compound('largestCoordinatedHeld', balancesKnown ? largest ? cache.sums.get(largest.id)! :
    graphComplete ? empty() : null : null, groupStatus);
  const coordinatedUnion = compound('unionCoordinatedHeld', balancesKnown && (eligible.length || graphComplete) ? union : null, groupStatus);
  const top = (r: Ranking, grouped: boolean) => r.top().map(row => {
    const c = grouped ? controls.find(c => c.id === row.key) : undefined;
    return { address: c ? c.memberIds[0] : row.key as Address, groupId: c?.id ?? null, units: units('liquid', balancesKnown ? row.units : null) };
  });
  const topSum = (r: Ranking) => r.top().reduce((n, b) => n + b.units, 0n);

  const lots = input.lots.map(l => ({ ...l, owner: l.owner.toLowerCase() as Address,
    origin: l.origin?.toLowerCase() as Address ?? null, originAlternatives: l.originAlternatives.map(a => a?.toLowerCase() as Address ?? null) }));
  if (new Set(lots.map(l => l.id)).size !== lots.length) throw new Error('Duplicate grouped lot');
  const lotTotals = new Map<Address, Balance>();
  for (const l of lots) {
    if (l.units.asset.toLowerCase() !== coin.toLowerCase() || l.units.decimals !== quantity(0n).decimals ||
      compareGuardCursors(l.acquiredAt, cursor) > 0) throw new Error('Grouped lot scope/cursor mismatch');
    if (l.state === 'sink' || !external.has(l.owner)) continue;
    const n = BigInt(l.units.raw), b = lotTotals.get(l.owner) ?? empty();
    lotTotals.set(l.owner, add(b, { raw: n, liquid: l.state === 'liquid' ? n : 0n, locked: l.state === 'locked' ? n : 0n }));
  }
  for (const [a, b] of lotTotals) {
    const balance = external.get(a)!;
    if (b.raw > balance.raw || b.liquid > balance.liquid || b.locked > balance.locked) throw new Error('Grouped lots exceed effective balance');
  }
  const originComplete = complete(input.originCoverage) && balancesKnown && [...external].every(([a, b]) => {
    const l = lotTotals.get(a) ?? empty(); return l.liquid === b.liquid && l.locked === b.locked;
  });
  function origin(target: (l: typeof lots[number], a: Address) => boolean, known: boolean) {
    let lower = empty(), upper = empty();
    if (!known || !balancesKnown) return { metric: null, lower: null, upper: null };
    for (const l of lots.filter(l => l.state !== 'sink' && external.has(l.owner))) {
      const possible = l.originAlternatives.some(a => a === null || target(l, a));
      const certain = l.originAlternatives.every(a => a !== null && target(l, a));
      const n = BigInt(l.units.raw), b = { raw: n, liquid: l.state === 'liquid' ? n : 0n, locked: l.state === 'locked' ? n : 0n };
      if (certain) lower = add(lower, b); if (possible) upper = add(upper, b);
    }
    for (const [a, b] of external) {
      const traced = lotTotals.get(a) ?? empty();
      upper = add(upper, { raw: b.liquid + b.locked - traced.raw, liquid: b.liquid - traced.liquid, locked: b.locked - traced.locked });
    }
    return { metric: lower, lower, upper, exact: originComplete && equalBalance(lower, upper) };
  }
  const principalOrigin = origin((_l, a) => a === principal, principal !== null);
  const earlyOrigin = origin((l, a) => input.firstTradeSec !== null && BigInt(l.acquiredAt.timestampSec) >= BigInt(input.firstTradeSec) &&
    BigInt(l.acquiredAt.timestampSec) < BigInt(input.firstTradeSec) + 5n && input.acquisitions.some(b => b.kind === 'buy' &&
      available(b) && b.recipient === a && sameState(b.cursor, l.acquiredAt)), input.firstTradeSec !== null && acquisitionComplete);
  const acquisitionMap = new Map<Address, GuardCursor>();
  const earlyRecipients = new Set<Address>(), lateRecipients = new Set<Address>();
  if (new Set(input.acquisitions.map(a => a.id)).size !== input.acquisitions.length) throw new Error('Duplicate grouped acquisition');
  for (const a of input.acquisitions.filter(available)) {
    const old = acquisitionMap.get(a.recipient);
    if (!old || compareGuardCursors(a.cursor, old) > 0) acquisitionMap.set(a.recipient, a.cursor);
    if (input.launchedAtSec !== null) {
      const t = BigInt(a.cursor.timestampSec), launch = BigInt(input.launchedAtSec);
      if (t >= launch && t < launch + 300n) earlyRecipients.add(a.recipient);
      if (t >= launch + 300n) lateRecipients.add(a.recipient);
    }
  }
  const descendants = new Set(lots.filter(l => principal !== null && l.originAlternatives.includes(principal)).map(l => l.owner));
  const investigated = new Set(input.investigations.filter(i => available(i) && sameState(i.cursor, cursor) && complete(i.coverage) &&
    !custody.has(i.address)).map(i => i.address));
  const excluded = new Set(input.exclusions.filter(e => available(e) && sameState(e.cursor, cursor)).map(e => e.address));
  const queue: GroupedCoverageSnapshot['coverage']['queue'] = [];
  let covered = 0n, unresolved = 0n, omitted = 0n, omittedCount = 0, excludedMass = 0n, excludedCount = 0;
  for (const [a, b] of external) {
    if (!b.liquid) continue;
    if (excluded.has(a)) { excludedMass += b.liquid; excludedCount++; }
    if (investigated.has(a)) { covered += b.liquid; continue; }
    unresolved += b.liquid;
    const reasons: typeof queue[number]['reasons'] = [];
    if (earlyRecipients.has(a)) reasons.push('launch_300s'); if (descendants.has(a)) reasons.push('principal_origin');
    if (S !== null && b.liquid * 100n >= S) reasons.push('large_holder');
    if (lateRecipients.has(a)) reasons.push('late_acquisition');
    if (!reasons.length) { omitted += b.liquid; omittedCount++; reasons.push('float_expansion'); }
    queue.push({ address: a, liquid: quantity(b.liquid), latestAcquisition: acquisitionMap.get(a) ?? null, reasons });
  }
  queue.sort((a, b) => {
    const x = BigInt(a.liquid.raw), y = BigInt(b.liquid.raw);
    if (x !== y) return x > y ? -1 : 1;
    if (a.latestAcquisition && b.latestAcquisition) return compareGuardCursors(b.latestAcquisition, a.latestAcquisition) || a.address.localeCompare(b.address);
    return a.latestAcquisition ? -1 : b.latestAcquisition ? 1 : a.address.localeCompare(b.address);
  });
  // Candidate/control edges may overlap; investigate their connected union, never score it as ownership.
  const candidateSets: Set<Address>[] = [];
  for (const e of graph.edges.filter(e => e.kind === 'coordination' || e.kind === 'control')) {
    const joined = new Set(e.memberIds), overlap = candidateSets.filter(s => [...s].some(a => joined.has(a)));
    for (const s of overlap) { s.forEach(a => joined.add(a)); candidateSets.splice(candidateSets.indexOf(s), 1); }
    candidateSets.push(joined);
  }
  const materialCandidates = candidateSets.map(s => {
    const memberIds = [...s].sort(), possible = sum(memberIds).liquid;
    return { id: hash([graph.graphVersion, memberIds]), memberIds, possibleUnits: quantity(possible),
      assessed: memberIds.every(a => !external.get(a)?.liquid || investigated.has(a)) };
  }).filter(c => F !== null && BigInt(c.possibleUnits.raw) * 100n >= F * 15n).sort((a, b) => a.id.localeCompare(b.id));
  const bound = float === null ? null : union.liquid + unresolved > float ? float : union.liquid + unresolved;
  const nextBoundaryPct = F === null ? null : ([15, 30, 50] as const).find(p => union.liquid * 100n < F * BigInt(p)) ?? null;
  const gaps: string[] = [];
  if (F === null || !balancesKnown) gaps.push('supply_float');
  if (!acquisitionComplete) gaps.push('candidate_universe');
  if (!originComplete) gaps.push('current_origin'); if (!complete(input.actorCoverage)) gaps.push('direct_actor');
  if (graph.issues.length) gaps.push('graph_paths'); if (custody.size) gaps.push('unresolved_custody');
  if (F === null || covered * 100n < F * 95n) gaps.push('float_coverage');
  if (F !== null && bound !== null && nextBoundaryPct !== null && bound * 100n >= F * BigInt(nextBoundaryPct)) gaps.push('next_coordination_boundary');
  if (materialCandidates.some(c => !c.assessed)) gaps.push('material_component');
  const check = GuardAssessmentCheckSchema.parse({ id: 'coordination_coverage', tier: 'lower_tier',
    status: gaps.length ? 'missing' : 'complete', failureCode: gaps.length ? 'missing' : null, evidenceIds,
    coverage: { ...input.actorCoverage, scopeId: 'grouped-coordination', complete: gaps.length === 0, gaps: gaps.length ? ['missing'] : [],
      coveredUnits: quantity(covered), excludedUnits: quantity(excludedMass) } });
  const releaseIds = new Set<Hash>(), releaseMass = new Map<Address, bigint>();
  let release = 0n;
  const releaseKnown = operatorKnown && complete(input.releaseCoverage);
  for (const r of input.releases.filter(available)) {
    if (releaseIds.has(r.id)) throw new Error('Duplicate horizon release'); releaseIds.add(r.id);
    if (!sameState(r.cursor, cursor)) throw new Error('Horizon release proof is not effective at snapshot');
    const n = BigInt(r.units), total = (releaseMass.get(r.owner) ?? 0n) + n; releaseMass.set(r.owner, total);
    if (balancesKnown && total > (external.get(r.owner)?.locked ?? 0n)) throw new Error('Horizon releases exceed unavailable holding');
    const t = BigInt(r.releaseAtSec), now = BigInt(cursor.timestampSec);
    if (operatorMembers?.includes(r.owner) && t > now && t <= now + 3600n) release += n;
  }
  const rawTop10 = CoinCardV2Schema.shape.supply.shape.rawTop10.parse(top(cache.rawRank, false));
  const controlTop10 = CoinCardV2Schema.shape.supply.shape.controlTop10.parse(top(cache.controlRank, true));
  const snapshot: GroupedCoverageSnapshot = {
    schemaVersion: 'grouped-coverage-2', methodVersion: GROUPED_COVERAGE_VERSION, mode: 'shadow', coin, cursor, knownAt, inputHash: hash(input),
    principal: shares(principal !== null && balancesKnown ? sum([principal]) : null), operator: shares(operatorKnown ? sum(operatorMembers!) : null),
    components: components.map(c => ({ id: c.id, kind: c.kind as 'control' | 'coordination', memberIds: c.memberIds,
      holdings: shares(balancesKnown ? cache.sums.get(c.id)! : null), scoringEligible: c.kind === 'coordination' && c.groupScoringEligible })),
    coordinatedLargest, coordinatedUnion, rawTop10, controlTop10,
    top10RawPct: ratio('topAddress10', balancesKnown ? topSum(cache.rawRank) : null, F),
    top10ControlPct: ratio('topControl10', balancesKnown && custody.size === 0 ? topSum(cache.controlRank) : null, F),
    principalOriginOverhang: compound('principalOriginOverhang', principalOrigin.metric, principalOrigin.exact ? 'observed' : 'lower_bound'),
    earlyOriginOverhang: compound('earlyOriginOverhang', earlyOrigin.metric, earlyOrigin.exact ? 'observed' : 'lower_bound'),
    principalOriginUpper: shares(principalOrigin.upper, 'upper_bound'), earlyOriginUpper: shares(earlyOrigin.upper, 'upper_bound'),
    principalOriginScoringEligible: input.principalOriginScoringAccepted && principalOrigin.exact === true,
    horizonRelease: { horizonSec: 3600, releasableByHorizon: createGuardMetric(RawAmountSchema).parse(units('releasableByHorizon', releaseKnown ? release : null)),
      scenarioPct: ratio('releasableByHorizon', releaseKnown ? release : null, F === null ? null : F + release, 'observed', 'other') },
    coverage: { check, covered: quantity(covered), unresolved: quantity(unresolved), omitted: quantity(omitted), omittedCount,
      excluded: quantity(excludedMass), excludedCount, unresolvedJointGroup: createGuardMetric(RawAmountSchema).parse(units('controlBound', balancesKnown ? bound : null, 'upper_bound')),
      unresolvedJointPct: ratio('unresolvedFloatPct', balancesKnown ? bound : null, F, 'upper_bound'), nextBoundaryPct, materialCandidates, queue, gaps },
    incremental: { touchedWallets: touched, recomputedComponents: [...dirty].sort(), retiredComponents: retired.sort() },
  };
  return { snapshot: freeze(snapshot), cache };
}

/** Pure fixture/caller-supplied measurement. It does not enable V2 or perform acquisition. */
export function measureGroupedCoverageV2(raw: GroupedCoverageInput): GroupedCoverageSnapshot {
  return evaluate(GroupedCoverageInputSchema.parse(raw), newCache()).snapshot;
}

/** Local incremental state; callers supply effective replacement graphs after expiry/split/reorg.
 * Reverse dependencies identify every coin affected by wallet/service/control reclassification. */
export class GroupedCoverageEngine {
  private coins = new Map<string, { cache: Cache; snapshot: GroupedCoverageSnapshot; dependencies: Address[]; input: GroupedCoverageInput; bytes: number }>();
  private walletCoins = new Map<string, Set<Address>>();
  private bytes = 0;
  constructor(readonly limits = { coins: 64, bytes: 32 * 1024 * 1024, holders: 10000, components: 10000 }) {
    for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid grouped cache budget');
    this.limits = Object.freeze({ ...limits });
  }
  evict(chainId: number, coin: Address) {
    const key = `${chainId}:${coin.toLowerCase()}`, old = this.coins.get(key);
    if (!old) return;
    for (const a of old.dependencies) {
      const walletKey = `${chainId}:${a}`, coins = this.walletCoins.get(walletKey)!;
      coins.delete(old.snapshot.coin); if (!coins.size) this.walletCoins.delete(walletKey);
    }
    this.coins.delete(key); this.bytes -= old.bytes;
  }
  stats() { return { coins: this.coins.size, bytes: this.bytes, reverseWallets: this.walletCoins.size }; }
  checkpoint(sourceRevision: string, candidateRevision: string) {
    if (![sourceRevision, candidateRevision].every(r => /^[a-f0-9]{64}$/.test(r))) throw new Error('Grouped checkpoint revision required');
    const body = { version: 1, sourceRevision, candidateRevision, limits: this.limits, inputs: [...this.coins.values()].map(c => c.input),
      incremental: [...this.coins.values()].map(c => c.snapshot.incremental) };
    return { ...body, digest: hash(body) };
  }
  static restore(checkpoint: ReturnType<GroupedCoverageEngine['checkpoint']>, sourceRevision: string, candidateRevision: string) {
    const { digest, ...body } = checkpoint;
    if (body.version !== 1 || body.sourceRevision !== sourceRevision || body.candidateRevision !== candidateRevision || hash(body) !== digest)
      throw new Error('Grouped checkpoint scope/digest mismatch');
    const engine = new GroupedCoverageEngine(body.limits);
    if (body.inputs.length > engine.limits.coins || body.incremental.length !== body.inputs.length) throw new Error('Grouped checkpoint capacity mismatch');
    const metadata = z.strictObject({ touchedWallets: z.array(AddressSchema), recomputedComponents: z.array(Bytes32Schema), retiredComponents: z.array(Bytes32Schema) });
    body.inputs.forEach((input, i) => engine.updateCaptured(input, metadata.parse(body.incremental[i])));
    if (engine.coins.size !== body.inputs.length) throw new Error('Grouped checkpoint exceeds budget or duplicates scope');
    return engine;
  }
  affectedCoins(chainId: number, wallets: Address[]): Address[] {
    return sorted(wallets.flatMap(a => [...this.walletCoins.get(`${chainId}:${a.toLowerCase()}`) ?? []]));
  }
  update(raw: GroupedCoverageInput): GroupedCoverageSnapshot { return this.updateCaptured(raw); }
  private updateCaptured(raw: GroupedCoverageInput, incremental?: GroupedCoverageSnapshot['incremental']): GroupedCoverageSnapshot {
    const input = GroupedCoverageInputSchema.parse(raw), { coin, cursor } = input.supply;
    const key = `${cursor.chainId}:${coin.toLowerCase()}`, old = this.coins.get(key);
    const result = evaluate(input, old?.cache ?? newCache());
    if (incremental) result.snapshot = freeze({ ...result.snapshot, incremental });
    const bytes = Buffer.byteLength(canonicalize({ input, snapshot: result.snapshot }));
    // Oversized hot tokens remain uncached; their normalized inputs belong to durable shards.
    if (bytes > this.limits.bytes || input.supply.holdings.length > this.limits.holders || input.graph.components.length > this.limits.components) {
      this.evict(cursor.chainId, coin); return result.snapshot;
    }
    this.evict(cursor.chainId, coin);
    while (this.coins.size >= this.limits.coins || this.bytes + bytes > this.limits.bytes) {
      const victim = this.coins.values().next().value!; this.evict(victim.snapshot.cursor.chainId, victim.snapshot.coin);
    }
    const wallets = sorted([...result.cache.balances.keys(), ...result.cache.walletGroups.keys(),
      ...input.graph.edges.flatMap(e => e.memberIds), ...input.lots.flatMap(l => l.originAlternatives.filter((a): a is Address => a !== null)),
      ...input.acquisitions.map(a => a.recipient), ...input.exclusions.map(e => e.address), ...(input.principal ? [input.principal] : [])]);
    for (const a of wallets) {
      const walletKey = `${cursor.chainId}:${a}`;
      if (!this.walletCoins.has(walletKey)) this.walletCoins.set(walletKey, new Set()); this.walletCoins.get(walletKey)!.add(coin);
    }
    this.coins.set(key, { ...result, dependencies: wallets, input: freeze(input), bytes }); this.bytes += bytes; return result.snapshot;
  }
  snapshot(chainId: number, coin: Address) { return this.coins.get(`${chainId}:${coin.toLowerCase()}`)?.snapshot; }
}
