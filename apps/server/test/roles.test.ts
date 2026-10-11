import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireRoleLease, imageRoles, planRole, roleStartupMessage, runRole, type RolePlan } from '../src/roles.js';
import { loadConfig } from '../src/config.js';

import { openDb } from '../../../packages/db/test/helpers/historical-db.js';

const directory = mkdtempSync(join(tmpdir(), 'eko-role-tests-'));
for (const file of ['index.js', 'indexer.js', 'engines.js', 'receipts.js', 'mcp.js']) writeFileSync(join(directory, file), '');
afterEach(() => vi.restoreAllMocks());
process.once('exit', () => rmSync(directory, { recursive: true, force: true }));
const plan = (role = 'worker', env: NodeJS.ProcessEnv = {}) => planRole({ APP_ROLE: role, ...env }, directory);

describe('closed image role dispatch', () => {
  it('maps implemented roles, isolates the reconciler and preserves runtime trading settings', () => {
    for (const role of ['api', 'indexer', 'engines', 'worker', 'receipts', 'mcp']) {
      const result = plan(role, { RUN_WORKER: 'true', LIVE_TRADING_ENABLED: 'false' });
      expect(result.env.APP_ROLE).toBe(role);
      expect(result.env.RUN_WORKER).toBe(role === 'worker' ? 'true' : 'false');
      expect(result.env.LIVE_TRADING_ENABLED).toBe('false');
    }
    expect(plan('api').env.LIVE_TRADING_ENABLED).toBeUndefined();
    expect(plan('api', { LIVE_TRADING_ENABLED: 'true' }).env.LIVE_TRADING_ENABLED).toBe('true');
    expect(plan('api').singleton).toBe(false);
    expect(plan('worker').singleton).toBe(true);
  });
  it.each(['', 'dev', 'keeper', 'sim', 'API', 'toString', 'unknown'])('rejects unknown image role %s', role => {
    expect(() => plan(role)).toThrow('Unknown or missing APP_ROLE');
  });
  it.each(['bots', 'og', 'swarm', 'research'])('keeps unimplemented %s unavailable even if a file exists', role => {
    writeFileSync(join(directory, `${role}.js`), '');
    expect(() => plan(role)).toThrow('unavailable');
    expect(imageRoles[role as keyof typeof imageRoles]).toBeNull();
  });
  it('rejects missing artifacts and production PGlite before opening any service', () => {
    expect(() => planRole({ APP_ROLE: 'api' }, join(directory, 'absent'))).toThrow('entry point is missing');
    for (const role of ['api', 'worker', 'indexer', 'engines', 'receipts']) {
      expect(() => plan(role, { NODE_ENV: 'production', DATABASE_URL: '' })).toThrow('DATABASE_URL required in production');
      expect(() => plan(role, { NODE_ENV: 'production', DATABASE_URL: 'postgresql://demo-account@localhost/fixture' })).not.toThrow();
    }
    expect(() => plan('api', { DATABASE_URL: 'file:local' })).toThrow('Postgres URL');
  });
  it('prints only the failed requirement for unknown roles, missing entry points and production configuration', () => {
    const attempts = [
      () => plan('fixture-only-secret'),
      () => planRole({ APP_ROLE: 'api' }, join(directory, 'absent')),
      () => plan('api', { NODE_ENV: 'production' }),
      () => plan('api', { DATABASE_URL: 'postgresql://demo-account:fixture-only-password@[' }),
    ];
    const requirements = ['Unknown or missing APP_ROLE', 'APP_ROLE=api entry point is missing', 'DATABASE_URL required in production; PGlite is unavailable', 'DATABASE_URL must be a Postgres URL'];
    attempts.forEach((attempt, index) => {
      try { attempt(); throw new Error('Expected startup refusal'); }
      catch (error) {
        expect(roleStartupMessage(error)).toBe(`EKO role startup failed: ${requirements[index]}`);
      }
    });
  });
  it('enforces production database/replica constraints outside the image too', async () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow('DATABASE_URL');
    expect(() => loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgresql://localhost/fixture' })).toThrow('RUN_WORKER=false');
    expect(() => loadConfig({ APP_ROLE: 'worker', RUN_WORKER: 'false' })).toThrow('RUN_WORKER=true');
    vi.stubEnv('NODE_ENV', 'production');
    try { await expect(openDb({ pgliteDir: ':memory:' })).rejects.toThrow('DATABASE_URL'); }
    finally { vi.unstubAllEnvs(); }
  });
});

