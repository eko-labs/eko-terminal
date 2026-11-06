import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = `${root}apps/web/e2e/.artifacts/tmp`;
mkdirSync(temporary, { recursive: true });
const env = { ...process.env, TMPDIR: temporary, E2E_WEB_PORT: '5491', E2E_API_PORT: '8991', EKO_PERFORMANCE: '1', PW_CHANNEL: 'chrome' };
// The budget gate always builds and writes its evidence, including on budget failure.
const budget = spawnSync(process.execPath, ['scripts/check-web-budgets.mjs'], { cwd: root, env, stdio: 'inherit' });
if (budget.status !== 0 && budget.status !== 1) { console.error('Web build failed; no measurement evidence accepted.'); process.exit(2); }
const measurement = spawnSync('pnpm', ['--filter', '@eko/web', 'exec', 'playwright', 'test', '--config', 'playwright.config.ts', '--project=desktop', 'performance.spec.ts'], { cwd: root, env, stdio: 'inherit' });
console.log(`Build budget exit=${budget.status}; measurement exit=${measurement.status}`);
process.exitCode = budget.status || measurement.status || 0;
