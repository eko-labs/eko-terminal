import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, keccak256, toFunctionSelector, type Address, type Hex } from 'viem';
import { collectGenericLpCustody, custodyDepthInputs } from '../src/custody/collector.js';
import { custodySqrtRatio } from '../src/custody/ticks.js';
import type { CustodyClients, CustodyIndex, CustodyRegistry, IndexedCustody } from '../src/custody/types.js';
import { referenceDigest } from '../src/simulation/reference.js';
import { removalDepth } from '../src/simulation/depth-removal.js';
import { route, repin, unit } from './directional-depth-fixtures.js';
import { address, cursor, hash } from './reference-fixtures.js';

const manager = address(40), factory = address(41), locker = address(42), holder = address(43), recipient = address(44), operator = address(45);
const managerCode: Hex = '0x60016000', factoryCode: Hex = '0x60026000', lockerCode: Hex = '0x60036000';
const dead: Address = `0x${'0'.repeat(36)}dead`, zero = address(0);
const wordAddress = (a: Address) => encodeAbiParameters([{ type: 'address' }], [a]);
const wordBool = (b: boolean) => encodeAbiParameters([{ type: 'bool' }], [b]);

function fixture() {
  const r = route('uniswap_v3'); r.poolId = address(50);
  if (r.venue !== 'uniswap_v3') throw new Error('Fixture venue');
  r.state.ranges = [{ lower: custodySqrtRatio(-10000), upper: custodySqrtRatio(10000), liquidity: 100000n * unit }]; repin(r);
  const registry: CustodyRegistry = { chainId: 4663, origin: 'fixture',
    managers: [{ address: manager, codeHash: keccak256(managerCode), factory, factoryCodeHash: keccak256(factoryCode), semantics: 'immutable_v3_nft', evidenceIds: [hash('manager-review')] }],
    lockers: [{ address: locker, codeHash: keccak256(lockerCode), selector: toFunctionSelector('positionLock(uint256)'), semantics: 'immutable_position_lock', evidenceIds: [hash('locker-review')] }] };
  const indexed: IndexedCustody = { cursor, origin: 'fixture', evidenceIds: [hash('index-events')],
    pools: [{ poolId: r.poolId, complete: true, positions: [{ manager, tokenId: '1', operators: [], operatorsComplete: true }] }] };
  const state = { owner: holder, liquidity: 100000n * unit, lockedLiquidity: 100000n * unit,
    expiry: 2000n, beneficiary: recipient, revocable: false, approved: zero, allApproved: false,
    code: lockerCode, pinChanged: false, failOwner: false, wrongPool: false, wrongManager: false };
  const calls: { method: string; params: readonly unknown[] }[] = [];
  const clients = { archive: { request: async ({ method, params }: { method: string; params: readonly unknown[] }) => {
    calls.push({ method, params });
    if (method === 'eth_chainId') return '0x1237';
    if (method === 'eth_getBlockByNumber') return { number: '0x64', timestamp: '0x3e8', hash: state.pinChanged && calls.length > 2 ? hash('replacement') : cursor.blockHash };
    expect(params.at(-1)).toBe('0x64');
    if (method === 'eth_getCode') {
      if (params[0] === manager) return managerCode;
      if (params[0] === factory) return factoryCode;
      return params[0] === locker ? state.code : '0x';
    }
    const tx = params[0] as { to: Address; data: Hex }, selector = tx.data.slice(0, 10);
    if (selector === toFunctionSelector('factory()')) return wordAddress(factory);
    if (selector === toFunctionSelector('getPool(address,address,uint24)')) return wordAddress(state.wrongPool ? address(51) : r.poolId as Address);
    if (selector === toFunctionSelector('ownerOf(uint256)')) { if (state.failOwner) throw new Error('synthetic failure'); return wordAddress(state.owner); }
    if (selector === toFunctionSelector('getApproved(uint256)')) return wordAddress(state.approved);
    if (selector === toFunctionSelector('isApprovedForAll(address,address)')) return wordBool(state.allApproved);
    if (selector === toFunctionSelector('positions(uint256)')) return encodeAbiParameters(
      [{ type: 'uint96' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'int24' }, { type: 'uint128' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }],
      [0n, zero, r.coin, address(11), 3000, -10000, 10000, state.liquidity, 0n, 0n, 0n, 0n]);
    if (selector === registry.lockers[0].selector) return encodeAbiParameters(
      [{ type: 'address' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint128' }, { type: 'uint256' }, { type: 'bool' }],
      [state.wrongManager ? address(99) : manager, 1n, state.beneficiary, state.lockedLiquidity, state.expiry, state.revocable]);
    throw new Error('Unexpected synthetic RPC');
  } } } as unknown as CustodyClients;
  const index: CustodyIndex = { positions: async input => { expect(input).toEqual({ poolIds: [r.poolId], cursor, limitPerPool: 128 }); return indexed; } };
  const collect = () => collectGenericLpCustody(clients, index, { cursor, origin: 'fixture', registry, pools: [{ launchpad: 'other', route: r }] });
  return { r, registry, indexed, state, calls, clients, index, collect };
}

describe('bounded generic LP custody acquisition', () => {
  it('uses transferred owner and current partial-removal liquidity, then feeds 041', async () => {
    const f = fixture(); f.state.owner = recipient; f.state.liquidity /= 2n;
    if (f.r.venue === 'uniswap_v3') f.r.state.ranges[0].liquidity = f.state.liquidity; repin(f.r);
    const result = await f.collect(), p = result.pools[0].positions[0];
    expect(p.owner).toBe(recipient); expect(p.liquidity).toBe(50000n * unit);
    expect(p.custody).toBe('removable'); expect(result.pools[0].complete).toBe(true);
    const input = custodyDepthInputs(result, [f.r], recipient);
    const depth = removalDepth([f.r], input.positions, input.controller, true, input.positionCoverageComplete);
    expect(depth.status).toBe('bounded'); expect(depth.lowerShare).toBe('1');
    const old = custodyDepthInputs(result, [f.r], holder);
    expect(removalDepth([f.r], old.positions, old.controller, true, old.positionCoverageComplete).lowerShare).toBe('0');
    expect(result.requests).toBe(f.calls.length); expect(result.requests).toBeLessThan(20);
  });

  it.each([['active', 1001n, 'locked'], ['at expiry', 1000n, 'removable'], ['expired', 999n, 'removable']] as const)('%s lock at pinned time', async (_, expiry, custody) => {
    const f = fixture(); f.state.owner = locker; f.state.expiry = expiry;
    const result = await f.collect(), p = result.pools[0].positions[0];
    expect(p.custody).toBe(custody); expect(p.expirySec).toBe(expiry.toString()); expect(p.beneficiary).toBe(recipient);
    expect(p.removers).toEqual(custody === 'locked' ? [] : [recipient]);
    expect(result.pools[0].complete).toBe(true);
  });

  it('distinguishes burned custody from a lock and refuses sink approval bypasses', async () => {
    const f = fixture(); f.state.owner = dead;
    expect((await f.collect()).pools[0].positions[0].custody).toBe('burned');
    f.state.approved = operator;
    expect((await f.collect()).pools[0].positions[0].custody).toBe('unknown');
    f.state.owner = zero; f.state.approved = zero;
    expect((await f.collect()).pools[0].positions[0].custody).toBe('unknown');
  });

  it.each(['code', 'revocable', 'partial', 'bypass', 'manager', 'registry'] as const)('leaves %s locker uncertainty unknown', async kind => {
    const f = fixture(); f.state.owner = locker;
    if (kind === 'code') f.state.code = '0x60046000';
    if (kind === 'revocable') f.state.revocable = true;
    if (kind === 'partial') f.state.lockedLiquidity /= 2n;
    if (kind === 'bypass') f.state.approved = operator;
    if (kind === 'manager') f.state.wrongManager = true;
    if (kind === 'registry') f.registry.lockers = [];
    const result = await f.collect();
    expect(result.pools[0].positions[0].custody).toBe('unknown'); expect(result.pools[0].complete).toBe(false);
    expect(f.calls.filter(c => c.method === 'eth_call' && (c.params[0] as { to: string }).to === locker)).toHaveLength(kind === 'code' || kind === 'registry' ? 0 : 1);
  });

  it('revalidates indexed operators and maps an approved remover without duplicating positions', async () => {
    const f = fixture(); f.indexed.pools[0].positions[0].operators = [operator]; f.state.allApproved = true;
    let result = await f.collect();
    expect(custodyDepthInputs(result, [f.r], operator).positions[0].controller).toBe(operator);
    f.state.allApproved = false; result = await f.collect();
    expect(result.pools[0].positions[0].removers).toEqual([holder]);
    f.indexed.pools[0].positions[0].operatorsComplete = false;
    expect((await f.collect()).pools[0].complete).toBe(false);
  });

  it.each(['index', 'liquidity', 'manager', 'pool', 'read'] as const)('does not complete %s gaps', async kind => {
    const f = fixture();
    if (kind === 'index') f.indexed.pools[0].complete = false;
    if (kind === 'liquidity') f.state.liquidity /= 2n;
    if (kind === 'manager') f.registry.managers = [];
    if (kind === 'pool') f.state.wrongPool = true;
    if (kind === 'read') f.state.failOwner = true;
    const result = await f.collect(), input = custodyDepthInputs(result, [f.r], holder);
    expect(input.positionCoverageComplete).toBe(false);
    expect(removalDepth([f.r], input.positions, input.controller, true, input.positionCoverageComplete).status).toBe('unknown');
  });

  it('rejects mixed pins, reorgs, origins, duplicate positions and out-of-scope indexes', async () => {
    const f = fixture(); f.indexed.cursor = { ...cursor, blockHash: hash('wrong') };
    await expect(f.collect()).rejects.toThrow('index scope/snapshot');
    f.indexed.cursor = cursor; f.state.pinChanged = true;
    await expect(f.collect()).rejects.toThrow('pin mismatch');
    f.state.pinChanged = false; f.indexed.origin = 'measured';
    await expect(f.collect()).rejects.toThrow('index scope/snapshot');
    f.indexed.origin = 'fixture'; f.indexed.pools[0].positions.push(f.indexed.pools[0].positions[0]);
    await expect(f.collect()).rejects.toThrow('Duplicate indexed');
    f.indexed.pools[0].positions.pop(); f.indexed.pools[0].poolId = 'other-pool';
    await expect(f.collect()).rejects.toThrow('index scope/snapshot');
  });

  it('rejects stale route state or tampered evidence at the depth boundary', async () => {
    const f = fixture(), result = await f.collect();
    result.pools[0].complete = false;
    expect(() => custodyDepthInputs(result, [f.r], holder)).toThrow('digest mismatch');
    result.id = referenceDigest((({ id: _, ...body }) => body)(result));
    if (f.r.venue === 'uniswap_v3') f.r.state.ranges[0].liquidity--;
    expect(() => custodyDepthInputs(result, [f.r], holder)).toThrow('route pin mismatch');
  });

  it('publishes a named generic v4 gap with no PoolManager balance or position calls', async () => {
    const f = fixture();
    const result = await collectGenericLpCustody(f.clients, { positions: async input => {
      expect(input.poolIds).toEqual(['fixture-v4']); return { ...f.indexed, pools: [] };
    } }, { cursor, origin: 'fixture', registry: f.registry, pools: [{ launchpad: 'other', venue: 'uniswap_v4', poolId: 'fixture-v4' }] });
    expect(result.pools[0]).toMatchObject({ complete: false, positions: [], gaps: ['generic_v4_positions_unsupported'] });
    expect(f.calls.map(c => c.method)).toEqual(['eth_chainId', 'eth_getBlockByNumber', 'eth_getBlockByNumber']);
  });

  it('bounds inputs before acquisition and excludes Pons', async () => {
    const f = fixture();
    await expect(collectGenericLpCustody(f.clients, f.index, { cursor, origin: 'fixture', registry: f.registry,
      pools: Array.from({ length: 17 }, () => ({ launchpad: 'other', route: f.r })) })).rejects.toThrow('Unsupported');
    f.r.venue = 'pons_curve' as never;
    await expect(f.collect()).rejects.toThrow('Unsupported'); expect(f.calls).toHaveLength(0);
  });

  it('uses exact TickMath extrema and zero with upward integer rounding', () => {
    expect(custodySqrtRatio(0)).toBe(1n << 96n);
    expect(custodySqrtRatio(-887272)).toBe(4295128739n);
    expect(custodySqrtRatio(887272)).toBe(1461446703485210103287273052203988822378723970342n);
    expect(() => custodySqrtRatio(887273)).toThrow(); expect(() => custodySqrtRatio(0.5)).toThrow();
  });
});
