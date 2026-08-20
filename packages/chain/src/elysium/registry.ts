import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { getAddress, type Address } from 'viem';
import { parse } from 'yaml';
import { z } from 'zod';
import { ELYSIUM_CHAIN_ID } from '@eko/shared';

/**
 * Elysium address registry (packages/chain/addresses.99901.yaml). Like the Robinhood registry, addresses live in
 * exactly one file; unlike it, there are no TODO entries: an address is listed only once it has been checked live.
 */
const checksum = z.string().regex(/^0x[0-9a-fA-F]{40}$/).refine(a => getAddress(a) === a, 'Expected EIP-55 checksum').transform(a => a as Address);
const entry = z.strictObject({
  address: checksum,
  verified: z.iso.date(),
  /** code: contract code is present; token: also symbol() and decimals(); montra_registry: Montra's registry names it. */
  check: z.enum(['code', 'token', 'montra_registry']),
  source: z.string().min(1),
  decimals: z.number().int().min(0).max(255).optional(),
  symbol: z.string().min(1).optional(),
}).refine(e => e.check !== 'token' || (e.decimals !== undefined && e.symbol !== undefined), 'token entries need decimals and symbol');
const group = <K extends string>(keys: readonly K[]) => z.strictObject(Object.fromEntries(keys.map(k => [k, entry])) as Record<K, typeof entry>);

export const ElysiumRegistrySchema = z.strictObject({
  chainId: z.literal(ELYSIUM_CHAIN_ID),
  uniswapV4: group(['poolManager', 'positionManager', 'stateView', 'v4Quoter', 'universalRouter', 'universalRouter212', 'permit2']),
  tokens: group(['WHYPE', 'USDC']),
  multicall3: entry,
  montra: group(['registry', 'factory', 'hook', 'lens', 'router', 'quoteRegistry', 'token']),
  unbrandedLauncher: group(['poolManager', 'hook', 'launcher']),
  otherLaunchpads: group(['taxLaunchHook', 'bloomCoreProxy', 'imortalHyperForge', 'taxLaunchFactory']),
  flaunchFork: group(['hook', 'creatorNft']),
});
export type ElysiumRegistryData = z.infer<typeof ElysiumRegistrySchema>;
export type ElysiumEntry = z.infer<typeof entry>;
type Groups = Exclude<keyof ElysiumRegistryData, 'chainId' | 'multicall3'>;
export type ElysiumKey = 'multicall3' | { [G in Groups]: `${G}.${keyof ElysiumRegistryData[G] & string}` }[Groups];

/** The Montra registry key (bytes32 name) each montra_registry entry is read back from. */
export const MONTRA_REGISTRY_NAMES = { factory: 'factory', lens: 'lens', router: 'router', quoteRegistry: 'quoteRegistry', token: 'montra' } as const;

export class ElysiumRegistry {
  constructor(readonly data: ElysiumRegistryData) {}
  entries(): [ElysiumKey, ElysiumEntry][] {
    const out: [ElysiumKey, ElysiumEntry][] = [['multicall3', this.data.multicall3]];
    for (const [g, members] of Object.entries(this.data)) {
      if (g === 'chainId' || g === 'multicall3') continue;
      for (const [k, e] of Object.entries(members as Record<string, ElysiumEntry>)) out.push([`${g}.${k}` as ElysiumKey, e]);
    }
    return out;
  }
  entry(key: ElysiumKey): ElysiumEntry {
    if (key === 'multicall3') return this.data.multicall3;
    const [g, k] = key.split('.') as [Groups, string];
    const found = (this.data[g] as Record<string, ElysiumEntry>)[k];
    if (!found) throw new Error(`Unknown Elysium registry key: ${key}`);
    return found;
  }
  address(key: ElysiumKey): Address { return this.entry(key).address; }
  /** The registry key an address is listed under, if any (case-insensitive). */
  keyOf(address: string): ElysiumKey | null {
    const lower = address.toLowerCase();
    return this.entries().find(([, e]) => e.address.toLowerCase() === lower)?.[0] ?? null;
  }
}
export function parseElysiumRegistry(text: string): ElysiumRegistry {
  return new ElysiumRegistry(ElysiumRegistrySchema.parse(parse(text)));
}
export function loadElysiumRegistry(path?: string): ElysiumRegistry {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  return parseElysiumRegistry(readFileSync(path ?? resolve(root, 'packages/chain/addresses.99901.yaml'), 'utf8'));
}
