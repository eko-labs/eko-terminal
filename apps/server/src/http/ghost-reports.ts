import type { FastifyInstance } from 'fastify';
import { GhostReportStore } from '@eko/db';
import type { ReceiptApiStore } from '@eko/db';
import { Bytes32Schema, GhostReportListSchema, GhostReportRecordSchema, GuardReceiptPayloadSchema,
  canonicalize, ghostReportShare } from '@eko/shared';
import type { GhostReportRecord } from '@eko/shared';
import { z } from 'zod';
import { InputError, notFound, parse, sendError } from './v1/helpers.js';

/** Revalidate canonical receipt proofs using CA-16; never trust cached anchors.
 * An unavailable verifier preserves a reviewed partial report and its gaps.
 * @remarks
 * Recheck a reviewed report's receipt payload/decision against the canonical receipt API before
 * promoting its public status. Public projection, no wallet auth. Verification failures retain
 * partial gaps; output schema errors still throw.
 * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../../docs/security/INVARIANTS.md | Implemented core invariants}
 */
export async function publicGhostReport(record: GhostReportRecord, receipts: Pick<ReceiptApiStore, 'get'>) {
  let anchored = false, receiptTxHash: string | null = null;
  try {
    const receipt = await receipts.get(record.draft.assessment.receipt.id);
    if (receipt?.status === 'anchored' && receipt.kind === 'verdict' && receipt.hash === record.draft.assessment.receipt.payloadHash) {
      const payload = GuardReceiptPayloadSchema.parse(receipt.revealed);
      const { receipt: _receipt, ...decision } = record.draft.assessment;
      anchored = payload.revisionId === record.draft.revisionId && canonicalize(payload.decision) === canonicalize(decision);
      if (anchored) receiptTxHash = receipt.txHash;
    }
  } catch { /* CA-16 unavailable/tampered evidence cannot be treated as verified. */ }
  const complete = record.draft.assessment.checks.every(c => c.status === 'complete' || c.status === 'not_applicable')
    && record.draft.missingEvidenceIds.length === 0;
  return GhostReportRecordSchema.parse({ ...record, receiptAnchored: anchored, receiptTxHash,
    status: record.review && !record.assessmentChanged && complete && anchored ? 'verified' : record.status });
}

/**
 * Register public no-store reviewed report list/detail/share under /v2. No wallet auth;
 * unreviewed/unknown reports are not_found. Invalid input and storage/schema failures return
 * bounded errors; proof failure cannot promote a report.
 * @see {@link ../../../../SECURITY.md#privileged-powers | Privileged powers}
 * @see {@link ../../../../docs/security/INVARIANTS.md | Implemented core invariants}
 */
export async function ghostReportRoutes(app: FastifyInstance, store: GhostReportStore, receipts: Pick<ReceiptApiStore, 'get'>) {
  await app.register(async routes => {
    routes.addHook('onRequest', async (_req, reply) => { reply.header('Cache-Control', 'no-store'); });
    routes.setErrorHandler((err, _req, reply) => err instanceof InputError
      ? sendError(reply, 'bad_request', err.message) : sendError(reply, 'internal_error', 'Ghost Report evidence is unavailable'));
    routes.get('/ghost-reports', async () => GhostReportListSchema.parse({ records: await Promise.all((await store.reviewed()).map(r => publicGhostReport(r, receipts))) }));
    routes.get('/ghost-reports/:id', async (req, reply) => {
      const { id } = parse(z.strictObject({ id: Bytes32Schema }), req.params);
      const report = await store.get(id);
      return report?.review ? publicGhostReport(report, receipts) : notFound(reply);
    });
    routes.get('/ghost-reports/:id/share', async (req, reply) => {
      const { id } = parse(z.strictObject({ id: Bytes32Schema }), req.params);
      const report = await store.get(id);
      return report?.review ? { text: ghostReportShare(await publicGhostReport(report, receipts)) } : notFound(reply);
    });
  }, { prefix: '/v2' });
}
