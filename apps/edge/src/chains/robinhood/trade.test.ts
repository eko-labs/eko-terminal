import { describe, expect, it } from 'vitest';
import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, getAddress, keccak256, parseAbi, toFunctionSelector, zeroAddress, type Address, type Hex } from 'viem';
import { v4PoolId } from '@eko/chain';
import { buildRobinhoodSwap, loadRobinhoodTradeAddresses, PERMIT2_TTL_SEC, PONS_CURVE_ABI, ponsBuyOut, ponsPoolKey, ponsSellOut, robinhoodApprovals, robinhoodApprovalTx,
  robinhoodFill, robinhoodHeldApprovals, robinhoodQuote, robinhoodRoute, universalRouterAbi, v4QuoterAbi, type PonsCurveState, type RobinhoodRoute } from './trade.js';

const a = loadRobinhoodTradeAddresses();
const token = getAddress('0x00000000000000000000000000000000000c0115'), curve = getAddress('0x000000000000000000000000000000000000c0e5');
const wallet = getAddress('0x00000000000000000000000000000000000ab0ba'), other = getAddress('0x00000000000000000000000000000000000ab0bb');
const curveRoute: RobinhoodRoute = { kind: 'curve', curve, token };
const key = ponsPoolKey(token, a.ponsHook);
const v4Route: RobinhoodRoute = { kind: 'v4', key, token: key.currency1 };
const ADDRESS_THIS = '0x0000000000000000000000000000000000000002';
const sixField = [{ type: 'tuple', components: [{ type: 'tuple', name: 'poolKey', components: [{ name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' },
  { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }] }, { name: 'zeroForOne', type: 'bool' }, { name: 'amountIn', type: 'uint128' },
  { name: 'amountOutMinimum', type: 'uint128' }, { name: 'reserved', type: 'uint256' }, { name: 'hookData', type: 'bytes' }] }] as const;
const addr2 = [{ type: 'address' }, { type: 'uint256' }] as const, addr3 = [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }] as const;
const word = (n: bigint) => encodeAbiParameters([{ type: 'uint256' }], [n]);
const lc = (s: string) => s.toLowerCase();

describe('registry addresses', () => {
  it('reads the verified 4663 trade addresses', () => {
    expect(a).toMatchObject({ universalRouter: '0x204FAca1764B154221e35c0d20aBb3c525710498', permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
      poolManager: '0x8366a39CC670B4001A1121B8F6A443A643e40951', quoter: '0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94', weth: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
      ponsHook: '0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044' });
  });
  it('refuses another chain, a TODO or an unverified entry', () => {
    const doc = (router: string, extra = 'verified: 2026-10-06') => `chainId: 4663\nuniswapV4:\n  universalRouter: { address: ${router}, ${extra} }\n  permit2: { address: "0x000000000022D473030F116dDEE9F6B43aC78BA3", verified: 2026-10-06 }\n  poolManager: { address: "0x8366a39CC670B4001A1121B8F6A443A643e40951", verified: 2026-10-06 }\n  v4Quoter: { address: "0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94", verified: 2026-10-06 }\ntokens:\n  WETH: { address: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", verified: 2026-09-28 }\npons:\n  v4Hook: { address: "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044", verified: 2026-10-01 }\n  factory: { address: "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e", verified: 2026-10-01 }\n`;
    expect(loadRobinhoodTradeAddresses(doc('"0x204FAca1764B154221e35c0d20aBb3c525710498"')).universalRouter).toBe('0x204FAca1764B154221e35c0d20aBb3c525710498');
    expect(() => loadRobinhoodTradeAddresses(doc('TODO'))).toThrow(/universalRouter/);
    expect(() => loadRobinhoodTradeAddresses(doc('"0x204FAca1764B154221e35c0d20aBb3c525710498"', 'check: code'))).toThrow(/universalRouter/);
    expect(() => loadRobinhoodTradeAddresses(doc('"0x204FAca1764B154221e35c0d20aBb3c525710498"').replace('4663', '99901'))).toThrow(/4663/);
  });
});

