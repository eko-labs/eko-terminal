import { keccak256, toHex } from 'viem';
import { Bytes32Schema, EvidenceRefV2Schema, GhostReportDraftSchema, GhostReportRecordSchema,
  GhostReportReviewSchema, GuardAssessmentV2Schema, GuardVerdictRevisionInputSchema, ghostReportFindings } from '@eko/shared';
import type { GhostReportDraft, GhostReportRecord, GuardStoredEvidence } from '@eko/shared';
import type { ChainDb } from './client.js';
import { GuardReceiptStore } from './guard-receipts.js';
import { guardRowsKnownAt, guardStorageHash } from './guard-store.js';

/** Internal writer only: no public approval/mutation route or social transport.
 * Drafts retain the exact engine snapshot; reviews and corrections are append-only. */
export class GhostReportStore {
  constructor(readonly db: ChainDb) {}

  async prepare(receiptId: string, options: { preRelease: boolean; supersedes?: string }) {
    return this.db.tx(async tx => {
      const receipt = await new GuardReceiptStore(tx).get(receiptId);
      if (!receipt || receipt.events.length) throw new Error('Evidence required: a current persisted Guard receipt');
      const row = (await tx.sql.query<{ data: unknown }>('SELECT data FROM guard_verdict_revisions WHERE id=$1', [receipt.payload.revisionId])).rows[0];
      const revision = GuardVerdictRevisionInputSchema.parse(row?.data);
      if (revision.context.routeId !== null || revision.context.sizeUsd !== null || revision.context.accountClass !== null)
        throw new Error('Token-wide Guard assessment required');
      const assessment = GuardAssessmentV2Schema.parse({ ...receipt.payload.decision,
        receipt: { status: 'recorded', id: receiptId, payloadHash: receipt.receipt.payloadHash } });
      if (assessment.chainId !== 4663) throw new Error('Unsupported report chain');
      const cut = { coin: assessment.coin, chainId: assessment.chainId, manifestId: revision.manifestId,
        state: assessment.cursor, availability: assessment.availabilityCut };
      const rows = (await Promise.all((['guard_chain_evidence', 'guard_measurement_evidence'] as const)
        .map(table => guardRowsKnownAt<GuardStoredEvidence>(tx, table, cut)))).flat();
      const wanted = [...new Set(assessment.reasons.flatMap(r => r.evidenceIds))].sort();
      const refs: GhostReportDraft['evidence'] = [];
      for (const id of wanted) {
        const stored = rows.find(r => r.id === id) as typeof rows[number] & { content?: Uint8Array } | undefined;
        if (!stored) continue;
        if (!stored.content || keccak256(toHex(stored.content)) !== stored.payload_hash || stored.object_ref !== stored.payload_hash)
          throw new Error('Ghost Report evidence content hash mismatch');
        const { text: _text, ...ref } = EvidenceRefV2Schema.parse({ ...stored.data.evidence, id: stored.id });
        refs.push(ref);
      }
      const supersedes = options.supersedes ? Bytes32Schema.parse(options.supersedes) : null;
      if (supersedes) {
        const prior = await new GhostReportStore(tx).get(supersedes);
        if (!prior || prior.draft.assessment.coin !== assessment.coin || prior.draft.revisionId === receipt.payload.revisionId)
          throw new Error('Correction requires a prior report for the same contract and a new assessment');
      }
      const body = { schemaVersion: 'ghost-report-1' as const, revisionId: receipt.payload.revisionId,
        preRelease: options.preRelease, assessment, evidence: refs,
        missingEvidenceIds: wanted.filter(id => !refs.some(e => e.id === id)), supersedes };
      const draft = GhostReportDraftSchema.parse({ ...body, id: guardStorageHash(body), preparedAt: new Date().toISOString() });
      await tx.sql.query('INSERT INTO ghost_report_drafts(id,revision_id,supersedes,data,prepared_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING',
        [draft.id, draft.revisionId, supersedes, JSON.stringify(draft), draft.preparedAt]);
      return (await new GhostReportStore(tx).get(draft.id))!;
    });
  }

