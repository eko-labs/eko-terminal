import { compareGuardCursors, guardKnownBy } from '@eko/shared';
import { referenceDigest } from '@eko/chain';
import { fraction, plus, rational, times, type Fraction } from './lot-arithmetic.js';
import { reconcileGraduationInventory } from './graduation-inventory.js';
import { ReserveOriginInputSchema, type ReserveOriginInput, type ReserveOriginStep } from './reserve-origin-input.js';

export const RESERVE_ORIGIN_METHOD_VERSION = '1.0.0' as const;
const sum = (items: Fraction[]) => items.reduce(plus, fraction(0n));
const eq = (a: Fraction, b: Fraction) => a.n * b.d === b.n * a.d;
type Buckets = { operator: Fraction; outsideBuyer: Fraction; other: Fraction; providers: Map<string, Fraction> };
const values = (b: Buckets) => [b.operator, b.outsideBuyer, b.other, ...b.providers.values()];
const serialize = (b: Buckets) => ({ operator: rational(b.operator), outsideBuyer: rational(b.outsideBuyer), other: rational(b.other),
  providers: [...b.providers].sort(([a], [c]) => a.localeCompare(c)).map(([provider, units]) => ({ provider, units: rational(units) })) });

/** Optional proportional mixing research. Pure, fixture-only and never consumed by policy or outcome labels. */
export function estimateReserveOrigin(raw: ReserveOriginInput) {
  const i = ReserveOriginInputSchema.parse(raw), opening = i.opening;
  const compare = compareGuardCursors;
  const same = (a: ReserveOriginInput['cursor'], b: ReserveOriginInput['cursor']) => referenceDigest(a) === referenceDigest(b);
  const available = (p: { cursor: typeof i.cursor; knownAt: typeof i.knownAt }) => compare(p.cursor, i.cursor) <= 0 &&
    compare(p.cursor, p.knownAt.cursor) <= 0 && guardKnownBy(p.knownAt, i.knownAt);
  if (i.cursor.chainId !== 4663 || i.cursor.boundary !== 'block_end' || !same(i.interval.through, i.cursor) ||
    !same(i.closing.cursor, i.cursor) || compare(opening.cursor, i.interval.from) > 0 || compare(i.interval.from, i.cursor) > 0 ||
    compare(i.cursor, i.knownAt.cursor) > 0) throw new Error('Reserve-origin capture/interval mismatch');
  for (const p of [opening, i.closing, ...i.steps]) if (!available(p)) throw new Error('Reserve-origin evidence exceeds capture');
  if (!guardKnownBy(i.identity.cut, i.knownAt) || i.identity.classifications.some(c => !guardKnownBy(c.knownAt, i.identity.cut)))
    throw new Error('Reserve-origin identity exceeds pinned cut');
  const classified = new Map(i.identity.classifications.map(c => [c.address, c.bucket]));
  if (classified.size !== i.identity.classifications.length || new Set(opening.buckets.providers.map(p => p.provider)).size !== opening.buckets.providers.length)
    throw new Error('Duplicate reserve-origin identity/provider');
  const steps = i.steps.slice().sort((a, b) => compare(a.cursor, b.cursor));
  const ids = new Set<string>(), sources = new Set<string>(), feeIds = new Set<string>();
  for (const [index, s] of steps.entries()) {
    if (compare(s.cursor, opening.cursor) <= 0 || (index > 0 && (compare(steps[index - 1].cursor, s.cursor) === 0 ||
      BigInt(steps[index - 1].cursor.timestampSec) > BigInt(s.cursor.timestampSec))) ||
      s.cursor.boundary !== (s.kind === 'migration' ? 'block_end' : 'after_tx')) throw new Error('Invalid reserve-origin execution order');
    if (ids.has(s.id) || new Set(s.sourceIds).size !== s.sourceIds.length || s.sourceIds.some(id => sources.has(id)))
      throw new Error('Duplicate reserve-origin action/source');
    ids.add(s.id); s.sourceIds.forEach(id => sources.add(id));
    for (const fee of s.fees ?? []) {
      if (feeIds.has(fee.id)) throw new Error('Duplicate reserve-origin fee');
      feeIds.add(fee.id);
    }
    if (s.kind === 'sale' && new Set(s.soldLots.map(l => l.id)).size !== s.soldLots.length) throw new Error('Duplicate sold lot');
  }
  const accountingGaps = new Set<string>(), estimateGaps = new Set<string>();
  const fail = (reason: string) => { accountingGaps.add(reason); estimateGaps.add(reason); };
  if (!i.coverageComplete) fail('incomplete_reserve_coverage');
  let route = opening.route, real = BigInt(opening.reserve.realQuote);
  const buckets: Buckets = { operator: fraction(BigInt(opening.buckets.operator)), outsideBuyer: fraction(BigInt(opening.buckets.outsideBuyer)),
    other: fraction(BigInt(opening.buckets.other)), providers: new Map(opening.buckets.providers.map(p => [p.provider, fraction(BigInt(p.units))])) };
  const supported = (r: typeof opening.reserve) => r.reviewed && r.source === (route.venue === 'pons_curve' ? 'curve_real_getter' : 'per_pool_settlement');
  const conserve = () => {
    if (values(buckets).some(b => b.n < 0n) || !eq(sum(values(buckets)), fraction(real))) fail('bucket_conservation');
  };
  if (!supported(opening.reserve)) fail('unsupported_reserve_source');
  conserve();
  const scale = (remaining: bigint, prior: bigint) => {
    // Empty-to-empty settlement needs no ratio. A sale against zero prior reserves is unknown below.
    if (prior === 0n) return;
    buckets.operator = times(buckets.operator, remaining, prior);
    buckets.outsideBuyer = times(buckets.outsideBuyer, remaining, prior);
    buckets.other = times(buckets.other, remaining, prior);
    for (const [p, value] of buckets.providers) buckets.providers.set(p, times(value, remaining, prior));
  };
  const classify = (account: ReserveOriginInput['coin']) => classified.get(account) ?? 'unknown';
  let buyerReceipts = fraction(0n), attributedNet = fraction(0n), buyOffset = 0n;
  let grossSales = 0n, netSales = 0n, saleFees = 0n;
  let netKnown = true, feesKnown = true;
  const offsetIds: string[] = [];
  const migrationEvidenceIds: `0x${string}`[] = [];
  const snapshots: { stepId: string; kind: ReserveOriginStep['kind']; routeId: string; beforeRealQuote: string; realQuote: string;
    netReserveContribution: string | null; grossOutflow: string | null; quoteDebit: string | null;
    feeOutflow: string | null; fees: ReserveOriginStep['fees']; payouts: Extract<ReserveOriginStep, { kind: 'outflow' }>['payouts'];
    buckets: ReturnType<typeof serialize> | null }[] = [];
  const sales: { stepId: string; recipient: string; grossOutflow: string; netReceipt: string | null;
    fees: ReserveOriginStep['fees']; soldLotMethod: 'fifo' | 'proportional'; inInterval: boolean; operatorLotFraction: ReturnType<typeof rational> | null;
    buyerFractionBefore: ReturnType<typeof rational> | null; attributedNetReceipt: ReturnType<typeof rational> | null;
    buyerOriginReceipt: ReturnType<typeof rational> | null }[] = [];
  for (const s of steps) {
    const prior = real, before = BigInt(s.before.realQuote), after = BigInt(s.after.realQuote);
    const inInterval = compare(s.cursor, i.interval.from) > 0;
    if (s.routeId !== route.id || before !== prior) fail('reserve_route_or_delta_binding');
    if (!supported(s.before) || (s.kind !== 'migration' && !supported(s.after))) fail('unsupported_reserve_source');
    const fee = s.fees === null ? null : s.fees.reduce((n, f) => n + BigInt(f.units), 0n);
    if (fee === null) fail('unsupported_fee_settlement');
    if (s.kind === 'buy' || s.kind === 'lp_addition') {
      const delta = after - before;
      if (delta < 0n || s.quoteDebit === null || fee === null || BigInt(s.quoteDebit) !== delta + fee) fail('incoming_quote_reconciliation');
      const bucket = classify(s.payer);
      if (s.kind === 'buy' && bucket === 'unknown') fail('unresolved_buy_identity');
      if (!accountingGaps.size) {
        if (s.kind === 'lp_addition') buckets.providers.set(s.provider, plus(buckets.providers.get(s.provider) ?? fraction(0n), fraction(delta)));
        else if (bucket === 'operator') buckets.operator = plus(buckets.operator, fraction(delta));
        else if (bucket === 'outside_buyer') buckets.outsideBuyer = plus(buckets.outsideBuyer, fraction(delta));
        else buckets.other = plus(buckets.other, fraction(delta));
      }
      if (s.kind === 'buy' && inInterval && bucket === 'operator' && s.quoteDebit !== null && fee !== null &&
        delta >= 0n && BigInt(s.quoteDebit) === delta + fee && supported(s.before) && supported(s.after) && before === prior && s.routeId === route.id) {
        buyOffset += BigInt(s.quoteDebit); offsetIds.push(s.id);
      }
    } else if (s.kind === 'sale' || s.kind === 'outflow') {
      const gross = BigInt(s.grossOutflow);
      if (before - after !== gross) fail('gross_reserve_reconciliation');
      const net = s.kind === 'sale' ? s.netReceipt === null ? null : BigInt(s.netReceipt) : s.payouts.reduce((n, p) => n + BigInt(p.units), 0n);
      if (net === null || fee === null || gross !== net + fee) fail('outgoing_quote_reconciliation');
      if (s.kind === 'sale') {
        if (inInterval) { grossSales += gross; if (net === null) netKnown = false; else netSales += net;
          if (fee === null) feesKnown = false; else saleFees += fee; }
        const sold = s.soldLots.reduce((n, l) => n + BigInt(l.units), 0n);
        const lotKnown = s.lotsReviewed && sold === BigInt(s.soldUnits) && s.soldLots.every(l => l.origin !== null && classify(l.origin) !== 'unknown');
        const operator = s.soldLots.reduce((n, l) => n + (l.origin !== null && classify(l.origin) === 'operator' ? BigInt(l.units) : 0n), 0n);
        const lotFraction = lotKnown ? fraction(operator, sold) : null;
        if (inInterval && !lotKnown) estimateGaps.add('unresolved_sold_lots');
        if (inInterval && prior === 0n) estimateGaps.add('zero_prior_real_reserve');
        const buyerFraction = !accountingGaps.size && prior > 0n ? times(buckets.outsideBuyer, 1n, prior) : null;
        const receipt = lotFraction && net !== null ? times(lotFraction, net) : null;
        const buyerReceipt = receipt && buyerFraction ? times(receipt, buyerFraction.n, buyerFraction.d) : null;
        if (inInterval && receipt) attributedNet = plus(attributedNet, receipt);
        if (inInterval && buyerReceipt) buyerReceipts = plus(buyerReceipts, buyerReceipt);
        sales.push({ stepId: s.id, recipient: s.recipient, grossOutflow: s.grossOutflow, netReceipt: s.netReceipt, fees: s.fees, soldLotMethod: s.soldLotMethod,
          inInterval, operatorLotFraction: lotFraction && rational(lotFraction), buyerFractionBefore: buyerFraction && rational(buyerFraction),
          attributedNetReceipt: receipt && rational(receipt), buyerOriginReceipt: buyerReceipt && rational(buyerReceipt) });
      }
      if (!accountingGaps.size) scale(after, prior);
    } else {
      const g = reconcileGraduationInventory(s.settlement), m = g.migration, pool = g.pools.find(p => p.id === m.successorPoolId);
      migrationEvidenceIds.push(...g.evidenceIds);
      const payouts = s.payouts.reduce((n, p) => n + BigInt(p.units), 0n);
      if (s.settlement.origin !== 'fixture' || g.coin !== i.coin || m.quoteAsset !== i.quoteAsset || !guardKnownBy(g.knownAt, i.knownAt) ||
        !same(g.cursor, s.cursor) || compare(s.settlement.before.cursor, opening.cursor) < 0 ||
        (snapshots.length > 0 && compare(s.settlement.before.cursor, steps[snapshots.length - 1].cursor) < 0) ||
        route.venue !== 'pons_curve' || route.address !== m.oldCurve.toLowerCase() || s.successor.venue !== 'per_pool' ||
        s.successor.poolId !== m.successorPoolId || s.successor.address !== pool?.manager.toLowerCase() ||
        before !== BigInt(s.settlement.before.realQuoteReserve) || after !== BigInt(m.depositedQuote) ||
        pool?.quoteInventory !== s.after.realQuote || pool?.quoteFees !== '0' ||
        !s.after.reviewed || s.after.source !== 'per_pool_settlement' || !g.inventoryComplete ||
        fee === null || fee + payouts !== BigInt(m.quotePayouts) || before !== after + BigInt(m.quotePayouts)) fail('unsupported_migration_settlement');
      // Only reconciled deposited real quote carries origin. Payouts are not seller receipts.
      if (!accountingGaps.size) scale(after, prior);
      route = s.successor;
    }
    real = after;
    if (!accountingGaps.size) conserve();
    snapshots.push({ stepId: s.id, kind: s.kind, routeId: route.id, beforeRealQuote: s.before.realQuote, realQuote: s.after.realQuote,
      netReserveContribution: s.kind === 'buy' || s.kind === 'lp_addition' ? (after - before).toString() : null,
      grossOutflow: s.kind === 'sale' || s.kind === 'outflow' ? s.grossOutflow : s.kind === 'migration' ? s.settlement.migration.quotePayouts : null,
      quoteDebit: s.kind === 'buy' || s.kind === 'lp_addition' ? s.quoteDebit : null,
      feeOutflow: fee?.toString() ?? null, fees: s.fees, payouts: s.kind === 'outflow' || s.kind === 'migration' ? s.payouts : [],
      buckets: accountingGaps.size ? null : serialize(buckets) });
  }
  if (real !== BigInt(i.closing.reserve.realQuote) || route.id !== i.closing.routeId) fail('closing_reserve_binding');
  if (!supported(i.closing.reserve)) fail('unsupported_reserve_source');
  const estimateKnown = estimateGaps.size === 0;
  const difference = plus(buyerReceipts, fraction(-buyOffset));
  const result = { schemaVersion: 'reserve-origin-1' as const, methodVersion: RESERVE_ORIGIN_METHOD_VERSION,
    origin: i.origin, mode: 'shadow' as const, active: false as const, released: false as const,
    sourceRevision: i.sourceRevision, inputDigest: referenceDigest(i), identityDigest: referenceDigest(i.identity), identity: i.identity,
    coin: i.coin, quoteAsset: i.quoteAsset, quoteDecimals: i.quoteDecimals, unit: 'quote_raw' as const, cursor: i.cursor, knownAt: i.knownAt,
    interval: i.interval, intervalConvention: '(from,through]' as const, status: estimateKnown ? 'observed' as const : 'unknown' as const,
    accountingGaps: [...accountingGaps].sort(), estimateGaps: [...estimateGaps].sort(),
    buckets: accountingGaps.size ? null : serialize(buckets), realQuote: i.closing.reserve.realQuote, route, snapshots, sales,
    grossSaleOutflow: grossSales.toString(), netSaleReceipts: netKnown ? netSales.toString() : null,
    saleFeeOutflow: feesKnown ? saleFees.toString() : null, verifiedOperatorBuyDebitsInInterval: buyOffset.toString(), operatorBuyDebitIds: offsetIds,
    netAttributedSaleReceipt: estimateKnown ? rational(attributedNet) : null,
    buyerOriginReceipts: estimateKnown ? rational(buyerReceipts) : null,
    estimate: estimateKnown ? rational(difference.n < 0n ? fraction(0n) : difference) : null,
    evidenceIds: [...new Set([opening, i.closing, ...steps].flatMap(p => p.evidenceIds).concat(i.identity.evidenceIds,
      i.identity.classifications.flatMap(c => c.evidenceIds), migrationEvidenceIds))].sort() };
  return { ...result, id: referenceDigest(result) };
}
