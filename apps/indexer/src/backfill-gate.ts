import { createHash } from 'node:crypto';
import { z } from 'zod';

const uint = z.string().regex(/^(0|[1-9][0-9]*)$/);
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform(s => s.toLowerCase());
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(s => s.toLowerCase());
const timestamp = z.iso.datetime();
const bounded = <T extends z.ZodType>(schema: T) => z.array(schema).max(10000);
const header = z.strictObject({ block: uint, hash, timestamp });
export const coverageKinds = ['ponsFactory', 'ponsCurves', 'identityRegistry', 'pools', 'swaps', 'holders', 'occupy', 'flap', 'klik', 'weth', 'entryPoints', 'fullBlocks', 'candidateFunding'] as const;
export const GatePlanSchema = z.strictObject({
  version: z.literal(1), chainId: z.literal(4663), candidateRevision: z.string().regex(/^[0-9a-f]{40}$/),
  head: header, recent: header.extend({ previous: header }), sevenDay: header.extend({ previous: header }),
  phaseC: z.enum(['full30', 'sevenDayCandidates']),
  // Stream names are exact, including the current filter-set hash for swaps/holders.
  streams: z.record(z.enum(coverageKinds), z.string().min(1).max(160)),
  tokens: z.array(address).min(1).max(1000), maxRows: z.number().int().min(1).max(10000),
});
export type GatePlan = z.infer<typeof GatePlanSchema>;
export const GateSnapshotSchema = z.strictObject({
  version: z.literal(1), chainId: z.literal(4663), origin: z.enum(['fixture', 'local', 'live-export']), capturedAt: timestamp,
  plan: GatePlanSchema,
  ranges: bounded(z.strictObject({ stream: z.string(), from: uint, to: uint, status: z.enum(['todo', 'leased', 'done', 'failed']), leaseOwner: z.string().nullable(), leaseUntil: timestamp.nullable(), attempts: z.number().int().nonnegative() })),
  checkpoints: bounded(z.strictObject({ stream: z.string(), block: uint, hash: hash.nullable(), canonicalHash: hash.nullable() })),
  headers: bounded(header),
  guardSources: bounded(z.strictObject({ id: hash, sourceRevision: hash, replayMode: z.enum(['production', 'retrospective']), cutBlock: uint, watermarkBlock: uint, invalidations: uint, contentHash: hash })),
  inventories: bounded(z.strictObject({ table: z.string(), rows: uint, duplicates: uint })),
  supplies: bounded(z.strictObject({ token: address, firstBlock: uint, to: uint, minted: uint, burned: uint,
    held: z.string().regex(/^-?[0-9]+$/), negativeHolders: uint, mismatchedHolders: uint,
    totalSupply: uint.nullable(), supplyBlock: uint.nullable(), transferRows: uint })),
  candles: z.strictObject({ expected: uint, actual: uint, mismatches: uint, unpricedSwaps: uint }),
  follower: z.strictObject({ sourceRevision: z.string(), startedAt: timestamp, endedAt: timestamp,
    startHead: uint, startCursor: uint, endHead: uint, endCursor: uint,
    headLagMs: z.array(z.number().finite().nonnegative()).min(1).max(10000),
    paidUnits: z.number().finite().nonnegative(), costUsd: z.number().finite().nonnegative(), logHash: hash }).nullable(),
  cost: z.strictObject({ paidUnits: z.number().finite().nonnegative(), costUsd: z.number().finite().nonnegative() }).nullable(),
  checkpoint: z.string().min(1).max(160),
});
export type GateSnapshot = z.infer<typeof GateSnapshotSchema>;
export interface Finding { check: string; status: 'verified' | 'failed' | 'unresolved'; detail: unknown }
export function evidenceHash(value: unknown) { return `0x${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`; }

/** Inclusive union of completed leases. Never combine different filter-set streams. */
export function rangeGaps(from: bigint, to: bigint, ranges: { from: string; to: string; status: string }[]) {
  let next = from;
  const gaps: { from: string; to: string }[] = [];
  for (const r of [...ranges].filter(r => r.status === 'done').sort((a, b) => BigInt(a.from) < BigInt(b.from) ? -1 : BigInt(a.from) > BigInt(b.from) ? 1 : 0)) {
    const lo = BigInt(r.from), hi = BigInt(r.to);
    if (lo > to) break;
    if (hi < next) continue;
    if (lo > next) gaps.push({ from: next.toString(), to: (lo - 1n).toString() });
    next = hi + 1n;
    if (next > to) break;
  }
  if (next <= to) gaps.push({ from: next.toString(), to: to.toString() });
  return gaps;
}

