import { createPublicKey, verify } from 'node:crypto';
import { z } from 'zod';
import { referenceDigest } from '@eko/chain';
import { guardStorageHash, reviewCaseId, reviewPins } from '@eko/db';
import { toUntrusted } from '@eko/untrusted';
import { Bytes32Schema, ReviewCaseSchema, ReviewQuestionsSchema, ReviewLabelSchema, ReviewAdjudicationSchema,
  guardKnownBy, type ReviewLabel, type ReviewAdjudication } from '@eko/shared';
import { AcquisitionDefinitionSchema, prepareAcquisition } from './acquisition-run.js';

export const LABEL_COMPLETION_VERSION = 'label-completion-059.1' as const;
const roles = ['reviewer_1', 'reviewer_2', 'adjudicator'] as const;
const hexKey = z.string().regex(/^[0-9a-f]{64}$/);
const signature = z.string().regex(/^[0-9a-f]{128}$/);
const blindedCase = ReviewCaseSchema.omit({ reveal: true }).strict();
const participant = z.strictObject({ id: Bytes32Schema, publicKey: hexKey,
  chainLiterate: z.literal(true), independentOfRuleAuthor: z.literal(true), evidenceIds: z.array(Bytes32Schema).min(1) });
// TODO(spec): §9.3 does not define offline signatures or assignment provisioning.
// Use a local Ed25519 envelope over existing 055 records, one token case per frozen
// draw member, and externally attested opaque roles. No public API or activation.
export const LabelAssignmentInputSchema = z.strictObject({ version: z.literal(LABEL_COMPLETION_VERSION),
  acquisition: AcquisitionDefinitionSchema, cases: z.array(blindedCase),
  roles: z.strictObject({ reviewer_1: participant.nullable(), reviewer_2: participant.nullable(), adjudicator: participant.nullable() }),
  labelVersion: z.string().regex(/^\d+\.\d+\.\d+$/), frozenAt: z.iso.datetime() });
export type LabelAssignmentInput = z.infer<typeof LabelAssignmentInputSchema>;
const same = (a: unknown, b: unknown) => referenceDigest(a) === referenceDigest(b);
const fail = (message: string): never => { throw new Error(message); };
function text(t: ReviewLabel['rationale']) {
  const clean = toUntrusted(t.text, 4000);
  if (!t.text.trim() || clean.text !== t.text || clean.flags.some(f => !t.flags.includes(f))) fail('Sanitized nonempty Untrusted rationale required');
}
function evidence(ids: string[], allowed: readonly string[]) {
  if (!ids.length || new Set(ids).size !== ids.length || ids.some(id => !allowed.includes(id))) fail('Pinned unique evidence required');
}

/** Export no decisions, defaults, score payloads or score-derived hashes. Every
 * selected token stays in the denominator, including purges and group holdouts. */