describe('buildRobinhoodSwap', () => {
  it('calls the curve directly: a payable buy and a sell, both to the wallet', () => {
    const buy = buildRobinhoodSwap(curveRoute, 'buy', 5n * 10n ** 14n, 123n, wallet, 1n, a);
    expect(buy).toMatchObject({ to: curve, value: 5n * 10n ** 14n });
    expect(buy.data.slice(0, 10)).toBe('0x59a87bc1');
    expect(decodeFunctionData({ abi: PONS_CURVE_ABI, data: buy.data }).args).toEqual([5n * 10n ** 14n, 123n, wallet]);
    const sell = buildRobinhoodSwap(curveRoute, 'sell', 10n ** 22n, 7n, wallet, 1n, a);
    expect(sell).toMatchObject({ to: curve, value: 0n });
    expect(sell.data.slice(0, 10)).toBe('0xd04c6983');
    expect(decodeFunctionData({ abi: PONS_CURVE_ABI, data: sell.data }).args).toEqual([10n ** 22n, 7n, wallet]);
    expect([toFunctionSelector('buy(uint256,uint256,address)'), toFunctionSelector('sell(uint256,uint256,address)')]).toEqual(['0x59a87bc1', '0xd04c6983']);
  });

  it('buys on v4: one V4_SWAP of SWAP_EXACT_IN_SINGLE (six fields), SETTLE_ALL ETH, TAKE the coin to the wallet', () => {
    const tx = buildRobinhoodSwap(v4Route, 'buy', 10n ** 15n, 999n, wallet, 1_800_000_000n, a);
    expect(tx).toMatchObject({ to: a.universalRouter, value: 10n ** 15n });
    const { args: [commands, inputs, deadline] } = decodeFunctionData({ abi: universalRouterAbi, data: tx.data });
    expect([commands, inputs.length, deadline]).toEqual(['0x10', 1, 1_800_000_000n]);
    const [actions, params] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], inputs[0]!);
    expect(actions).toBe('0x060c0e');
    const [swap] = decodeAbiParameters(sixField, params[0]!);
    expect(swap).toEqual({ poolKey: key, zeroForOne: true, amountIn: 10n ** 15n, amountOutMinimum: 999n, reserved: 0n, hookData: '0x' });
    expect(decodeAbiParameters(addr2, params[1]!)).toEqual([zeroAddress, 10n ** 15n]);
    expect(decodeAbiParameters(addr3, params[2]!)).toEqual([key.currency1, wallet, 0n]);
  });

  it('sells on v4: the ETH goes to the router, is wrapped, then unwrapped to the wallet with the minimum', () => {
    const tx = buildRobinhoodSwap(v4Route, 'sell', 10n ** 21n, 555n, wallet, 1_800_000_000n, a);
    expect(tx).toMatchObject({ to: a.universalRouter, value: 0n });
    const { args: [commands, inputs] } = decodeFunctionData({ abi: universalRouterAbi, data: tx.data });
    expect(commands).toBe('0x100b0c');
    const [actions, params] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], inputs[0]!);
    expect(actions).toBe('0x060c0e');
    expect(decodeAbiParameters(sixField, params[0]!)[0]).toMatchObject({ zeroForOne: false, amountIn: 10n ** 21n, amountOutMinimum: 555n, reserved: 0n });
    expect(decodeAbiParameters(addr2, params[1]!)).toEqual([key.currency1, 10n ** 21n]);
    expect(decodeAbiParameters(addr3, params[2]!)).toEqual([zeroAddress, ADDRESS_THIS, 0n]);
    expect(decodeAbiParameters(addr2, inputs[1]!)).toEqual([ADDRESS_THIS, 1n << 255n]);
    expect(decodeAbiParameters(addr2, inputs[2]!)).toEqual([wallet, 555n]);
  });

  it('refuses router sentinels as recipients, non-native or foreign pools, and bad amounts', () => {
    expect(() => buildRobinhoodSwap(curveRoute, 'buy', 1n, 1n, '0x0000000000000000000000000000000000000001', 1n, a)).toThrow(/wallet/);
    expect(() => buildRobinhoodSwap({ ...v4Route, key: { ...key, currency0: a.weth } }, 'buy', 1n, 1n, wallet, 1n, a)).toThrow(/native/);
    expect(() => buildRobinhoodSwap({ ...v4Route, token: other }, 'buy', 1n, 1n, wallet, 1n, a)).toThrow(/native/);
    expect(() => buildRobinhoodSwap(curveRoute, 'buy', 0n, 1n, wallet, 1n, a)).toThrow(/amounts/);
    expect(() => buildRobinhoodSwap(v4Route, 'sell', 2n ** 128n, 1n, wallet, 1n, a)).toThrow(/amounts/);
  });
});

