import { describe, expect, it, vi } from 'vitest';
import type { Agent, CoinCard, Policy, PreflightRequest } from '@eko/shared';
import { applyPreset, evaluate, orderHash, PRESETS } from '../src/index.js';
import type { Deps } from '../src/index.js';
import { agent, approval, ASSET, card, deps, NOW, policy, request, verdict } from './fixtures.js';

const stale = { ...request.context!, reportedAt: new Date(NOW - 300_001).toISOString() };
const large = { ...request, order: { ...request.order, notionalUsd: 2_001 } };
const codes = (reasons: string[]) => reasons.map((reason) => reason.split(':')[0]);

describe('presets (§9.6)', () => {
  it('matches every table value, with no approval threshold for Degen', () => {
    expect(PRESETS).toEqual({
      safe: { blockPlaybookLevel: 'monitor', maxRoundTripCostPct: 5, minLiquidityUsd: 50_000, approvalAboveUsd: 500, maxLeverage: 1, earningsBlackoutDays: 2 },
      balanced: { blockPlaybookLevel: 'danger', maxRoundTripCostPct: 10, minLiquidityUsd: 10_000, approvalAboveUsd: 2_000, maxLeverage: 3, earningsBlackoutDays: 1 },
      degen: { blockPlaybookLevel: 'danger', maxRoundTripCostPct: 25, minLiquidityUsd: 2_000, maxLeverage: 5, earningsBlackoutDays: 0 },
    });
    expect(applyPreset({ mode: 'degen', killed: false, version: 1 }).approvalAboveUsd).toBeUndefined();
    expect(evaluate(large, { ...policy, mode: 'degen' }, agent, deps).decision).toBe('allow');
  });
  it('fills only unset values without mutating the input', () => {
    const input = { mode: 'safe' as const, killed: false, version: 4, blockPlaybookLevel: null,
      approvalAboveUsd: 0, earningsBlackoutDays: 0, minLiquidityUsd: undefined, allowAssets: [] };
    const before = { ...input, allowAssets: [...input.allowAssets] };
    expect(applyPreset(input)).toEqual({ ...PRESETS.safe, ...input, minLiquidityUsd: 50_000 });
    expect(input).toEqual(before);
    expect(applyPreset({ ...policy, approvalAboveUsd: 321 }).approvalAboveUsd).toBe(321);
  });
});

