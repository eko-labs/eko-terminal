import { keccak256, toHex, toFunctionSelector, type Hex } from 'viem';
import type { ControlClients, ControlRecipe, ControlInspection } from '../src/control/types.js';
import type { AnvilRpc } from '../src/simulation/types.js';
import { CONTROL_SLOTS } from '../src/control/collector.js';
import { address, hash, cursor } from './reference-fixtures.js';
export { address, hash, cursor };
export const coin = address(10), owner = address(20), impl = address(30), beacon = address(40), timelock = address(50);
export const selector = toFunctionSelector('setSellTax(uint256)');
export const runtime: Hex = `0x63${selector.slice(2)}1460005700`;
export const storageWord = (a: string) => `0x${a.slice(2).padStart(64, '0')}` as Hex;
export function archiveFixture(options: { proxy?: 'eip1967' | 'beacon' | 'clone'; implementation?: string; inert?: boolean; role?: boolean; noOwner?: boolean; runtime?: Hex; roleContract?: boolean; cycle?: boolean } = {}) {
  const calls: { method: string; params: readonly unknown[] }[] = [];
  const currentImpl = options.implementation ?? impl;
  const code = (a: string) => a === coin ? options.proxy === 'clone' ? `0x363d3d373d3d3d363d73${currentImpl.slice(2)}5af43d82803e903d91602b57fd5bf3` : options.proxy ? '0x600000' : options.runtime ?? runtime : a === currentImpl ? options.runtime ?? runtime : a === beacon || a === timelock ? '0x600000' : '0x';
  const request = async (r: { method: string; params: readonly unknown[] }) => {
    calls.push(r);
    if (r.method === 'eth_chainId') return toHex(BigInt(cursor.chainId));
    if (r.method === 'eth_getBlockByNumber') return { hash: cursor.blockHash, number: toHex(BigInt(cursor.blockNumber)), timestamp: toHex(BigInt(cursor.timestampSec)) };
    if (r.method === 'eth_getCode') return code(r.params[0] as string);
    if (r.method === 'eth_getStorageAt') {
      const [target, slot] = r.params;
      if (target === currentImpl && options.cycle && slot === CONTROL_SLOTS.implementation) return storageWord(coin);
      if (target === coin && slot === CONTROL_SLOTS.implementation && options.proxy === 'eip1967') return storageWord(currentImpl);
      if (target === coin && slot === CONTROL_SLOTS.beacon && options.proxy === 'beacon') return storageWord(beacon);
      return toHex(0n, { size: 32 });
    }
    if (r.method === 'eth_call') {
      const tx = r.params[0] as { to: string; data: string };
      if (tx.to === beacon && tx.data === toFunctionSelector('implementation()')) return storageWord(currentImpl);
      if (tx.data === toFunctionSelector('owner()') || tx.data === toFunctionSelector('getOwner()')) {
        if (options.noOwner) throw new Error('No getter fixture');
        return storageWord(tx.to === timelock ? owner : options.inert ? address(0) : options.roleContract ? timelock : owner);
      }
      if (tx.data.startsWith(toFunctionSelector('getRoleMemberCount(bytes32)'))) return toHex(options.role ? 1n : 0n, { size: 32 });
      if (tx.data.startsWith(toFunctionSelector('getRoleMember(bytes32,uint256)'))) return storageWord(owner);
      if (tx.data.startsWith(toFunctionSelector('hasRole(bytes32,address)'))) return toHex(1n, { size: 32 });
      return toHex(5n, { size: 32 });
    }
    throw new Error('Unexpected fixture read');
  };
  return { clients: { archive: { request } } as unknown as ControlClients, calls, code };
}
export const recipeFor = (s: ControlInspection, changes: Partial<ControlRecipe> = {}): ControlRecipe => ({
  capability: 'tax_raise', implementationHash: s.implementationHash!, configurationHash: s.configurationHash,
  authority: owner, authorityTarget: coin, caller: owner, selector,
  execute: { target: coin, data: `${selector}${toHex(99n, { size: 32 }).slice(2)}`, value: '0' }, queue: null, delaySec: 0,
  read: { kind: 'call', target: coin, data: toFunctionSelector('sellTax()') }, effect: 'uint_increase', reviewEvidenceIds: [hash('synthetic-review')], ...changes,
});
export function forkFixture(s: ControlInspection, options: { noOp?: boolean; revert?: boolean; delay?: number; earlySucceeds?: boolean; providerFailure?: boolean; upgrade?: boolean } = {}) {
  let value = options.upgrade ? BigInt(impl) : 5n, seconds = Number(cursor.timestampSec), txStatus = '0x1', resets = 0, transactions = 0;
  const calls: { method: string; params: readonly unknown[] }[] = [];
  const rpc: AnvilRpc = { request: async r => {
    calls.push(r);
    if (options.providerFailure) throw new Error('Fixture provider failure');
    if (r.method === 'eth_getBlockByNumber') return { hash: cursor.blockHash, timestamp: toHex(BigInt(seconds)) };
    if (r.method === 'eth_chainId') return toHex(BigInt(cursor.chainId));
    if (r.method === 'eth_getCode') {
      if (options.upgrade && r.params[0] === address(90)) return '0x600100';
      if (s.path.some(p => p.address === r.params[0])) return options.upgrade ? `0x63${toFunctionSelector('upgradeTo(address)').slice(2)}00` : runtime;
      return '0x';
    }
    if (r.method === 'eth_call' || r.method === 'eth_getStorageAt') return toHex(value, { size: 32 });
    if (r.method === 'eth_sendTransaction') {
      transactions++;
      const tx = r.params[0] as { to: string; data: string };
      const queue = tx.to === timelock && !tx.data.startsWith(selector);
      txStatus = options.revert || !queue && seconds < Number(cursor.timestampSec) + (options.delay ?? 0) && !options.earlySucceeds ? '0x0' : '0x1';
      if (!queue && txStatus === '0x1' && !options.noOp) value = options.upgrade ? BigInt(address(90)) : 99n;
      return hash(`synthetic-tx-${transactions}`);
    }
    if (r.method === 'eth_getTransactionReceipt') return { status: txStatus, blockNumber: '0x65' };
    if (r.method === 'debug_traceTransaction') return { type: 'CALL', fixture: true };
    if (r.method === 'evm_increaseTime') { seconds += Number(r.params[0]); return seconds; }
    if (['evm_mine', 'anvil_setBalance', 'anvil_impersonateAccount', 'anvil_stopImpersonatingAccount'].includes(r.method)) return null;
    throw new Error('Unexpected fixture fork call');
  } };
  const reset = async () => { resets++; value = options.upgrade ? BigInt(impl) : 5n; seconds = Number(cursor.timestampSec); };
  return { rpc, reset, calls, resets: () => resets, transactions: () => transactions };
}