describe('robinhoodApprovals', () => {
  it('needs none to buy, the exact amount to the curve to sell there, and exact short-lived Permit2 for v4', () => {
    expect(robinhoodApprovals(curveRoute, 'buy', 5n, a)).toEqual([]);
    expect(robinhoodApprovals(v4Route, 'buy', 5n, a)).toEqual([]);
    expect(robinhoodApprovals(curveRoute, 'sell', 5n, a)).toEqual([{ kind: 'erc20', token, spender: curve, amount: '5' }]);
    expect(robinhoodApprovals(v4Route, 'sell', 5n, a, 1_000)).toEqual([
      { kind: 'erc20', token: key.currency1, spender: a.permit2, amount: '5' },
      { kind: 'permit2', token: key.currency1, spender: a.universalRouter, amount: '5', expiration: 1_000 + PERMIT2_TTL_SEC }]);
    expect(() => robinhoodApprovals(v4Route, 'sell', 2n ** 160n - 1n, a)).toThrow();
  });
  it('encodes each approval as its exact call', () => {
    const [erc20, permit2] = robinhoodApprovals(v4Route, 'sell', 77n, a, 1_000);
    const abi = parseAbi(['function approve(address spender, uint256 amount)', 'function approve(address token, address spender, uint160 amount, uint48 expiration)']);
    const e = robinhoodApprovalTx(erc20!, a), p = robinhoodApprovalTx(permit2!, a);
    expect(e.to).toBe(key.currency1);
    expect(decodeFunctionData({ abi, data: e.data }).args).toEqual([a.permit2, 77n]);
    expect(p.to).toBe(a.permit2);
    expect(decodeFunctionData({ abi, data: p.data }).args).toEqual([key.currency1, a.universalRouter, 77n, 1_000 + PERMIT2_TTL_SEC]);
  });
  it('drops approvals already held, keeps short or expiring ones', async () => {
    const rpc = mockRpc({ [`${lc(key.currency1)}:allowance`]: word(77n), [`${lc(a.permit2)}:allowance`]: encodeAbiParameters([{ type: 'uint160' }, { type: 'uint48' }, { type: 'uint48' }], [77n, 1_100, 0]) });
    const held = await robinhoodHeldApprovals(rpc, wallet, robinhoodApprovals(v4Route, 'sell', 77n, a, 1_000), a, 1_000);
    expect(held.map(h => h.kind)).toEqual(['permit2']); // ERC-20 held; the Permit2 allowance ends within two minutes
    expect((await robinhoodHeldApprovals(rpc, wallet, robinhoodApprovals(v4Route, 'sell', 78n, a), a, 1_000)).length).toBe(2);
  });
});

/** An eth_call mock answering by `${to}:${function}`; anything else rejects. */
function mockRpc(answers: Record<string, Hex>) {
  const names = new Map<string, string>();
  for (const f of [...PONS_CURVE_ABI, ...v4QuoterAbi, ...parseAbi(['function allowance(address,address) view returns (uint256)', 'function allowance(address,address,address) view returns (uint160,uint48,uint48)',
    'function extsload(bytes32) view returns (bytes32)'])]) if (f.type === 'function') names.set(toFunctionSelector(f), f.name);
  const calls: { to: string; data: Hex }[] = [];
  return { calls, async request(i: { method: string; params: readonly unknown[] }) {
    const { to, data } = i.params[0] as { to: string; data: Hex };
    calls.push({ to, data });
    const answer = answers[`${lc(to)}:${names.get(data.slice(0, 10))}`] ?? answers[`${lc(to)}:${data}`];
    if (!answer) throw new Error(`unexpected call ${to} ${data.slice(0, 10)}`);
    return answer;
  } };
}
const state: PonsCurveState = { quoteReserve: 1_680_580_020_849_616_636n, tokenReserve: 999_654_868_651_048_584_023_665_341n, sellable: 713_940_582_936_762_869_737_951_056n,
  realQuote: 580_020_849_616_636n, feeBps: 100n, creatorTaxBps: 100n, snipeTaxBps: 0n, graduated: false, readyToGraduate: false };
