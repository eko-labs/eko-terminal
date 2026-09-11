// Offline schema/flow fixtures only; measured tags exercise trusted acquisition contracts, not real evidence.
import type { ActualOrderBinding, ActualOrderObservation, ActualOrderState, Policy, PreflightRequest } from '@eko/shared';
import { actualBindingHash, executionPolicyHash, type Deps } from '../src/index.js';
import { agent as legacyAgent, ASSET, deps as legacyDeps, NOW, policy, request as legacyRequest } from './fixtures.js';
import { cachedGuard } from './guard-fixtures.js';
export const h = `0x${'11'.repeat(32)}` as const;
export const wallet = `0x${'cd'.repeat(20)}` as const;
export const agent = { ...legacyAgent, wallet };
export const binding = (p: Policy = policy): ActualOrderBinding => ({ chainId: 4663, account: wallet, recipient: wallet, coin: ASSET,
  side: 'buy', amountIn: '10000000000000000000000000', minOut: '9900000000000000000000000', slippageBps: 100,
  cursor: cachedGuard().guardV2!.cursor, routeFingerprint: h, profileHash: h, stateFingerprint: h,
  policyHash: executionPolicyHash(p), guardReceiptId: cachedGuard().guardV2!.receipt.id,
  tx: { chainId: 4663, to: wallet, data: '0xab', value: '10000000000000000000000000' }, approval: null });
export function actualRequest(p: Policy = policy): PreflightRequest {
  const b = binding(p);
  return { ...legacyRequest, order: { ...legacyRequest.order, tx: { to: b.tx.to, data: b.tx.data, value: b.tx.value }, execution: b } };
}
export const stateFor = (b: ActualOrderBinding): ActualOrderState => ({ observedAtMs: NOW, criticalCheckedAtMs: NOW, cursor: b.cursor,
  routeFingerprint: b.routeFingerprint, profileHash: b.profileHash, stateFingerprint: b.stateFingerprint,
  balanceHash: h, feeHash: h, controlHash: h, sourceRevision: h, semanticHash: h,
  policyHash: b.policyHash, guardReceiptId: b.guardReceiptId, routeAvailable: true });
export const observationFor = (b: ActualOrderBinding): ActualOrderObservation => ({ binding: b, state: stateFor(b), quotedAtMs: NOW,
  refreshedAtMs: NOW, expiresAtMs: NOW + 15000, origin: 'measured', mode: b.side === 'buy' ? 'round_trip' : 'sell_only', accountClass: 'eoa',
  status: 'ok', spent: b.side === 'buy' ? b.amountIn : '0', returned: b.side === 'buy' ? (BigInt(b.amountIn) * 99n / 100n).toString() : b.minOut,
  notionalUsd: Number(BigInt(b.amountIn) / (10n ** 23n)), tokens: b.amountIn, heldBefore: b.amountIn, allowanceBefore: b.amountIn, entryNetworkFee: '0', exitNetworkFee: '0', depthUsdLower: 100000, evidenceIds: [h] });
export const request = actualRequest();
export const deps: Deps = { ...legacyDeps, guardPolicyV2: true, verdictFor: () => cachedGuard(),
  actualStateFor: stateFor, actualOrderFor: b => ({ status: 'ready', observation: observationFor(b) }) };
/** Tests of preset/approval ordering use the current policy hash, while mismatch tests bind explicitly. */
export function bindRequest(req: PreflightRequest, p: Policy): PreflightRequest {
  const b = { ...binding(p), side: req.order.side, amountIn: (BigInt(req.order.notionalUsd ?? 100) * 10n ** 23n).toString() };
  b.minOut = (BigInt(b.amountIn) * 99n / 100n).toString();
  b.tx = { ...b.tx, value: b.side === 'buy' ? b.amountIn : '0' };
  return { ...req, order: { ...req.order, execution: b, tx: { to: b.tx.to, data: b.tx.data, value: b.tx.value } } };
}
