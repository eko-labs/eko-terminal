import { keccak256, stringToHex } from 'viem';
import { LotMetricsSnapshotSchema, compareGuardCursors, guardKnownBy } from '@eko/shared';
import type { Address, GuardCursor, GuardLot, LotMetricsSnapshot, Metric, MetricId, PositionMetrics, RawAmount, SupplySnapshotV2 } from '@eko/shared';
import { LotMetricsInputSchema } from './lot-input.js';
import type { LotAction, LotMetricsInput } from './lot-input.js';
import { decimal, fraction, plus, rational, times, tokenDecimal } from './lot-arithmetic.js';
import type { Fraction } from './lot-arithmetic.js';
import { rawSellingMetrics } from './lot-selling.js';

export const LOT_METRICS_METHOD_VERSION = '2.0.0' as const;
export const lotHash = (value: unknown): `0x${string}` => keccak256(stringToHex(JSON.stringify(value)));
type LiveLot = Omit<GuardLot, 'units' | 'basis'> & { units: bigint; basis: { asset: Address; decimals: number; cost: Fraction } | null };
interface Stats { opening: bigint; bought: bigint; acquired: bigint; received: bigint; out: bigint; sold: bigint; burned: bigint;
  fees: bigint; cex: bigint; debit: bigint; receipt: bigint; cashKnown: boolean; soldBasis: Fraction; basisKnown: boolean; knownSold: bigint }
export interface LotHistory { cursor: GuardCursor; liquid: bigint; acquired: bigint; debit: bigint; receipt: bigint; cashKnown: boolean }
export interface SaleFact {
  action: Extract<LotAction, { kind: 'sell' }>; opening: bigint; origin: bigint; sensitive: boolean;
}