describe('evaluation reasons and exact text (§9.6)', () => {
  const cases: { text: string; req?: PreflightRequest; p?: Partial<Policy>; d?: Partial<Deps>; a?: Partial<Agent> }[] = [
    { text: 'killed: your owner stopped this agent. Place no orders and tell the human.', p: { killed: true } },
    { text: 'stale_context: positions and cash are older than 5 minutes', req: { ...request, context: stale }, p: { mode: 'safe' } },
    { text: `blocked_asset: ${ASSET} is on your block list`, p: { blockAssets: [ASSET] } },
    { text: `not_allowed: ${ASSET} is not on your allow list`, p: { allowAssets: ['other'] } },
    { text: 'sim_unavailable: simulation is down, so on-chain buys are refused', d: { verdictFor: () => 'unavailable' } },
    { text: "scan_pending: EKO hasn't finished checking this coin; retry shortly", d: { verdictFor: () => undefined } },
    { text: 'honeypot: the sell simulation fails', d: { verdictFor: () => ({ ...verdict, playbooks: [{ id: 'honeypot', level: 'danger', confidence: 1, evidence: [] }] }) } },
    { text: 'playbook_danger: fixture risk', d: { verdictFor: () => ({ ...verdict, level: 'danger' }) } },
    { text: 'playbook_monitor: fixture risk', p: { mode: 'safe', blockPlaybookLevel: 'monitor' }, d: { verdictFor: () => ({ ...verdict, level: 'monitor' }) } },
    { text: 'thin_liquidity: ±2% depth below your minimum', p: { minLiquidityUsd: 100_001 } },
    { text: 'round_trip_cost: exit cost above your maximum', p: { maxRoundTripCostPct: 0.9 } },
    { text: 'missing_notional: send notionalUsd, or qty with limitPrice', req: { ...request, order: { ...request.order, notionalUsd: undefined } } },
    { text: 'position_cap: above your max position (USD)', p: { maxPositionUsd: 99 } },
    { text: 'position_pct: above your max position (% of equity)', p: { maxPositionPct: 0.9 } },
    { text: 'daily_loss: daily loss limit reached; only sells are allowed', p: { maxDailyLossUsd: 100 }, req: { ...request, context: { ...request.context!, dailyPnlUsd: -100 } } },
    { text: 'earnings_blackout: inside your earnings blackout', req: { ...request, context: { ...request.context!, earningsDate: '2026-10-02' } } },
    { text: 'leverage: above your max leverage', req: { ...request, order: { ...request.order, leverage: 4 } } },
  ];
  it.each(cases)('$text', ({ text, req, p, d, a }) => {
    expect(evaluate(req ?? request, { ...policy, ...p }, { ...agent, ...a }, { ...deps, ...d })).toMatchObject({ decision: 'deny', reasons: [text] });
  });

  it.each(['soft_killed', 'disconnected'] as const)('stops a %s agent', (status) => {
    expect(codes(evaluate(request, policy, { ...agent, status }, deps).reasons)).toEqual(['killed']);
  });
  it('kill wins over all checks without consulting dependencies', () => {
    const noLookup = vi.fn(() => { throw new Error('unexpected lookup'); });
    const result = evaluate({ ...request, context: stale }, { ...policy, killed: true, blockAssets: [ASSET] }, agent,
      { ...deps, now: noLookup, verdictFor: noLookup, cardFor: noLookup, priceFor: noLookup, approvalFor: noLookup });
    expect(codes(result.reasons)).toEqual(['killed']);
    expect(noLookup).not.toHaveBeenCalled();
  });
  it('collects all deny reasons in order, then warnings, and never consults approvals', () => {
    const lookup = vi.fn(deps.approvalFor);
    const result = evaluate({ ...large, order: { ...large.order, leverage: 4 }, context: { ...stale,
      positions: [{ instrument: ASSET.toUpperCase(), qty: 1, valueUsd: 1_000 }], dailyPnlUsd: -100, earningsDate: '2026-10-02' } },
    { ...policy, blockAssets: [ASSET], allowAssets: ['other'], minLiquidityUsd: 100_001,
      maxRoundTripCostPct: 0, maxPositionUsd: 2_500, maxPositionPct: 20, maxDailyLossUsd: 100 }, agent,
    { ...deps, verdictFor: () => ({ ...verdict, level: 'danger' }), approvalFor: lookup });
    expect(result.decision).toBe('deny');
    expect(codes(result.reasons)).toEqual(['blocked_asset', 'not_allowed', 'playbook_danger', 'thin_liquidity',
      'round_trip_cost', 'position_cap', 'position_pct', 'daily_loss', 'earnings_blackout', 'leverage', 'stale_context']);
    expect(result.senses?.verdict?.level).toBe('danger');
    expect(lookup).not.toHaveBeenCalled();
  });
  it.each(['safe', 'balanced', 'degen'] as const)('denies honeypots in %s with playbook blocking disabled', (mode) => {
    const result = evaluate(request, { ...policy, mode, blockPlaybookLevel: null }, agent, { ...deps,
      verdictFor: () => ({ ...verdict, level: 'danger', playbooks: [{ id: 'honeypot', level: 'danger', confidence: 1, evidence: [] }] }) });
    expect(codes(result.reasons)).toEqual(['honeypot']);
  });
  it.each(['rhc', 'base'] as const)('checks senses on %s, and skips them on non-chain venues', (venue) => {
    expect(codes(evaluate({ ...request, order: { ...request.order, venue } }, policy, agent, { ...deps, verdictFor: () => undefined }).reasons)).toEqual(['scan_pending']);
    const lookup = vi.fn(deps.verdictFor);
    for (const other of ['robinhood', 'perp'] as const) {
      expect(evaluate({ ...request, order: { ...request.order, venue: other, instrument: 'nvda' } }, policy, agent, { ...deps, verdictFor: lookup }).decision).toBe('allow');
    }
    expect(lookup).not.toHaveBeenCalled();
  });
  it('allows sells under daily-loss stops and skips freshness, allowlist, senses, size, earnings and approval', () => {
    const lookup = vi.fn(deps.verdictFor);
    const sell = { ...request, order: { ...request.order, side: 'sell' as const, notionalUsd: undefined }, context: { ...stale, dailyPnlUsd: -1_000, earningsDate: '2026-10-01' } };
    const stopped = { ...policy, mode: 'safe' as const, maxDailyLossUsd: 100, maxPositionUsd: 0, maxPositionPct: 0, approvalAboveUsd: 0, allowAssets: ['other'] };
    expect(evaluate(sell, stopped, agent, { ...deps, verdictFor: lookup })).toMatchObject({ decision: 'allow', reasons: [] });
    expect(lookup).not.toHaveBeenCalled();
    expect(codes(evaluate(sell, { ...stopped, blockAssets: [ASSET] }, agent, deps).reasons)).toEqual(['blocked_asset']);
    expect(codes(evaluate(sell, { ...stopped, killed: true }, agent, deps).reasons)).toEqual(['killed']);
    expect(codes(evaluate({ ...sell, order: { ...sell.order, leverage: 4 } }, policy, agent, deps).reasons)).toEqual(['leverage']);
  });
  it.each(['safe', 'balanced', 'degen'] as const)('handles missing/stale context for %s and accepts exactly 5 minutes', (mode) => {
    for (const context of [undefined, stale]) {
      const result = evaluate({ ...request, context }, { ...policy, mode }, agent, deps);
      expect(result.decision).toBe(mode === 'safe' ? 'deny' : 'allow');
      expect(codes(result.reasons)).toEqual(['stale_context']);
    }
    expect(evaluate({ ...request, context: { ...stale, reportedAt: new Date(NOW - 300_000).toISOString() } }, { ...policy, mode }, agent, deps).reasons).toEqual([]);
  });
  it('accepts exact limits and uses held exposure, cash and all positions for equity', () => {
    const req = { ...request, order: { ...request.order, leverage: 3 }, context: { ...request.context!, cashUsd: 800,
      positions: [{ instrument: ASSET.toUpperCase(), qty: 1, valueUsd: 100 }, { instrument: 'OTHER', qty: 1, valueUsd: 100 }] } };
    expect(evaluate(req, { ...policy, maxPositionUsd: 200, maxPositionPct: 20, minLiquidityUsd: 100_000, maxRoundTripCostPct: 1 }, agent, deps).decision).toBe('allow');
    expect(codes(evaluate(req, { ...policy, maxPositionUsd: 199, maxPositionPct: 19 }, agent, deps).reasons)).toEqual(['position_cap', 'position_pct']);
  });
});

