import { afterAll, beforeAll, expect, it } from 'vitest';
import { decodeAbiParameters, decodeFunctionResult, encodeFunctionData, erc20Abi, parseEther, type Hex } from 'viem';
import { loadRegistry } from '../../src/registry.js';
import { createMeteredClients } from '../../src/rpc/clients.js';
import { verifyChain } from '../../src/verify.js';
import { referenceQuoterAbi, v3Legs, type ReferenceRoute } from '../../src/simulation/v3.js';
import { probeAbi } from '../../src/simulation/reference.js';
import { EKO_PROBE_RUNTIME } from '../../src/simulation/probe-runtime.js';

// Read-only archive calls: no signing, keys, transactions or synthetic contract fixtures.
const rpc = process.env.FORK_URL;
if (!rpc) throw new Error('FORK_URL is required for live dependency tests');
const pin = process.env.FORK_BLOCK_NUMBER ?? '77469811';
if (!/^[1-9][0-9]*$/.test(pin)) throw new Error('FORK_BLOCK_NUMBER must be a positive block number');
const blockNumber = BigInt(pin);
const registry = loadRegistry();
const { forkArchive: client, meter } = createMeteredClients({
  RPC_HTTP_URL: rpc, RPC_PUBLIC_HTTP_URL: rpc, RPC_USAGE_DIR: ':memory:', RPC_SESSION_BUDGET: '2000',
  // This URL is public even though the archive route uses the paid-only meter bucket.
  RPC_PAID_MAX_RPM: '120', RPC_PUBLIC_MAX_RPM: '120',
}, { standalone: true, transientRetrySec: 15 });
let blockHash: Hex;

beforeAll(async () => {
  expect(await client.getChainId()).toBe(4663);
  const block = await client.getBlock({ blockNumber });
  expect(block.number).toBe(blockNumber);
  blockHash = block.hash;
  console.log(`dependency pin: ${blockNumber} ${blockHash}`);
});

afterAll(async () => {
  try { expect((await client.getBlock({ blockNumber })).hash).toBe(blockHash); }
  finally { await meter.close(); }
});

it('verifies deployed registry code, proxy implementations, router wiring and v3/v4/Pons events', async () => {
  const report = await verifyChain(registry, {
    getChainId: () => client.getChainId(),
    getBlockNumber: async () => blockNumber,
    getCode: input => client.getCode(input),
    getStorageAt: input => client.getStorageAt(input),
    readContract: input => client.readContract(input),
    getLogs: input => client.getLogs(input),
  }, { prelaunch: true }); // EKO's own entries are not deployed yet; strict mode fails closed on them by design.
  console.table(report.rows);
  expect(report.block).toBe(blockNumber);
  expect(report.rows.filter(row => row.check === 'code')).toHaveLength(14);
  expect(report.rows.filter(row => row.check.startsWith('event '))).toHaveLength(9);
  expect(report.rows.filter(row => !row.ok)).toEqual([]);
  expect(report.ok).toBe(true);
});

it('quotes both directions through the real WETH/USDG pool and QuoterV2', async () => {
  const weth = registry.requireAddress('tokens.WETH');
  const usdg = registry.requireAddress('tokens.USDG');
  for (const [address, decimals] of [[weth, 18], [usdg, 6]] as const) {
    expect(await client.readContract({ address, abi: erc20Abi, functionName: 'decimals', blockNumber })).toBe(decimals);
  }
  // Use the 10000 tier captured by the existing v3-pool fixture, with real archive state.
  for (const [tokenIn, tokenOut, amountIn] of [[weth, usdg, parseEther('0.05')], [usdg, weth, 40_000_000n]] as const) {
    const data = encodeFunctionData({ abi: referenceQuoterAbi, functionName: 'quoteExactInputSingle', args: [{ tokenIn, tokenOut, amountIn, fee: 10000, sqrtPriceLimitX96: 0n }] });
    const result = await client.call({ to: registry.requireAddress('uniswapV3.quoterV2'), data, blockNumber });
    const [amountOut, sqrtPriceX96, , gasEstimate] = decodeFunctionResult({ abi: referenceQuoterAbi, functionName: 'quoteExactInputSingle', data: result.data! });
    expect(amountOut).toBeGreaterThan(0n);
    expect(sqrtPriceX96).toBeGreaterThan(0n);
    expect(gasEstimate).toBeGreaterThan(0n);
    console.log(`quote ${tokenIn} -> ${tokenOut}: ${amountIn} -> ${amountOut}`);
  }
});

it('executes the contract probe buy, exact approval and sell against deployed v3 dependencies in eth_call', async () => {
  const probe = '0x000000000000000000000000000000000000ba11';
  expect((await client.getCode({ address: probe, blockNumber })) ?? '0x').toBe('0x');
  const block = await client.getBlock({ blockNumber });
  const size = parseEther('0.05');
  const route: ReferenceRoute = {
    venue: 'uniswap_v3', id: 'fork-weth-usdg', coin: registry.requireAddress('tokens.USDG'),
    weth: registry.requireAddress('tokens.WETH'), router: registry.requireAddress('uniswapV3.swapRouter02'),
    quoter: registry.requireAddress('uniswapV3.quoterV2'), fee: 10000, deadline: block.timestamp + 600n,
    verification: { blockHash, evidenceIds: [] }, entryLimitSelectors: [], cooldown: null,
  };
  const legs = v3Legs(route, probe, size);
  const result = await client.call({
    to: probe, blockNumber, gas: 30_000_000n,
    data: encodeFunctionData({ abi: probeAbi, functionName: 'roundTrip', args: [route.coin, route.router, legs.buy, legs.quoteSell, legs.sell] }),
    // Override only the local probe's code and native funding; deployed token/pool storage stays real.
    stateOverride: [{ address: probe, code: EKO_PROBE_RUNTIME, balance: size + parseEther('1') }],
  });
  const [tokens, quotedBack, returned, spent, buyOk, sellOk, sellData] = decodeFunctionResult({ abi: probeAbi, functionName: 'roundTrip', data: result.data! });
  expect(buyOk).toBe(true);
  expect(sellOk).toBe(true);
  expect(tokens).toBeGreaterThan(0n);
  expect(quotedBack).toBeGreaterThan(0n);
  expect(returned).toBe(quotedBack);
  expect(returned).toBeLessThan(size);
  expect(spent).toBe(size);
  // BwProbe retains the sell call's return bytes on success, as well as revert data on failure.
  const [calls] = decodeAbiParameters([{ type: 'bytes[]' }], sellData);
  expect(calls).toHaveLength(2);
  expect(decodeAbiParameters([{ type: 'uint256' }], calls[0])[0]).toBe(returned);
  expect(calls[1]).toBe('0x');
  console.log(`probe: ${spent} wei spent, ${tokens} raw USDG, ${returned} wei returned`);
});