const curveAnswers = (s: PonsCurveState, t = token) => ({
  [`${lc(curve)}:graduated`]: word(s.graduated ? 1n : 0n), [`${lc(curve)}:readyToGraduate`]: word(s.readyToGraduate ? 1n : 0n),
  [`${lc(curve)}:token`]: encodeAbiParameters([{ type: 'address' }], [t]), [`${lc(curve)}:pairToken`]: encodeAbiParameters([{ type: 'address' }], [zeroAddress]),
  [`${lc(curve)}:getReserves`]: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [s.quoteReserve, s.tokenReserve]),
  [`${lc(curve)}:sellableTokens`]: word(s.sellable), [`${lc(curve)}:realQuoteReserve`]: word(s.realQuote), [`${lc(curve)}:feeBps`]: word(s.feeBps),
  [`${lc(curve)}:creatorTaxBps`]: word(s.creatorTaxBps), [`${lc(curve)}:currentSnipeTaxBps`]: word(s.snipeTaxBps),
});

describe('curve math and quotes', () => {
  it('floors fee and tax from the gross leg, then prices on the reserves', () => {
    const b = ponsBuyOut(state, 1_000_000n);
    expect([b.fee, b.tax, b.net]).toEqual([10_000n, 10_000n, 980_000n]);
    expect(b.tokens).toBe(980_000n * state.tokenReserve / (state.quoteReserve + 980_000n));
    const s = ponsSellOut(state, 10n ** 23n), gross = 10n ** 23n * state.quoteReserve / (state.tokenReserve + 10n ** 23n);
    expect(s).toEqual({ gross, fee: gross / 100n, tax: gross / 100n, out: gross - 2n * (gross / 100n), capacity: true });
    // The anti-snipe tax is charged with the fee; a buy that would take the last sellable tokens completes the curve.
    expect(ponsBuyOut({ ...state, snipeTaxBps: 500n }, 1_000_000n).fee).toBe(60_000n);
    expect(ponsBuyOut(state, 10n ** 19n).completes).toBe(true);
    expect(ponsSellOut(state, 10n ** 26n).capacity).toBe(false);
  });

  it('quotes the curve from its live reserves', async () => {
    const rpc = mockRpc(curveAnswers(state));
    const buy = await robinhoodQuote(rpc, curveRoute, 'buy', 5n * 10n ** 14n, a);
    expect(buy.expectedOut).toBe(ponsBuyOut(state, 5n * 10n ** 14n).tokens);
    expect(buy.feeBps).toBe(200);
    expect(buy.priceImpactBps).toBe(2.91); // net 4.9e14 against Q + net ≈ 1.68107e18, floored to 0.01 bps
    const sell = await robinhoodQuote(rpc, curveRoute, 'sell', 10n ** 23n, a);
    expect(sell.expectedOut).toBe(ponsSellOut(state, 10n ** 23n).out);
    await expect(robinhoodQuote(rpc, curveRoute, 'buy', 10n ** 19n, a)).rejects.toMatchObject({ code: 'route_unavailable' });
    await expect(robinhoodQuote(mockRpc(curveAnswers({ ...state, readyToGraduate: true })), curveRoute, 'buy', 1n, a)).rejects.toMatchObject({ code: 'route_unavailable' });
    await expect(robinhoodQuote(mockRpc(curveAnswers(state, other)), curveRoute, 'buy', 1n, a)).rejects.toMatchObject({ code: 'route_unavailable' });
  });

  it('quotes v4 through the quoter, impact against a 1/1000 quote and fees against slot0', async () => {
    const sqrt = 2n ** 96n * 3000n; // 9,000,000 coin per wei
    const slot = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [v4PoolId(key), 6n]));
    const answers: Record<string, Hex> = { [`${lc(a.poolManager)}:extsload`]: encodeAbiParameters([{ type: 'uint256' }], [sqrt]) };
    const rpc = mockRpc(answers);
    const quoter = rpc.request.bind(rpc);
    // The full size pays 3% fee and moves the price 1%; the 1/1000 size pays only the fee.
    rpc.request = async i => {
      const { to, data } = i.params[0] as { to: string; data: Hex };
      if (lc(to) === lc(a.quoter)) {
        const { args: [p] } = decodeFunctionData({ abi: v4QuoterAbi, data });
        const atPrice = p.exactAmount * 9_000_000n, out = atPrice * 97n / 100n * (p.exactAmount === 10n ** 15n ? 99n : 100n) / 100n;
        return encodeFunctionResult({ abi: v4QuoterAbi, functionName: 'quoteExactInputSingle', result: [out, 100_000n] });
      }
      return quoter(i);
    };
    const q = await robinhoodQuote(rpc, v4Route, 'buy', 10n ** 15n, a);
    expect(q.expectedOut).toBe(10n ** 15n * 9_000_000n * 97n / 100n * 99n / 100n);
    expect(q.priceImpactBps).toBe(100);
    expect(q.feeBps).toBe(300);
    expect(rpc.calls.some(c => c.data.includes(slot.slice(2)))).toBe(true);
  });
});

