import { parseAbi, toEventSelector } from 'viem';

/** Uniswap v4's PoolManager Swap and the ERC-20 Transfer: the same on every chain EKO serves (tracker.ts re-exports them). */
export const swapAbi = parseAbi(['event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)']);
export const SWAP_TOPIC = toEventSelector(swapAbi[0]);
/** ERC-20 Transfer(address indexed from, address indexed to, uint256 value). */
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
