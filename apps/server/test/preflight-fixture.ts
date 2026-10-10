// Offline PGlite/encryption fixtures only; never measured route/release evidence.
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, migrateEngines, FileJournalDestructionLedger } from '@eko/db';
import { openDb, runMigrations } from '../src/db/client.js';
import { accounts } from '../src/db/schema.js';
import { HarnessService } from '../src/harness/service.js';
import { JournalService } from '../src/harness/journal.js';
import { PreflightService, type CachedPreflightInputs, type PreflightApprovals, type PreflightInputs } from '../src/harness/preflight.js';
import { NOW, policy } from '../../../packages/policy/test/fixtures.js';
import { agent as actualAgent, bindRequest, deps as actualDeps, request } from '../../../packages/policy/test/actual-fixtures.js';
import type { Policy } from '@eko/shared';

export async function preflightFixture() {
  const handle = await openDb({ pgliteDir: ':memory:' });
  const dir = await mkdtemp(join(tmpdir(), 'eko-095-fixture-')), path = join(dir, 'destruction.log');
  await writeFile(path, 'eko-journal-destruction-v1\n', { mode: 0o600 });
  await runMigrations(handle); await migrate(handle.chain); await migrateEngines(handle.chain);
  const pepper = randomBytes(32).toString('hex'), kek = randomBytes(32), keyId = 'fixture-kek';
  const ledger = new FileJournalDestructionLedger(path);
  const harness = new HarnessService(handle.db, pepper);
  const journal = new JournalService(handle.chain, ledger, { kek, id: keyId });
  async function owner(mode: Policy['mode'] = 'balanced', optedIn = true) {
    const [account] = await handle.db.insert(accounts).values({ kind: 'wallet' }).returning();
    const agent = await harness.create(account!.id, { name: 'Sample preflight agent', kind: 'onchain', wallet: actualAgent.wallet, preset: mode }, 10);
    await handle.chain.sql.query('UPDATE policies SET policy=$2 WHERE agent_id=$1',
      [agent.id, JSON.stringify({ ...policy, mode, guardPolicyVersion: 2 })]);
    if (optedIn) await journal.setConsent(account!.id, true);
    const key = await harness.createKey(account!.id, agent.id);
    return { accountId: account!.id, agentId: agent.id, agent, key };
  }
  async function req(agentId: string, ref = 'fixture-order-001') {
    const p = await harness.policy((await handle.chain.sql.query<{account_id:string}>('SELECT account_id FROM agents WHERE id=$1', [agentId])).rows[0]!.account_id, agentId);
    return bindRequest({ ...request, agentId, clientOrderRef: ref }, p);
  }
  // Synchronous fixture evidence; the stored transaction argument is unused.
  const cached = (..._args: Partial<Parameters<CachedPreflightInputs>>): PreflightInputs => actualDeps;
  const service = (inputs: CachedPreflightInputs = cached, approvals?: PreflightApprovals) => new PreflightService(handle.chain, journal, inputs, approvals, () => NOW);
  return { handle, harness, journal, ledger, owner, req, cached, service, path, pepper, kek, keyId,
    async close() { await handle.close(); kek.fill(0); await rm(dir, { recursive: true, force: true }); } };
}