/** Pure normalized economic actions. No legacy outcomes, control unions, harm labels or I/O. */
export function measureLotMetricsV2(raw: LotMetricsInput): LotMetricsSnapshot {
  const input = LotMetricsInputSchema.parse(raw), { coin, cursor, knownAt } = input;
  if (cursor.boundary !== 'block_end' || compareGuardCursors(cursor, knownAt.cursor) > 0 || input.launch.coin !== coin ||
    compareGuardCursors(input.launch.cursor, cursor) > 0 || !input.coverage.from || !input.coverage.through ||
    compareGuardCursors(input.coverage.through, cursor) !== 0) throw new Error('Lot source boundary mismatch');
  const available = (s: { cursor: GuardCursor; knownAt: typeof knownAt }) => compareGuardCursors(s.cursor, cursor) <= 0 &&
    compareGuardCursors(s.cursor, s.knownAt.cursor) <= 0 && guardKnownBy(s.knownAt, knownAt);
  const supplies = [...input.supplyBoundaries, input.currentSupply];
  for (const s of supplies) {
    if (s.coin !== coin || !available(s)) throw new Error('Lot supply exceeds captured source');
    for (const field of ['total', 'holderFloat'] as const) {
      const value = s.supply[field].value;
      if (value && (value.asset !== coin || value.decimals !== input.decimals)) throw new Error('Lot supply unit mismatch');
    }
  }
  if (compareGuardCursors(input.currentSupply.cursor, cursor) !== 0) throw new Error('Lot current supply boundary mismatch');
  for (const e of input.exclusions) if (!available(e)) throw new Error('Lot exclusion exceeds captured source');
  if (input.launch.roles.some(r => compareGuardCursors(r.cursor, cursor) > 0)) throw new Error('Lot role exceeds captured source');
  const issues = new Set<LotMetricsSnapshot['issues'][number]>();
  // A position checkpoint contains remaining basis, not all earlier buy debits or sale receipts.
  if (input.opening.length > 0) issues.add('unknown_lifetime_cash');
  const actions = input.actions.filter(available).sort((a, b) => compareGuardCursors(a.cursor, b.cursor));
  if (!input.coverage.complete || input.actions.some(a => compareGuardCursors(a.cursor, cursor) <= 0 && !available(a))) issues.add('incomplete_source');
  if (input.launch.createdAtSec === null || BigInt(input.coverage.from.timestampSec) > BigInt(input.launch.createdAtSec)) issues.add('incomplete_source');
  const positions = new Set<string>(), ids = new Set<string>(), sourceIds = new Set<string>();
  for (const a of actions) {
    if (a.cursor.boundary !== 'after_tx' || compareGuardCursors(a.cursor, input.coverage.from) <= 0) throw new Error('Lot action needs a full ordered cursor after opening');
    const key = JSON.stringify([a.cursor.blockNumber, a.cursor.blockHash, a.cursor.transactionIndex, a.cursor.executionOrdinal]);
    if (positions.has(key) || ids.has(a.id) || a.sourceIds.some(id => sourceIds.has(id))) throw new Error('Duplicate lot action/order/source leg');
    positions.add(key); ids.add(a.id); for (const id of a.sourceIds) sourceIds.add(id);
  }
  if (actions.some((a, i) => i > 0 && BigInt(a.cursor.timestampSec) < BigInt(actions[i - 1].cursor.timestampSec)))
    throw new Error('Non-monotone recorded lot clock');
  const principals = [...new Set(input.launch.roles.filter(r => r.role === 'launch_principal' && r.status === 'verified' &&
    r.address !== null && compareGuardCursors(r.cursor, cursor) <= 0).map(r => r.address!))];
  const principal = principals.length === 1 ? principals[0] : null;
  if (!principal) issues.add('unknown_principal');
  const excluded = new Set(input.exclusions.map(e => e.address)), sinks = new Set(input.exclusions.filter(e => e.role === 'sink').map(e => e.address));
  const zero: Address = `0x${'0'.repeat(40)}`;
  const evidenceIds = [...new Set([...actions.flatMap(a => a.evidenceIds), ...input.opening.flatMap(l => l.evidenceIds),
    ...input.exclusions.flatMap(e => e.evidenceIds), ...input.currentSupply.supply.total.evidenceIds])].sort();
  const quantity = (n: bigint): RawAmount => ({ asset: coin, decimals: input.decimals, raw: n.toString() });
  const complete = !issues.has('incomplete_source');
  function metric<T>(id: MetricId, value: T | null, unit: Metric<T>['unit'], numerator: string | RawAmount | null = null,
    denominator: string | RawAmount | null = null, denominatorKind: Metric<T>['denominatorKind'] = null, exact = false): Metric<T> {
    if (!complete && !exact) value = null;
    return { id, unit, cursor, knownAt, numerator, denominator, denominatorKind, fromSec: input.coverage.from!.timestampSec,
      throughSec: cursor.timestampSec, methodVersion: LOT_METRICS_METHOD_VERSION, evidenceIds,
      coverage: { ...input.coverage, scopeId: `lots-${id}`, complete: value !== null, gaps: value === null ? ['missing'] : [] },
      ...(value === null ? { status: 'unknown' as const, value: null, failureCode: 'missing' as const } :
        { status: 'observed' as const, value, failureCode: null }) };
  }
  const units = (id: MetricId, n: bigint | null) => metric(id, n === null ? null : quantity(n), 'raw');
  const ratio = (id: MetricId, n: bigint | null, d: bigint | null, kind: 'S' | 'F' | 'other' | 'quote_cost', pct = true) => {
    const valid = n !== null && d !== null && d > 0n;
    const m = metric(id, valid ? decimal(fraction(n! * (pct ? 100n : 1n), d!)) : null, pct ? 'pct' : 'ratio',
      n?.toString() ?? null, valid ? d!.toString() : null, kind);
    return m.status === 'observed' ? { ...m, errorBounds: { lower: rational(fraction(0n)), upper: rational(fraction(1n, 10n ** 36n)) } } : m;
  };
  const quoteMetric = (id: MetricId, n: bigint | null, asset = input.quoteAsset, decimals = input.quoteDecimals, exact = false) =>
    metric(id, n === null ? null : { asset, decimals, amount: tokenDecimal(n, decimals) }, 'quote', null, null, null, exact);
  const stats = new Map<Address, Stats>(), history = new Map<Address, LotHistory[]>();
  const stat = (a: Address) => {
    if (!stats.has(a)) stats.set(a, { opening: 0n, bought: 0n, acquired: 0n, received: 0n, out: 0n, sold: 0n, burned: 0n,
      fees: 0n, cex: 0n, debit: 0n, receipt: 0n, cashKnown: true, soldBasis: fraction(0n), basisKnown: true, knownSold: 0n });
    return stats.get(a)!;
  };
  const lots: LiveLot[] = input.opening.map(l => {
    if (l.units.asset !== coin || l.units.decimals !== input.decimals || compareGuardCursors(l.acquiredAt, input.coverage.from!) > 0)
      throw new Error('Opening lot source mismatch');
    if (l.state === 'locked') issues.add('opening_lock');
    stat(l.owner).opening += l.state === 'liquid' ? BigInt(l.units.raw) : 0n;
    return { ...l, units: BigInt(l.units.raw), basis: l.basis ? { ...l.basis,
      cost: fraction(BigInt(l.basis.cost.numerator), BigInt(l.basis.cost.denominator)) } : null };
  });
  if (new Set(lots.map(l => l.id)).size !== lots.length) throw new Error('Duplicate opening lot');
  const amount = (a: Address, state?: LiveLot['state']) => lots.reduce((n, l) => n + (l.owner === a && (!state || l.state === state) ? l.units : 0n), 0n);
  const save = (a: Address, at: GuardCursor) => {
    const s = stat(a), item = { cursor: at, liquid: amount(a, 'liquid'), acquired: s.acquired + s.received,
      debit: s.debit, receipt: s.receipt, cashKnown: s.cashKnown };
    if (!history.has(a)) history.set(a, []); history.get(a)!.push(item);
  };
  for (const a of stats.keys()) save(a, input.coverage.from);
  const ordered = (owner: Address, state: LiveLot['state']) => lots.filter(l => l.owner === owner && l.state === state && l.units > 0n)
    .sort((a, b) => compareGuardCursors(a.acquiredAt, b.acquiredAt) || (a.origin ?? '').localeCompare(b.origin ?? '') || a.id.localeCompare(b.id));
  const consume = (owner: Address, n: bigint, state: LiveLot['state'] = 'liquid'): LiveLot[] => {
    let remaining = n; const pieces: LiveLot[] = [];
    const before = ordered(owner, state), total = before.reduce((sum, l) => sum + l.units, 0n);
    const origins = new Map<Address | null, bigint>();
    for (const l of before) origins.set(l.origin, (origins.get(l.origin) ?? 0n) + l.units);
    for (const l of before) {
      const take = remaining < l.units ? remaining : l.units; if (!take) break;
      const cost = l.basis ? times(l.basis.cost, take, l.units) : null;
      pieces.push({ ...l, units: take, basis: l.basis && cost ? { ...l.basis, cost } : null });
      if (l.basis && cost) l.basis.cost = plus(l.basis.cost, times(cost, -1n));
      l.units -= take; remaining -= take;
    }
    if (remaining) throw new Error('Unreconciled lot debit: source history/balance is insufficient');
    const taken = new Map<Address | null, bigint>();
    for (const piece of pieces) taken.set(piece.origin, (taken.get(piece.origin) ?? 0n) + piece.units);
    if (n > 0n && [...origins].some(([origin, mass]) => (taken.get(origin) ?? 0n) * total !== mass * n)) {
      const alternatives = [...new Set(before.flatMap(l => l.originAlternatives))].sort((a, b) => (a ?? '').localeCompare(b ?? ''));
      if (principal !== null && (alternatives.includes(principal) || alternatives.includes(null))) issues.add('allocation_sensitive');
      // A later receiver sale cannot turn a prior FIFO/proportional disagreement into certain lineage.
      for (const lot of [...before, ...pieces]) lot.originAlternatives = alternatives;
    }
    return pieces;
  };
  const credit = (pieces: LiveLot[], owner: Address, action: LotAction, state: LiveLot['state'] = 'liquid') => {
    for (const [i, piece] of pieces.entries()) lots.push({ ...piece, id: lotHash([piece.id, action.id, owner, state, i]), owner, state,
      evidenceIds: [...new Set([...piece.evidenceIds, ...action.evidenceIds])].sort() });
  };
  const mintLot = (owner: Address, n: bigint, action: LotAction, basis: LiveLot['basis'], basisPayer: Address | null) =>
    lots.push({ id: lotHash([action.id, owner]), owner, origin: owner, originAlternatives: [owner], acquiredAt: action.cursor, units: n, state: 'liquid',
      basis, basisPayer, evidenceIds: action.evidenceIds });
  const linked = new Set<Address>();
  const broad = new Set<string>();
  for (const id of input.completeDistributions) {
    const transfers = actions.filter((a): a is Extract<LotAction, { kind: 'transfer' }> => a.kind === 'transfer' && a.distributionId === id);
    const recipients = new Map<Address, bigint>();
    for (const t of transfers) recipients.set(t.to, (recipients.get(t.to) ?? 0n) + BigInt(t.delivered));
    // Require a supplied S at the distribution boundary, rather than using a later changed total.
    const boundary = supplies.find(s => transfers.length && compareGuardCursors(s.cursor, transfers[0].cursor) < 0 &&
      s.cursor.timestampSec === transfers[0].cursor.timestampSec && s.supply.total.status === 'observed');
    const S = boundary?.supply.total.value?.raw;
    if (S && recipients.size >= 100 && [...recipients.values()].every(n => n * 1000n <= BigInt(S))) broad.add(id);
  }
  const sales: LotMetricsSnapshot['sales'] = [], saleFacts: SaleFact[] = [];
  for (const action of actions) {
    const touched = new Set<Address>();
    if (action.kind === 'buy') {
      const recipient = stat(action.recipient), payer = stat(action.payer), n = BigInt(action.delivered);
      recipient.bought += n; recipient.acquired += n;
      const sameQuote = action.quoteAsset === input.quoteAsset && action.quoteDecimals === input.quoteDecimals;
      if (!sameQuote) issues.add('mixed_quote');
      if (action.quoteDebit === null || !sameQuote) payer.cashKnown = false; else payer.debit += BigInt(action.quoteDebit);
      mintLot(action.recipient, n, action, action.quoteDebit === null ? null : { asset: action.quoteAsset,
        decimals: action.quoteDecimals, cost: fraction(BigInt(action.quoteDebit)) }, action.payer);
      if (action.quoteDebit === null) issues.add('unknown_basis');
      if (principal !== null && action.creationSubtree === true && action.recipient !== principal && !excluded.has(action.recipient)) linked.add(action.recipient);
      if (action.creationSubtree === null) issues.add('unknown_creation_subtree');
      touched.add(action.recipient); touched.add(action.payer);
    } else if (action.kind === 'sell') {
      const n = BigInt(action.swapDebit), fee = BigInt(action.tokenFee), opening = amount(action.seller, 'liquid');
      if (fee > 0n) issues.add('unresolved_fee_origin');
      const before = ordered(action.seller, 'liquid'), origins = new Map<Address | null, bigint>();
      for (const l of before) origins.set(l.origin, (origins.get(l.origin) ?? 0n) + l.units);
      const inheritedOriginUncertainty = principal !== null && before.some(l =>
        l.originAlternatives.includes(null) || l.originAlternatives.length > 1 && l.originAlternatives.includes(principal));
      const consumed = consume(action.seller, n), fifo = new Map<Address | null, bigint>();
      for (const l of consumed) fifo.set(l.origin, (fifo.get(l.origin) ?? 0n) + l.units);
      consume(action.seller, fee);
      const s = stat(action.seller); s.sold += n; s.fees += fee;
      for (const l of consumed) {
        if (l.basis && l.basis.asset === input.quoteAsset && l.basis.decimals === input.quoteDecimals) {
          s.soldBasis = plus(s.soldBasis, l.basis.cost); s.knownSold += l.units;
        } else { s.basisKnown = false; issues.add('unknown_basis'); }
      }
      if (action.grossQuote !== null && action.netQuote !== null && action.quoteFee !== null &&
        BigInt(action.grossQuote) !== BigInt(action.netQuote) + BigInt(action.quoteFee)) throw new Error('Unreconciled sale quote deltas');
      if (action.grossQuote !== null && action.netQuote !== null && BigInt(action.netQuote) > BigInt(action.grossQuote))
        throw new Error('Unreconciled sale quote deltas');
      const receiver = stat(action.recipient), sameQuote = action.quoteAsset === input.quoteAsset && action.quoteDecimals === input.quoteDecimals;
      if (!sameQuote) issues.add('mixed_quote');
      if (action.netQuote === null || !sameQuote) { receiver.cashKnown = false; s.cashKnown = false; }
      else receiver.receipt += BigInt(action.netQuote);
      const origin = principal ? fifo.get(principal) ?? 0n : 0n;
      const proportion = principal && opening > 0n ? fraction((origins.get(principal) ?? 0n) * n, opening) : fraction(0n);
      const sensitive = principal !== null && (inheritedOriginUncertainty || origin * proportion.d !== proportion.n);
      if (sensitive) issues.add('allocation_sensitive');
      const netQuote = quoteMetric('netSaleReceipts', action.netQuote === null ? null : BigInt(action.netQuote), action.quoteAsset, action.quoteDecimals, true);
      const grossQuote = quoteMetric('grossSaleReceipts', action.grossQuote === null ? null : BigInt(action.grossQuote), action.quoteAsset, action.quoteDecimals, true);
      for (const m of [netQuote, grossQuote]) { m.cursor = action.cursor; m.fromSec = action.cursor.timestampSec; m.throughSec = action.cursor.timestampSec; }
      sales.push({ id: action.id, cursor: action.cursor, seller: action.seller, proceedsRecipient: action.recipient, transactionId: action.transactionId,
        units: quantity(n), feeUnits: quantity(fee), directPrincipal: principal !== null && action.seller === principal,
        responsibility: 'not_assessed', originUnits: [...origins].sort(([a], [b]) => (a ?? '').localeCompare(b ?? '')).map(([origin, mass]) => ({
          origin, fifo: quantity(fifo.get(origin) ?? 0n), proportional: rational(opening > 0n ? fraction(mass * n, opening) : fraction(0n)) })),
        principalOriginLower: principal === null ? null : quantity(inheritedOriginUncertainty ? 0n : origin < proportion.n / proportion.d ? origin : proportion.n / proportion.d),
        principalOriginUpper: principal === null ? null : quantity(inheritedOriginUncertainty ? n : origin > (proportion.n + proportion.d - 1n) / proportion.d ? origin : (proportion.n + proportion.d - 1n) / proportion.d),
        inheritedOriginUncertainty,
        basisKnown: consumed.every(l => l.basis !== null),
        netQuote, grossQuote });
      saleFacts.push({ action, opening, origin, sensitive }); touched.add(action.seller); touched.add(action.recipient);
    } else if (action.kind === 'transfer') {
      const n = BigInt(action.delivered), fee = BigInt(action.tokenFee), pieces = consume(action.from, n);
      if (fee > 0n) issues.add('unresolved_fee_origin');
      consume(action.from, fee); stat(action.from).fees += fee;
      if (action.to === zero || sinks.has(action.to)) {
        stat(action.from).burned += n;
        if (action.to !== zero) credit(pieces, action.to, action, 'sink');
      } else {
        if (action.from !== action.to) { stat(action.from).out += n; stat(action.to).received += n; }
        credit(pieces, action.to, action);
        if (action.cexDeposit) stat(action.from).cex += n;
        if (n > 0n && principal === action.from && action.to !== principal && !excluded.has(action.to) && !(action.distributionId && broad.has(action.distributionId))) linked.add(action.to);
      }
      touched.add(action.from); touched.add(action.to);
    } else if (action.kind === 'mint') {
      mintLot(action.recipient, BigInt(action.units), action, null, null); stat(action.recipient).acquired += BigInt(action.units); touched.add(action.recipient);
    } else if (action.kind === 'burn') {
      consume(action.owner, BigInt(action.units)); stat(action.owner).burned += BigInt(action.units); touched.add(action.owner);
    } else {
      const from = action.kind === 'lock' ? 'liquid' : 'locked', to = action.kind === 'lock' ? 'locked' : 'liquid';
      credit(consume(action.owner, BigInt(action.units), from), action.owner, action, to); touched.add(action.owner);
    }
    for (const a of touched) save(a, action.cursor);
  }
  const sourceSupply = (s: SupplySnapshotV2 | undefined, field: 'total' | 'holderFloat') => s?.supply[field].status === 'observed' &&
    (field !== 'holderFloat' || s.floatState === 'stable') ? BigInt(s.supply[field].value!.raw) : null;
  const S = sourceSupply(input.currentSupply, 'total'), F = sourceSupply(input.currentSupply, 'holderFloat');
  const rawLots = lots.filter(l => l.units > 0n);
  for (const a of stats.keys()) {
    const observed = input.currentSupply.holdings.find(h => h.address === a);
    if (observed?.raw.status === 'observed' && BigInt(observed.raw.value.raw) !== amount(a)) issues.add('unreconciled');
  }
  const aggregate = (members: Address[], memberComplete: boolean): PositionMetrics => {
    const sum = (key: keyof Pick<Stats, 'opening' | 'bought' | 'acquired' | 'received' | 'out' | 'sold' | 'burned' | 'fees' | 'cex' | 'debit' | 'receipt' | 'knownSold'>) =>
      members.reduce((n, a) => n + stat(a)[key], 0n);
    const raw = members.reduce((n, a) => n + amount(a), 0n), liquid = members.reduce((n, a) => n + amount(a, 'liquid'), 0n),
      locked = members.reduce((n, a) => n + amount(a, 'locked'), 0n), out = sum('out') - sum('received');
    const residual = sum('opening') + sum('acquired') - liquid - locked - sum('sold') - sum('burned') - out - sum('fees');
    const measured = memberComplete && !issues.has('unreconciled');
    const conserved = measured && residual === 0n && !issues.has('opening_lock');
    const cashKnown = measured && members.every(a => stat(a).cashKnown), basisKnown = measured && members.every(a => stat(a).basisKnown);
    const basis = members.reduce((n, a) => plus(n, stat(a).soldBasis), fraction(0n));
    const unit = (id: MetricId, n: bigint) => units(id, measured ? n : null);
    return { raw: unit('raw', raw), liquid: unit('liquid', liquid), locked: unit('locked', locked),
      supplyPct: ratio('supplyPct', measured ? liquid : null, S, 'S'), floatPct: ratio('floatPct', measured ? liquid : null, F, 'F'),
      grossBought: unit('grossBought', sum('bought')), sold: unit('sold', sum('sold')),
      dispositions: { openingLiquid: units('openingLiquid', conserved ? sum('opening') : null), externalAcquisition: units('externalAcquisition', conserved ? sum('acquired') : null),
        held: units('held', measured ? liquid : null), sold: unit('sold', sum('sold')), burned: unit('burned', sum('burned')), locked: unit('locked', locked),
        netTransferredOut: quoteMetric('netTransferredOut', conserved ? out : null, coin, input.decimals),
        fees: unit('transferFees', sum('fees')), unexplainedResidual: quoteMetric('unexplainedResidual', memberComplete ? residual : null, coin, input.decimals),
        cexDeposits: unit('cexDeposits', sum('cex')) },
      marketCashOutMultiple: ratio('marketCashOutMultiple', cashKnown && !issues.has('unknown_lifetime_cash') ? sum('receipt') : null,
        cashKnown && !issues.has('unknown_lifetime_cash') ? sum('debit') : null, 'quote_cost', false),
      allInCashOutMultiple: ratio('allInCashOutMultiple', null, null, 'quote_cost', false),
      realizedLotMultiple: ratio('realizedLotMultiple', basisKnown && cashKnown ? sum('receipt') * basis.d : null,
        basisKnown ? basis.n : null, 'quote_cost', false), basisCoveragePct: ratio('basisCoveragePct', measured ? sum('knownSold') : null, sum('sold'), 'other') };
  };
  const firstTrade = input.launch.firstTradeSec === null ? null : BigInt(input.launch.firstTradeSec);
  const launchAt = input.launch.createdAtSec === null ? null : BigInt(input.launch.createdAtSec);
  const T = BigInt(cursor.timestampSec), cohortSpecs: { id: LotMetricsSnapshot['cohorts'][number]['id']; members: Address[]; known: boolean; end: bigint | null }[] = [
    { id: 'principal', members: principal ? [principal] : [], known: principal !== null, end: null },
    { id: 'launch_linked', members: [...linked], known: principal !== null && input.creationSubtreeComplete && !issues.has('unknown_creation_subtree'), end: null },
    { id: 'exempt', members: input.launch.roles.filter(r => r.role === 'exempt' && r.status === 'verified' && r.address !== null).map(r => r.address!), known: input.exemptComplete, end: null },
  ];
  for (const [id, start, duration] of [['early', firstTrade, 5n], ['launch_5s', launchAt, 5n], ['launch_60s', launchAt, 60n], ['launch_300s', launchAt, 300n]] as const) {
    const end = start === null ? null : start + duration;
    const members = start === null ? [] : actions.filter((a): a is Extract<LotAction, { kind: 'buy' }> => a.kind === 'buy' &&
      BigInt(a.cursor.timestampSec) >= start && BigInt(a.cursor.timestampSec) < end!).map(a => a.recipient);
    if (start === null) issues.add('unknown_window');
    cohortSpecs.push({ id, members, known: start !== null, end });
  }
  const cohorts = cohortSpecs.map(c => {
    const members = [...new Set(c.members)].sort(), metrics = aggregate(members, c.known);
    // Window cohorts' gross bought count only delivered buys inside that named window, not subsequent turnover.
    const duration = c.id === 'launch_60s' ? 60n : c.id === 'launch_300s' ? 300n : 5n;
    const bought = c.end === null ? members.reduce((n, a) => n + stat(a).bought, 0n) : actions.reduce((n, a) => n + (a.kind === 'buy' &&
      members.includes(a.recipient) && BigInt(a.cursor.timestampSec) >= c.end! - duration && BigInt(a.cursor.timestampSec) < c.end! ? BigInt(a.delivered) : 0n), 0n);
    if (c.end !== null) metrics.grossBought = units('grossBought', c.known ? bought : null);
    const denominatorSnapshot = c.end === null || c.end > T ? input.currentSupply : supplies.find(s => BigInt(s.cursor.timestampSec) === c.end &&
      !actions.some(a => BigInt(a.cursor.timestampSec) === c.end && compareGuardCursors(a.cursor, s.cursor) <= 0));
    const received = actions.reduce((n, a) => n + (a.kind === 'transfer' && !members.includes(a.from) && members.includes(a.to) &&
      a.to !== zero && !sinks.has(a.to) ? BigInt(a.delivered) : 0n), 0n);
    const acquired = members.reduce((n, a) => n + stat(a).opening + stat(a).acquired, 0n) + received;
    return { id: c.id, members, membershipHash: lotHash([coin, c.id, members]), membershipComplete: c.known && complete,
      metrics, soldOfAcquired: ratio('soldShare', c.known ? members.reduce((n, a) => n + stat(a).sold, 0n) : null, acquired, 'other'),
      boughtSupplyPct: ratio('cohortBought', c.known ? bought : null, sourceSupply(denominatorSnapshot, 'total'), 'S'),
      boughtFloatPct: ratio('cohortBought', c.known ? bought : null, sourceSupply(denominatorSnapshot, 'holderFloat'), 'F') };
  });
  const originKnown = principal !== null && !issues.has('unresolved_fee_origin') && !rawLots.some(l =>
    (l.originAlternatives.includes(null) || l.originAlternatives.length > 1 && l.originAlternatives.includes(principal)));
  const originLots = principal ? rawLots.filter(l => l.origin === principal) : [];
  const originRaw = originLots.reduce((n, l) => n + l.units, 0n), originLiquid = originLots.reduce((n, l) => n + (l.state === 'liquid' ? l.units : 0n), 0n),
    originLocked = originLots.reduce((n, l) => n + (l.state === 'locked' ? l.units : 0n), 0n);
  const result = { schemaVersion: 'lot-metrics-2', methodVersion: LOT_METRICS_METHOD_VERSION, coin, cursor, knownAt,
    lots: rawLots.map(l => ({ ...l, units: quantity(l.units), basis: l.basis ? { ...l.basis, cost: rational(l.basis.cost) } : null })),
    cohorts, sales, principalOriginOverhang: { raw: units('raw', originKnown ? originRaw : null), liquid: units('liquid', originKnown ? originLiquid : null),
      locked: units('locked', originKnown ? originLocked : null), supplyPct: ratio('supplyPct', originKnown ? originLiquid : null, S, 'S'),
      floatPct: ratio('floatPct', originKnown ? originLiquid : null, F, 'F') },
    ...rawSellingMetrics(input, saleFacts, history, supplies, principal, metric, units, ratio, quoteMetric), issues: [...issues].sort() };
  return LotMetricsSnapshotSchema.parse(result);
}
