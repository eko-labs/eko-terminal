import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
const scriptUrl = new URL('../../../scripts/check-addresses.mjs', import.meta.url).href;
const { addressViolations, sourceFiles, rpcTransportViolations } = await import(scriptUrl) as {
  rpcTransportViolations(files: { path: string; text: string }[]): string[];
  addressViolations(files: { path: string; text: string }[], registry: string): string[];
  sourceFiles(dir: string, base?: string): { path: string; text: string }[];
};
const registry = readFileSync(new URL('../addresses.4663.yaml', import.meta.url), 'utf8');
describe('check:addresses', () => {
  it('allows registry entries case-insensitively, zero and dead; rejects other full literals with file and line', () => {
    const text = ['0x0bd7d308f8e1639fab988df18a8011f41eacad73', `0x${'0'.repeat(40)}`, `0x${'0'.repeat(36)}dEaD`, '0x1111111111111111111111111111111111111111'].join('\n');
    expect(addressViolations([{ path: 'packages/example/src/a.ts', text }], registry)).toEqual(['packages/example/src/a.ts:4: 0x1111111111111111111111111111111111111111 is outside the registry']);
    expect(addressViolations([{ path: 'packages/shared/src/networks.ts', text: '0x1111111111111111111111111111111111111111' }], registry)).toHaveLength(1);
  });
  it('does not mistake selectors, truncated hints, topics, storage slots or transaction hashes for addresses', () => {
    const text = [`0x${'a'.repeat(64)}`, '0x8366a39c…0951', '0x12345678'].join('\n');
    expect(addressViolations([{ path: 'packages/example/src/a.ts', text }], registry)).toEqual([]);
  });
  it('rejects raw HTTP/WS transports outside the centralized RPC wrapper', () => {
    const files = [
      { path: 'apps/example/src/client.ts', text: "import { createPublicClient, http as raw } from 'viem'; createPublicClient({ transport: raw(env.RPC_HTTP_URL) });" },
      { path: 'apps/example/src/socket.ts', text: "import { webSocket } from 'viem';" },
      { path: 'packages/chain/src/rpc/metered.ts', text: "import { http, webSocket } from 'viem';" },
      { path: 'packages/chain/src/rpc/clients.ts', text: "import { createPublicClient } from 'viem';" },
    ];
    expect(rpcTransportViolations(files)).toEqual([
      'apps/example/src/client.ts: raw viem transport bypasses the RPC spend guard',
      'apps/example/src/socket.ts: raw viem transport bypasses the RPC spend guard',
    ]);
  });
  it('scans source files and excludes tests, fixtures, mocks and docs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eko-address-scan-'));
    try {
      for (const file of ['src/index.ts', 'src/deep/source.ts', 'src/check.test.ts', 'src/a.spec.ts', 'src/a.mock.ts', 'src/a.fixture.json', 'src/test/a.ts', 'src/__tests__/a.ts', 'src/fixtures/a.json', 'src/mocks/a.ts', 'src/docs/a.ts']) {
        const path = join(dir, file); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, '0x1111111111111111111111111111111111111111');
      }
      const files = sourceFiles(join(dir, 'src'), dir);
      expect(files.map(f => f.path).sort()).toEqual(['src/deep/source.ts', 'src/index.ts']);
      expect(addressViolations(files, registry)).toHaveLength(2);
    } finally { rmSync(dir, { recursive: true }); }
  });
});
