import { createMeteredClients } from '../rpc/clients.js';
import { safeError } from '../rpc/safe-error.js';
import { elysium, ELYSIUM_PUBLIC_RPC } from './chain.js';
import { loadElysiumRegistry } from './registry.js';
import { verifyElysium } from './verify.js';

/** `pnpm --filter @eko/chain verify:elysium`: check addresses.99901.yaml against the live chain. Uses RPC_HTTP_URL if set, else the public RPC. */
const controller = new AbortController();
let meter: ReturnType<typeof createMeteredClients>['meter'] | undefined;
const stop = () => { controller.abort(); meter?.stop(); process.exitCode = 1; };
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
  const registry = loadElysiumRegistry();
  const clients = createMeteredClients({ ...process.env, RPC_PUBLIC_HTTP_URL: process.env.RPC_PUBLIC_HTTP_URL ?? ELYSIUM_PUBLIC_RPC }, {
    standalone: true, chain: elysium, onSessionBudget: stop,
    alert: (reason, fields) => { console.log(JSON.stringify({ event: 'alert', reason, ...fields })); if (reason === 'rpc_budget_exhausted') stop(); },
  });
  meter = clients.meter;
  const report = await verifyElysium(registry, clients.public, { signal: controller.signal });
  console.table(report.rows.map(r => ({ entry: r.entry, check: r.check, result: r.ok ? 'PASS' : 'FAIL', detail: r.detail })));
  const failed = report.rows.filter(r => !r.ok).length;
  console.log(report.ok ? `verify:elysium passed (${report.rows.length} checks)` : `verify:elysium FAILED (${failed} of ${report.rows.length} checks)`);
  process.exitCode = report.ok ? 0 : 1;
} catch (error) {
  console.error(safeError(error)); process.exitCode = 1;
} finally {
  try { await meter?.close(); } catch (error) { console.error(safeError(error)); process.exitCode = 1; }
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
  if (controller.signal.aborted) process.exitCode = 1;
}
