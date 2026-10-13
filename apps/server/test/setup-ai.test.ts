import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// scripts/setup-ai.mjs is plain ESM; import it by path so TypeScript treats it as untyped.
const scriptPath = resolve(__dirname, '../../../scripts/setup-ai.mjs');
const mod = (await import(scriptPath)) as { saveKey(p: string, k: string, b?: string): Promise<void>; validKey(k: string): boolean };

const dir = await mkdtemp(join(tmpdir(), 'eko-setup-ai-'));
afterAll(() => rm(dir, { recursive: true, force: true }));

describe('pnpm setup:ai', () => {
  it('writes the gateway key atomically with mode 0600, keeping other settings and replacing old keys', async () => {
    const env = join(dir, '.env');
    await writeFile(env, 'LIVE_TRADING_ENABLED=false\nGATEWAY_API_KEY=old-key-000000\nexport GATEWAY_BASE_URL=https://old.example\nAI_DAILY_BUDGET_USD=3\n');
    await mod.saveKey(env, 'test_key-1234567890');
    const text = await readFile(env, 'utf8');
    expect(text).toBe('LIVE_TRADING_ENABLED=false\nAI_DAILY_BUDGET_USD=3\nGATEWAY_BASE_URL=https://api.ppq.ai\nGATEWAY_API_KEY=test_key-1234567890\n');
    expect((await stat(env)).mode & 0o777).toBe(0o600);
    await mod.saveKey(env, 'test_key-abcdefghij');
    expect((await readFile(env, 'utf8')).match(/GATEWAY_API_KEY=/g)).toHaveLength(1);
  });

  it('creates the file when missing and refuses malformed keys', async () => {
    const env = join(dir, 'fresh.env');
    await mod.saveKey(env, 'another_test_key_42');
    expect(await readFile(env, 'utf8')).toBe('GATEWAY_BASE_URL=https://api.ppq.ai\nGATEWAY_API_KEY=another_test_key_42\n');
    expect(mod.validKey('short')).toBe(false);
    expect(mod.validKey('has spaces in it here')).toBe(false);
    await expect(mod.saveKey(env, 'bad key with spaces')).rejects.toThrow('invalid_key');
  });
});
