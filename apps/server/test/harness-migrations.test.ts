import { randomUUID } from 'node:crypto';
import { seedSanctions, listedWallet } from './sanctions-fixture.js';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, openDb, runMigrations } from '../src/db/client.js';
import { accounts, agents, agentKeys, policies, tradingAllowlist, journalConsent, mcpRateLimits, ofacSdn, oauthClients, oauthRequests, oauthRegistrationLimits, bagShares } from '../src/db/schema.js';

const journalPath = join(MIGRATIONS_DIR, 'meta/_journal.json');
const readJournal = async () => JSON.parse(await readFile(journalPath, 'utf8')) as {
  entries: { idx: number; tag: string; when: number }[];
};

async function exerciseHarness(db: Awaited<ReturnType<typeof openDb>>['db']) {
  const [account] = await db.insert(accounts).values({ kind: 'wallet' }).returning();
  const [agent] = await db.insert(agents).values({ accountId: account!.id, name: 'Sample agent', kind: 'other' }).returning();
  await db.insert(policies).values({ agentId: agent!.id, version: 1,
    policy: { mode: 'balanced', killed: false, version: 1, blockPlaybookLevel: null } });
  await db.insert(agentKeys).values({ agentId: agent!.id, prefix: 'migration-fixture', hash: '0'.repeat(64) });
  expect(await db.select().from(agents)).toHaveLength(1);
  expect(await db.select().from(policies)).toHaveLength(1);
  expect(await db.select().from(agentKeys)).toHaveLength(1);
}

