import { withRpcOrigin } from '@eko/chain';
import { mkdir, cp, rename, rm, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { RpcMeter, createMeteredClients, TraceAcquisition, fundingFromTraceBlock } from '@eko/chain';
import { openDb, hex } from '@eko/db';
import { EngineWorker } from './worker.js';
import { PilotManifestSchema, PilotStop, initialPilotCheckpoint, pilotHash, pilotReport, runCoveragePilot } from './coverage-pilot.js';
import type { PilotCheckpoint } from './coverage-pilot.js';
import { atomicPilotJson, readPilotJson, pilotFileHash, verifyPilotSnapshot, PilotUsageStore, pilotCostReport } from './coverage-pilot-store.js';
import type { PilotLedger } from './coverage-pilot-store.js';

/** Hash candidate code actually used by replay/acquisition, including local uncommitted edits. */
export async function pilotCandidateRevision() {
  const root = new URL('../../../', import.meta.url), hash = createHash('sha256');
  const files = ['pnpm-lock.yaml', 'tsconfig.base.json'];
  async function collect(path: string) {
    for (const entry of await readdir(new URL(path, root), { withFileTypes: true })) {
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) await collect(child);
      else if (entry.isFile() && /\.(ts|json|sql)$/.test(entry.name)) files.push(child);
    }
  }
  for (const area of ['apps/engines', 'packages/chain', 'packages/db', 'packages/shared', 'packages/playbooks', 'packages/policy', 'packages/signal', 'packages/untrusted']) {
    files.push(`${area}/package.json`, `${area}/tsconfig.json`);
    await collect(`${area}/src`);
  }
  await collect('packages/db/drizzle'); await collect('packages/playbooks/config');
  for (const path of [...new Set(files)].sort()) hash.update(path).update('\0').update(await readFile(new URL(path, root))).update('\0');
  return hash.digest('hex');
}
const rpcLog = z.object({ address: z.string().regex(/^0x[0-9a-fA-F]{40}$/), blockNumber: z.string().regex(/^0x[0-9a-fA-F]+$/),
  blockHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/), transactionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  logIndex: z.string().regex(/^0x[0-9a-fA-F]+$/), topics: z.array(z.string().regex(/^0x[0-9a-fA-F]{64}$/)),
  blockTimestamp: z.string().regex(/^0x[0-9a-fA-F]+$/), removed: z.boolean().optional() }).passthrough();
