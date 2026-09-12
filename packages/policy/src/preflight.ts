import type { Agent, Approval, CoinCard, Policy, PreflightRequest, PreflightResult, Verdict } from '@eko/shared';
import { applyPreset } from './presets.js';
import { daysUntil, exitCostAt, normalizeInstrument, notionalOf } from './helpers.js';
import type { Prices } from './helpers.js';
import { orderHash } from './canonical.js';
import { guardBuyGate } from './guard.js';
import { actualOrderGate, actualNotionalOf, type ActualOrderDeps } from './actual-order.js';
import { CHAIN_ID } from '@eko/shared';

export type Evaluation = Pick<PreflightResult, 'decision' | 'reasons' | 'senses' | 'guardPolicyVersion'>;
export interface Deps extends Prices, ActualOrderDeps {
  /** TODO(spec): deployment flag name is unspecified. Use this same trusted switch for settings and evaluation; defaults off. */
  guardPolicyV2?: boolean;
  blueChipEnabled?: boolean;
  blueChipFor?(asset: string): boolean;
  now(): number;
  verdictFor(asset: string): Verdict | 'unavailable' | undefined;
  cardFor(asset: string): CoinCard | undefined;
  /** Return only the approval bound to all three lookup keys. Expiry is reflected in status (§9.7). */
  approvalFor(agentId: string, clientOrderRef: string, hash: `0x${string}`): Approval | undefined;
  approvalsAvailable: boolean;
  /** Trusted host replacement for the Guard v2 buy gate (guard.ts), used by live trade admission while no Guard v2
   * release is active. Absent: `guardBuyGate`. The actual-order gate, policy limits and approvals still apply. */
  buyVerdictGate?(verdict: Verdict | undefined, policy: Policy, asset: string, chainId: number, requestClockMs: number): { deny: string[]; warn: string[] };
}

/** BACKEND §9.6, in its specified evaluation order. All dependencies are in-memory.
 * @remarks
 * Evaluate advisory policy in order with kill/inactive agent first, active-input denials,
 * deliberate sell-exit exceptions and approvals bound to agent/reference/full order hash. Trusted
 * caller binds authenticated agent and supplies in-memory dependencies; no I/O or signing occurs.
 * Returns deny/needs_approval/allow; schema/dependency errors can throw. Guard v2 adds exact
 * actual-account evidence gates when enabled.
 * @see {@link ../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../docs/security/INVARIANTS.md | Guard, policy and approval invariants}
 */
export function evaluate(req: PreflightRequest, policy: Policy, agent: Agent, d: Deps): Evaluation {
  const result = evaluatePolicy(req, policy, agent, d);
  return d.guardPolicyV2 ? { ...result, guardPolicyVersion: 2 } : result;
}

