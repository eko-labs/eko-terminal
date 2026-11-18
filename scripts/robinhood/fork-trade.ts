/**
 * Robinhood trading, proven on a local anvil fork of Robinhood Chain (4663). Nothing touches mainnet but reads.
 *
 *   pnpm --filter @eko/edge exec node --import tsx ../../scripts/robinhood/fork-trade.ts
 *
 * Starts `anvil --fork-url $ROBINHOOD_RPC --chain-id 4663 --port 8548 --silent` (or uses FORK_RPC when set), mines a few
 * blocks, then picks a real Pons coin still on its curve and a graduated one (newest from the factory's TokenLaunched and
 * the PoolManager's Initialize logs; CURVE_COIN / GRADUATED_COIN override). For each, with a throwaway key funded by
 * anvil_setBalance, it buys about $1 of ETH worth and sells half, signing exactly what apps/edge/src/chains/robinhood/trade.ts
 * builds, and checks robinhoodFill against the wallet's real ETH and coin balance changes to the wei, gas included.
 * Exits 1 on any mismatch.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { buildRobinhoodSwap, loadRobinhoodTradeAddresses, ponsPoolKey, readPonsCurve, robinhoodApprovals, robinhoodApprovalTx, robinhoodFill,
  robinhoodHeldApprovals, robinhoodQuote, robinhoodRoute, type RobinhoodRoute } from '../../apps/edge/src/chains/robinhood/trade.ts';

// viem lives in the edge app's dependencies, not at the repo root.
const req = createRequire(new URL('../../apps/edge/package.json', import.meta.url));
const viem = await import(pathToFileURL(req.resolve('viem')).href);
const { privateKeyToAccount, generatePrivateKey } = await import(pathToFileURL(req.resolve('viem/accounts')).href);
type Address = `0x${string}`; type Hex = `0x${string}`;

const UPSTREAM = process.env.ROBINHOOD_RPC ?? 'https://rpc.mainnet.chain.robinhood.com';
const PORT = 8548;
let anvil: ChildProcess | undefined;
const FORK = process.env.FORK_RPC ?? `http://127.0.0.1:${PORT}`;
if (!process.env.FORK_RPC) {
  anvil = spawn('anvil', ['--fork-url', UPSTREAM, '--chain-id', '4663', '--port', String(PORT), '--silent'], { stdio: 'inherit' });
  process.on('exit', () => anvil?.kill());
}
const chain = viem.defineChain({ id: 4663, name: 'Robinhood Chain (fork)', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [FORK] } } });
const client = viem.createPublicClient({ chain, transport: viem.http(FORK) });
const rpc = { request: (i: { method: string; params: readonly unknown[] }) => client.request(i as never) as Promise<unknown> };
for (let i = 0; ; i++) {
  try { await client.getChainId(); break; } catch { if (i > 60) throw new Error(`No fork at ${FORK}`); await new Promise(r => setTimeout(r, 500)); }
}
await client.request({ method: 'anvil_mine', params: ['0x3'] } as never);

const a = loadRobinhoodTradeAddresses();
const erc20 = viem.parseAbi(['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)', 'function symbol() view returns (string)']);
const permit2 = viem.parseAbi(['function allowance(address,address,address) view returns (uint160,uint48,uint48)']);
const head: bigint = await client.getBlockNumber();
const ts = Number((await client.getBlock()).timestamp);

// ETH/USD from the Uniswap v3 WETH/USDG pools (QuoterV2), best fee tier; only sizes the $1 trade.
const quoterV2 = viem.parseAbi(['function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160, uint32, uint256)']);
let ethUsd = 0;
for (const fee of [100, 500, 3000, 10000]) {
  try {
    const { result } = await client.simulateContract({ address: '0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7', abi: quoterV2, functionName: 'quoteExactInputSingle',
      args: [{ tokenIn: a.weth, tokenOut: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', amountIn: 10n ** 16n, fee, sqrtPriceLimitX96: 0n }] });
    ethUsd = Math.max(ethUsd, Number(result[0]) / 1e6 * 100);
  } catch { /* no pool at this tier */ }
}
if (!(ethUsd > 100)) ethUsd = Number(process.env.ETH_USD ?? 3000);
const ONE_USD = BigInt(Math.round(1e18 / ethUsd));

