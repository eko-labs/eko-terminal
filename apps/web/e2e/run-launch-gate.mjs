import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// Local-only gate runner. Logs and checkpoint stay inside the worktree, with neutral paths.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const output = join(root, 'apps/web/e2e/.artifacts/gate-129');
await mkdir(output, { recursive: true });
await mkdir(join(output, 'tmp'), { recursive: true });
const neutral = text => text.replaceAll(root.replace(/\/$/, ''), '<worktree>').replaceAll(homedir(), '<home>');
const env = { ...process.env, EKO_SITE: join(root, 'apps/web/e2e/.artifacts/site-unavailable'), TMPDIR: join(output, 'tmp'), E2E_WEB_PORT: '5591', E2E_API_PORT: '9091', E2E_MAINNET_RPC: 'http://127.0.0.1:9', E2E_LIVE: 'false' };
const browserFinal = process.argv[2] === '--browser-final';
const desktopFocus = process.argv[2] === '--desktop';
const focused = browserFinal ? [] : process.argv.slice(desktopFocus ? 3 : 2);
const commands = browserFinal ? [['playwright-final', ['--filter', '@eko/web', 'e2e', '--project=desktop', '--project=mobile']],
  ['typecheck-final', ['typecheck']], ['web-test-final', ['--filter', '@eko/web', 'test']], ['checks-final', ['test:checks']]]
  : focused.length ? [[`focused-${Date.now()}`, ['--filter', '@eko/web', 'e2e', desktopFocus ? '--project=desktop' : '--project=mobile', '--grep', focused.join(' ')]]]
  : [['playwright', ['--filter', '@eko/web', 'e2e', '--project=desktop', '--project=mobile']],
    ['typecheck', ['typecheck']], ['web-test', ['--filter', '@eko/web', 'test']], ['checks', ['test:checks']],
    ['test', ['test']], ['brand', ['brand:check']], ['addresses', ['check:addresses']]];
const checkpoint = { candidate: process.env.E2E_CANDIDATE_REVISION ?? 'unspecified', startedAt: new Date().toISOString(),
  ports: { web: 5591, api: 9091 }, fork: 'PENDING: no archive RPC or fork host; acceptance blocked', commands: [] };
const sources = ['apps/web/src/App.tsx', 'apps/web/src/main.tsx', 'apps/web/src/lib/mainFocus.ts', 'apps/web/src/lib/mainFocus.test.ts',
  'apps/web/src/components/shell/Shell.tsx', 'apps/web/src/components/SkipLink.tsx', 'apps/web/src/pages/scan/Landing.tsx', 'apps/web/src/pages/scan/scan.test.tsx',
  'apps/web/src/styles/shell.css', 'apps/web/src/pages/terminal/radar.css', 'apps/web/e2e/launch-helpers.ts',
  'apps/web/e2e/helpers.ts', 'apps/web/e2e/launch-matrix.ts', 'apps/web/e2e/launch-matrix.spec.ts', 'apps/web/e2e/launch-matrix-mobile.spec.ts',
  'apps/server/test/read-e2e-server.ts', 'apps/server/test/launch-e2e-fixture.ts', 'apps/web/e2e/launch-gate.spec.ts',
  'apps/web/e2e/mission-screens.spec.ts', 'apps/web/e2e/mockWallet.ts', 'apps/web/e2e/guarded-trade.spec.ts', 'apps/web/playwright.config.ts', 'apps/web/e2e/run-launch-gate.mjs'];
checkpoint.sourceSha256 = Object.fromEntries(await Promise.all(sources.map(async path => [path, createHash('sha256').update(await readFile(join(root, path))).digest('hex')])));
for (const [name, args] of commands) {
  const step = { name, command: ['pnpm', ...args], startedAt: new Date().toISOString(), log: `apps/web/e2e/.artifacts/gate-129/${name}.log`, pid: null, exitCode: null };
  checkpoint.commands.push(step);
  const child = spawn('pnpm', args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  step.pid = child.pid;
  await writeFile(join(output, 'checkpoint.json'), JSON.stringify(checkpoint, null, 2));
  const chunks = [];
  let logWrites = Promise.resolve();
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
    chunks.push(chunk.toString());
    // Sanitize the accumulated text so a path split across stream chunks stays neutral.
    const content = neutral(chunks.join(''));
    logWrites = logWrites.then(() => writeFile(join(root, step.log), content));
  });
  step.exitCode = await new Promise(resolve => { child.on('error', error => { chunks.push(error.message); resolve(1); }); child.on('close', code => resolve(code ?? 1)); });
  step.finishedAt = new Date().toISOString();
  await logWrites;
  await writeFile(join(root, step.log), neutral(chunks.join('')));
  await writeFile(join(output, 'checkpoint.json'), JSON.stringify(checkpoint, null, 2));
  console.log(`${name}: exit ${step.exitCode}; ${step.log}`);
  // Continue independent unit/type/consistency checks after a browser failure, never call it acceptance.
}
checkpoint.finishedAt = new Date().toISOString();
await writeFile(join(output, `checkpoint-${checkpoint.startedAt.replaceAll(':', '-').replaceAll('.', '-')}.json`), JSON.stringify(checkpoint, null, 2));
await writeFile(join(output, 'checkpoint.json'), JSON.stringify(checkpoint, null, 2));
process.exitCode = checkpoint.commands.some(step => step.exitCode !== 0) ? 1 : 0;