export function exportLabelAssignments(raw: LabelAssignmentInput) {
  const input = LabelAssignmentInputSchema.parse(raw), cohort = prepareAcquisition(input.acquisition);
  const assigned = roles.flatMap(role => input.roles[role] ? [input.roles[role]!] : []);
  if (new Set(assigned.map(a => a.id)).size !== assigned.length || new Set(assigned.map(a => a.publicKey)).size !== assigned.length)
    fail('Independent roles require distinct pseudonyms and signing keys');
  const sample = cohort.sample;
  if (!sample && input.cases.length) fail('Cases require a frozen probability draw');
  const coins = sample?.strata.flatMap(s => s.selected).sort() ?? [];
  if (new Set(input.cases.map(c => c.coin)).size !== input.cases.length || new Set(input.cases.map(c => c.caseId)).size !== input.cases.length)
    fail('One pinned case per selected token required');
  for (const c of input.cases) {
    const { id: _, revision: __, pins: ___, ...blinded } = c;
    const snapshot = { ...blinded, reveal: { points: null, level: null, legacyPoints: null, legacyLevel: null, allegedIncidentLabels: [] } };
    if (!coins.includes(c.coin) || c.origin !== input.acquisition.origin || c.sourceRevision !== sample!.frame.sourceRevision ||
        c.datasetHash !== cohort.manifestHash || c.cursor.chainId !== input.acquisition.chainId ||
        !guardKnownBy(c.availability, sample!.frame.availabilityCut) || !guardKnownBy({ cursor: c.cursor, acquisitionSequence: '0' }, c.availability))
      fail('Case differs from frozen cohort/source/dataset');
    if (c.id !== reviewCaseId(snapshot) || !same(c.pins, reviewPins(snapshot))) fail('Blinded 055 case/pin hash mismatch');
    if (assigned.some(a => a.id === c.ruleAuthorId)) fail('Rule author cannot occupy an independent role');
    evidence(c.evidenceIds, c.evidenceIds);
    for (const panel of c.panels) {
      if (panel.evidenceIds.length) evidence(panel.evidenceIds, c.evidenceIds);
      if (panel.status === 'supported' && !panel.evidenceIds.length) fail('Supported panel needs evidence');
      if (panel.text) text(panel.text);
    }
    for (const role of c.identity.roles) {
      if (role.evidenceIds.length) evidence(role.evidenceIds, c.evidenceIds);
      if ((role.status === 'verified') !== (role.address !== null) || role.status === 'verified' && !role.evidenceIds.length)
        fail('Identity role requires verified evidence or explicit unknown');
    }
  }
  const assignments = coins.map(coin => {
    const stratum = sample!.strata.find(s => s.selected.includes(coin))!;
    return { coin, stratum: stratum.id, inclusionProbability: stratum.inclusionProbability!,
      inclusionWeight: { numerator: String(stratum.N_h), denominator: String(stratum.n_h) },
      cohortDisposition: cohort.assignments!.find(a => a.coin === coin)!,
      case: input.cases.find(c => c.coin === coin) ?? null };
  });
  const body = { version: LABEL_COMPLETION_VERSION, origin: input.acquisition.origin, frozenAt: input.frozenAt,
    cohortHash: cohort.manifestHash, designHash: sample?.designHash ?? null, populationSize: sample?.populationSize ?? null,
    sampleSize: sample?.sampleSize ?? null, roles: input.roles, assignments, labelVersion: input.labelVersion,
    requirements: { independentSlotsPerToken: 2, requiredIndependentJudgments: sample ? sample.sampleSize * 2 : null,
      initialTargetTokens: 600, initialTargetJudgments: 1200, questions: Object.keys(ReviewQuestionsSchema.shape),
      evidenceRequired: true, unresolvedValid: true, scoresHidden: true, humanIndependenceRequiresExternalVerification: true },
    mode: 'shadow' as const, released: false as const };
  return { ...body, assignmentHash: referenceDigest(body) };
}
export type LabelAssignments = ReturnType<typeof exportLabelAssignments>;
const common = { version: z.literal(LABEL_COMPLETION_VERSION), assignmentHash: Bytes32Schema,
  origin: z.enum(['fixture', 'measured']), signature };