describe('singleton ownership', () => {
  const fixture = () => {
    vi.spyOn(pg.Client.prototype, 'connect').mockImplementation(async () => {});
    const query = vi.spyOn(pg.Client.prototype, 'query').mockImplementation(async () => ({ rows: [{ acquired: true }] }) as never);
    const end = vi.spyOn(pg.Client.prototype, 'end').mockImplementation(async () => {});
    return { query, end };
  };
  const pgPlan = () => plan('worker', { DATABASE_URL: 'postgresql://localhost/fixture' });
  it('owns one Postgres session until close, and excludes another owner', async () => {
    const { query, end } = fixture();
    const lease = await acquireRoleLease(pgPlan(), vi.fn());
    expect(query).toHaveBeenCalledWith('SELECT pg_try_advisory_lock(4663, hashtext($1)) AS acquired', ['eko:role:worker']);
    expect(end).not.toHaveBeenCalled();
    await lease.close();
    expect(end).toHaveBeenCalledTimes(1);
    query.mockImplementation(async () => ({ rows: [{ acquired: false }] }) as never);
    await expect(acquireRoleLease(pgPlan(), vi.fn())).rejects.toThrow('singleton ownership is already taken');
    expect(end).toHaveBeenCalledTimes(2);
  });
  it('does not acquire a singleton lock for API replicas', async () => {
    const { query } = fixture();
    await (await acquireRoleLease(plan('api', { DATABASE_URL: 'postgresql://localhost/fixture' }), vi.fn())).close();
    expect(query).not.toHaveBeenCalled();
  });
  it('names a failed connection without printing provider details or URLs', async () => {
    fixture();
    vi.mocked(pg.Client.prototype.connect).mockRejectedValue(new Error('postgresql://demo-account:fixture-only-password@example.invalid/fixture') as never);
    const error = await acquireRoleLease(pgPlan(), vi.fn()).catch(error => error);
    expect(roleStartupMessage(error)).toBe('EKO role startup failed: APP_ROLE=worker Postgres connection or ownership check failed');
    expect(roleStartupMessage(new Error('fixture-only-secret'))).toBe('EKO role startup failed: runtime entry point failed (details withheld)');
  });
});

