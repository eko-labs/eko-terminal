import { withRpcOrigin } from '@eko/chain';
import { keccak256, parseAbi, zeroAddress, type Address, type Hex, type PublicClient } from 'viem';
import { loadRegistry, v4PoolId } from '@eko/chain';
import { V4_MANAGER, type IndexedV4Pool } from './v4-routes.js';

// Proof that a Pons graduation pool's liquidity cannot be removed (docs/operations/pons-graduation-lock.md). A
// graduation mints one full-range Uniswap v4 position through the canonical PositionManager and parks its NFT in the
// Pons launch locker. The reviewed locker bytecode has no path that moves, approves or spends that NFT, and the
// PositionManager only lets the NFT's owner or an approved account decrease liquidity. Each pool is re-proven at the
// block: the factory's hook, locker and PositionManager are the reviewed ones (by code hash), and the locker still
// owns a live position on exactly this pool.
const registry = loadRegistry();
const lower = (a: string) => a.toLowerCase() as Address;
const same = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const PONS_FACTORY = lower(registry.requireAddress('pons.factory'));
const PONS_HOOK = lower(registry.requireAddress('pons.v4Hook'));
/** Runtime code hashes reviewed on 2026-10-06 (block 81,960,826): the Pons launch locker and Uniswap's v4 PositionManager. */
export const PONS_LOCKER_CODE_HASH: Hex = '0x58455f80b3773871d601a025e56ec27c71ab3bbb8e2ca6b17828954450742025';
export const V4_POSITION_MANAGER_CODE_HASH: Hex = '0xc873e135dc9aaec88489cfbad146b4cb49d6a32e0d80326377784b7ba17670b2';

const FACTORY_ABI = parseAbi(['function locker() view returns (address)', 'function positionManager() view returns (address)', 'function memeHook() view returns (address)']);
const LOCKER_ABI = parseAbi(['function lockedPositions(address token) view returns (uint256)']);
const POSM_ABI = parseAbi(['function ownerOf(uint256 tokenId) view returns (address)', 'function getApproved(uint256 tokenId) view returns (address)',
  'function getPositionLiquidity(uint256 tokenId) view returns (uint128)', 'function poolManager() view returns (address)',
  'function getPoolAndPositionInfo(uint256 tokenId) view returns ((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey, uint256 info)']);

export interface PonsGraduationLock { locked: boolean; tokenId: bigint; liquidity: bigint; locker: Address | null }
/**
 * Whether `pool` is `coin`'s Pons graduation pool with its graduation position provably locked at `block`: the pool uses
 * the registry's Pons hook and is the indexer's graduation record for the coin; the factory's hook, locker and
 * PositionManager are the reviewed contracts; and the locker owns, with no approval, a position with liquidity on this
 * pool. Any failed check is `locked: false` (the pool keeps its depth floor); provider failures reject. `pins` are the
 * reviewed code hashes (tests inject their own).
 */
export async function ponsGraduationLock(client: Pick<PublicClient, 'readContract' | 'getCode'>, coin: Address, pool: IndexedV4Pool,
  graduatedPool: Hex | null, block: bigint,
  pins: { locker: Hex; positionManager: Hex } = { locker: PONS_LOCKER_CODE_HASH, positionManager: V4_POSITION_MANAGER_CODE_HASH }): Promise<PonsGraduationLock> {
  const none: PonsGraduationLock = { locked: false, tokenId: 0n, liquidity: 0n, locker: null };
  if (!same(pool.key.hooks, PONS_HOOK) || !same(graduatedPool, pool.id) || !same(pool.key.currency1, coin) || !same(pool.key.currency0, zeroAddress)) return none;
  const at = { blockNumber: block } as const;
  const [locker, posm, hook] = await Promise.all([
    withRpcOrigin('server.pons_graduation.L41',()=>client.readContract({ address: PONS_FACTORY, abi: FACTORY_ABI, functionName: 'locker', ...at })),
    withRpcOrigin('server.pons_graduation.L42',()=>client.readContract({ address: PONS_FACTORY, abi: FACTORY_ABI, functionName: 'positionManager', ...at })),
    withRpcOrigin('server.pons_graduation.L43',()=>client.readContract({ address: PONS_FACTORY, abi: FACTORY_ABI, functionName: 'memeHook', ...at }))]);
  const [lockerCode, posmCode, manager, tokenId] = await Promise.all([withRpcOrigin('server.pons_graduation.L44.c1',()=>client.getCode({ address: locker, ...at })), withRpcOrigin('server.pons_graduation.L44.c2',()=>client.getCode({ address: posm, ...at })),
    withRpcOrigin('server.pons_graduation.L45',()=>client.readContract({ address: posm, abi: POSM_ABI, functionName: 'poolManager', ...at })),
    withRpcOrigin('server.pons_graduation.L46',()=>client.readContract({ address: locker, abi: LOCKER_ABI, functionName: 'lockedPositions', args: [coin], ...at }))]);
  if (!same(hook, PONS_HOOK) || keccak256(lockerCode ?? '0x') !== pins.locker || keccak256(posmCode ?? '0x') !== pins.positionManager ||
    !same(manager, V4_MANAGER) || tokenId === 0n) return none;
  const [owner, approved, liquidity, [poolKey]] = await Promise.all([
    withRpcOrigin('server.pons_graduation.L50',()=>client.readContract({ address: posm, abi: POSM_ABI, functionName: 'ownerOf', args: [tokenId], ...at })),
    withRpcOrigin('server.pons_graduation.L51',()=>client.readContract({ address: posm, abi: POSM_ABI, functionName: 'getApproved', args: [tokenId], ...at })),
    withRpcOrigin('server.pons_graduation.L52',()=>client.readContract({ address: posm, abi: POSM_ABI, functionName: 'getPositionLiquidity', args: [tokenId], ...at })),
    withRpcOrigin('server.pons_graduation.L53',()=>client.readContract({ address: posm, abi: POSM_ABI, functionName: 'getPoolAndPositionInfo', args: [tokenId], ...at }))]);
  const locked = same(owner, locker) && same(approved, zeroAddress) && liquidity > 0n && same(v4PoolId(poolKey), pool.id);
  return { locked, tokenId, liquidity, locker: lower(locker) };
}