export const SignedDecisionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...common, kind: z.literal('independent'), independent: z.literal(true), record: ReviewLabelSchema }),
  z.strictObject({ ...common, kind: z.literal('adjudication'), record: ReviewAdjudicationSchema }),
]);
export type SignedDecision = z.infer<typeof SignedDecisionSchema>;
export function labelDecisionSigningBytes(value: Omit<SignedDecision, 'signature'> | SignedDecision) {
  const { signature: _, ...payload } = value as SignedDecision;
  return Buffer.from(referenceDigest(payload), 'utf8');
}
function verifiedDecision(raw: SignedDecision, plan: LabelAssignments) {
  const signed = SignedDecisionSchema.parse(raw), r = signed.record;
  if (signed.assignmentHash !== plan.assignmentHash || signed.origin !== plan.origin || r.labelVersion !== plan.labelVersion)
    fail('Decision assignment/origin/version mismatch');
  const c = plan.assignments.find(a => a.case?.id === r.caseRevisionId)?.case;
  if (!c) fail('Decision outside pinned case revisions');
  const role = signed.kind === 'independent' ? signed.record.slot : 'adjudicator';
  const actor = signed.kind === 'independent' ? signed.record.reviewerId : signed.record.adjudicatorId;
  const assignment = plan.roles[role] ?? fail('Decision signer not designated for role');
  if (assignment.id !== actor) fail('Decision signer not designated for role');
  const key = createPublicKey({ key: Buffer.from(`302a300506032b6570032100${assignment.publicKey}`, 'hex'), type: 'spki', format: 'der' });
  if (!verify(null, labelDecisionSigningBytes(signed), key, Buffer.from(signed.signature, 'hex'))) fail('Decision signature invalid');
  const { id, revision: _, submittedAt: __, ...identity } = r;
  if (id !== guardStorageHash(identity)) fail('055 immutable decision hash mismatch');
  if (Date.parse(r.submittedAt) < Date.parse(plan.frozenAt)) fail('Decision predates frozen assignment');
  evidence(r.evidenceIds, c!.evidenceIds); text(r.rationale);
  return signed;
}
type Judgment = ReviewLabel | ReviewAdjudication;
function revisionChain<T extends Judgment>(records: T[]) {
  const sorted = records.sort((a, b) => a.revision - b.revision);
  sorted.forEach((r, i) => {
    if (r.revision !== i + 1 || r.supersedes !== (sorted[i - 1]?.id ?? null) ||
        i > 0 && Date.parse(r.submittedAt) < Date.parse(sorted[i - 1].submittedAt)) fail('Immutable contiguous decision revision chain required');
  });
  return sorted;
}
const differences = (a: Judgment, b: Judgment) => (Object.keys(ReviewQuestionsSchema.shape) as (keyof ReviewLabel['answers'])[])
  .filter(key => a.answers[key] !== b.answers[key]);
const unresolved = (r: Judgment) => Object.values(r.answers).includes('unresolved');
function reversal(from: Judgment, to: Judgment) {
  const fields = differences(from, to);
  return { fromId: from.id, toId: to.id, changedQuestions: fields,
    controlReversal: fields.some(f => ['retrospectiveResponsibility', 'sellerControl', 'sellerOrigin'].includes(f)),
    basisChanged: fields.some(f => ['factsAndRoles', 'reasonSupport'].includes(f)) || !same(from.evidenceIds, to.evidenceIds) || !same(from.rationale, to.rationale) };
}

/** Append-only local import. Recompute the frozen assignment rather than trusting
 * claimed counts/hashes, and preserve all signed originals on every continuation. */
