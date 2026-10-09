// Synthetic retained engine evidence, in-memory DB and injected HTTP. No RPC,
// live incident validation, human approval, publishing or network spend.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { keccak256, toHex } from 'viem';
import { migrate, migrateEngines, GhostReportStore, GuardSourceStore, GuardVerdictStore,
  guardManifestId, guardStorageHash, GuardReceiptStore, type ChainDb } from '@eko/db';
import { openDb } from '../../../packages/db/test/helpers/historical-db.js';
import { canonicalize, Bytes32Schema, GuardCursorSchema, GuardCoverageSchema, GuardAssessmentV2Schema, guardDecisionBody, ghostReportShare, ghostReportFindings,
  GhostReportReviewSchema, type ReceiptLookup } from '@eko/shared';
import { assessment as sample, cursor as sampleCursor, hash as sampleHash, coverage } from '../../../packages/shared/test/fixtures/contracts/guard-v2.js';
import { ghostReportRoutes, publicGhostReport } from '../src/http/ghost-reports.js';

let db: ChainDb, reports: GhostReportStore;
const cursor = GuardCursorSchema.parse(sampleCursor), hash = Bytes32Schema.parse(sampleHash);
const at = '2026-10-02T00:00:00.000Z';
beforeAll(async () => { db = await openDb({ pgliteDir: ':memory:' }); await migrate(db); await migrateEngines(db); reports = new GhostReportStore(db); });
afterAll(async () => { await db?.close(); });
async function engine(n: number, sequence = '1', supported = true, complete = false) {
  const coin = `0x${n.toString(16).padStart(40, '0')}` as `0x${string}`;
  const key = { sourceId: `sample-source-${n}`, sourceRevision: hash, replayMode: 'production' as const,
    cut: { cursor, acquisitionSequence: sequence }, watermark: cursor };
  const manifest = { ...key, id: guardManifestId(key), acquiredAt: at };
  const sources = new GuardSourceStore(db); await sources.putManifest(manifest);
  const content = new TextEncoder().encode(JSON.stringify({ kind: 'synthetic-measurement', amount: sequence })), digest = keccak256(toHex(content));
  const source = await sources.putEvidence({ coin, chainId: 4663, manifestId: manifest.id, sourceRevision: hash,
    sourceItemId: `sample-observation-${sequence}`, cursor, knownAt: manifest.cut, acquiredAt: at,
    methodVersion: '2.0.0', dependencyIds: [], evidence: { id: digest, kind: 'state', cursor, knownAt: manifest.cut,
      payloadHash: digest, objectRef: digest, supersedes: null, text: { text: 'Untrusted source content', flags: [], truncated: false } } }, content);
  const a = GuardAssessmentV2Schema.parse(sample);
  a.coin = coin; a.availabilityCut = manifest.cut;
  a.reasons = supported ? a.reasons.map(r => ({ ...r, evidenceIds: [source.id] })) : [];
  a.factors = a.factors.map(f => ({ ...f, evidenceIds: supported ? [source.id] : [] }));
  if (complete) {
    a.checks = a.checks.map(c => ({ ...c, status: 'complete', coverage: GuardCoverageSchema.parse(coverage), failureCode: null, evidenceIds: [source.id] }));
    a.completeness = { buyCriticalComplete: true, lowerTierComplete: true, missing: [] };
    a.level = 'lower'; a.scoreIsLowerBound = false;
  }
  const deterministicInput = { sample: n, sequence };
  a.snapshotHash = guardStorageHash(deterministicInput); a.decisionHash = guardStorageHash(guardDecisionBody(a));
  return new GuardVerdictStore(db).putRevision({ assessment: GuardAssessmentV2Schema.parse(a), manifestId: manifest.id,
    sourceRevision: hash, context: { routeId: null, sizeUsd: null, accountClass: null }, dependencyIds: supported ? [source.id as `0x${string}`] : [],
    recordedAt: at, runId: `sample-run-${n}-${sequence}`, deterministicInput });
}
const approve = (id: string) => reports.approve({ reportId: id, reviewedAt: at, humanFactApproval: true });