/** Log builders for synthetic receipts. */
const transferAbi = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)', 'event Withdrawal(address indexed src, uint256 wad)']);
const log = (address: Address, abi: readonly unknown[], eventName: string, args: Record<string, unknown>, data: Hex) =>
  ({ address, topics: (encodeEventTopics as (p: object) => Hex[])({ abi, eventName, args }), data });
const transfer = (t: Address, from: Address, to: Address, v: bigint) => log(t, transferAbi, 'Transfer', { from, to }, word(v));
const curveEvent = (name: 'CurveBuy' | 'CurveSell', party: Address, amounts: [bigint, bigint, bigint, bigint]) =>
  log(curve, PONS_CURVE_ABI, name, name === 'CurveBuy' ? { buyer: party, recipient: party } : { seller: party, recipient: party },
    encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], amounts));
const swapLog = (sender: Address, amount0: bigint, amount1: bigint) => log(a.poolManager, parseAbi(['event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)']),
  'Swap', { id: v4PoolId(key), sender }, encodeAbiParameters([{ type: 'int128' }, { type: 'int128' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }, { type: 'uint24' }], [amount0, amount1, 1n, 1n, 0, 0]));
const ok = (...logs: { address: string; topics: Hex[]; data: Hex }[]) => ({ status: '0x1' as Hex, logs });

