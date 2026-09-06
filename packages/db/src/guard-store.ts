import { canonicalize } from '@eko/policy';
import { keccak256, stringToHex, toHex } from 'viem';
import { GuardReceiptPayloadSchema, guardReceiptRevisionKey, guardDecisionBody, AddressSchema, Bytes32Schema, AvailabilityCutSchema, GuardAvailabilityManifestSchema, GuardStoredEvidenceSchema, GuardStoredCoverageSchema, GuardStoredRoleSchema, GuardVerdictRevisionInputSchema, GuardRevisionEventSchema, GuardReorgSchema, guardCursorPosition, guardKnownBy, compareGuardCursors } from '@eko/shared';
import type { AvailabilityCut, GuardCursor, GuardAvailabilityManifest, GuardStoredEvidence, GuardStoredCoverage, GuardStoredRole, GuardVerdictRevisionInput, GuardRevisionEvent, GuardReorg } from '@eko/shared';
import type { ChainDb } from './client.js';
import { GuardReceiptStore } from './guard-receipts.js';

const sourceTables = ['guard_chain_evidence', 'guard_roles', 'guard_source_coverage'] as const;
const normalizerTables = ['guard_measurement_evidence', 'guard_check_coverage'] as const;
const verdictTables = ['guard_verdict_revisions'] as const;
const allTables = [...sourceTables, ...normalizerTables, ...verdictTables];
const eventTables = ['guard_source_events', 'guard_measurement_events', 'guard_verdict_events'] as const;
type Table = typeof allTables[number];
type EventTable = typeof eventTables[number];
type Document = GuardStoredEvidence | GuardStoredRole | GuardStoredCoverage;
export interface GuardStoredRow<T> { id: string; data: T; recorded_at: Date; payload_hash: string; object_ref: string; dependency_ids: string[] }
export interface GuardReadCut { chainId: number; coin: string; manifestId: string; availability: AvailabilityCut; state: GuardCursor; validity?: 'canonical' | 'historic' }
export function guardStorageHash(value: unknown): `0x${string}` { return keccak256(stringToHex(canonicalize(value))); }
export function guardManifestId(input: Omit<GuardAvailabilityManifest, 'id' | 'acquiredAt'>): `0x${string}` { return guardStorageHash(input); }
const eventsFor = (table: Table): EventTable => sourceTables.includes(table as typeof sourceTables[number]) ? 'guard_source_events' : normalizerTables.includes(table as typeof normalizerTables[number]) ? 'guard_measurement_events' : 'guard_verdict_events';
const cleanHashes = (ids: readonly string[]) => [...new Set(ids.map((id) => Bytes32Schema.parse(id)))].sort();
const same = (a: unknown, b: unknown) => canonicalize(a) === canonicalize(b);

