// Synthetic migration/settlement/custody observations; no deployed graduation transaction is claimed.
import { GUARD_CAPABILITIES } from '@eko/shared';
import { assessPonsControlProfile, controlStateFingerprint, type PonsControlInput } from '../src/control-profile.js';
import type { GraduationInventoryInput } from '../src/graduation-inventory.js';
import { address, at, coin, curve, cursor, fixture as supplyFixture, hash, knownAt, proof, transfer } from './supply-fixtures.js';
export const manager = address(70), locker = address(80), successorId = hash(70), positionId = hash(80);
export function graduationFixture(): GraduationInventoryInput {
  const before = at(8), ids = [hash(100)];
  const pin = (n: number) => ({ status: 'verified' as const, address: address(n), codeHash: hash(n), evidenceIds: ids });
  const absent = { status: 'absent' as const, address: null, codeHash: null, evidenceIds: ids };
  const input: PonsControlInput = { schemaVersion: 'pons-control-input-2', origin: 'fixture', coin, decimals: 18, launchpad: 'pons', cursor: before, knownAt,
    pins: { token: pin(1), curve: pin(2), proxy: absent, implementation: pin(1), hook: pin(90), locker: pin(80), authorityHash: hash(20), authorityEvidenceIds: ids },
    configuration: { launchConfigId: '1', launchedAtSec: '1001', decayEndSec: '1002', decayPolicyHash: hash(21), feePolicyHash: hash(22),
      recipientScheduleHash: hash(23), configurationHash: hash(24), evidenceIds: ids },
    getters: { creatorTaxBps: '200', feeBps: '100', currentSnipeTaxBps: '0', launchedAtSec: '1001', evidenceIds: ids },
    permissionCoverageComplete: true, probes: [], charges: [], evidenceIds: ids };
  const stateFingerprint = controlStateFingerprint(input);
  input.probes = GUARD_CAPABILITIES.map(capability => ({ capability, stateFingerprint, authority: address(3), permissionPathHash: hash(30),
    boundCode: 'absent', bound: null, delaySec: '0', earliestExecutionSec: before.timestampSec, revocable: false, queued: false, releaseUnits: null,
    success: false, beforeHash: hash(40), afterHash: hash(40), transactionHash: hash(41), absenceReviewed: true, evidenceIds: ids }));
  for (const accountClass of ['eoa', 'smart_account'] as const) for (const direction of ['buy', 'sell'] as const)
    input.charges.push({ stateFingerprint, direction, accountClass, account: address(accountClass === 'eoa' ? 4 : 5), sizeQuoteUnits: '1000', quoteAsset: address(0),
      quoteDebitUnits: direction === 'buy' ? '1000' : '0', reserveDeltaUnits: direction === 'buy' ? '970' : '1000', quoteCreditUnits: direction === 'sell' ? '970' : '0',
      payouts: [{ recipient: address(6), units: '30' }], breakdown: { ordinary: null, creator: null, temporary: null, hook: null }, evidenceIds: ids });
  const profile = assessPonsControlProfile(input, { schemaVersion: 'pons-template-2', coin, origin: 'fixture', reviewed: true,
    stateFingerprint, sourceRevision: hash(60), evidenceIds: ids });
  const custody = { owner: locker, controller: address(3), locker, lockerCodeHash: hash(80), reviewed: true, revocable: false, unlockAtSec: '2000' };
  return structuredClone({ schemaVersion: 'graduation-input-1', origin: 'fixture', coin, cursor, knownAt, profile, routeDiscoveryComplete: true, inventoryCoverageComplete: true,
    migration: { ...proof, cursor: at(9), reviewed: true, transactionHash: hash(90), factory: address(7), factoryCodeHash: hash(7), sourceRevision: hash(60),
      oldCurve: curve, quoteAsset: address(0), successorPoolId: successorId, positionId, mintedLiquidity: '100', depositedTokens: '300', depositedQuote: '100', tokenPayouts: '0', quotePayouts: '5' },
    before: { ...proof, cursor: before, tokenInventory: '400', realQuoteReserve: '105', sellableTokens: '0', readyToGraduate: true },
    after: { ...proof, tokenInventory: '0', realQuoteReserve: '0', sellableTokens: '0', readyToGraduate: true },
    excess: { ...proof, address: locker, units: '100', custody },
    pools: [{ ...proof, id: successorId, manager, managerCodeHash: hash(70), token: coin, quoteAsset: address(0), hook: address(90), hookCodeHash: hash(90),
      venue: 'uniswap_v4', inventorySource: 'per_pool_settlement', tokenInventory: '300', quoteInventory: '100',
      tokenFees: '0', quoteFees: '0', settlementReviewed: true, positionsComplete: true, migrationCredit: { transactionHash: hash(90), tokens: '300', quote: '100' },
      tickSpacing: 60, currentTick: 0, activeLiquidity: '100', ticks: [{ tick: -887220, liquidityNet: '100' }, { tick: 887220, liquidityNet: '-100' }],
      positions: [{ id: positionId, poolId: successorId, lowerTick: -887220, upperTick: 887220, liquidity: '100', custody, evidenceIds: ids }],
      exit: { status: 'executed', buyerReachable: true, accountClass: 'eoa', sizeUsd: 100, tokenInput: '10', netQuoteOutput: '3', evidenceIds: ids } }] });
}
export function graduatedSupplyFixture() {
  const input = supplyFixture(); input.inventory.stage = 'graduated'; input.inventory.curveOnly = false;
  input.inventory.graduation = graduationFixture();
  input.transfers.push(transfer(3, curve, manager, '300', 9), transfer(4, curve, locker, '100', 9));
  return input;
}
