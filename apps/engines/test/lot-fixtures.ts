// Synthetic normalized accounting inputs. No measured attribution, impact or calibration evidence.
import { GuardCursorSchema, SupplySnapshotV2Schema } from '@eko/shared';
import type { Address, GuardCursor, GuardLot } from '@eko/shared';
import { resolveLaunchRolesV2 } from '@eko/chain';
import { coverage as sampleCoverage, observed, unknown } from '../../../packages/shared/test/fixtures/contracts/guard-v2.js';
import type { LotAction, LotMetricsInput } from '../src/lot-input.js';
export const address = (n: number): Address => `0x${n.toString(16).padStart(40, '0')}`;
export const hash = (n: number): `0x${string}` => `0x${n.toString(16).padStart(64, '0')}`;
export const coin = address(1), principal = address(2), recipient = address(3), bot = address(4), quoteAsset = address(5), router = address(6);
export const at = (sec: number, ordinal?: number): GuardCursor => GuardCursorSchema.parse({ chainId: 4663,
  blockNumber: String(sec), blockHash: hash(sec), timestampSec: String(sec), transactionIndex: ordinal === undefined ? null : 0,
  executionOrdinal: ordinal ?? null, boundary: ordinal === undefined ? 'block_end' : 'after_tx' });
export const qty = (raw: string) => ({ asset: coin, decimals: 0, raw });
export function supply(cursor: GuardCursor, total = '1000000', float = '1000000') {
  const knownAt = { cursor: at(200000), acquisitionSequence: '1' };
  const metric = (id: Parameters<typeof observed>[0], value: unknown, unit = 'raw') => ({ ...observed(id, value, unit), cursor, knownAt,
    coverage: { ...sampleCoverage, from: at(1000), through: cursor } });
  return SupplySnapshotV2Schema.parse({ schemaVersion: 'supply-2', methodVersion: '2.0.0', capSemanticsVersion: '2.0.0', coin, cursor, knownAt,
    supply: { minted: metric('minted', qty(total)), total: metric('total', qty(total)), sinks: metric('sinks', qty('0')),
      locked: metric('locked', qty('0')), curveInventory: metric('curveInventory', qty((BigInt(total) - BigInt(float)).toString())),
      poolInventory: metric('poolInventory', qty('0')), circulating: metric('circulating', qty(float)), holderFloat: metric('holderFloat', qty(float)),
      burnedPct: unknown('burnedPct', 'pct'), holders: metric('holders', 0, 'count'), top10RawPct: unknown('topAddress10', 'pct'), rawTop10: [] },
    holdings: [], floatState: 'stable', check: { id: 'supply_float', tier: 'buy_critical', status: 'complete',
      coverage: { ...sampleCoverage, from: at(1000), through: cursor }, evidenceIds: [hash(1)], failureCode: null }, issues: [] });
}
export function fixture(now = 1100): LotMetricsInput {
  const cursor = at(now), knownAt = { cursor: at(200000), acquisitionSequence: '1' };
  const launch = resolveLaunchRolesV2({ coin, cursor, name: 'Sample token', symbol: 'DEMO', launchpad: 'pons', senders: [], exemptions: [],
    events: [{ ref: 'launch-fixture', block: '1000', logIndex: 0, txHash: hash(1), emitter: address(9), kind: 'launch',
      data: { token: coin, deployer: principal, curve: address(8), outerFrom: principal, outerTo: address(9), timestampSec: '1000' } },
    { ref: 'first-trade-fixture', block: '1001', logIndex: 1, txHash: hash(2), emitter: address(8), kind: 'trade',
      data: { token: coin, side: 1, timestampSec: '1001' } }] });
  return structuredClone({ coin, decimals: 0, cursor, knownAt, launch, quoteAsset, quoteDecimals: 0,
    coverage: { ...sampleCoverage, from: at(1000), through: cursor }, opening: [], actions: [], currentSupply: supply(cursor),
    supplyBoundaries: [supply(at(1000)), supply(at(1005)), supply(at(1006)), supply(at(1060)), supply(at(1300))].filter(s => BigInt(s.cursor.blockNumber) <= BigInt(cursor.blockNumber)),
    exemptComplete: true, creationSubtreeComplete: true, exclusions: [], completeDistributions: [] });
}
export function base(id: number, sec: number, ordinal = id) {
  return { id: hash(id), cursor: at(sec, ordinal), knownAt: { cursor: at(200000), acquisitionSequence: '1' },
    transactionId: hash(id + 1000), evidenceIds: [hash(id + 2000)], sourceIds: [`economic-leg-${id}`] };
}
export const buy = (id: number, sec: number, who: Address, units: string, cost: string | null = '10', payer = who): LotAction =>
  ({ ...base(id, sec), kind: 'buy', payer, recipient: who, delivered: units, quoteAsset, quoteDecimals: 0,
    quoteDebit: cost, creationSubtree: false });
export const sell = (id: number, sec: number, who: Address, units: string, net: string | null = '15'): LotAction =>
  ({ ...base(id, sec), kind: 'sell', seller: who, recipient: who, swapDebit: units, tokenFee: '0', quoteAsset,
    quoteDecimals: 0, grossQuote: net, netQuote: net, quoteFee: '0' });
export const transfer = (id: number, sec: number, from: Address, to: Address, units: string): LotAction =>
  ({ ...base(id, sec), kind: 'transfer', from, to, delivered: units, tokenFee: '0', distributionId: null, cexDeposit: false });
export const opening = (id: number, owner: Address, units: string, origin: Address | null = owner): GuardLot => ({
  id: hash(id), owner, origin, originAlternatives: [origin], acquiredAt: at(1000), units: qty(units), state: 'liquid', basis: null, basisPayer: null, evidenceIds: [hash(id + 2000)] });
