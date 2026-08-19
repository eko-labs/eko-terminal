import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { getAddress, type Address } from 'viem';
import { parse } from 'yaml';
import { z } from 'zod';
import { CHAIN_ID } from '@eko/shared';

const checksum = z.string().regex(/^0x[0-9a-fA-F]{40}$/).refine(a => /^0x[0-9a-fA-F]{40}$/.test(a) && getAddress(a) === a, 'Expected EIP-55 checksum').transform(a => a as Address);
const entryObject = z.strictObject({
    address: z.union([checksum, z.literal('TODO')]),
    decimals: z.number().int().min(0).max(255).optional(),
    verified: z.iso.date().optional(),
    check: z.enum(['code', 'router02_wiring', 'VERIFY', 'VERIFY_ABI']).optional(),
    required_for: z.enum(['T', 'D0']).optional(),
    owner: z.union([checksum, z.literal('TODO')]).optional(),
    committer: z.union([checksum, z.literal('TODO')]).optional(),
    build_record: z.union([z.string().regex(/^contracts\/release\/[A-Za-z0-9_-]+\.build\.json$/), z.literal('TODO')]).optional(),
    hint: z.string().optional(), source: z.string().optional(),
});
const entry = z.union([entryObject, z.literal('TODO').transform((): z.infer<typeof entryObject> => ({ address: 'TODO' }))]);
const group = <K extends string>(keys: readonly K[]) => z.strictObject(Object.fromEntries(keys.map(k => [k, entry])) as Record<K, typeof entry>);
export const RegistrySchema = z.strictObject({
  chainId: z.literal(CHAIN_ID),
  uniswapV3: group(['factory', 'quoterV2', 'swapRouter02']),
  tokens: group(['WETH', 'USDG', 'USDC_bridged']),
  multicall3: entry,
  uniswapV4: group(['poolManager', 'v4Quoter', 'universalRouter', 'permit2']),
  erc8004: group(['identityRegistry', 'reputationRegistry']),
  pons: group(['v4Hook', 'factory', 'router']),
  virtuals: group(['VIRTUAL', 'bondingCurve']),
  entryPoints: group(['v06', 'v07', 'v08']),
  fingerprints: z.strictObject({ unknownRouters: z.tuple([entry, entry]), orbioCreditExchange: entry }),
  ours: group(['receiptsRegistry', 'burnWallet', 'devWallet', 'burnEngine', 'burnVenue', 'ponsFeeRouter', 'milestoneLockFactory', 'guardedExecutor', 'ponsTargetRegistry']),
  offTheShelf: group(['safeSingleton', 'safeProxyFactory', 'zodiacRolesV2Mastercopy', 'moduleProxyFactory']),
});
export type RegistryData = z.infer<typeof RegistrySchema>;
export type RegistryEntry = z.infer<typeof entry>;
type Groups = Exclude<keyof RegistryData, 'chainId' | 'multicall3' | 'fingerprints'>;
export type RegistryKey = 'multicall3' | 'fingerprints.orbioCreditExchange' | 'fingerprints.unknownRouters.0' | 'fingerprints.unknownRouters.1' | {
  [G in Groups]: `${G}.${keyof RegistryData[G] & string}`
}[Groups];

export class AddressRegistry {
  constructor(readonly data: RegistryData) {}
  entries(): [RegistryKey, RegistryEntry][] {
    const entries: [RegistryKey, RegistryEntry][] = [];
    const visit = (value: unknown, path: string) => {
      if (!value || typeof value !== 'object') return;
      if ('address' in value) { entries.push([path as RegistryKey, value as RegistryEntry]); return; }
      for (const [key, child] of Object.entries(value)) visit(child, path ? `${path}.${key}` : key);
    };
    visit(this.data, '');
    return entries;
  }
  /**
   * The key's path is followed down the data. It used to list every entry of the registry and search the list, on each
   * call; the indexer asks several times per log, and that listing was 6% of its CPU in a burst on 2026-10-13.
   */
  addressOf(key: RegistryKey): Address | null {
    let node: unknown = this.data;
    for (const part of key.split('.')) node = node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined;
    if (!node || typeof node !== 'object' || !('address' in node)) throw new Error(`Unknown registry key: ${key}`);
    const address = (node as RegistryEntry).address;
    return address === 'TODO' ? null : address;
  }
  requireAddress(key: RegistryKey): Address {
    const address = this.addressOf(key);
    if (!address) throw new Error(`Registry address is TODO: ${key}`);
    return address;
  }
}
export function parseRegistry(text: string): AddressRegistry {
  return new AddressRegistry(RegistrySchema.parse(parse(text)));
}
export function loadRegistry(path?: string): AddressRegistry {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const defaultPath = process.env.ADDRESSES_FILE
    ? resolve(root, process.env.ADDRESSES_FILE)
    : resolve(root, 'packages/chain/addresses.4663.yaml');
  return parseRegistry(readFileSync(path ?? defaultPath, 'utf8'));
}
