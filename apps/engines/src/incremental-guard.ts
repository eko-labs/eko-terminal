import { z } from 'zod';
import { canonicalize, GuardScoreInputSchema, AddressSchema } from '@eko/shared';
import type { Address, GuardScoreInput, GuardScoreResult } from '@eko/shared';
import { evaluateGuardV2, guardScoreHash } from '@eko/playbooks';

const revision = z.string().regex(/^[0-9a-f]{64}$/);
const uint = z.string().regex(/^(0|[1-9]\d*)$/);
const address = AddressSchema.transform(a => a.toLowerCase() as Address);
const limitsSchema = z.strictObject({ entries: z.number().int().positive().safe(), bytes: z.number().int().positive().safe(),
  dependenciesPerEntry: z.number().int().positive().safe() });
const contextSchema = z.strictObject({ sourceRevision: revision, route: z.string().max(256).nullable(),
  sizeRaw: uint.nullable(), account: address.nullable() });
export type GuardCacheContext = z.infer<typeof contextSchema>;
type Entry = { key: string; input: GuardScoreInput; context: GuardCacheContext; wallets: Address[]; result: GuardScoreResult; bytes: number };
const freeze = <T>(value: T): T => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};

/** Engines-owned shadow cache of immutable normalized observations. No acquisition callbacks.
 * Budget misses evaluate uncached; eviction never completes missing checks or discards durable evidence. */
export class IncrementalGuardCache {
  private entries = new Map<string, Entry>();
  private reverse = new Map<string, Set<string>>();
  private bytes = 0;
  private hits = 0;
  private misses = 0;
  readonly limits: z.infer<typeof limitsSchema>;
  constructor(limits = { entries: 256, bytes: 16 * 1024 * 1024, dependenciesPerEntry: 10000 }) {
    this.limits = Object.freeze(limitsSchema.parse(limits));
  }
  private walletKey(chainId: number, wallet: Address) { return `${chainId}:${wallet.toLowerCase()}`; }
  private remove(key: string) {
    const e = this.entries.get(key); if (!e) return;
    this.entries.delete(key); this.bytes -= e.bytes;
    for (const w of e.wallets) {
      const k = this.walletKey(e.input.cursor.chainId, w), set = this.reverse.get(k)!;
      set.delete(key); if (!set.size) this.reverse.delete(k);
    }
  }
  evaluate(raw: GuardScoreInput, rawContext: GuardCacheContext, dependencies: readonly Address[] = []) {
    const input = GuardScoreInputSchema.parse(raw), context = contextSchema.parse(rawContext);
    if (input.mode !== 'shadow') throw new Error('Incremental Guard cache is shadow only');
    const wallets = [...new Set(dependencies.map(w => address.parse(w)))].sort();
    // Dependency registration is part of identity: a hit cannot omit newly supplied invalidation paths.
    const key = guardScoreHash({ input, context, wallets });
    const existing = this.entries.get(key);
    if (existing) { this.hits++; this.entries.delete(key); this.entries.set(key, existing); return existing.result; }
    this.misses++;
    const result = freeze(evaluateGuardV2(input));
    const bytes = Buffer.byteLength(canonicalize({ key, input, context, wallets, result }));
    if (bytes <= this.limits.bytes && wallets.length <= this.limits.dependenciesPerEntry) {
      while (this.entries.size >= this.limits.entries || this.bytes + bytes > this.limits.bytes) this.remove(this.entries.keys().next().value!);
      const e = freeze({ key, input, context, wallets, result, bytes });
      this.entries.set(key, e); this.bytes += bytes;
      for (const w of wallets) {
        const k = this.walletKey(input.cursor.chainId, w);
        if (!this.reverse.has(k)) this.reverse.set(k, new Set()); this.reverse.get(k)!.add(key);
      }
    }
    return result;
  }
  affectedCoins(chainId: number, wallets: readonly Address[]): Address[] {
    return [...new Set(wallets.flatMap(w => [...this.reverse.get(this.walletKey(chainId, w)) ?? []])
      .map(k => this.entries.get(k)!.input.coin))].sort();
  }
  invalidateWallets(chainId: number, wallets: readonly Address[]) {
    const coins = this.affectedCoins(chainId, wallets);
    for (const key of new Set(wallets.flatMap(w => [...this.reverse.get(this.walletKey(chainId, w)) ?? []]))) this.remove(key);
    return coins;
  }
  invalidateSource(sourceRevision: string) {
    for (const [key, e] of this.entries) if (e.context.sourceRevision === sourceRevision) this.remove(key);
  }
  stats() { return { entries: this.entries.size, bytes: this.bytes, reverseWallets: this.reverse.size, hits: this.hits, misses: this.misses }; }
  checkpoint(candidateRevision: string) {
    revision.parse(candidateRevision);
    const body = { version: 1 as const, candidateRevision, limits: this.limits,
      entries: [...this.entries.values()].map(({ input, context, wallets }) => ({ input, context, wallets })) };
    return { ...body, digest: guardScoreHash(body) };
  }
  static restore(raw: unknown, candidateRevision: string, sourceRevision: string) {
    const c = z.strictObject({ version: z.literal(1), candidateRevision: revision, limits: limitsSchema,
      entries: z.array(z.strictObject({ input: GuardScoreInputSchema, context: contextSchema, wallets: z.array(address) })),
      digest: z.string() }).parse(raw);
    const { digest, ...body } = c;
    if (c.candidateRevision !== candidateRevision || guardScoreHash(body) !== digest || c.entries.length > c.limits.entries ||
      c.entries.some(e => e.context.sourceRevision !== sourceRevision || e.wallets.length > c.limits.dependenciesPerEntry))
      throw new Error('Guard cache checkpoint scope/digest/budget mismatch');
    const cache = new IncrementalGuardCache(c.limits);
    for (const e of c.entries) cache.evaluate(e.input, e.context, e.wallets);
    if (cache.entries.size !== c.entries.length) throw new Error('Guard cache checkpoint exceeds byte budget or duplicates entries');
    cache.hits = 0; cache.misses = 0; return cache;
  }
}

