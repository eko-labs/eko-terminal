import { describe, expect, it, vi } from 'vitest';
import { GUARD_CHECK_IDS, GUARD_CHECK_TIERS } from '@eko/shared';
import type { GuardLevelV2, Policy, PreflightResult } from '@eko/shared';
import { applyPreset, evaluate as evaluatePolicy, orderHash, resolveRepeat } from '../src/index.js';
import { approval, ASSET, card, NOW, policy, verdict } from './fixtures.js';
import { cachedGuard, guardFixture } from './guard-fixtures.js';
import { agent, deps, request, bindRequest } from './actual-fixtures.js';
import type { Agent, PreflightRequest } from '@eko/shared';
import type { Deps } from '../src/index.js';
// Rebind the policy under test so these existing gate tests still isolate their original invariant.
const evaluate = (req: PreflightRequest, p: Policy, a: Agent, d: Deps) =>
  evaluatePolicy(d.guardPolicyV2 ? bindRequest(req, p) : req, p, a, d);

const modes = ['safe', 'balanced', 'degen'] as const;
const thresholds = [null, 'danger', 'monitor'] as const;
const levels: GuardLevelV2[] = ['lower', 'elevated', 'high', 'incomplete'];
const migrated = { ...deps, guardPolicyV2: true };
const codes = (reasons: string[]) => reasons.map(reason => reason.split(':')[0]);
const atLevel = (level: GuardLevelV2) => level === 'incomplete'
  ? guardFixture('lower', ['reference_exit']) : guardFixture(level);

describe('Guard policy 2 mandatory buyer gates (§1)', () => {
  for (const mode of modes) for (const blockPlaybookLevel of thresholds) {
    it.each(levels)(`${mode}/${blockPlaybookLevel}: %s`, level => {
      const p = { ...policy, mode, blockPlaybookLevel };
      const result = evaluate(request, p, agent, { ...migrated, verdictFor: () => cachedGuard(atLevel(level)) });
      const deny = level === 'high' || level === 'incomplete' ||
        level === 'elevated' && (mode === 'safe' || blockPlaybookLevel === 'monitor');
      expect(result).toMatchObject({ decision: deny ? 'deny' : 'allow', guardPolicyVersion: 2 });
      expect(codes(result.reasons)).toEqual(deny
        ? level === 'incomplete' ? ['guard_incomplete', 'guard_gaps'] : [`guard_${level}`] : []);
    });
  }

  it.each(modes)('%s applies unset-only presets and stamps settings from the same switch', mode => {
    const p = applyPreset({ mode, killed: false, version: 7 }, true);
    expect(p).toMatchObject({ guardPolicyVersion: 2, version: 7 });
    const chosen = applyPreset({ ...p, blockPlaybookLevel: null, minLiquidityUsd: 0, approvalAboveUsd: 0,
      maxRoundTripCostPct: 0, earningsBlackoutDays: 0, allowAssets: [] }, true);
    expect(chosen).toMatchObject({ blockPlaybookLevel: null, minLiquidityUsd: 0, approvalAboveUsd: 0,
      maxRoundTripCostPct: 0, earningsBlackoutDays: 0, allowAssets: [] });
    expect(evaluate(request, p, agent, { ...migrated, verdictFor: () => cachedGuard(guardFixture('elevated')) }).decision)
      .toBe(mode === 'safe' ? 'deny' : 'allow');
  });

  it.each(modes)('%s Lower still runs independent depth, venue cost and exposure limits', mode => {
    const result = evaluate(request, { ...policy, mode, minLiquidityUsd: 100_001, maxRoundTripCostPct: 0.9,
      maxPositionUsd: 99, maxDailyLossUsd: 0 }, agent, { ...migrated, verdictFor: () => cachedGuard() });
    expect(codes(result.reasons)).toEqual(['thin_liquidity', 'round_trip_cost', 'position_cap', 'daily_loss']);
  });
});

