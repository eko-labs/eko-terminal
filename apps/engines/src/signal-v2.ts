import { readFile } from 'node:fs/promises';
import signalCodeFiles from './signal-code-files.json' with { type: 'json' };
import { keccak256, toHex } from 'viem';
import { guardRowsKnownAt, guardStorageHash, type ChainDb } from '@eko/db';
import {
  GuardCardMeasurementSchema, compareGuardCursors, guardKnownBy,
  type GuardAssessmentV2, type GuardStoredEvidence, type CoinSignal,
} from '@eko/shared';
import { computeSignalV2, shouldRecomputeSignal, type SignalInputV2 } from '@eko/signal';

const codeBase = new URL(import.meta.url.includes('/dist/') ? './guard-code/' : '../../../', import.meta.url);
const adapterCode = Promise.all(signalCodeFiles.map(p => readFile(new URL(p, codeBase), 'utf8'))).then(guardStorageHash);

/** Append-only captured shadow inputs/output. No source acquisition or public activation.
 * A real recorded Guard revision is required; uncaptured Guard journals are insufficient. */
export async function persistShadowSignalV2(db: ChainDb, target: {
  guard: GuardAssessmentV2; guardRevisionId: string; manifestId: string; sourceRevision: string;
  replayMode: 'production' | 'retrospective'; legacySignal?: CoinSignal; recordedAt: string;
}) {
  const { guard } = target, codeHash = await adapterCode;
  const last = (await db.sql.query<{snapshot_sec:string}>(`SELECT snapshot_sec FROM signal_shadow_runs
    WHERE coin=$1 AND replay_mode=$2 AND adapter_code_hash=$3 ORDER BY snapshot_sec DESC LIMIT 1`,
    [guard.coin,target.replayMode,codeHash])).rows[0];
  if (!shouldRecomputeSignal(last ? Number(last.snapshot_sec)*1000 : null, Number(guard.cursor.timestampSec)*1000)) return;
  const sources = await guardRowsKnownAt<GuardStoredEvidence>(db, 'guard_measurement_evidence', {
    chainId: guard.chainId, coin: guard.coin, manifestId: target.manifestId,
    state: guard.cursor, availability: guard.availabilityCut,
  });
  const input: SignalInputV2 = { guard, powers: [], lpStatus: null, ...(target.legacySignal ? {legacySignal:target.legacySignal} : {}) };
  const dependencyIds: string[] = [];
  for (const source of sources) {
    const content = (source as typeof source & {content:Uint8Array}).content;
    if (keccak256(toHex(content)) !== source.payload_hash) throw new Error('Signal source content hash mismatch');
    const parsed = GuardCardMeasurementSchema.safeParse(JSON.parse(new TextDecoder().decode(content)));
    if (!parsed.success) continue;
    const m = parsed.data;
    if (m.coin !== guard.coin || compareGuardCursors(m.cursor, guard.cursor) !== 0 ||
        !guardKnownBy(m.knownAt, guard.availabilityCut)) continue;
    if (m.control?.powers) input.powers.push(...m.control.powers);
    if (m.liquidity?.lpStatus) {
      if (input.lpStatus && guardStorageHash(input.lpStatus) !== guardStorageHash(m.liquidity.lpStatus))
        throw new Error('Ambiguous Signal LP measurement');
      input.lpStatus = m.liquidity.lpStatus;
    }
    if (m.control?.powers || m.liquidity?.lpStatus) dependencyIds.push(source.id);
  }
  const signal = computeSignalV2(input);
  const data = { mode: 'shadow', adapterVersion: '2.0.0', adapterCodeHash: codeHash,
    sourceRevision: target.sourceRevision, manifestId: target.manifestId,
    guardRevisionId: target.guardRevisionId, dependencyIds: dependencyIds.sort(), input, signal };
  await db.sql.query(`INSERT INTO signal_shadow_runs(id,coin,block,snapshot_sec,adapter_version,adapter_code_hash,
    replay_mode,manifest_id,guard_revision_id,guard_receipt_id,source_revision,data,recorded_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(id) DO NOTHING`,
    [guardStorageHash(data),guard.coin,guard.cursor.blockNumber,guard.cursor.timestampSec,'2.0.0',codeHash,
      target.replayMode,target.manifestId,target.guardRevisionId,guard.receipt.id,target.sourceRevision,JSON.stringify(data),target.recordedAt]);
}
