import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAddress } from 'viem';
import { loadRegistry, parseRegistry } from '../src/registry.js';
import codes from './fixtures/4663/registry-code.json' with { type: 'json' };
const yaml = readFileSync(new URL('../addresses.4663.yaml', import.meta.url), 'utf8');
afterEach(() => vi.unstubAllEnvs());
describe('registry', () => {
  it('loads all 17 captured deployments in checksum form, preserving TODO/null and stage requirements', () => {
    const registry = parseRegistry(yaml);
    const addresses = registry.entries().filter(([, e]) => e.address !== 'TODO').map(([, e]) => e.address);
    expect(addresses).toHaveLength(17);
    expect(addresses).toEqual(expect.arrayContaining(Object.values(codes.codes).map(e => getAddress(e.address))));
    expect(registry.addressOf('ours.burnWallet')).toBeNull();
    expect(registry.data.ours.burnWallet.required_for).toBe('D0');
    expect(registry.entries().filter(([, e]) => e.required_for === 'T')).toHaveLength(8);
    expect(registry.entries().filter(([, e]) => e.required_for === 'T').every(([, e]) => e.address !== 'TODO')).toBe(true);
    expect(() => registry.requireAddress('ours.burnWallet')).toThrow('TODO');
    // @ts-expect-error Registry keys are checked at compile time.
    expect(() => registry.addressOf('pons.typo')).toThrow('Unknown registry key');
  });
  it.each([
    ['wrong chain', yaml.replace('chainId: 4663', 'chainId: 1')],
    ['non-checksum', yaml.replace(codes.codes.WETH.address, codes.codes.WETH.address.toLowerCase())],
    ['short address', yaml.replace(codes.codes.WETH.address, '0x1234')],
    ['invalid decimals', yaml.replace('decimals: 18', 'decimals: 256')],
    ['root key', `${yaml}\nunexpected: TODO`],
    ['nested key', yaml.replace('  quoterV2:', '  typo:')],
    ['entry key', yaml.replace('decimals: 18', 'decimals: 18, typo: true')],
    ['owner checksum', yaml.replace('owner: TODO', 'owner: "0x1234"')],
    ['committer checksum', yaml.replace('committer: TODO', 'committer: "0x1234"')],
    ['record outside release', yaml.replace('contracts/release/ReceiptsRegistry.build.json', '../some-record.json')],
    ['malformed YAML', 'chainId: ['],
    ['duplicate YAML key', `${yaml}\nchainId: 4663`],
  ])('rejects %s', (_name, text) => expect(() => parseRegistry(text)).toThrow());
  it('loads explicit files, ADDRESSES_FILE and the package default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eko-registry-'));
    try {
      const path = join(dir, 'registry.yaml'); writeFileSync(path, yaml);
      expect(loadRegistry(path).data.chainId).toBe(4663);
      vi.stubEnv('ADDRESSES_FILE', path); expect(loadRegistry().data.chainId).toBe(4663);
      vi.stubEnv('ADDRESSES_FILE', ''); expect(loadRegistry().data.chainId).toBe(4663);
      writeFileSync(path, 'chainId: invalid'); expect(() => loadRegistry(path)).toThrow();
    } finally { rmSync(dir, { recursive: true }); }
  });
});
