import { z } from 'zod';
import { keccak256, toHex } from 'viem';
import { AddressSchema, Bytes32Schema, GuardCursorSchema, GuardAvailabilityManifestSchema, GuardStoredRoleSchema, compareGuardCursors, guardKnownBy } from '@eko/shared';
import type { GuardAvailabilityManifest, GuardStoredRole, GuardCoverage, GuardCursor } from '@eko/shared';
import { binary, hex, GuardSourceStore, guardStorageHash } from '@eko/db';
import type { ChainDb } from '@eko/db';
import { ServiceResolutionSchema } from './principal-services.js';
import { resolveTraceLaunchRoles } from './trace-principals.js';
import type { TraceRoleOptions } from './trace-principals.js';
import { TRACE_ROLES_METHOD_VERSION } from './trace-acquisition.js';
import type { AcquiredTraceBlock } from './trace-acquisition.js';

export const LAUNCH_ROLES_METHOD_VERSION = '2.0.0' as const;
const uint = z.string().regex(/^(0|[1-9]\d*)$/);
const bps = uint.refine(v => BigInt(v) <= 10000n, 'Invalid basis points');
const role = GuardStoredRoleSchema.pick({ role: true, address: true, status: true }).extend({ refs: z.array(z.string()), cursor: GuardCursorSchema });
// TODO(spec): 029/043 require explicit jobs but do not specify their wire envelope.
// These persisted requests describe missing work; they are not a running trace queue.
export const LaunchRoleSnapshotSchema = z.strictObject({
  schemaVersion: z.literal('launch-roles-2'), coin: AddressSchema, cursor: GuardCursorSchema,
  name: z.string().nullable(), symbol: z.string().nullable(), launchpad: z.enum(['pons', 'occupy', 'flap', 'klik', 'other']),
  createdAtSec: uint.nullable(), firstTradeSec: uint.nullable(), quoteAsset: AddressSchema.nullable(),
  roles: z.array(role),
  jobs: z.array(z.strictObject({ kind: z.enum(['launch_evidence', 'trace_principal', 'service_review', 'creation_payer', 'fee_configuration']), status: z.literal('missing'), refs: z.array(z.string()) })),
  feeConfiguration: z.strictObject({ curve: AddressSchema, cursor: GuardCursorSchema, creatorTaxBps: bps.nullable(), ordinaryFeeBps: bps.nullable(), feeRecipient: AddressSchema.nullable() }).nullable(),
  service: ServiceResolutionSchema.optional(),
});
export type LaunchRoleSnapshot = z.infer<typeof LaunchRoleSnapshotSchema>;
/** Inject only an acquired per-curve configuration observation, never a global default. */
export const LaunchFeeObservationSchema = z.strictObject({
  coin: AddressSchema, curve: AddressSchema, cursor: GuardCursorSchema,
  knownAt: z.strictObject({ cursor: GuardCursorSchema, acquisitionSequence: uint }),
  creatorTaxBps: bps.nullable(), ordinaryFeeBps: bps.nullable(), feeRecipient: AddressSchema.nullable(),
  sourceRef: z.string().min(1),
});
export type LaunchFeeObservation = z.infer<typeof LaunchFeeObservationSchema>;
export interface LaunchEventObservation {
  ref: string; block: string; logIndex: number; txHash: string; emitter: string; kind: string; data: Record<string, unknown>;
}
export interface LaunchRoleInput {
  coin: string; cursor: GuardCursor; name: string | null; symbol: string | null; launchpad: string | null;
  events: readonly LaunchEventObservation[];
  senders: readonly { txHash: string; from: string; to: string | null }[];
  exemptions: readonly { wallet: string; ref: string }[];
  feeObservation?: LaunchFeeObservation;
}
const address = (v: unknown) => { const parsed = AddressSchema.safeParse(typeof v === 'string' ? v.toLowerCase() : v); return parsed.success ? parsed.data : null; };
const timestamp = (v: unknown) => { const parsed = uint.safeParse(v); return parsed.success ? parsed.data : null; };

