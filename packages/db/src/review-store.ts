import {
  GUARD_REVIEW_VERSION, ReviewCaseInputSchema, ReviewCaseSchema, ReviewLabelInputSchema, ReviewLabelSchema,
  ReviewAdjudicationInputSchema, ReviewAdjudicationSchema, ReviewViewSchema, ReviewExportSchema,
  ReviewPseudonymSchema, ReviewRoleSchema, Bytes32Schema, guardKnownBy,
  type ReviewCase, type ReviewCaseInput, type ReviewLabel, type ReviewLabelInput, type ReviewAdjudication,
  type ReviewAdjudicationInput, type ReviewRole, type ReviewView, type Untrusted,
} from '@eko/shared';
import { toUntrusted } from '@eko/untrusted';
import type { ChainDb } from './client.js';
import { guardStorageHash } from './guard-store.js';

export class ReviewError extends Error {
  constructor(readonly statusCode: 403 | 404 | 409 | 400, message: string) { super(message); }
}
const fail = (message: string): never => { throw new ReviewError(409, message); };
const same = (a: unknown, b: unknown) => guardStorageHash(a) === guardStorageHash(b);
export const reviewAccountHash = (accountId: string) => guardStorageHash({ reviewAccount: accountId });
// Public revision IDs hash only blinded facts. A digest of hidden low-entropy
// scores would allow a reviewer to enumerate candidate points before submission.
export function reviewCaseId(c: ReviewCaseInput) {
  const { reveal: _, ...blinded } = c;
  return guardStorageHash(blinded);
}
export function reviewPins(c: ReviewCaseInput) {
  return { cursorHash: guardStorageHash(c.cursor), availabilityHash: guardStorageHash(c.availability),
    identityHash: guardStorageHash(c.identity), outcomeHash: guardStorageHash(c.machineOutcome),
    methodHash: guardStorageHash(c.method), datasetHash: c.datasetHash,
    evidenceHash: guardStorageHash({ evidenceIds: c.evidenceIds, panels: c.panels }) };
}
function validateText(t: Untrusted) {
  const clean = toUntrusted(t.text, 4000);
  if (clean.text !== t.text || clean.flags.some(f => !t.flags.includes(f))) throw new ReviewError(400, 'Review text must be sanitized Untrusted text');
}
function validateEvidence(ids: string[], c: ReviewCase) {
  if (new Set(ids).size !== ids.length || ids.some(id => !c.evidenceIds.includes(id as `0x${string}`))) throw new ReviewError(400, 'Review evidence is outside the pinned case');
}
type Assignment = { account_hash: string; pseudonym: `0x${string}`; role: ReviewRole };
async function row<T>(db: ChainDb, table: 'review_case_revisions' | 'review_labels' | 'review_adjudications', id: string): Promise<T | null> {
  return (await db.sql.query<{ data: T }>(`SELECT data FROM ${table} WHERE id=$1`, [id])).rows[0]?.data ?? null;
}
async function loadCase(db: ChainDb, id: string) {
  const value = await row<ReviewCase>(db, 'review_case_revisions', Bytes32Schema.parse(id));
  if (!value) throw new ReviewError(404, 'Review revision unavailable');
  const c = ReviewCaseSchema.parse(value);
  const { id: _, revision: __, pins, ...input } = c;
  if (c.id !== reviewCaseId(input) || !same(pins, reviewPins(input))) fail('Review case hash mismatch');
  return c;
}
async function assignment(db: ChainDb, c: ReviewCase, accountId: string): Promise<Assignment> {
  const a = (await db.sql.query<Assignment>('SELECT account_hash,pseudonym,role FROM review_assignments WHERE case_id=$1 AND account_hash=$2', [c.caseId, reviewAccountHash(accountId)])).rows[0];
  if (!a) throw new ReviewError(403, 'Review assignment required');
  return a;
}
async function labels(db: ChainDb, id: string) {
  return (await db.sql.query<{ data: unknown }>('SELECT data FROM review_labels WHERE case_revision_id=$1 ORDER BY slot,revision', [id])).rows.map(r => ReviewLabelSchema.parse(r.data));
}
const latestLabels = (all: ReviewLabel[]) => ['reviewer_1', 'reviewer_2'].map(slot => all.filter(l => l.slot === slot).at(-1));
function reviewStatus(all: ReviewLabel[], adjudications: ReviewAdjudication[]): NonNullable<ReviewView['status']> {
  const current = latestLabels(all);
  if (current.some(l => !l)) return 'pending';
  if (adjudications.at(-1)?.labelIds.every((id, i) => id === current[i]!.id)) return 'adjudicated';
  if (current.some(l => Object.values(l!.answers).includes('unresolved'))) return 'unresolved';
  return same(current[0]!.answers, current[1]!.answers) ? 'agreed' : 'disputed';
}

/** Evals-only append API. Caller identities come from authenticated sessions,
 * assignments are provisioned separately; no reviewer IDs are accepted with labels. */
