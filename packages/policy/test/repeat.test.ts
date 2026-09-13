import { describe, expect, it, vi } from 'vitest';
import type { PreflightResult } from '@eko/shared';
import { evaluate, orderHash, resolveRepeat } from '../src/index.js';
import { agent, approval, deps, policy, request, verdict } from './fixtures.js';

const result: PreflightResult = { preflightId: 'preflight-1', decision: 'needs_approval', reasons: ['fixture'],
  policyVersion: 1, approvalId: 'approval-1', journalId: 'journal-1' };
const hash = orderHash(request.order);

describe('idempotency (§9.6)', () => {
  it.each(['allow', 'deny', 'needs_approval'] as const)('denies order mismatches before touching a stored %s', (decision) => {
    const original = { ...result, decision };
    const before = JSON.stringify(original);
    const reevaluate = vi.fn(() => result);
    expect(resolveRepeat({ orderHash: hash, result: original }, orderHash({ ...request.order, notionalUsd: 101 }), reevaluate)).toEqual({
      preflightId: 'preflight-1', policyVersion: 1, journalId: 'journal-1', decision: 'deny',
      reasons: ['order_mismatch: this clientOrderRef was used for a different order'] });
    expect(reevaluate).not.toHaveBeenCalled();
    expect(JSON.stringify(original)).toBe(before);
  });
  it.each(['allow', 'deny'] as const)('replays final %s results as-is', (decision) => {
    const original = { ...result, decision };
    const reevaluate = vi.fn(() => result);
    expect(resolveRepeat({ orderHash: hash, result: original }, hash, reevaluate)).toBe(original);
    expect(reevaluate).not.toHaveBeenCalled();
  });
  it.each(['pending', 'approved', 'denied', 'expired'] as const)('fully re-evaluates a %s approval while preserving IDs', (status) => {
    const req = { ...request, order: { ...request.order, notionalUsd: 2_001 } };
    const order = orderHash(req.order);
    const reevaluate = vi.fn(() => ({ ...evaluate(req, { ...policy, version: 2 }, agent,
      { ...deps, approvalFor: () => ({ ...approval, status }) }), preflightId: 'discarded', approvalId: 'discarded',
      policyVersion: 2, journalId: 'journal-2' }));
    const next = resolveRepeat({ orderHash: order, result }, order, reevaluate);
    expect(next).toMatchObject({ preflightId: result.preflightId, approvalId: result.approvalId,
      policyVersion: 2, journalId: 'journal-2', decision: status === 'pending' ? 'needs_approval' : status === 'approved' ? 'allow' : 'deny' });
    expect(reevaluate).toHaveBeenCalledOnce();
    expect(result.decision).toBe('needs_approval');
  });
  it('denies newly dangerous coins despite an approved order', () => {
    const req = { ...request, order: { ...request.order, notionalUsd: 2_001 } };
    const lookup = vi.fn(() => ({ ...approval, status: 'approved' as const }));
    const next = resolveRepeat({ orderHash: orderHash(req.order), result }, orderHash(req.order), () => ({ ...result,
      ...evaluate(req, policy, agent, { ...deps, verdictFor: () => ({ ...verdict, level: 'danger' }), approvalFor: lookup }), journalId: 'journal-2' }));
    expect(next.decision).toBe('deny');
    expect(next.reasons).toEqual(['playbook_danger: fixture risk']);
    expect(lookup).not.toHaveBeenCalled();
  });
  it('rechecks kill switches and context on retries', () => {
    for (const p of [{ ...policy, killed: true }, { ...policy, mode: 'safe' as const }]) {
      const next = resolveRepeat({ orderHash: hash, result }, hash, () => ({ ...result,
        ...evaluate({ ...request, context: undefined }, p, agent, deps) }));
      expect(next.decision).toBe('deny');
    }
  });
});
