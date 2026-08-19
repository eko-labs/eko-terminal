import { loadRegistry } from './registry.js';
import { loadBuildRecords } from './build-records.js';
import { runVerifyCommand, verificationMode } from './verify-command.js';
import { createMeteredClients } from './rpc/clients.js';
import { safeError } from './rpc/safe-error.js';
import { CHAIN_ID } from '@eko/shared';

const controller = new AbortController();
let meter: ReturnType<typeof createMeteredClients>['meter'] | undefined;
const stop = () => { controller.abort(); meter?.stop(); process.exitCode = 1; };
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
  const prelaunch = verificationMode(process.argv.slice(2));
  if (process.env.CHAIN_ID && process.env.CHAIN_ID !== String(CHAIN_ID)) throw new Error(`CHAIN_ID must be ${CHAIN_ID}`);
  const registry = loadRegistry();
  const buildRecords = loadBuildRecords(registry);
  const clients = createMeteredClients(process.env, {
    standalone: true, onSessionBudget: stop,
    alert: (reason, fields) => {
      console.log(JSON.stringify({ event: 'alert', reason, ...fields }));
      if (reason === 'rpc_budget_exhausted') stop();
    },
  });
  meter = clients.meter;
  process.exitCode = await runVerifyCommand(registry, clients.public, {
    prelaunch, buildRecords, signal: controller.signal,
    output: (report, summary) => {
      console.table(report.rows.map(row => ({ entry: row.entry, check: row.check, result: row.detail.startsWith('not deployed') ? 'NOT DEPLOYED' : row.ok ? 'PASS' : 'FAIL', detail: row.detail })));
      console.log(summary);
    },
  });
} catch (error) {
  console.error(safeError(error)); process.exitCode = 1;
} finally {
  try { await meter?.close(); }
  catch (error) { console.error(safeError(error)); process.exitCode = 1; }
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
  if (controller.signal.aborted) process.exitCode = 1;
}
