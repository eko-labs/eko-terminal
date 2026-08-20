import { getAddress, parseAbi, stringToHex, type Address, type Hex } from 'viem';
import { ELYSIUM_CHAIN_ID } from '@eko/shared';
import { MONTRA_REGISTRY_NAMES, type ElysiumKey, type ElysiumRegistry } from './registry.js';

/** The reads the verifier needs; a viem PublicClient satisfies it, and tests pass a mock. */
export interface ElysiumVerifyClient {
  getChainId(): Promise<number>;
  getCode(input: { address: Address }): Promise<Hex | undefined>;
  readContract(input: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }): Promise<unknown>;
}
export interface VerifyRow { entry: ElysiumKey | 'chain'; check: string; ok: boolean; detail: string }
export interface VerifyReport { rows: VerifyRow[]; ok: boolean }

const erc20Abi = parseAbi(['function symbol() view returns (string)', 'function decimals() view returns (uint8)']);
export const montraRegistryAbi = parseAbi([
  'function get(bytes32 key) view returns (address)',
  'function hooks() view returns (address[])',
  'function isKnownHook(address hook) view returns (bool)',
]);

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).split('\n')[0]!.slice(0, 160);

/**
 * Checks every registry entry against the live chain: the chain ID, contract code at each address, token symbol and
 * decimals, and that Montra's own on-chain registry names the factory, hook and periphery we list. Read-only.
 */
export async function verifyElysium(registry: ElysiumRegistry, client: ElysiumVerifyClient, opts: { signal?: AbortSignal } = {}): Promise<VerifyReport> {
  const rows: VerifyRow[] = [];
  const push = (row: VerifyRow) => rows.push(row);
  const chainId = await client.getChainId();
  push({ entry: 'chain', check: 'chain_id', ok: chainId === ELYSIUM_CHAIN_ID, detail: `eth_chainId ${chainId}, expected ${ELYSIUM_CHAIN_ID}` });
  if (chainId !== ELYSIUM_CHAIN_ID) return { rows, ok: false };

  for (const [key, e] of registry.entries()) {
    if (opts.signal?.aborted) throw new Error('Verification aborted');
    try {
      const code = await client.getCode({ address: e.address });
      const bytes = code && code !== '0x' ? (code.length - 2) / 2 : 0;
      push({ entry: key, check: 'code', ok: bytes > 0, detail: bytes > 0 ? `${bytes} bytes` : 'no contract code' });
      if (bytes === 0) continue;
      if (e.check === 'token') {
        const symbol = await client.readContract({ address: e.address, abi: erc20Abi, functionName: 'symbol' }) as string;
        const decimals = Number(await client.readContract({ address: e.address, abi: erc20Abi, functionName: 'decimals' }));
        const ok = symbol === e.symbol && decimals === e.decimals;
        push({ entry: key, check: 'token', ok, detail: `${symbol}/${decimals}, expected ${e.symbol}/${e.decimals}` });
      }
    } catch (error) { push({ entry: key, check: 'code', ok: false, detail: message(error) }); }
  }

  // Montra's registry is the source of truth for its own addresses.
  const montra = registry.address('montra.registry');
  for (const [field, name] of Object.entries(MONTRA_REGISTRY_NAMES) as [keyof typeof MONTRA_REGISTRY_NAMES, string][]) {
    const key = `montra.${field}` as ElysiumKey;
    try {
      const named = await client.readContract({ address: montra, abi: montraRegistryAbi, functionName: 'get', args: [stringToHex(name, { size: 32 })] }) as Address;
      const listed = registry.address(key);
      push({ entry: key, check: 'montra_registry', ok: same(named, listed), detail: `registry get("${name}") = ${getAddress(named)}` });
    } catch (error) { push({ entry: key, check: 'montra_registry', ok: false, detail: message(error) }); }
  }
  try {
    const hook = registry.address('montra.hook');
    const known = await client.readContract({ address: montra, abi: montraRegistryAbi, functionName: 'isKnownHook', args: [hook] }) as boolean;
    push({ entry: 'montra.hook', check: 'montra_registry', ok: known === true, detail: known ? 'isKnownHook = true' : 'isKnownHook = false' });
  } catch (error) { push({ entry: 'montra.hook', check: 'montra_registry', ok: false, detail: message(error) }); }

  return { rows, ok: rows.every(r => r.ok) };
}
