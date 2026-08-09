import { z } from 'zod';
import { Bytes32Schema } from './receipt-encoding.js';
import { EvidenceRefV2Schema, GuardAssessmentV2Schema } from './guard-v2.js';
import { BUYER_RISK, BUILT_ON, DYOR, GUARD_CHECK_LABELS, NON_AFFILIATION } from './guard-copy.js';
import { compactGuardVerdict, guardConsumerReasons } from './guard-consumers.js';
import { formatGuardReason } from './guard-copy.js';

// TODO(spec): Ghost Report storage/review API is not frozen. Keep this additive
// contract separate from Guard scoring and existing Feed event kinds.
const evidence = EvidenceRefV2Schema.omit({ text: true });
export const GhostReportDraftSchema = z.strictObject({
  schemaVersion: z.literal('ghost-report-1'), id: Bytes32Schema, revisionId: Bytes32Schema,
  preparedAt: z.iso.datetime(), preRelease: z.boolean(), assessment: GuardAssessmentV2Schema,
  evidence: z.array(evidence), missingEvidenceIds: z.array(Bytes32Schema),
  supersedes: Bytes32Schema.nullable(),
}).superRefine((d, ctx) => {
  const wanted = new Set(d.assessment.reasons.flatMap(r => r.evidenceIds));
  const retained = new Set(d.evidence.map(e => e.id));
  const missing = new Set<string>(d.missingEvidenceIds);
  if (retained.size !== d.evidence.length || d.evidence.some(e => !wanted.has(e.id))
    || new Set(d.missingEvidenceIds).size !== d.missingEvidenceIds.length
    || d.missingEvidenceIds.some(id => retained.has(id) || !wanted.has(id))
    || [...wanted].some(id => !retained.has(id) && !missing.has(id)))
    ctx.addIssue({ code: 'custom', message: 'Every reason reference must be retained or explicitly missing' });
});
export type GhostReportDraft = z.infer<typeof GhostReportDraftSchema>;
export const GhostReportReviewSchema = z.strictObject({
  reportId: Bytes32Schema, reviewedAt: z.iso.datetime(), humanFactApproval: z.literal(true),
});
export type GhostReportReview = z.infer<typeof GhostReportReviewSchema>;
export const GhostReportRecordSchema = z.strictObject({
  draft: GhostReportDraftSchema, review: GhostReportReviewSchema.nullable(),
  status: z.enum(['draft', 'evidence_required', 'reviewed_partial', 'verified', 'correction_needed']),
  corrections: z.array(Bytes32Schema), assessmentChanged: z.boolean(),
  receiptAnchored: z.boolean(), receiptTxHash: Bytes32Schema.nullable(),
}).superRefine((r, ctx) => {
  if (r.review && r.review.reportId !== r.draft.id)
    ctx.addIssue({ code: 'custom', message: 'Fact approval must bind this report' });
  if (r.receiptAnchored !== (r.receiptTxHash !== null))
    ctx.addIssue({ code: 'custom', message: 'Canonical anchor requires a transaction reference' });
  if ((r.status === 'reviewed_partial' || r.status === 'verified') && !r.review)
    ctx.addIssue({ code: 'custom', message: 'Human fact approval required' });
  if (r.status === 'verified' && (!r.receiptAnchored || r.assessmentChanged || r.draft.missingEvidenceIds.length
    || r.draft.assessment.completeness.missing.length || !ghostReportFindings(r.draft).length))
    ctx.addIssue({ code: 'custom', message: 'Verified reports require current complete supported evidence' });
});
export type GhostReportRecord = z.infer<typeof GhostReportRecordSchema>;
export const GhostReportListSchema = z.strictObject({ records: z.array(GhostReportRecordSchema) });

/** Only typed reasons with retained evidence become findings. Never ingest prose,
 * token names, allegations, reviewer identities or social account information. */
export function ghostReportFindings(draft: GhostReportDraft) {
  const ids = new Set(draft.evidence.map(e => e.id));
  return guardConsumerReasons(draft.assessment).filter(r => r.code !== 'INCOMPLETE'
    && r.evidenceIds.length > 0 && r.evidenceIds.every(id => ids.has(id)));
}
export function ghostReportShare(input: GhostReportRecord): string {
  const record = GhostReportRecordSchema.parse(input), d = record.draft, a = d.assessment;
  const view = compactGuardVerdict({ version: 2, assessment: a });
  const findings = ghostReportFindings(d);
  return [
    'EKO · Ghost Report',
    record.status === 'verified' ? 'Human fact review complete · live status; can change' : record.status === 'correction_needed'
      ? 'Correction required · prior snapshot retained' : record.status === 'reviewed_partial'
        ? 'Human fact review complete · partial evidence' : 'Draft · human fact approval required',
    d.preRelease ? 'From our pre-release engine' : null,
    `Contract: ${a.coin} · chain ${a.chainId}`, view.label, view.mode, view.snapshot,
    findings.length ? 'What the engine saw:' : 'Evidence required: a retained Guard reason with validated source references.',
    ...findings.map(formatGuardReason),
    ...a.checks.filter(c => c.status !== 'complete' && c.status !== 'not_applicable')
      .map(c => `Missing check: ${GUARD_CHECK_LABELS[c.id]} · ${c.status} · ${c.failureCode}`),
    ...d.missingEvidenceIds.map(id => `Missing evidence: ${id}`),
    ...d.evidence.map(e => `Evidence (${e.kind}, block ${e.cursor.blockNumber}): /v2/coins/${a.coin}/evidence/${e.id}`),
    `Receipt: /receipt/${a.receipt.id}`,
    record.receiptAnchored ? `Receipt transaction: ${record.receiptTxHash}` : 'Receipt transaction: pending canonical anchor verification',
    `Rules: ${a.rulesVersion} · code ${a.codeHash} · snapshot ${a.snapshotHash} · decision ${a.decisionHash}`,
    'Identity collisions and exemptions alone establish neither shared control nor wrongdoing.',
    d.supersedes ? `Corrects: /v2/ghost-reports/${d.supersedes}` : null,
    ...record.corrections.map(id => `Correction: /v2/ghost-reports/${id}`),
    record.assessmentChanged ? 'Guard assessment updated; this report retains its original snapshot.' : null,
    BUYER_RISK, DYOR, BUILT_ON, NON_AFFILIATION,
  ].filter(Boolean).join('\n');
}
