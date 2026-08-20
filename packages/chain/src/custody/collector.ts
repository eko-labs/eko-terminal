import { decodeAbiParameters, decodeFunctionResult, encodeFunctionData, keccak256, parseAbi, toHex, type Address, type Hex } from 'viem';
import { AddressSchema, GuardCursorSchema, type GuardCursor } from '@eko/shared';
import { rpcStopReason } from '../rpc/metered.js';
import { referenceDigest } from '../simulation/reference.js';
import { localRouteStateHash, supportsLocalDepth } from '../simulation/directional-depth.js';
import type { ValidatedDepthPosition } from '../simulation/depth-removal.js';
import { custodySqrtRatio } from './ticks.js';
import { CustodyRegistrySchema, IndexedCustodySchema, type CustodyClients, type CustodyIndex,
  type CustodyObservation, type CustodyPool, type CustodyPosition, type CustodyRegistry } from './types.js';

const abi = parseAbi([
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function getApproved(uint256 tokenId) view returns (address)',
  'function isApprovedForAll(address owner,address operator) view returns (bool)',
  'function factory() view returns (address)',
  'function getPool(address token0,address token1,uint24 fee) view returns (address)',
  'function positions(uint256 tokenId) view returns (uint96 nonce,address operator,address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint128 liquidity,uint256 feeGrowthInside0LastX128,uint256 feeGrowthInside1LastX128,uint128 tokensOwed0,uint128 tokensOwed1)',
]);
const normalize = (a: string) => a.toLowerCase() as Address;
const sink = (a: string) => /^0x0{40}$/.test(a) || /^0x0{36}dead$/i.test(a);
const zero = `0x${'0'.repeat(40)}` as Address;
class CustodyBudgetError extends Error {}

/** Opt-in acquisition: injected canonical position index and existing metered archive
 * client only. No global scans, fork resets, transactions, or aggregate v4 balances. */
