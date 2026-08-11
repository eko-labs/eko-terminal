import { z } from 'zod';

// BACKEND §8.4: bounded structured votes, without model-written prose.
export const SwarmSnapshotHashSchema = z.string().regex(/^0x[0-9a-f]{64}$/);
export const SwarmBlockSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const PersonaIdSchema = z.string().min(1).max(32).regex(/^[a-z][a-z0-9_]*$/);
export const PersonaExitSchema = z.strictObject({
  tp_pct: z.number().min(1).max(1000),
  sl_pct: z.number().min(1).max(100),
  max_hold_min: z.number().int().min(1).max(10080),
});
export const PersonaVoteSchema = z.strictObject({
  persona_id: PersonaIdSchema,
  action: z.enum(['ape', 'wait', 'pass']),
  size_bucket: z.enum(['none', 's', 'm', 'l']),
  exit: PersonaExitSchema,
  confidence: z.number().min(0).max(1),
});
export const VoteBatchSchema = z.strictObject({
  snapshot_hash: SwarmSnapshotHashSchema,
  as_of_block: SwarmBlockSchema,
  votes: z.array(PersonaVoteSchema).min(1).max(10),
});
export type PersonaVote = z.infer<typeof PersonaVoteSchema>;
export type VoteBatch = z.infer<typeof VoteBatchSchema>;

const ContextSchema = z.strictObject({
  snapshotHash: SwarmSnapshotHashSchema,
  asOfBlock: SwarmBlockSchema,
  headBlock: SwarmBlockSchema,
  personas: z.array(PersonaIdSchema).min(1).max(10),
});
export type PersonaBatchContext = z.infer<typeof ContextSchema>;
export type PersonaBatchValidation =
  | { ok: true; output: VoteBatch }
  | { ok: false; code: 'malformed' | 'invalid_context' | 'snapshot_mismatch' | 'stale' | 'persona_mismatch' | 'contradictory'; reason: string };

/** Acceptance validates a behavioural forecast; it never grants trade permission. */
export function validatePersonaBatch(raw: unknown, context: PersonaBatchContext): PersonaBatchValidation {
  const c = ContextSchema.safeParse(context);
  if (!c.success || c.data.headBlock < c.data.asOfBlock || new Set(c.data.personas).size !== c.data.personas.length) {
    return { ok: false, code: 'invalid_context', reason: 'invalid snapshot context' };
  }
  const p = VoteBatchSchema.safeParse(raw);
  // Never reflect hostile output (including schema paths) into rejection prose.
  if (!p.success) return { ok: false, code: 'malformed', reason: 'invalid vote batch' };
  const o = p.data;
  if (o.snapshot_hash !== c.data.snapshotHash || o.as_of_block !== c.data.asOfBlock) {
    return { ok: false, code: 'snapshot_mismatch', reason: 'echoed snapshot differs' };
  }
  if (c.data.headBlock - c.data.asOfBlock > 600) return { ok: false, code: 'stale', reason: 'older than 600 blocks' };
  const ids = new Set(o.votes.map(v => v.persona_id));
  if (ids.size !== o.votes.length || ids.size !== c.data.personas.length || c.data.personas.some(id => !ids.has(id))) {
    return { ok: false, code: 'persona_mismatch', reason: 'wrong persona set' };
  }
  if (o.votes.some(v => (v.action === 'ape') !== (v.size_bucket !== 'none'))) {
    return { ok: false, code: 'contradictory', reason: 'size vs action' };
  }
  return { ok: true, output: o };
}