export const GuardTimerSchema = z.strictObject({ id: z.string().regex(/^[a-z0-9-]{1,128}$/), chainId: z.number().int().positive(),
  coin: address, kind: z.enum(['expiry', 'maturity', 'probe', 'acquisition', 'pressure', 'critical', 'lower']),
  dueSec: uint, sourceRevision: revision, inputRef: revision, dependencyIds: z.array(revision).max(10000) });
export type GuardTimer = z.infer<typeof GuardTimerSchema>;
const compare = (a: GuardTimer, b: GuardTimer) => BigInt(a.dueSec) < BigInt(b.dueSec) ? -1 : BigInt(a.dueSec) > BigInt(b.dueSec) ? 1 : a.id.localeCompare(b.id);

// TODO(spec): §8.4 does not define a queue/checkpoint wire. This engines-only heap
// retains immutable input references; the host persists artifacts/checkpoints and acknowledges only after commit.
// The ordinary worker never starts these shadow jobs. Existing campaign/outcome DB queues own their results.
export class GuardChainTimeQueue {
  private heap: GuardTimer[] = [];
  private positions = new Map<string, number>();
  private clockSec = '0';
  constructor(readonly chainId: number, readonly sourceRevision: string, readonly capacity = 10000) {
    z.number().int().positive().parse(chainId); revision.parse(sourceRevision); z.number().int().positive().safe().parse(capacity);
  }
  private swap(a: number, b: number) {
    [this.heap[a], this.heap[b]] = [this.heap[b], this.heap[a]];
    this.positions.set(this.heap[a].id, a); this.positions.set(this.heap[b].id, b);
  }
  private up(i: number) { while (i > 0) { const p = (i - 1) >>> 1; if (compare(this.heap[p], this.heap[i]) <= 0) break; this.swap(p, i); i = p; } }
  private down(i: number) {
    while (i * 2 + 1 < this.heap.length) {
      let n = i * 2 + 1;
      if (n + 1 < this.heap.length && compare(this.heap[n + 1], this.heap[n]) < 0) n++;
      if (compare(this.heap[i], this.heap[n]) <= 0) break; this.swap(i, n); i = n;
    }
  }
  enqueue(raw: GuardTimer) {
    const t = freeze(GuardTimerSchema.parse(raw));
    if (t.chainId !== this.chainId || t.sourceRevision !== this.sourceRevision) throw new Error('Timer scope mismatch');
    const i = this.positions.get(t.id);
    if (i !== undefined) {
      if (canonicalize(t) !== canonicalize(this.heap[i])) throw new Error('Timer ID conflict');
      return false;
    }
    if (this.heap.length >= this.capacity) throw new Error('Timer queue capacity reached');
    this.positions.set(t.id, this.heap.length); this.heap.push(t); this.up(this.heap.length - 1); return true;
  }
  advance(chainTimeSec: string) {
    uint.parse(chainTimeSec);
    if (BigInt(chainTimeSec) < BigInt(this.clockSec)) throw new Error('Chain clock moved backwards; restore canonical checkpoint');
    this.clockSec = chainTimeSec;
  }
  peekDue() { const t = this.heap[0]; return t && BigInt(t.dueSec) <= BigInt(this.clockSec) ? t : null; }
  /** Failure leaves the job pending. Call only after the owned durable result/checkpoint commits. */
  acknowledge(id: string) {
    const i = this.positions.get(id); if (i === undefined) return false;
    const last = this.heap.pop()!; this.positions.delete(id);
    if (i < this.heap.length) { this.heap[i] = last; this.positions.set(last.id, i); this.up(i); this.down(this.positions.get(last.id)!); }
    return true;
  }
  invalidateDependencies(ids: readonly string[]) {
    const dependencies = new Set(ids);
    const removed = this.heap.filter(t => t.dependencyIds.some(d => dependencies.has(d))).map(t => t.id).sort();
    removed.forEach(id => this.acknowledge(id)); return removed;
  }
  stats() { return { pending: this.heap.length, clockSec: this.clockSec, oldestDueSec: this.heap[0]?.dueSec ?? null }; }
  checkpoint(candidateRevision: string) {
    revision.parse(candidateRevision);
    const body = { version: 1 as const, candidateRevision, chainId: this.chainId, sourceRevision: this.sourceRevision,
      capacity: this.capacity, clockSec: this.clockSec, timers: [...this.heap].sort(compare) };
    return { ...body, digest: guardScoreHash(body) };
  }
  static restore(raw: unknown, candidateRevision: string, sourceRevision: string, chainId: number) {
    const c = z.strictObject({ version: z.literal(1), candidateRevision: revision, chainId: z.number().int().positive(),
      sourceRevision: revision, capacity: z.number().int().positive().safe(), clockSec: uint, timers: z.array(GuardTimerSchema), digest: z.string() }).parse(raw);
    const { digest, ...body } = c;
    if (c.candidateRevision !== candidateRevision || c.sourceRevision !== sourceRevision || c.chainId !== chainId || guardScoreHash(body) !== digest ||
      c.timers.length > c.capacity || new Set(c.timers.map(t => t.id)).size !== c.timers.length) throw new Error('Timer checkpoint scope/digest/budget mismatch');
    const q = new GuardChainTimeQueue(c.chainId, c.sourceRevision, c.capacity);
    c.timers.forEach(t => q.enqueue(t)); q.advance(c.clockSec); return q;
  }
}