describe('robinhoodFill', () => {
  it('reads a curve buy and sell from their events and the coin transfers', () => {
    expect(robinhoodFill(ok(transfer(token, curve, wallet, 900n), curveEvent('CurveBuy', wallet, [1000n, 900n, 10n, 10n])), curveRoute, 'buy', wallet, a))
      .toEqual({ filledIn: 1000n, filledOut: 900n });
    expect(robinhoodFill(ok(transfer(token, wallet, curve, 450n), curveEvent('CurveSell', wallet, [450n, 480n, 5n, 5n])), curveRoute, 'sell', wallet, a))
      .toEqual({ filledIn: 450n, filledOut: 480n });
  });
  it('counts what the wallet received, not the event, when the coin takes a transfer tax', () => {
    expect(robinhoodFill(ok(transfer(token, curve, wallet, 880n), curveEvent('CurveBuy', wallet, [1000n, 900n, 10n, 10n])), curveRoute, 'buy', wallet, a)?.filledOut).toBe(880n);
  });
  it('refuses reverted receipts, another buyer, two legs, or no coin movement', () => {
    const buy = [transfer(token, curve, wallet, 900n), curveEvent('CurveBuy', wallet, [1000n, 900n, 10n, 10n])];
    expect(robinhoodFill({ status: '0x0', logs: buy }, curveRoute, 'buy', wallet, a)).toBeNull();
    expect(robinhoodFill(ok(...buy), curveRoute, 'buy', other, a)).toBeNull();
    expect(robinhoodFill(ok(...buy, buy[1]!), curveRoute, 'buy', wallet, a)).toBeNull();
    expect(robinhoodFill(ok(buy[1]!), curveRoute, 'buy', wallet, a)).toBeNull();
    expect(robinhoodFill(ok(...buy), curveRoute, 'sell', wallet, a)).toBeNull();
  });
  it('reads a v4 buy as the coin received only: the hook makes the pool amounts differ from the wallet', () => {
    const fill = robinhoodFill(ok(swapLog(a.universalRouter, -1000n, 990n), transfer(key.currency1, a.poolManager, a.ponsHook, 30n), transfer(key.currency1, a.poolManager, wallet, 960n)),
      v4Route, 'buy', wallet, a);
    expect(fill).toEqual({ filledOut: 960n });
  });
  it('reads a v4 sell payout from the router unwrap, as a burn Transfer or a WETH9 Withdrawal', () => {
    const base = [swapLog(a.universalRouter, 500n, -1000n), transfer(key.currency1, wallet, a.poolManager, 1000n)];
    const wrap = transfer(a.weth, zeroAddress, a.universalRouter, 485n), burn = transfer(a.weth, a.universalRouter, zeroAddress, 485n);
    expect(robinhoodFill(ok(...base, wrap, burn), v4Route, 'sell', wallet, a)).toEqual({ filledIn: 1000n, filledOut: 485n });
    expect(robinhoodFill(ok(...base, log(a.weth, transferAbi, 'Withdrawal', { src: a.universalRouter }, word(485n))), v4Route, 'sell', wallet, a))
      .toEqual({ filledIn: 1000n, filledOut: 485n });
    // Without the unwrap the payout is not in the logs: the integrator measures the balance change.
    expect(robinhoodFill(ok(...base), v4Route, 'sell', wallet, a)).toEqual({ filledIn: 1000n });
  });
  it('refuses a v4 receipt without exactly one Swap on this pool by the router', () => {
    const coin = transfer(key.currency1, a.poolManager, wallet, 960n);
    expect(robinhoodFill(ok(coin), v4Route, 'buy', wallet, a)).toBeNull();
    expect(robinhoodFill(ok(swapLog(other, -1000n, 990n), coin), v4Route, 'buy', wallet, a)).toBeNull();
    expect(robinhoodFill(ok(swapLog(a.universalRouter, -1000n, 990n), swapLog(a.universalRouter, -1n, 1n), coin), v4Route, 'buy', wallet, a)).toBeNull();
  });
  it('uses the registry addresses when none are passed', () => {
    expect(robinhoodFill(ok(swapLog(a.universalRouter, -1000n, 990n), transfer(key.currency1, a.poolManager, wallet, 960n)), v4Route, 'buy', wallet)).toEqual({ filledOut: 960n });
  });
});

describe('robinhoodRoute', () => {
  it('routes an open curve to the curve, a graduated one to its Pons pool, and refuses one in between', async () => {
    expect(await robinhoodRoute(mockRpc(curveAnswers(state)), { token, curve }, a)).toEqual({ kind: 'curve', curve, token });
    const graduated = { ...curveAnswers({ ...state, graduated: true }), [`${lc(a.poolManager)}:extsload`]: word(2n ** 96n) };
    expect(await robinhoodRoute(mockRpc(graduated), { token, curve }, a)).toEqual({ kind: 'v4', key, token: key.currency1 });
    expect(key).toEqual({ currency0: zeroAddress, currency1: key.currency1, fee: 0, tickSpacing: 200, hooks: a.ponsHook });
    await expect(robinhoodRoute(mockRpc({ ...graduated, [`${lc(a.poolManager)}:extsload`]: word(0n) }), { token, curve }, a)).rejects.toMatchObject({ code: 'route_unavailable' });
    await expect(robinhoodRoute(mockRpc(curveAnswers({ ...state, readyToGraduate: true })), { token, curve }, a)).rejects.toMatchObject({ code: 'route_unavailable' });
  });
});