export function verifyBackfill(input: unknown, manifests: { owner: '048' | '057'; content: unknown }[] = []) {
  const s = GateSnapshotSchema.parse(input), p = s.plan, findings: Finding[] = [];
  const add = (check: string, status: Finding['status'], detail: unknown) => findings.push({ check, status, detail });
  const head = BigInt(p.head.block);
  add('row-bound', [s.ranges, s.checkpoints, s.headers, s.inventories, s.supplies, s.guardSources].every(rows => rows.length <= p.maxRows) ? 'verified' : 'failed', { maxRows: p.maxRows });
  const matchingHeader = (h: z.infer<typeof header>) => s.headers.some(v => v.block === h.block && v.hash === h.hash && v.timestamp === h.timestamp);
  add('canonical-boundaries', [p.head, p.recent, p.recent.previous, p.sevenDay, p.sevenDay.previous].every(matchingHeader) ? 'verified' : 'unresolved', 'All declared window boundaries must match the exported canonical headers.');
  for (const [name, h, days] of [['recent', p.recent, 30], ['sevenDay', p.sevenDay, 7]] as const) {
    const cutoff = Date.parse(p.head.timestamp) - days * 86400000;
    const valid = BigInt(h.previous.block) + 1n === BigInt(h.block) && BigInt(h.block) <= head && Date.parse(h.previous.timestamp) < cutoff && Date.parse(h.timestamp) >= cutoff && Date.parse(h.timestamp) <= Date.parse(p.head.timestamp);
    add(`calendar-${name}`, valid ? 'verified' : 'failed', { cutoff: new Date(cutoff).toISOString(), from: h.block, to: p.head.block });
  }
  const bounds = (kind: typeof coverageKinds[number]) => ({ from: ['ponsFactory', 'ponsCurves', 'identityRegistry'].includes(kind) ? 0n : ['fullBlocks', 'candidateFunding'].includes(kind) && p.phaseC === 'sevenDayCandidates' ? BigInt(p.sevenDay.block) : BigInt(p.recent.block), to: head });
  for (const kind of coverageKinds) {
    if (kind === 'candidateFunding' && p.phaseC === 'full30') continue;
    const stream = p.streams[kind], { from, to } = bounds(kind);
    const ranges = s.ranges.filter(r => r.stream === stream && BigInt(r.from) <= to && BigInt(r.to) >= from);
    const gaps = rangeGaps(from, to, ranges);
    const invalid = ranges.filter(r => BigInt(r.from) > BigInt(r.to) || (r.status === 'done' && (r.leaseOwner !== null || r.leaseUntil !== null)));
    const leases = ranges.filter(r => r.status !== 'done').map(r => ({ ...r, expired: r.leaseUntil !== null && Date.parse(r.leaseUntil) <= Date.parse(s.capturedAt) }));
    const keys = ranges.map(r => r.from), duplicates = keys.length - new Set(keys).size;
    add(`coverage-${kind}`, gaps.length || leases.length || invalid.length || duplicates ? 'unresolved' : 'verified', { stream, from: from.toString(), to: to.toString(), gaps, leases, invalid, duplicates, rangeCount: ranges.length, hash: evidenceHash(ranges) });
  }
  add('candidate-funding-denominator', p.phaseC === 'full30' ? 'verified' : 'unresolved', 'The fallback also needs the 048 manifest of every eligible candidate wallet and its source coverage; a stream lease alone does not establish that denominator.');
  add('distinct-streams', new Set(Object.values(p.streams)).size === coverageKinds.length ? 'verified' : 'failed', 'Each acquisition content group requires its own exact stream; aliases cannot certify different sources.');
  add('head-checkpoint', s.checkpoints.some(c => c.stream === 'head' && c.block === p.head.block && c.hash === p.head.hash && c.canonicalHash === p.head.hash) ? 'verified' : 'unresolved', s.checkpoints);
  add('reorg-checkpoints', s.checkpoints.length && s.checkpoints.every(c => c.hash !== null && c.hash === c.canonicalHash && BigInt(c.block) <= head) ? 'verified' : 'unresolved', 'Offline canonical consistency only; a fresh metered head/hash check is required before live acceptance.');
  for (const table of ['pons_events', 'pools', 'swaps', 'token_transfers', 'balances', 'bars_1m']) {
    const rows = s.inventories.filter(i => i.table === table);
    add(`duplicates-${table}`, rows.length !== 1 ? 'unresolved' : BigInt(rows[0].duplicates) ? 'failed' : 'verified', rows);
  }
  for (const token of p.tokens) {
    const rows = s.supplies.filter(v => v.token === token), v = rows[0];
    if (rows.length !== 1) { add(`supply-${token}`, 'unresolved', 'Missing or duplicated token reconciliation'); continue; }
    const holderStream = p.streams.holders;
    const gaps = rangeGaps(BigInt(v.firstBlock), head, s.ranges.filter(r => r.stream === holderStream));
    const conserved = BigInt(v.minted) - BigInt(v.burned) === BigInt(v.held) && BigInt(v.burned) <= BigInt(v.minted) && v.negativeHolders === '0' && v.mismatchedHolders === '0';
    const sampled = v.supplyBlock === p.head.block && v.totalSupply !== null;
    const exact = sampled && BigInt(v.totalSupply!) === BigInt(v.minted) - BigInt(v.burned);
    add(`supply-${token}`, !conserved || (sampled && !exact) ? 'failed' : gaps.length || !sampled || v.to !== p.head.block || v.transferRows === '0' ? 'unresolved' : 'verified', { ...v, gaps, conserved, sampled, exact });
  }
  add('token-scope', new Set(p.tokens).size === p.tokens.length ? 'verified' : 'failed', { tokens: p.tokens.length, scope: 'Only the declared token set; broader coverage is not inferred.' });
  add('candles', BigInt(s.candles.mismatches) ? 'failed' : s.candles.expected !== s.candles.actual || s.candles.unpricedSwaps !== '0' ? 'unresolved' : 'verified', s.candles);
  add('guard-availability', s.guardSources.length && s.guardSources.every(m => m.invalidations === '0' && BigInt(m.watermarkBlock) <= BigInt(m.cutBlock) && BigInt(m.cutBlock) <= head) ? 'verified' : 'unresolved', s.guardSources);
  for (const owner of ['048', '057'] as const) {
    const available = manifests.filter(m => m.owner === owner);
    // TODO(spec): 048/057 have no merged manifest interchange schema. Preserve their original contents and hashes; require their owning packet's review adapter before accepting incident/clone/history evidence.
    add(`guard-${owner}`, 'unresolved', { manifests: available.map(m => ({ hash: evidenceHash(m.content) })), reason: available.length ? 'Present, awaiting owning-packet schema and human review' : 'Acquisition/review manifest absent' });
  }
  add('incident-53-launches', 'unresolved', 'Requires verified full addresses/transactions, archive coverage and independently reconciled cash paths from 057; allegation is not a reproduced incident.');
  add('clone-fixtures', 'unresolved', 'Requires the owning review manifest for both named clone challenges; synthetic fixtures alone do not certify live clones.');
  add('50-deployer-histories', 'unresolved', 'Requires 50 distinct point-in-time deployer comparisons and independent human review; no judgments are inferred.');
  const f = s.follower;
  if (!f) add('follower', 'unresolved', 'No measured catch-up/head-lag log supplied.');
  else {
    const seconds = (Date.parse(f.endedAt) - Date.parse(f.startedAt)) / 1000;
    const lags = [...f.headLagMs].sort((a, b) => a - b), p95 = lags[Math.ceil(lags.length * .95) - 1];
    const caught = BigInt(f.startHead) - BigInt(f.startCursor) >= 2000n && f.endHead === f.endCursor;
    const valid = seconds > 0 && seconds < 300 && caught && p95 <= 1000 && f.sourceRevision === p.candidateRevision && BigInt(f.endHead) >= BigInt(f.startHead) && BigInt(f.startCursor) <= BigInt(f.startHead);
    add('follower', valid ? 'verified' : 'unresolved', { ...f, seconds, p95HeadLagMs: p95, caught });
  }
  return { version: 1, chainId: 4663, candidateRevision: p.candidateRevision, origin: s.origin,
    capturedAt: s.capturedAt, snapshotHash: evidenceHash(s), checkpoint: s.checkpoint, cost: s.cost,
    scope: { phaseC: p.phaseC, tokens: p.tokens, head: p.head },
    status: findings.every(f => f.status === 'verified') ? 'verified-offline' : 'unresolved', liveApproved: false, findings };
}
