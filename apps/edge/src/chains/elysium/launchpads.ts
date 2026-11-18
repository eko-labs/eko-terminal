import { decodeAbiParameters, getAddress, hexToString, toEventSelector, zeroAddress, type Address, type Hex } from 'viem';
import { v4PoolId, type ElysiumRegistry, type V4PoolKey } from '@eko/chain';

/**
 * Launches on Elysium other than Montra's, all trading on Uniswap's own PoolManager against native HYPE (field layouts
 * decoded from mainnet logs on 2026-11-11):
 * - Flaunch fork: PoolCreated from its hook; trades are its PoolSwap events (part of each fill comes from an internal
 *   pool that Uniswap's Swap event never shows);
 * - HyperForge family: CoinCreated from any of ~40 clone factories (matched by topic), hookless 1% pools;
 * - Tax launchpad: Launched from its verified factory;
 * - the unbranded launcher (about a third of all launches, little trading): its own launch event, on its own PoolManager
 *   fork (a stock Uniswap v4 PoolManager by verified source, at another address), 0-fee pools with an unverified hook.
 * Every decoded launch rebuilds its pool key and must hash to the event's pool id, or it is dropped: a key that does
 * not match is a launch read wrongly or quoted in another token, and EKO prices only HYPE pools.
 */
export type LaunchpadId = 'montra' | 'flaunch' | 'hyperforge' | 'taxlaunch' | 'unbranded';
export interface DecodedLaunch {
  launchpad: Exclude<LaunchpadId, 'montra'>; token: Address; creator: Address; poolId: Hex; key: V4PoolKey;
  /** The token is currency0 (a flipped pool); HYPE is currency1. */
  flipped: boolean; supply: bigint; name: string | null; symbol: string | null;
  /** The PoolManager its pool lives in. */
  manager: Address;
}
interface Log { address: string; topics: Hex[]; data: Hex }

/** Observed topic of the fork's PoolCreated (its exact signature is not published). */
export const FLAUNCH_POOL_CREATED_TOPIC = '0xc6550fb368e63f84a610ca23004bbbcb73d7995d4d93af3f0fa6d6a90c171bc8' as Hex;
export const FLAUNCH_POOL_SWAP = '0x35001030bac7516ed5b1daf42bbfd3eaf587acc70c90f7f00ee42d5a34d75233' as Hex;
export const HYPERFORGE_COIN_CREATED = toEventSelector('CoinCreated(address,address,bytes32,string,string)');
export const TAX_LAUNCHED = toEventSelector('Launched(address,bytes32,address,address,uint256,int24)');
/** Observed topic of the unbranded launcher's launch event: topics token, poolId, creator (signature not published). */
export const UNBRANDED_LAUNCHED = '0xa60ab6fd8015fd59d85bd8c772ef0d57822ad96335b042e38864217fdef82e86' as Hex;
export const LAUNCH_TOPICS = [FLAUNCH_POOL_CREATED_TOPIC, HYPERFORGE_COIN_CREATED, TAX_LAUNCHED, UNBRANDED_LAUNCHED];

const word = (data: Hex, i: number) => BigInt(`0x${data.slice(2 + i * 64, 2 + (i + 1) * 64) || '0'}`);
const addr = (data: Hex, i: number) => getAddress(`0x${data.slice(2 + i * 64 + 24, 2 + (i + 1) * 64)}`);
const topicAddr = (t: Hex | undefined) => t ? getAddress(`0x${t.slice(26)}`) : null;
/** A dynamic string at byte offset `at` (length word, then bytes), or null when out of bounds. */
function str(data: Hex, at: number): string | null {
  const bytes = (data.length - 2) / 2;
  if (at < 0 || at + 32 > bytes) return null;
  const len = Number(word(data, at / 32));
  if (len > 256 || at + 32 + len > bytes) return null;
  try { return hexToString(`0x${data.slice(2 + (at + 32) * 2, 2 + (at + 32 + len) * 2)}`); } catch { return null; }
}
function native(token: Address, flipped: boolean, fee: number, tickSpacing: number, hooks: Address): V4PoolKey {
  return flipped ? { currency0: token, currency1: zeroAddress, fee, tickSpacing, hooks } : { currency0: zeroAddress, currency1: token, fee, tickSpacing, hooks };
}
const matches = (key: V4PoolKey, poolId: Hex) => v4PoolId(key).toLowerCase() === poolId.toLowerCase();