describe('role lifecycle', () => {
  function fixture() {
    const child = new EventEmitter() as ChildProcess;
    child.kill = vi.fn(() => true);
    const close = vi.fn(async () => {});
    const lease = vi.fn(async (_plan: RolePlan, _lost: () => void) => ({ close }));
    const spawn = vi.fn(() => child);
    return { child, close, lease, spawn };
  }
  it('announces the build identity of headless roles before starting them, and lets api and worker report their own', async () => {
    const f = fixture(), announced: string[] = [];
    const announce = (p: RolePlan) => { if (p.role !== 'api' && p.role !== 'worker') announced.push(p.role); };
    const done = runRole({ ...plan(), role: 'indexer' } as RolePlan, { ...f, announce });
    await vi.waitFor(() => expect(f.spawn).toHaveBeenCalledTimes(1));
    expect(announced).toEqual(['indexer']);
    f.child.emit('close', 0, null); await done;
    const failing = fixture();
    await expect(runRole({ ...plan(), role: 'engines' } as RolePlan, { ...failing, announce: () => { throw new Error('Production build identity missing or invalid'); } })).rejects.toThrow('build identity');
    expect(failing.spawn).not.toHaveBeenCalled();
  });
  it('computes headless role identity with the same digest the staging verifier expects', async () => {
    const { roleIdentity, expectedConfigDigest } = await import('../src/build-identity.js');
    const inventory = JSON.parse(readFileSync(new URL('../../../infra/railway/staging.json', import.meta.url), 'utf8'));
    const env = { ...inventory.commonEnvironment, ...inventory.services.indexer.environment, NODE_ENV: 'test', BURN_WALLET_ADDRESS: '0x000000000000000000000000000000000000dEaD' };
    const caps = readFileSync(new URL('../config/trading-caps.yaml', import.meta.url), 'utf8');
    const identity = roleIdentity(env, null);
    expect(identity.role).toBe('indexer');
    expect(identity.configDigest).toBe(expectedConfigDigest(env, caps));
  });
  it.each(['SIGTERM', 'SIGINT'] as const)('starts one child and holds ownership while draining %s', async signal => {
    const f = fixture();
    const done = runRole(plan(), f);
    await vi.waitFor(() => expect(f.spawn).toHaveBeenCalledTimes(1));
    process.emit(signal);
    expect(f.child.kill).toHaveBeenCalledWith(signal);
    expect(f.close).not.toHaveBeenCalled();
    f.child.emit('close', 0, null);
    expect(await done).toBe(0);
    expect(f.close).toHaveBeenCalledTimes(1);
  });
  it('starts no child on failed ownership and closes the lease on child failure', async () => {
    const f = fixture();
    f.lease.mockRejectedValueOnce(new Error('already owned'));
    await expect(runRole(plan(), f)).rejects.toThrow('already owned');
    expect(f.spawn).not.toHaveBeenCalled();
    const done = runRole(plan(), f);
    await vi.waitFor(() => expect(f.spawn).toHaveBeenCalledTimes(1));
    f.child.emit('close', 7, null);
    expect(await done).toBe(7);
    expect(f.close).toHaveBeenCalledTimes(1);
  });
  it('stops the child immediately when singleton ownership is lost', async () => {
    const f = fixture();
    const done = runRole(plan(), f);
    await vi.waitFor(() => expect(f.spawn).toHaveBeenCalledTimes(1));
    f.lease.mock.calls[0][1]();
    expect(f.child.kill).toHaveBeenCalledWith('SIGKILL');
    f.child.emit('close', null, 'SIGKILL');
    expect(await done).toBe(1);
    expect(f.close).toHaveBeenCalledTimes(1);
  });
  it('handles termination during ownership acquisition without launching a child', async () => {
    const f = fixture();
    let ready!: () => void;
    f.lease.mockImplementationOnce(async () => { await new Promise<void>(resolve => { ready = resolve; }); return { close: f.close }; });
    const done = runRole(plan(), f);
    process.emit('SIGTERM'); ready();
    expect(await done).toBe(0);
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.close).toHaveBeenCalledTimes(1);
  });
});

it('builds browser bundles in their own image stage, away from server sources and the server build', () => {
  const dockerfile = readFileSync(new URL('Dockerfile', new URL('../../../', import.meta.url)), 'utf8');
  const stages = dockerfile.split(/^FROM /m).slice(1);
  const server = stages.find(stage => stage.includes('@eko/server build'))!;
  expect(server).not.toMatch(/@eko\/(web|landing) build/);
  expect(server).toContain("pnpm install --frozen-lockfile --filter '!@eko/web' --filter '!@eko/landing'");
  const frontend = stages.find(stage => stage.includes('@eko/landing build'))!;
  expect(frontend).not.toMatch(/apps\/server|COPY \. \./);
  expect(dockerfile).toContain('COPY --from=frontend /repo/apps/web/dist ./web');
  expect(dockerfile).toContain('COPY --from=frontend /repo/apps/landing/dist ./landing');
});

it('copies every current workspace manifest before frozen image installation and excludes runtime secrets', () => {
  const root = new URL('../../../', import.meta.url);
  const dockerfile = readFileSync(new URL('Dockerfile', root), 'utf8');
  const beforeInstall = dockerfile.split('RUN pnpm install --frozen-lockfile')[0];
  for (const parent of ['apps', 'packages']) {
    for (const name of readdirSync(new URL(`${parent}/`, root))) {
      expect(beforeInstall).toContain(`COPY ${parent}/${name}/package.json ${parent}/${name}/`);
    }
  }
  expect(beforeInstall).toContain('COPY contracts/package.json contracts/');
  expect(dockerfile).toContain('RUN_WORKER=false');
  expect(dockerfile).toContain('CMD ["node", "dist/launch.js"]');
  expect(dockerfile).not.toMatch(/(?:ARG|ENV)\s+(?:SESSION_SECRET|.*API_KEY|.*PRIVATE_KEY|DATABASE_URL)\b/);
  const ignored = readFileSync(new URL('.dockerignore', root), 'utf8').split('\n');
  expect(ignored).toContain('**/.env');
  expect(ignored).toContain('**/.env.*');
  expect(ignored).toContain('**/secrets');
});