async function manifestAt(db: ChainDb, id: string): Promise<GuardAvailabilityManifest> {
  const row = (await db.sql.query<{ data: unknown }>('SELECT data FROM guard_availability WHERE id=$1', [Bytes32Schema.parse(id)])).rows[0];
  if (!row) throw new Error('Missing Guard availability manifest');
  return GuardAvailabilityManifestSchema.parse(row.data);
}
async function assertManifestUsable(db: ChainDb, id: string) {
  if ((await db.sql.query('SELECT 1 FROM guard_source_events WHERE target_id=$1',[id])).rows.length) throw new Error('Guard availability manifest invalidated');
}
async function validateSource(db: ChainDb, input: Document) {
  const m = await manifestAt(db, input.manifestId);
  await assertManifestUsable(db,input.manifestId);
  if (input.chainId !== input.cursor.chainId || input.chainId !== input.knownAt.cursor.chainId || input.chainId !== m.cut.cursor.chainId || input.sourceRevision !== m.sourceRevision) throw new Error('Guard source/manifest mismatch');
  if (!guardKnownBy(input.knownAt, m.cut) || compareGuardCursors(input.cursor, m.watermark) > 0 || compareGuardCursors(input.cursor, input.knownAt.cursor) > 0 || input.acquiredAt > m.acquiredAt) throw new Error('Guard source exceeds captured availability');
  if ('coverage' in input && input.coverage.through && compareGuardCursors(input.coverage.through,input.cursor) > 0) throw new Error('Coverage exceeds source state');
  await dependenciesAt(db, input.dependencyIds, input.chainId, input.knownAt, m.replayMode);
}
async function dependenciesAt(db: ChainDb, ids: readonly string[], chainId: number, cut: AvailabilityCut, replayMode: string) {
  for (const id of cleanHashes(ids)) {
    const rows = (await db.sql.query<{ id: string }>(`SELECT r.id FROM (${allTables.map((t) => `SELECT id,chain_id,manifest_id,known_position,known_hash,acquisition_sequence FROM ${t}`).join(' UNION ALL ')}) r JOIN guard_availability m ON m.id=r.manifest_id
      WHERE r.id=$1 AND r.chain_id=$2 AND r.known_position<=$3::numeric[] AND r.acquisition_sequence<=$4::numeric AND m.replay_mode=$5 AND (r.known_position[1]<>$6::numeric OR r.known_hash=$7)
      AND NOT EXISTS(SELECT 1 FROM (${eventTables.map((t) => `SELECT target_id,kind FROM ${t}`).join(' UNION ALL ')}) e WHERE e.target_id=r.id AND e.kind IN ('orphaned','dependency_invalidated'))`, [id, chainId, guardCursorPosition(cut.cursor), cut.acquisitionSequence, replayMode,cut.cursor.blockNumber,cut.cursor.blockHash])).rows;
    if (!rows.length) throw new Error('Guard dependency unavailable or invalidated');
  }
}
async function insertDocument<T extends Document>(db: ChainDb, table: Table, input: T, payloadHash: string, objectRef: string, content?: Uint8Array): Promise<GuardStoredRow<T>> {
  await validateSource(db, input);
  const { acquiredAt: _, ...identity } = input;
  const sourceKey = guardStorageHash({ table, ...identity, dependencyIds: cleanHashes(input.dependencyIds), payloadHash, objectRef });
  const columns = ['id','source_key','chain_id','coin','manifest_id','source_revision','state_position','state_hash','known_position','known_hash','acquisition_sequence','dependency_ids','payload_hash','object_ref','data','recorded_at'];
  const params: unknown[] = [sourceKey,sourceKey,input.chainId,input.coin,input.manifestId,input.sourceRevision,guardCursorPosition(input.cursor),input.cursor.blockHash,guardCursorPosition(input.knownAt.cursor),input.knownAt.cursor.blockHash,input.knownAt.acquisitionSequence,cleanHashes([...input.dependencyIds,input.manifestId]),payloadHash,objectRef,JSON.stringify(input),input.acquiredAt];
  if (content !== undefined) { columns.push('content'); params.push(Buffer.from(content)); }
  const inserted = (await db.sql.query<GuardStoredRow<T>>(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${params.map((_, i) => `$${i+1}`).join(',')}) ON CONFLICT(source_key) DO NOTHING RETURNING *`, params)).rows[0];
  if (inserted) {
    await db.notify(table.includes('coverage') ? 'guard_coverage_created' : table === 'guard_roles' ? 'guard_role_created' : 'guard_evidence_created', { id: sourceKey });
    return inserted;
  }
  return (await db.sql.query<GuardStoredRow<T>>(`SELECT * FROM ${table} WHERE source_key=$1`, [sourceKey])).rows[0];
}
function verifyContent(payloadHash: string, objectRef: string, content: Uint8Array) {
  const digest = keccak256(toHex(content));
  if (Bytes32Schema.parse(payloadHash) !== digest || Bytes32Schema.parse(objectRef) !== digest) throw new Error('Guard content hash mismatch');
}
async function appendEvent(db: ChainDb, table: EventTable, raw: unknown): Promise<string> {
  const input = GuardRevisionEventSchema.parse(raw);
  if ((input.kind === 'superseded') !== (input.replacementId !== null)) throw new Error('Guard supersession needs replacement');
  const { recordedAt: _, ...identity } = input;
  const id = guardStorageHash({ table, ...identity });
  const inserted = (await db.sql.query(`INSERT INTO ${table}(id,target_id,kind,replacement_id,cause_id,known_position,acquisition_sequence,data,recorded_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(target_id,kind,cause_id) DO NOTHING RETURNING id`, [id,input.targetId,input.kind,input.replacementId,input.causeId,guardCursorPosition(input.knownAt.cursor),input.knownAt.acquisitionSequence,JSON.stringify(input),input.recordedAt])).rows.length;
  if (inserted) await db.notify('guard_revision_invalidated', { id });
  else {
    const old = (await db.sql.query<{ id: string; data: GuardRevisionEvent }>(`SELECT id,data FROM ${table} WHERE target_id=$1 AND kind=$2 AND cause_id=$3`, [input.targetId,input.kind,input.causeId])).rows[0];
    if (!same({ ...old.data, recordedAt: null }, { ...input, recordedAt: null })) throw new Error('Conflicting Guard status replay');
    return old.id;
  }
  return id;
}

/** Indexer-only availability/source/role writes. No legacy backfill or masked zeros. */
export class GuardSourceStore {
  readonly writer = 'indexer';
  constructor(readonly db: ChainDb) {}
  async putManifest(raw: GuardAvailabilityManifest): Promise<GuardAvailabilityManifest> {
    const input = GuardAvailabilityManifestSchema.parse(raw);
    const { id, acquiredAt: _, ...key } = input;
    if (id !== guardManifestId(key) || compareGuardCursors(input.watermark, input.cut.cursor) > 0) throw new Error('Invalid Guard manifest identity/watermark');
    return this.db.tx(async (tx) => {
      const row = (await tx.sql.query<{ data: GuardAvailabilityManifest }>('INSERT INTO guard_availability(id,chain_id,source_id,source_revision,replay_mode,acquisition_sequence,known_position,watermark_position,data,acquired_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO NOTHING RETURNING data', [id,input.cut.cursor.chainId,input.sourceId,input.sourceRevision,input.replayMode,input.cut.acquisitionSequence,guardCursorPosition(input.cut.cursor),guardCursorPosition(input.watermark),JSON.stringify(input),input.acquiredAt])).rows[0];
      return row?.data ?? await manifestAt(tx, id);
    });
  }
  async putEvidence(raw: GuardStoredEvidence, content: Uint8Array) {
    const input = GuardStoredEvidenceSchema.parse(raw); validateEvidence(input); verifyContent(input.evidence.payloadHash,input.evidence.objectRef,content);
    return this.db.tx((tx) => insertDocument(tx,'guard_chain_evidence',input,input.evidence.payloadHash,input.evidence.objectRef,content));
  }
  async putRole(raw: GuardStoredRole, content: Uint8Array) {
    const input = GuardStoredRoleSchema.parse(raw); verifyContent(input.payloadHash,input.objectRef,content);
    if (input.status === 'verified' ? input.address === null || !input.evidenceIds.length : input.address !== null) throw new Error('Guard role needs proved address or explicit null');
    return this.db.tx(async (tx) => { await dependenciesAt(tx,input.evidenceIds,input.chainId,input.knownAt,(await manifestAt(tx,input.manifestId)).replayMode); return insertDocument(tx,'guard_roles',{ ...input, dependencyIds: cleanHashes([...input.dependencyIds,...input.evidenceIds]) },input.payloadHash,input.objectRef,content); });
  }
  async putCoverage(raw: GuardStoredCoverage) {
    const input = GuardStoredCoverageSchema.parse(raw), digest = guardStorageHash(input.coverage);
    return this.db.tx((tx) => insertDocument(tx,'guard_source_coverage',input,digest,digest));
  }
  supersede(targetId: string, replacementId: string, event: Omit<GuardRevisionEvent,'targetId'|'replacementId'|'kind'>) { return supersede(this.db,sourceTables,'guard_source_events',targetId,replacementId,event); }
  async invalidateReorg(input: GuardReorg) {
    const reorg=GuardReorgSchema.parse(input);
    return this.db.tx(async tx=>{
      await tx.sql.query('LOCK TABLE guard_availability,guard_source_events IN SHARE ROW EXCLUSIVE MODE');
      const manifests=(await tx.sql.query<{id:string}>(`SELECT id FROM guard_availability m WHERE chain_id=$1 AND (known_position[1]>=$2::numeric OR watermark_position[1]>=$2::numeric) AND NOT EXISTS(SELECT 1 FROM guard_source_events e WHERE e.target_id=m.id)`,[reorg.chainId,reorg.fromBlock])).rows;
      for(const m of manifests)await appendEvent(tx,'guard_source_events',{kind:'orphaned',targetId:m.id,replacementId:null,causeId:reorg.causeId,knownAt:reorg.knownAt,recordedAt:reorg.recordedAt});
      return invalidate(tx,sourceTables,'guard_source_events',reorg);
    });
  }
  invalidateDependencies(event: Omit<GuardRevisionEvent,'targetId'|'replacementId'|'kind'>) { return invalidateDependencies(this.db,sourceTables,'guard_source_events',event); }
}
function validateEvidence(input: GuardStoredEvidence) {
  if (!same(input.cursor,input.evidence.cursor) || !same(input.knownAt,input.evidence.knownAt)) throw new Error('Guard evidence cursor mismatch');
}
export class GuardMeasurementStore {
  readonly writer = 'normalizer';
  constructor(readonly db: ChainDb) {}
  async putEvidence(raw: GuardStoredEvidence, content: Uint8Array) {
    const input = GuardStoredEvidenceSchema.parse(raw); validateEvidence(input); verifyContent(input.evidence.payloadHash,input.evidence.objectRef,content);
    return this.db.tx((tx) => insertDocument(tx,'guard_measurement_evidence',input,input.evidence.payloadHash,input.evidence.objectRef,content));
  }
  async putCoverage(raw: GuardStoredCoverage) {
    const input = GuardStoredCoverageSchema.parse(raw), digest = guardStorageHash(input.coverage);
    return this.db.tx((tx) => insertDocument(tx,'guard_check_coverage',input,digest,digest));
  }
  supersede(targetId: string, replacementId: string, event: Omit<GuardRevisionEvent,'targetId'|'replacementId'|'kind'>) { return supersede(this.db,normalizerTables,'guard_measurement_events',targetId,replacementId,event); }
  invalidateReorg(input: GuardReorg) { return invalidate(this.db,normalizerTables,'guard_measurement_events',input); }
  invalidateDependencies(event: Omit<GuardRevisionEvent,'targetId'|'replacementId'|'kind'>) { return invalidateDependencies(this.db,normalizerTables,'guard_measurement_events',event); }
}
async function supersede(db: ChainDb, tables: readonly Table[], events: EventTable, targetId: string, replacementId: string, event: Omit<GuardRevisionEvent,'targetId'|'replacementId'|'kind'>) {
  return db.tx(async (tx) => {
    if (targetId === replacementId) throw new Error('Guard revision cannot supersede itself');
    const found = (await tx.sql.query<{ id: string; chain_id: string; coin: string; manifest_id: string; owner_table: string; known_position: string[]; acquisition_sequence: string }>(tables.map((t) => `SELECT id,chain_id,coin,manifest_id,'${t}' AS owner_table,known_position,acquisition_sequence FROM ${t} WHERE id=ANY($1::text[])`).join(' UNION ALL '), [[Bytes32Schema.parse(targetId),Bytes32Schema.parse(replacementId)]])).rows;
    if (found.length !== 2 || found[0].chain_id !== found[1].chain_id || found[0].coin !== found[1].coin || found[0].owner_table !== found[1].owner_table) throw new Error('Guard supersession ownership/context mismatch');
    if (BigInt(found[0].chain_id) !== BigInt(event.knownAt.cursor.chainId)) throw new Error('Guard supersession chain mismatch');
    const old = found.find((r) => r.id === targetId)!, next = found.find((r) => r.id === replacementId)!;
    if ((await manifestAt(tx,old.manifest_id)).replayMode !== (await manifestAt(tx,next.manifest_id)).replayMode) throw new Error('Cannot supersede across Guard replay modes');
    const position=guardCursorPosition(event.knownAt.cursor);
    const after=(p:readonly string[])=>{for(let i=0;i<p.length;i++){if(BigInt(p[i])!==BigInt(position[i]))return BigInt(p[i])>BigInt(position[i]);}return false;};
    if (found.some(r=>after(r.known_position) || BigInt(r.acquisition_sequence)>BigInt(event.knownAt.acquisitionSequence))) throw new Error('Guard supersession precedes its records');
    return appendEvent(tx,events,{ ...event, targetId, replacementId, kind: 'superseded' });
  });
}

/** Owner-local invalidation. Invoke indexer -> normalizer -> playbooks on reorg;
 * each writer appends its own events, retaining original payloads/proofs forever. */
async function invalidate(db: ChainDb, tables: readonly Table[], events: EventTable, raw: GuardReorg): Promise<string[]> {
  const reorg = GuardReorgSchema.parse(raw);
  if (reorg.chainId !== reorg.knownAt.cursor.chainId) throw new Error('Guard reorg chain mismatch');
  return db.tx(async (tx) => {
    await tx.sql.query(`LOCK TABLE ${tables.join(',')},${events} IN SHARE ROW EXCLUSIVE MODE`);
    const rows = (await tx.sql.query<{ id: string; dependency_ids: string[]; state_position: string[]; known_position: string[]; data: Document | GuardVerdictRevisionInput }>(tables.map((t) => `SELECT id,dependency_ids,state_position,known_position,data FROM ${t} WHERE chain_id=$1`).join(' UNION ALL '), [reorg.chainId])).rows;
    const invalid = new Set((await tx.sql.query<{ target_id: string }>(eventTables.map((t) => `SELECT target_id FROM ${t} WHERE kind IN ('orphaned','dependency_invalidated')`).join(' UNION ALL '))).rows.map((r) => r.target_id));
    const affected: string[] = [];
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) {
        if (invalid.has(row.id)) continue;
        const direct = BigInt(row.state_position[0]) >= BigInt(reorg.fromBlock) || BigInt(row.known_position[0]) >= BigInt(reorg.fromBlock);
        if (!direct && !row.dependency_ids.some((id) => invalid.has(id))) continue;
        await appendEvent(tx,events,{ targetId: row.id, replacementId: null, kind: direct ? 'orphaned' : 'dependency_invalidated', causeId: reorg.causeId, knownAt: reorg.knownAt, recordedAt: reorg.recordedAt });
        invalid.add(row.id); affected.push(row.id); changed = true;
      }
    }
    return affected;
  });
}

export class GuardVerdictStore {
  readonly writer = 'playbooks';
  constructor(readonly db: ChainDb) {}
  async putRevision(raw: GuardVerdictRevisionInput): Promise<GuardStoredRow<GuardVerdictRevisionInput>> {
    const input = GuardVerdictRevisionInputSchema.parse(raw), a = input.assessment;
    const { receipt: _, ...decision } = a;
    if (a.snapshotHash !== guardStorageHash(input.deterministicInput)) throw new Error('Guard raw input hash mismatch');
    if (a.decisionHash !== guardStorageHash(guardDecisionBody(a))) throw new Error('Guard different decision hash');
    return this.db.tx(async (tx) => {
      // Serializes competing decision/supersession/run writes. PGlite and PG use
      // the same constraints; no upsert ever rewrites an existing public record.
      await tx.sql.query('LOCK TABLE guard_verdict_revisions,guard_verdict_events IN SHARE ROW EXCLUSIVE MODE');
      const m = await manifestAt(tx,input.manifestId);
      await assertManifestUsable(tx,input.manifestId);
      if (m.cut.cursor.chainId !== a.chainId || input.sourceRevision !== m.sourceRevision || !guardKnownBy(a.availabilityCut,m.cut) || compareGuardCursors(a.cursor,m.watermark) > 0) throw new Error('Guard verdict exceeds source manifest');
      const deps = cleanHashes([...input.dependencyIds, ...a.checks.flatMap((c) => c.evidenceIds), ...a.factors.flatMap((f) => f.evidenceIds), ...a.reasons.flatMap((r) => r.evidenceIds)]);
      await dependenciesAt(tx,deps,a.chainId,a.availabilityCut,m.replayMode);
      const sourceRefs = (await tx.sql.query<{id:string;payload_hash:string;object_ref:string;data:Document|GuardVerdictRevisionInput}>(allTables.map(t=>`SELECT id,payload_hash,object_ref,data FROM ${t} WHERE id=ANY($1::text[])`).join(' UNION ALL '),[deps])).rows.sort((x,y)=>x.id.localeCompare(y.id)).map(({id,data,payload_hash,object_ref})=>{
        // Prior verdict dependencies are references, never recursively embedded receipts.
        if('assessment' in data) { const a=data.assessment;return {id,payloadHash:payload_hash,objectRef:object_ref,
          cursor:a.cursor,knownAt:a.availabilityCut,snapshotHash:a.snapshotHash,decisionHash:a.decisionHash}; }
        const {acquiredAt:_,...source}=data;return {id,...source,payloadHash:payload_hash,objectRef:object_ref};
      });
      const { acquiredAt: _time, ...manifest } = m;
      const deterministicInput = { scoring: input.deterministicInput, context: input.context, manifest, sourceRefs, dependencyIds: deps };
      const snapshotHash = guardStorageHash(deterministicInput);
      const key = guardReceiptRevisionKey({...decision,snapshotHash},input.manifestId,input.sourceRevision,input.context);
      const id = guardStorageHash(key);
      const derived = { ...decision, snapshotHash };
      derived.decisionHash = guardStorageHash(guardDecisionBody(derived));
      const semanticHash = guardStorageHash({ decision: {...derived,supersedes:null}, dependencyIds: deps });
      let stored = (await tx.sql.query<GuardStoredRow<GuardVerdictRevisionInput> & { semantic_hash: string }>('SELECT * FROM guard_verdict_revisions WHERE source_key=$1',[id])).rows[0];
      if (stored && stored.semantic_hash !== semanticHash) throw new Error('Same Guard key produced a different decision');
      if (!stored) {
        // A correction to the same executable boundary appends to that context's
        // revision chain, including an orphan predecessor. New blocks stand alone.
        if (derived.supersedes === null) {
          const previous=(await tx.sql.query<{id:string}>(`SELECT r.id FROM guard_verdict_revisions r JOIN guard_availability m ON m.id=r.manifest_id
            WHERE r.chain_id=$1 AND r.coin=$2 AND r.state_position=$3::numeric[] AND r.known_position<=$4::numeric[] AND r.acquisition_sequence<=$5::numeric
            AND NOT EXISTS(SELECT 1 FROM guard_verdict_events e WHERE e.target_id=r.id AND e.kind='superseded' AND e.known_position<=$4::numeric[] AND e.acquisition_sequence<=$5::numeric)
            AND r.data->'context'=$6::jsonb AND r.data->'assessment'->>'mode'=$7 AND m.source_id=$8 AND m.replay_mode=$9
            ORDER BY r.known_position DESC,r.acquisition_sequence DESC,r.recorded_at DESC,r.id DESC LIMIT 1`,
            [a.chainId,a.coin,guardCursorPosition(a.cursor),guardCursorPosition(a.availabilityCut.cursor),a.availabilityCut.acquisitionSequence,JSON.stringify(input.context),a.mode,m.sourceId,m.replayMode])).rows[0];
          derived.supersedes=previous?.id ?? null;
        }
        if (derived.supersedes !== null) {
          const old = (await tx.sql.query<{ data: GuardVerdictRevisionInput }>('SELECT data FROM guard_verdict_revisions WHERE id=$1',[derived.supersedes])).rows[0];
          if (!old || old.data.assessment.coin !== a.coin || old.data.assessment.chainId !== a.chainId || !same(old.data.context,input.context) || old.data.assessment.mode !== a.mode || (await manifestAt(tx,old.data.manifestId)).replayMode !== m.replayMode) throw new Error('Invalid Guard verdict supersession');
        }
        const receiptId = `guard:${id}`;
        const payload = GuardReceiptPayloadSchema.parse({schemaVersion:'guard-receipt-2',canonicalization:'jcs-rfc8785/v1',receiptId,revisionId:id,revisionKey:key,kind:'verdict',recordedAt:input.recordedAt,deterministicInput,decision:derived});
        const canonicalPayload = canonicalize(payload), payloadHash = keccak256(stringToHex(canonicalPayload));
        const recordedInput = {...input, deterministicInput, assessment: {...derived,receipt:{status:'recorded' as const,id:receiptId,payloadHash}}};
        stored = (await tx.sql.query<GuardStoredRow<GuardVerdictRevisionInput> & { semantic_hash: string }>(`INSERT INTO guard_verdict_revisions(id,source_key,chain_id,coin,manifest_id,source_revision,state_position,state_hash,known_position,known_hash,acquisition_sequence,dependency_ids,payload_hash,object_ref,data,recorded_at,semantic_hash,receipt_id,supersedes) VALUES($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,$13,$14,$15,$16,$17) RETURNING *`,[id,a.chainId,a.coin,input.manifestId,input.sourceRevision,guardCursorPosition(a.cursor),a.cursor.blockHash,guardCursorPosition(a.availabilityCut.cursor),a.availabilityCut.cursor.blockHash,a.availabilityCut.acquisitionSequence,cleanHashes([...deps,input.manifestId]),payloadHash,JSON.stringify(recordedInput),input.recordedAt,semanticHash,receiptId,derived.supersedes])).rows[0];
        await new GuardReceiptStore(tx).record(payload);
        if (derived.supersedes !== null) await appendEvent(tx,'guard_verdict_events',{ kind:'superseded',targetId:derived.supersedes,replacementId:id,causeId:id,knownAt:a.availabilityCut,recordedAt:input.recordedAt });
        await tx.notify('guard_verdict_created',{ id });
      }
      const run = (await tx.sql.query<{ revision_id: string }>('INSERT INTO guard_verdict_runs(run_id,revision_id,recorded_at) VALUES($1,$2,$3) ON CONFLICT(run_id) DO NOTHING RETURNING revision_id',[input.runId,id,input.recordedAt])).rows[0] ?? (await tx.sql.query<{ revision_id: string }>('SELECT revision_id FROM guard_verdict_runs WHERE run_id=$1',[input.runId])).rows[0];
      if (run.revision_id !== id) throw new Error('Guard run ID reused for another revision');
      return stored;
    });
  }
  invalidateReorg(input: GuardReorg) { return invalidate(this.db,verdictTables,'guard_verdict_events',input); }
  invalidateDependencies(event: Omit<GuardRevisionEvent,'targetId'|'replacementId'|'kind'>) { return invalidateDependencies(this.db,verdictTables,'guard_verdict_events',event); }
}

/** Readers select state AND availability, and never mix retrospective/production.
 * Historic reads consider only status events available at that original cut. */
export async function guardRowsKnownAt<T>(db: ChainDb, table: Table, input: GuardReadCut): Promise<GuardStoredRow<T>[]> {
  if (!allTables.includes(table)) throw new Error('Invalid Guard read table');
  const cut = AvailabilityCutSchema.parse(input.availability), coin = AddressSchema.parse(input.coin), m = await manifestAt(db,input.manifestId);
  if (cut.cursor.chainId !== input.chainId || input.state.chainId !== input.chainId || m.cut.cursor.chainId !== input.chainId || !guardKnownBy(cut,m.cut) || compareGuardCursors(input.state,cut.cursor) > 0) throw new Error('Invalid Guard read cut');
  const temporalEvents = input.validity === 'historic' ? 'AND e.known_position<=$3::numeric[] AND e.acquisition_sequence<=$4::numeric' : '';
  return (await db.sql.query<GuardStoredRow<T>>(`SELECT r.* FROM ${table} r JOIN guard_availability m ON m.id=r.manifest_id
    WHERE r.chain_id=$1 AND r.coin=$2 AND r.known_position<=$3::numeric[] AND r.acquisition_sequence<=$4::numeric AND r.state_position<=$5::numeric[] AND m.replay_mode=$6 AND m.source_id=$7
    AND (r.state_position[1]<>$8::numeric OR r.state_hash=$9) AND (r.known_position[1]<>$10::numeric OR r.known_hash=$11)
    AND NOT EXISTS(SELECT 1 FROM ${eventsFor(table)} e WHERE e.target_id=r.id ${temporalEvents})
    AND NOT EXISTS(SELECT 1 FROM guard_source_events e WHERE e.target_id=m.id ${temporalEvents})
    ORDER BY r.state_position,r.known_position,r.acquisition_sequence,r.id`,[input.chainId,coin,guardCursorPosition(cut.cursor),cut.acquisitionSequence,guardCursorPosition(input.state),m.replayMode,m.sourceId,input.state.blockNumber,input.state.blockHash,cut.cursor.blockNumber,cut.cursor.blockHash])).rows;
}

async function invalidateDependencies(db: ChainDb, tables: readonly Table[], events: EventTable, event: Omit<GuardRevisionEvent,'targetId'|'replacementId'|'kind'>): Promise<string[]> {
  return db.tx(async tx => {
    await tx.sql.query(`LOCK TABLE ${tables.join(',')},${events} IN SHARE ROW EXCLUSIVE MODE`);
    const rows = (await tx.sql.query<{ id:string;dependency_ids:string[] }>(tables.map(t=>`SELECT id,dependency_ids FROM ${t} WHERE chain_id=$1`).join(' UNION ALL '),[event.knownAt.cursor.chainId])).rows;
    const invalid = new Set((await tx.sql.query<{ target_id:string }>(eventTables.map(t=>`SELECT target_id FROM ${t}`).join(' UNION ALL '))).rows.map(r=>r.target_id));
    const affected:string[]=[]; let changed=true;
    while(changed) { changed=false; for(const row of rows) {
      if(invalid.has(row.id) || !row.dependency_ids.some(id=>invalid.has(id)))continue;
      await appendEvent(tx,events,{...event,kind:'dependency_invalidated',targetId:row.id,replacementId:null});
      invalid.add(row.id);affected.push(row.id);changed=true;
    }}
    return affected;
  });
}