export function importLabelDecisions(input: LabelAssignmentInput, incoming: SignedDecision[], previous: SignedDecision[] = []) {
  const plan = exportLabelAssignments(input), records = new Map<string, SignedDecision>();
  for (const raw of [...previous, ...incoming]) {
    const signed = verifiedDecision(raw, plan), prior = records.get(signed.record.id);
    if (prior && !same(prior, signed)) fail('Immutable signed decision conflict');
    records.set(signed.record.id, signed);
  }
  const decisions = [...records.values()].sort((a, b) => a.record.id.localeCompare(b.record.id));
  const reversals: ReturnType<typeof reversal>[] = [];
  const cases = plan.assignments.map(a => {
    const records = decisions.filter(d => d.record.caseRevisionId === a.case?.id);
    const labels = roles.slice(0, 2).map(slot => revisionChain(records.flatMap(d =>
      d.kind === 'independent' && d.record.slot === slot ? [d.record] : [])));
    const adjudications = revisionChain(records.flatMap(d => d.kind === 'adjudication' ? [d.record] : []));
    for (const chain of [...labels, adjudications]) for (let i = 1; i < chain.length; i++) reversals.push(reversal(chain[i - 1], chain[i]));
    const latest = labels.map(chain => chain.at(-1));
    for (const adj of adjudications) {
      const referenced = adj.labelIds.map((id, i) => labels[i].find(l => l.id === id));
      if (referenced.some(l => !l || Date.parse(l.submittedAt) > Date.parse(adj.submittedAt))) fail('Adjudication requires both submitted independent labels');
      const currentAtSubmission = labels.map(chain => chain.filter(l => Date.parse(l.submittedAt) <= Date.parse(adj.submittedAt)).at(-1));
      if (currentAtSubmission.some((l, i) => l?.id !== adj.labelIds[i])) fail('Adjudication references stale independent decisions');
      for (const l of referenced) reversals.push(reversal(l!, adj));
    }
    const adjudication = adjudications.at(-1);
    const currentAdjudication = adjudication && latest.every((l, i) => l?.id === adjudication.labelIds[i]) ? adjudication : null;
    const disagreement = latest.every(Boolean) ? differences(latest[0]!, latest[1]!) : [];
    const effective = currentAdjudication ?? (latest.every(Boolean) && !disagreement.length ? latest[0]! : null);
    const missingSlots = (['reviewer_1', 'reviewer_2'] as const).filter((_, i) => !latest[i]);
    const status = missingSlots.length ? 'pending' : effective ? unresolved(effective) ? 'unresolved' : currentAdjudication ? 'adjudicated' : 'agreed'
      : disagreement.length ? 'disputed' : 'unresolved';
    return { coin: a.coin, caseRevisionId: a.case?.id ?? null, inclusionProbability: a.inclusionProbability, inclusionWeight: a.inclusionWeight,
      missingSlots, currentLabelIds: latest.map(l => l?.id ?? null), currentAdjudicationId: currentAdjudication?.id ?? null,
      disagreement, status, effectiveAnswers: effective?.answers ?? null,
      // The designated adjudicator sees only submitted decisions and evidence; no test scores.
      adjudicationTask: latest.every(Boolean) && !currentAdjudication && (disagreement.length > 0 || latest.some(l => unresolved(l!)))
        ? { adjudicatorId: plan.roles.adjudicator?.id ?? null, caseRevisionId: a.case!.id,
          labelIds: latest.map(l => l!.id), reason: disagreement.length ? 'disagreement' : 'unresolved' } : null };
  });
  const missingJudgments = cases.reduce((n, c) => n + c.missingSlots.length, 0);
  const blockers = [
    ...(!plan.designHash ? ['frozen_population_pending'] : !plan.sampleSize ? ['empty_probability_frame'] : []),
    ...(plan.assignments.some(a => !a.case) ? ['pinned_cases_missing'] : []),
    ...(roles.some(r => !plan.roles[r]) ? ['independent_roles_missing'] : []),
    ...(missingJudgments ? ['independent_judgments_missing'] : []),
    ...(cases.some(c => c.adjudicationTask) ? ['adjudication_pending'] : []),
    ...(cases.some(c => c.status === 'unresolved') ? ['unresolved_judgments'] : []),
  ];
  const labelSetHash = referenceDigest({ version: LABEL_COMPLETION_VERSION, assignmentHash: plan.assignmentHash, decisions });
  return { plan, decisions, cases, reversals, labelSetHash, counts: { population: plan.populationSize, selectedTokens: plan.sampleSize,
    requiredIndependentJudgments: plan.requirements.requiredIndependentJudgments, submittedIndependentJudgments: cases.reduce((n, c) => n + 2 - c.missingSlots.length, 0),
    independentRevisions: decisions.filter(d => d.kind === 'independent').length, adjudicationRevisions: decisions.filter(d => d.kind === 'adjudication').length,
    missingCases: plan.assignments.filter(a => !a.case).length, missingJudgments, unresolvedCases: cases.filter(c => c.status === 'unresolved').length,
    disputedCases: cases.filter(c => c.status === 'disputed').length, pendingAdjudications: cases.filter(c => c.adjudicationTask).length },
    blockers, importComplete: blockers.length === 0, measuredHumanValidation: false,
    humanSignoff: 'external_verification_required', mode: 'shadow', released: false };
}
