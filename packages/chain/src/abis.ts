import { parseAbi } from 'viem';
import pons from '../abi/pons/events.json' with { type: 'json' };
export const v3Abi = parseAbi([
  'event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)',
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
  'event Initialize(uint160 sqrtPriceX96, int24 tick)',
  'event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)',
  'event Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)',
]);
// Solidity user-defined types resolve to bytes32 (PoolId) and address (Currency/IHooks).
export const v4Abi = parseAbi([
  'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
  'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)',
  'event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)',
  'event Donate(bytes32 indexed id, address indexed sender, uint256 amount0, uint256 amount1)',
]);
// All four topics are pinned in the v4 PoolManager RPC fixtures.
export const verifiedV4Events = ['Initialize', 'Swap', 'ModifyLiquidity', 'Donate'] as const;
export const erc20Abi = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']);
export const wethAbi = parseAbi(['event Deposit(address indexed dst, uint256 wad)', 'event Withdrawal(address indexed src, uint256 wad)']);
export const ponsFactoryAbi = parseAbi(pons.factory);
export const ponsCurveAbi = parseAbi(pons.curve);