// Coins: the newest open curve launched over 10 minutes ago, and the newest Pons graduation pool with a known curve.
const launched = viem.parseAbiItem('event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)');
const initialized = viem.parseAbiItem('event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)');
const getLogs = (p: object) => client.getLogs(p as never) as Promise<{ args: Record<string, unknown>; blockNumber: bigint }[]>;
async function curveOf(token: Address, before: bigint): Promise<Address | null> {
  for (let to = before; to > before - 6_000_000n; to -= 1_000_000n) {
    const logs = await getLogs({ address: a.ponsFactory, event: launched, args: { token }, fromBlock: to - 1_000_000n, toBlock: to });
    if (logs.length) return logs[0]!.args.curve as Address;
  }
  return null;
}
async function pickCurveCoin(): Promise<{ token: Address; curve: Address }> {
  if (process.env.CURVE_COIN) return { token: viem.getAddress(process.env.CURVE_COIN), curve: (await curveOf(viem.getAddress(process.env.CURVE_COIN), head))! };
  const logs = (await getLogs({ address: a.ponsFactory, event: launched, fromBlock: head - 100_000n, toBlock: head })).reverse();
  for (const l of logs) {
    const coin = { token: l.args.token as Address, curve: l.args.curve as Address };
    const block = await client.getBlock({ blockNumber: l.blockNumber });
    if (ts - Number(block.timestamp) < 600) continue;
    const s = await readPonsCurve(rpc, { kind: 'curve', ...coin }).catch(() => null);
    if (s && !s.graduated && !s.readyToGraduate && s.snipeTaxBps === 0n && s.sellable > s.tokenReserve / 4n) return coin;
  }
  throw new Error('No open Pons curve found');
}
async function pickGraduated(): Promise<{ token: Address; curve: Address }> {
  if (process.env.GRADUATED_COIN) return { token: viem.getAddress(process.env.GRADUATED_COIN), curve: (await curveOf(viem.getAddress(process.env.GRADUATED_COIN), head))! };
  const pools = (await getLogs({ address: a.poolManager, event: initialized, args: { currency0: viem.zeroAddress }, fromBlock: head - 2_000_000n, toBlock: head }))
    .filter(l => (l.args.hooks as string).toLowerCase() === a.ponsHook.toLowerCase()).reverse();
  for (const p of pools) {
    const token = p.args.currency1 as Address, curve = await curveOf(token, p.blockNumber);
    if (curve) return { token, curve };
  }
  throw new Error('No graduated Pons coin found');
}

const account = privateKeyToAccount(generatePrivateKey());
const wallet = viem.createWalletClient({ account, chain, transport: viem.http(FORK) });
await client.request({ method: 'anvil_setBalance', params: [account.address, viem.toHex(10n ** 18n)] } as never);

