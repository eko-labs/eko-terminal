import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

async function cliFixture(mode: 'budget' | 'daily-budget' | 'unreachable' | 'SIGINT' | 'SIGTERM') {
  const child = spawn(process.execPath, [
    '--import', 'tsx', '--import', './test/fixtures/verify-cli/register.mjs', 'src/verify-cli.ts', '--prelaunch',
  ], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: { PATH: process.env.PATH, EKO_VERIFY_TEST_CASE: mode },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '', sentSignal = false;
  child.stdout.on('data', data => {
    output += data;
    if (!sentSignal && (mode === 'SIGINT' || mode === 'SIGTERM') && output.includes('mock RPC pending')) {
      sentSignal = true;
      child.kill(mode);
    }
  });
  child.stderr.on('data', data => { output += data; });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<{ code: number | null; signal: string | null; output: string }>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code, signal) => resolve({ code, signal, output }));
      timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Verifier CLI did not finish: ${mode}`)); }, 10_000);
    });
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

describe('verifier CLI with injected mock RPC', () => {
  it.each(['budget', 'daily-budget', 'unreachable', 'SIGINT', 'SIGTERM'] as const)('exits non-zero on %s', async mode => {
    const result = await cliFixture(mode);
    expect(result.code).toBe(1);
    expect(result.signal).toBeNull();
    expect(result.output).toContain('verify:chain failed');
    if (mode === 'SIGINT' || mode === 'SIGTERM') expect(result.output).toContain('Verification incomplete');
  });
});