export async function collectGenericLpCustody(clients: CustodyClients, index: CustodyIndex, input: {
  cursor: GuardCursor; origin: 'fixture' | 'measured'; pools: CustodyPool[]; registry: CustodyRegistry;
}): Promise<CustodyObservation> {
  const cursor = GuardCursorSchema.parse(input.cursor), registry = CustodyRegistrySchema.parse(input.registry);
  if (cursor.boundary !== 'block_end' || registry.origin !== input.origin) throw new Error('Custody snapshot/origin mismatch');
  if (!input.pools.length || input.pools.length > 16 || input.pools.some(p => p.launchpad !== 'other' ||
    'route' in p && (p.route.venue !== 'uniswap_v3' || p.route.origin !== input.origin ||
      referenceDigest(p.route.cursor) !== referenceDigest(cursor) || !supportsLocalDepth(p.route)))) throw new Error('Unsupported custody request');
  const ids = input.pools.map(p => 'route' in p ? p.route.poolId : p.poolId);
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate requested pool');
  for (const p of input.pools) if ('route' in p) AddressSchema.parse(p.route.poolId);
  if (new Set(registry.managers.map(m => m.address)).size !== registry.managers.length ||
    new Set(registry.lockers.map(l => l.address)).size !== registry.lockers.length) throw new Error('Duplicate custody registry entry');
  const trace: unknown[] = []; let requests = 0;
  const block = toHex(BigInt(cursor.blockNumber));
  const request = async (method: string, params: readonly unknown[]) => {
    if (requests >= 4096) throw new CustodyBudgetError('Custody request budget exceeded');
    requests++;
    try {
      const result: unknown = await clients.archive.request({ method, params } as never);
      trace.push({ method, params, result }); return result;
    } catch (error) {
      if (rpcStopReason(error)) throw error;
      trace.push({ method, params, failed: true }); throw error;
    }
  };
  const pin = async () => {
    const b = await request('eth_getBlockByNumber', [block, false]) as { hash?: string; number?: string; timestamp?: string };
    if (b?.hash?.toLowerCase() !== cursor.blockHash.toLowerCase() || BigInt(b.number ?? '-1') !== BigInt(cursor.blockNumber) ||
      BigInt(b.timestamp ?? '-1') !== BigInt(cursor.timestampSec)) throw new Error('Custody pin mismatch');
  };
  if (BigInt(await request('eth_chainId', []) as string) !== BigInt(cursor.chainId)) throw new Error('Custody chain mismatch');
  await pin();
  const indexed = IndexedCustodySchema.parse(await index.positions({ poolIds: ids, cursor, limitPerPool: 128 }));
  if (indexed.origin !== input.origin || referenceDigest(indexed.cursor) !== referenceDigest(cursor) ||
    indexed.pools.some(p => !ids.includes(p.poolId)) || new Set(indexed.pools.map(p => p.poolId)).size !== indexed.pools.length ||
    indexed.pools.reduce((n, p) => n + p.positions.length, 0) > 128) throw new Error('Custody index scope/snapshot/budget mismatch');
  const registryHash = referenceDigest(registry), indexHash = referenceDigest(indexed);
  const codes = new Map<Address, Hex>();
  const code = async (address: Address) => {
    const a = normalize(address);
    if (!codes.has(a)) {
      const result = await request('eth_getCode', [a, block]);
      if (typeof result !== 'string' || !/^0x(?:[0-9a-f]{2})*$/i.test(result) || result.length > 100002) throw new Error('Invalid custody code');
      codes.set(a, result.toLowerCase() as Hex);
    }
    return codes.get(a)!;
  };
  const call = async (to: Address, functionName: typeof abi[number]['name'], args: readonly unknown[] = []): Promise<unknown> =>
    decodeFunctionResult({ abi, functionName, data: await request('eth_call', [{ to, data: encodeFunctionData({ abi, functionName, args } as never) }, block]) as Hex });
  const pools: CustodyObservation['pools'] = [];
  const seen = new Set<string>();
  for (const pool of input.pools) {
    if (!('route' in pool)) {
      pools.push({ poolId: pool.poolId, routeStateHash: null, complete: false, positions: [], gaps: ['generic_v4_positions_unsupported'] }); continue;
    }
    const route = pool.route, poolId = AddressSchema.parse(route.poolId).toLowerCase();
    const row = indexed.pools.find(p => p.poolId === route.poolId);
    const result: CustodyObservation['pools'][number] = { poolId: route.poolId, routeStateHash: localRouteStateHash(route),
      complete: row?.complete ?? false, positions: [], gaps: row?.complete ? [] : ['position_index_incomplete'] };
    for (const ref of row?.positions ?? []) {
      const id = `${ref.manager}:${ref.tokenId}`;
      if (seen.has(id)) throw new Error('Duplicate indexed custody position');
      seen.add(id);
      const start = trace.length;
      const p: CustodyPosition = { id, poolId: route.poolId, manager: ref.manager, tokenId: ref.tokenId, owner: null,
        lower: 0n, upper: 0n, liquidity: 0n, custody: 'unknown', removers: [], expirySec: null, beneficiary: null, evidenceIds: [], gaps: [] };
      try {
        const manager = registry.managers.find(m => m.address === ref.manager);
        if (!manager || keccak256(await code(ref.manager)) !== manager.codeHash ||
          keccak256(await code(manager.factory)) !== manager.factoryCodeHash ||
          normalize(await call(ref.manager, 'factory') as Address) !== manager.factory) {
          p.gaps.push('manager_unverified');
        } else {
          const state = await call(ref.manager, 'positions', [BigInt(ref.tokenId)]) as readonly [bigint, Address, Address, Address, number, number, number, bigint, bigint, bigint, bigint, bigint];
          const [, , token0, token1, fee, lower, upper, liquidity] = state;
          p.lower = custodySqrtRatio(lower); p.upper = custodySqrtRatio(upper); p.liquidity = liquidity;
          if (p.lower >= p.upper || normalize(await call(manager.factory, 'getPool', [token0, token1, fee]) as Address) !== poolId ||
            route.venue !== 'uniswap_v3' || BigInt(fee) !== route.state.feePips ||
            normalize(route.state.coinIsToken0 ? token0 : token1) !== normalize(route.coin)) {
            p.gaps.push('position_pool_mismatch');
          } else {
            p.owner = normalize(await call(ref.manager, 'ownerOf', [BigInt(ref.tokenId)]) as Address);
            const approved = normalize(await call(ref.manager, 'getApproved', [BigInt(ref.tokenId)]) as Address);
            const actors = new Set<Address>([p.owner, ...(!sink(approved) ? [approved] : [])]);
            for (const operator of ref.operators) if (await call(ref.manager, 'isApprovedForAll', [p.owner, operator]) === true && !sink(operator)) actors.add(operator);
            if (!ref.operatorsComplete) p.gaps.push('approval_coverage_incomplete');
            if (sink(p.owner)) {
              // A sink holding a live NFT is burned custody only if no alternate actor can remove it.
              if (p.owner !== zero && actors.size === 1 && ref.operatorsComplete) p.custody = 'burned';
              else p.gaps.push('locker_state_unresolved');
            } else if (await code(p.owner) === '0x') {
              p.custody = 'removable'; p.removers = [...actors];
            } else {
              const locker = registry.lockers.find(l => l.address === p.owner);
              if (!locker || keccak256(await code(p.owner)) !== locker.codeHash) p.gaps.push('locker_unverified');
              else {
                const data = `${locker.selector}${toHex(BigInt(ref.tokenId), { size: 32 }).slice(2)}`;
                const lock = decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint128' }, { type: 'uint256' }, { type: 'bool' }],
                  await request('eth_call', [{ to: p.owner, data }, block]) as Hex);
                const [managerAddress, tokenId, beneficiary, lockedLiquidity, expiry, revocable] = lock;
                p.expirySec = expiry.toString(); p.beneficiary = normalize(beneficiary);
                p.evidenceIds.push(...locker.evidenceIds);
                if (normalize(managerAddress) !== ref.manager || tokenId !== BigInt(ref.tokenId) || lockedLiquidity !== liquidity ||
                  revocable || sink(beneficiary) || actors.size !== 1 || !ref.operatorsComplete) p.gaps.push('locker_state_unresolved');
                else if (expiry > BigInt(cursor.timestampSec)) p.custody = 'locked';
                else { p.custody = 'removable'; p.removers = [p.beneficiary]; }
              }
            }
          }
          p.evidenceIds.push(...manager.evidenceIds);
        }
      } catch (error) {
        if (error instanceof CustodyBudgetError || rpcStopReason(error)) throw error;
        p.custody = 'unknown'; p.removers = []; p.gaps.push('position_read_failed');
      }
      p.evidenceIds = [...new Set([...p.evidenceIds, ...indexed.evidenceIds, registryHash, indexHash, referenceDigest(trace.slice(start))])];
      result.positions.push(p);
      if (p.custody === 'unknown' || p.gaps.length) result.complete = false;
      result.gaps.push(...p.gaps);
    }
    if (route.venue === 'uniswap_v3' && (result.positions.some(p =>
      !route.state.ranges.some(r => r.lower === p.lower) || !route.state.ranges.some(r => r.upper === p.upper)) ||
      route.state.ranges.some(r => result.positions.filter(p => p.lower <= r.lower && p.upper >= r.upper)
        .reduce((sum, p) => sum + p.liquidity, 0n) !== r.liquidity))) {
      result.complete = false; result.gaps.push('position_liquidity_unreconciled');
    }
    result.gaps = [...new Set(result.gaps)]; pools.push(result);
  }
  await pin();
  const body = { methodVersion: 'generic-lp-custody-1' as const, cursor, origin: input.origin, registryHash, indexHash, pools, trace, requests };
  return { ...body, id: referenceDigest(body) };
}