  async approve(raw: unknown) {
    const review = GhostReportReviewSchema.parse(raw);
    return this.db.tx(async tx => {
      const store = new GhostReportStore(tx), report = await store.get(review.reportId);
      if (!report || report.assessmentChanged || !ghostReportFindings(report.draft).length)
        throw new Error('Current supported engine evidence required for fact approval');
      await tx.sql.query('INSERT INTO ghost_report_reviews(report_id,data,reviewed_at) VALUES($1,$2,$3) ON CONFLICT(report_id) DO NOTHING',
        [review.reportId, JSON.stringify(review), review.reviewedAt]);
      return (await store.get(review.reportId))!;
    });
  }

  async get(id: string): Promise<GhostReportRecord | null> {
    const key = Bytes32Schema.parse(id);
    const row = (await this.db.sql.query<{ data: unknown; review: unknown }>(
      'SELECT d.data,r.data AS review FROM ghost_report_drafts d LEFT JOIN ghost_report_reviews r ON r.report_id=d.id WHERE d.id=$1', [key])).rows[0];
    if (!row) return null;
    const draft = GhostReportDraftSchema.parse(row.data), review = row.review ? GhostReportReviewSchema.parse(row.review) : null;
    const receipt = await new GuardReceiptStore(this.db).get(draft.assessment.receipt.id);
    const invalidSources = (await this.db.sql.query(`SELECT 1 FROM guard_verdict_revisions r
      JOIN (SELECT target_id FROM guard_source_events UNION ALL SELECT target_id FROM guard_measurement_events) e
      ON e.target_id=ANY(r.dependency_ids) WHERE r.id=$1 LIMIT 1`, [draft.revisionId])).rows.length > 0;
    const changed = !receipt || receipt.events.length > 0 || invalidSources || (await this.db.sql.query(`SELECT 1 FROM guard_verdict_revisions r
      JOIN guard_availability m ON m.id=r.manifest_id
      JOIN guard_verdict_revisions original ON original.id=$2
      JOIN guard_availability captured ON captured.id=original.manifest_id
      WHERE r.coin=$1 AND r.id<>$2 AND r.state_position >= original.state_position
      AND m.replay_mode=captured.replay_mode AND m.source_id=captured.source_id
      AND r.data->'assessment'->>'mode'=original.data->'assessment'->>'mode'
      AND r.data->'context' = '{"routeId":null,"sizeUsd":null,"accountClass":null}'::jsonb
      AND NOT EXISTS(SELECT 1 FROM guard_verdict_events e WHERE e.target_id=r.id) LIMIT 1`, [draft.assessment.coin, draft.revisionId])).rows.length > 0;
    const corrections = (await this.db.sql.query<{ id: string }>(`SELECT d.id FROM ghost_report_drafts d
      JOIN ghost_report_reviews r ON r.report_id=d.id WHERE d.supersedes=$1 ORDER BY d.prepared_at,d.id`, [key])).rows.map(r => r.id);
    const supported = ghostReportFindings(draft).length > 0;
    // Canonical receipt verification belongs to CA-16. Stored anchor metadata
    // alone cannot make a report verified; the API adapter supplies that state.
    return GhostReportRecordSchema.parse({ draft, review, corrections, assessmentChanged: changed,
      receiptAnchored: false, receiptTxHash: null, status: changed ? 'correction_needed' : !supported ? 'evidence_required' : review ? 'reviewed_partial' : 'draft' });
  }

  async reviewed() {
    const rows = (await this.db.sql.query<{ id: string }>(`SELECT d.id FROM ghost_report_drafts d
      JOIN ghost_report_reviews r ON r.report_id=d.id ORDER BY r.reviewed_at DESC,d.id LIMIT 50`)).rows;
    return (await Promise.all(rows.map(r => this.get(r.id)))).filter((r): r is GhostReportRecord => r !== null);
  }
}
