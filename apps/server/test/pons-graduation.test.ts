import { describe, expect, it, vi } from 'vitest';
import { keccak256, padHex, zeroAddress, type Address, type Hex, type PublicClient } from 'viem';
import { loadRegistry, v4PoolId, type V4PoolKey } from '@eko/chain';
import { ponsGraduationLock, PONS_LOCKER_CODE_HASH, V4_POSITION_MANAGER_CODE_HASH } from '../src/exec/pons-graduation.js';
import { V4_MANAGER } from '../src/exec/v4-routes.js';

// Offline: the per-pool lock proof with injected reads. The deployed-contract evidence behind it (locker bytecode, the
// PositionManager's approval rule, fork attempts to move or decrease the position) is docs/operations/pons-graduation-lock.md.
const registry = loadRegistry();
const HOOK = registry.requireAddress('pons.v4Hook').toLowerCase() as Address, FACTORY = registry.requireAddress('pons.factory').toLowerCase();
const coin = padHex('0xc0', { size: 20 }), locker = padHex('0xa1', { size: 20 }), posm = padHex('0xa2', { size: 20 });
const key: V4PoolKey = { currency0: zeroAddress, currency1: coin, fee: 0, tickSpacing: 200, hooks: HOOK };
const pool = { id: v4PoolId(key).toLowerCase() as Hex, key };
const lockerCode = '0x6001' as Hex, posmCode = '0x6002' as Hex;
const pins = { locker: keccak256(lockerCode), positionManager: keccak256(posmCode) };

function chain(over: Record<string, unknown> = {}, code: Record<string, Hex> = {}) {
  const reads: Record<string, unknown> = { locker, positionManager: posm, memeHook: HOOK, poolManager: V4_MANAGER, lockedPositions: 3_635_850n,
    ownerOf: locker, getApproved: zeroAddress, getPositionLiquidity: 29_277_002_188_455_996_366_490n, getPoolAndPositionInfo: [key, 0n], ...over };
  return {
    readContract: vi.fn(async (a: { address: Address; functionName: string }) => {
      if (['locker', 'positionManager', 'memeHook'].includes(a.functionName) && a.address.toLowerCase() !== FACTORY) throw new Error('not the factory');
      return reads[a.functionName];
    }),
    getCode: vi.fn(async ({ address }: { address: Address }) => code[address] ?? (address === locker ? lockerCode : address === posm ? posmCode : '0x')),
  } as unknown as PublicClient;
}

describe('Pons graduation pool lock proof', () => {
  it('pins the reviewed locker and PositionManager runtime code', () => {
    expect(PONS_LOCKER_CODE_HASH).toBe('0x58455f80b3773871d601a025e56ec27c71ab3bbb8e2ca6b17828954450742025');
    expect(V4_POSITION_MANAGER_CODE_HASH).toBe('0xc873e135dc9aaec88489cfbad146b4cb49d6a32e0d80326377784b7ba17670b2');
  });
  it('proves the lock when the locker owns, unapproved, a live position on exactly this graduation pool', async () => {
    expect(await ponsGraduationLock(chain(), coin, pool, pool.id, 100n, pins)).toEqual({ locked: true, tokenId: 3_635_850n, liquidity: 29_277_002_188_455_996_366_490n, locker });
  });
  it('identifies the pool by the verified Pons hook and the indexer’s graduation record, never by name', async () => {
    const plain = { id: v4PoolId({ ...key, hooks: zeroAddress }).toLowerCase() as Hex, key: { ...key, hooks: zeroAddress } };
    expect((await ponsGraduationLock(chain(), coin, plain, plain.id, 100n, pins)).locked).toBe(false);
    expect((await ponsGraduationLock(chain(), coin, pool, null, 100n, pins)).locked).toBe(false);
    expect((await ponsGraduationLock(chain(), coin, pool, `0x${'12'.repeat(32)}`, 100n, pins)).locked).toBe(false);
    expect((await ponsGraduationLock(chain(), padHex('0xc9', { size: 20 }), pool, pool.id, 100n, pins)).locked).toBe(false);
  });
  it.each([
    ['another hook in the factory', { memeHook: padHex('0x77', { size: 20 }) }, {}],
    ['a PositionManager on another PoolManager', { poolManager: padHex('0x78', { size: 20 }) }, {}],
    ['no locked position for the coin', { lockedPositions: 0n }, {}],
    ['the NFT left the locker', { ownerOf: padHex('0x79', { size: 20 }) }, {}],
    ['an approved spender on the NFT', { getApproved: padHex('0x7a', { size: 20 }) }, {}],
    ['a fully withdrawn position', { getPositionLiquidity: 0n }, {}],
    ['a position on another pool', { getPoolAndPositionInfo: [{ ...key, tickSpacing: 60 }, 0n] }, {}],
    ['locker code that differs from the reviewed bytecode', {}, { [locker]: '0x6003' as Hex }],
    ['PositionManager code that differs from the reviewed bytecode', {}, { [posm]: '0x6004' as Hex }],
  ])('refuses the lock with %s', async (_label, over, code) => {
    expect((await ponsGraduationLock(chain(over, code), coin, pool, pool.id, 100n, pins)).locked).toBe(false);
  });
});
