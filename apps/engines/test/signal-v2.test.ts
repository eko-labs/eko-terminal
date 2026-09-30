import { afterAll, beforeAll, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { keccak256, toHex } from 'viem';
import {
  migrate, migrateEngines, GuardSourceStore, GuardMeasurementStore, GuardVerdictStore,
  guardManifestId, guardStorageHash, type ChainDb,
} from '@eko/db';
import { openDb } from '../../../packages/db/test/helpers/historical-db.js';
import {
  CoinCardV2Schema, CoinSignalV2Schema, GUARD_CAPABILITIES,
  type CoinSignalV2, type GuardVerdictRevisionInput, type CoinSignal,
} from '@eko/shared';
import { evaluateGuardV2 } from '@eko/playbooks';
import { computeSignalV2, SIGNAL_WEIGHTS, type SignalInputV2 } from '@eko/signal';
import { input, metric, NOW } from '../../../packages/playbooks/test/scoring-fixtures.js';
import { power } from '../../../packages/shared/test/fixtures/contracts/guard-v2.js';
import { persistShadowSignalV2 } from '../src/signal-v2.js';

let db: ChainDb;
beforeAll(async () => { db = await openDb({pgliteDir:':memory:'}); await migrate(db); await migrateEngines(db); },30000);
afterAll(async () => { await db?.close(); });
const legacySignal: CoinSignal = { composite:100, readings:{momentum:100,liquidity:100,holders:100,narrative:100,risk:100},
  weights:{...SIGNAL_WEIGHTS},beta:true,asOfBlock:NOW,lowData:[] };

async function snapshot(elapsed: number, replayMode: 'production' | 'retrospective' = 'production') {
  // Pure synthetic captured state; never acquired from a provider.
  const source = input();
  const cursor = { ...source.cursor,blockNumber:String(NOW+elapsed),timestampSec:String(NOW+elapsed) };
  const cut = { ...source.availabilityCut,cursor };
  source.cursor = cursor; source.availabilityCut = cut;
  const key = {sourceId:'signal-fixture',sourceRevision:guardStorageHash({fixture:elapsed}),replayMode,cut,watermark:cursor};
  const manifest = { ...key,id:guardManifestId(key),acquiredAt:'2026-10-02T00:00:00.000Z' };
  await new GuardSourceStore(db).putManifest(manifest);
  const powers = GUARD_CAPABILITIES.map(capability => ({ ...power,capability,
    reachable:{...metric(capability==='mint','boolean'),cursor,knownAt:cut},
  }));
  const lpStatus = { ...metric('removable','status'),id:'lpStatus',cursor,knownAt:cut };
  const content = new TextEncoder().encode(JSON.stringify({schemaVersion:'guard-card-measurements-2',coin:source.coin,cursor,knownAt:cut,
    control:{powers},liquidity:{lpStatus}}));
  const digest = keccak256(toHex(content));
  const row = await new GuardMeasurementStore(db).putEvidence({chainId:4663,coin:source.coin,manifestId:manifest.id,
    sourceItemId:'signal-controls',sourceRevision:manifest.sourceRevision,cursor,knownAt:cut,acquiredAt:manifest.acquiredAt,
    methodVersion:'2.0.0',dependencyIds:[],evidence:{id:digest,kind:'state',cursor,knownAt:cut,payloadHash:digest,objectRef:digest,supersedes:null}},content);
  // Bind synthetic history proof to this captured fixture row, rather than the
  // standalone scorer fixture's unstored evidence IDs.
  source.historySource!.operator!.evidenceIds = [row.id as `0x${string}`];
  const result = evaluateGuardV2(source);
  const stored = await new GuardVerdictStore(db).putRevision({ assessment:result.assessment,deterministicInput:result.deterministicInput,manifestId:manifest.id,sourceRevision:manifest.sourceRevision,
    context:{routeId:null,sizeUsd:null,accountClass:null},dependencyIds:[row.id as `0x${string}`],recordedAt:manifest.acquiredAt,runId:`fixture-${elapsed}-${replayMode}` });
  return {guard:stored.data.assessment,guardRevisionId:stored.id,manifestId:manifest.id,sourceRevision:manifest.sourceRevision,
    replayMode,legacySignal,recordedAt:manifest.acquiredAt};
}

it('records independently hashed adapter inputs/methods and exact Guard receipt, preserving repeat history', async () => {
  const target = await snapshot(0); await persistShadowSignalV2(db,target);
  const rows = (await db.sql.query<{data:{signal:CoinSignalV2;input:SignalInputV2;dependencyIds:string[]};guard_receipt_id:string}>(
    'SELECT * FROM signal_shadow_runs')).rows;
  expect(rows).toHaveLength(1);
  expect(CoinSignalV2Schema.parse(rows[0].data.signal)).toEqual(rows[0].data.signal);
  expect(rows[0].guard_receipt_id).toBe(target.guard.receipt.id);
  expect(rows[0].data.signal).toMatchObject({guardReceiptId:target.guard.receipt.id,readings:{risk:75},inputMethodVersions:{risk:'2.0.0'}});
  expect(computeSignalV2(rows[0].data.input)).toEqual(rows[0].data.signal);
  expect(rows[0].data.dependencyIds).toHaveLength(1);
  await persistShadowSignalV2(db,target); await migrateEngines(db);
  expect((await db.sql.query('SELECT * FROM signal_shadow_runs')).rows).toHaveLength(1);
  await expect(db.sql.query("UPDATE signal_shadow_runs SET adapter_version='2.0.0'")).rejects.toThrow('append-only');
});

it('refreshes at exactly 15 seconds, preserves separate replay lanes and never rewrites cached data', async () => {
  const original = (await db.sql.query('SELECT data FROM signal_shadow_runs')).rows[0].data;
  await persistShadowSignalV2(db,await snapshot(14));
  expect((await db.sql.query('SELECT * FROM signal_shadow_runs')).rows).toHaveLength(1);
  await persistShadowSignalV2(db,await snapshot(15));
  expect((await db.sql.query('SELECT * FROM signal_shadow_runs')).rows).toHaveLength(2);
  await persistShadowSignalV2(db,await snapshot(15,'retrospective'));
  expect((await db.sql.query('SELECT * FROM signal_shadow_runs')).rows).toHaveLength(3);
  expect((await db.sql.query('SELECT data FROM signal_shadow_runs WHERE block=$1',[NOW])).rows[0].data).toEqual(original);
});

it('V2 Signal is not a dependency of Guard/policy or either Radar ranking implementation', async () => {
  for (const path of ['packages/playbooks/src/guard-scoring.ts','packages/policy/src/guard.ts',
    'packages/policy/src/preflight.ts','apps/server/src/read/radar.ts']) {
    const source = await readFile(new URL(`../../../${path}`,import.meta.url),'utf8');
    expect(source).not.toMatch(/from ['"]@eko\/signal|computeSignalV2|signalPresentationV2/);
  }
  expect((await db.sql.query<{data:GuardVerdictRevisionInput}>('SELECT data FROM guard_verdict_revisions')).rows
    .every(r => r.data.deterministicInput !== null && typeof r.data.deterministicInput === 'object' && !('signal' in r.data.deterministicInput))).toBe(true);
});