const quantity = (n: string) => `0x${BigInt(n).toString(16)}`;
export async function coveragePilotMain(args: string[]) {
  if (args.length !== 4 || !['--local', '--acquire'].includes(args[0])) throw new Error('Usage: coverage-pilot-cli.ts --local|--acquire manifest.json snapshot-directory output-directory');
  const acquire = args[0] === '--acquire';
  const m = PilotManifestSchema.parse(JSON.parse(await readFile(args[1], 'utf8')));
  if (acquire && (!m.budget.approvalRef || !m.budget.pricingEvidence || m.validation !== 'measured')) throw new Error('Measured manifest, recorded approval and verified pricing required');
  if (acquire && !process.env.RPC_HTTP_URL) throw new Error('RPC_HTTP_URL required');
  const snapshot = resolve(args[2]), output = resolve(args[3]);
  if (output === snapshot || output.startsWith(`${snapshot}/`) || snapshot.startsWith(`${output}/`)) throw new Error('Snapshot and output must be separate');
  await verifyPilotSnapshot(snapshot, m);
  await mkdir(output, { recursive: true });
  const lock = join(output, 'runner.lock');
  await mkdir(lock); // Exclusive owner; crashed locks require explicit inspection/removal by lead.
  let db: Awaited<ReturnType<typeof openDb>> | undefined, rpc: ReturnType<typeof createMeteredClients> | undefined;
  let stopped = false, worker: EngineWorker | undefined;
  const stop = () => { stopped = true; worker?.stop(); rpc?.meter.stop(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    const candidate = await pilotCandidateRevision(), manifestHash = pilotHash(m);
    const c = await readPilotJson<PilotCheckpoint>(join(output, 'checkpoint.json')) ?? initialPilotCheckpoint(m, candidate);
    if (c.manifestHash !== manifestHash || c.candidateRevision !== candidate) throw new Error('Checkpoint source/candidate changed; use a separate output');
    const existing = await readPilotJson<{ hash: string }>(join(output, 'manifest.json'));
    if (existing && existing.hash !== manifestHash) throw new Error('Output manifest mismatch');
    await atomicPilotJson(join(output, 'manifest.json'), { hash: manifestHash, manifest: m });
    const ledger = await readPilotJson<PilotLedger>(join(output, 'usage.json')) ?? { version: 1 as const, manifestHash, calls: 0, units: 0, paidNanoUsd: '0', rows: [] };
    const store = new PilotUsageStore(m, ledger, value => atomicPilotJson(join(output, 'usage.json'), value));
    await atomicPilotJson(join(output, 'usage.json'), ledger);
    if (acquire) {
      const meter = new RpcMeter({ RPC_HTTP_URL: process.env.RPC_HTTP_URL,
        RPC_PUBLIC_HTTP_URL: process.env.RPC_PUBLIC_HTTP_URL,
        RPC_PAID_MAX_RPM: String(m.budget.paidStartsPerSecond * 60), RPC_PUBLIC_MAX_RPM: String(m.budget.publicStartsPerSecond * 60),
        RPC_PAID_DAILY_BUDGET: String(m.budget.checkpointUnits), RPC_WEIGHTS: JSON.stringify(m.budget.weights) },
      { store, onSessionBudget: stop, log: () => {}, alert: () => {} });
      rpc = createMeteredClients({}, { meter });
    }
    const replayDir = join(output, 'replay-db');
    const copied = await readPilotJson<{ manifestHash: string }>(join(output, 'replay-copy.json'));
    if (copied && copied.manifestHash !== manifestHash) throw new Error('Replay copy source mismatch');
    if (!copied) {
      const temp = join(output, 'replay-db-copy');
      try {
        await verifyPilotSnapshot(replayDir, m); // Recover a complete copy whose marker write was interrupted.
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await rm(temp, { recursive: true, force: true });
        await cp(snapshot, temp, { recursive: true, errorOnExist: true, force: false });
        await verifyPilotSnapshot(temp, m);
        await rename(temp, replayDir);
      }
      await atomicPilotJson(join(output, 'replay-copy.json'), { manifestHash });
    }
    await mkdir(join(output, 'artifacts'), { recursive: true });
    let pinned = false;
    async function checkPins() {
      if (!rpc) throw new PilotStop('acquisition_not_requested');
      if (!pinned && await rpc.archive.getChainId() !== 4663) throw new Error('Pilot chain mismatch');
      for (const cursor of [m.from, m.through]) {
        const header = await rpc.archive.getBlock({ blockNumber: BigInt(cursor.blockNumber) });
        if (header.hash?.toLowerCase() !== cursor.blockHash.toLowerCase() || header.timestamp.toString() !== cursor.timestampSec) throw new Error('Pilot boundary mismatch');
      }
      pinned = true;
    }
    const traces = rpc ? new TraceAcquisition(rpc, 1) : null;
    const result = await runCoveragePilot(m, c, {
      now: () => performance.now(), rss: () => process.memoryUsage().rss, stopped: () => stopped,
      save: async value => {
        await atomicPilotJson(join(output, 'checkpoint.json'), value);
        const report = { ...pilotReport(m, value), cost: pilotCostReport(m, ledger),
          process: { pid: process.pid, checkpoint: 'checkpoint.json', usage: 'usage.json', artifacts: 'artifacts', nextAction:
            value.status === 'complete' ? 'review_coverage_and_frozen_target' : 'inspect_reason_then_resume_same_manifest_candidate' } };
        await atomicPilotJson(join(output, 'report.json'), report);
        console.log(JSON.stringify({ event: 'coverage_pilot_checkpoint', status: value.status, reason: value.reason,
          pendingJobs: value.pending.length, completedJobs: value.completed.length, units: ledger.units, paidNanoUsd: ledger.paidNanoUsd }));
      },
      replay: async () => {
        db ??= await openDb({ pgliteDir: replayDir });
        const tokens = (await db.sql.query<{ address: Uint8Array }>('SELECT address FROM tokens WHERE first_block <= $1 ORDER BY address', [m.through.blockNumber])).rows.map(r => hex(r.address));
        if (JSON.stringify(tokens.sort()) !== JSON.stringify(m.selected.map(s => s.coin).sort())) throw new Error('Snapshot selected universe mismatch');
        const began = performance.now();
        // Existing timestamps only: no readBlock/profile clients, no every-empty-block RPC.
        worker = new EngineWorker(db, { onProgress: n => {
          c.peakRssBytes = Math.max(c.peakRssBytes, process.memoryUsage().rss);
          if (n % 100 === 0) console.log(JSON.stringify({ event: 'coverage_pilot_replay', evaluations: n, ...worker!.telemetry() }));
        } });
        if (stopped) worker.stop();
        const evaluations = await worker.replay(Number(m.from.blockNumber), Number(m.through.blockNumber));
        return { complete: !stopped, evaluations, elapsedMs: performance.now() - began };
      },
      artifact: async key => {
        const record = await readPilotJson<{ hash: string; status: string }>(join(output, 'artifacts', `${key}.ref.json`));
        if (record && await pilotFileHash(join(output, 'artifacts', `${key}.json`)) !== record.hash) throw new Error('Pilot artifact changed');
        return record;
      },
      putArtifact: async (key, value, status) => {
        const path = join(output, 'artifacts', `${key}.json`);
        await atomicPilotJson(path, value);
        const hash = await pilotFileHash(path);
        await atomicPilotJson(join(output, 'artifacts', `${key}.ref.json`), { hash, status });
        return hash;
      },
      logs: async job => {
        if (!pinned) await checkPins();
        const value = await withRpcOrigin('engines.coverage_pilot_cli.rawL140',()=>rpc!.archive.request({ method: 'eth_getLogs', params: [{ fromBlock: quantity(job.from), toBlock: quantity(job.through),
          address: job.addresses, topics: job.topics }] } as never));
        const logs = z.array(rpcLog).parse(value);
        for (const log of logs) {
          if (log.removed || !job.addresses.includes(log.address.toLowerCase()) || BigInt(log.blockNumber) < BigInt(job.from) || BigInt(log.blockNumber) > BigInt(job.through) ||
            job.topics.some((topic, index) => topic !== null && !(Array.isArray(topic) ? topic : [topic]).map(t => t.toLowerCase()).includes(log.topics[index]?.toLowerCase()))) throw new Error('Log filter mismatch');
        }
        await checkPins();
        return { job, logs, sourceRevision: m.sourceRevision, availability: m.availability };
      },
      trace: async job => {
        if (!pinned) await checkPins();
        try {
          const block = await traces!.acquire(job.cursor);
          return { status: block.status, value: { job, block, funding: fundingFromTraceBlock(block, []), diagnosticOnly: true,
            sourceRevision: m.sourceRevision, availability: m.availability } };
        } finally { await traces!.release(job.cursor); }
      },
      rangeLimit: error => {
        // Match only provider range/response limits; never persist arbitrary error text or URLs.
        const text = error instanceof Error ? error.message : '';
        return /too many results|query exceeds limit|response body exceeded|range .*not supported|limited to .*addresses.*blocks/i.test(text);
      },
    }, acquire);
    return result.status === 'failed' ? 1 : result.status === 'stopped' ? 2 : 0;
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    try { await rpc?.meter.close(); } finally { try { await db?.close(); } finally { await rm(lock, { recursive: true }); } }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  coveragePilotMain(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(() => {
    console.error('Coverage pilot halted; inspect manifest, checkpoint, budget and snapshot.'); process.exitCode = 1;
  });
}
