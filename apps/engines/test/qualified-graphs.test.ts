import { describe, expect, it } from 'vitest';
import { fundingFlowId } from '@eko/chain';
import type { PermissionObservation } from '@eko/chain';
import type { GuardCursor } from '@eko/shared';
import { qualifyGraphsV2 } from '../src/qualified-graphs.js';
import type { QualifiedGraphInput } from '../src/qualified-graph-input.js';
import { address, hash, at, coin, principal, quoteAsset, opening } from './lot-fixtures.js';
import { coverage } from '../../../packages/shared/test/fixtures/contracts/guard-v2.js';

const cut = (sec: number) => ({ cursor: at(sec), acquisitionSequence: '1' });
const amount = (raw: string) => ({ asset: quoteAsset, decimals: 0, raw });
const base = (id: number, sec: number) => ({ id: hash(id), cursor: at(sec, id), knownAt: cut(sec), evidenceIds: [hash(id + 1000)] });
function input(now = 400000): QualifiedGraphInput {
  return { at: cut(now), coin, principal, launchedAtSec: '100000', valuationUnit: { asset: quoteAsset, decimals: 0 }, firstBuysComplete: true,
    acquisitions: [], sales: [], flows: [], paths: [], permissions: [], authorities: [], services: [], canonicalBlocks: [],
    originLots: [], origin: [], soft: [], loopMethodAccepted: false };
}
function canonical(i: QualifiedGraphInput) {
  const blocks = new Map<string, string>();
  function walk(x: unknown) {
    if (!x || typeof x !== 'object') return;
    if ('blockNumber' in x && 'blockHash' in x) { const c = x as GuardCursor; blocks.set(c.blockNumber, c.blockHash); }
    for (const [k, v] of Object.entries(x)) if (k !== 'canonicalBlocks') walk(v);
  }
  walk(i); i.canonicalBlocks = [...blocks].map(([blockNumber, blockHash]) => ({ blockNumber, blockHash: blockHash as `0x${string}` })); return i;
}
const run = (i: QualifiedGraphInput, previous?: ReturnType<typeof qualifyGraphsV2>) => qualifyGraphsV2(canonical(i), previous);
function buy(i: QualifiedGraphInput, id: number, sec: number, who = address(20), cost = '100', gas = '0') {
  const b: QualifiedGraphInput['acquisitions'][number] = { ...base(id, sec), coin, payer: who, recipient: who, cost: amount(cost), gas: amount(gas), subtree: null, authenticatedPrivatePayment: false };
  i.acquisitions.push(b); return b;
}
function sale(i: QualifiedGraphInput, id: number, sec: number, who = address(20), net = '100') {
  const s = { ...base(id, sec), coin, seller: who, proceedsRecipient: who, net: amount(net) }; i.sales.push(s); return s;
}
function flow(i: QualifiedGraphInput, id: number, sec: number, from: `0x${string}`, to: `0x${string}`, raw = '100') {
  const f = { flow: { transactionHash: hash(id + 10000), position: 'call:0', cursor: at(sec, id), stream: 'native_external' as const,
    asset: null, from, to, raw, transactionSuccessful: true, ancestorsSuccessful: true, settlement: 'external' as const },
    knownAt: cut(sec), value: amount(raw), evidenceIds: [hash(id + 20000)] };
  i.flows.push(f); return f;
}
function path(i: QualifiedGraphInput, id: number, fs: QualifiedGraphInput['flows'], kind: QualifiedGraphInput['paths'][number]['kind'], target: string, raw = '100') {
  const p: QualifiedGraphInput['paths'][number] = { id: hash(id), kind, legs: fs.map(f => ({ flowId: fundingFlowId(f.flow), value: raw })),
    acquisitionId: kind === 'funding' ? target as `0x${string}` : null, saleId: kind === 'collection' ? target as `0x${string}` : null,
    nextFunder: null, coverage: { ...coverage, from: at(0), through: i.at.cursor, topLevelNative: true, internalNative: true },
    loopReview: null, repeatedPattern: null, validUntil: null };
  i.paths.push(p); return p;
}
function funded(ratio = '90', fundingSec = 99990) {
  const i = input();
  for (const [n, who] of [address(20), address(21)].entries()) {
    const b = buy(i, n + 1, 100001 + n, who), f = flow(i, n + 10, fundingSec + n, principal, who, ratio);
    path(i, n + 100, [f], 'funding', b.id, ratio);
  }
  return i;
}
const byClass = (i: QualifiedGraphInput, cls: string) => run(i).edges.filter(e => e.evidenceClass === cls);
function permission(account: `0x${string}`, end: GuardCursor | null = null): PermissionObservation {
  return { account, codeHash: hash(1), implementation: null, effectiveFrom: at(90000), effectiveUntil: end, knownAt: cut(90000),
    owners: [principal], threshold: 1, enabledModules: [], permissionCoverageComplete: true, evidenceIds: [hash(900)],
    paths: [{ authority: principal, kind: 'owner_quorum', signers: [principal], module: null, arbitraryEconomicActions: true, verifiedPermission: true, evidenceIds: [hash(901)] }] };
}
function service(i: QualifiedGraphInput, who: `0x${string}`, confirmed = true) {
  i.services.push({ status: confirmed ? 'confirmed' : 'unresolved', registryHash: hash(600), registryVersion: '2.0.0', cursor: at(90000), knownAt: cut(90000), effectiveCursor: at(90000),
    address: who, codeHash: hash(601), implementation: null, launches: 0, principals: 0, pairs: 0, pairDenominator: 0,
    launchCoverageComplete: false, principalCoverageComplete: false, pairCoverageComplete: false, degree: 501, degreeStatus: 'lower_bound', hub: 'review',
    degreeCoverage: { fromSec: '3600', throughSec: '90000', complete: false, evidenceIds: [hash(602)] },
    stopControlExpansion: true, aggregateInfrastructureHistory: false, preserveEconomicExposure: true, reviewEvidence: [] });
}