describe('118 evidence-backed Ghost Reports', () => {
  it('requires an actual receipt and never fabricates findings from empty evidence', async () => {
    await expect(reports.prepare('absent-receipt', { preRelease: true })).rejects.toThrow('Evidence required');
    const revision = await engine(1, '1', false), report = await reports.prepare(revision.data.assessment.receipt.id, { preRelease: true });
    expect(report.status).toBe('evidence_required'); expect(ghostReportFindings(report.draft)).toEqual([]);
    expect(ghostReportShare(report)).toContain('Evidence required:');
    await expect(approve(report.draft.id)).rejects.toThrow('supported engine evidence');
  });
  it('keeps partial evidence, immutable drafts, deterministic shares and no attribution fields', async () => {
    const revision = await engine(2), first = await reports.prepare(revision.data.assessment.receipt.id, { preRelease: true });
    const again = await reports.prepare(revision.data.assessment.receipt.id, { preRelease: true });
    expect(again).toEqual(first); expect(first.draft.evidence).toHaveLength(1);
    expect(first.draft.evidence[0]).not.toHaveProperty('text');
    const text = ghostReportShare(first);
    expect(text).toBe(ghostReportShare(first)); expect(text).toContain('From our pre-release engine');
    expect(text).toContain('Missing check: Can a buyer sell?'); expect(text).toContain('Receipt transaction: pending');
    expect(text).not.toContain('Untrusted source content');
    expect(text).toContain('neither shared control nor wrongdoing');
    expect(text).toContain('DYOR'); expect(text).toContain('Not affiliated');
    expect(GhostReportReviewSchema.safeParse({ reportId: first.draft.id, reviewedAt: at, humanFactApproval: false }).success).toBe(false);
    expect(GhostReportReviewSchema.safeParse({ reportId: first.draft.id, reviewedAt: at, humanFactApproval: true, reviewer: 'sample-user' }).success).toBe(false);
    await expect(db.sql.query('UPDATE ghost_report_drafts SET data=$1 WHERE id=$2', ['{}', first.draft.id])).rejects.toThrow('append-only');
    await expect(db.sql.query('DELETE FROM ghost_report_drafts WHERE id=$1', [first.draft.id])).rejects.toThrow('append-only');
    const reviewed = await approve(first.draft.id); expect(reviewed.status).toBe('reviewed_partial');
    expect((await publicGhostReport(reviewed, { get: async () => null })).status).toBe('reviewed_partial');
    await expect(db.sql.query('DELETE FROM ghost_report_reviews WHERE report_id=$1', [first.draft.id])).rejects.toThrow('append-only');
  });
  it('preserves old approvals and corrections when Guard changes; rejects mismatched predecessors', async () => {
    const firstRevision = await engine(3), first = await reports.prepare(firstRevision.data.assessment.receipt.id, { preRelease: true });
    await approve(first.draft.id);
    const next = await engine(3, '2');
    const old = (await reports.get(first.draft.id))!;
    expect(old.status).toBe('correction_needed'); expect(old.draft).toEqual(first.draft); expect(old.review).not.toBeNull();
    await expect(approve(first.draft.id)).rejects.toThrow('Current supported');
    const correction = await reports.prepare(next.data.assessment.receipt.id, { preRelease: true, supersedes: first.draft.id });
    expect((await reports.get(first.draft.id))!.corrections).toEqual([]); // unreviewed corrections stay private
    await approve(correction.draft.id);
    expect((await reports.get(first.draft.id))!.corrections).toEqual([correction.draft.id]);
    expect(ghostReportShare(correction)).toContain(`Corrects: /v2/ghost-reports/${first.draft.id}`);
    const other = await engine(4);
    await expect(reports.prepare(other.data.assessment.receipt.id, { preRelease: true, supersedes: first.draft.id })).rejects.toThrow('same contract');
  });
  it('exposes only reviewed records and requires canonical revealed receipt binding for verified status', async () => {
    const r = await engine(5, '1', true, true), draft = await reports.prepare(r.data.assessment.receipt.id, { preRelease: true });
    const storedReceipt = (await new GuardReceiptStore(db).get(r.data.assessment.receipt.id))!;
    const canonical: ReceiptLookup = { status: 'anchored', id: storedReceipt.receipt.id, kind: 'verdict', hash: Bytes32Schema.parse(storedReceipt.receipt.payloadHash),
      leaf: hash, canonicalization: 'jcs-rfc8785/v1', merkleRoot: hash, proof: [], batchId: 1, txHash: hash, block: 123, blockHash: hash,
      registry: r.data.assessment.coin, chainId: 4663, logIndex: 0, revealed: JSON.parse(canonicalize(storedReceipt.payload)), canonicalPayload: storedReceipt.canonicalPayload };
    const receipts = { get: async () => canonical }, app = Fastify();
    await ghostReportRoutes(app, reports, receipts);
    try {
      expect((await app.inject(`/v2/ghost-reports/${draft.draft.id}`)).statusCode).toBe(404);
      expect((await app.inject(`/v2/ghost-reports/${draft.draft.id}/share`)).statusCode).toBe(404);
      expect((await app.inject({ method: 'POST', url: '/v2/ghost-reports' })).statusCode).toBe(404);
      const reviewed = await approve(draft.draft.id);
      expect((await publicGhostReport(reviewed, receipts)).status).toBe('verified');
      expect((await publicGhostReport(reviewed, { get: async () => ({ ...canonical, hash: guardStorageHash('tampered') }) })).status).toBe('reviewed_partial');
      expect((await publicGhostReport(reviewed, { get: async () => { throw new Error('unavailable'); } })).receiptAnchored).toBe(false);
      const response = await app.inject(`/v2/ghost-reports/${draft.draft.id}`);
      expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json().status).toBe('verified');
      const list = await app.inject('/v2/ghost-reports'); expect(list.json().records.every((record: { review: unknown }) => record.review)).toBe(true);
      const share = (await app.inject(`/v2/ghost-reports/${draft.draft.id}/share`)).json().text;
      expect(share).toContain(`Receipt transaction: ${hash}`);
      expect((await app.inject('/v2/ghost-reports/invalid')).statusCode).toBe(422);
    } finally { await app.close(); }
  });
});
