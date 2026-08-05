import { describe, expect, it } from 'vitest';
import { AgentDetailSchema, ApprovalDetailSchema, PolicySchema, PreflightResultSchema } from '../src/index.js';
import samples from './fixtures/contracts/v1.json';

describe('Guard policy version metadata (Guard §1)', () => {
  for (const [schema, sample] of [[PolicySchema, samples.Policy], [PreflightResultSchema, samples.PreflightResult],
    [ApprovalDetailSchema, samples.ApprovalDetail]] as const) {
    it('preserves original payloads and accepts only version 2 for new metadata', () => {
      expect(schema.parse(sample)).toEqual(sample);
      expect(schema.parse({ ...sample, guardPolicyVersion: 2 })).toEqual({ ...sample, guardPolicyVersion: 2 });
      for (const guardPolicyVersion of [null, 1, 3, '2'])
        expect(schema.safeParse({ ...sample, guardPolicyVersion }).success).toBe(false);
    });
  }
  it('retains the settings version in agent detail', () => {
    const detail = { ...samples.AgentDetail, policy: { ...samples.AgentDetail.policy, guardPolicyVersion: 2 } };
    expect(AgentDetailSchema.parse(detail)).toEqual(detail);
  });
});
