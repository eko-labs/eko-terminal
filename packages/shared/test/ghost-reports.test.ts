import { describe, expect, it } from 'vitest';
import { GhostReportDraftSchema, GhostReportRecordSchema, GhostReportReviewSchema,
  GuardAssessmentV2Schema, ghostReportShare } from '../src/index.js';
import { ghostDraft, ghostRecord, ghostSamples } from './fixtures/contracts/ghost-reports.js';
import { address, cursor, hash, availability } from './fixtures/contracts/guard-v2.js';

describe('Ghost Report evidence and copy boundaries (synthetic)', () => {
  it('never treats a clone or exemption as wrongdoing or shared control', () => {
    const assessment = GuardAssessmentV2Schema.parse({ ...ghostDraft.assessment, reasons: [
      { code: 'CLONE', factorId: null, parameters: { tokenId: { chainId: 4663, address } }, evidenceIds: [hash] },
      { code: 'EXEMPTIONS', factorId: null, parameters: { count: 2, affiliatedCount: 0 }, evidenceIds: [hash] },
    ] });
    const draft = GhostReportDraftSchema.parse({ ...ghostDraft, assessment, missingEvidenceIds: [], evidence: [
      { id: hash, kind: 'state', cursor, knownAt: availability, payloadHash: hash, objectRef: hash, supersedes: null },
    ] });
    const text = ghostReportShare({ ...ghostRecord, draft });
    expect(text).toContain('neither authenticity nor shared control');
    expect(text).toContain('0 have independent affiliation evidence');
    expect(text).toContain('neither shared control nor wrongdoing');
    expect(text).not.toContain('insiders');
  });
  it('rejects invented references, premature verification and personal attribution fields', () => {
    expect(GhostReportDraftSchema.safeParse({ ...ghostDraft, missingEvidenceIds: [] }).success).toBe(false);
    expect(GhostReportRecordSchema.safeParse({ ...ghostRecord, status: 'verified' }).success).toBe(false);
    for (const field of ['name', 'email', 'handle', 'username', 'person', 'notes']) {
      expect(GhostReportDraftSchema.safeParse({ ...ghostDraft, [field]: 'sample-user' }).success).toBe(false);
      expect(GhostReportReviewSchema.safeParse({ ...ghostSamples.GhostReportReview, [field]: 'sample-user' }).success).toBe(false);
    }
    const bad = { ...ghostDraft.assessment, reasons: [{ ...ghostDraft.assessment.reasons[0], parameters: { arbitraryText: 'Untrusted source content' } }] };
    expect(GuardAssessmentV2Schema.safeParse(bad).success).toBe(false);
  });
});
