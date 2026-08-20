import { toFunctionSelector, toHex, keccak256, type Hex } from 'viem';
import { AddressSchema, GuardCursorSchema } from '@eko/shared';
import type { Address, GuardCursor } from '@eko/shared';
import { referenceDigest } from '../simulation/reference.js';
import { rpcStopReason } from '../rpc/metered.js';
import { CONTROL_METHOD_VERSION, ControlInspectionSchema, ControlReadSchema, controlBytes } from './types.js';
import type { ControlClients, ControlInspection, ControlRead } from './types.js';

export const CONTROL_SLOTS = {
  implementation: '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',
  beacon: '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50',
  admin: '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103',
} as const;
class ControlBudgetError extends Error {}
const zero = `0x${'0'.repeat(64)}` as Hex;
/**
 * Recognize only the zero and dead addresses as inert authority hints. Pure predicate; this does
 * not prove absence of other controllers.
 */
export const inertAuthority = (a: string) => /^0x0{40}$/.test(a) || /^0x0{36}dead$/i.test(a);
/**
 * Decode an ABI word with twelve leading zero bytes into a lowercase address, or return null for
 * malformed/non-address words. Pure decoding; no chain read or authority acceptance occurs.
 */
export const controlWordAddress = (v: string): Address | null => /^0x0{24}[0-9a-f]{40}$/i.test(v) ? `0x${v.slice(-40).toLowerCase()}` as Address : null;
export const CONTROL_SELECTORS = [
  ['setTax(uint256)', 'tax_raise', 'tax'], ['setFees(uint256,uint256)', 'tax_raise', 'tax'],
  ['setBuyTax(uint256)', 'tax_raise', 'tax'], ['setSellTax(uint256)', 'tax_raise', 'tax'],
  ['blacklist(address,bool)', 'blacklist', 'blacklist'], ['setBlacklist(address,bool)', 'blacklist', 'blacklist'],
  ['pause()', 'sell_pause', 'pause'], ['setTradingEnabled(bool)', 'sell_pause', 'pause'],
  ['mint(address,uint256)', 'mint', 'mint'], ['upgradeTo(address)', 'transfer_upgrade', 'upgrade'],
  ['upgradeToAndCall(address,bytes)', 'transfer_upgrade', 'upgrade'],
  ['upgrade(address,address)', 'transfer_upgrade', 'upgrade'], ['upgradeAndCall(address,address,bytes)', 'transfer_upgrade', 'upgrade'],
  ['setMaxTransactionAmount(uint256)', null, 'limit'], ['setMaxWallet(uint256)', null, 'limit'],
].map(([signature, capability, category]) => ({ selector: toFunctionSelector(signature!), capability, category })) as Omit<ControlInspection['selectors'][number], 'address'>[];
/** Disassemble PUSH operands rather than searching metadata/arbitrary byte substrings. These remain suspected selectors. */
export function observedControlSelectors(code: Hex) {
  const found = new Set<string>();
  for (let i = 2; i < code.length;) {
    const op = parseInt(code.slice(i, i + 2), 16); i += 2;
    const length = op >= 0x60 && op <= 0x7f ? op - 0x5f : 0;
    if (op === 0x63 && i + 8 <= code.length) found.add(`0x${code.slice(i, i + 8)}`);
    i += length * 2;
  }
  return CONTROL_SELECTORS.filter(s => found.has(s.selector));
}
/** No template claim, cache, unbounded role scan or automatic fork job. A fresh inspection is needed at every state cursor. */
export async function inspectGenericControls(clients: ControlClients, input: {
  coin: Address; cursor: GuardCursor; launchpad: 'other' | 'pons'; configurationReads?: ControlRead[];
  /** Explicit known controller contracts only; bounded role reads do not discover arbitrary role names. */
  roleTargets?: Address[];
}): Promise<ControlInspection> {
  if (input.launchpad === 'pons') throw new Error('Pons profiles belong to packet 039');
  const cursor = GuardCursorSchema.parse(input.cursor), coin = AddressSchema.parse(input.coin).toLowerCase() as Address;
  if (cursor.boundary !== 'block_end') throw new Error('Control inspection requires block-end state');
  const reads = (input.configurationReads ?? []).map(r => ControlReadSchema.parse(r));
  const targets = (input.roleTargets ?? []).map(a => AddressSchema.parse(a).toLowerCase() as Address);
  if (reads.length > 16 || targets.length > 2) throw new Error('Control input budget exceeded');
  let requests = 0;
  const gaps = new Set<ControlInspection['gaps'][number]>();
  const request = async (method: string, params: readonly unknown[]) => {
    if (requests >= 128) throw new ControlBudgetError('Control request budget exceeded');
    requests++;
    return clients.archive.request({ method, params } as never);
  };
  const number = toHex(BigInt(cursor.blockNumber));
  const check = async () => {
    const h = await request('eth_getBlockByNumber', [number, false]) as { hash?: string; timestamp?: string; number?: string };
    if (h?.hash?.toLowerCase() !== cursor.blockHash.toLowerCase() || BigInt(h.number ?? '-1') !== BigInt(cursor.blockNumber) || BigInt(h.timestamp ?? '-1') !== BigInt(cursor.timestampSec)) throw new Error('Control state pin mismatch');
  };
  if (BigInt(await request('eth_chainId', []) as string) !== BigInt(cursor.chainId)) throw new Error('Control chain mismatch');
  await check();
  const read = async (method: string, params: readonly unknown[]): Promise<Hex | null> => {
    try { return controlBytes.parse(await request(method, params)); }
    catch (e) { if (e instanceof ControlBudgetError || rpcStopReason(e)) throw e; gaps.add('failed'); return null; }
  };
  const code = (address: Address) => read('eth_getCode', [address, number]);
  const slot = (address: Address, s: Hex) => read('eth_getStorageAt', [address, s, number]);
  const call = (address: Address, data: Hex) => read('eth_call', [{ to: address, data }, number]);
  const path: ControlInspection['path'] = [], roles: ControlInspection['roles'] = [], selectors: ControlInspection['selectors'] = [];
  const roleAddresses = new Set<Address>([coin, ...targets]);
  const visited = new Set<Address>(); let current: Address | null = coin, resolution: ControlInspection['resolution'] = 'unknown';
  for (let depth = 0; current && depth < 4; depth++) {
    if (visited.has(current)) { gaps.add('unsupported'); break; } visited.add(current);
    const runtime = await code(current);
    if (!runtime || runtime === '0x') { gaps.add('missing'); break; }
    const [impl, beacon, admin] = await Promise.all([slot(current, CONTROL_SLOTS.implementation), slot(current, CONTROL_SLOTS.beacon), slot(current, CONTROL_SLOTS.admin)]);
    const clone = /^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/.exec(runtime);
    let next: Address | null = null, beaconAddress: Address | null = null, beaconCodeHash: Hex | null = null;
    let kind: ControlInspection['path'][number]['kind'] = 'unknown';
    if (impl && impl !== zero) { next = controlWordAddress(impl); kind = 'eip1967'; }
    if (beacon && beacon !== zero) {
      if (next || clone) { gaps.add('unsupported'); break; }
      beaconAddress = controlWordAddress(beacon);
      if (beaconAddress) {
        roleAddresses.add(beaconAddress); const beaconCode = await code(beaconAddress);
        beaconCodeHash = beaconCode && beaconCode !== '0x' ? keccak256(beaconCode) : null;
        if (beaconCode) selectors.push(...observedControlSelectors(beaconCode).map(s => ({ ...s, address: beaconAddress! })));
        next = controlWordAddress(await call(beaconAddress, toFunctionSelector('implementation()')) ?? '');
      }
      kind = 'beacon';
    } else if (clone) {
      if (next) { gaps.add('unsupported'); break; }
      next = `0x${clone[1]}` as Address; kind = 'clone';
    }
    if (kind !== 'unknown' && (!next || inertAuthority(next))) { gaps.add('unsupported'); next = null; }
    if (admin && admin !== zero) {
      const a = controlWordAddress(admin);
      if (a) roles.push({ target: current, kind: 'proxy_admin', address: a, codeHash: null, inert: inertAuthority(a) });
      else gaps.add('unsupported');
    }
    path.push({ address: current, codeHash: keccak256(runtime), kind, next, beacon: beaconAddress, beaconCodeHash });
    selectors.push(...observedControlSelectors(runtime).map(s => ({ ...s, address: current! })));
    if (kind !== 'unknown') resolution = 'bounded_proxy';
    current = next;
  }
  if (current) gaps.add('unsupported');
  // owner() zero is an observation about one role, never absence of other powers.
  for (const target of roleAddresses) {
    for (const [signature, kind] of [['owner()', 'owner'], ['getOwner()', 'get_owner']] as const) {
      const value = await call(target, toFunctionSelector(signature)); const a = value ? controlWordAddress(value) : null;
      if (a) roles.push({ target, kind, address: a, codeHash: null, inert: inertAuthority(a) });
    }
    const countWord = await call(target, `${toFunctionSelector('getRoleMemberCount(bytes32)')}${zero.slice(2)}`);
    if (countWord && /^0x[0-9a-f]{64}$/.test(countWord)) {
      const n = BigInt(countWord); if (n > 8n) gaps.add('unsupported');
      for (let i = 0n; i < n && i < 8n; i++) {
        const word = await call(target, `${toFunctionSelector('getRoleMember(bytes32,uint256)')}${zero.slice(2)}${toHex(i, { size: 32 }).slice(2)}`);
        const a = word ? controlWordAddress(word) : null;
        if (a) {
          const member = await call(target, `${toFunctionSelector('hasRole(bytes32,address)')}${zero.slice(2)}${a.slice(2).padStart(64, '0')}`);
          if (member === toHex(1n, { size: 32 })) roles.push({ target, kind: 'default_admin', address: a, codeHash: null, inert: inertAuthority(a) });
          else gaps.add('unsupported');
        }
      }
    } else gaps.add('unsupported');
  }
  const codes = new Map<Address, Hex | null>();
  for (const role of roles) {
    if (!codes.has(role.address) && !role.inert) codes.set(role.address, await code(role.address));
    const runtime = codes.get(role.address); role.codeHash = runtime ? keccak256(runtime) : null;
    if (runtime) for (const selector of observedControlSelectors(runtime)) {
      if (!selectors.some(s => s.address === role.address && s.selector === selector.selector)) selectors.push({ ...selector, address: role.address });
    }
  }
  const configuration: ControlInspection['configuration'] = [];
  for (const r of reads) configuration.push({ ...r, result: await call(r.target, r.data) });
  await check(); // Number-addressed reads must still describe the same canonical block.
  const implementationHash = path.at(-1)?.kind === 'unknown' && !current ? path.at(-1)!.codeHash : null;
  const configurationHash = referenceDigest({ roles, configuration });
  const profileHash = referenceDigest({ methodVersion: CONTROL_METHOD_VERSION, coin, cursor, path, roles, selectors, configurationHash });
  return ControlInspectionSchema.parse({ methodVersion: CONTROL_METHOD_VERSION, coin, cursor, path, roles, selectors,
    configuration, implementationHash, configurationHash, profileHash, resolution, gaps: [...gaps].sort(), requests });
}
