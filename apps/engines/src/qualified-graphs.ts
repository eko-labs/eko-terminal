import { keccak256, stringToHex } from 'viem';
import { compareGuardCursors, guardKnownBy, canonicalize } from '@eko/shared';
import type { Address, AvailabilityCut, GuardCursor, RawAmount } from '@eko/shared';
import { fundingFlowId, resolveEffectiveControl, successfulFunding } from '@eko/chain';
import { CONFIG_GUARD_V2 } from '@eko/playbooks';
import { QualifiedGraphInputSchema } from './qualified-graph-input.js';
import type { QualifiedGraphInput } from './qualified-graph-input.js';

export const QUALIFIED_GRAPH_VERSION = CONFIG_GUARD_V2.identityVersion;
type Hash = `0x${string}`;
type Kind = 'control' | 'coordination' | 'origin';
type Class = 'authenticated_control' | 'private_payer' | 'recent_material_funder' | 'collector' | 'closed_loop' | 'bounded_path' | 'medium_path' | 'consolidation' | 'soft_cohort' | 'lot_origin';
export interface GraphParticipant { address: Address; roles: readonly ('funder' | 'buy_payer' | 'buy_recipient' | 'sell_source' | 'proceeds_recipient' | 'purchaser' | 'lot_sender' | 'lot_origin' | 'lot_holder')[] }
export interface QualifiedGraphEdge {
  id: Hash; kind: Kind; evidenceClass: Class; status: 'qualified' | 'candidate'; memberIds: Address[];
  participants: GraphParticipant[]; evidenceIds: Hash[]; sourceIds: Hash[];
  fundingRatio: { numerator: string; denominator: string } | null;
  collectionRatio: { numerator: string; denominator: string } | null;
  fastCollection: string | null; launchBundle: boolean; historyEligible: boolean;
}
export interface QualifiedGraphComponent {
  id: Hash; kind: Kind; memberIds: Address[]; edgeIds: Hash[]; graphVersion: string; supersedes: Hash[];
  participants: GraphParticipant[]; groupScoringEligible: boolean; historyEligible: boolean;
  diagnostics: { deleted: Address; reason: 'highest_degree' | 'unresolved_hub'; remaining: Address[][] }[];
}
export interface QualifiedGraphSnapshot {
  graphVersion: string; coin: Address; at: AvailabilityCut; mode: 'shadow'; edges: QualifiedGraphEdge[];
  observedConnections: { id: string; from: string; to: string; raw: string }[];
  components: QualifiedGraphComponent[]; retired: Hash[]; issues: string[];
}
const hash = (x: unknown): Hash => keccak256(stringToHex(canonicalize(x)));
const sorted = <T extends string>(xs: readonly T[]) => [...new Set(xs)].sort();
const sec = (c: GuardCursor) => BigInt(c.timestampSec);
const participants = (xs: GraphParticipant[]): GraphParticipant[] => sorted(xs.map(x => x.address)).map(address => ({
  address, roles: sorted(xs.filter(x => x.address === address).flatMap(x => x.roles)),
}));
function partition(edges: Pick<QualifiedGraphEdge, 'memberIds'>[], deleted?: Address): Address[][] {
  const neighbors = new Map<Address, Set<Address>>();
  for (const e of edges) {
    const members = e.memberIds.filter(a => a !== deleted);
    for (const a of members) { if (!neighbors.has(a)) neighbors.set(a, new Set()); for (const b of members) if (a !== b) neighbors.get(a)!.add(b); }
  }
  const seen = new Set<Address>(), groups: Address[][] = [];
  for (const a of sorted([...neighbors.keys()])) {
    if (seen.has(a)) continue;
    const pending = [a], group: Address[] = []; seen.add(a);
    while (pending.length) { const next = pending.pop()!; group.push(next); for (const b of neighbors.get(next)!) if (!seen.has(b)) { seen.add(b); pending.push(b); } }
    groups.push(group.sort());
  }
  return groups;
}
function freeze<T>(x: T): T {
  if (x && typeof x === 'object') { for (const v of Object.values(x)) freeze(v); Object.freeze(x); } return x;
}
/** Pure qualification of a conserved factual ledger. Never fetches, assigns keys from transfers,
 * or completes §5.3's population/95%-float coverage checks from a small candidate graph. */
