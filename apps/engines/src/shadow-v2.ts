import { persistShadowSignalV2 } from './signal-v2.js';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import guardCodeFiles from './guard-code-files.json' with { type: 'json' };
import { keccak256, toHex } from 'viem';
import { canonicalize } from '@eko/policy';
import { guardScoreHash } from '@eko/playbooks';
import { IncrementalGuardCache } from './incremental-guard.js';
const shadowCache = new IncrementalGuardCache();
import { GuardAvailabilityManifestSchema, GuardScoreInputSchema, GuardShadowRunSchema, Bytes32Schema, compareGuardCursors } from '@eko/shared';
import type { Address, GuardAvailabilityManifest, GuardStoredEvidence, GuardStoredRole, GuardScoreInput, CoinSignal } from '@eko/shared';
import { GuardVerdictStore, guardRowsKnownAt, guardStorageHash, hex } from '@eko/db';
import { appendSnapshotObservations } from './shadow-observations.js';
import type { ChainDb } from '@eko/db';

// Hash the actual candidate implementation once; never label its unpassed gates as released.
const codeBase = new URL(import.meta.url.includes('/dist/') ? './guard-code/' : '../../../', import.meta.url);
const candidateCode = Promise.all(guardCodeFiles.map(p => readFile(new URL(p, codeBase), 'utf8'))).then(guardScoreHash);

/** Packet 033: normalized captured observations only. Legacy holdings/exemptions and
 * simulation placeholders cannot establish Guard float, sale harm or control predicates. */