describe('Guard policy completeness (§5.3)', () => {
  for (const id of GUARD_CHECK_IDS) for (const status of ['missing', 'stale', 'failed', 'unsupported'] as const) {
    it.each(modes)(`${id}/${status} in %s`, mode => {
      const guard = guardFixture('lower', [id], status);
      const result = evaluate(request, { ...policy, mode, blockPlaybookLevel: null }, agent,
        { ...migrated, verdictFor: () => cachedGuard(guard) });
      const critical = GUARD_CHECK_TIERS[id] === 'buy_critical';
      expect(result.decision).toBe(critical || mode === 'safe' ? 'deny' : 'allow');
      expect(guard.level).toBe(critical ? 'incomplete' : 'elevated');
      expect(result.reasons).toContain(`guard_gaps: not fully checked: ${id}`);
      if (critical) expect(result.reasons[0]).toContain(`${id} (${status})`);
      else expect(guard.levelFloorReason).toBe('lower_tier_gap');
      expect(result.senses?.verdict?.guardV2).toEqual(guard);
    });
  }

  it.each(modes)('High stays High with both tiers missing in %s', mode => {
    const guard = guardFixture('high', [...GUARD_CHECK_IDS], 'stale', true);
    const result = evaluate(request, { ...policy, mode, blockPlaybookLevel: null }, agent,
      { ...migrated, verdictFor: () => cachedGuard(guard) });
    expect(codes(result.reasons)).toEqual(['guard_high', 'guard_gaps']);
    expect(result.reasons[1]).toBe(`guard_gaps: not fully checked: ${GUARD_CHECK_IDS.join(', ')}`);
  });

  it('accepts proved not-applicable checks without inventing gaps', () => {
    const guard = guardFixture();
    const check = guard.checks.find(check => check.id === 'launcher_service')!;
    check.status = 'not_applicable';
    check.evidenceIds = [guard.snapshotHash];
    expect(evaluate(request, policy, agent, { ...migrated, verdictFor: () => cachedGuard(guard) }).decision).toBe('allow');
  });

  it.each(modes)('missing verdict or simulation still denies %s with null', mode => {
    for (const value of [undefined, 'unavailable'] as const) {
      const result = evaluate(request, { ...policy, mode, blockPlaybookLevel: null }, agent,
        { ...migrated, verdictFor: () => value });
      expect(result.decision).toBe('deny');
      expect(codes(result.reasons)).toEqual([value ? 'sim_unavailable' : 'guard_incomplete']);
    }
  });
});

describe('host buy verdict gate (live trade admission before a Guard v2 release)', () => {
  it('replaces only the Guard v2 buy gate; the exact-account evidence gate still applies', () => {
    const legacy = { ...verdict, level: 'monitor' as const };
    const gate = vi.fn(() => ({ deny: [], warn: [] }));
    const admitted = evaluate(request, policy, agent, { ...migrated, verdictFor: () => legacy, buyVerdictGate: gate });
    expect(admitted.decision).toBe('allow');
    expect(gate).toHaveBeenCalledWith(legacy, expect.objectContaining({ mode: policy.mode }), ASSET, 4663, NOW);
    const refused = evaluate(request, policy, agent, { ...migrated, verdictFor: () => legacy, buyVerdictGate: () => ({ deny: ['guard_danger: refused'], warn: [] }) });
    expect(codes(refused.reasons)).toEqual(['guard_danger']);
    // Without the hook the same legacy-only verdict meets the Guard v2 gate and is incomplete.
    expect(codes(evaluate(request, policy, agent, { ...migrated, verdictFor: () => legacy }).reasons)).toEqual(['guard_incomplete']);
    // A read failure still refuses before any gate, and the exact-account evidence gate still runs.
    expect(codes(evaluate(request, policy, agent, { ...migrated, verdictFor: () => 'unavailable', buyVerdictGate: gate }).reasons)).toEqual(['sim_unavailable']);
    const noEvidence = evaluate(request, policy, agent, { ...migrated, verdictFor: () => legacy, buyVerdictGate: gate, actualOrderFor: undefined });
    expect(codes(noEvidence.reasons)).toContain('actual_order_quote_queued');
  });
});

