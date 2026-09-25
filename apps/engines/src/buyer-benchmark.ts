import { z } from 'zod';
import { Bytes32Schema, RationalSchema, type Rational } from '@eko/shared';
import { referenceDigest } from '@eko/chain';
import { BuyerBenchmarkManifestSchema, BenchmarkEntrySchema, BenchmarkExitSchema, type BuyerBenchmarkManifest,
  type BenchmarkFrame, type BenchmarkEntry, type BenchmarkExit, type BenchmarkGas } from './buyer-benchmark-input.js';

export const benchmarkRational = (n: bigint, d = 1n): Rational => {
  if (d <= 0n) throw new Error('Invalid benchmark denominator');
  let a = n < 0n ? -n : n, b = d; while (b) [a, b] = [b, a % b];
  return { numerator: (n / a).toString(), denominator: (d / a).toString() };
};
const read = (r: Rational) => ({ n: BigInt(r.numerator), d: BigInt(r.denominator) });
const add = (a: Rational, b: Rational) => { const x = read(a), y = read(b); return benchmarkRational(x.n * y.d + y.n * x.d, x.d * y.d); };
const mul = (a: Rational, b: Rational) => { const x = read(a), y = read(b); return benchmarkRational(x.n * y.n, x.d * y.d); };
const neg = (a: Rational) => ({ ...a, numerator: (-BigInt(a.numerator)).toString() });
const cmp = (a: Rational, b: Rational) => { const x = read(a), y = read(b); return x.n * y.d < y.n * x.d ? -1 : x.n * y.d > y.n * x.d ? 1 : 0; };
const pct = (value: Rational, cost: Rational) => {
  const c = read(cost); if (c.n <= 0n) throw new Error('Nonpositive benchmark entry cost');
  return mul(add(value, neg(cost)), benchmarkRational(100n * c.d, c.n));
};
const gasQuote = (g: BenchmarkGas) => add(g.executionQuote, g.l1Quote);
export type BenchmarkMethod = 'paper' | 'persistent';
export type BenchmarkPath = { delaySec: 5 | 30 | 60 | 300; sizeUsd: 100 | 1000; account: string; accountClass: 'eoa' | 'contract'; method: BenchmarkMethod; stress: boolean };
export interface BenchmarkAdapter {
  version: string;
  /** Local only. Buy includes impact and preserves purchase-dependent account storage. */
  enter(m: BuyerBenchmarkManifest, path: BenchmarkPath, frame: BenchmarkFrame, requestedQuote: string): BenchmarkEntry;
  /** Each liquidation is isolated; persistent replay must retain every original transaction/constraint, failing closed. */
  exit(m: BuyerBenchmarkManifest, path: BenchmarkPath, entry: Extract<BenchmarkEntry, { status: 'purchased' }>, entryIndex: number, exitIndex: number): BenchmarkExit;
}
export function benchmarkReturns(m: BuyerBenchmarkManifest, entry: Extract<BenchmarkEntry, { status: 'purchased' }>,
  entryFrame: BenchmarkFrame, exit: BenchmarkExit, exitFrame: BenchmarkFrame) {
  const entryQuote = add(benchmarkRational(BigInt(entry.spentQuote)), gasQuote(entry.gas));
  const usd = (quote: Rational, frame: BenchmarkFrame) => frame.quoteUsd ? mul(quote, mul(frame.quoteUsd, benchmarkRational(1n, 10n ** BigInt(m.quoteDecimals)))) : null;
  const spentUsd = usd(benchmarkRational(BigInt(entry.spentQuote)), entryFrame);
  const allInEntryUsd = spentUsd && entry.gas.usd ? add(spentUsd, entry.gas.usd) : null;
  let netQuote: Rational | null = null, netExitQuoteUsd: Rational | null = null;
  if (exit.status === 'executed' || exit.status === 'token_failure' && exit.grossQuote !== null) {
    const gross = benchmarkRational(BigInt(exit.grossQuote!));
    netQuote = add(gross, neg(gasQuote(exit.gas)));
    const grossUsd = usd(gross, exitFrame);
    netExitQuoteUsd = grossUsd && exit.gas.usd ? add(grossUsd, neg(exit.gas.usd)) : null;
  }
  const returnPct = netExitQuoteUsd && allInEntryUsd ? pct(netExitQuoteUsd, allInEntryUsd) : null;
  const quoteReturnPct = netQuote ? pct(netQuote, entryQuote) : null;
  const blocked = exit.status === 'token_failure' && exit.verifiedNoExit && exit.validScheduledState;
  return { allInEntryQuote: entryQuote, allInEntryUsd, netQuote, netExitQuoteUsd, quoteReturnPct, returnPct,
    severelyHurt: blocked ? true : returnPct ? cmp(returnPct, benchmarkRational(-30n)) <= 0 : null,
    quoteHurt: blocked ? true : quoteReturnPct ? cmp(quoteReturnPct, benchmarkRational(-30n)) <= 0 : null };
}
const pathSchema = z.strictObject({ delaySec: z.union([z.literal(5), z.literal(30), z.literal(60), z.literal(300)]),
  sizeUsd: z.union([z.literal(100), z.literal(1000)]), account: z.string(), accountClass: z.enum(['eoa', 'contract']),
  method: z.enum(['paper', 'persistent']), stress: z.boolean() });
