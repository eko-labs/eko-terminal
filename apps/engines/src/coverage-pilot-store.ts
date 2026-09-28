import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { readFile, rename, lstat, readdir, open } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { UsageStore } from '@eko/chain';
import { PilotStop, pilotHash, type PilotManifest } from './coverage-pilot.js';

export async function atomicPilotJson(path: string, value: unknown) {
  const file = await open(`${path}.tmp`, 'w', 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
  await rename(`${path}.tmp`, path);
  const directory = await open(dirname(path), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
export async function readPilotJson<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error('Invalid pilot file'); }
}
export async function pilotFileHash(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
/** Closed, stopped PGlite snapshot only. Reject extra files and symlinks before copying. */
export async function verifyPilotSnapshot(root: string, m: PilotManifest) {
  const actual: string[] = [];
  async function walk(path: string, relative: string) {
    if ((await lstat(path)).isSymbolicLink()) throw new Error('Snapshot symlink rejected');
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error('Snapshot symlink rejected');
      if (entry.isDirectory()) await walk(join(path, entry.name), child);
      else if (entry.isFile()) actual.push(child);
      else throw new Error('Unsupported snapshot entry');
    }
  }
  await walk(root, '');
  if (JSON.stringify(actual.sort()) !== JSON.stringify(m.snapshotFiles.map(f => f.path).sort())) throw new Error('Snapshot inventory mismatch');
  for (const file of m.snapshotFiles) if (await pilotFileHash(join(root, file.path)) !== file.sha256) throw new Error('Snapshot content mismatch');
}
export interface PilotLedger {
  version: 1; manifestHash: string; calls: number; units: number; paidNanoUsd: string;
  rows: { day: string; provider: 'paid' | 'public'; method: string; calls: number; units: number }[];
}
/** RpcMeter reserves every attempt before dispatch, including retries and subrequests.
 * Crash between reservation and dispatch stays conservatively charged to the cap.
 * Only this isolated job uses the store; baseline ingest has its own store/budget.
 */
export class PilotUsageStore implements UsageStore {
  private serial: Promise<unknown> = Promise.resolve();
  constructor(readonly manifest: PilotManifest, readonly ledger: PilotLedger,
    private readonly save: (ledger: PilotLedger) => Promise<void>) {
    if (ledger.version !== 1 || ledger.manifestHash !== pilotHash(manifest) || !Number.isSafeInteger(ledger.units) || ledger.units < 0 ||
      !Number.isSafeInteger(ledger.calls) || ledger.calls < 0 || !/^(0|[1-9]\d*)$/.test(ledger.paidNanoUsd) ||
      ledger.rows.some(r => !/^\d{4}-\d{2}-\d{2}$/.test(r.day) || !['paid', 'public'].includes(r.provider) ||
        !Number.isSafeInteger(r.calls) || r.calls < 0 || !Number.isSafeInteger(r.units) || r.units < 0) ||
      ledger.rows.reduce((n, r) => n + r.units, 0) !== ledger.units || ledger.rows.reduce((n, r) => n + r.calls, 0) !== ledger.calls ||
      BigInt(ledger.paidNanoUsd) !== BigInt(ledger.rows.filter(r => r.provider === 'paid').reduce((n, r) => n + r.units, 0)) * BigInt(manifest.budget.rpcUnitNanoUsd)) throw new Error('Pilot ledger mismatch');
  }
  reserve(day: string, provider: 'paid' | 'public', method: string, units: number, _limit: number) {
    const result = this.serial.then(async () => {
      const budget = this.manifest.budget;
      if (!budget.approvalRef || !budget.pricingEvidence) throw new PilotStop('approval_or_pricing_missing');
      if (!Number.isSafeInteger(units) || units !== budget.weights[method]) throw new PilotStop('method_weight_unverified');
      const fixed = BigInt(budget.computeStorageNanoUsd) + BigInt(budget.indexedSubscriptionNanoUsd) + BigInt(budget.humanReviewNanoUsd);
      const cost = provider === 'paid' ? BigInt(units) * BigInt(budget.rpcUnitNanoUsd) : 0n;
      if (this.ledger.units + units > budget.checkpointUnits || BigInt(this.ledger.paidNanoUsd) + fixed + cost > BigInt(budget.capNanoUsd))
        return { allowed: false, total: this.ledger.units };
      const next: PilotLedger = structuredClone(this.ledger);
      next.units += units; next.calls++; next.paidNanoUsd = (BigInt(next.paidNanoUsd) + cost).toString();
      let row = next.rows.find(r => r.day === day && r.provider === provider && r.method === method);
      if (!row) { row = { day, provider, method, calls: 0, units: 0 }; next.rows.push(row); }
      row.calls++; row.units += units;
      await this.save(next); Object.assign(this.ledger, next);
      return { allowed: true, total: this.ledger.units };
    });
    this.serial = result.catch(() => undefined); return result;
  }
  async today(day: string) { await this.serial; return this.ledger.rows.filter(r => r.day === day).map(({ day: _day, ...row }) => ({ ...row })); }
}
export function pilotCostReport(m: PilotManifest, ledger: PilotLedger) {
  const category = (trace: boolean) => ledger.rows.filter(r => r.method.startsWith('debug_trace') === trace)
    .reduce((n, r) => ({ calls: n.calls + r.calls, units: n.units + r.units }), { calls: 0, units: 0 });
  return { admittedCalls: ledger.calls, admittedRequestUnits: ledger.units, requestAttempts: ledger.rows,
    pricing: { evidence: m.budget.pricingEvidence, rpcUnitNanoUsd: m.budget.rpcUnitNanoUsd, weights: m.budget.weights },
    marginalRpcNanoUsd: ledger.paidNanoUsd, invoiceChargedNanoUsd: null,
    accounting: 'pre_dispatch_admissions_including_retries_crash_reservations_conservative',
    capNanoUsd: m.budget.capNanoUsd, checkpointUnits: m.budget.checkpointUnits,
    categories: { confirmationsAndLogs: category(false), blockTraces: category(true), indexedPages: { calls: 0, units: 0 },
      anvilUpstream: { calls: 0, units: 0 }, computeStorageNanoUsd: m.budget.computeStorageNanoUsd,
      indexedSubscriptionNanoUsd: m.budget.indexedSubscriptionNanoUsd, humanReviewNanoUsd: m.budget.humanReviewNanoUsd } };
}