export function qualifyGraphsV2(raw: QualifiedGraphInput, previous?: QualifiedGraphSnapshot): QualifiedGraphSnapshot {
  const input = QualifiedGraphInputSchema.parse(raw), { at, coin } = input;
  if (at.cursor.boundary !== 'block_end') throw new Error('Graph needs completed block state');
  if (previous && (previous.coin !== coin || previous.at.cursor.chainId !== at.cursor.chainId)) throw new Error('Graph predecessor scope mismatch');
  const blocks = new Map<string, string>();
  for (const b of input.canonicalBlocks) { if (blocks.has(b.blockNumber)) throw new Error('Duplicate canonical block'); blocks.set(b.blockNumber, b.blockHash); }
  const canonical = (c: GuardCursor) => c.chainId === at.cursor.chainId && blocks.get(c.blockNumber) === c.blockHash;
  if (!canonical(at.cursor)) throw new Error('Graph snapshot is not canonical');
  const available = (cursor: GuardCursor, knownAt: AvailabilityCut) => canonical(cursor) && canonical(knownAt.cursor) &&
    compareGuardCursors(cursor, at.cursor) <= 0 && compareGuardCursors(cursor, knownAt.cursor) <= 0 && guardKnownBy(knownAt, at);
  const issues = new Set<string>();
  const value = (v: RawAmount | null): bigint | null => {
    if (!v) return null;
    if (v.asset.toLowerCase() !== input.valuationUnit.asset || v.decimals !== input.valuationUnit.decimals) throw new Error('Inconsistent graph valuation unit');
    return BigInt(v.raw);
  };
  const unique = (ids: string[]) => { if (new Set(ids).size !== ids.length) throw new Error('Duplicate graph source'); };
  unique([...input.acquisitions, ...input.sales, ...input.paths, ...input.origin, ...input.soft].map(x => x.id));
  unique(input.flows.map(x => fundingFlowId(x.flow)));
  const buys = input.acquisitions.filter(b => available(b.cursor, b.knownAt));
  const sales = input.sales.filter(s => available(s.cursor, s.knownAt));
  const flows = new Map(input.flows.filter(f => available(f.flow.cursor, f.knownAt) && successfulFunding(f.flow)).map(f => [fundingFlowId(f.flow), f]));
  const services = input.services.filter(s => available(s.cursor, s.knownAt));
  const known = (k: AvailabilityCut) => canonical(k.cursor) && guardKnownBy(k, at);
  const service = (a: Address) => services.some(s => s.address === a && (s.status === 'confirmed' || s.status === 'candidate'));
  const stopped = (a: Address) => service(a) || services.some(s => s.address === a && s.stopControlExpansion);
  const unresolved = (a: Address) => services.some(s => s.address === a && (s.hub !== 'below_threshold' || s.status === 'unresolved'));
  const edges: QualifiedGraphEdge[] = [];
  const add = (e: Omit<QualifiedGraphEdge, 'id' | 'memberIds'> & { memberIds?: Address[] }) => {
    const normalized = { ...e, participants: participants(e.participants), memberIds: sorted(e.memberIds ?? e.participants.map(p => p.address)),
      evidenceIds: sorted(e.evidenceIds), sourceIds: sorted(e.sourceIds) };
    if (normalized.memberIds.length >= 2) edges.push({ ...normalized, id: hash([QUALIFIED_GRAPH_VERSION, normalized]) });
  };
  const plain = { fundingRatio: null, collectionRatio: null, fastCollection: null, launchBundle: false, historyEligible: false };
  const permissions = input.permissions.filter(p => available(p.effectiveFrom, p.knownAt) &&
    (p.effectiveUntil === null || canonical(p.effectiveUntil)));
  for (const authority of sorted(input.authorities)) {
    const controlled = sorted(permissions.map(p => p.account)).filter(a => !stopped(a) && permissions.some(p => p.account !== a &&
      !stopped(p.account) && resolveEffectiveControl([a, p.account], authority, permissions, at).status === 'verified'));
    const members = controlled;
    const proof = resolveEffectiveControl(members, authority, permissions, at);
    if (proof.status === 'verified' && !stopped(authority)) add({ ...plain, kind: 'control', evidenceClass: 'authenticated_control', status: 'qualified',
      memberIds: members, participants: members.map(address => ({ address, roles: [] })), evidenceIds: proof.evidenceIds, sourceIds: [], historyEligible: true });
  }
  const launch = (bs: typeof buys) => bs.every(b => sec(b.cursor) >= BigInt(input.launchedAtSec) && sec(b.cursor) < BigInt(input.launchedAtSec) + 300n);
  for (const subtree of sorted(buys.filter(b => b.coin === coin && b.authenticatedPrivatePayment && b.subtree !== null).map(b => b.subtree!))) {
    const bs = buys.filter(b => b.coin === coin && b.subtree === subtree && b.authenticatedPrivatePayment);
    if (new Set(bs.map(b => b.payer)).size !== 1 || new Set(bs.map(b => b.recipient)).size < 2 || service(bs[0].payer) ||
      bs.some(b => compareGuardCursors(b.cursor, bs[0].cursor) !== 0)) continue;
    add({ ...plain, kind: 'coordination', evidenceClass: 'private_payer', status: 'qualified', sourceIds: bs.map(b => b.id),
      participants: bs.flatMap(b => [{ address: b.payer, roles: ['buy_payer'] }, { address: b.recipient, roles: ['buy_recipient'] }]),
      evidenceIds: bs.flatMap(b => b.evidenceIds), launchBundle: launch(bs) });
  }
  type Path = { path: QualifiedGraphInput['paths'][number]; from: Address; to: Address; amount: bigint; first: GuardCursor; last: GuardCursor; evidence: Hash[] };
  const valid: Path[] = [], used = new Map<string, bigint>();
  // Validate every ledger allocation before qualifying a subset. Value cannot be reused across coins.
  for (const p of [...input.paths].sort((a, b) => a.id.localeCompare(b.id))) {
    if (p.validUntil && (!canonical(p.validUntil) || compareGuardCursors(at.cursor, p.validUntil) >= 0)) continue;
    const legs = p.legs.map(l => flows.get(l.flowId));
    if (legs.some(f => !f)) { issues.add('unavailable_path'); continue; }
    const fs = legs.map(f => f!);
    if (new Set(p.legs.map(l => l.flowId)).size !== p.legs.length || fs.some((f, i) => i > 0 &&
      (fs[i - 1].flow.to !== f.flow.from || compareGuardCursors(fs[i - 1].flow.cursor, f.flow.cursor) >= 0)) ||
      p.legs.some((l, i) => i > 0 && BigInt(l.value) > BigInt(p.legs[i - 1].value))) throw new Error('Nonconserved or unordered graph path');
    if (fs.some(f => value(f.value) === null)) { issues.add('unknown_conversion'); continue; }
    for (const [i, l] of p.legs.entries()) {
      const n = (used.get(l.flowId) ?? 0n) + BigInt(l.value);
      if (n > value(fs[i].value)!) throw new Error('Graph flow reused beyond conserved value'); used.set(l.flowId, n);
    }
    const first = fs[0].flow.cursor, last = fs.at(-1)!.flow.cursor;
    if (fs.some(f => service(f.flow.from as Address) || service(f.flow.to as Address)) || fs.slice(1).some(f => stopped(f.flow.from as Address))) { issues.add('service_path'); continue; }
    const c = p.coverage;
    if (!c.complete || !c.from || !c.through || !canonical(c.from) || !canonical(c.through) ||
      compareGuardCursors(c.from, first) > 0 || compareGuardCursors(c.through, last) < 0 || compareGuardCursors(c.through, at.cursor) > 0 ||
      p.kind === 'funding' && (!c.topLevelNative || !c.internalNative)) { issues.add('path_coverage_missing'); continue; }
    valid.push({ path: p, from: fs[0].flow.from as Address, to: fs.at(-1)!.flow.to as Address,
      amount: BigInt(p.legs.at(-1)!.value), first, last, evidence: fs.flatMap(f => f.evidenceIds) });
  }
  const funding: { buy: typeof buys[number]; root: Address; amount: bigint; denominator: bigint; paths: Path[]; recent: boolean }[] = [];
  for (const b of buys) {
    const cost = value(b.cost), gas = value(b.gas);
    if (cost === null || gas === null || !input.firstBuysComplete) { issues.add('funding_unknown'); continue; }
    const denominator = cost + gas; if (!denominator) continue;
    const firstBuy = buys.filter(x => x.coin === b.coin && x.recipient === b.recipient).sort((a, c) => compareGuardCursors(a.cursor, c.cursor))[0];
    if (valid.filter(p => p.path.kind === 'funding' && p.path.acquisitionId === b.id).reduce((n, p) => n + p.amount, 0n) > denominator) throw new Error('Acquisition value reused');
    const ps = valid.filter(p => p.path.kind === 'funding' && p.path.acquisitionId === b.id && p.to === b.payer &&
      compareGuardCursors(p.last, firstBuy.cursor) < 0 && sec(p.first) > sec(firstBuy.cursor) - 86400n);
    if (ps.reduce((n, p) => n + p.amount, 0n) > denominator) throw new Error('Acquisition value reused');
    for (const root of sorted(ps.map(p => p.from))) {
      const paths = ps.filter(p => p.from === root), amount = paths.reduce((n, p) => n + p.amount, 0n);
      const recent = paths.every(p => sec(p.last) > sec(firstBuy.cursor) - 21600n);
      funding.push({ buy: b, root, amount, denominator, paths, recent });
    }
  }
  const fundingTimes = (f: typeof funding[number]) => f.paths.map(p => sec(p.last)).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  const qualifyingFunding = funding.filter(f => f.amount * 100n >= f.denominator * 90n && f.recent && f.paths.every(p => p.path.legs.length === 1) &&
    fundingTimes(f).at(-1)! - fundingTimes(f)[0] <= 60n);
  for (const root of sorted(qualifyingFunding.filter(f => f.buy.coin === coin).map(f => f.root))) {
    const remaining = qualifyingFunding.filter(f => f.root === root && f.buy.coin === coin).sort((a, b) => fundingTimes(a)[0] < fundingTimes(b)[0] ? -1 : fundingTimes(a)[0] > fundingTimes(b)[0] ? 1 : a.buy.id.localeCompare(b.buy.id));
    while (remaining.length) {
      const first = remaining.shift()!, batch = [first];
      while (remaining.length && fundingTimes(remaining[0]).at(-1)! - fundingTimes(first)[0] <= 60n) batch.push(remaining.shift()!);
      add({ ...plain, kind: 'coordination', evidenceClass: 'recent_material_funder', status: new Set([root, ...batch.flatMap(f => [f.buy.payer, f.buy.recipient])]).size >= 3 ? 'qualified' : 'candidate',
        fundingRatio: { numerator: batch.reduce((n, f) => n + f.amount, 0n).toString(), denominator: batch.reduce((n, f) => n + f.denominator, 0n).toString() },
        participants: [{ address: root, roles: ['funder'] }, ...batch.flatMap(f => [{ address: f.buy.payer, roles: ['buy_payer'] as const }, { address: f.buy.recipient, roles: ['buy_recipient'] as const }])],
        sourceIds: batch.flatMap(f => f.paths.map(p => p.path.id)), evidenceIds: batch.flatMap(f => [...f.buy.evidenceIds, ...f.paths.flatMap(p => p.evidence)]), launchBundle: launch(batch.map(f => f.buy)) });
    }
  }
  for (const f of funding.filter(f => f.buy.coin === coin && (!f.recent || f.amount * 100n < f.denominator * 90n || f.paths.some(p => p.path.legs.length > 1)))) {
    const repeat = f.paths.some(p => p.path.repeatedPattern && known(p.path.repeatedPattern.knownAt) && new Set(p.path.repeatedPattern.independentEvidenceIds).size >= 2);
    if (f.amount * 100n < f.denominator * 50n || !repeat && f.paths.every(p => p.path.legs.length === 1)) continue;
    add({ ...plain, kind: 'coordination', evidenceClass: f.paths.some(p => p.path.legs.length > 1) ? 'bounded_path' : 'medium_path', status: 'candidate',
      fundingRatio: { numerator: f.amount.toString(), denominator: f.denominator.toString() }, sourceIds: f.paths.map(p => p.path.id),
      participants: [{ address: f.root, roles: ['funder'] }, { address: f.buy.payer, roles: ['buy_payer'] }, { address: f.buy.recipient, roles: ['buy_recipient'] }], evidenceIds: f.paths.flatMap(p => [...p.evidence, ...(p.path.repeatedPattern?.independentEvidenceIds ?? [])]) });
  }
  const collected: { sale: typeof sales[number]; collector: Address; amount: bigint; denominator: bigint; paths: Path[] }[] = [];
  for (const s of sales) {
    const denominator = value(s.net); if (denominator === null || !denominator) { issues.add('collection_unknown'); continue; }
    if (valid.filter(p => p.path.kind === 'collection' && p.path.saleId === s.id).reduce((n, p) => n + BigInt(p.path.legs[0].value), 0n) > denominator) throw new Error('Sale proceeds reused');
    const ps = valid.filter(p => p.path.kind === 'collection' && p.path.saleId === s.id && p.from === s.proceedsRecipient &&
      compareGuardCursors(p.first, s.cursor) > 0 && sec(p.last) <= sec(s.cursor) + 86400n);
    if (ps.reduce((n, p) => n + BigInt(p.path.legs[0].value), 0n) > denominator) throw new Error('Sale proceeds reused');
    for (const collector of sorted(ps.map(p => p.to))) {
      const paths = ps.filter(p => p.to === collector), amount = paths.reduce((n, p) => n + p.amount, 0n);
      if (amount * 100n < denominator * 90n) {
        const repeat = paths.some(p => p.path.repeatedPattern && known(p.path.repeatedPattern.knownAt) && new Set(p.path.repeatedPattern.independentEvidenceIds).size >= 2);
        if (s.coin === coin && amount * 100n >= denominator * 50n && repeat) add({ ...plain, kind: 'coordination', evidenceClass: 'medium_path', status: 'candidate',
          collectionRatio: { numerator: amount.toString(), denominator: denominator.toString() }, sourceIds: paths.map(p => p.path.id), evidenceIds: paths.flatMap(p => [...p.evidence, ...(p.path.repeatedPattern?.independentEvidenceIds ?? [])]),
          participants: [{ address: s.seller, roles: ['sell_source'] }, { address: collector, roles: ['proceeds_recipient'] }] });
        continue;
      }
      collected.push({ sale: s, collector, amount, denominator, paths });
      if (s.coin === coin) add({ ...plain, kind: 'coordination', evidenceClass: 'collector', status: 'qualified',
        collectionRatio: { numerator: amount.toString(), denominator: denominator.toString() },
        fastCollection: paths.filter(p => sec(p.last) <= sec(s.cursor) + 3600n).reduce((n, p) => n + p.amount, 0n).toString(),
        participants: [{ address: s.seller, roles: ['sell_source'] }, { address: s.proceedsRecipient, roles: ['proceeds_recipient'] }, { address: collector, roles: ['proceeds_recipient'] }], sourceIds: paths.map(p => p.path.id), evidenceIds: [...s.evidenceIds, ...paths.flatMap(p => p.evidence)] });
    }
  }
  const tied = (a: Address, b: Address) => a === b || partition(edges.filter(e => e.kind === 'control')).some(g => g.includes(a) && g.includes(b));
  const loopFunding = funding.filter(f => f.amount * 100n >= f.denominator * 90n && f.recent &&
    f.paths.every(p => sec(p.first) > sec(f.buy.cursor) - 21600n));
  for (const c of collected.filter(c => c.sale.coin === coin)) {
    const f = loopFunding.find(f => f.buy.coin === coin && f.buy.recipient === c.sale.seller && compareGuardCursors(f.buy.cursor, c.sale.cursor) < 0 &&
      (f.root === c.collector || tied(f.root, c.collector)) && input.principal !== null && tied(f.root, input.principal));
    if (!f) continue;
    const reviews = [...f.paths, ...c.paths].map(p => p.path.loopReview);
    const reviewed = input.loopMethodAccepted && !stopped(f.root) && !stopped(c.collector) && reviews.every(r => r && known(r.knownAt));
    add({ ...plain, kind: reviewed ? 'control' : 'coordination', evidenceClass: 'closed_loop', status: reviewed ? 'qualified' : 'candidate',
      historyEligible: reviewed, fundingRatio: { numerator: f.amount.toString(), denominator: f.denominator.toString() },
      collectionRatio: { numerator: c.amount.toString(), denominator: c.denominator.toString() },
      participants: [{ address: f.root, roles: ['funder'] }, { address: c.sale.seller, roles: ['buy_recipient', 'sell_source'] }, { address: c.collector, roles: ['proceeds_recipient'] }],
      sourceIds: [...f.paths, ...c.paths].map(p => p.path.id), evidenceIds: [...f.paths, ...c.paths].flatMap(p => [...p.evidence, ...(p.path.loopReview?.evidenceIds ?? [])]) });
  }
  const recycled = new Map<Hash, bigint>();
  for (const p of valid.filter(p => p.path.kind === 'recycling')) {
    const c = collected.find(c => c.sale.id === p.path.saleId && c.collector === p.from && c.paths.every(x => compareGuardCursors(x.last, p.first) < 0));
    const f = qualifyingFunding.find(f => f.buy.id === p.path.acquisitionId && f.root === p.to && p.path.nextFunder === f.root && f.paths.every(x => compareGuardCursors(p.last, x.first) < 0));
    if (!c || !f || c.paths.some(x => sec(p.last) - sec(x.last) > 604800n) || p.amount * 100n < c.amount * 90n) continue;
    const spent = (recycled.get(c.sale.id) ?? 0n) + BigInt(p.path.legs[0].value);
    if (spent > c.amount) throw new Error('Collected value reused'); recycled.set(c.sale.id, spent);
    add({ ...plain, kind: 'coordination', evidenceClass: 'bounded_path', status: 'candidate',
      fundingRatio: { numerator: p.amount.toString(), denominator: c.amount.toString() }, sourceIds: [p.path.id], evidenceIds: p.evidence,
      participants: [{ address: p.from, roles: ['proceeds_recipient'] }, { address: p.to, roles: ['funder'] }] });
  }
  unique(input.originLots.map(x => x.lot.id));
  for (const o of input.originLots) {
    const l = { ...o.lot, owner: o.lot.owner.toLowerCase() as Address, origin: o.lot.origin?.toLowerCase() as Address | undefined };
    if (!available(o.cursor, o.knownAt) || !canonical(l.acquiredAt) || compareGuardCursors(l.acquiredAt, o.cursor) > 0 ||
      l.units.asset.toLowerCase() !== coin || !l.origin || l.origin === l.owner || BigInt(l.units.raw) === 0n) continue;
    add({ ...plain, kind: 'origin', evidenceClass: 'lot_origin', status: 'qualified', sourceIds: [l.id], evidenceIds: l.evidenceIds,
      participants: [{ address: l.origin, roles: ['lot_origin'] }, { address: l.owner, roles: ['lot_holder'] }] });
  }
  const origin = input.origin.filter(o => available(o.cursor, o.knownAt) && available(o.soldAt, o.soldKnownAt) &&
    compareGuardCursors(o.cursor, o.soldAt) <= 0 && sec(o.soldAt) - sec(o.cursor) <= 86400n);
  for (const saleId of sorted(origin.map(o => o.saleId))) {
    const os = origin.filter(o => o.saleId === saleId), received = os.reduce((n, o) => n + BigInt(o.units), 0n);
    if (os.some(o => o.seller !== os[0].seller || o.soldUnits !== os[0].soldUnits || o.saleTransactionId !== os[0].saleTransactionId) || received > BigInt(os[0].soldUnits)) continue;
    if (new Set(os.map(o => o.from).filter(a => a !== os[0].seller)).size < 2) continue;
    for (const kind of ['origin', 'coordination'] as const) add({ ...plain, kind, evidenceClass: 'consolidation', status: 'qualified',
      ...(kind === 'coordination' ? { memberIds: sorted([os[0].seller, ...os.map(o => o.from)]) } : {}), sourceIds: os.map(o => o.id),
      participants: [{ address: os[0].seller, roles: ['sell_source'] }, ...os.flatMap(o => [{ address: o.from, roles: ['lot_sender'] as const },
        ...(o.purchaser ? [{ address: o.purchaser, roles: ['purchaser'] as const }] : [])])], evidenceIds: os.flatMap(o => o.evidenceIds) });
  }
  for (const s of input.soft.filter(s => available(s.cursor, s.knownAt))) add({ ...plain, kind: 'coordination', evidenceClass: 'soft_cohort', status: 'candidate',
    memberIds: s.members, participants: [], sourceIds: [s.id], evidenceIds: s.evidenceIds });
  for (const e of edges.filter(e => e.kind === 'control')) e.participants = participants([...e.participants,
    ...buys.filter(b => b.coin === coin).flatMap(b => [{ address: b.payer, roles: ['buy_payer'] as const }, { address: b.recipient, roles: ['buy_recipient'] as const }]).filter(p => e.memberIds.includes(p.address)),
    ...sales.filter(s => s.coin === coin).flatMap(s => [{ address: s.seller, roles: ['sell_source'] as const }, { address: s.proceedsRecipient, roles: ['proceeds_recipient'] as const }]).filter(p => e.memberIds.includes(p.address))]);
  // Rehash after attaching economic roles; immutable edge IDs cover every returned field.
  for (const e of edges) { const { id: _id, ...payload } = e; e.id = hash([QUALIFIED_GRAPH_VERSION, payload]); }
  const components: QualifiedGraphComponent[] = [];
  for (const kind of ['control', 'coordination', 'origin'] as const) {
    const es = edges.filter(e => e.kind === kind && e.status === 'qualified');
    for (const memberIds of partition(es)) {
      const own = es.filter(e => e.memberIds.some(a => memberIds.includes(a))), edgeIds = sorted(own.map(e => e.id));
      const id = hash([QUALIFIED_GRAPH_VERSION, kind, memberIds, edgeIds]), ps = participants(own.flatMap(e => e.participants).filter(p => memberIds.includes(p.address)));
      const diagnostics: QualifiedGraphComponent['diagnostics'] = [];
      if (own.some(e => e.evidenceClass === 'recent_material_funder')) {
        const topology = own.flatMap(e => {
          const root = e.evidenceClass === 'recent_material_funder' ? e.participants.find(p => p.roles.includes('funder'))?.address : null;
          return root ? e.memberIds.filter(a => a !== root).map(a => ({ memberIds: [root, a] })) : [{ memberIds: e.memberIds }];
        });
        const degree = (a: Address) => new Set(topology.filter(e => e.memberIds.includes(a)).flatMap(e => e.memberIds).filter(b => b !== a)).size;
        const highest = [...memberIds].sort((a, b) => degree(b) - degree(a) || a.localeCompare(b))[0];
        for (const deleted of sorted([highest, ...memberIds.filter(unresolved)])) diagnostics.push({ deleted, reason: deleted === highest ? 'highest_degree' : 'unresolved_hub', remaining: partition(topology, deleted) });
      }
      components.push({ id, kind, memberIds, edgeIds, graphVersion: QUALIFIED_GRAPH_VERSION,
        supersedes: previous?.components.find(c => c.id === id)?.supersedes ?? sorted(previous?.components.filter(c => c.kind === kind && c.id !== id && c.memberIds.some(a => memberIds.includes(a))).map(c => c.id) ?? []),
        participants: ps, groupScoringEligible: kind === 'coordination' && ps.filter(p => p.roles.length > 0).length >= 3,
        historyEligible: kind === 'control' && own.every(e => e.historyEligible), diagnostics });
    }
  }
  return freeze({ graphVersion: QUALIFIED_GRAPH_VERSION, coin, at, mode: 'shadow', edges: edges.sort((a, b) => a.id.localeCompare(b.id)),
    observedConnections: [...flows].sort(([a], [b]) => a.localeCompare(b)).map(([id, f]) => ({ id, from: f.flow.from, to: f.flow.to, raw: f.flow.raw })),
    components: components.sort((a, b) => a.id.localeCompare(b.id)), retired: sorted(previous?.components.filter(c => !components.some(n => n.id === c.id)).map(c => c.id) ?? []), issues: sorted([...issues]) });
}
