import type { AddressRegistry } from './registry.js';
import { verifyChain, type VerifyClient, type VerificationReport } from './verify.js';
import type { BuildRecords } from './build-records.js';

export function verificationMode(args: readonly string[]): boolean {
  if (args.some(arg => arg !== '--prelaunch') || args.length > 1) throw new Error('Usage: verify:chain [--prelaunch]');
  return args.includes('--prelaunch');
}
export function verificationSummary(report: VerificationReport, prelaunch: boolean): string {
  const missing = report.rows.filter(row => row.detail.startsWith('not deployed')).length;
  return `verify:chain ${report.ok ? 'passed' : 'failed'}${report.block !== undefined ? ` at block ${report.block}` : ''}` +
    (prelaunch ? ' (prelaunch; deployment verification incomplete)' : '') +
    (missing ? `; ${missing} manifest entries not deployed` : '');
}
export async function runVerifyCommand(registry: AddressRegistry, client: VerifyClient, options: {
  prelaunch: boolean; buildRecords: BuildRecords; signal?: AbortSignal; timeoutMs?: number;
  output: (report: VerificationReport, summary: string) => void;
}): Promise<number> {
  const report = await verifyChain(registry, client, options);
  options.output(report, verificationSummary(report, options.prelaunch));
  return report.ok && report.complete && !options.signal?.aborted ? 0 : 1;
}
