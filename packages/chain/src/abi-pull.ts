import { getAddress, type Address } from 'viem';
import type { AddressRegistry } from './registry.js';
export function abiPullTargets(registry: AddressRegistry, launchpad: string): { name: string; address: Address }[] {
  if (launchpad !== 'pons') throw new Error(`No verified addresses for launchpad ${launchpad}; supply verified fragments in abi/${launchpad}/`);
  return ['factory', 'v4Hook', 'router'].map(name => ({ name, address: registry.requireAddress(`pons.${name}` as 'pons.factory' | 'pons.v4Hook' | 'pons.router') }));
}
export async function pullAbi(address: Address, apiKey: string, fetcher: typeof fetch): Promise<unknown[]> {
  const url = new URL('https://robinhoodchain.blockscout.com/api');
  url.search = new URLSearchParams({ module: 'contract', action: 'getabi', address: getAddress(address), apikey: apiKey }).toString();
  let response: Response;
  try { response = await fetcher(url, { signal: AbortSignal.timeout(15_000) }); }
  catch { throw new Error('Blockscout request failed; use the verified fragments in abi/pons/'); }
  if (!response.ok) throw new Error(`Blockscout HTTP ${response.status}; use the verified fragments in abi/pons/`);
  let payload: { status?: string; result?: string };
  try { payload = await response.json() as typeof payload; } catch { throw new Error('Blockscout returned a bot check or non-JSON response; use abi/pons/'); }
  if (payload.status !== '1' || typeof payload.result !== 'string') throw new Error('Blockscout has no verified ABI; use abi/pons/');
  const abi: unknown = JSON.parse(payload.result);
  if (!Array.isArray(abi) || !abi.every(item => item && typeof item === 'object' && 'type' in item)) throw new Error('Invalid Blockscout ABI');
  return abi;
}
