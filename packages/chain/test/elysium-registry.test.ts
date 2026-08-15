import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getAddress, stringToHex, type Address } from 'viem';
import { ELYSIUM_CHAIN_ID } from '@eko/shared';
import { loadElysiumRegistry, parseElysiumRegistry, type ElysiumKey } from '../src/elysium/registry.js';
import { verifyElysium, type ElysiumVerifyClient } from '../src/elysium/verify.js';

const yamlPath = fileURLToPath(new URL('../addresses.99901.yaml', import.meta.url));
const text = readFileSync(yamlPath, 'utf8');
const registry = loadElysiumRegistry();

describe('Elysium registry', () => {
  it('loads every entry as a checksummed address with a source and a live-check date', () => {
    const entries = registry.entries();
    expect(registry.data.chainId).toBe(ELYSIUM_CHAIN_ID);
    expect(entries.length).toBe(26);
    for (const [, e] of entries) { expect(getAddress(e.address)).toBe(e.address); expect(e.source.length).toBeGreaterThan(0); }
    expect(new Set(entries.map(([, e]) => e.address.toLowerCase())).size).toBe(entries.length);
  });
  it('resolves keys both ways and keeps the unofficial pool manager apart from Uniswap\'s', () => {
    expect(registry.keyOf(registry.address('montra.hook').toLowerCase())).toBe('montra.hook');
    expect(registry.address('uniswapV4.poolManager')).not.toBe(registry.address('unbrandedLauncher.poolManager'));
    expect(registry.keyOf('0x0000000000000000000000000000000000000001')).toBeNull();
    expect(() => registry.entry('montra.nope' as ElysiumKey)).toThrow(/Unknown/);
  });
  it('rejects a wrong chain, a bad checksum, an unknown key and a token entry without decimals', () => {
    expect(() => parseElysiumRegistry(text.replace('chainId: 99901', 'chainId: 4663'))).toThrow();
    expect(() => parseElysiumRegistry(text.replace('0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1', '0xe2e105d3f7209a9da11f83ccf3e7398a753823F2'))).toThrow();
    expect(() => parseElysiumRegistry(`${text}\nsurprise: 1\n`)).toThrow();
    expect(() => parseElysiumRegistry(text.replace('decimals: 6, ', ''))).toThrow(/decimals/);
  });
});

/** A chain that agrees with the registry, with one switch per way it can disagree. */
function mockChain(over: { chainId?: number; noCode?: Address; symbol?: string; montraFactory?: Address; knownHook?: boolean } = {}): ElysiumVerifyClient {
  const montraNames: Record<string, Address> = {
    factory: over.montraFactory ?? registry.address('montra.factory'), lens: registry.address('montra.lens'), router: registry.address('montra.router'),
    quoteRegistry: registry.address('montra.quoteRegistry'), montra: registry.address('montra.token'),
  };
  const byKey = new Map(Object.entries(montraNames).map(([name, a]) => [stringToHex(name, { size: 32 }), a]));
  return {
    getChainId: async () => over.chainId ?? ELYSIUM_CHAIN_ID,
    getCode: async ({ address }) => address === over.noCode ? '0x' : '0x6080',
    readContract: async ({ address, functionName, args }) => {
      if (functionName === 'symbol') return over.symbol && address === registry.address('tokens.USDC') ? over.symbol : registry.entry(registry.keyOf(address)!).symbol;
      if (functionName === 'decimals') return registry.entry(registry.keyOf(address)!).decimals;
      if (functionName === 'get') return byKey.get(args![0] as `0x${string}`) ?? '0x0000000000000000000000000000000000000000';
      if (functionName === 'isKnownHook') return over.knownHook ?? true;
      throw new Error(`unexpected ${functionName}`);
    },
  };
}

describe('verify:elysium', () => {
  it('passes when the chain agrees with every entry', async () => {
    const report = await verifyElysium(registry, mockChain());
    expect(report.rows.filter(r => !r.ok)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.rows.filter(r => r.check === 'token')).toHaveLength(2);
    expect(report.rows.filter(r => r.check === 'montra_registry')).toHaveLength(6);
  });
  it('stops at a wrong chain before reading any address', async () => {
    const report = await verifyElysium(registry, mockChain({ chainId: 4663 }));
    expect(report).toEqual({ ok: false, rows: [{ entry: 'chain', check: 'chain_id', ok: false, detail: `eth_chainId 4663, expected ${ELYSIUM_CHAIN_ID}` }] });
  });
  it.each([
    ['missing code', { noCode: registry.address('uniswapV4.permit2') }, 'uniswapV4.permit2', 'code'],
    ['a look-alike token', { symbol: 'USDC.e' }, 'tokens.USDC', 'token'],
    ['Montra naming another factory', { montraFactory: registry.address('montra.router') }, 'montra.factory', 'montra_registry'],
    ['an unannounced hook', { knownHook: false }, 'montra.hook', 'montra_registry'],
  ] as const)('fails on %s', async (_name, over, entry, check) => {
    const report = await verifyElysium(registry, mockChain(over));
    expect(report.ok).toBe(false);
    expect(report.rows.filter(r => !r.ok).map(r => [r.entry, r.check])).toEqual([[entry, check]]);
  });
});
