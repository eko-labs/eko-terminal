import { ActualOrderBindingSchema, canonicalize, type ActualOrderBinding, type ActualOrderState,
  type Policy, type PreflightRequest, type Verdict, type Agent, type ActualOrderLookup } from '@eko/shared';
import { keccak256, stringToHex } from 'viem';
import { applyPreset } from './presets.js';
import { normalizeInstrument } from './helpers.js';
import { CHAIN_ID } from '@eko/shared';

export const QUOTE_MAX_AGE_MS = 15_000;
export const QUOTE_REFRESH_MS = 5_000;
export const GUARD_MAX_AGE_MS = 30_000;
/**
 * Hash the complete supplied actual-order binding with canonical hashing. Pure trusted-input
 * operation without wallet auth; canonicalization errors throw and input is not schema-validated
 * here.
 * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../docs/security/INVARIANTS.md | Guard, policy and approval invariants}
 */
export const actualBindingHash = (binding: ActualOrderBinding) => keccak256(stringToHex(canonicalize(binding)));
/**
 * Hash the effective Guard-v2 preset policy including explicit overrides using canonical keccak
 * encoding. Pure trusted-input operation without wallet auth; projection/canonicalization failures
 * throw and no policy edit is authorized.
 * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../docs/security/INVARIANTS.md | Guard, policy and approval invariants}
 */
export const executionPolicyHash = (policy: Policy) => keccak256(stringToHex(canonicalize(applyPreset(policy, true))));
/** Wall clocks are deliberately excluded: an unchanged new head need not invalidate dependent state.
 * @remarks
 * Hash chain id plus selected route/profile/state/balance/fee/control/source/semantic/policy/Guard
 * fingerprints and route availability. Pure trusted-input operation without auth; wall clocks and
 * block number/hash are excluded. Malformed/canonicalization errors throw and no state is acquired
 * here.
 * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../docs/security/INVARIANTS.md | Guard, policy and approval invariants}
 */
export const actualStateHash = (state: ActualOrderState) => keccak256(stringToHex(canonicalize({
  chainId: state.cursor.chainId, routeFingerprint: state.routeFingerprint, profileHash: state.profileHash,
  stateFingerprint: state.stateFingerprint, balanceHash: state.balanceHash, feeHash: state.feeHash,
  controlHash: state.controlHash, sourceRevision: state.sourceRevision, semanticHash: state.semanticHash,
  policyHash: state.policyHash, guardReceiptId: state.guardReceiptId, routeAvailable: state.routeAvailable,
})));
export interface ActualOrderDeps {
  actualOrderFor?(binding: ActualOrderBinding): ActualOrderLookup;
  actualStateFor?(binding: ActualOrderBinding): ActualOrderState | undefined;
  /**
   * Trusted host statement that the bound bytes trade a venue whose liquidity cannot be removed (owner decisions
   * 2026-10-06): an open bonding curve (its price is deterministic), or a launchpad graduation pool whose position is
   * proven locked at the block. The ±2% depth floor (`minLiquidityUsd`) does not apply to it; the exact measured
   * round-trip cost against `maxRoundTripCostPct`, the sell check and the per-trade simulation still do. Absent or
   * false: an ordinary pool, and every depth floor applies.
   */
  lockedLiquidityRoute?(binding: ActualOrderBinding): boolean;
}
const fresh = (at: number, now: number, max: number) => Number.isSafeInteger(at) && at >= 0 && at <= now && now - at <= max;
const raw = (value: string, positive = false) => value.length <= 78 && /^(0|[1-9]\d*)$/.test(value) && BigInt(value) >= (positive ? 1n : 0n) && BigInt(value) < 2n ** 256n;

/** Pure cached check. No interpolation, acquisition, request clock reads, or idempotent replay here.
 * @remarks
 * Require schema-bound exact order/account/policy/Guard/current-state evidence, freshness and
 * accepted observation metrics before permitting v2 execution. Trusted caller authenticates agent
 * and dependencies; no I/O or signing. Missing/mismatched/unavailable evidence returns denial
 * reasons; invalid unchecked dependencies may throw.
 * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../docs/security/INVARIANTS.md | Guard, policy and approval invariants}
 */