export class ReviewStore {
  readonly writer = 'evals';
  constructor(readonly db: ChainDb, readonly now: () => Date = () => new Date()) {}
  async putCase(raw: ReviewCaseInput): Promise<ReviewCase> {
    const input = ReviewCaseInputSchema.parse(raw), id = reviewCaseId(input);
    if (!guardKnownBy({ cursor: input.cursor, acquisitionSequence: '0' }, input.availability)) throw new ReviewError(400, 'Review cursor exceeds captured availability');
    for (const t of [...input.panels.flatMap(p => p.text ? [p.text] : []), ...input.reveal.allegedIncidentLabels]) validateText(t);
    return this.db.tx(async tx => {
      await tx.sql.query('SELECT pg_advisory_xact_lock(hashtext($1))', [input.caseId]);
      const existing = await row<ReviewCase>(tx, 'review_case_revisions', id);
      if (existing) {
        const { id: _, revision: __, pins: ___, ...original } = existing;
        if (!same(original, input)) fail('Review case content conflict');
        return loadCase(tx, id);
      }
      const previous = (await tx.sql.query<{ data: ReviewCase }>('SELECT data FROM review_case_revisions WHERE case_id=$1 ORDER BY revision DESC LIMIT 1', [input.caseId])).rows[0]?.data;
      if (input.supersedes !== (previous?.id ?? null)) fail('Review case revision conflict');
      if (previous && (previous.coin !== input.coin || previous.cursor.chainId !== input.cursor.chainId || previous.ruleAuthorId !== input.ruleAuthorId || !same(previous.context, input.context) || previous.datasetHash !== input.datasetHash || previous.origin !== input.origin)) fail('Review case identity changed');
      const c = ReviewCaseSchema.parse({ ...input, id, revision: (previous?.revision ?? 0) + 1, pins: reviewPins(input) });
      validateEvidence(input.evidenceIds, c);
      for (const p of input.panels) {
        validateEvidence(p.evidenceIds, c);
        if (p.status === 'supported' && !p.evidenceIds.length) throw new ReviewError(400, 'Supported panel needs evidence');
      }
      for (const r of input.identity.roles) {
        validateEvidence(r.evidenceIds, c);
        if ((r.status === 'verified') !== (r.address !== null) || r.status === 'verified' && !r.evidenceIds.length) throw new ReviewError(400, 'Role needs verified evidence or explicit unknown');
      }
      await tx.sql.query('INSERT INTO review_cases(id,coin,rule_author_id) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING', [input.caseId, input.coin, input.ruleAuthorId]);
      await tx.sql.query('INSERT INTO review_case_revisions(id,case_id,revision,supersedes,data) VALUES($1,$2,$3,$4,$5)', [id, c.caseId, c.revision, c.supersedes, JSON.stringify(c)]);
      return c;
    });
  }
  async assign(caseId: string, accountId: string, pseudonym: string, role: ReviewRole) {
    const key = Bytes32Schema.parse(caseId), actor = ReviewPseudonymSchema.parse(pseudonym), r = ReviewRoleSchema.parse(role), accountHash = reviewAccountHash(accountId);
    return this.db.tx(async tx => {
      await tx.sql.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
      const c = (await tx.sql.query<{ rule_author_id: string }>('SELECT rule_author_id FROM review_cases WHERE id=$1', [key])).rows[0];
      if (!c) throw new ReviewError(404, 'Review case unavailable');
      if (r !== 'evaluator' && actor === c.rule_author_id) throw new ReviewError(403, 'Rule author cannot occupy an independent review role');
      const existing = (await tx.sql.query<Assignment>('SELECT * FROM review_assignments WHERE case_id=$1 AND (account_hash=$2 OR pseudonym=$3 OR role=$4)', [key, accountHash, actor, r])).rows;
      if (existing.length) {
        if (existing.length === 1 && existing[0].account_hash === accountHash && existing[0].pseudonym === actor && existing[0].role === r) return;
        fail('Review roles require distinct accounts and pseudonyms');
      }
      await tx.sql.query('INSERT INTO review_assignments(case_id,account_hash,pseudonym,role) VALUES($1,$2,$3,$4)', [key, accountHash, actor, r]);
    });
  }
  async role(caseRevisionId: string, accountId: string): Promise<ReviewRole> {
    const c = await loadCase(this.db, caseRevisionId);
    return (await assignment(this.db, c, accountId)).role;
  }
  async submit(caseRevisionId: string, accountId: string, raw: ReviewLabelInput): Promise<ReviewLabel> {
    const input = ReviewLabelInputSchema.parse(raw); validateText(input.rationale);
    return this.db.tx(async tx => {
      const c = await loadCase(tx, caseRevisionId);
      await tx.sql.query('SELECT pg_advisory_xact_lock(hashtext($1))', [c.caseId]);
      const a = await assignment(tx, c, accountId);
      if (a.role !== 'reviewer_1' && a.role !== 'reviewer_2') throw new ReviewError(403, 'Independent reviewer role required');
      validateEvidence(input.evidenceIds, c);
      const identity = { ...input, caseRevisionId: c.id, reviewerId: a.pseudonym, slot: a.role }, id = guardStorageHash(identity);
      const existing = await row<ReviewLabel>(tx, 'review_labels', id);
      if (existing) return ReviewLabelSchema.parse(existing);
      const previous = (await labels(tx, c.id)).filter(l => l.slot === a.role).at(-1);
      if (input.supersedes !== (previous?.id ?? null)) fail('Review label revision conflict');
      const label = ReviewLabelSchema.parse({ ...identity, id, revision: (previous?.revision ?? 0) + 1, submittedAt: this.now().toISOString() });
      await tx.sql.query('INSERT INTO review_labels(id,case_revision_id,slot,revision,supersedes,data) VALUES($1,$2,$3,$4,$5,$6)', [id, c.id, a.role, label.revision, label.supersedes, JSON.stringify(label)]);
      return label;
    });
  }
  async adjudicate(caseRevisionId: string, accountId: string, raw: ReviewAdjudicationInput): Promise<ReviewAdjudication> {
    const input = ReviewAdjudicationInputSchema.parse(raw); validateText(input.rationale);
    return this.db.tx(async tx => {
      const c = await loadCase(tx, caseRevisionId);
      await tx.sql.query('SELECT pg_advisory_xact_lock(hashtext($1))', [c.caseId]);
      const a = await assignment(tx, c, accountId);
      if (a.role !== 'adjudicator') throw new ReviewError(403, 'Adjudicator role required');
      validateEvidence(input.evidenceIds, c);
      const current = latestLabels(await labels(tx, c.id));
      if (current.some((l, i) => !l || l.id !== input.labelIds[i])) fail('Adjudication needs both current independent labels');
      const identity = { ...input, caseRevisionId: c.id, adjudicatorId: a.pseudonym }, id = guardStorageHash(identity);
      const existing = await row<ReviewAdjudication>(tx, 'review_adjudications', id);
      if (existing) return ReviewAdjudicationSchema.parse(existing);
      const previous = (await tx.sql.query<{ data: ReviewAdjudication }>('SELECT data FROM review_adjudications WHERE case_revision_id=$1 ORDER BY revision DESC LIMIT 1', [c.id])).rows[0]?.data;
      if (input.supersedes !== (previous?.id ?? null)) fail('Review adjudication revision conflict');
      const adjudication = ReviewAdjudicationSchema.parse({ ...identity, id, revision: (previous?.revision ?? 0) + 1, submittedAt: this.now().toISOString() });
      await tx.sql.query('INSERT INTO review_adjudications(id,case_revision_id,revision,supersedes,data) VALUES($1,$2,$3,$4,$5)', [id, c.id, adjudication.revision, adjudication.supersedes, JSON.stringify(adjudication)]);
      return adjudication;
    });
  }
  async view(caseRevisionId: string, accountId: string): Promise<ReviewView> {
    return this.db.tx(async tx => {
      const c = await loadCase(tx, caseRevisionId);
      // A coherent read cannot mix labels with an adjudication of a newer revision.
      await tx.sql.query('SELECT pg_advisory_xact_lock(hashtext($1))', [c.caseId]);
      const a = await assignment(tx, c, accountId), all = await labels(tx, c.id), current = latestLabels(all);
      const revealed = a.role === 'evaluator' || (a.role === 'adjudicator' ? current.every(Boolean) : all.some(l => l.reviewerId === a.pseudonym));
      const adjudications = revealed ? (await tx.sql.query<{ data: unknown }>('SELECT data FROM review_adjudications WHERE case_revision_id=$1 ORDER BY revision', [c.id])).rows.map(r => ReviewAdjudicationSchema.parse(r.data)) : [];
      const { reveal, ...snapshot } = c;
      return ReviewViewSchema.parse({ version: GUARD_REVIEW_VERSION, blinded: !revealed, case: snapshot,
        reveal: revealed ? reveal : null, labels: revealed ? all : [], adjudications, status: revealed ? reviewStatus(all, adjudications) : null });
    });
  }
  async export(caseId: string, accountId: string) {
    return this.db.tx(async tx => {
      const key = Bytes32Schema.parse(caseId);
      await tx.sql.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
      const records = (await tx.sql.query<{ id: string }>('SELECT id FROM review_case_revisions WHERE case_id=$1 ORDER BY revision', [key])).rows;
      if (!records.length) throw new ReviewError(404, 'Review case unavailable');
      const store = new ReviewStore(tx, this.now), revisions: ReviewView[] = [];
      for (const r of records) revisions.push(await store.view(r.id, accountId));
      const body = { version: GUARD_REVIEW_VERSION, caseId: key, revisions };
      return ReviewExportSchema.parse({ ...body, exportHash: guardStorageHash(body) });
    });
  }
}