describe('approval flows (§9.6–9.7)', () => {
  it.each([
    ['approved', 'allow', 'approved: your owner approved this order'],
    ['denied', 'deny', 'approval_denied: your owner did not approve this order'],
    ['expired', 'deny', 'approval_expired: your owner did not approve this order'],
    ['pending', 'needs_approval', 'approval_required: above your approval limit; wait for the human'],
  ] as const)('%s → %s', (status, decision, reason) => {
    const lookup = vi.fn(() => ({ ...approval, status }));
    const result = evaluate(large, policy, agent, { ...deps, approvalFor: lookup });
    expect(result).toMatchObject({ decision, reasons: [reason] });
    expect(lookup).toHaveBeenCalledExactlyOnceWith(agent.id, large.clientOrderRef, orderHash(large.order));
  });
  it('denies unavailable approvals immediately with the exact text', () => {
    expect(evaluate(large, policy, agent, { ...deps, approvalsAvailable: false })).toMatchObject({ decision: 'deny',
      reasons: ['approval_unavailable: this order is above your approval limit and approvals are not available on this plan; place a smaller order or ask the human to raise the limit'] });
  });
  it('requests a new approval when available; exactly the threshold needs none', () => {
    expect(codes(evaluate(large, policy, agent, deps).reasons)).toEqual(['approval_required']);
    const lookup = vi.fn(deps.approvalFor);
    expect(evaluate({ ...large, order: { ...large.order, notionalUsd: 2_000 } }, policy, agent, { ...deps, approvalFor: lookup }).decision).toBe('allow');
    expect(lookup).not.toHaveBeenCalled();
  });
  it('preserves warning placement, including the sketch’s denied/expired exception', () => {
    const req = { ...large, context: stale };
    for (const status of ['approved', 'pending', 'denied', 'expired'] as const) {
      const result = evaluate(req, policy, agent, { ...deps, approvalFor: () => ({ ...approval, status }) });
      expect(result.reasons.length).toBe(status === 'denied' || status === 'expired' ? 1 : 2);
      if (result.reasons.length === 2) expect(codes(result.reasons).at(-1)).toBe('stale_context');
    }
    expect(codes(evaluate(req, policy, agent, { ...deps, approvalsAvailable: false }).reasons)).toEqual(['approval_unavailable', 'stale_context']);
  });
  it('binds approvals to the agent, ref and whole order, including calldata', () => {
    const hash = orderHash(large.order);
    const bound: Deps = { ...deps, approvalFor: (id, ref, incoming) =>
      id === agent.id && ref === large.clientOrderRef && incoming === hash ? { ...approval, status: 'approved' } : undefined };
    expect(evaluate(large, policy, agent, bound).decision).toBe('allow');
    for (const req of [{ ...large, clientOrderRef: 'other-ref' }, { ...large, order: { ...large.order, notionalUsd: 2_002 } },
      { ...large, order: { ...large.order, tx: { to: ASSET as `0x${string}`, data: '0x1234' as const, value: '0' } } }]) {
      expect(evaluate(req, policy, agent, bound).decision).toBe('needs_approval');
    }
    expect(evaluate(large, policy, { ...agent, id: 'other-agent' }, bound).decision).toBe('needs_approval');
  });
});