export function decodeLaunch(log: Log, registry: ElysiumRegistry): DecodedLaunch | null {
  const t0 = log.topics[0], uniswap = registry.address('uniswapV4.poolManager');
  try {
    if (t0 === FLAUNCH_POOL_CREATED_TOPIC) {
      // Only the fork's own hook announces its pools.
      const hook = registry.address('flaunchFork.hook');
      if (log.address.toLowerCase() !== hook.toLowerCase() || !log.topics[1]) return null;
      const poolId = log.topics[1];
      const token = addr(log.data, 0), flipped = word(log.data, 3) !== 0n, struct = Number(word(log.data, 5));
      const head = struct / 32;
      const creator = addr(log.data, head + 4);
      const key = native(token, flipped, 0, 60, hook);
      if (!matches(key, poolId)) return null;
      return { launchpad: 'flaunch', token, creator, poolId, key, flipped, supply: 0n, manager: uniswap,
        name: str(log.data, struct + Number(word(log.data, head))), symbol: str(log.data, struct + Number(word(log.data, head + 1))) };
    }
    if (t0 === HYPERFORGE_COIN_CREATED) {
      const token = topicAddr(log.topics[1]), creator = topicAddr(log.topics[2]), poolId = log.topics[3];
      if (!token || !creator || !poolId) return null;
      const key = native(token, false, 10_000, 200, zeroAddress);
      if (!matches(key, poolId)) return null;
      const [name, symbol] = decodeAbiParameters([{ type: 'string' }, { type: 'string' }], log.data);
      return { launchpad: 'hyperforge', token, creator, poolId, key, flipped: false, supply: 0n, manager: uniswap, name: name.slice(0, 256), symbol: symbol.slice(0, 64) };
    }
    if (t0 === TAX_LAUNCHED) {
      if (log.address.toLowerCase() !== registry.address('otherLaunchpads.taxLaunchFactory').toLowerCase()) return null;
      const token = topicAddr(log.topics[1]), poolId = log.topics[2], creator = topicAddr(log.topics[3]);
      if (!token || !creator || !poolId) return null;
      const [quote, launchSupply, tickSpacing] = decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'int24' }], log.data);
      if (quote !== zeroAddress) return null;
      const hook = registry.address('otherLaunchpads.taxLaunchHook');
      // Its pools take a dynamic fee (0x800000) or none; whichever hashes to the pool id is the key.
      const key = [0x800000, 0].map(fee => native(token, false, fee, tickSpacing, hook)).find(k => matches(k, poolId));
      if (!key) return null;
      return { launchpad: 'taxlaunch', token, creator, poolId, key, flipped: false, supply: launchSupply, manager: uniswap, name: null, symbol: null };
    }
    if (t0 === UNBRANDED_LAUNCHED) {
      if (log.address.toLowerCase() !== registry.address('unbrandedLauncher.launcher').toLowerCase()) return null;
      const token = topicAddr(log.topics[1]), poolId = log.topics[2], creator = topicAddr(log.topics[3]);
      if (!token || !creator || !poolId) return null;
      const [quote, name, symbol] = decodeAbiParameters([{ type: 'address' }, { type: 'string' }, { type: 'string' }], log.data);
      if (quote !== zeroAddress) return null;
      const key = native(token, false, 0, 200, registry.address('unbrandedLauncher.hook'));
      if (!matches(key, poolId)) return null;
      // Supply is 1e27, nearly all minted to the pool (the rest burned): summed from the mints.
      return { launchpad: 'unbranded', token, creator, poolId, key, flipped: false, supply: 0n, manager: registry.address('unbrandedLauncher.poolManager'),
        name: name.slice(0, 256), symbol: symbol.slice(0, 64) };
    }
  } catch { return null; }
  return null;
}

/**
 * One Flaunch-fork PoolSwap as the swapper saw it. Twelve signed amounts: fair-launch, internal-pool and Uniswap legs,
 * each (amount0, amount1, fee0, fee1), in the swapper's sign (negative paid in). The legs sum to the whole trade; fees
 * come off what the swapper receives. Checked against the buyer's token transfer on mainnet.
 */
export function flaunchTrade(data: Hex, flipped: boolean): { side: 'buy' | 'sell'; hype: number; tokens: number; priceHype: number } | null {
  const v = Array.from({ length: 12 }, (_, i) => { const x = word(data, i); return x >= 1n << 255n ? x - (1n << 256n) : x; });
  const sum = (o: number) => v[o]! + v[o + 4]! + v[o + 8]!;
  const [a0, a1, f0, f1] = [sum(0), sum(1), sum(2), sum(3)];
  const [hype, token, hypeFee, tokenFee] = flipped ? [a1, a0, f1, f0] : [a0, a1, f0, f1];
  if (hype === 0n || token === 0n || (hype < 0n) === (token < 0n)) return null;
  const n = (x: bigint) => Number(x < 0n ? -x : x) / 1e18;
  const buy = hype < 0n;
  const gross = n(hype) / n(token);
  return buy ? { side: 'buy', hype: n(hype), tokens: n(token + tokenFee), priceHype: gross } : { side: 'sell', hype: n(hype + hypeFee), tokens: n(token), priceHype: gross };
}
