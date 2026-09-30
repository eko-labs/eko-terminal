import { describe, expect, it } from 'vitest';
import { referenceDigest } from '@eko/chain';
import { fraction, plus } from '../src/lot-arithmetic.js';
import { estimateReserveOrigin } from '../src/reserve-origin.js';
import { ReserveOriginInputSchema } from '../src/reserve-origin-input.js';
import { address, at, base, buy, fees, fixture, hash, migration, operator, outside, provider, reserve, sale } from './reserve-origin-fixtures.js';

const ratio = (numerator: string, denominator = '1') => ({ numerator, denominator });
const conserved = (result: ReturnType<typeof estimateReserveOrigin>) => {
  for (const snapshot of [...result.snapshots, result]) {
    expect(snapshot.buckets).not.toBeNull();
    const b = snapshot.buckets!;
    const values = [b.operator, b.outsideBuyer, b.other, ...b.providers.map(p => p.units)]
      .map(v => fraction(BigInt(v.numerator), BigInt(v.denominator)));
    expect(values.every(v => v.n >= 0n)).toBe(true);
    const total = values.reduce(plus, fraction(0n));
    expect(total.n).toBe(BigInt(snapshot.realQuote) * total.d);
  }
};
describe('optional fixture-only proportional reserve origin', () => {
  it('uses real quote, keeps gross/net/fees separate, and leaves input immutable', () => {
    const i = fixture(); i.steps = [sale(1, 2, '100', '50', '10')]; i.closing.reserve = reserve('50');
    const before = JSON.stringify(i), r = estimateReserveOrigin(i);
    expect(r).toMatchObject({ status: 'observed', mode: 'shadow', active: false, released: false, origin: 'fixture',
      grossSaleOutflow: '50', netSaleReceipts: '40', saleFeeOutflow: '10', buyerOriginReceipts: ratio('24'), estimate: ratio('24'),
      buckets: { operator: ratio('10'), outsideBuyer: ratio('30'), other: ratio('10') } });
    expect(r.sales[0]).toMatchObject({ recipient: address(40), buyerFractionBefore: ratio('3', '5'),
      attributedNetReceipt: ratio('40'), buyerOriginReceipt: ratio('24'), fees: fees(1, '10') });
    expect(JSON.stringify(i)).toBe(before);
    i.opening.reserve.virtualQuote = '1'; i.steps[0].before.virtualQuote = '2'; i.steps[0].after.virtualQuote = '3';
    expect(estimateReserveOrigin(i).estimate).toEqual(r.estimate); conserved(r);
    const { id, ...body } = r; expect(referenceDigest(body)).toBe(id);
  });
  it('attributes mixed sold lots independently of the proceeds recipient and control', () => {
    const i = fixture(), s = sale(1, 2, '100', '50', '10');
    s.soldLots = [{ id: hash(80), origin: operator, units: '4' }, { id: hash(81), origin: outside, units: '6' }];
    i.steps = [s]; i.closing.reserve = reserve('50');
    const r = estimateReserveOrigin(i);
    expect(r.sales[0]).toMatchObject({ operatorLotFraction: ratio('2', '5'), attributedNetReceipt: ratio('16'), buyerOriginReceipt: ratio('48', '5') });
    expect(r.estimate).toEqual(ratio('48', '5')); conserved(r);
    s.recipient = outside; expect(estimateReserveOrigin(i).estimate).toEqual(r.estimate);
  });
  it('subtracts each verified buy debit once, including buy fees, across several receipts', () => {
    const i = fixture(); i.steps = [buy(1, 2, '100', '110', operator, '2'), sale(2, 3, '110', '55'), sale(3, 4, '55', '22')];
    i.closing.reserve = reserve('22'); const r = estimateReserveOrigin(i);
    expect(r.buyerOriginReceipts).toEqual(ratio('48')); expect(r.estimate).toEqual(ratio('36'));
    expect(r.verifiedOperatorBuyDebitsInInterval).toBe('12'); expect(r.operatorBuyDebitIds).toEqual([hash(1)]);
    expect(r.snapshots[0]).toMatchObject({ netReserveContribution: '10', quoteDebit: '12', feeOutflow: '2' }); conserved(r);
    i.steps = [buy(1, 2, '100', '200'), sale(2, 3, '200', '199')]; i.closing.reserve = reserve('199');
    expect(estimateReserveOrigin(i).estimate).toEqual(ratio('0'));
  });
  it('replays pre-interval mixing but only offsets and sums sales in (from,through]', () => {
    const i = fixture(); i.interval.from = at(3);
    i.steps = [buy(1, 2, '100', '110'), sale(2, 3, '110', '55'), sale(3, 4, '55', '22')]; i.closing.reserve = reserve('22');
    const r = estimateReserveOrigin(i); expect(r.verifiedOperatorBuyDebitsInInterval).toBe('0');
    expect(r.grossSaleOutflow).toBe('33'); expect(r.buyerOriginReceipts).toEqual(ratio('18'));
    expect(r.sales.map(s => s.inInterval)).toEqual([false, true]); conserved(r);
  });
  it('handles large raw integers and fractional bucket units with exact sums', () => {
    const i = fixture(); const n = 9007199254740993123456789n;
    i.opening.reserve = reserve((n + 2n).toString()); i.opening.buckets = { operator: n.toString(), outsideBuyer: '1', other: '1', providers: [] };
    i.steps = [sale(1, 2, (n + 2n).toString(), '1')]; i.closing.reserve = reserve('1');
    const r = estimateReserveOrigin(i); expect(r.buckets!.outsideBuyer).toEqual(ratio('1', (n + 2n).toString())); conserved(r);
  });
  it('records LP funding in provider buckets and removes non-sale payouts proportionally', () => {
    const i = fixture(); i.steps = [{ ...base(1, 2, '100', '120'), kind: 'lp_addition', payer: operator, provider, quoteDebit: '23', fees: fees(1, '3') },
      { ...base(2, 3, '120', '60'), kind: 'outflow', grossOutflow: '60', fees: fees(2, '5'), payouts: [{ recipient: provider, units: '55', kind: 'lp_principal' }] }];
    i.closing.reserve = reserve('60'); const r = estimateReserveOrigin(i);
    expect(r.buckets!.providers).toEqual([{ provider, units: ratio('10') }]); expect(r.estimate).toEqual(ratio('0'));
    expect(r.operatorBuyDebitIds).toEqual([]); expect(r.sales).toEqual([]); conserved(r);
  });
  it('pins identity version/cut, changes only with an explicit new identity input', () => {
    const i = fixture(); i.steps = [sale(1, 2, '100', '50')]; i.closing.reserve = reserve('50');
    const r = estimateReserveOrigin(i); expect(r.identity).toEqual(i.identity);
    i.identity.graphVersion = '2.0.1'; i.identity.classifications[0].bucket = 'other';
    const next = estimateReserveOrigin(i); expect(next.estimate).toEqual(ratio('0')); expect(next.identityDigest).not.toBe(r.identityDigest);
    expect(next.id).not.toBe(r.id); expect(r.estimate).toEqual(ratio('30'));
    i.identity.classifications[0].knownAt = { ...i.knownAt, acquisitionSequence: '2' }; expect(() => estimateReserveOrigin(i)).toThrow('pinned cut');
  });
  it('requires known-at acquisition order even at the same timestamp', () => {
    const i = fixture(); i.identity.cut = { ...i.knownAt, acquisitionSequence: '2' }; expect(() => estimateReserveOrigin(i)).toThrow('pinned cut');
    const future = fixture(); future.steps = [buy(1, 2, '100', '110')]; future.steps[0].knownAt.acquisitionSequence = '2';
    expect(() => estimateReserveOrigin(future)).toThrow('exceeds capture');
    const fork = fixture(); fork.closing.cursor.blockHash = hash(999); expect(() => estimateReserveOrigin(fork)).toThrow('capture/interval');
  });
  it('makes a zero-prior sale ratio unknown, while an empty reserve can accept its first contribution', () => {
    const i = fixture(); i.opening.reserve = reserve('0'); i.opening.buckets = { operator: '0', outsideBuyer: '0', other: '0', providers: [] };
    i.steps = [sale(1, 2, '0', '0')]; i.closing.reserve = reserve('0');
    const r = estimateReserveOrigin(i); expect(r.estimate).toBeNull(); expect(r.sales[0].buyerFractionBefore).toBeNull();
    expect(r.estimateGaps).toContain('zero_prior_real_reserve'); conserved(r);
    i.steps = [buy(1, 2, '0', '10', outside)]; i.closing.reserve = reserve('10');
    expect(estimateReserveOrigin(i).buckets!.outsideBuyer).toEqual(ratio('10'));
  });
  it.each(['fees', 'fee_sum', 'negative_delta', 'opening_sum', 'closing', 'coverage', 'manager', 'buy_identity', 'route'] as const)
    ('publishes %s reconciliation/coverage as unknown without clipping or restoring buckets', kind => {
      const i = fixture(); i.steps = [buy(1, 2, '100', '110'), sale(2, 3, '110', '55')]; i.closing.reserve = reserve('55');
      if (kind === 'fees') i.steps[1].fees = null;
      if (kind === 'fee_sum') i.steps[1].fees = fees(2, '1');
      if (kind === 'negative_delta') i.steps[0].after.realQuote = '90';
      if (kind === 'opening_sum') i.opening.buckets.other = '21';
      if (kind === 'closing') i.closing.reserve.realQuote = '54';
      if (kind === 'coverage') i.coverageComplete = false;
      if (kind === 'manager') i.steps[0].before.source = 'manager_balance';
      if (kind === 'buy_identity') i.identity.classifications = i.identity.classifications.filter(c => c.address !== operator);
      if (kind === 'route') i.steps[0].routeId = hash(999);
      const r = estimateReserveOrigin(i); expect(r.status).toBe('unknown'); expect(r.estimate).toBeNull(); expect(r.buckets).toBeNull();
      expect(r.accountingGaps.length).toBeGreaterThan(0); expect(r.grossSaleOutflow).toBe('55');
    });
  it.each(['unknown', 'unreviewed', 'units'] as const)('withholds %s lot estimate while keeping reserve conservation', kind => {
    const i = fixture(), s = sale(1, 2, '100', '50'); i.steps = [s]; i.closing.reserve = reserve('50');
    if (kind === 'unknown') s.soldLots[0].origin = null;
    if (kind === 'unreviewed') s.lotsReviewed = false;
    if (kind === 'units') s.soldLots[0].units = '11';
    const r = estimateReserveOrigin(i); expect(r.estimate).toBeNull(); expect(r.estimateGaps).toEqual(['unresolved_sold_lots']);
    expect(r.accountingGaps).toEqual([]); expect(r.netSaleReceipts).toBe('50'); conserved(r);
  });
  it('rejects duplicate debit/source/fee/lot identities and non-fixture input', () => {
    const i = fixture(); i.steps = [buy(1, 2, '100', '110'), buy(1, 3, '110', '120')];
    expect(() => estimateReserveOrigin(i)).toThrow('Duplicate reserve-origin action');
    i.steps[1].id = hash(2); expect(() => estimateReserveOrigin(i)).toThrow('Duplicate reserve-origin action/source');
    i.steps[1].sourceIds = [hash(999)]; expect(() => estimateReserveOrigin(i)).toThrow('Duplicate reserve-origin fee');
    const lots = fixture(), s = sale(1, 2, '100', '50'); s.soldLots.push(s.soldLots[0]); lots.steps = [s];
    expect(() => estimateReserveOrigin(lots)).toThrow('Duplicate sold lot');
    expect(ReserveOriginInputSchema.safeParse({ ...fixture(), origin: 'measured' }).success).toBe(false);
  });
  it('orders same-block economic legs by ordinal, not input array order', () => {
    const i = fixture(); i.steps = [sale(2, 2, '110', '55'), buy(1, 2, '100', '110')]; i.closing.reserve = reserve('55');
    const r = estimateReserveOrigin(i); expect(r.estimate).toEqual(ratio('20')); expect(r.snapshots.map(s => s.stepId)).toEqual([hash(1), hash(2)]);
    i.steps[0].cursor.executionOrdinal = 1; expect(() => estimateReserveOrigin(i)).toThrow('execution order');
  });
  it('shows mixing/order and reviewed FIFO/proportional sensitivity without inferring control', () => {
    const i = fixture(); i.steps = [sale(1, 2, '100', '50'), buy(2, 3, '50', '100', outside)];
    const afterSale = estimateReserveOrigin(i); expect(afterSale.estimate).toEqual(ratio('30'));
    i.steps = [buy(1, 2, '100', '150', outside), sale(2, 3, '150', '100')];
    const beforeSale = estimateReserveOrigin(i); expect(beforeSale.estimate).toEqual(ratio('110', '3'));
    conserved(afterSale); conserved(beforeSale);
    const s = i.steps[1]; if (s.kind !== 'sale') throw new Error('Fixture sale');
    s.soldLotMethod = 'proportional'; s.soldLots = [
      { id: hash(80), origin: operator, units: '4' }, { id: hash(81), origin: outside, units: '6' }];
    const proportional = estimateReserveOrigin(i);
    expect(proportional.sales[0].soldLotMethod).toBe('proportional'); expect(proportional.estimate).toEqual(ratio('44', '3'));
    expect(proportional.buckets).toEqual(beforeSale.buckets);
  });
  it('carries actual origins through verified per-pool migration, with payout separation', () => {
    const i = fixture(), m = migration(); i.opening.cursor = at(8); i.interval.from = at(8);
    i.opening.reserve = reserve('105'); i.opening.buckets = { operator: '21', outsideBuyer: '63', other: '21', providers: [] };
    i.steps = [m]; i.closing.routeId = m.successor.id; i.closing.reserve = reserve('100', 'per_pool_settlement');
    const r = estimateReserveOrigin(i); expect(r.status).toBe('observed'); expect(r.buckets).toMatchObject({ operator: ratio('20'), outsideBuyer: ratio('60'), other: ratio('20') });
    expect(r.sales).toEqual([]); expect(r.snapshots[0]).toMatchObject({ grossOutflow: '5', feeOutflow: '5', routeId: m.successor.id }); conserved(r);
    m.fees = fees(900, '2'); m.payouts = [{ recipient: address(40), units: '3', kind: 'other' }];
    expect(estimateReserveOrigin(i).buckets).toEqual(r.buckets);
  });
  it('keeps later per-pool additions in provider buckets after migration', () => {
    const i = fixture(), m = migration(); i.opening.cursor = at(8); i.interval.from = at(8);
    i.opening.reserve = reserve('105'); i.opening.buckets = { operator: '21', outsideBuyer: '63', other: '21', providers: [] };
    i.cursor = at(12); i.knownAt = { cursor: at(12), acquisitionSequence: '1' }; i.interval.through = i.cursor;
    i.closing.cursor = i.cursor; i.closing.knownAt = i.knownAt;
    i.closing.routeId = m.successor.id; i.closing.reserve = reserve('125', 'per_pool_settlement');
    i.steps = [m, { ...base(901, 11, '100', '125'), kind: 'lp_addition', knownAt: i.knownAt, payer: operator, provider,
      routeId: m.successor.id, before: reserve('100', 'per_pool_settlement'), after: reserve('125', 'per_pool_settlement'), quoteDebit: '25' }];
    const r = estimateReserveOrigin(i); expect(r.buckets!.providers).toEqual([{ provider, units: ratio('25') }]);
    expect(r.buckets!.outsideBuyer).toEqual(ratio('60')); expect(r.estimate).toEqual(ratio('0')); conserved(r);
  });
  it.each(['settlement', 'fees', 'aggregate', 'residual', 'quote', 'before_pin', 'accrued_fees'] as const)
    ('does not carry migration origins through unsupported %s', kind => {
      const i = fixture(), m = migration(); i.opening.cursor = at(8); i.interval.from = at(8);
      i.opening.reserve = reserve('105'); i.opening.buckets = { operator: '21', outsideBuyer: '63', other: '21', providers: [] };
      i.steps = [m]; i.closing.routeId = m.successor.id; i.closing.reserve = reserve('100', 'per_pool_settlement');
      if (kind === 'settlement') m.settlement.pools[0].migrationCredit!.transactionHash = hash(999);
      if (kind === 'fees') m.fees = fees(900, '4');
      if (kind === 'aggregate') m.settlement.pools[0].inventorySource = 'manager_balance';
      if (kind === 'residual') { m.settlement.after.realQuoteReserve = '1'; m.settlement.before.realQuoteReserve = '106'; }
      if (kind === 'quote') m.settlement.migration.quoteAsset = address(999);
      if (kind === 'before_pin') { i.opening.cursor = at(9); i.interval.from = at(9); }
      if (kind === 'accrued_fees') m.settlement.pools[0].quoteFees = '1';
      const r = estimateReserveOrigin(i); expect(r.estimate).toBeNull(); expect(r.buckets).toBeNull();
      expect(r.accountingGaps).toContain('unsupported_migration_settlement');
    });
});
