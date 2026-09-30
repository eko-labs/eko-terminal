// Synthetic accounting fixtures, not chain measurements or calibration evidence.
import { GuardCursorSchema } from '@eko/shared';
import type { Address } from '@eko/shared';
import { resolveLaunchRolesV2 } from '@eko/chain';
import type { SupplyBasicsInput } from '../src/supply-v2.js';

export const address = (n: number): Address => `0x${n.toString(16).padStart(40, '0')}`;
export const hash = (n: number): `0x${string}` => `0x${n.toString(16).padStart(64, '0')}`;
export const coin = address(1), curve = address(2), holder = address(3), second = address(4), sink = address(5), live = address(6);
export const at = (block: number) => GuardCursorSchema.parse({ chainId: 4663, blockNumber: String(block), blockHash: hash(block),
  timestampSec: String(1000 + block), transactionIndex: null, executionOrdinal: null, boundary: 'block_end' });
export const cursor = at(10), knownAt = { cursor, acquisitionSequence: '1' };
export const proof = { cursor, knownAt, evidenceIds: [hash(1)] };
export const coverage = { scopeId: 'fixture-supply', from: at(1), through: cursor, complete: true, gaps: [],
  methodVersion: '2.0.0', coveredUnits: null, excludedUnits: null, sourceHashes: [hash(1)],
  topLevelNative: false, internalNative: false, firstEverEstablished: false };
export function transfer(id: number, from: Address, to: Address, amount: string, block = 2): SupplyBasicsInput['transfers'][number] {
  return { ...proof, id: `transfer-${id}`, cursor: at(block), from, to, amount };
}
export function fixture(): SupplyBasicsInput {
  const launch = resolveLaunchRolesV2({ coin, cursor, name: 'Sample token', symbol: 'DEMO', launchpad: 'pons', senders: [], exemptions: [],
    events: [{ ref: 'synthetic-launch', block: '1', logIndex: 0, txHash: hash(1), emitter: address(7), kind: 'launch',
      data: { token: coin, deployer: holder, curve, timestampSec: '1001', outerFrom: holder, outerTo: address(7) } }] });
  return structuredClone({ coin, decimals: 18, cursor, knownAt, launch, fromDeployment: true, semantics: 'standard_erc20',
    transfers: [transfer(1, address(0), curve, '1000', 1), transfer(2, curve, holder, '600')],
    transferCoverage: coverage, classificationCoverage: coverage, sinks: [], locks: [],
    inventory: { ...proof, stage: 'curve', curve, curveOnly: true }, totalSupplyRead: { ...proof, total: '1000' } });
}