describe('private journal 0005, MCP 0006, sanctions 0007 monitoring 0010, OAuth 0017 points 0023 bags 0024 watches 0025 Telegram 0026 trades 0027 preflight 0029 consent 0030 reconciliation 0031 Telegram DMs 0033 security collectors 0034 Census evidence 0035 Swarm inference 0037 X 0040, Farcaster 0041 OAuth tokens 0043 and Scoreboard 0044 migration chain (offline PGlite)', () => {
  it('migrates a fresh database and preserves both feature schemas on rerun', async () => {
    const handle = await openDb({ pgliteDir: ':memory:' });
    try {
      await runMigrations(handle);
      await exerciseHarness(handle.db);
      expect(await handle.db.select().from(tradingAllowlist)).toEqual([]);
      await runMigrations(handle);
      expect(await handle.db.select().from(agents)).toHaveLength(1);
      const journal = await readJournal();
      expect(journal.entries.map(entry => entry.idx)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25]);
      for (let i = 1; i < journal.entries.length; i++) expect(journal.entries[i]!.when).toBeGreaterThan(journal.entries[i - 1]!.when);
      expect(journal.entries.map(entry => entry.tag)).toEqual(['0000_init', '0001_feature_flags', '0002_v1_account', '0003_trade_access', '0004_harness', '0005_private_journal', '0006_mcp_rate_limits', '0007_ofac', '0010_launch_monitoring', '0017_oauth_discovery', '0023_points_ledger', '0024_bags', '0025_watch_alerts', '0026_telegram_groups', '0027_trade_api', '0029_mcp_preflights', '0030_oauth_consent', '0031_trade_reconcile', '0033_telegram_dms', '0034_security_collectors', '0035_census_evidence', '0037_swarm_inference', '0040_x_bot_dark', '0041_farcaster_summons', '0043_oauth_tokens', '0044_scoreboard']);
      expect(journal.entries[15]!.when).toBe(journal.entries[14]!.when + 1);
      expect(journal.entries[16]!.when).toBe(journal.entries[15]!.when + 1);
      expect(journal.entries[17]!.when).toBe(journal.entries[16]!.when + 1);
      expect(journal.entries[18]!.when).toBe(journal.entries[17]!.when + 1);
      expect(journal.entries[19]!.when).toBe(journal.entries[18]!.when + 1);
      expect(journal.entries[20]!.when).toBe(journal.entries[19]!.when + 1);
      expect(journal.entries[21]!.when).toBe(journal.entries[20]!.when + 1);
      expect(journal.entries[22]!.when).toBe(journal.entries[21]!.when + 1);
      expect(journal.entries[23]!.when).toBe(journal.entries[22]!.when + 1);
      expect(journal.entries[24]!.when).toBe(journal.entries[23]!.when + 1);
      expect(journal.entries[25]!.when).toBe(journal.entries[24]!.when + 1);
      const previous = JSON.parse(await readFile(join(MIGRATIONS_DIR, 'meta/0003_snapshot.json'), 'utf8'));
      const next = JSON.parse(await readFile(join(MIGRATIONS_DIR, 'meta/0004_snapshot.json'), 'utf8'));
      expect(next.prevId).toBe(previous.id);
      expect(next.tables['public.trading_allowlist']).toEqual(previous.tables['public.trading_allowlist']);
      for (const table of ['agents', 'agent_keys', 'policies']) expect(next.tables[`public.${table}`]).toBeDefined();
      const privateJournal = JSON.parse(await readFile(join(MIGRATIONS_DIR, 'meta/0005_snapshot.json'), 'utf8'));
      const mcp = JSON.parse(await readFile(join(MIGRATIONS_DIR, 'meta/0006_snapshot.json'), 'utf8'));
      expect(privateJournal.prevId).toBe(next.id);
      expect(mcp.prevId).toBe(privateJournal.id);
      for (const [name, table] of Object.entries(privateJournal.tables)) expect(mcp.tables[name]).toEqual(table);
      expect(Object.keys(mcp.tables).filter(name => !(name in privateJournal.tables))).toEqual(['public.mcp_rate_limits']);
      const sanctions = JSON.parse(await readFile(join(MIGRATIONS_DIR, 'meta/0007_snapshot.json'), 'utf8'));
      expect(sanctions.prevId).toBe(mcp.id);
      for (const [name, table] of Object.entries(mcp.tables)) expect(sanctions.tables[name]).toEqual(table);
      expect(Object.keys(sanctions.tables).filter(name => !(name in mcp.tables)).sort()).toEqual(['public.ofac_refresh', 'public.ofac_sdn']);
      const monitoring = JSON.parse(await readFile(join(MIGRATIONS_DIR, 'meta/0010_snapshot.json'), 'utf8'));
      expect(monitoring.prevId).toBe(sanctions.id);
      for (const [name, table] of Object.entries(sanctions.tables)) expect(monitoring.tables[name]).toEqual(table);
      expect(Object.keys(monitoring.tables).filter(name => !(name in sanctions.tables))).toEqual(['public.launch_measurements']);
      const oauth = JSON.parse(await readFile(join(MIGRATIONS_DIR, 'meta/0017_snapshot.json'), 'utf8'));
      expect(oauth.prevId).toBe(monitoring.id);
      for (const [name, table] of Object.entries(monitoring.tables)) expect(oauth.tables[name]).toEqual(table);
      expect(Object.keys(oauth.tables).filter(name => !(name in monitoring.tables)).sort())
        .toEqual(['public.oauth_clients', 'public.oauth_registration_limits', 'public.oauth_requests']);
      const points = JSON.parse(await readFile(join(MIGRATIONS_DIR, 'meta/0023_snapshot.json'), 'utf8'));
      expect(points.prevId).toBe(oauth.id);
      for (const [name, table] of Object.entries(oauth.tables)) {
        if (name === 'public.referrals') expect(points.tables[name]).toEqual({
          ...(table as object), checkConstraints: { referrals_no_self: {
            name: 'referrals_no_self', value: '"referrals"."referrer_account_id" <> "referrals"."referred_account_id"',
          } },
        });
        else expect(points.tables[name]).toEqual(table);
      }
      expect(Object.keys(points.tables).filter(name => !(name in oauth.tables)).sort())
        .toEqual(['public.points_ledger', 'public.points_scan_creators']);
      const bags = JSON.parse(await readFile(join(MIGRATIONS_DIR, 'meta/0024_snapshot.json'), 'utf8'));
      expect(bags.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(bags.id).not.toBe(points.id);
      for (const key of ['enums', 'schemas', 'sequences', 'roles', 'policies', 'views', '_meta']) expect(bags[key]).toEqual(points[key]);
      expect(bags.prevId).toBe(points.id);
      for (const [name, table] of Object.entries(points.tables)) expect(bags.tables[name]).toEqual(table);
      expect(Object.keys(bags.tables).filter(name => !(name in points.tables))).toEqual(['public.bag_shares']);
      const snapshot = { asOfBlock: 1, holdings: [], summary: { coins: 0, flagged: 0, danger: 0 } };
      const [shared] = await handle.db.insert(bagShares).values({ snapshot }).returning();
      await runMigrations(handle);
      expect(await handle.db.select().from(bagShares)).toEqual([shared]);
      const watchSnapshot = JSON.parse(await readFile(join(MIGRATIONS_DIR, 'meta/0025_snapshot.json'), 'utf8'));
      expect(watchSnapshot.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(watchSnapshot.id).not.toBe(bags.id);
      for (const key of ['enums', 'schemas', 'sequences', 'roles', 'policies', 'views', '_meta']) expect(watchSnapshot[key]).toEqual(bags[key]);
      expect(watchSnapshot.prevId).toBe(bags.id);
      for (const [name, table] of Object.entries(bags.tables)) expect(watchSnapshot.tables[name]).toEqual(table);
      expect(Object.keys(watchSnapshot.tables).filter(name => !(name in bags.tables)).sort())
        .toEqual(['public.alert_consumer_cursors', 'public.alert_deliveries', 'public.alert_settings', 'public.alert_sources', 'public.watches']);
      for (const table of ['watches', 'alert_settings', 'alert_sources', 'alert_deliveries', 'alert_consumer_cursors']) {
        expect((await handle.chain.sql.query(`SELECT to_regclass('public.${table}') AS table_name`)).rows[0]!.table_name).toBe(table);
      }
      const telegram = JSON.parse(await readFile(join(MIGRATIONS_DIR, 'meta/0026_snapshot.json'), 'utf8'));
      expect(telegram.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(telegram.id).not.toBe(watchSnapshot.id);
      for (const key of ['enums', 'schemas', 'sequences', 'roles', 'policies', 'views', '_meta']) expect(telegram[key]).toEqual(watchSnapshot[key]);
      expect(telegram.prevId).toBe(watchSnapshot.id);
      for (const [name, table] of Object.entries(watchSnapshot.tables)) expect(telegram.tables[name]).toEqual(table);
      expect(Object.keys(telegram.tables).filter(name => !(name in watchSnapshot.tables)).sort())
        .toEqual(['public.bot_interactions', 'public.caller_calls', 'public.caller_grades']);
      for (const table of ['bot_interactions', 'caller_calls', 'caller_grades']) {
        expect((await handle.chain.sql.query(`SELECT to_regclass('public.${table}') AS table_name`)).rows[0]!.table_name).toBe(table);
      }
      const trades = JSON.parse(await readFile(join(MIGRATIONS_DIR, 'meta/0027_snapshot.json'), 'utf8'));
      expect(trades.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(trades.id).not.toBe(telegram.id);
      for (const key of ['enums', 'schemas', 'sequences', 'roles', 'policies', 'views', '_meta']) expect(trades[key]).toEqual(telegram[key]);
      expect(trades.prevId).toBe(telegram.id);
      for (const [name, table] of Object.entries(telegram.tables)) expect(trades.tables[name]).toEqual(table);
      expect(Object.keys(trades.tables).filter(name => !(name in telegram.tables)).sort()).toEqual(['public.trade_orders', 'public.trade_quotes']);
      for (const table of ['trade_orders', 'trade_quotes']) {
        expect((await handle.chain.sql.query(`SELECT to_regclass('public.${table}') AS table_name`)).rows[0]!.table_name).toBe(table);
      }
      const preflight = JSON.parse(await readFile(join(MIGRATIONS_DIR, 'meta/0029_snapshot.json'), 'utf8'));
      expect(preflight.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(preflight.id).not.toBe(trades.id);
      for (const key of ['enums', 'schemas', 'sequences', 'roles', 'policies', 'views', '_meta']) expect(preflight[key]).toEqual(trades[key]);
      expect(preflight.prevId).toBe(trades.id);
      for (const [name, table] of Object.entries(trades.tables)) expect(preflight.tables[name]).toEqual(table);
      expect(Object.keys(preflight.tables).filter(name => !(name in trades.tables))).toEqual(['public.preflights']);
      expect((await handle.chain.sql.query('SELECT * FROM preflights')).rows).toEqual([]);
      const consent = JSON.parse(await readFile(join(MIGRATIONS_DIR, 'meta/0030_snapshot.json'), 'utf8'));
      expect(consent.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(consent.id).not.toBe(preflight.id);
      for (const key of ['enums', 'schemas', 'sequences', 'roles', 'policies', 'views', '_meta']) expect(consent[key]).toEqual(preflight[key]);
      expect(consent.prevId).toBe(preflight.id);
      for (const [name, table] of Object.entries(preflight.tables)) {
        if (!['public.sessions', 'public.oauth_requests', 'public.agent_keys'].includes(name)) expect(consent.tables[name]).toEqual(table);
      }
      expect(Object.keys(consent.tables).filter(name => !(name in preflight.tables)).sort()).toEqual(['public.oauth_codes', 'public.oauth_grants']);
      expect(consent.tables['public.sessions'].columns.authenticated_at).toBeDefined();
      expect(consent.tables['public.oauth_requests'].columns.account_id).toBeDefined();
      expect(consent.tables['public.oauth_codes'].columns.account_id).toBeDefined();
      expect(consent.tables['public.agent_keys'].foreignKeys.agent_keys_oauth_grant_id_oauth_grants_id_fk.onDelete).toBe('cascade');

      const reconcile = JSON.parse(await readFile(join(MIGRATIONS_DIR, 'meta/0031_snapshot.json'), 'utf8'));
      expect(reconcile.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(reconcile.id).not.toBe(consent.id);
      expect(reconcile.prevId).toBe(consent.id);
      for (const key of ['enums', 'schemas', 'sequences', 'roles', 'policies', 'views', '_meta']) expect(reconcile[key]).toEqual(consent[key]);
      for (const [name, table] of Object.entries(consent.tables)) {
        if (name !== 'public.trade_orders') expect(reconcile.tables[name]).toEqual(table);
      }
      expect(Object.keys(reconcile.tables).filter(name => !(name in consent.tables))).toEqual(['public.trade_guard_misses']);
      const priorOrders = consent.tables['public.trade_orders'];
      const reconciledOrders = reconcile.tables['public.trade_orders'];
      expect(reconciledOrders).toEqual({
        ...priorOrders,
        columns: { ...priorOrders.columns,
          tx_hash: { name: 'tx_hash', type: 'text', primaryKey: false, notNull: false },
          filled_in: { name: 'filled_in', type: 'text', primaryKey: false, notNull: false },
          filled_out: { name: 'filled_out', type: 'text', primaryKey: false, notNull: false },
          error_code: { name: 'error_code', type: 'text', primaryKey: false, notNull: false },
          submitted_at: { name: 'submitted_at', type: 'timestamp with time zone', primaryKey: false, notNull: false },
          settled_at: { name: 'settled_at', type: 'timestamp with time zone', primaryKey: false, notNull: false },
          post_fill_evidence: { name: 'post_fill_evidence', type: 'jsonb', primaryKey: false, notNull: false },
        },
        indexes: { ...priorOrders.indexes, trade_orders_tx_hash: {
          name: 'trade_orders_tx_hash', columns: [{ expression: 'tx_hash', isExpression: false, asc: true, nulls: 'last' }],
          isUnique: true, concurrently: false, method: 'btree', with: {},
        } },
      });
      expect(reconciledOrders.columns.filled_in.type).toBe('text');
      expect((await handle.chain.sql.query('SELECT * FROM trade_guard_misses')).rows).toEqual([]);

      const dms = JSON.parse(await readFile(join(MIGRATIONS_DIR, 'meta/0033_snapshot.json'), 'utf8'));
      expect(dms.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(dms.prevId).toBe(reconcile.id);
      expect(dms.id).not.toBe(reconcile.id);
      for (const [name, table] of Object.entries(reconcile.tables)) expect(dms.tables[name]).toEqual(table);
      for (const key of ['enums', 'schemas', 'sequences', 'roles', 'policies', 'views', '_meta']) expect(dms[key]).toEqual(reconcile[key]);
      expect(Object.keys(dms.tables).filter(name => !(name in reconcile.tables)).sort())
        .toEqual(['public.linked_identities', 'public.telegram_link_codes']);
      for (const table of ['linked_identities', 'telegram_link_codes']) {
        expect((await handle.chain.sql.query(`SELECT to_regclass('public.${table}') AS table_name`)).rows[0]!.table_name).toBe(table);
      }
      const security = JSON.parse(await readFile(join(MIGRATIONS_DIR, 'meta/0034_snapshot.json'), 'utf8'));
      expect(security.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(security.prevId).toBe(dms.id);
      expect(security.id).not.toBe(dms.id);
      for (const [name, table] of Object.entries(dms.tables)) expect(security.tables[name]).toEqual(table);
      for (const key of ['enums', 'schemas', 'sequences', 'roles', 'policies', 'views', '_meta']) expect(security[key]).toEqual(dms[key]);
      expect(Object.keys(security.tables).filter(name => !(name in dms.tables)).sort())
        .toEqual(['public.security_collector_checkpoints', 'public.security_collector_events']);
      for (const table of ['security_collector_checkpoints', 'security_collector_events']) {
        expect((await handle.chain.sql.query(`SELECT to_regclass('public.${table}') AS table_name`)).rows[0]!.table_name).toBe(table);
      }
      const census = JSON.parse(await readFile(join(MIGRATIONS_DIR, 'meta/0035_snapshot.json'), 'utf8'));
      expect(census.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(census.id).not.toBe(security.id);
      expect(census.prevId).toBe(security.id);
      for (const [name, table] of Object.entries(security.tables)) expect(census.tables[name]).toEqual(table);
      for (const key of ['version', 'dialect', 'enums', 'schemas', 'sequences', 'roles', 'policies', 'views', '_meta']) expect(census[key]).toEqual(security[key]);
      expect(Object.keys(census.tables).filter(name => !(name in security.tables))).toEqual(['public.eval_gates']);
      expect(census.tables['public.eval_gates']).toEqual({
        name: 'eval_gates', schema: '',
        columns: {
          id: { name: 'id', type: 'text', primaryKey: true, notNull: true },
          metric: { name: 'metric', type: 'text', primaryKey: false, notNull: true },
          model_version: { name: 'model_version', type: 'text', primaryKey: false, notNull: true },
          value: { name: 'value', type: 'double precision', primaryKey: false, notNull: true },
          wilson_lower: { name: 'wilson_lower', type: 'double precision', primaryKey: false, notNull: true },
          recall: { name: 'recall', type: 'double precision', primaryKey: false, notNull: true },
          evaluated_at: { name: 'evaluated_at', type: 'timestamp with time zone', primaryKey: false, notNull: true },
          expires_at: { name: 'expires_at', type: 'timestamp with time zone', primaryKey: false, notNull: false },
          model_hash: { name: 'model_hash', type: 'text', primaryKey: false, notNull: false },
          dataset_hash: { name: 'dataset_hash', type: 'text', primaryKey: false, notNull: false },
          evidence: { name: 'evidence', type: 'jsonb', primaryKey: false, notNull: false },
        },
        indexes: { eval_gates_model_latest: {
          name: 'eval_gates_model_latest', columns: [
            { expression: 'model_version', isExpression: false, asc: true, nulls: 'last' },
            { expression: 'evaluated_at', isExpression: false, asc: false, nulls: 'first' },
            { expression: 'id', isExpression: false, asc: false, nulls: 'first' },
          ], isUnique: false, concurrently: false, method: 'btree', with: {},
        } },
        foreignKeys: {}, compositePrimaryKeys: {}, uniqueConstraints: {}, policies: {}, isRLSEnabled: false,
        checkConstraints: {
          eval_gates_metric_check: { name: 'eval_gates_metric_check', value: "metric = 'likely_agent_precision'::text" },
          eval_gates_value_check: { name: 'eval_gates_value_check', value: 'value BETWEEN 0 AND 1' },
          eval_gates_wilson_lower_check: { name: 'eval_gates_wilson_lower_check', value: 'wilson_lower BETWEEN 0 AND 1' },
          eval_gates_recall_check: { name: 'eval_gates_recall_check', value: 'recall BETWEEN 0 AND 1' },
          eval_gates_model_hash_check: { name: 'eval_gates_model_hash_check', value: "model_hash ~ '^[a-f0-9]{64}$'::text" },
          eval_gates_dataset_hash_check: { name: 'eval_gates_dataset_hash_check', value: "dataset_hash ~ '^[a-f0-9]{64}$'::text" },
        },
      });
      const censusColumns = (await handle.chain.sql.query(
        "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='eval_gates' ORDER BY ordinal_position",
      )).rows;
      expect(censusColumns).toEqual(Object.values(census.tables['public.eval_gates'].columns).map(column => {
        const c = column as { name: string; type: string; notNull: boolean };
        return { column_name: c.name, data_type: c.type, is_nullable: c.notNull ? 'NO' : 'YES' };
      }));
      expect((await handle.chain.sql.query("SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname='eval_gates_model_latest'")).rows)
        .toEqual([{ indexdef: 'CREATE INDEX eval_gates_model_latest ON public.eval_gates USING btree (model_version, evaluated_at DESC, id DESC)' }]);
      expect((await handle.chain.sql.query('SELECT * FROM eval_gates')).rows).toEqual([]);
      const swarm = JSON.parse(await readFile(join(MIGRATIONS_DIR, 'meta/0037_snapshot.json'), 'utf8'));
      expect(swarm.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(swarm.id).not.toBe(census.id);
      for (const key of ['version', 'dialect', 'enums', 'schemas', 'sequences', 'roles', 'policies', 'views', '_meta']) expect(swarm[key]).toEqual(census[key]);
      expect(Object.keys(swarm.tables)).toEqual(Object.keys(census.tables));
      expect(swarm.prevId).toBe(census.id);
      for (const [name, table] of Object.entries(census.tables)) {
        if (name !== 'public.inference_runs') expect(swarm.tables[name]).toEqual(table);
      }
      const oldRuns = census.tables['public.inference_runs'], runs = swarm.tables['public.inference_runs'];
      for (const [name, column] of Object.entries(oldRuns.columns)) expect(runs.columns[name]).toEqual(column);
      expect(Object.keys(runs.columns).filter(name => !(name in oldRuns.columns)).sort())
        .toEqual(['coin','persona_set_version','purpose','reservation_id']);
      for (const [name, index] of Object.entries(oldRuns.indexes)) expect(runs.indexes[name]).toEqual(index);
      expect(Object.keys(runs.indexes).filter(name => !(name in oldRuns.indexes)).sort())
        .toEqual(['inference_runs_reservation','inference_runs_swarm']);
      expect((await handle.chain.sql.query("SELECT column_name FROM information_schema.columns WHERE table_name='inference_runs' AND column_name IN ('coin','persona_set_version','purpose','reservation_id')")).rows).toHaveLength(4);
      expect((await handle.chain.sql.query("SELECT tgname FROM pg_trigger WHERE tgname='swarm_inference_immutable'")).rows).toHaveLength(1);
      const xBot = JSON.parse(await readFile(join(MIGRATIONS_DIR, 'meta/0040_snapshot.json'), 'utf8'));
      expect(xBot.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(xBot.id).not.toBe(swarm.id);
      for (const key of ['version', 'dialect', 'enums', 'schemas', 'sequences', 'roles', 'policies', 'views', '_meta']) expect(xBot[key]).toEqual(swarm[key]);
      expect(xBot.prevId).toBe(swarm.id);
      for (const [name, table] of Object.entries(swarm.tables)) expect(xBot.tables[name]).toEqual(table);
      expect(Object.keys(xBot.tables).filter(name => !(name in swarm.tables)).sort())
        .toEqual(['public.burn_posts', 'public.x_bot_state', 'public.x_bot_usage', 'public.x_summons']);
      for (const table of ['x_bot_state', 'x_bot_usage', 'x_summons', 'burn_posts']) {
        expect((await handle.chain.sql.query(`SELECT to_regclass('public.${table}') AS table_name`)).rows[0]!.table_name).toBe(table);
      }
      const farcaster = JSON.parse(await readFile(join(MIGRATIONS_DIR, 'meta/0041_snapshot.json'), 'utf8'));
      expect(farcaster.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(farcaster.prevId).toBe(xBot.id);
      expect(farcaster.id).not.toBe(xBot.id);
      for (const key of ['version', 'dialect', 'enums', 'schemas', 'sequences', 'roles', 'policies', 'views', '_meta']) expect(farcaster[key]).toEqual(xBot[key]);
      for (const [name, table] of Object.entries(xBot.tables)) expect(farcaster.tables[name]).toEqual(table);
      expect(Object.keys(farcaster.tables).filter(name => !(name in xBot.tables)).sort())
        .toEqual(['public.farcaster_interactions', 'public.farcaster_summon_locks']);
      for (const table of ['farcaster_interactions', 'farcaster_summon_locks']) {
        expect((await handle.chain.sql.query(`SELECT to_regclass('public.${table}') AS table_name`)).rows[0]!.table_name).toBe(table);
      }
      const tokens = JSON.parse(await readFile(join(MIGRATIONS_DIR, 'meta/0043_snapshot.json'), 'utf8'));
      expect(tokens.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(tokens.id).not.toBe(farcaster.id);
      for (const key of ['version', 'dialect', 'enums', 'schemas', 'sequences', 'roles', 'policies', 'views', '_meta']) expect(tokens[key]).toEqual(farcaster[key]);
      expect(tokens.prevId).toBe(farcaster.id);
      for (const [name, table] of Object.entries(farcaster.tables)) expect(tokens.tables[name]).toEqual(table);
      expect(Object.keys(tokens.tables).filter(name => !(name in farcaster.tables))).toEqual(['public.oauth_tokens']);
      expect((await handle.chain.sql.query('SELECT * FROM oauth_tokens')).rows).toEqual([]);
      const scoreboard = JSON.parse(await readFile(join(MIGRATIONS_DIR,'meta/0044_snapshot.json'),'utf8'));
      expect(scoreboard.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(scoreboard.id).not.toBe(tokens.id);
      for (const key of ['version', 'dialect', 'enums', 'schemas', 'sequences', 'roles', 'policies', 'views', '_meta']) expect(scoreboard[key]).toEqual(tokens[key]);
      expect(scoreboard.prevId).toBe(tokens.id);
      for(const [name,table] of Object.entries(tokens.tables))expect(scoreboard.tables[name]).toEqual(table);
      expect(Object.keys(scoreboard.tables).filter(name=>!(name in tokens.tables))).toEqual(['public.scoreboard_records']);
      expect(scoreboard.tables['public.scoreboard_records'].columns.seq.type).toBe('bigserial');
      expect((await handle.chain.sql.query('SELECT * FROM scoreboard_records')).rows).toEqual([]);
      expect((await handle.chain.sql.query('SELECT * FROM launch_measurements')).rows).toEqual([]);
      expect(await handle.db.select().from(journalConsent)).toEqual([]);
      await seedSanctions(handle.chain);
      const dataset = await handle.db.select().from(ofacSdn);
      expect(dataset[0]!.addresses).toContain(listedWallet);
      await handle.db.insert(mcpRateLimits).values({ subjectHash: 'a'.repeat(64), windowStart: new Date(), hits: 1 });
      await runMigrations(handle);
      expect(await handle.db.select().from(mcpRateLimits)).toHaveLength(1);
      expect(await handle.db.select().from(ofacSdn)).toEqual(dataset);
    } finally { await handle.close(); }
  });

  it('upgrades a database already on main 0003 without losing its allowlist data', async () => {
    const staging = await mkdtemp(join(tmpdir(), 'eko-091b-main-migrations-'));
    const handle = await openDb({ pgliteDir: ':memory:' });
    try {
      await cp(join(MIGRATIONS_DIR, 'meta'), join(staging, 'meta'), { recursive: true });
      const journal = await readJournal();
      await writeFile(join(staging, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: journal.entries.slice(0, 4) }));
      for (const entry of journal.entries.slice(0, 4)) await cp(join(MIGRATIONS_DIR, `${entry.tag}.sql`), join(staging, `${entry.tag}.sql`));
      await migrate(handle.db as never, { migrationsFolder: staging });
      const [account] = await handle.db.insert(accounts).values({ kind: 'wallet' }).returning();
      const wallet = `0x${'a'.repeat(40)}`;
      await handle.db.insert(tradingAllowlist).values({ wallet, role: 'beta_user', capUsd: 100, addedBy: account!.id });
      const before = await handle.db.select().from(tradingAllowlist);
      await runMigrations(handle);
      expect(await handle.db.select().from(tradingAllowlist)).toEqual(before);
      await exerciseHarness(handle.db);
      await runMigrations(handle);
      expect(await handle.db.select().from(tradingAllowlist)).toEqual(before);
      expect(await handle.db.select().from(agents)).toHaveLength(1);
    } finally { await handle.close(); await rm(staging, { recursive: true, force: true }); }
  });

  it('upgrades all main migrations through private journal 0005 without losing existing data', async () => {
    const staging = await mkdtemp(join(tmpdir(), 'eko-093b-main-migrations-'));
    const handle = await openDb({ pgliteDir: ':memory:' });
    try {
      await cp(join(MIGRATIONS_DIR, 'meta'), join(staging, 'meta'), { recursive: true });
      const journal = await readJournal();
      await writeFile(join(staging, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: journal.entries.slice(0, 6) }));
      for (const entry of journal.entries.slice(0, 6)) await cp(join(MIGRATIONS_DIR, `${entry.tag}.sql`), join(staging, `${entry.tag}.sql`));
      await migrate(handle.db as never, { migrationsFolder: staging });
      await exerciseHarness(handle.db);
      const [account] = await handle.db.select().from(accounts);
      await handle.db.insert(journalConsent).values({ accountId: account!.id, optedIn: true });
      const before = await handle.db.select().from(journalConsent);
      expect((await handle.chain.sql.query("SELECT to_regclass('public.mcp_rate_limits') AS table_name")).rows[0]!.table_name).toBeNull();
      const mainLedger = (await handle.chain.sql.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY created_at')).rows;
      expect(mainLedger).toHaveLength(6);
      await runMigrations(handle);
      expect(await handle.db.select().from(journalConsent)).toEqual(before);
      expect(await handle.db.select().from(agents)).toHaveLength(1);
      expect(await handle.db.select().from(agentKeys)).toHaveLength(1);
      const mergedLedger = (await handle.chain.sql.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY created_at')).rows;
      expect(mergedLedger.slice(0, 6)).toEqual(mainLedger);
      expect(mergedLedger).toHaveLength(26);
      await handle.db.insert(mcpRateLimits).values({ subjectHash: 'b'.repeat(64), windowStart: new Date(), hits: 2 });
      await runMigrations(handle);
      expect(await handle.db.select().from(journalConsent)).toEqual(before);
      expect((await handle.db.select().from(mcpRateLimits))[0]!.hits).toBe(2);
    } finally { await handle.close(); await rm(staging, { recursive: true, force: true }); }
  });

  it('upgrades main through MCP 0006 without changing its journal, allowlist, counters or migration ledger', async () => {
    const staging = await mkdtemp(join(tmpdir(), 'eko-074b-main-migrations-'));
    const handle = await openDb({ pgliteDir: ':memory:' });
    try {
      await cp(join(MIGRATIONS_DIR, 'meta'), join(staging, 'meta'), { recursive: true });
      const journal = await readJournal();
      const mainEntries = journal.entries.slice(0, 7);
      await writeFile(join(staging, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: mainEntries }));
      for (const entry of mainEntries) await cp(join(MIGRATIONS_DIR, `${entry.tag}.sql`), join(staging, `${entry.tag}.sql`));
      await migrate(handle.db as never, { migrationsFolder: staging });
      await exerciseHarness(handle.db);
      const [account] = await handle.db.select().from(accounts);
      await handle.db.insert(journalConsent).values({ accountId: account!.id, optedIn: true });
      await handle.db.insert(tradingAllowlist).values({ wallet: listedWallet, role: 'team', capUsd: 25, addedBy: account!.id });
      await handle.db.insert(mcpRateLimits).values({ subjectHash: 'c'.repeat(64), windowStart: new Date(), hits: 3 });
      const before = { consent: await handle.db.select().from(journalConsent),
        allowlist: await handle.db.select().from(tradingAllowlist), counters: await handle.db.select().from(mcpRateLimits),
        agents: await handle.db.select().from(agents), keys: await handle.db.select().from(agentKeys),
        ledger: (await handle.chain.sql.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY created_at')).rows };
      expect(before.ledger).toHaveLength(7);
      expect((await handle.chain.sql.query("SELECT to_regclass('public.ofac_sdn') AS table_name")).rows[0]!.table_name).toBeNull();
      await runMigrations(handle);
      await seedSanctions(handle.chain);
      const dataset = await handle.db.select().from(ofacSdn);
      expect(dataset[0]!.addresses).toContain(listedWallet);
      await runMigrations(handle);
      expect(await handle.db.select().from(journalConsent)).toEqual(before.consent);
      expect(await handle.db.select().from(tradingAllowlist)).toEqual(before.allowlist);
      expect(await handle.db.select().from(mcpRateLimits)).toEqual(before.counters);
      expect(await handle.db.select().from(agents)).toEqual(before.agents);
      expect(await handle.db.select().from(agentKeys)).toEqual(before.keys);
      expect(await handle.db.select().from(ofacSdn)).toEqual(dataset);
      const mergedLedger = (await handle.chain.sql.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY created_at')).rows;
      expect(mergedLedger.slice(0, 7)).toEqual(before.ledger);
      expect(mergedLedger).toHaveLength(26);
      expect(Number(mergedLedger[7]!.created_at)).toBeGreaterThan(Number(mergedLedger[6]!.created_at));
    } finally { await handle.close(); await rm(staging, { recursive: true, force: true }); }
  });
});

// Main 0000–0007 is the precise predecessor chain for reserved migration 0010.
it('upgrades main through sanctions 0007 and preserves its data and ledger on repeat', async () => {
  const staging = await mkdtemp(join(tmpdir(), 'eko-085b-main-migrations-'));
  const handle = await openDb({ pgliteDir: ':memory:' });
  try {
    await cp(join(MIGRATIONS_DIR, 'meta'), join(staging, 'meta'), { recursive: true });
    const journal = await readJournal();
    const mainEntries = journal.entries.slice(0, 8);
    expect(mainEntries.at(-1)!.tag).toBe('0007_ofac');
    await writeFile(join(staging, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: mainEntries }));
    for (const entry of mainEntries) await cp(join(MIGRATIONS_DIR, `${entry.tag}.sql`), join(staging, `${entry.tag}.sql`));
    await migrate(handle.db as never, { migrationsFolder: staging });
    await exerciseHarness(handle.db);
    const [account] = await handle.db.select().from(accounts);
    await handle.db.insert(journalConsent).values({ accountId: account!.id, optedIn: true });
    await handle.db.insert(tradingAllowlist).values({ wallet: listedWallet, role: 'team', capUsd: 25, addedBy: account!.id });
    await handle.db.insert(mcpRateLimits).values({ subjectHash: 'd'.repeat(64), windowStart: new Date(), hits: 4 });
    await seedSanctions(handle.chain);
    const before = {
      consent: await handle.db.select().from(journalConsent), allowlist: await handle.db.select().from(tradingAllowlist),
      counters: await handle.db.select().from(mcpRateLimits), agents: await handle.db.select().from(agents),
      keys: await handle.db.select().from(agentKeys), sanctions: await handle.db.select().from(ofacSdn),
      ledger: (await handle.chain.sql.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY created_at')).rows,
    };
    expect(before.ledger).toHaveLength(8);
    expect((await handle.chain.sql.query("SELECT to_regclass('public.launch_measurements') AS table_name")).rows[0]!.table_name).toBeNull();
    await runMigrations(handle);
    await handle.chain.sql.query('INSERT INTO launch_measurements VALUES($1,$2,$3)', ['backup_success', '[{"value":1,"at":1}]', 1]);
    await runMigrations(handle);
    expect(await handle.db.select().from(journalConsent)).toEqual(before.consent);
    expect(await handle.db.select().from(tradingAllowlist)).toEqual(before.allowlist);
    expect(await handle.db.select().from(mcpRateLimits)).toEqual(before.counters);
    expect(await handle.db.select().from(agents)).toEqual(before.agents);
    expect(await handle.db.select().from(agentKeys)).toEqual(before.keys);
    expect(await handle.db.select().from(ofacSdn)).toEqual(before.sanctions);
    expect((await handle.chain.sql.query('SELECT * FROM launch_measurements')).rows).toHaveLength(1);
    const ledger = (await handle.chain.sql.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY created_at')).rows;
    expect(ledger.slice(0, 8)).toEqual(before.ledger); expect(ledger).toHaveLength(26);
    expect(Number(ledger[8]!.created_at)).toBe(journal.entries[8]!.when);
  } finally { await handle.close(); await rm(staging, { recursive: true, force: true }); }
});

it('upgrades main through monitoring 0010 and preserves OAuth state on repeat', async () => {
  const staging = await mkdtemp(join(tmpdir(), 'eko-097-main-migrations-'));
  const handle = await openDb({ pgliteDir: ':memory:' });
  try {
    await cp(join(MIGRATIONS_DIR, 'meta'), join(staging, 'meta'), { recursive: true });
    const journal = await readJournal();
    const mainEntries = journal.entries.slice(0, 9);
    expect(mainEntries.at(-1)!.tag).toBe('0010_launch_monitoring');
    await writeFile(join(staging, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: mainEntries }));
    for (const entry of mainEntries) await cp(join(MIGRATIONS_DIR, `${entry.tag}.sql`), join(staging, `${entry.tag}.sql`));
    await migrate(handle.db as never, { migrationsFolder: staging });
    await exerciseHarness(handle.db);
    await handle.chain.sql.query('INSERT INTO launch_measurements VALUES($1,$2,$3)', ['fixture_counter', '[]', 1]);
    const before = { agents: await handle.db.select().from(agents), keys: await handle.db.select().from(agentKeys),
      monitoring: (await handle.chain.sql.query('SELECT * FROM launch_measurements')).rows,
      ledger: (await handle.chain.sql.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY created_at')).rows };
    expect(before.ledger).toHaveLength(9);
    expect((await handle.chain.sql.query("SELECT to_regclass('public.oauth_clients') AS table_name")).rows[0]!.table_name).toBeNull();
    await runMigrations(handle);
    await handle.db.insert(oauthClients).values({ id: 'sample-client', clientName: { text: 'Sample client', flags: [], truncated: false },
      redirectUris: ['https://clients.example/callback'] });
    await handle.db.insert(oauthRequests).values({ clientId: 'sample-client', redirectUri: 'https://clients.example/callback',
      codeChallenge: 'A'.repeat(43), codeChallengeMethod: 'S256', state: 'sample-state', scopes: ['senses:read', 'preflight', 'journal'],
      resource: 'https://mcp.eko.example/mcp', expiresAt: new Date(Date.now() + 600_000) });
    await handle.db.insert(oauthRegistrationLimits).values({ subjectHash: 'e'.repeat(64), attempts: [new Date()], allowed: true });
    const oauth = { clients: await handle.db.select().from(oauthClients), requests: await handle.db.select().from(oauthRequests),
      limits: await handle.db.select().from(oauthRegistrationLimits) };
    await runMigrations(handle);
    expect(await handle.db.select().from(agents)).toEqual(before.agents);
    expect(await handle.db.select().from(agentKeys)).toEqual(before.keys);
    expect((await handle.chain.sql.query('SELECT * FROM launch_measurements')).rows).toEqual(before.monitoring);
    expect(await handle.db.select().from(oauthClients)).toEqual(oauth.clients);
    expect(await handle.db.select().from(oauthRequests)).toEqual(oauth.requests);
    expect(await handle.db.select().from(oauthRegistrationLimits)).toEqual(oauth.limits);
    const ledger = (await handle.chain.sql.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY created_at')).rows;
    expect(ledger.slice(0, 9)).toEqual(before.ledger); expect(ledger).toHaveLength(26);
    expect(Number(ledger[9]!.created_at)).toBe(journal.entries[9]!.when);
  } finally { await handle.close(); await rm(staging, { recursive: true, force: true }); }
});

it('upgrades OAuth 0017 to points 0023 and preserves attribution and append-only history on rerun',async()=>{
  const staging=await mkdtemp(join(tmpdir(),'eko-122-main-migrations-'));
  const handle=await openDb({pgliteDir:':memory:'});
  try {
    await cp(join(MIGRATIONS_DIR,'meta'),join(staging,'meta'),{recursive:true});
    const journal=await readJournal(),mainEntries=journal.entries.slice(0,10);
    expect(mainEntries.at(-1)!.tag).toBe('0017_oauth_discovery');
    await writeFile(join(staging,'meta/_journal.json'),JSON.stringify({...journal,entries:mainEntries}));
    for(const entry of mainEntries)await cp(join(MIGRATIONS_DIR,`${entry.tag}.sql`),join(staging,`${entry.tag}.sql`));
    await migrate(handle.db as never,{migrationsFolder:staging});
    const [a,b]=await handle.db.insert(accounts).values([{kind:'wallet'},{kind:'wallet'}]).returning();
    await handle.chain.sql.query('INSERT INTO referral_codes VALUES($1,$2)',[a!.id,'sample-referral']);
    await handle.chain.sql.query('INSERT INTO referrals(referred_account_id,referrer_account_id) VALUES($1,$2)',[b!.id,a!.id]);
    const before={codes:(await handle.chain.sql.query('SELECT * FROM referral_codes')).rows,
      referrals:(await handle.chain.sql.query('SELECT * FROM referrals')).rows,
      ledger:(await handle.chain.sql.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY created_at')).rows};
    expect(before.ledger).toHaveLength(10);
    await runMigrations(handle);
    await handle.chain.sql.query(`INSERT INTO points_ledger(account_id,category,source_id,points,occurred_at,earning_day)
      VALUES($1,'shared_journal','sample-entry',3,'2026-10-14T00:00:00Z','2026-10-14')`,[a!.id]);
    const credit=(await handle.chain.sql.query('SELECT * FROM points_ledger')).rows;
    await runMigrations(handle);
    expect((await handle.chain.sql.query('SELECT * FROM referral_codes')).rows).toEqual(before.codes);
    expect((await handle.chain.sql.query('SELECT * FROM referrals')).rows).toEqual(before.referrals);
    expect((await handle.chain.sql.query('SELECT * FROM points_ledger')).rows).toEqual(credit);
    const ledger=(await handle.chain.sql.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY created_at')).rows;
    expect(ledger.slice(0,10)).toEqual(before.ledger);expect(ledger).toHaveLength(26);
    expect(Number(ledger[10]!.created_at)).toBe(journal.entries[10]!.when);
    await expect(handle.chain.sql.query('DELETE FROM points_ledger')).rejects.toThrow(/append-only/);
  } finally {await handle.close();await rm(staging,{recursive:true,force:true});}
});

it('upgrades main through points 0023 to bags 0024 and preserves redacted bag snapshots on repeat', async () => {
  const staging = await mkdtemp(join(tmpdir(), 'eko-109-main-migrations-'));
  const handle = await openDb({ pgliteDir: ':memory:' });
  try {
    await cp(join(MIGRATIONS_DIR, 'meta'), join(staging, 'meta'), { recursive: true });
    const journal = await readJournal();
    const mainEntries = journal.entries.slice(0, 11);
    expect(mainEntries.at(-1)!.tag).toBe('0023_points_ledger');
    await writeFile(join(staging, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: mainEntries }));
    for (const entry of mainEntries) await cp(join(MIGRATIONS_DIR, `${entry.tag}.sql`), join(staging, `${entry.tag}.sql`));
    await migrate(handle.db as never, { migrationsFolder: staging });
    await exerciseHarness(handle.db);
    await handle.db.insert(oauthClients).values({ id: 'sample-client', clientName: { text: 'Sample client', flags: [], truncated: false },
      redirectUris: ['https://clients.example/callback'] });
    const [account] = await handle.db.select().from(accounts);
    await handle.chain.sql.query(`INSERT INTO points_ledger(account_id,category,source_id,points,occurred_at,earning_day)
      VALUES($1,'shared_journal','sample-bags-entry',3,'2026-10-14T00:00:00Z','2026-10-14')`, [account!.id]);
    const before = { points: (await handle.chain.sql.query('SELECT * FROM points_ledger')).rows, clients: await handle.db.select().from(oauthClients), agents: await handle.db.select().from(agents),
      keys: await handle.db.select().from(agentKeys), policies: await handle.db.select().from(policies),
      ledger: (await handle.chain.sql.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY created_at')).rows };
    expect(before.ledger).toHaveLength(11);
    expect((await handle.chain.sql.query("SELECT to_regclass('public.bag_shares') AS table_name")).rows[0]!.table_name).toBeNull();
    await runMigrations(handle);
    const snapshot = { asOfBlock: 1, holdings: [], summary: { coins: 0, flagged: 0, danger: 0 } };
    const [shared] = await handle.db.insert(bagShares).values({ snapshot }).returning();
    await runMigrations(handle);
    expect(await handle.db.select().from(bagShares)).toEqual([shared]);
    expect((await handle.chain.sql.query('SELECT * FROM points_ledger')).rows).toEqual(before.points);
    await expect(handle.chain.sql.query('DELETE FROM points_ledger')).rejects.toThrow(/append-only/);
    expect(await handle.db.select().from(oauthClients)).toEqual(before.clients);
    expect(await handle.db.select().from(agents)).toEqual(before.agents);
    expect(await handle.db.select().from(agentKeys)).toEqual(before.keys);
    expect(await handle.db.select().from(policies)).toEqual(before.policies);
    const ledger = (await handle.chain.sql.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY created_at')).rows;
    expect(ledger.slice(0, 11)).toEqual(before.ledger); expect(ledger).toHaveLength(26);
    expect(Number(ledger[11]!.created_at)).toBe(journal.entries[11]!.when);
  } finally { await handle.close(); await rm(staging, { recursive: true, force: true }); }
});


it('upgrades bags 0024 to watches 0025 and preserves prior data and durable watch state on rerun', async () => {
  const staging = await mkdtemp(join(tmpdir(), 'eko-114-main-migrations-'));
  const handle = await openDb({ pgliteDir: ':memory:' });
  try {
    await cp(join(MIGRATIONS_DIR, 'meta'), join(staging, 'meta'), { recursive: true });
    const journal = await readJournal(), mainEntries = journal.entries.slice(0, 12);
    expect(mainEntries.at(-1)!.tag).toBe('0024_bags');
    await writeFile(join(staging, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: mainEntries }));
    for (const entry of mainEntries) await cp(join(MIGRATIONS_DIR, `${entry.tag}.sql`), join(staging, `${entry.tag}.sql`));
    await migrate(handle.db as never, { migrationsFolder: staging });
    await exerciseHarness(handle.db);
    const [account] = await handle.db.select().from(accounts);
    const [shared] = await handle.db.insert(bagShares).values({ snapshot: { asOfBlock: 1, holdings: [], summary: { coins: 0, flagged: 0, danger: 0 } } }).returning();
    const before = (await handle.chain.sql.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY created_at')).rows;
    expect(before).toHaveLength(12);
    expect((await handle.chain.sql.query("SELECT to_regclass('public.watches') AS table_name")).rows[0]!.table_name).toBeNull();
    await runMigrations(handle);
    await handle.chain.sql.query('INSERT INTO watches(account_id,kind,target,after_source) VALUES($1,$2,$3,$4)', [account!.id, 'coin', `0x${'a'.repeat(40)}`, 0]);
    const watches = (await handle.chain.sql.query('SELECT * FROM watches')).rows;
    await runMigrations(handle);
    expect((await handle.chain.sql.query('SELECT * FROM watches')).rows).toEqual(watches);
    expect(await handle.db.select().from(bagShares)).toEqual([shared]);
    expect(await handle.db.select().from(agents)).toHaveLength(1);
    expect(await handle.db.select().from(policies)).toHaveLength(1);
    expect(await handle.db.select().from(agentKeys)).toHaveLength(1);
    const ledger = (await handle.chain.sql.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY created_at')).rows;
    expect(ledger.slice(0, 12)).toEqual(before); expect(ledger).toHaveLength(26);
    expect(Number(ledger[12]!.created_at)).toBe(journal.entries[12]!.when);
  } finally { await handle.close(); await rm(staging, { recursive: true, force: true }); }
});

it('upgrades watches 0025 to Telegram 0026 and preserves prior data and caller records on rerun', async () => {
  const staging = await mkdtemp(join(tmpdir(), 'eko-116-main-migrations-'));
  const handle = await openDb({ pgliteDir: ':memory:' });
  try {
    await cp(join(MIGRATIONS_DIR, 'meta'), join(staging, 'meta'), { recursive: true });
    const journal = await readJournal(), mainEntries = journal.entries.slice(0, 13);
    expect(mainEntries.at(-1)!.tag).toBe('0025_watch_alerts');
    await writeFile(join(staging, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: mainEntries }));
    for (const entry of mainEntries) await cp(join(MIGRATIONS_DIR, `${entry.tag}.sql`), join(staging, `${entry.tag}.sql`));
    await migrate(handle.db as never, { migrationsFolder: staging });
    await exerciseHarness(handle.db);
    const [account] = await handle.db.select().from(accounts);
    const [shared] = await handle.db.insert(bagShares).values({ snapshot: { asOfBlock: 1, holdings: [], summary: { coins: 0, flagged: 0, danger: 0 } } }).returning();
    await handle.chain.sql.query('INSERT INTO watches(account_id,kind,target,after_source) VALUES($1,$2,$3,$4)', [account!.id, 'coin', `0x${'a'.repeat(40)}`, 0]);
    const before = { watches: (await handle.chain.sql.query('SELECT * FROM watches')).rows,
      ledger: (await handle.chain.sql.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY created_at')).rows };
    expect(before.ledger).toHaveLength(13);
    expect((await handle.chain.sql.query("SELECT to_regclass('public.caller_calls') AS table_name")).rows[0]!.table_name).toBeNull();
    await runMigrations(handle);
    const callId = '00000000-0000-4000-8000-000000000001';
    await handle.chain.sql.query('INSERT INTO bot_interactions(platform,update_id,state) VALUES($1,$2,$3)', ['telegram', 1, 'claimed']);
    await handle.chain.sql.query('INSERT INTO caller_calls(id,group_key,caller_key,coin,data) VALUES($1,$2,$3,$4,$5)', [callId, 'sample-group-hash', 'sample-caller-hash', `0x${'a'.repeat(40)}`, '{}']);
    await handle.chain.sql.query('INSERT INTO caller_grades(call_id,data) VALUES($1,$2)', [callId, '{}']);
    const records = { calls: (await handle.chain.sql.query('SELECT * FROM caller_calls')).rows,
      grades: (await handle.chain.sql.query('SELECT * FROM caller_grades')).rows,
      interactions: (await handle.chain.sql.query('SELECT * FROM bot_interactions')).rows };
    await runMigrations(handle);
    expect((await handle.chain.sql.query('SELECT * FROM watches')).rows).toEqual(before.watches);
    expect(await handle.db.select().from(bagShares)).toEqual([shared]);
    expect(await handle.db.select().from(agents)).toHaveLength(1);
    expect(await handle.db.select().from(policies)).toHaveLength(1);
    expect(await handle.db.select().from(agentKeys)).toHaveLength(1);
    expect((await handle.chain.sql.query('SELECT * FROM caller_calls')).rows).toEqual(records.calls);
    expect((await handle.chain.sql.query('SELECT * FROM caller_grades')).rows).toEqual(records.grades);
    expect((await handle.chain.sql.query('SELECT * FROM bot_interactions')).rows).toEqual(records.interactions);
    await expect(handle.chain.sql.query('DELETE FROM caller_calls')).rejects.toThrow(/append-only/);
    await expect(handle.chain.sql.query('DELETE FROM caller_grades')).rejects.toThrow(/append-only/);
    const ledger = (await handle.chain.sql.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY created_at')).rows;
    expect(ledger.slice(0, 13)).toEqual(before.ledger); expect(ledger).toHaveLength(26);
    expect(Number(ledger[13]!.created_at)).toBe(journal.entries[13]!.when);
  } finally { await handle.close(); await rm(staging, { recursive: true, force: true }); }
});

it('upgrades Telegram 0026 to trades 0027 and preserves prior data and trade intents on rerun', async () => {
  const staging = await mkdtemp(join(tmpdir(), 'eko-075-main-migrations-'));
  const handle = await openDb({ pgliteDir: ':memory:' });
  try {
    await cp(join(MIGRATIONS_DIR, 'meta'), join(staging, 'meta'), { recursive: true });
    const journal = await readJournal(), mainEntries = journal.entries.slice(0, 14);
    expect(mainEntries.at(-1)!.tag).toBe('0026_telegram_groups');
    await writeFile(join(staging, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: mainEntries }));
    for (const entry of mainEntries) await cp(join(MIGRATIONS_DIR, `${entry.tag}.sql`), join(staging, `${entry.tag}.sql`));
    await migrate(handle.db as never, { migrationsFolder: staging });
    await exerciseHarness(handle.db);
    const [account] = await handle.db.select().from(accounts);
    const [shared] = await handle.db.insert(bagShares).values({ snapshot: { asOfBlock: 1, holdings: [], summary: { coins: 0, flagged: 0, danger: 0 } } }).returning();
    await handle.chain.sql.query('INSERT INTO watches(account_id,kind,target,after_source) VALUES($1,$2,$3,$4)', [account!.id, 'coin', `0x${'a'.repeat(40)}`, 0]);
    await handle.chain.sql.query('INSERT INTO bot_interactions(platform,update_id,state) VALUES($1,$2,$3)', ['telegram', 1, 'claimed']);
    const before = { watches: (await handle.chain.sql.query('SELECT * FROM watches')).rows,
      interactions: (await handle.chain.sql.query('SELECT * FROM bot_interactions')).rows,
      ledger: (await handle.chain.sql.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY created_at')).rows };
    expect(before.ledger).toHaveLength(14);
    for (const table of ['trade_quotes', 'trade_orders']) {
      expect((await handle.chain.sql.query(`SELECT to_regclass('public.${table}') AS table_name`)).rows[0]!.table_name).toBeNull();
    }
    await runMigrations(handle);
    const quoteId = '00000000-0000-4000-8000-000000000001';
    await handle.chain.sql.query(`INSERT INTO trade_quotes(id,account_id,input,quote,quoted_at,expires_at)
      VALUES($1,$2,'{}','{}','2026-10-14T00:00:00Z','2026-10-14T00:00:15Z')`, [quoteId, account!.id]);
    await handle.chain.sql.query(`INSERT INTO trade_orders(account_id,quote_id,idempotency_key,request_body,order_hash,coin,side,fee_bps)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [account!.id, quoteId, 'sample-order-key', '{}', 'sample-order-hash', `0x${'a'.repeat(40)}`, 'buy', 0]);
    const trades = { quotes: (await handle.chain.sql.query('SELECT * FROM trade_quotes')).rows,
      orders: (await handle.chain.sql.query('SELECT * FROM trade_orders')).rows };
    expect(trades.quotes).toHaveLength(1);
    expect(trades.orders).toHaveLength(1);
    await runMigrations(handle);
    expect((await handle.chain.sql.query('SELECT * FROM trade_quotes')).rows).toEqual(trades.quotes);
    expect((await handle.chain.sql.query('SELECT * FROM trade_orders')).rows).toEqual(trades.orders);
    expect((await handle.chain.sql.query('SELECT * FROM watches')).rows).toEqual(before.watches);
    expect((await handle.chain.sql.query('SELECT * FROM bot_interactions')).rows).toEqual(before.interactions);
    expect(await handle.db.select().from(bagShares)).toEqual([shared]);
    expect(await handle.db.select().from(agents)).toHaveLength(1);
    expect(await handle.db.select().from(policies)).toHaveLength(1);
    expect(await handle.db.select().from(agentKeys)).toHaveLength(1);
    const ledger = (await handle.chain.sql.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY created_at')).rows;
    expect(ledger.slice(0, 14)).toEqual(before.ledger); expect(ledger).toHaveLength(26);
    expect(Number(ledger[14]!.created_at)).toBe(journal.entries[14]!.when);
  } finally { await handle.close(); await rm(staging, { recursive: true, force: true }); }
});

it('upgrades trades 0027 to preflight 0029, preserves replay state on rerun and enforces agent/ref uniqueness', async () => {
  const staging = await mkdtemp(join(tmpdir(), 'eko-095-main-migrations-'));
  const handle = await openDb({ pgliteDir: ':memory:' });
  try {
    await cp(join(MIGRATIONS_DIR, 'meta'), join(staging, 'meta'), { recursive: true });
    const journal = await readJournal(), mainEntries = journal.entries.slice(0, 15);
    expect(mainEntries.at(-1)!.tag).toBe('0027_trade_api');
    await writeFile(join(staging, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: mainEntries }));
    for (const entry of mainEntries) await cp(join(MIGRATIONS_DIR, `${entry.tag}.sql`), join(staging, `${entry.tag}.sql`));
    await migrate(handle.db as never, { migrationsFolder: staging });
    await exerciseHarness(handle.db);
    const before = { agents: await handle.db.select().from(agents), keys: await handle.db.select().from(agentKeys),
      ledger: (await handle.chain.sql.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY created_at')).rows };
    expect(before.ledger).toHaveLength(15);
    expect((await handle.chain.sql.query("SELECT to_regclass('public.preflights') AS table_name")).rows[0]!.table_name).toBeNull();
    await runMigrations(handle);
    const preflightId = randomUUID(), journalId = randomUUID();
    const result = { preflightId, journalId, decision: 'allow', reasons: [], policyVersion: 1 };
    await handle.chain.sql.query(`INSERT INTO preflights(id,agent_id,client_order_ref,order_hash,instrument,side,
      decision,reasons,policy_version,journal_id,result,latency_ms)
      VALUES($1,$2,'sample-order-ref',$3,'DEMO','buy','allow','[]',1,$4,$5,1)`,
    [preflightId,before.agents[0]!.id,`0x${'11'.repeat(32)}`,journalId,JSON.stringify(result)]);
    const preflight = (await handle.chain.sql.query('SELECT * FROM preflights')).rows;
    await runMigrations(handle);
    expect((await handle.chain.sql.query('SELECT * FROM preflights')).rows).toEqual(preflight);
    expect(await handle.db.select().from(agents)).toEqual(before.agents);
    expect(await handle.db.select().from(agentKeys)).toEqual(before.keys);
    const ledger = (await handle.chain.sql.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY created_at')).rows;
    expect(ledger.slice(0,15)).toEqual(before.ledger); expect(ledger).toHaveLength(26);
    expect(Number(ledger[15]!.created_at)).toBe(journal.entries[15]!.when);
    await expect(handle.chain.sql.query(`INSERT INTO preflights SELECT $1,agent_id,client_order_ref,order_hash,instrument,side,
      notional_usd,qty,decision,reasons,policy_version,approval_id,journal_id,result,latency_ms,created_at,updated_at
      FROM preflights`, [randomUUID()])).rejects.toThrow(/preflights_agent_ref/);
  } finally { await handle.close(); await rm(staging, { recursive: true, force: true }); }
});


it('upgrades consent 0030 to reconciliation 0031 and preserves existing trade intents on rerun', async () => {
  const staging = await mkdtemp(join(tmpdir(), 'eko-076-main-migrations-'));
  const handle = await openDb({ pgliteDir: ':memory:' });
  try {
    await cp(join(MIGRATIONS_DIR, 'meta'), join(staging, 'meta'), { recursive: true });
    const journal = await readJournal(), mainEntries = journal.entries.slice(0, 17);
    expect(mainEntries.at(-1)!.tag).toBe('0030_oauth_consent');
    await writeFile(join(staging, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: mainEntries }));
    for (const entry of mainEntries) await cp(join(MIGRATIONS_DIR, `${entry.tag}.sql`), join(staging, `${entry.tag}.sql`));
    await migrate(handle.db as never, { migrationsFolder: staging });
    await exerciseHarness(handle.db);
    const [account] = await handle.db.select().from(accounts);
    const quoteId = randomUUID();
    await handle.chain.sql.query(`INSERT INTO trade_quotes(id,account_id,input,quote,quoted_at,expires_at)
      VALUES($1,$2,'{}','{}','2026-10-14T00:00:00Z','2026-10-14T00:00:15Z')`, [quoteId, account!.id]);
    await handle.chain.sql.query(`INSERT INTO trade_orders(account_id,quote_id,idempotency_key,request_body,order_hash,coin,side,fee_bps)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [account!.id, quoteId, 'sample-reconcile-key', '{}', 'sample-reconcile-hash', `0x${'a'.repeat(40)}`, 'buy', 0]);
    const before = { quotes: (await handle.chain.sql.query('SELECT * FROM trade_quotes')).rows,
      orders: (await handle.chain.sql.query('SELECT * FROM trade_orders')).rows,
      agents: await handle.db.select().from(agents), keys: await handle.db.select().from(agentKeys),
      ledger: (await handle.chain.sql.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY created_at')).rows };
    expect(before.ledger).toHaveLength(17);
    expect((await handle.chain.sql.query("SELECT to_regclass('public.trade_guard_misses') AS table_name")).rows[0]!.table_name).toBeNull();
    await runMigrations(handle);
    await runMigrations(handle);
    expect((await handle.chain.sql.query('SELECT * FROM trade_quotes')).rows).toEqual(before.quotes);
    expect((await handle.chain.sql.query('SELECT * FROM trade_orders')).rows).toEqual(before.orders.map(row => ({
      ...row, tx_hash: null, filled_in: null, filled_out: null, error_code: null,
      submitted_at: null, settled_at: null, post_fill_evidence: null,
    })));
    expect((await handle.chain.sql.query('SELECT * FROM trade_guard_misses')).rows).toEqual([]);
    expect(await handle.db.select().from(agents)).toEqual(before.agents);
    expect(await handle.db.select().from(agentKeys)).toEqual(before.keys);
    const ledger = (await handle.chain.sql.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY created_at')).rows;
    expect(ledger.slice(0, 17)).toEqual(before.ledger); expect(ledger).toHaveLength(26);
    expect(Number(ledger[17]!.created_at)).toBe(journal.entries[17]!.when);
  } finally { await handle.close(); await rm(staging, { recursive: true, force: true }); }
});

it('upgrades reconciliation 0031 to account links 0033 and preserves prior state on rerun', async () => {
  const staging = await mkdtemp(join(tmpdir(), 'eko-117-migrations-'));
  const handle = await openDb({ pgliteDir: ':memory:' });
  try {
    await cp(join(MIGRATIONS_DIR, 'meta'), join(staging, 'meta'), { recursive: true });
    const journal = await readJournal(), previous = journal.entries.slice(0, 18);
    expect(previous.at(-1)!.tag).toBe('0031_trade_reconcile');
    await writeFile(join(staging, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: previous }));
    for (const entry of previous) await cp(join(MIGRATIONS_DIR, `${entry.tag}.sql`), join(staging, `${entry.tag}.sql`));
    await migrate(handle.db as never, { migrationsFolder: staging });
    await exerciseHarness(handle.db);
    const [account] = await handle.db.select().from(accounts);
    await handle.chain.sql.query("INSERT INTO bot_interactions(platform,update_id,state) VALUES('telegram',117,'sent')");
    const before = { interactions: (await handle.chain.sql.query('SELECT * FROM bot_interactions')).rows,
      ledger: (await handle.chain.sql.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY created_at')).rows };
    expect(before.ledger).toHaveLength(18);
    expect((await handle.chain.sql.query("SELECT to_regclass('public.linked_identities') AS table_name")).rows[0]!.table_name).toBeNull();
    await runMigrations(handle);
    await handle.chain.sql.query("INSERT INTO linked_identities(account_id,provider,external_id) VALUES($1,'telegram','9001')", [account!.id]);
    await handle.chain.sql.query("INSERT INTO telegram_link_codes(code_hash,account_id,expires_at) VALUES($1,$2,now()+interval '10 minutes')", ['a'.repeat(64), account!.id]);
    const links = (await handle.chain.sql.query('SELECT * FROM linked_identities')).rows;
    const codes = (await handle.chain.sql.query('SELECT * FROM telegram_link_codes')).rows;
    await runMigrations(handle);
    expect((await handle.chain.sql.query('SELECT * FROM linked_identities')).rows).toEqual(links);
    expect((await handle.chain.sql.query('SELECT * FROM telegram_link_codes')).rows).toEqual(codes);
    expect((await handle.chain.sql.query('SELECT * FROM bot_interactions')).rows).toEqual(before.interactions);
    expect(await handle.db.select().from(agents)).toHaveLength(1);
    expect(await handle.db.select().from(policies)).toHaveLength(1);
    expect(await handle.db.select().from(agentKeys)).toHaveLength(1);
    const ledger = (await handle.chain.sql.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY created_at')).rows;
    expect(ledger.slice(0, 18)).toEqual(before.ledger); expect(ledger).toHaveLength(26);
    expect(Number(ledger[18]!.created_at)).toBe(journal.entries[18]!.when);
  } finally { await handle.close(); await rm(staging, { recursive: true, force: true }); }
});

it('upgrades Telegram DMs 0033 to collector 0034 and preserves durable evidence on rerun', async () => {
  const staging = await mkdtemp(join(tmpdir(), 'eko-security-migration-'));
  const handle = await openDb({ pgliteDir: ':memory:' });
  try {
    await cp(join(MIGRATIONS_DIR, 'meta'), join(staging, 'meta'), { recursive: true });
    const journal = await readJournal(), predecessor = journal.entries.slice(0, 19);
    expect(predecessor.at(-1)!.tag).toBe('0033_telegram_dms');
    await writeFile(join(staging, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: predecessor }));
    for (const entry of predecessor) await cp(join(MIGRATIONS_DIR, `${entry.tag}.sql`), join(staging, `${entry.tag}.sql`));
    await migrate(handle.db as never, { migrationsFolder: staging });
    await exerciseHarness(handle.db);
    const before = (await handle.chain.sql.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY created_at')).rows;
    await runMigrations(handle);
    const hash = Buffer.alloc(32, 1);
    await handle.chain.sql.query('INSERT INTO security_collector_checkpoints(stream,block,hash,log_index) VALUES($1,10,$2,2)', ['sample-stream', hash]);
    await handle.chain.sql.query('INSERT INTO security_collector_events(stream,block,log_index,hash,timestamp_s,evidence) VALUES($1,10,2,$2,100,$3)', ['sample-stream', hash, '{"event":"CommitterChanged"}']);
    const points = (await handle.chain.sql.query('SELECT * FROM security_collector_checkpoints')).rows;
    const events = (await handle.chain.sql.query('SELECT * FROM security_collector_events')).rows;
    await runMigrations(handle);
    expect((await handle.chain.sql.query('SELECT * FROM security_collector_checkpoints')).rows).toEqual(points);
    expect((await handle.chain.sql.query('SELECT * FROM security_collector_events')).rows).toEqual(events);
    expect(await handle.db.select().from(agents)).toHaveLength(1);
    const ledger = (await handle.chain.sql.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY created_at')).rows;
    expect(ledger.slice(0, 19)).toEqual(before); expect(ledger).toHaveLength(26);
    expect(Number(ledger[19]!.created_at)).toBe(journal.entries[19]!.when);
    await expect(handle.chain.sql.query('UPDATE security_collector_events SET timestamp_s=$1', [Infinity])).rejects.toThrow();
  } finally { await handle.close(); await rm(staging, { recursive: true, force: true }); }
});

it('upgrades Swarm inference 0037 to X 0040, preserves interactions and keeps cursor/quotas on rerun', async () => {
  const staging = await mkdtemp(join(tmpdir(), 'eko-126-main-migrations-'));
  const handle = await openDb({ pgliteDir: ':memory:' });
  try {
    await cp(join(MIGRATIONS_DIR, 'meta'), join(staging, 'meta'), { recursive: true });
    const journal = await readJournal(), mainEntries = journal.entries.slice(0, 22);
    expect(mainEntries.at(-1)!.tag).toBe('0037_swarm_inference');
    await writeFile(join(staging, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: mainEntries }));
    for (const entry of mainEntries) await cp(join(MIGRATIONS_DIR, `${entry.tag}.sql`), join(staging, `${entry.tag}.sql`));
    await migrate(handle.db as never, { migrationsFolder: staging });
    await handle.chain.sql.query("INSERT INTO bot_interactions(platform,update_id,state) VALUES('telegram',101,'sent')");
    const before = (await handle.chain.sql.query('SELECT * FROM bot_interactions')).rows;
    const ledgerBefore = (await handle.chain.sql.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY created_at')).rows;
    await runMigrations(handle);
    const state = { cursor: '9007199254740993', stopped: false };
    await handle.chain.sql.query('INSERT INTO x_bot_state(id,data) VALUES(1,$1::jsonb)', [JSON.stringify(state)]);
    await handle.chain.sql.query("INSERT INTO x_bot_usage(bucket,spend,reads,replies) VALUES('2026-10',15000,1,1)");
    await handle.chain.sql.query("INSERT INTO burn_posts(platform,burn_tx,state) VALUES('x',$1,'sent')", [`0x${'ab'.repeat(32)}`]);
    await runMigrations(handle);
    expect((await handle.chain.sql.query('SELECT * FROM bot_interactions')).rows).toEqual(before);
    expect((await handle.chain.sql.query('SELECT data FROM x_bot_state')).rows).toEqual([{ data: state }]);
    expect((await handle.chain.sql.query('SELECT spend,reads,replies FROM x_bot_usage')).rows).toEqual([{ spend: 15000, reads: 1, replies: 1 }]);
    await expect(handle.chain.sql.query("INSERT INTO burn_posts(platform,burn_tx,state) VALUES('x',$1,'claimed')", [`0x${'ab'.repeat(32)}`])).rejects.toThrow();
    const ledger = (await handle.chain.sql.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY created_at')).rows;
    expect(ledger.slice(0, 22)).toEqual(ledgerBefore); expect(ledger).toHaveLength(26);
    expect(Number(ledger[22]!.created_at)).toBe(journal.entries[22]!.when);
  } finally { await handle.close(); await rm(staging, { recursive: true, force: true }); }
});

it('upgrades X 0040 to Farcaster 0041 without changing Telegram/X records or replay claims', async () => {
  const staging = await mkdtemp(join(tmpdir(), 'eko-127-main-migrations-'));
  const handle = await openDb({ pgliteDir: ':memory:' });
  try {
    await cp(join(MIGRATIONS_DIR, 'meta'), join(staging, 'meta'), { recursive: true });
    const journal = await readJournal(), mainEntries = journal.entries.slice(0, 23);
    expect(mainEntries.at(-1)!.tag).toBe('0040_x_bot_dark');
    await writeFile(join(staging, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: mainEntries }));
    for (const entry of mainEntries) await cp(join(MIGRATIONS_DIR, `${entry.tag}.sql`), join(staging, `${entry.tag}.sql`));
    await migrate(handle.db as never, { migrationsFolder: staging });
    await handle.chain.sql.query("INSERT INTO bot_interactions(platform,update_id,state) VALUES('telegram',1,'sent')");
    const xState = { cursor: '9007199254740993', stopped: false };
    await handle.chain.sql.query('INSERT INTO x_bot_state(id,data) VALUES(1,$1::jsonb)', [JSON.stringify(xState)]);
    await handle.chain.sql.query("INSERT INTO x_bot_usage(bucket,spend,reads,replies) VALUES('2026-10',15000,1,1)");
    const xRecords = { state: (await handle.chain.sql.query('SELECT * FROM x_bot_state')).rows,
      usage: (await handle.chain.sql.query('SELECT * FROM x_bot_usage')).rows };
    const prior = (await handle.chain.sql.query('SELECT * FROM bot_interactions')).rows;
    const ledger = (await handle.chain.sql.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY created_at')).rows;
    expect(ledger).toHaveLength(23);
    expect((await handle.chain.sql.query("SELECT to_regclass('public.farcaster_interactions') AS table_name")).rows[0]!.table_name).toBeNull();
    await runMigrations(handle);
    await handle.chain.sql.query(`INSERT INTO farcaster_interactions(bot_fid,cast_hash,author_key,state)
      VALUES(1001,$1,$2,'claimed')`, [`0x${'a'.repeat(40)}`, 'b'.repeat(64)]);
    await handle.chain.sql.query('INSERT INTO farcaster_summon_locks(bot_fid,author_key) VALUES(1001,$1)', ['b'.repeat(64)]);
    const claims = (await handle.chain.sql.query('SELECT * FROM farcaster_interactions')).rows;
    await runMigrations(handle);
    expect((await handle.chain.sql.query('SELECT * FROM bot_interactions')).rows).toEqual(prior);
    expect((await handle.chain.sql.query('SELECT * FROM x_bot_state')).rows).toEqual(xRecords.state);
    expect((await handle.chain.sql.query('SELECT * FROM x_bot_usage')).rows).toEqual(xRecords.usage);
    expect((await handle.chain.sql.query('SELECT * FROM farcaster_interactions')).rows).toEqual(claims);
    expect((await handle.chain.sql.query('SELECT * FROM farcaster_summon_locks')).rows).toEqual([{ bot_fid: 1001, author_key: 'b'.repeat(64) }]);
    await expect(handle.chain.sql.query(`INSERT INTO farcaster_interactions(bot_fid,cast_hash,author_key,state)
      VALUES(1001,$1,$2,'claimed')`, [`0x${'a'.repeat(40)}`, 'b'.repeat(64)])).rejects.toThrow(/duplicate key/);
    const merged = (await handle.chain.sql.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY created_at')).rows;
    expect(merged.slice(0, 23)).toEqual(ledger); expect(merged).toHaveLength(26);
    expect(Number(merged[23]!.created_at)).toBe(journal.entries[23]!.when);
  } finally { await handle.close(); await rm(staging, { recursive: true, force: true }); }
});

it('upgrades Farcaster 0041 to OAuth tokens 0043 and preserves prior data and ledger on rerun', async () => {
  const staging = await mkdtemp(join(tmpdir(), 'eko-099-main-migrations-'));
  const handle = await openDb({ pgliteDir: ':memory:' });
  try {
    await cp(join(MIGRATIONS_DIR, 'meta'), join(staging, 'meta'), { recursive: true });
    const journal = await readJournal(), mainEntries = journal.entries.slice(0, 24);
    expect(mainEntries.at(-1)!.tag).toBe('0041_farcaster_summons');
    await writeFile(join(staging, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: mainEntries }));
    for (const entry of mainEntries) await cp(join(MIGRATIONS_DIR, `${entry.tag}.sql`), join(staging, `${entry.tag}.sql`));
    await migrate(handle.db as never, { migrationsFolder: staging });
    await exerciseHarness(handle.db);
    await handle.chain.sql.query(`INSERT INTO farcaster_interactions(bot_fid,cast_hash,author_key,state)
      VALUES(1001,$1,$2,'claimed')`, [`0x${'a'.repeat(40)}`, 'b'.repeat(64)]);
    const before = { agents: await handle.db.select().from(agents), keys: await handle.db.select().from(agentKeys),
      policies: await handle.db.select().from(policies),
      claims: (await handle.chain.sql.query('SELECT * FROM farcaster_interactions')).rows,
      ledger: (await handle.chain.sql.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY created_at')).rows };
    expect(before.ledger).toHaveLength(24);
    expect((await handle.chain.sql.query("SELECT to_regclass('public.oauth_tokens') AS table_name")).rows[0]!.table_name).toBeNull();
    await runMigrations(handle);
    expect((await handle.chain.sql.query('SELECT * FROM oauth_tokens')).rows).toEqual([]);
    await runMigrations(handle);
    expect(await handle.db.select().from(agents)).toEqual(before.agents);
    expect(await handle.db.select().from(agentKeys)).toEqual(before.keys);
    expect(await handle.db.select().from(policies)).toEqual(before.policies);
    expect((await handle.chain.sql.query('SELECT * FROM farcaster_interactions')).rows).toEqual(before.claims);
    const ledger = (await handle.chain.sql.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY created_at')).rows;
    expect(ledger.slice(0, 24)).toEqual(before.ledger); expect(ledger).toHaveLength(26);
    expect(Number(ledger[24]!.created_at)).toBe(journal.entries[24]!.when);
  } finally { await handle.close(); await rm(staging, { recursive: true, force: true }); }
});

it('upgrades 0043 to immutable scoreboard 0044 and preserves source data and the ledger on rerun',async()=>{
  const handle=await openDb({pgliteDir:':memory:'}), staging=await mkdtemp(join(tmpdir(),'eko-scoreboard-migration-'));
  try {
    await import('node:fs/promises').then(fs=>fs.mkdir(join(staging,'meta')));
    const journal=await readJournal(), entries=journal.entries.slice(0,25);
    expect(entries.at(-1)!.tag).toBe('0043_oauth_tokens');
    await writeFile(join(staging,'meta/_journal.json'),JSON.stringify({version:'7',dialect:'postgresql',entries}));
    for(const entry of entries)await cp(join(MIGRATIONS_DIR,`${entry.tag}.sql`),join(staging,`${entry.tag}.sql`));
    await migrate(handle.db as never,{migrationsFolder:staging});
    await exerciseHarness(handle.db);
    const before={agents:await handle.db.select().from(agents),keys:await handle.db.select().from(agentKeys),ledger:(await handle.chain.sql.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY created_at')).rows};
    expect(before.ledger).toHaveLength(25);
    expect((await handle.chain.sql.query("SELECT to_regclass('public.scoreboard_records') AS table_name")).rows[0]!.table_name).toBeNull();
    await runMigrations(handle);
    await handle.chain.sql.query("INSERT INTO scoreboard_records(source_key,category,data) VALUES('fixture-coverage','coverage','{}')");
    const records=(await handle.chain.sql.query('SELECT * FROM scoreboard_records')).rows;
    await runMigrations(handle);
    expect((await handle.chain.sql.query('SELECT * FROM scoreboard_records')).rows).toEqual(records);
    expect(await handle.db.select().from(agents)).toEqual(before.agents);expect(await handle.db.select().from(agentKeys)).toEqual(before.keys);
    const ledger=(await handle.chain.sql.query('SELECT * FROM drizzle.__drizzle_migrations ORDER BY created_at')).rows;
    expect(ledger).toHaveLength(26);expect(ledger.slice(0,25)).toEqual(before.ledger);expect(Number(ledger[25]!.created_at)).toBe(journal.entries[25]!.when);
    await expect(handle.chain.sql.query('UPDATE scoreboard_records SET data=data')).rejects.toThrow('append-only');
    await expect(handle.chain.sql.query('DELETE FROM scoreboard_records')).rejects.toThrow('append-only');
  }finally{await handle.close();await rm(staging,{recursive:true,force:true});}
});
