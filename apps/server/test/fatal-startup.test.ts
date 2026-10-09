import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { runRole, type RolePlan } from '../src/roles.js';

const directory = mkdtempSync('.fatal-role-test-');
const entry = join(process.cwd(), directory, 'index.mjs');
beforeAll(async () => {
  const result = await build({
    entryPoints: ['src/index.ts'], bundle: true, platform: 'node', format: 'esm', write: false,
    plugins: [{ name: 'role-services', setup(builder) {
      builder.onLoad({ filter: /src\/(?:app|config|dev|build-identity|obs\/(?:logger|errors|security-worker))\.ts$/ }, args => {
        const mode = "process.env.TEST_MODE";
        if (args.path.endsWith('/app.ts')) return { contents: `
          const mode = ${mode};
          setInterval(() => {}, 1000); // A live DB handle must not keep a failed boot alive.
          export async function buildApp() {
            if (mode === 'boot') throw new Error('fixture');
            if (mode === 'connection') {
              setImmediate(() => { throw new Error('Connection terminated unexpectedly'); });
              await new Promise(() => {});
            }
            const loop = { start() { if (mode === 'start') throw new Error('fixture'); } };
            return {
              app: { async listen(options) {
                if (mode === 'listen') throw new Error('fixture');
                console.log(JSON.stringify({ listening: options.host }));
                if (mode === 'uncaught') setImmediate(() => { throw new Error('fixture'); });
                if (mode === 'rejection') setImmediate(() => { void Promise.reject(new Error('fixture')); });
              } },
              ctx: { exec: loop, sanctionsWorker: loop, retentionWorker: loop, pricingRepair: loop,
                coinOnboarding: loop, blueChipListings: loop, dbh: { driver: 'fixture' },
                market: { source: 'fixture' }, providers: { healthList: () => [] } },
              async close() { console.log('fixture closed'); }
            };
          }` };
        if (args.path.endsWith('/config.ts')) return { contents: "export const loadConfig = () => ({ APP_ROLE: process.env.APP_ROLE, HOST: '0.0.0.0', PORT: 8710 });" };
        if (args.path.endsWith('/dev.ts')) return { contents: 'export const startDev = async () => undefined;' };
        if (args.path.endsWith('/build-identity.ts')) return { contents: 'export const runtimeIdentity = () => ({});' };
        if (args.path.endsWith('/logger.ts')) return { contents: 'export const logger = { info(_fields, msg) { if (msg) console.log(msg); }, warn() {} };' };
        if (args.path.endsWith('/errors.ts')) return { contents: 'export const reportError = async () => {};' };
        return { contents: 'export const workerSecurityCollectors = () => undefined;' };
      });
    } }],
  });
  writeFileSync(entry, result.outputFiles[0].text);
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

async function child(mode: string, role = 'worker', signal = false) {
  const process = spawn(globalThis.process.execPath, [entry], {
    env: { TEST_MODE: mode, APP_ROLE: role, SESSION_SECRET: 'fixture-placeholder' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  const timeout = setTimeout(() => process.kill('SIGKILL'), 5000);
  process.stdout.on('data', chunk => {
    stdout += chunk;
    if (signal && stdout.includes('ready')) process.kill('SIGTERM');
  });
  process.stderr.on('data', chunk => { stderr += chunk; });
  const result = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    process.once('error', reject);
    process.once('close', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timeout);
  return { ...result, stdout, stderr };
}

it.each(['boot', 'connection', 'start', 'listen', 'uncaught', 'rejection'])('exits nonzero after %s even with open handles, logging one bounded fatal line', async mode => {
  const result = await child(mode);
  expect(result.signal).toBeNull();
  expect(result.code).toBe(1);
  expect(result.stderr.trim().split('\n')).toHaveLength(1);
  expect(JSON.parse(result.stderr)).toMatchObject({ level: 60, msg: 'EKO role halted' });
  expect(result.stderr).not.toContain('Connection terminated unexpectedly');
});

it.each(['api', 'worker'])('keeps graceful SIGTERM for %s and binds worker health to loopback', async role => {
  const result = await child('ready', role, true);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain('fixture closed');
  expect(result.stdout).toContain(JSON.stringify({ listening: role === 'worker' ? '127.0.0.1' : '0.0.0.0' }));
  expect(result.stderr).toBe('');
});

it('propagates a real child boot failure through the launch dispatcher', async () => {
  const plan: RolePlan = { role: 'worker', entry, singleton: false, env: { TEST_MODE: 'boot', APP_ROLE: 'worker', SESSION_SECRET: 'fixture-placeholder' } };
  const code = await runRole(plan, {
    lease: async () => ({ close: async () => {} }),
    spawn: (file, env) => spawn(process.execPath, [file], { env, stdio: 'ignore' }),
  });
  expect(code).toBe(1);
});