/** Validated acquisition -> packet 041 inputs. This performs no depth solve, scoring,
 * activation, or custody claim for unsupported venues. Completeness is never upgraded. */
export function custodyDepthInputs(observation: CustodyObservation, routes: import('../simulation/directional-depth.js').LocalDepthRoute[], controller: Address) {
  const { id, ...body } = observation;
  if (referenceDigest(body) !== id) throw new Error('Custody observation digest mismatch');
  const actor = normalize(AddressSchema.parse(controller));
  if (routes.length !== observation.pools.length || new Set(routes.map(r => r.poolId)).size !== routes.length) throw new Error('Custody route scope mismatch');
  const positions: ValidatedDepthPosition[] = [];
  for (const r of routes) {
    const pool = observation.pools.find(p => p.poolId === r.poolId);
    if (!pool || pool.routeStateHash !== localRouteStateHash(r) || r.origin !== observation.origin ||
      referenceDigest(r.cursor) !== referenceDigest(observation.cursor)) throw new Error('Custody route pin mismatch');
    for (const p of pool.positions) {
      positions.push({ id: p.id, poolId: p.poolId, controller: p.removers.includes(actor) ? actor : p.owner ?? zero,
        cursor: observation.cursor, custody: p.custody, validated: p.custody !== 'unknown' && !p.gaps.length,
        routeStateHash: pool.routeStateHash, origin: observation.origin, evidenceIds: [...p.evidenceIds, observation.id],
        lower: p.lower, upper: p.upper, liquidity: p.liquidity });
    }
  }
  return { positions, positionCoverageComplete: observation.pools.every(p => p.complete), controller: actor };
}