describe('qualified graph fixtures (shadow, not measured precision)', () => {
  it('accepts exact 90% funding and keeps three economic roles, immutable disjoint components and raw connections', () => {
    const i = funded(), before = structuredClone(i), s = run(i), c = s.components[0];
    expect(c.kind).toBe('coordination'); expect(c.memberIds).toEqual([principal, address(20), address(21)]);
    expect(c.groupScoringEligible).toBe(true); expect(c.historyEligible).toBe(false);
    expect(s.edges[0].fundingRatio).toEqual({ numerator: '180', denominator: '200' });
    expect(s.edges[0].launchBundle).toBe(true); expect(c.participants.find(p => p.address === address(20))?.roles).toEqual(['buy_payer', 'buy_recipient']);
    expect(Object.isFrozen(c.memberIds)).toBe(true); expect(s.observedConnections).toHaveLength(2);
    expect({ ...i, canonicalBlocks: [] }).toEqual(before);
    i.acquisitions.reverse(); i.flows.reverse(); i.paths.reverse(); expect(run(i)).toEqual(s);
  });
  it.each(['80', '89', '50'])('keeps %s%% repeated leads unrounded and out of components/control/history', ratio => {
    const i = funded(ratio); for (const p of i.paths) p.repeatedPattern = { knownAt: cut(100010), independentEvidenceIds: [hash(401), hash(402)] };
    const s = run(i); expect(s.edges).toHaveLength(2); expect(s.components).toEqual([]);
    expect(s.edges.every(e => e.status === 'candidate' && e.fundingRatio?.numerator === ratio && !e.historyEligible)).toBe(true);
  });
  it('does not qualify dust, old three-year funding, post-buy funding, or unrepeated 89% leads', () => {
    expect(run(funded('1')).components).toEqual([]); expect(run(funded('89')).edges).toEqual([]);
    const old = funded('100', 0); old.acquisitions.forEach(b => { b.cursor = at(100000000, 1); b.knownAt = cut(100000000); }); old.at = cut(100000001);
    expect(run(old).edges).toEqual([]); expect(run(funded('100', 100010)).edges).toEqual([]);
  });
  it('uses exact trailing six-hour boundary and 24-hour sensitivity', () => {
    const i = funded('100', 100001 - 21600); for (const p of i.paths) p.repeatedPattern = { knownAt: cut(100010), independentEvidenceIds: [hash(401), hash(402)] };
    expect(run(i).components).toEqual([]); expect(byClass(i, 'medium_path')).toHaveLength(2);
    i.flows.forEach(f => { f.flow.cursor.timestampSec = (BigInt(f.flow.cursor.timestampSec) + 1n).toString(); });
    expect(byClass(i, 'recent_material_funder')[0].status).toBe('qualified');
  });
  it('includes gas and never mixes valuation units or substitutes missing conversions', () => {
    const i = funded('90'); i.acquisitions[0].gas = amount('1'); expect(run(i).components).toEqual([]);
    i.flows[0].value = null; expect(run(i).issues).toContain('unknown_conversion');
    i.acquisitions[0].gas = { ...amount('1'), decimals: 18 }; expect(() => run(i)).toThrow('valuation unit');
  });
  it('does not turn a 61-second batch or two participants into a scored group', () => {
    const i = funded(); i.flows[1].flow.cursor = at(100051, 11); i.flows[1].knownAt = cut(100051); i.acquisitions[1].cursor = at(100060, 2); i.acquisitions[1].knownAt = cut(100060);
    expect(run(i).components).toEqual([]); expect(run(i).edges.every(e => e.status === 'candidate')).toBe(true);
  });
  it('excludes services, failed flows, wrapping, and incomplete internal coverage but retains observations', () => {
    const i = funded(); service(i, principal); const s = run(i); expect(s.components).toEqual([]); expect(s.observedConnections).toHaveLength(2);
    const failed = funded(); failed.flows[0].flow.ancestorsSuccessful = false; expect(run(failed).components).toEqual([]);
    const wrapped = funded(); wrapped.flows[0].flow.settlement = 'same_account_wrap'; expect(run(wrapped).components).toEqual([]);
    const missing = funded(); missing.paths[0].coverage.internalNative = false; expect(run(missing).issues).toContain('path_coverage_missing');
  });
  it('preserves private fanout at an unresolved hub while diagnosing deletion and refusing control', () => {
    const i = funded(); service(i, principal, false); const s = run(i); expect(s.components[0].groupScoringEligible).toBe(true);
    expect(s.components[0].diagnostics[0].deleted).toBe(principal); expect(s.components[0].diagnostics[0].remaining).toEqual([[address(20)], [address(21)]]);
    expect(s.components.every(c => c.kind !== 'control')).toBe(true);
  });
  it('counts two authenticated controlled accounts in control even without three-wallet scoring', () => {
    const i = input(); i.permissions = [permission(address(20)), permission(address(21))]; i.authorities = [principal];
    const s = run(i); expect(s.components[0].kind).toBe('control'); expect(s.components[0].memberIds).toHaveLength(2);
    expect(s.components[0].historyEligible).toBe(true); expect(s.components[0].groupScoringEligible).toBe(false);
    i.permissions[1].paths[0].verifiedPermission = false; expect(run(i).components).toEqual([]);
  });
  it('private authenticated subtree is coordination; unrelated customers/operations/gifts do not qualify', () => {
    const i = input(); for (let n = 1; n <= 2; n++) { const b = buy(i, n, 100001, address(n + 20)); b.payer = principal; b.cursor = at(100001, 1); b.subtree = hash(40); b.authenticatedPrivatePayment = true; }
    const s = run(i); expect(s.edges[0].evidenceClass).toBe('private_payer'); expect(s.components[0].groupScoringEligible).toBe(true);
    i.acquisitions[1].subtree = hash(41); expect(run(i).edges).toEqual([]);
    i.acquisitions[1].subtree = hash(40); i.acquisitions[1].authenticatedPrivatePayment = false; expect(run(i).edges).toEqual([]);
  });
  it('preserves authenticated private payment at a quarantined hub and separate later acquisitions', () => {
    const i = input(); service(i, principal, false);
    for (let n = 1; n <= 2; n++) { const b = buy(i, n, 100301, address(n + 20)); b.payer = principal; b.cursor = at(100301, 1); b.subtree = hash(40); b.authenticatedPrivatePayment = true; }
    const s = run(i); expect(s.components[0].groupScoringEligible).toBe(true); expect(s.edges[0].launchBundle).toBe(false); expect(s.components[0].historyEligible).toBe(false);
  });
  it('never joins an original gift purchaser into disposition coordination', () => {
    const i = input();
    for (let n = 1; n <= 2; n++) i.origin.push({ ...base(n, 100001), purchaser: address(90), from: address(20 + n), seller: address(30),
      units: '50', soldUnits: '100', soldAt: at(100002, 5), soldKnownAt: cut(100002), saleId: hash(5), transactionId: hash(200 + n), saleTransactionId: hash(205) });
    const s = run(i); expect(s.components.find(c => c.kind === 'coordination')!.memberIds).toEqual([address(21), address(22), address(30)]);
    expect(s.components.find(c => c.kind === 'origin')!.participants.find(p => p.address === address(90))!.roles).toEqual(['purchaser']);
  });
  it('keeps a conserved gift lot as origin without any coordination/control inference', () => {
    const i = input(); i.originLots.push({ cursor: at(100100), knownAt: cut(100100), lot: opening(800, address(30), '100', principal) });
    const s = run(i); expect(s.edges[0].evidenceClass).toBe('lot_origin'); expect(s.components[0].kind).toBe('origin');
    expect(s.components[0].historyEligible).toBe(false); expect(s.components[0].groupScoringEligible).toBe(false);
  });
  it('conserves one flow across launches and rejects inflation and reversed execution paths', () => {
    const i = funded('100'); const b = buy(i, 4, 100050); b.coin = address(50); path(i, 104, [i.flows[0]], 'funding', b.id);
    expect(() => run(i)).toThrow('flow reused');
    const inflated = funded('100'); inflated.paths[0].legs[0].value = '101'; expect(() => run(inflated)).toThrow('flow reused');
    const reversed = funded(); reversed.paths[0].legs.push(reversed.paths[1].legs[0]); expect(() => run(reversed)).toThrow('unordered');
  });
  it('qualifies 2h sweeps, shows the fast slice, excludes future collections and exact >24h', () => {
    const i = input(), s = sale(i, 1, 100010), f = flow(i, 10, 107210, s.seller, principal, '90'); path(i, 100, [f], 'collection', s.id, '90');
    const e = byClass(i, 'collector')[0]; expect(e.collectionRatio).toEqual({ numerator: '90', denominator: '100' }); expect(e.fastCollection).toBe('0'); expect(e.historyEligible).toBe(false);
    i.at = cut(100011); expect(byClass(i, 'collector')).toEqual([]);
    i.at = cut(400000); f.flow.cursor = at(186411, 10); f.knownAt = cut(186411); expect(byClass(i, 'collector')).toEqual([]);
  });
  it('requires principal-side connection, review and method gate for loop control', () => {
    const i = funded('100'), s = sale(i, 5, 100010), f = flow(i, 15, 107210, s.seller, principal); path(i, 105, [f], 'collection', s.id);
    expect(byClass(i, 'closed_loop')[0].status).toBe('candidate'); expect(run(i).components.every(c => c.kind !== 'control')).toBe(true);
    for (const p of i.paths) p.loopReview = { knownAt: cut(107211), evidenceIds: [hash(700)] }; i.loopMethodAccepted = true;
    expect(byClass(i, 'closed_loop')[0].historyEligible).toBe(true);
    i.principal = address(90); expect(byClass(i, 'closed_loop')).toEqual([]);
  });
  it('keeps bounded two-hop funding medium; stops at services and rejects >3 hops', () => {
    const i = input(), b = buy(i, 1, 100001), a = flow(i, 10, 80000, principal, address(30)), z = flow(i, 11, 99990, address(30), b.payer);
    path(i, 100, [a, z], 'funding', b.id); expect(byClass(i, 'bounded_path')[0].status).toBe('candidate'); expect(run(i).components).toEqual([]);
    service(i, address(30)); expect(run(i).edges).toEqual([]);
    i.services = []; i.paths[0].legs.push(i.paths[0].legs[0], i.paths[0].legs[0]); expect(() => run(i)).toThrow();
  });
  it('requires independent gated loop proof before a bounded funding lead can join control', () => {
    const i = input(), b = buy(i, 1, 100001), a = flow(i, 10, 99980, principal, address(30)), z = flow(i, 11, 99990, address(30), b.payer);
    path(i, 100, [a, z], 'funding', b.id);
    const s = sale(i, 2, 100010), sweep = flow(i, 12, 107210, s.seller, principal); path(i, 101, [sweep], 'collection', s.id);
    expect(run(i).components.every(c => c.kind !== 'control')).toBe(true);
    for (const p of i.paths) p.loopReview = { knownAt: cut(107211), evidenceIds: [hash(700)] }; i.loopMethodAccepted = true;
    expect(byClass(i, 'bounded_path')[0].status).toBe('candidate'); expect(byClass(i, 'closed_loop')[0].historyEligible).toBe(true);
  });
  it('tracks delayed 2d recycling only with qualified collector and next-funder endpoints', () => {
    const i = funded('100'), s = sale(i, 5, 100010), c = flow(i, 15, 107210, s.seller, principal); path(i, 105, [c], 'collection', s.id);
    const r = flow(i, 16, 280010, principal, address(40)), next = buy(i, 6, 280100, address(41)); next.coin = address(60);
    const nf = flow(i, 17, 280050, address(40), next.payer); path(i, 106, [nf], 'funding', next.id);
    const p = path(i, 107, [r], 'recycling', next.id); p.acquisitionId = next.id; p.saleId = s.id; p.nextFunder = address(40);
    expect(byClass(i, 'bounded_path')).toHaveLength(1); expect(run(i).components.every(c => c.kind !== 'control')).toBe(true);
    nf.value = amount('89'); nf.flow.raw = '89'; i.paths.find(p => p.id === hash(106))!.legs[0].value = '89'; expect(byClass(i, 'bounded_path')).toEqual([]);
  });
  it('qualifies three-wallet consolidation and records purchaser separately from seller/control', () => {
    const i = input(); for (let n = 1; n <= 2; n++) i.origin.push({ ...base(n, 100001), purchaser: address(20 + n), from: address(20 + n), seller: address(30),
      units: '50', soldUnits: '100', soldAt: at(186401, 5), soldKnownAt: cut(186401), saleId: hash(5), transactionId: hash(200 + n), saleTransactionId: hash(205) });
    const s = run(i); expect(s.components.map(c => c.kind).sort()).toEqual(['coordination', 'origin']);
    expect(s.components.find(c => c.kind === 'coordination')?.groupScoringEligible).toBe(true); expect(s.edges.every(e => !e.historyEligible && !e.launchBundle)).toBe(true);
    i.origin[1].soldUnits = '99'; expect(run(i).edges).toEqual([]);
  });
  it('recomputes immutable components on permission expiry/splits and canonical reorgs', () => {
    const i = input(100100); i.permissions = [permission(address(20)), permission(address(21)), permission(address(22), at(100200))]; i.authorities = [principal];
    const first = run(i); i.at = cut(100201); const split = run(i, first);
    expect(split.components[0].memberIds).toHaveLength(2); expect(split.components[0].supersedes).toEqual([first.components[0].id]); expect(split.retired).toEqual([first.components[0].id]);
    const f = funded(), before = run(f); canonical(f); f.canonicalBlocks.find(b => b.blockNumber === f.flows[0].flow.cursor.blockNumber)!.blockHash = hash(999999);
    const reorg = qualifyGraphsV2(f, before); expect(reorg.components).toEqual([]); expect(reorg.retired).toEqual([before.components[0].id]); expect(before.components[0].memberIds).toHaveLength(3);
  });
  it('honors explicit path expiry and same-second later availability; soft cohorts never union', () => {
    const i = funded(); i.paths[0].validUntil = at(400000); expect(run(i).components).toEqual([]);
    const j = funded(); j.flows[0].knownAt = { ...j.at, acquisitionSequence: '2' }; expect(run(j).components).toEqual([]);
    j.soft.push({ ...base(900, 100002), members: [address(20), address(21)] }); expect(byClass(j, 'soft_cohort')[0].status).toBe('candidate');
  });
});