describe('coherent migration and shadow isolation (§7.2)', () => {
  it.each([undefined, false])('migration %s preserves complete legacy results and settings', flag => {
    const legacy = { ...verdict, level: 'danger' as const };
    for (const mode of modes) for (const blockPlaybookLevel of thresholds) {
      const p = { ...policy, mode, blockPlaybookLevel };
      const baseline = evaluate(request, p, agent, { ...deps, guardPolicyV2: false, verdictFor: () => legacy });
      const withCandidate = evaluate(request, p, agent, { ...deps, guardPolicyV2: flag,
        verdictFor: () => ({ ...legacy, guardV2: guardFixture('high') }) });
      expect({ ...withCandidate, senses: baseline.senses }).toEqual(baseline);
      expect(withCandidate).not.toHaveProperty('guardPolicyVersion');
      expect(applyPreset(p, flag)).toEqual(applyPreset(p));
    }
  });

  it.each(['shadow', 'candidate'] as const)('never promotes %s completeness or scores into order decisions', mode => {
    for (const level of levels) {
      const guard = { ...atLevel(level), mode };
      const result = evaluate(request, { ...policy, blockPlaybookLevel: null }, agent,
        { ...migrated, verdictFor: () => cachedGuard(guard) });
      expect(codes(result.reasons)).toEqual(['guard_incomplete']);
    }
  });

  it('uses active typed levels rather than old attribution or reason strings', () => {
    const v = { ...cachedGuard(), level: 'danger' as const, reasons: ['unreleased legacy attribution'] };
    expect(evaluate(request, policy, agent, { ...migrated, verdictFor: () => v }).decision).toBe('allow');
    expect(evaluate(request, { ...policy, blockPlaybookLevel: null }, agent,
      { ...migrated, verdictFor: () => ({ ...v, playbooks: [{ id: 'honeypot', level: 'danger', confidence: 1, evidence: [] }] }) })
      .reasons).toEqual(['honeypot: the sell simulation fails']);
  });

  it('fails closed for malformed, mismatched, absent or unreleased active assessments', () => {
    const guard = guardFixture('elevated');
    const invalid = [undefined, { ...guard, coin: `0x${'cd'.repeat(20)}` },
      { ...guard, chainId: 8453, cursor: { ...guard.cursor, chainId: 8453 },
        availabilityCut: { ...guard.availabilityCut, cursor: { ...guard.cursor, chainId: 8453 } } },
      { ...guard, checks: [] }, { ...guard, factors: guard.factors.map(f => ({ ...f, calibration: 'shadow' })) }];
    for (const guardV2 of invalid) {
      const result = evaluate(request, policy, agent, { ...migrated,
        verdictFor: () => ({ ...verdict, guardV2 } as typeof verdict) });
      expect(codes(result.reasons)).toEqual(['guard_incomplete']);
    }
  });

  it('matches the chain for both supported on-chain venues and skips non-chain venues', () => {
    const guard = guardFixture();
    guard.chainId = guard.cursor.chainId = guard.availabilityCut.cursor.chainId = 8453;
    const req = { ...request, order: { ...request.order, venue: 'base' as const } };
    expect(evaluate(req, policy, agent, { ...migrated, verdictFor: () => cachedGuard(guard) }).decision).toBe('deny');
    expect(evaluate(req, policy, agent, { ...migrated, verdictFor: () => cachedGuard() }).decision).toBe('deny');
    const lookup = vi.fn(() => { throw new Error('unexpected senses lookup'); });
    for (const venue of ['robinhood', 'perp'] as const) expect(evaluate({ ...request, order: { ...request.order, venue } },
      policy, agent, { ...migrated, verdictFor: lookup }).decision).toBe('allow');
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe('ordering, approvals, replay and exits', () => {
  const large = { ...request, order: { ...request.order, notionalUsd: 2_001 } };
  const stored: PreflightResult = { preflightId: 'preflight-1', policyVersion: 1, journalId: 'journal-1',
    decision: 'needs_approval', reasons: ['approval_required'], approvalId: 'approval-1' };
  const hash = orderHash(large.order);

  for (const mode of modes) it.each(['high', 'incomplete', 'elevated'] as const)(`${mode}: approval obeys %s gates`, level => {
    const lookup = vi.fn(() => ({ ...approval, status: 'approved' as const }));
    const next = resolveRepeat({ orderHash: hash, result: stored }, hash, () => ({ ...stored,
      ...evaluate(large, { ...policy, mode, blockPlaybookLevel: null, approvalAboveUsd: 500 }, agent,
        { ...migrated, verdictFor: () => cachedGuard(atLevel(level)), approvalFor: lookup }),
      policyVersion: 2, journalId: 'journal-2' }));
    const denied = level !== 'elevated' || mode === 'safe';
    expect(next).toMatchObject({ decision: denied ? 'deny' : 'allow', preflightId: stored.preflightId, approvalId: stored.approvalId,
      guardPolicyVersion: 2, policyVersion: 2, journalId: 'journal-2' });
    expect(lookup).toHaveBeenCalledTimes(denied ? 0 : 1);
    expect(stored).not.toHaveProperty('guardPolicyVersion');
  });

  it.each(['pending', 'approved', 'denied', 'expired'] as const)('re-evaluates %s approval under current V2 limits', status => {
    const next = resolveRepeat({ orderHash: hash, result: stored }, hash, () => ({ ...stored,
      ...evaluate(large, policy, agent, { ...migrated, verdictFor: () => cachedGuard(),
        approvalFor: () => ({ ...approval, status }) }), journalId: 'journal-2' }));
    expect(next).toMatchObject({ guardPolicyVersion: 2, preflightId: stored.preflightId, approvalId: stored.approvalId,
      decision: status === 'pending' ? 'needs_approval' : status === 'approved' ? 'allow' : 'deny' });
    const changedLimits = resolveRepeat({ orderHash: hash, result: stored }, hash, () => ({ ...stored,
      ...evaluate(large, { ...policy, maxPositionUsd: 1 }, agent, { ...migrated, verdictFor: () => cachedGuard(),
        approvalFor: () => ({ ...approval, status }) }) }));
    expect(changedLimits.decision).toBe('deny');
  });

  for (const guardPolicyVersion of [undefined, 2] as const) it.each(['allow', 'deny'] as const)(
    `replays final %s results unchanged (stored Guard version ${guardPolicyVersion})`, decision => {
      const original = { ...stored, decision, ...(guardPolicyVersion ? { guardPolicyVersion } : {}) };
      const before = JSON.stringify(original);
      const reevaluate = vi.fn(() => { throw new Error('final result must not re-evaluate'); });
      expect(resolveRepeat({ orderHash: hash, result: original }, hash, reevaluate)).toBe(original);
      expect(reevaluate).not.toHaveBeenCalled();
      expect(JSON.stringify(original)).toBe(before);
      const mismatch = resolveRepeat({ orderHash: hash, result: original }, orderHash(request.order), reevaluate);
      expect(mismatch.guardPolicyVersion).toBe(guardPolicyVersion);
      expect(mismatch.decision).toBe('deny');
    });

  it('preserves denial ordering and warning placement before approval', () => {
    const lookup = vi.fn(deps.approvalFor);
    const result = evaluate({ ...large, context: { reportedAt: new Date(NOW - 300_001).toISOString(),
      dailyPnlUsd: -100, earningsDate: '2026-10-02' }, order: { ...large.order, leverage: 4 } },
    { ...policy, blockAssets: [ASSET], allowAssets: ['other'], minLiquidityUsd: 100_001, maxRoundTripCostPct: 0,
      maxPositionUsd: 1, maxDailyLossUsd: 100 }, agent,
    { ...migrated, verdictFor: () => cachedGuard(guardFixture('high')), approvalFor: lookup });
    expect(codes(result.reasons)).toEqual(['blocked_asset', 'not_allowed', 'guard_high', 'thin_liquidity',
      'round_trip_cost', 'position_cap', 'daily_loss', 'earnings_blackout', 'leverage', 'stale_context']);
    expect(lookup).not.toHaveBeenCalled();
  });

  for (const mode of modes) it.each(levels)(`sells bypass ${mode}/%s buyer gates and keep kill/blocklist/leverage`, level => {
    const sell = { ...large, context: undefined, order: { ...large.order, side: 'sell' as const, notionalUsd: undefined } };
    const lookup = vi.fn(() => cachedGuard(atLevel(level)));
    const p: Policy = { ...policy, mode, allowAssets: ['other'], maxDailyLossUsd: 0, maxPositionUsd: 0, approvalAboveUsd: 0 };
    const d = { ...migrated, verdictFor: lookup, cardFor: vi.fn(() => card), approvalFor: vi.fn(deps.approvalFor) };
    expect(evaluate(sell, p, agent, d)).toMatchObject({ decision: 'allow', reasons: [], guardPolicyVersion: 2 });
    expect(lookup).not.toHaveBeenCalled();
    expect(d.cardFor).not.toHaveBeenCalled();
    expect(d.approvalFor).not.toHaveBeenCalled();
    expect(codes(evaluate(sell, { ...p, killed: true }, agent, d).reasons)).toEqual(['killed']);
    expect(codes(evaluate(sell, { ...p, blockAssets: [ASSET] }, agent, d).reasons)).toEqual(['blocked_asset']);
    expect(codes(evaluate({ ...sell, order: { ...sell.order, leverage: 6 } }, p, agent, d).reasons)).toEqual(['leverage']);
  });

  it('kill still short circuits all captured dependencies and stamps the version', () => {
    const lookup = vi.fn(() => { throw new Error('unexpected dependency'); });
    expect(evaluate(request, { ...policy, killed: true }, agent,
      { ...migrated, now: lookup, verdictFor: lookup, cardFor: lookup, priceFor: lookup, approvalFor: lookup }))
      .toMatchObject({ decision: 'deny', guardPolicyVersion: 2 });
    expect(lookup).not.toHaveBeenCalled();
  });
});