/** Pure existing-data adapter. No exemption, nonce, actor or shared code proves control. */
export function resolveLaunchRolesV2(input: LaunchRoleInput): LaunchRoleSnapshot {
  const cursor = GuardCursorSchema.parse(input.cursor), coin = AddressSchema.parse(input.coin.toLowerCase());
  if (cursor.boundary !== 'block_end') throw new Error('Launch roles require completed block-end state');
  const events = input.events.filter(e => BigInt(e.block) <= BigInt(cursor.blockNumber) && address(e.data.token) === coin).slice().sort((a, b) =>
    BigInt(a.block) !== BigInt(b.block) ? (BigInt(a.block) < BigInt(b.block) ? -1 : 1) : a.logIndex - b.logIndex || a.txHash.localeCompare(b.txHash));
  const launches = events.filter(e => e.kind === 'launch' && address(e.data.token) === coin);
  const launch = launches.length === 1 && input.launchpad === 'pons' ? launches[0] : undefined;
  const roles: LaunchRoleSnapshot['roles'] = [];
  const add = (kind: GuardStoredRole['role'], value: string | null, refs: string[], at = cursor) => {
    roles.push({ role: kind, address: address(value), status: address(value) ? 'verified' : 'missing', refs, cursor: at });
  };
  const caller = launch ? address(launch.data.deployer) : null;
  // Same-transaction stored senders can recover older launch rows; trader/actor cannot.
  const txRows = launch ? input.senders.filter(s => s.txHash.toLowerCase() === launch.txHash.toLowerCase()) : [];
  const outerPairs = launch ? [
    ...(address(launch.data.outerFrom) ? [{ from: address(launch.data.outerFrom)!, to: address(launch.data.outerTo) }] : []),
    ...txRows.map(s => ({ from: address(s.from), to: address(s.to) })),
  ] : [];
  const pairs = [...new Map(outerPairs.map(p => [JSON.stringify(p), p])).values()];
  const outer = pairs.length === 1 ? pairs[0] : null;
  const refs = launch ? [launch.ref] : [];
  add('factory_deployer', caller, refs);
  add('outer_signer', outer?.from ?? null, refs);
  // A signed transaction directly to the factory authenticates only its own launch.
  // Self-calls, routers, UserOps and shared callers need the launch call subtree.
  const principal = caller && outer?.from === caller && outer.to === address(launch?.emitter) ? caller : null;
  add('launch_principal', principal, refs);
  add('creation_payer', null, refs);
  const exemptions = new Map<string, string[]>();
  for (const e of [...input.exemptions, ...events.filter(e => e.kind === 'exempt').map(e => ({ wallet: String(e.data.wallet), ref: e.ref }))]) {
    const wallet = address(e.wallet); if (!wallet) continue;
    exemptions.set(wallet, [...new Set([...(exemptions.get(wallet) ?? []), e.ref])].sort());
  }
  for (const [wallet, proof] of [...exemptions].sort(([a], [b]) => a.localeCompare(b))) add('exempt', wallet, proof);
  // Preserve every economic destination and its log, without assigning batch ownership.
  for (const e of events.filter(e => e.kind === 'trade' && (e.data.side === 1 || e.data.side === -1))) {
    add(e.data.side === 1 ? 'buy_recipient' : 'proceeds_recipient', address(e.data.recipient), [e.ref]);
  }
  let feeConfiguration: LaunchRoleSnapshot['feeConfiguration'] = null;
  if (input.feeObservation) {
    const fee = LaunchFeeObservationSchema.parse(input.feeObservation);
    if (!launch || fee.coin !== coin || fee.curve !== address(launch.data.curve) || BigInt(fee.cursor.blockNumber) < BigInt(launch.block) || compareGuardCursors(fee.cursor, cursor) > 0) throw new Error('Fee observation does not match this launch/state');
    const { coin: _, knownAt: __, sourceRef: ___, ...configuration } = fee;
    feeConfiguration = configuration;
    if (fee.feeRecipient) add('fee_recipient', fee.feeRecipient, [fee.sourceRef], fee.cursor);
  }
  const jobs: LaunchRoleSnapshot['jobs'] = [];
  if (!launch) jobs.push({ kind: 'launch_evidence', status: 'missing', refs: launches.map(e => e.ref) });
  if (!principal) jobs.push({ kind: 'trace_principal', status: 'missing', refs }, { kind: 'service_review', status: 'missing', refs });
  jobs.push({ kind: 'creation_payer', status: 'missing', refs });
  if (!feeConfiguration || feeConfiguration.creatorTaxBps === null || feeConfiguration.ordinaryFeeBps === null || feeConfiguration.feeRecipient === null) jobs.push({ kind: 'fee_configuration', status: 'missing', refs });
  const firstTrade = events.find(e => e.kind === 'trade' && (e.data.side === 1 || e.data.side === -1));
  return LaunchRoleSnapshotSchema.parse({ schemaVersion: 'launch-roles-2', coin, cursor, name: input.name, symbol: input.symbol,
    launchpad: ['pons', 'occupy', 'flap', 'klik'].includes(input.launchpad ?? '') ? input.launchpad : 'other',
    createdAtSec: launch ? timestamp(launch.data.timestampSec) : null,
    firstTradeSec: firstTrade ? timestamp(firstTrade.data.timestampSec) : null,
    quoteAsset: launch ? address(launch.data.pairToken) : null, roles, jobs, feeConfiguration });
}