export async function persistShadowGuardV2(db: ChainDb, target: { coin: Address; block: number; sec: number;
  legacyVerdictId: string; replayMode: 'production' | 'retrospective'; legacySignal?: CoinSignal }) {
  const header = (await db.sql.query<{hash:Uint8Array | null}>('SELECT hash FROM engine_block_times WHERE number=$1',[target.block])).rows[0];
  const codeHash = await candidateCode, recordedAt = new Date().toISOString();
  if (!header?.hash) {
    const data = { coin: target.coin, block: String(target.block), legacyVerdictId: target.legacyVerdictId,
      codeHash, failureCode: 'missing_cursor', replayMode: target.replayMode };
    // No invented block hash, acquisition sequence, or recorded Guard assessment.
    await journal(db, guardStorageHash(data), target, null, null, 'missing_cursor', data, recordedAt); return;
  }
  const cursor = { chainId: 4663, blockNumber: String(target.block), blockHash: hex(header.hash), timestampSec: String(target.sec),
    transactionIndex: null, executionOrdinal: null, boundary: 'block_end' as const };
  const rows = (await db.sql.query<{data:unknown}>(`SELECT m.data FROM guard_availability m
    WHERE m.chain_id=4663 AND m.replay_mode=$1 AND m.watermark_position[1]=$2
    AND NOT EXISTS(SELECT 1 FROM guard_source_events e WHERE e.target_id=m.id)
    ORDER BY m.acquisition_sequence DESC,m.id`,[target.replayMode,target.block])).rows;
  let manifest: GuardAvailabilityManifest | null = null;
  for (const row of rows) { const m=GuardAvailabilityManifestSchema.parse(row.data);
    if (compareGuardCursors(m.watermark,cursor)===0) {manifest=m; break;} }
  // Uncaptured journals have no revision or signal and are not consumed by card/verdict readers.
  if (!manifest) return;
  let input: GuardScoreInput = GuardScoreInputSchema.parse({coin:target.coin,cursor,
    availabilityCut:manifest?.cut ?? {cursor,acquisitionSequence:'0'},mode:'shadow',observations:[],checks:[],decisive:[],informational:[],
    historySource:null,shadowBooster:false,codeHash,profileHash:guardScoreHash(null),serviceRegistryHash:guardScoreHash(null),calibrationManifestHash:guardScoreHash(null)});
  const dependencyIds: `0x${string}`[]=[];
  if (manifest) {
    const cut={chainId:4663,coin:target.coin,manifestId:manifest.id,availability:manifest.cut,state:cursor};
    const measurements=await guardRowsKnownAt<GuardStoredEvidence>(db,'guard_measurement_evidence',cut);
    const current=measurements.filter(r=>r.data.sourceItemId==='guard-score-inputs' && compareGuardCursors(r.data.cursor,cursor)===0);
    if (current.length>1) throw new Error('Ambiguous current Guard scoring envelope');
    const source=current[0];
    if (source) {
      const content=(await db.sql.query<{content:Uint8Array}>('SELECT content FROM guard_measurement_evidence WHERE id=$1',[source.id])).rows[0].content;
      if(keccak256(toHex(content))!==source.payload_hash)throw new Error('Guard scoring content hash mismatch');
      const captured=GuardScoreInputSchema.parse(JSON.parse(new TextDecoder().decode(content)));
      if(captured.coin!==target.coin || compareGuardCursors(captured.cursor,cursor)!==0 || canonicalize(captured.availabilityCut)!==canonicalize(manifest.cut))
        throw new Error('Guard scoring envelope context mismatch');
      input={...captured,mode:'shadow',shadowBooster:false,codeHash}; dependencyIds.push(Bytes32Schema.parse(source.id));
    } else {
      const roles=await guardRowsKnownAt<GuardStoredRole>(db,'guard_roles',cut);
      const principals=roles.filter(r=>r.data.role==='launch_principal' && r.data.status==='verified');
      if(principals.length>1)throw new Error('Ambiguous captured principal');
      const principal=principals[0]?{...principals[0].data,evidenceIds:[Bytes32Schema.parse(principals[0].id)]}:null;
      for(const measurement of measurements) {
        if(compareGuardCursors(measurement.data.cursor,cursor)!==0)continue;
        const content=(measurement as typeof measurement & {content:Uint8Array}).content;
        if(keccak256(toHex(content))!==measurement.payload_hash)throw new Error('Guard snapshot content hash mismatch');
        const before=input.observations.length+input.checks.length;
        appendSnapshotObservations(input,JSON.parse(new TextDecoder().decode(content)),Bytes32Schema.parse(measurement.id),principal);
        if(input.observations.length+input.checks.length>before)dependencyIds.push(Bytes32Schema.parse(measurement.id));
      }
    }
  }
  const sourceRevision=manifest?.sourceRevision ?? guardScoreHash({method:'uncaptured-shadow',cursor});
  const result=shadowCache.evaluate(input,{sourceRevision:sourceRevision.slice(2),route:null,sizeRaw:null,account:null});
  const id=guardScoreHash({legacyVerdictId:target.legacyVerdictId,replayMode:target.replayMode,sourceRevision,input});
  let run=GuardShadowRunSchema.parse({id,legacyVerdictId:target.legacyVerdictId,manifestId:manifest?.id ?? null,
    sourceRevision,input,...result,recordedAt});
  let revisionId:string|null=null;
  if(manifest) {
    const stored=await new GuardVerdictStore(db).putRevision({assessment:result.assessment,deterministicInput:result.deterministicInput,manifestId:manifest.id,
      sourceRevision,context:{routeId:null,sizeUsd:null,accountClass:null},dependencyIds,recordedAt,runId:`shadow:${randomUUID()}`});
    revisionId=stored.id; run={...run,assessment:stored.data.assessment,deterministicInput:stored.data.deterministicInput,recordedAt:stored.data.recordedAt};
  }
  await journal(db,id,target,manifest?.id ?? null,revisionId,'evaluated',run,recordedAt);
  if (manifest && revisionId) await persistShadowSignalV2(db,{guard:run.assessment,guardRevisionId:revisionId,
    manifestId:manifest.id,sourceRevision,replayMode:target.replayMode,legacySignal:target.legacySignal,recordedAt});
}
async function journal(db:ChainDb,id:string,target:{coin:Address;block:number;legacyVerdictId:string},manifestId:string|null,
  revisionId:string|null,status:string,data:unknown,recordedAt:string) {
  await db.sql.query(`INSERT INTO guard_shadow_runs(id,coin,block,legacy_verdict_id,manifest_id,revision_id,status,data,recorded_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO NOTHING`,
    [id,target.coin,target.block,target.legacyVerdictId,manifestId,revisionId,status,JSON.stringify(data),recordedAt]);
}