function evaluatePolicy(req: PreflightRequest, policy: Policy, agent: Agent, d: Deps): Evaluation {
  const p = applyPreset(policy, d.guardPolicyV2);
  const deny: string[] = [], warn: string[] = [];
  const o = req.order, buying = o.side === 'buy';
  const asset = normalizeInstrument(o.venue, o.instrument);

  if (p.killed || agent.status !== 'active') return { decision: 'deny', reasons: ['killed: your owner stopped this agent. Place no orders and tell the human.'] };
  const now = d.now();
  const age = req.context ? now - Date.parse(req.context.reportedAt) : Infinity;
  if (buying && age > 300_000) (p.mode === 'safe' ? deny : warn).push('stale_context: positions and cash are older than 5 minutes');
  if (p.blockAssets?.includes(asset)) deny.push(`blocked_asset: ${asset} is on your block list`);
  if (buying && p.allowAssets?.length && !p.allowAssets.includes(asset)) deny.push(`not_allowed: ${asset} is not on your allow list`);

  if (buying && p.blueChipsOnly && d.blueChipEnabled && (o.venue === 'rhc' || o.venue === 'base') &&
      (o.venue !== 'rhc' || d.blueChipFor?.(asset) !== true))
    deny.push('blue_chips_only: this coin is not a Blue chip member');

  let verdict: Verdict | undefined;
  if (buying && (o.venue === 'rhc' || o.venue === 'base')) {
    const v = d.verdictFor(asset);
    if (v === 'unavailable') deny.push('sim_unavailable: simulation is down, so on-chain buys are refused');
    else if (d.guardPolicyV2) {
      verdict = v;
      const gate = (d.buyVerdictGate ?? guardBuyGate)(v, p, asset, o.venue === 'rhc' ? CHAIN_ID : 8453, now);
      deny.push(...gate.deny);
      warn.push(...gate.warn);
    }
    else if (!v || v.level === 'pending') {
      verdict = v;
      deny.push("scan_pending: EKO hasn't finished checking this coin; retry shortly");
    }
    else {
      verdict = v;
      if (v.playbooks.some((m) => m.id === 'honeypot' && m.level === 'danger')) deny.push('honeypot: the sell simulation fails');
      else if (v.level === 'danger' && p.blockPlaybookLevel) deny.push(`playbook_danger: ${v.reasons[0]}`);
      else if (v.level === 'monitor' && p.blockPlaybookLevel === 'monitor') deny.push(`playbook_monitor: ${v.reasons[0]}`);
    }
    // Legacy replay remains compatible; V2 uses exact actual-account execution observations.
    if (!d.guardPolicyV2 && v && v !== 'unavailable' && v.level !== 'pending') {
      const card = d.cardFor(asset);
      if (p.minLiquidityUsd !== undefined && p.minLiquidityUsd > 0) {
        if (!card || card.meta?.liquidity?.unavailable) deny.push('liquidity_unavailable');
        else if (card.meta?.liquidity?.missing?.some(field => ['depthUsd', 'depth', 'pct2', 'depthUsd.pct2'].includes(field))) deny.push('depth_unavailable');
        else if (card.liquidity.depthUsd.pct2 < p.minLiquidityUsd) deny.push('thin_liquidity: ±2% depth below your minimum');
      }
      if (p.maxRoundTripCostPct !== undefined) {
        const gaps = card?.meta?.tradeability?.missing ?? [];
        if (!card || card.meta?.tradeability?.unavailable || gaps.some(field => ['exitCosts', 'exitCostPct', 'simulations'].includes(field) || field.startsWith('exitCostPct.'))) deny.push('exit_cost_unavailable');
        else if (gaps.some(field => ['taxes', 'buyTaxPct', 'sellTaxPct'].includes(field))) deny.push('taxes_unavailable');
        else if (exitCostAt(card, notionalOf(o, d)) > p.maxRoundTripCostPct) deny.push('round_trip_cost: exit cost above your maximum');
      }
    }
  }
  if (d.guardPolicyV2 && (o.venue === 'rhc' || o.venue === 'base'))
    deny.push(...actualOrderGate(req, policy, agent, d, now, verdict));
  const notional = d.guardPolicyV2 && (o.venue === 'rhc' || o.venue === 'base') ? actualNotionalOf(req, d) : notionalOf(o, d);
  if (buying && notional === undefined) deny.push('missing_notional: send notionalUsd, or qty with limitPrice');
  if (buying && notional !== undefined) {
    const held = req.context?.positions?.find((x) => normalizeInstrument(o.venue, x.instrument) === asset)?.valueUsd ?? 0;
    const equity = (req.context?.cashUsd ?? 0) + (req.context?.positions ?? []).reduce((s, x) => s + x.valueUsd, 0);
    if (p.maxPositionUsd !== undefined && held + notional > p.maxPositionUsd) deny.push('position_cap: above your max position (USD)');
    if (p.maxPositionPct !== undefined && equity > 0 && (held + notional) / equity * 100 > p.maxPositionPct) deny.push('position_pct: above your max position (% of equity)');
  }
  if (buying && p.maxDailyLossUsd !== undefined && (req.context?.dailyPnlUsd ?? 0) <= -p.maxDailyLossUsd) deny.push('daily_loss: daily loss limit reached; only sells are allowed');
  if (buying && p.earningsBlackoutDays && req.context?.earningsDate && daysUntil(req.context.earningsDate, now) <= p.earningsBlackoutDays) deny.push('earnings_blackout: inside your earnings blackout');
  if (o.leverage && p.maxLeverage !== undefined && o.leverage > p.maxLeverage) deny.push('leverage: above your max leverage');
  if (deny.length) return { decision: 'deny', reasons: [...deny, ...warn], senses: { verdict } };

  if (buying && p.approvalAboveUsd !== undefined && (notional ?? Infinity) > p.approvalAboveUsd) {
    const a = d.approvalFor(agent.id, req.clientOrderRef, orderHash(o));
    if (a?.status === 'approved') return { decision: 'allow', reasons: ['approved: your owner approved this order', ...warn], senses: { verdict } };
    if (a?.status === 'denied' || a?.status === 'expired')
      return { decision: 'deny', reasons: [`approval_${a.status}: your owner did not approve this order`], senses: { verdict } };
    if (!a && !d.approvalsAvailable)
      return { decision: 'deny', reasons: ['approval_unavailable: this order is above your approval limit and approvals are not available on this plan; place a smaller order or ask the human to raise the limit', ...warn], senses: { verdict } };
    return { decision: 'needs_approval', reasons: ['approval_required: above your approval limit; wait for the human', ...warn], senses: { verdict } };
  }
  return { decision: 'allow', reasons: warn, senses: { verdict } };
}