/** Indexer-owned capture from existing indexed rows; no RPC, trace or legacy writes. */
export async function captureLaunchRolesV2(db: ChainDb, coinInput: string, manifestInput: GuardAvailabilityManifest, feeObservation?: LaunchFeeObservation,
  traceObservation?: { block: AcquiredTraceBlock; options: TraceRoleOptions }) {
  const coin = AddressSchema.parse(coinInput.toLowerCase()), manifest = GuardAvailabilityManifestSchema.parse(manifestInput);
  const cursor = manifest.watermark;
  if (cursor.boundary !== 'block_end') throw new Error('Launch roles require completed block-end state');
  if (feeObservation && (!guardKnownBy(feeObservation.knownAt, manifest.cut) || compareGuardCursors(feeObservation.cursor, feeObservation.knownAt.cursor) > 0)) throw new Error('Fee observation exceeds captured availability');
  if (traceObservation && (!guardKnownBy(traceObservation.options.at, manifest.cut) || compareGuardCursors(traceObservation.block.cursor, traceObservation.options.at.cursor) > 0)) throw new Error('Trace observation exceeds captured availability');
  return db.tx(async tx => {
    const store = new GuardSourceStore(tx);
    const [tokens, pons, swaps, exempt] = await Promise.all([
      tx.sql.query<{ name: string | null; symbol: string | null; launchpad: string | null }>('SELECT name,symbol,launchpad FROM tokens WHERE address=$1 AND first_block<=$2', [binary(coin), cursor.blockNumber]),
      tx.sql.query<{ block: string; tx_hash: Uint8Array; log_index: number; emitter: Uint8Array; kind: string; data: Record<string, unknown>; ts: Date | null }>(`SELECT e.*,b.ts FROM pons_events e LEFT JOIN chain_blocks b ON b.number=e.block WHERE e.token=$1 AND e.block<=$2 ORDER BY e.block,e.log_index,e.tx_hash`, [binary(coin), cursor.blockNumber]),
      tx.sql.query<{ tx_hash: Uint8Array; tx_from: Uint8Array; tx_to: Uint8Array | null; log_index: number; ts: Date }>('SELECT tx_hash,tx_from,tx_to,log_index,ts FROM swaps WHERE coin=$1 AND block<=$2 AND NOT senders_pending AND tx_from IS NOT NULL ORDER BY block,log_index,tx_hash', [binary(coin), cursor.blockNumber]),
      tx.sql.query<{ wallet: Uint8Array; tx_hash: Uint8Array; log_index: number }>('SELECT wallet,tx_hash,log_index FROM pons_exemptions WHERE token=$1 AND block<=$2 ORDER BY wallet', [binary(coin), cursor.blockNumber]),
    ]);
    const token = tokens.rows[0]; if (!token) return null;
    const events = pons.rows.map(e => ({ block: e.block, logIndex: e.log_index, txHash: hex(e.tx_hash), ref: `${hex(e.tx_hash)}:${e.log_index}`, emitter: hex(e.emitter), kind: e.kind,
      data: { ...e.data, ...(e.data.timestampSec == null && e.ts ? { timestampSec: String(Math.floor(e.ts.getTime() / 1000)) } : {}) } }));
    for (const e of events) if (e.data.timestampSec == null && e.kind === 'trade') {
      const swap = swaps.rows.find(s => hex(s.tx_hash) === e.txHash && s.log_index === e.logIndex);
      if (swap) e.data.timestampSec = String(Math.floor(swap.ts.getTime() / 1000));
    }
    const roleInput: LaunchRoleInput = { coin, cursor, ...token, events,
      senders: swaps.rows.map(s => ({ txHash: hex(s.tx_hash), from: hex(s.tx_from), to: s.tx_to ? hex(s.tx_to) : null })),
      exemptions: exempt.rows.map(e => ({ wallet: hex(e.wallet), ref: `${hex(e.tx_hash)}:${e.log_index}` })), feeObservation };
    const basic = resolveLaunchRolesV2(roleInput);
    const snapshot = LaunchRoleSnapshotSchema.parse(traceObservation ? resolveTraceLaunchRoles(basic, roleInput, traceObservation.block, traceObservation.options) : basic);
    await store.putManifest(manifest);
    // Full source references stay in the payload. Old rows have no merged execution
    // ordinal, so observations use completed block ends, never invented tx cursors.
    const payload = { snapshot, events, senders: swaps.rows.map(s => ({ txHash: hex(s.tx_hash), from: hex(s.tx_from), to: s.tx_to ? hex(s.tx_to) : null })), feeObservation: feeObservation ?? null,
      ...(traceObservation ? { traceObservation } : {}) };
    const content = new TextEncoder().encode(JSON.stringify(payload)), hash = guardStorageHash(payload);
    // Hash the exact retained bytes (JSON field order is not JCS).
    const contentHash = keccak256(toHex(content));
    // A frozen availability manifest cannot acquire a different legacy-table
    // snapshot on replay. New evidence needs a new acquisition sequence/cut.
    await tx.sql.query('SELECT id FROM guard_availability WHERE id=$1 FOR UPDATE', [manifest.id]);
    const existing = (await tx.sql.query<{ payload_hash: string }>("SELECT payload_hash FROM guard_chain_evidence WHERE manifest_id=$1 AND coin=$2 AND data->>'sourceItemId'='launch-roles'", [manifest.id, coin])).rows;
    if (existing.some(r => r.payload_hash !== contentHash)) throw new Error('Launch snapshot changed; capture a new availability revision');
    const base = { chainId: cursor.chainId, coin, manifestId: manifest.id, sourceItemId: 'launch-roles', sourceRevision: manifest.sourceRevision,
      cursor, knownAt: manifest.cut, acquiredAt: manifest.acquiredAt, methodVersion: traceObservation ? TRACE_ROLES_METHOD_VERSION : LAUNCH_ROLES_METHOD_VERSION, dependencyIds: [] };
    const proof = await store.putEvidence({ ...base, evidence: { id: hash, kind: 'log', cursor, knownAt: manifest.cut, payloadHash: contentHash, objectRef: contentHash, supersedes: null } }, content);
    const roleIds: string[] = [];
    for (const [i, r] of snapshot.roles.entries()) {
      const bytes = new TextEncoder().encode(JSON.stringify(r)), digest = keccak256(toHex(bytes));
      const stored = await store.putRole({ ...base, sourceItemId: `launch-role:${r.role}:${i}`, cursor: r.cursor,
        role: r.role, address: r.address, status: r.status, evidenceIds: [Bytes32Schema.parse(proof.id)], payloadHash: digest, objectRef: digest }, bytes);
      roleIds.push(stored.id);
    }
    const complete = !snapshot.jobs.some(j => ['trace_principal', 'service_review', 'launch_evidence'].includes(j.kind));
    const coverage: GuardCoverage = { scopeId: 'launcher_service', from: null, through: cursor, complete, gaps: complete ? [] : ['missing'], methodVersion: base.methodVersion,
      coveredUnits: null, excludedUnits: null, topLevelNative: false, internalNative: false, firstEverEstablished: false, sourceHashes: [contentHash] };
    await store.putCoverage({ ...base, dependencyIds: [Bytes32Schema.parse(proof.id)], coverage });
    return { snapshot, evidenceId: proof.id, roleIds };
  });
}
