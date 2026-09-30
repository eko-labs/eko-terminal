// Synthetic normalized reserve accounting only; no measured chain validation or independent labels.
import type { ReserveOriginInput, ReserveOriginStep } from '../src/reserve-origin-input.js';
import { address, at, coin, curve, hash, knownAt, proof } from './supply-fixtures.js';
import { graduationFixture, manager, successorId } from './graduation-fixtures.js';
export { address, at, hash };
export const operator = address(30), outside = address(31), feeRecipient = address(32), provider = address(33);
export const route = { id: hash(200), venue: 'pons_curve' as const, address: curve, poolId: null };
export const reserve = (realQuote: string, source: 'curve_real_getter' | 'per_pool_settlement' | 'manager_balance' = 'curve_real_getter') =>
  ({ realQuote, virtualQuote: '999999999999999999999999', reviewed: true, source });
export const fees = (id: number, units: string) => [{ id: hash(id + 10000), recipient: feeRecipient, units }];
export function base(id: number, block: number, before: string, after: string) {
  return { ...structuredClone(proof), id: hash(id), cursor: { ...at(block), transactionIndex: 0, executionOrdinal: id, boundary: 'after_tx' as const },
    sourceIds: [hash(id + 20000)], routeId: route.id, before: reserve(before), after: reserve(after), fees: fees(id, '0') };
}
export function fixture(): ReserveOriginInput {
  return structuredClone({ schemaVersion: 'reserve-origin-input-1', origin: 'fixture', sourceRevision: '0'.repeat(40), coin,
    quoteAsset: address(0), quoteDecimals: 18, cursor: at(10), knownAt, interval: { from: at(1), through: at(10) }, coverageComplete: true,
    identity: { schemaVersion: 'reserve-origin-identity-1', graphVersion: '2.0.0', cut: knownAt, evidenceIds: [hash(500)],
      classifications: [ { address: operator, bucket: 'operator', knownAt, evidenceIds: [hash(501)] },
        { address: outside, bucket: 'outside_buyer', knownAt, evidenceIds: [hash(502)] } ] },
    opening: { ...proof, cursor: at(1), route, reserve: reserve('100'),
      buckets: { operator: '20', outsideBuyer: '60', other: '20', providers: [] } },
    closing: { ...proof, routeId: route.id, reserve: reserve('100') }, steps: [] });
}
export const buy = (id: number, block: number, before: string, after: string, payer = operator, fee = '0'): ReserveOriginStep =>
  ({ ...base(id, block, before, after), kind: 'buy', payer, quoteDebit: (BigInt(after) - BigInt(before) + BigInt(fee)).toString(), fees: fees(id, fee) });
export const sale = (id: number, block: number, before: string, after: string, fee = '0'): Extract<ReserveOriginStep, { kind: 'sale' }> =>
  ({ ...base(id, block, before, after), kind: 'sale', recipient: address(40), grossOutflow: (BigInt(before) - BigInt(after)).toString(),
    netReceipt: (BigInt(before) - BigInt(after) - BigInt(fee)).toString(), fees: fees(id, fee), soldUnits: '10', lotsReviewed: true, soldLotMethod: 'fifo',
    soldLots: [{ id: hash(id + 30000), origin: operator, units: '10' }] });
export function migration(): Extract<ReserveOriginStep, { kind: 'migration' }> {
  const settlement = graduationFixture();
  return { ...base(900, 10, '105', '100'), cursor: at(10), kind: 'migration', after: reserve('100', 'per_pool_settlement'),
    fees: fees(900, '5'), payouts: [], successor: { id: successorId, venue: 'per_pool', address: manager, poolId: successorId }, settlement };
}
