// Synthetic schema samples only; no live incident or review evidence.
import { GuardAssessmentV2Schema } from '../../../src/contracts/guard-v2.js';
import { GhostReportDraftSchema, GhostReportRecordSchema, GhostReportReviewSchema } from '../../../src/contracts/ghost-reports.js';
import { assessment, hash } from './guard-v2.js';
export const ghostDraft = GhostReportDraftSchema.parse({
  schemaVersion: 'ghost-report-1' as const, id: hash, revisionId: hash,
  preparedAt: '2026-10-02T00:00:00.000Z', preRelease: true,
  assessment: GuardAssessmentV2Schema.parse(assessment), evidence: [], missingEvidenceIds: [hash], supersedes: null,
});
export const ghostRecord = GhostReportRecordSchema.parse({ draft: ghostDraft, review: null, status: 'evidence_required' as const,
  corrections: [], assessmentChanged: false, receiptAnchored: false, receiptTxHash: null });
export const ghostSamples = {
  GhostReportDraft: ghostDraft,
  GhostReportReview: GhostReportReviewSchema.parse({ reportId: hash, reviewedAt: '2026-10-02T00:00:00.000Z', humanFactApproval: true }),
  GhostReportRecord: ghostRecord, GhostReportList: { records: [ghostRecord] },
};
