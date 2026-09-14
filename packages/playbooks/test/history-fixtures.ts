// Synthetic calibrated-status envelopes exercise pure arithmetic; they are not measured outcome evidence.
import type { Address, GuardCursor, GuardCoverage, GuardFactor, GuardHistoryAttribution, GuardHistoryInput, GuardHistorySource } from '@eko/shared';
import { OutcomeV2Schema } from '@eko/shared';
import { outcome as sampleOutcome, factor as sampleFactor, coverage as sampleCoverage } from '../../shared/test/fixtures/contracts/guard-v2.js';
export const address = (n: number): Address => `0x${n.toString(16).padStart(40, '0')}`;
export const hash = (n: number): `0x${string}` => `0x${n.toString(16).padStart(64, '0')}`;
export const NOW = 4000000, principal = address(2), actor = address(3), service = address(99);
export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
export const at = (sec: number, ordinal?: number): GuardCursor => ({ chainId: 4663, blockNumber: String(sec), blockHash: hash(sec),
  transactionIndex: ordinal === undefined ? null : 0, executionOrdinal: ordinal ?? null, timestampSec: String(sec),
  boundary: ordinal === undefined ? 'block_end' : 'after_tx' });
export const known = (sec: number, sequence = '1') => ({ cursor: at(sec), acquisitionSequence: sequence });
export const coverage = (from: number, through: number): GuardCoverage => ({ ...sampleCoverage, from: at(from), through: at(through) });
export const proof = (sec: number, who = principal): GuardHistoryAttribution => ({ operatorGroupId: hash(1), principal, actor: who,
  kind: who === principal ? 'authenticated_principal' : 'authenticated_control', effectiveFrom: at(sec - 1), effectiveThrough: null,
  knownAt: known(sec + 1), evidenceIds: [hash(sec)], loop: null });
export const factor = (id: GuardFactor['id'], family: GuardFactor['family'], points: number): GuardFactor =>
  ({ ...sampleFactor, id, family, eligiblePoints: points, assignedPoints: points } as GuardFactor);
export function fixture(count = 6, bad = 3): GuardHistoryInput & { source: GuardHistorySource; coin: Address } {
  const source: GuardHistorySource = {
    operator: { group: { id: hash(1), kind: 'control', memberIds: [principal, actor], edgeIds: [hash(2)], graphVersion: '2.0.0', supersedes: [] },
      principal, effectiveFrom: at(0), effectiveThrough: null, knownAt: known(1), serviceStatus: 'not_service', serviceAddresses: [service], evidenceIds: [hash(3)] },
    enumeration: { coverage: coverage(NOW - 2592000, NOW), knownAt: known(NOW) }, launches: [], assessments: [], outcomes: [],
  };
  for (let i = 0; i < count; i++) addLaunch(source, i, NOW - 20000 + i * 1000, i < bad ? 'dump' : 'survived');
  return clone({ coin: address(1), cursor: at(NOW), availabilityCut: known(NOW), mode: 'shadow', booster: 'shadow',
    baseScore: 30, factors: [factor('execution_cost', 'E', 10), factor('operator_hold', 'O', 20)], source });
}
export function addLaunch(source: GuardHistorySource, i: number, sec: number, kind: GuardHistorySource['outcomes'][number]['outcome']['kind']) {
  const id = hash(100 + i), coin = address(100 + i), entryCursor = at(sec), maturityCursor = at(sec + 3600), confirmationThrough = at(sec + 3630);
  source.launches.push({ coin, launchedAt: entryCursor, knownAt: known(sec + 1), attribution: proof(sec) });
  source.assessments.push({ id: hash(1000 + i), coin, entryCursor, maturityCursor, firstBoundaryAfterHorizon: true, confirmationThrough,
    canonicalRechecked: true, knownAt: known(sec + 3631), coverage: coverage(sec, sec + 3630), calibrated: true,
    outcomeVersion: '2.0.0', identityVersion: '2.0.0', outcomeIds: [id] });
  const eventSec = sec + 60;
  source.outcomes.push({ outcome: OutcomeV2Schema.parse({ ...sampleOutcome, id, coin, kind, status: 'confirmed_under_policy', horizonSec: 3600,
    entryCursor, maturityCursor, knownAt: known(sec + 3630), attribution: kind === 'survived' ? 'unknown' : 'operator',
    controller: { ...sampleOutcome.controller, cursor: at(eventSec), knownAt: known(sec + 3630), status: 'observed', value: principal,
      failureCode: null, coverage: coverage(sec, sec + 3630) }, coverage: coverage(sec, sec + 3600), supersedes: null }),
    eventCursor: at(eventSec), calibrated: true, outcomeVersion: '2.0.0', identityVersion: '2.0.0', attribution: proof(eventSec) });
}
