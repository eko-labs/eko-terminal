import { decodeEventLog, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, parseAbi, zeroAddress, type Address, type Hex } from 'viem';
import type { ElysiumRegistry, V4PoolKey } from '@eko/chain';
import { swapAbi, TRANSFER_TOPIC } from '../logs.js';
import type { TradeVenue } from '../types.js';

/**
 * Wallet trading on Elysium: a coin's Uniswap v4 pool through the Universal Router, in the shape Elysium's own swaps use
 * (decoded from mainnet transactions, 2026-11-11): one V4_SWAP command with SETTLE (pay in: native HYPE from the call's
 * value on a buy, the coin through Permit2 on a sell), then SWAP_EXACT_IN_SINGLE (the minimum out is enforced inside the
 * swap), then TAKE (the whole output to whoever signs: MSG_SENDER).
 */
export const universalRouterAbi = parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable']);
export const v4QuoterAbi = parseAbi(['function quoteExactInputSingle(((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)']);

const V4_SWAP = '0x10', SETTLE = 0x0b, SWAP_EXACT_IN_SINGLE = 0x06, TAKE = 0x0e;
/** v4-periphery ActionConstants.MSG_SENDER: the router pays TAKE's output to the account that called execute(). */
export const MSG_SENDER: Address = '0x0000000000000000000000000000000000000001';
const poolKeyType = { type: 'tuple', components: [{ name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }] } as const;
const fail = (message: string, code: string, status: number) => Object.assign(new Error(message), { code, status });

/** The Universal Router call for one exact-in swap on a native-HYPE pool (currency0 is HYPE). */
export function buildSwap(key: V4PoolKey, side: 'buy' | 'sell', amountIn: bigint, minOut: bigint, recipient: Address, deadline: bigint): { data: Hex; value: bigint } {
  if (key.currency0 !== zeroAddress) throw new Error('Only native-HYPE pools are traded');
  const buy = side === 'buy', input = buy ? key.currency0 : key.currency1, output = buy ? key.currency1 : key.currency0;
  const settle = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'bool' }], [input, amountIn, !buy]);
  const swap = encodeAbiParameters([{ type: 'tuple', components: [{ name: 'poolKey', ...poolKeyType }, { name: 'zeroForOne', type: 'bool' }, { name: 'amountIn', type: 'uint128' }, { name: 'amountOutMinimum', type: 'uint128' },
    { name: 'reserved', type: 'uint256' }, { name: 'hookData', type: 'bytes' }] }], [{ poolKey: key, zeroForOne: buy, amountIn, amountOutMinimum: minOut, reserved: 0n, hookData: '0x' }]);
  const take = encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], [output, recipient, 0n]);
  const actions = `0x${[SETTLE, SWAP_EXACT_IN_SINGLE, TAKE].map(a => a.toString(16).padStart(2, '0')).join('')}` as Hex;
  const v4 = encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [actions, [settle, swap, take]]);
  return { data: encodeFunctionData({ abi: universalRouterAbi, functionName: 'execute', args: [V4_SWAP, [v4], deadline] }), value: buy ? amountIn : 0n };
}

export function elysiumTrade(registry: ElysiumRegistry): TradeVenue {
  const router = registry.address('uniswapV4.universalRouter212'), permit2 = registry.address('uniswapV4.permit2');
  const manager = registry.address('uniswapV4.poolManager'), quoter = registry.address('uniswapV4.v4Quoter');
  return {
    routers: [router], spenders: [permit2], permit2,
    precheck(coin) {
      // The Universal Router trades only in Uniswap's own PoolManager (not the unbranded launcher's fork).
      if (coin.manager.toLowerCase() !== manager.toLowerCase()) throw fail('This coin trades in a PoolManager EKO cannot route to yet.', 'route_unavailable', 409);
    },
    route(coin, a) {
      const key = a?.key;
      if (!a || !key || key.currency0 !== zeroAddress) throw fail('This coin\'s pool could not be read; try again shortly.', 'route_unavailable', 503);
      return { kind: 'v4', key, token: coin.token };
    },
    async quote(rpc, route, side, amountIn) {
      if (route.kind !== 'v4') throw fail('Elysium trades only v4 pools.', 'route_unavailable', 409);
      const out = await rpc.request({ method: 'eth_call', params: [{ to: quoter, data: encodeFunctionData({ abi: v4QuoterAbi, functionName: 'quoteExactInputSingle',
        args: [{ poolKey: route.key, zeroForOne: side === 'buy', exactAmount: amountIn, hookData: '0x' }] }) }, 'latest'] }) as Hex;
      const [expectedOut, gas] = decodeFunctionResult({ abi: v4QuoterAbi, functionName: 'quoteExactInputSingle', data: out });
      return { expectedOut, gas };
    },
    build(route, side, amountIn, minOut, deadline) {
      if (route.kind !== 'v4') throw fail('Elysium trades only v4 pools.', 'route_unavailable', 409);
      // The output goes to whoever signs (the Universal Router's MSG_SENDER), never to an address named in the request.
      return { to: router, ...buildSwap(route.key, side, amountIn, minOut, MSG_SENDER, deadline) };
    },
    approvals(route, side, amountIn, expiration) {
      // A sell pays the coin in through Permit2: the token approves Permit2, and Permit2 allows the router until `expiration`.
      return side === 'buy' ? [] : [{ kind: 'erc20', token: route.token, spender: permit2, amount: amountIn.toString() },
        { kind: 'permit2', token: route.token, spender: router, amount: amountIn.toString(), expiration }];
    },
    fill(receipt, route, side, wallet) {
      let filledIn: bigint | undefined, filledOut: bigint | undefined;
      const coin = route.token.toLowerCase(), w = wallet.toLowerCase();
      for (const l of receipt.logs) {
        if (l.topics[0] === TRANSFER_TOPIC && l.address.toLowerCase() === coin && l.topics.length === 3) {
          const from = `0x${l.topics[1]!.slice(26)}`, to = `0x${l.topics[2]!.slice(26)}`, v = BigInt(l.data.slice(0, 66));
          if (side === 'buy' && to === w) filledOut = v; if (side === 'sell' && from === w) filledIn = v;
        }
        if (l.address.toLowerCase() === manager.toLowerCase()) {
          try {
            const { args } = decodeEventLog({ abi: swapAbi, topics: l.topics as [Hex, ...Hex[]], data: l.data });
            const hype = args.amount0 < 0n ? -args.amount0 : args.amount0;
            if (side === 'buy') filledIn = hype; else filledOut = hype;
          } catch { /* not a Swap */ }
        }
      }
      return { ...(filledIn !== undefined ? { filledIn } : {}), ...(filledOut !== undefined ? { filledOut } : {}) };
    },
  };
}
