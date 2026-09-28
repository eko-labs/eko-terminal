import { z } from 'zod';
const stage = z.enum(['acquisition', 'probe', 'pressure', 'critical', 'lower', 'head', 'scan', 'preflight']);
const sample = z.strictObject({ stage, venue: z.enum(['pons_curve', 'v3', 'v4', 'other']),
  ageSec: z.number().nonnegative().finite(), queueMs: z.number().nonnegative().finite(),
  workMs: z.number().nonnegative().finite(), status: z.enum(['complete', 'missing', 'failed', 'pending']) });
export type GuardPerformanceSample = z.infer<typeof sample>;
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const pin = z.strictObject({ sourceRevision: revision, candidateRevision: revision, validation: z.enum(['fixture', 'measured']),
  evaluations: z.number().int().nonnegative().safe(), elapsedMs: z.number().nonnegative().finite(), evaluatorRpc: z.number().int().nonnegative().safe(),
  priorEvaluationsPerSec: z.number().nonnegative().finite().nullable(), pilotTargetRef: revision.nullable() });
const p95 = (values: number[]) => values.length ? [...values].sort((a,b) => a-b)[Math.ceil(values.length * .95)-1] : null;
const age = (sec: number) => sec < 300 ? 'under_300s' : sec < 3600 ? '300_to_3600s' : sec < 86400 ? '3600_to_86400s' : 'at_least_86400s';

/** An incomplete fast response never enters the full-completion latency population.
 * Missing sample populations stay null; this report cannot freeze a pilot or activate Guard. */
export function reportGuardPerformance(rawPin: z.infer<typeof pin>, rawSamples: GuardPerformanceSample[]) {
  const p = pin.parse(rawPin), samples = rawSamples.map(s => sample.parse(s));
  const rate = p.elapsedMs > 0 ? p.evaluations * 1000 / p.elapsedMs : null;
  const groups = [...new Set(samples.map(s => `${s.stage}:${s.venue}:${age(s.ageSec)}`))].sort().map(key => {
    const rows = samples.filter(s => `${s.stage}:${s.venue}:${age(s.ageSec)}` === key), completed = rows.filter(s => s.status === 'complete');
    return { key, samples: rows.length, completed: completed.length, missing: rows.filter(s => s.status === 'missing').length,
      failed: rows.filter(s => s.status === 'failed').length, pending: rows.filter(s => s.status === 'pending').length,
      responseP95Ms: p95(rows.map(s => s.workMs)), queueP95Ms: p95(rows.map(s => s.queueMs)),
      completionP95Ms: p95(completed.map(s => s.queueMs + s.workMs)) };
  });
  const budgets = ([['head', 1000, false], ['scan', 5000, false], ['preflight', 150, true]] as const).map(([stage, targetMs, strict]) => {
    const rows = samples.filter(s => s.stage === stage), completed = rows.filter(s => s.status === 'complete');
    const measured = p95(completed.map(s => s.workMs + s.queueMs));
    return { stage, targetMs, strict, p95Ms: measured, completed: completed.length, total: rows.length,
      met: measured === null ? null : strict ? measured < targetMs : measured <= targetMs,
      allRequiredComplete: rows.length > 0 && completed.length === rows.length };
  });
  return { ...p, evaluationsPerSec: rate, targetEvaluationsPerSec: 170, targetMet: rate === null ? null : rate >= 170,
    regressionPct: rate === null || !p.priorEvaluationsPerSec ? null : 100 * (rate - p.priorEvaluationsPerSec) / p.priorEvaluationsPerSec,
    zeroEvaluatorRpc: p.evaluatorRpc === 0, groups, budgets,
    operatingTargetStatus: p.pilotTargetRef === null ? 'unavailable' : 'supplied_reference_only', released: false };
}