const taskSchema = z.strictObject({ path: pathSchema, entryIndex: z.number().int().nonnegative().nullable(),
  stage: z.enum(['entry', 'exit']), exitIndex: z.number().int().nonnegative().nullable(), deadlineSec: z.string().regex(/^\d+$/).nullable() });
type Task = z.infer<typeof taskSchema>;
export const BenchmarkCheckpointSchema = z.strictObject({ version: z.literal(1), manifestHash: Bytes32Schema, candidateRevision: Bytes32Schema,
  status: z.enum(['prepared', 'running', 'stopped', 'complete']), reason: z.enum(['shutdown_requested', 'source_reorg']).nullable(),
  artifacts: z.array(z.strictObject({ key: Bytes32Schema, task: taskSchema, hash: Bytes32Schema })) });
export type BenchmarkCheckpoint = z.infer<typeof BenchmarkCheckpointSchema>;
export const initialBenchmarkCheckpoint = (m: BuyerBenchmarkManifest, candidateRevision: string): BenchmarkCheckpoint =>
  BenchmarkCheckpointSchema.parse({ version: 1, manifestHash: referenceDigest(BuyerBenchmarkManifestSchema.parse(m)), candidateRevision,
    status: 'prepared', reason: null, artifacts: [] });
export interface BenchmarkIO {
  artifact(key: string): Promise<unknown | null>; putArtifact(key: string, value: BenchmarkEntry | BenchmarkExit): Promise<void>;
  save(checkpoint: BenchmarkCheckpoint): Promise<void>; sourceRevision(): Promise<string>; stopped(): boolean;
}
class BenchmarkStop extends Error {}
const firstAt = (m: BuyerBenchmarkManifest, sec: bigint) => { const index = m.frames.findIndex(f => BigInt(f.cursor.timestampSec) >= sec); return index < 0 ? null : index; };
export function benchmarkPaths(m: BuyerBenchmarkManifest): BenchmarkPath[] {
  return ([5, 30, 60, 300] as const).flatMap(delaySec => ([100, 1000] as const).flatMap(sizeUsd =>
    m.accounts.flatMap(a => (['paper', 'persistent'] as const).flatMap(method =>
      (m.nextBlockStress ? [false, true] : [false]).map(stress => ({ delaySec, sizeUsd, ...a, method, stress }))))));
}
export async function runBuyerBenchmark(raw: BuyerBenchmarkManifest, checkpoint: BenchmarkCheckpoint, io: BenchmarkIO,
  adapter: BenchmarkAdapter, candidateRevision: string) {
  const m = BuyerBenchmarkManifestSchema.parse(raw), c = BenchmarkCheckpointSchema.parse(checkpoint);
  if (c.manifestHash !== referenceDigest(m) || c.candidateRevision !== candidateRevision || adapter.version !== m.adapterVersion)
    throw new Error('Benchmark source/candidate/adapter mismatch');
  if (new Set(c.artifacts.map(a => a.key)).size !== c.artifacts.length || c.artifacts.some(a => a.key !== referenceDigest({ manifest: c.manifestHash, task: a.task })))
    throw new Error('Benchmark checkpoint ledger mismatch');
  const cached = new Map<string, BenchmarkEntry | BenchmarkExit>();
  // Validate every completed artifact even when a stopped strategy no longer requests it.
  for (const a of c.artifacts) {
    const value = await io.artifact(a.key);
    if (!value || referenceDigest(value) !== a.hash) throw new Error('Benchmark artifact missing or changed');
    cached.set(a.key, (a.task.stage === 'entry' ? BenchmarkEntrySchema : BenchmarkExitSchema).parse(value));
  }
  const save = async () => { Object.assign(checkpoint, c); await io.save(c); };
  const check = async () => {
    if (io.stopped()) throw new BenchmarkStop('shutdown_requested');
    if (await io.sourceRevision() !== m.sourceRevision) throw new BenchmarkStop('source_reorg');
  };
  const compute = async <T extends BenchmarkEntry | BenchmarkExit>(task: Task, work: () => T): Promise<T> => {
    await check(); const key = referenceDigest({ manifest: c.manifestHash, task });
    const prior = cached.get(key); if (prior) return prior as T;
    // Local pure work may be recomputed after a crash; no remote dispatch or mutable reserve session.
    const value = work(); await check();
    await io.putArtifact(key, value);
    c.artifacts.push({ key, task, hash: referenceDigest(value) }); cached.set(key, value); await save(); return value;
  };
  const rows: { id: string; path: BenchmarkPath; primary: boolean; coin: string; venue: string; routeId: string; configHash: string;
    entryCursor: BenchmarkFrame['cursor'] | null; entryKnownAt: BenchmarkFrame['knownAt'] | null; actualDelaySec: string | null; predictor: BenchmarkFrame['predictors'][number] | null;
    entry: BenchmarkEntry; checkpoints: { deadlineSec: string; cursor: BenchmarkFrame['cursor'] | null; exit: BenchmarkExit; returns: ReturnType<typeof benchmarkReturns> | null }[];
    strategies: { kind: 'fixed_300' | 'fixed_3600' | 'fixed_86400' | 'stop_target'; status: 'completed' | 'censored' | 'indeterminate'; checkpoint: number; trigger: string }[];
    retries: number[] }[] = [];
  c.status = 'running'; c.reason = null; await save();
  try {
    for (const path of benchmarkPaths(m)) {
      await check();
      const scheduled = firstAt(m, BigInt(m.launch.timestampSec) + BigInt(path.delaySec));
      const entryIndex = scheduled === null ? null : path.stress ? scheduled + 1 < m.frames.length ? scheduled + 1 : null : scheduled;
      const frame = entryIndex === null ? null : m.frames[entryIndex];
      const entry = await compute<BenchmarkEntry>({ path, entryIndex, stage: 'entry', exitIndex: null, deadlineSec: null }, () => {
        if (!frame || frame.status === 'data_gap' || frame.status === 'provider_gap') return { status: 'censored', reason: frame?.status === 'provider_gap' ? 'provider_gap' : 'data_gap', evidenceIds: frame?.evidenceIds ?? [] };
        if (frame.status === 'unsupported') return { status: 'unsupported', reason: 'unsupported', evidenceIds: frame.evidenceIds };
        if (!frame.quoteUsd) return { status: 'censored', reason: 'usd_missing', evidenceIds: frame.evidenceIds };
        const price = read(frame.quoteUsd), requested = BigInt(path.sizeUsd) * 10n ** BigInt(m.quoteDecimals) * price.d / price.n;
        if (requested === 0n) return { status: 'entry_unavailable', reason: 'entry_failed', evidenceIds: frame.evidenceIds };
        const result = BenchmarkEntrySchema.parse(adapter.enter(m, path, frame, requested.toString()));
        if (result.status === 'purchased' && BigInt(result.spentQuote) > requested) throw new Error('Entry spent exceeds requested size');
        return result;
      });
      const row: (typeof rows)[number] = { id: referenceDigest({ manifest: c.manifestHash, path }), path,
        primary: path.delaySec === 60 && !path.stress, coin: m.coin, venue: m.venue, routeId: m.routeId, configHash: m.configHash,
        entryCursor: frame?.cursor ?? null, entryKnownAt: frame?.knownAt ?? null, actualDelaySec: frame ? (BigInt(frame.cursor.timestampSec) - BigInt(m.launch.timestampSec)).toString() : null,
        predictor: frame?.predictors.find(p => p.sizeUsd === path.sizeUsd && p.accountClass === path.accountClass) ?? null,
        entry, checkpoints: [], strategies: [], retries: [] };
      rows.push(row);
      if (entry.status !== 'purchased' || !frame || entryIndex === null) continue;
      const entryTime = BigInt(frame.cursor.timestampSec);
      const attempt = async (deadline: bigint) => {
        // Deadline is in the key even when sparse blocks resolve two deadlines to one state.
        const exitIndex = firstAt(m, deadline);
        const existing = row.checkpoints.findIndex(x => x.deadlineSec === deadline.toString()); if (existing >= 0) return existing;
        const at = exitIndex === null ? null : m.frames[exitIndex];
        const exit = await compute<BenchmarkExit>({ path, entryIndex, stage: 'exit', exitIndex, deadlineSec: deadline.toString() }, () => {
          if (!at || at.status === 'data_gap' || at.status === 'provider_gap') return { status: 'censored', reason: at?.status ?? 'horizon_unavailable', failedTransaction: null, evidenceIds: at?.evidenceIds ?? [] };
          if (at.status === 'unsupported') return { status: 'unsupported', reason: 'unsupported_route', failedTransaction: null, evidenceIds: at.evidenceIds };
          return BenchmarkExitSchema.parse(adapter.exit(m, path, entry, entryIndex, exitIndex!));
        });
        row.checkpoints.push({ deadlineSec: deadline.toString(), cursor: at?.cursor ?? null, exit, returns: at ? benchmarkReturns(m, entry, frame, exit, at) : null });
        return row.checkpoints.length - 1;
      };
      for (const hold of [300, 3600, 86400] as const) {
        const k = await attempt(entryTime + BigInt(hold)), x = row.checkpoints[k];
        row.strategies.push({ kind: `fixed_${hold}`, status: x.exit.status === 'censored' || x.exit.status === 'unsupported' ? 'censored' :
          x.exit.status === 'indeterminate' || x.exit.status === 'token_failure' && !x.exit.validScheduledState ? 'indeterminate' : 'completed', checkpoint: k, trigger: 'deadline' });
        if (hold === 3600 && m.retrySensitivity && x.exit.status === 'token_failure')
          for (let retry = 60; retry <= 300; retry += 60) row.retries.push(await attempt(entryTime + 3600n + BigInt(retry)));
      }
      const deadlines = new Set<string>();
      for (let sec = 60; sec <= 3600; sec += 60) deadlines.add((entryTime + BigInt(sec)).toString());
      for (const f of m.frames) if (f.relevant.length && BigInt(f.cursor.timestampSec) > entryTime && BigInt(f.cursor.timestampSec) <= entryTime + 3600n) deadlines.add(f.cursor.timestampSec);
      for (const deadline of [...deadlines].map(BigInt).sort((a, b) => a < b ? -1 : a > b ? 1 : 0)) {
        const k = await attempt(deadline), x = row.checkpoints[k];
        let trigger: string | null = null;
        const ret = x.returns?.returnPct;
        if (x.exit.status !== 'executed' || !ret) trigger = x.exit.status === 'token_failure' ? 'exit_failure' : 'checkpoint_unknown';
        else if (cmp(ret, benchmarkRational(-30n)) <= 0) trigger = 'stop';
        else if (cmp(ret, benchmarkRational(50n)) >= 0) trigger = 'target';
        else if (deadline === entryTime + 3600n) trigger = 'mandatory_exit';
        if (trigger) { row.strategies.push({ kind: 'stop_target', status: x.exit.status === 'indeterminate' || x.exit.status === 'token_failure' && !x.exit.validScheduledState ? 'indeterminate' :
          trigger === 'checkpoint_unknown' ? 'censored' : 'completed', checkpoint: k, trigger }); break; }
      }
    }
    await check(); c.status = 'complete';
  } catch (e) {
    if (!(e instanceof BenchmarkStop)) throw e;
    c.status = 'stopped'; c.reason = e.message as BenchmarkCheckpoint['reason'];
  }
  await save();
  return { version: m.version, mode: 'shadow' as const, released: false as const, origin: m.origin, sourceRevision: m.sourceRevision,
    candidateRevision, availabilityCut: m.availabilityCut, quoteAsset: m.quoteAsset, quoteDecimals: m.quoteDecimals, manifestHash: c.manifestHash, status: c.status, reason: c.reason, rows,
    completedLocalEvaluations: c.artifacts.length, actualRequestUnits: 0, actualPaidNanoUsd: '0', realMatchedCases: 0,
    primaryUnit: '(token,60,size,class)' as const, paperBandGateEligible: false as const, operatorHistoryEligible: false as const };
}