describe('CA-34 incomplete scans and unavailable policy inputs', () => {
  it.each(['safe', 'balanced', 'degen'] as const)('denies pending buys in %s even with playbook blocking disabled', mode => {
    const approvalFor = vi.fn(() => ({ ...approval, status: 'approved' as const }));
    const result = evaluate(large, { ...policy, mode, blockPlaybookLevel: null }, agent,
      { ...deps, verdictFor: () => ({ ...verdict, level: 'pending', evaluatedPlaybooks: ['agent_bait'] }), approvalFor });
    expect(result.decision).toBe('deny');
    expect(result.reasons).toEqual(["scan_pending: EKO hasn't finished checking this coin; retry shortly"]);
    expect(result.senses?.verdict?.level).toBe('pending');
    expect(approvalFor).not.toHaveBeenCalled();
  });
  it.each([
    ['tradeability', { unavailable: true }, 'exit_cost_unavailable'],
    ['tradeability', { missing: ['exitCosts'] }, 'exit_cost_unavailable'],
    ['tradeability', { missing: ['exitCostPct.usd100'] }, 'exit_cost_unavailable'],
    ['tradeability', { missing: ['taxes'] }, 'taxes_unavailable'],
    ['liquidity', { unavailable: true }, 'liquidity_unavailable'],
    ['liquidity', { missing: ['depthUsd'] }, 'depth_unavailable'],
    ['liquidity', { missing: ['depthUsd.pct2'] }, 'depth_unavailable'],
  ] as const)('denies unavailable %s instead of comparing its placeholder', (section, metadata, reason) => {
    const unknown: CoinCard = JSON.parse(JSON.stringify(card));
    unknown.tradeability.exitCostPct = { usd100: 0, usd1k: 0, usd10k: 0 };
    unknown.liquidity.depthUsd.pct2 = 999999;
    unknown.meta = { [section]: { confidence: 0, asOfBlock: 1, ...metadata } };
    expect(evaluate(request, policy, agent, { ...deps, cardFor: () => unknown })).toMatchObject({ decision: 'deny', reasons: [reason] });
  });
  it('denies absent card inputs for active limits and keeps sell exit paths available', () => {
    expect(evaluate(request, policy, agent, { ...deps, cardFor: () => undefined }).reasons).toEqual(['liquidity_unavailable', 'exit_cost_unavailable']);
    expect(evaluate({ ...request, order: { ...request.order, side: 'sell' } }, policy, agent,
      { ...deps, verdictFor: () => ({ ...verdict, level: 'pending' }), cardFor: () => undefined }).decision).toBe('allow');
  });
});