const eth = () => client.getBalance({ address: account.address }) as Promise<bigint>;
const coinBal = (token: Address) => client.readContract({ address: token, abi: erc20, functionName: 'balanceOf', args: [account.address] }) as Promise<bigint>;
async function send(tx: { to: Address; data: Hex; value: bigint }) {
  const hash = await wallet.sendTransaction({ ...tx, account });
  const r = await client.waitForTransactionReceipt({ hash });
  return { hash, receipt: r, gas: r.gasUsed * r.effectiveGasPrice, raw: await client.request({ method: 'eth_getTransactionReceipt', params: [hash] } as never) as { status: Hex; logs: { address: string; topics: Hex[]; data: Hex }[] } };
}
const failures: string[] = [], fixture: object[] = [];
const slim = (r: { status: Hex; logs: { address: string; topics: Hex[]; data: Hex }[] }) => ({ status: r.status, logs: r.logs.map(l => ({ address: l.address, topics: l.topics, data: l.data })) });
const check = (label: string, got: bigint | undefined, want: bigint) => {
  const ok = got === want;
  if (!ok) failures.push(label);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}: ${got ?? 'absent'}${ok ? '' : ` (expected ${want})`}`);
};

async function trade(label: string, coin: { token: Address; curve: Address }) {
  const route: RobinhoodRoute = await robinhoodRoute(rpc, coin, a);
  const symbol = await client.readContract({ address: coin.token, abi: erc20, functionName: 'symbol' }).catch(() => '?');
  console.log(`\n${label}: ${symbol} ${coin.token} (curve ${coin.curve}) → route ${route.kind}${route.kind === 'v4' ? ` fee ${route.key.fee} tickSpacing ${route.key.tickSpacing} hooks ${route.key.hooks}` : ''}`);
  if (route.kind === 'v4' && route.key.hooks !== ponsPoolKey(coin.token, a.ponsHook).hooks) throw new Error('Unexpected hook');
  const deadline = BigInt(ts + 600);

  // Buy about $1.
  const q = await robinhoodQuote(rpc, route, 'buy', ONE_USD, a);
  const minOut = q.expectedOut * 98n / 100n;
  const buy = buildRobinhoodSwap(route, 'buy', ONE_USD, minOut, account.address, deadline, a);
  if (robinhoodApprovals(route, 'buy', ONE_USD, a).length) failures.push(`${label} buy asked for approvals`);
  const stateBefore = route.kind === 'curve' ? await readPonsCurve(rpc, route) : null;
  const [e0, c0] = await Promise.all([eth(), coinBal(coin.token)]);
  const b = await send(buy);
  const [e1, c1] = await Promise.all([eth(), coinBal(coin.token)]);
  const bf = robinhoodFill(b.raw, route, 'buy', account.address);
  console.log(`  buy ${viem.formatEther(ONE_USD)} ETH ($1 at $${ethUsd.toFixed(0)}): quote ${q.expectedOut} impact ${q.priceImpactBps} bps fee ${q.feeBps} bps; tx ${b.hash} gas ${b.receipt.gasUsed}`);
  fixture.push({ label, side: 'buy', route, wallet: account.address, amountIn: ONE_USD, minOut, deadline, tx: buy, state: stateBefore, quote: q,
    receipt: slim(b.raw), gas: b.gas, ethDelta: e1 - e0, coinDelta: c1 - c0 });
  if (!bf) failures.push(`${label} buy fill unreadable`);
  // A v4 buy's filledIn is the transaction's value by design (absent from the fill).
  check(`${label} buy filledIn = ETH spent less gas`, bf?.filledIn ?? (route.kind === 'v4' ? buy.value : undefined), e0 - e1 - b.gas);
  check(`${label} buy filledOut = coin received`, bf?.filledOut, c1 - c0);
  console.log(`  ${q.expectedOut === c1 - c0 ? 'ok  ' : 'note'} quote vs fill: ${q.expectedOut} vs ${c1 - c0}`);

  // Sell half of what was bought: exact approvals first, then the sell.
  const half = (c1 - c0) / 2n;
  const sq = await robinhoodQuote(rpc, route, 'sell', half, a);
  const approvals = await robinhoodHeldApprovals(rpc, account.address, robinhoodApprovals(route, 'sell', half, a, ts), a, ts);
  for (const ap of approvals) {
    const r = await send(robinhoodApprovalTx(ap, a));
    console.log(`  approve ${ap.kind} ${ap.amount} → ${ap.spender}: tx ${r.hash}`);
  }
  const sell = buildRobinhoodSwap(route, 'sell', half, sq.expectedOut * 98n / 100n, account.address, deadline, a);
  const sellState = route.kind === 'curve' ? await readPonsCurve(rpc, route) : null;
  const [e2, c2] = await Promise.all([eth(), coinBal(coin.token)]);
  const s = await send(sell);
  const [e3, c3] = await Promise.all([eth(), coinBal(coin.token)]);
  const sf = robinhoodFill(s.raw, route, 'sell', account.address);
  console.log(`  sell ${half}: quote ${sq.expectedOut} wei impact ${sq.priceImpactBps} bps fee ${sq.feeBps} bps; tx ${s.hash} gas ${s.receipt.gasUsed}`);
  fixture.push({ label, side: 'sell', route, wallet: account.address, amountIn: half, minOut: sq.expectedOut * 98n / 100n, deadline, tx: sell, state: sellState, quote: sq,
    receipt: slim(s.raw), gas: s.gas, ethDelta: e3 - e2, coinDelta: c3 - c2 });
  if (!sf) failures.push(`${label} sell fill unreadable`);
  check(`${label} sell filledIn = coin sent`, sf?.filledIn, c2 - c3);
  check(`${label} sell filledOut = ETH received plus gas`, sf?.filledOut, e3 - e2 + s.gas);
  console.log(`  ${sq.expectedOut === e3 - e2 + s.gas ? 'ok  ' : 'note'} quote vs fill: ${sq.expectedOut} vs ${e3 - e2 + s.gas}`);
  // The approvals were exact: nothing is left behind.
  const left = route.kind === 'curve'
    ? await client.readContract({ address: coin.token, abi: erc20, functionName: 'allowance', args: [account.address, coin.curve] }) as bigint
    : (await client.readContract({ address: a.permit2, abi: permit2, functionName: 'allowance', args: [account.address, coin.token, a.universalRouter] }) as readonly [bigint])[0];
  check(`${label} allowance left after the sell`, left, 0n);
}

try {
  console.log(`fork ${FORK} of ${UPSTREAM} at block ${head}; wallet ${account.address} (throwaway, 1 ETH from anvil_setBalance)`);
  await trade('curve', await pickCurveCoin());
  await trade('graduated', await pickGraduated());
} catch (e) { failures.push(String((e as Error).stack ?? e)); }
console.log(failures.length ? `\nFAILED: ${failures.join('; ')}` : '\nAll fills match the wallet balance changes to the wei.');
// FIXTURE_OUT=path writes each trade (call, receipt, curve state, measured deltas) for apps/edge/test/robinhood-trade.test.ts.
if (process.env.FIXTURE_OUT) writeFileSync(process.env.FIXTURE_OUT, JSON.stringify(fixture, (_, v) => typeof v === 'bigint' ? v.toString() : v, 1));
anvil?.kill();
process.exit(failures.length ? 1 : 0);