export const BenchmarkFidelityMatchSchema = z.strictObject({ id: Bytes32Schema, caseId: z.string().min(1),
  origin: z.enum(['fixture', 'measured']), venue: z.string().min(1), sizeUsd: z.union([z.literal(100), z.literal(1000)]), accountClass: z.enum(['eoa', 'contract']),
  comparison: z.enum(['persistent', 'real_fifo']), supported: z.boolean(), persistentValid: z.boolean(),
  // exactAccounting covers actor, denominator, gas and returned-amount reconciliation.
  exactAccounting: z.boolean(), diversityReviewed: z.boolean(), paperNetUsd: RationalSchema.nullable(), comparatorNetUsd: RationalSchema.nullable(),
  paperHurt: z.boolean().nullable(), comparatorHurt: z.boolean().nullable(), evidenceIds: z.array(Bytes32Schema).min(1) });
export type BenchmarkFidelityMatch = z.infer<typeof BenchmarkFidelityMatchSchema>;
/** Separate gate per venue/size/class; fixture assertions cannot fill the real denominator. */
export function benchmarkFidelityGate(raw: BenchmarkFidelityMatch[], group: Pick<BenchmarkFidelityMatch, 'venue' | 'sizeUsd' | 'accountClass'>) {
  const matches = raw.map(x => BenchmarkFidelityMatchSchema.parse(x)).filter(x => x.venue === group.venue && x.sizeUsd === group.sizeUsd && x.accountClass === group.accountClass);
  if (new Set(matches.map(x => x.id)).size !== matches.length) throw new Error('Duplicate fidelity evidence');
  const usable = matches.filter(x => x.origin === 'measured' && x.supported && (x.comparison === 'real_fifo' || x.persistentValid));
  const tested = usable.filter(x => x.exactAccounting && x.diversityReviewed && x.paperNetUsd && x.comparatorNetUsd && x.paperHurt !== null && x.comparatorHurt !== null);
  const errors = tested.filter(x => {
    const a = read(x.paperNetUsd!), b = read(x.comparatorNetUsd!);
    if (b.n <= 0n) return false; // Positive-proceeds relative-error screen only; harm reversal still applies.
    const diff = a.n * b.d - b.n * a.d;
    return (diff < 0n ? -diff : diff) * 100n > b.n * a.d;
  });
  const reversals = tested.filter(x => x.paperHurt !== x.comparatorHurt);
  const realCases = new Set(tested.map(x => x.caseId)).size;
  const missing = matches.filter(x => x.origin === 'measured' && (!x.supported || x.comparison === 'persistent' && !x.persistentValid) &&
    !tested.some(t => t.caseId === x.caseId && t.comparison === 'real_fifo')).length;
  return { ...group, passed: realCases >= 30 && tested.length === usable.length && !errors.length && !reversals.length && missing === 0,
    realMatchedCases: realCases, syntheticChecks: matches.filter(x => x.origin === 'fixture').length,
    unsupportedOrInvalid: missing, diversityUnreviewed: usable.filter(x => !x.diversityReviewed).length, accountingFailures: usable.filter(x => !x.exactAccounting).length,
    relativeErrorFailures: errors.length, harmReversals: reversals.length, missingReleaseTruth: missing > 0 };
}