export function actualOrderGate(req: PreflightRequest, policy: Policy, agent: Agent, d: ActualOrderDeps,
  now: number, verdict?: Verdict): string[] {
  const parsed = ActualOrderBindingSchema.safeParse(req.order.execution);
  if (!parsed.success) return ['actual_order_binding_missing'];
  const b = parsed.data, buying = req.order.side === 'buy';
  const chainId = req.order.venue === 'rhc' ? CHAIN_ID : 8453;
  if (b.chainId !== chainId || b.coin !== normalizeInstrument(req.order.venue, req.order.instrument) ||
    b.side !== req.order.side || !agent.wallet || b.account !== agent.wallet.toLowerCase() ||
    req.agentId !== agent.id || !req.order.tx || canonicalize(req.order.tx) !== canonicalize({ to: b.tx.to, data: b.tx.data, value: b.tx.value }))
    return ['actual_order_binding_mismatch'];
  if (b.policyHash !== executionPolicyHash(policy)) return ['execution_policy_changed'];
  const state = d.actualStateFor?.(b);
  if (!state) return ['actual_state_unavailable'];
  if (!state.routeAvailable) return [buying ? 'buy_route_unavailable' : 'sell_route_unavailable'];
  if (state.policyHash !== b.policyHash || state.guardReceiptId !== b.guardReceiptId ||
    state.cursor.chainId !== b.chainId || state.cursor.boundary !== 'block_end' ||
    !fresh(state.observedAtMs, now, QUOTE_REFRESH_MS) || !fresh(state.criticalCheckedAtMs, now, QUOTE_REFRESH_MS) ||
    !fresh(Number(BigInt(state.cursor.timestampSec) * 1000n), now, GUARD_MAX_AGE_MS)) return ['critical_state_stale'];
  if (state.cursor.blockNumber === b.cursor.blockNumber && state.cursor.blockHash !== b.cursor.blockHash) return ['actual_order_state_changed'];
  if (state.routeFingerprint !== b.routeFingerprint || state.profileHash !== b.profileHash ||
    state.stateFingerprint !== b.stateFingerprint) return ['actual_order_state_changed'];
  if (buying && verdict?.guardV2 && verdict.guardV2.receipt.id !== b.guardReceiptId) return ['guard_receipt_changed'];
  const lookup = d.actualOrderFor?.(b);
  if (!lookup) return ['actual_order_quote_queued'];
  if (lookup.status !== 'ready') return [`${lookup.status === 'queued' ? 'actual_order_quote_queued' : 'actual_order_quote_unavailable'}: ${lookup.code}`];
  const q = lookup.observation;
  if (actualBindingHash(q.binding) !== actualBindingHash(b) || actualStateHash(q.state) !== actualStateHash(state))
    return ['actual_order_state_changed'];
  if (!fresh(q.quotedAtMs, now, QUOTE_MAX_AGE_MS) || !Number.isSafeInteger(q.expiresAtMs) ||
    q.expiresAtMs > q.quotedAtMs + QUOTE_MAX_AGE_MS || now > q.expiresAtMs) return ['quote_expired'];
  if (!fresh(q.refreshedAtMs, now, QUOTE_REFRESH_MS) || q.refreshedAtMs < q.quotedAtMs) return ['quote_refresh_required'];
  if (q.origin !== 'measured' || q.status !== 'ok' || !q.evidenceIds.length ||
    !q.evidenceIds.every(id => /^0x[0-9a-f]{64}$/i.test(id)) ||
    q.mode !== (buying ? 'round_trip' : 'sell_only')) return ['actual_order_simulation_unavailable'];
  if (![q.spent, q.returned, q.tokens, q.heldBefore, q.allowanceBefore, q.entryNetworkFee, q.exitNetworkFee].every(v => raw(v)) ||
    !raw(q.returned, true) || !raw(q.tokens, true) || buying && !raw(q.spent, true)) return ['actual_order_amounts_invalid'];
  if (buying && BigInt(q.spent) > BigInt(b.amountIn) || !buying && (BigInt(q.heldBefore) < BigInt(b.amountIn) ||
    q.tokens !== b.amountIn || q.spent !== '0')) return ['actual_order_amounts_invalid'];
  if (buying ? BigInt(q.spent) * BigInt(b.minOut) > BigInt(b.amountIn) * BigInt(q.tokens) : BigInt(q.returned) < BigInt(b.minOut)) return ['actual_order_slippage_exceeded'];
  const quotedOutput = buying ? BigInt(q.tokens) : BigInt(q.returned);
  if (BigInt(b.minOut) < quotedOutput * BigInt(10000 - b.slippageBps) / 10000n) return ['actual_order_slippage_mismatch'];
  if (!Number.isFinite(q.notionalUsd) || q.notionalUsd <= 0) return ['actual_order_valuation_unavailable'];
  if (!buying) return [];
  const reasons: string[] = [], p = applyPreset(policy, true);
  // A curve or a proven-locked graduation pool is judged by its exact round-trip cost below, not by depth.
  const locked = d.lockedLiquidityRoute?.(b) === true;
  if (!locked && p.minLiquidityUsd !== undefined && p.minLiquidityUsd > 0) {
    if (q.depthUsdLower === null || !Number.isFinite(q.depthUsdLower) || q.depthUsdLower < 0) reasons.push('depth_unavailable');
    else if (q.depthUsdLower < p.minLiquidityUsd) reasons.push('thin_liquidity: ±2% depth below your minimum');
  }
  if (p.maxRoundTripCostPct !== undefined) {
    // Compare the exact signed venue ratio against the owner's decimal ceiling. Gas is separate.
    const text = String(p.maxRoundTripCostPct);
    const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(text);
    if (!match) reasons.push('exit_cost_unavailable');
    else {
      const exponent = Number(match[4] ?? 0) - (match[3]?.length ?? 0);
      const numerator = BigInt(`${match[1]}${match[2]}${match[3] ?? ''}`) * (exponent > 0 ? 10n ** BigInt(exponent) : 1n);
      const denominator = exponent < 0 ? 10n ** BigInt(-exponent) : 1n;
      if ((BigInt(q.spent) - BigInt(q.returned)) * 100n * denominator > BigInt(q.spent) * numerator)
        reasons.push('round_trip_cost: exit cost above your maximum');
    }
  }
  return reasons;
}

/** Use acquisition's pinned valuation for exposure and approval limits, never caller-supplied USD.
 * @remarks
 * Read positive finite notional from a ready observation returned for the request's execution
 * binding, or undefined. Trusted caller supplies cached dependency data; this helper does not
 * itself validate observation binding/state/freshness (actualOrderGate owns those checks).
 * Dependency failures may throw.
 * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../docs/security/INVARIANTS.md | Guard, policy and approval invariants}
 */
export function actualNotionalOf(req: PreflightRequest, d: ActualOrderDeps): number | undefined {
  const b = req.order.execution;
  if (!b) return undefined;
  const q = d.actualOrderFor?.(b);
  return q?.status === 'ready' && Number.isFinite(q.observation.notionalUsd) && q.observation.notionalUsd > 0
    ? q.observation.notionalUsd : undefined;
}
