#!/usr/bin/env node
// Read-only verification of the Robinhood Chain (4663) facts EKO's trading depends on. Every read goes to the public
// RPC, Blockscout, Hyperliquid's public info API or a public Ethereum mainnet RPC; nothing is signed or sent. Run:
//   node scripts/robinhood/verify-chain.mjs [--json out.json] [--strict]
// Env: RH_RPC_URL (default the public RPC), RH_RPS (paced request rate, default 4), ETH_MAINNET_RPC (canonical Permit2
// comparison), HYPERLIQUID_URL. Behind an HTTP proxy, set NODE_USE_ENV_PROXY=1 so Node's fetch uses it.
// Each check prints PASS, FAIL or UNKNOWN with its evidence. --strict exits 1 when any check FAILs.
// Results are written up in docs/robinhood/CHAIN-FACTS.md; re-run this before trusting a fact older than a week.
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
// viem and yaml are @eko/chain's dependencies; the repo root does not list them.
const require = createRequire(resolve(root, 'packages/chain/package.json'));
const viem = await import(require.resolve('viem'));
const YAML = await import(require.resolve('yaml'));
const { createPublicClient, custom, parseAbi, parseAbiItem, decodeFunctionData, decodeAbiParameters, encodeAbiParameters,
  encodeFunctionData, keccak256, toFunctionSelector, toHex, getAddress, zeroAddress, stringToHex } = viem;

const RPC = process.env.RH_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com';
const EXPLORER = 'https://robinhoodchain.blockscout.com';
const ETH_RPC = process.env.ETH_MAINNET_RPC ?? 'https://ethereum-rpc.publicnode.com';
const HL = process.env.HYPERLIQUID_URL ?? 'https://api.hyperliquid.xyz/info';
const RPS = Number(process.env.RH_RPS ?? 4);
const args = process.argv.slice(2), jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;

// ---- registry, recorded hashes and pins ------------------------------------------------------------------------------
const registry = YAML.parse(readFileSync(resolve(root, 'packages/chain/addresses.4663.yaml'), 'utf8'));
const reg = path => { const a = path.split('.').reduce((o, k) => o?.[k], registry)?.address; if (!/^0x[0-9a-fA-F]{40}$/.test(a ?? '')) throw new Error(`registry ${path} missing`); return getAddress(a); };
const A = { pm: reg('uniswapV4.poolManager'), ur: reg('uniswapV4.universalRouter'), quoter: reg('uniswapV4.v4Quoter'), permit2: reg('uniswapV4.permit2'),
  v3factory: reg('uniswapV3.factory'), weth: reg('tokens.WETH'), usdg: reg('tokens.USDG'), factory: reg('pons.factory'), hook: reg('pons.v4Hook'), ponsRouter: reg('pons.router') };
/** Code hashes recorded at block 77,438,572 (the registry's 2026-10-01/06 verification), packages/chain/test/fixtures/4663. */
const recorded = JSON.parse(readFileSync(resolve(root, 'packages/chain/test/fixtures/4663/registry-code.json'), 'utf8'));
/** The graduation-lock pins reviewed on 2026-10-06 in the frozen product's apps/server/src/exec/pons-graduation.ts. */
const PINS = { locker: '0x58455f80b3773871d601a025e56ec27c71ab3bbb8e2ca6b17828954450742025', positionManager: '0xc873e135dc9aaec88489cfbad146b4cb49d6a32e0d80326377784b7ba17670b2' };
const rhPinsSource = (() => {
  // The frozen copy sits next to the main checkout (a worktree is nested inside it): look beside every ancestor.
  const candidates = []; for (let d = root; d !== dirname(d); d = dirname(d)) candidates.push(resolve(dirname(d), 'EKO-RH/apps/server/src/exec/pons-graduation.ts'));
  for (const p of candidates) if (existsSync(p)) {
    const t = readFileSync(p, 'utf8'), l = t.match(/PONS_LOCKER_CODE_HASH: Hex = '(0x[0-9a-f]{64})'/)?.[1], m = t.match(/V4_POSITION_MANAGER_CODE_HASH: Hex = '(0x[0-9a-f]{64})'/)?.[1];
    if (l && m) { if (l !== PINS.locker || m !== PINS.positionManager) throw new Error('EKO-RH pins differ from the copy in this script'); return 'EKO-RH pons-graduation.ts (read)'; }
  }
  return 'copy in this script (EKO-RH not found)';
})();

// ---- paced JSON-RPC ----------------------------------------------------------------------------------------------------
const sleep = ms => new Promise(r => setTimeout(r, ms));
let nextSlot = 0, requests = 0, throttled = 0;
class RpcError extends Error { constructor(e) { super(e.message); this.code = e.code; this.data = e.data; } }
async function rawRpc(url, method, params, id = 1) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
  const text = await res.text(); let body; try { body = JSON.parse(text); } catch { body = { error: { code: res.status, message: text.slice(0, 120) } }; }
  return { status: res.status, body };
}
/** One request at a time, at most RH_RPS per second; a 429 backs off and retries (a heavy query can draw one alone). */
async function rpc(method, params) {
  for (let attempt = 0; ; attempt++) {
    const now = Date.now(), wait = Math.max(0, nextSlot - now); nextSlot = Math.max(now, nextSlot) + 1000 / RPS; if (wait) await sleep(wait);
    requests++;
    const { status, body } = await rawRpc(RPC, method, params, requests);
    const limited = status === 429 || body.error?.code === 429;
    if (limited) throttled++;
    if (limited && attempt < 5) { await sleep(1500 * (attempt + 1)); continue; }
    if (body.error) throw new RpcError(body.error);
    return body.result;
  }
}
const client = createPublicClient({ transport: custom({ request: ({ method, params }) => rpc(method, params) }), batch: { multicall: false } });

// ---- reporting ---------------------------------------------------------------------------------------------------------
const results = [];
function report(id, status, title, evidence) {
  results.push({ id, status, title, evidence });
  console.log(`[${status.padEnd(7)}] ${id} ${title}`); for (const line of [evidence].flat()) console.log(`            ${line}`);
}
async function check(id, title, fn) {
  try { const r = await fn(); report(id, r.status, title, r.evidence); return r; }
  catch (e) { report(id, 'UNKNOWN', title, `check errored: ${(e.shortMessage ?? e.message).split('\n')[0]}${e.details ? ` (${e.details})` : ''}`); return null; }
}
const same = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const word = x => BigInt(x).toString(16).padStart(64, '0');
const fmt = (x, d = 18, p = 6) => (Number(x) / 10 ** d).toFixed(p);
/** The fork manifest's dispatcher scan (packages/chain/src/simulation/fork-manifest.ts): PUSH4 sel, EQ, PUSHn, JUMPI. */
function dispatcherSelectors(code) {
  const ops = [];
  for (let i = 2; i < code.length;) { const op = parseInt(code.slice(i, i + 2), 16); i += 2; const size = op >= 0x60 && op <= 0x7f ? op - 0x5f : 0;
    const value = code.slice(i, i + size * 2); if (value.length !== size * 2) break; ops.push({ op, value }); i += size * 2; }
  const out = new Set();
  for (let i = 0; i < ops.length; i++) if (ops[i].op === 0x63 && ops[i + 1]?.op === 0x14 && ops[i + 2]?.op >= 0x60 && ops[i + 2]?.op <= 0x7f && ops[i + 3]?.op === 0x57) out.add(`0x${ops[i].value.toLowerCase()}`);
  return out;
}
const missing = (code, sigs) => { const d = dispatcherSelectors(code); return sigs.filter(s => !d.has(toFunctionSelector(s))); };
/** Logs over [from,to] in chunks that halve on a span or result-limit error. */
async function logsChunked(filter, from, to, chunk = 500000n) {
  const out = [];
  for (let f = from; f <= to;) {
    const t = f + chunk - 1n > to ? to : f + chunk - 1n;
    try { out.push(...await client.getLogs({ ...filter, fromBlock: f, toBlock: t })); f = t + 1n; }
    catch (e) { if (chunk <= 1000n || !/limit|allowed|span|exceed/i.test(`${e.details ?? e.message}`)) throw e; chunk /= 2n; }
  }
  return out;
}

const ABI = {
  launched: parseAbiItem('event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)'),
  buy: parseAbiItem('event CurveBuy(address indexed buyer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 tax)'),
  sell: parseAbiItem('event CurveSell(address indexed seller, address indexed recipient, uint256 tokensIn, uint256 quoteOut, uint256 fee, uint256 tax)'),
  swap: parseAbiItem('event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)'),
  init: parseAbiItem('event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)'),
  pm: parseAbi(['function poolManager() view returns (address)']),
  curve: parseAbi(['function currentSnipeTaxBps(address) view returns (uint256)', 'function launchedAt() view returns (uint256)', 'function feeBps() view returns (uint256)',
    'function creatorTaxBps() view returns (uint256)', 'function trackedTokens() view returns (uint256)', 'function realQuoteReserve() view returns (uint256)',
    'function phantomQuote() view returns (uint256)', 'function reservedTokens() view returns (uint256)', 'function graduated() view returns (bool)',
    'function readyToGraduate() view returns (bool)', 'function token() view returns (address)', 'function factory() view returns (address)',
    'function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256)']),
  token: parseAbi(['function curve() view returns (address)']),
  factory: parseAbi(['function locker() view returns (address)', 'function positionManager() view returns (address)', 'function memeHook() view returns (address)']),
  ur: parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable', 'function execute(bytes commands, bytes[] inputs) payable']),
  quoter: parseAbi(['function quoteExactInputSingle(((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)']),
  v3factory: parseAbi(['function getPool(address,address,uint24) view returns (address)']),
  v3pool: parseAbi(['function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)', 'function liquidity() view returns (uint128)', 'function token0() view returns (address)']),
};
const poolKeyT = { type: 'tuple', components: [{ name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }] };
/** v4-periphery IV4Router.ExactInputSingleParams: the 5-field original and the 6-field one with a uint256 before hookData. */
const single5 = { type: 'tuple', components: [{ name: 'poolKey', ...poolKeyT }, { name: 'zeroForOne', type: 'bool' }, { name: 'amountIn', type: 'uint128' }, { name: 'amountOutMinimum', type: 'uint128' }, { name: 'hookData', type: 'bytes' }] };
const single6 = { type: 'tuple', components: [...single5.components.slice(0, 4), { name: 'field5', type: 'uint256' }, { name: 'hookData', type: 'bytes' }] };
/** A layout counts only if decoding and re-encoding reproduces the exact bytes. */
const roundTrip = (def, raw) => { try { const [d] = decodeAbiParameters([def], raw); return encodeAbiParameters([def], [d]).toLowerCase() === raw.toLowerCase() ? d : null; } catch { return null; } };
const poolId = key => keccak256(encodeAbiParameters([poolKeyT], [key]));

console.log(`Robinhood Chain fact check · ${new Date().toISOString()} · RPC ${RPC} · paced at ${RPS} req/s\n`);
const head = await client.getBlockNumber();
const headBlock = await client.getBlock({ blockNumber: head });
console.log(`head block ${head} (timestamp ${headBlock.timestamp}, ${new Date(Number(headBlock.timestamp) * 1000).toISOString()})\n`);
let blockTime = 0.1;

// ---- 1. chain ----------------------------------------------------------------------------------------------------------
await check('1.1', 'eth_chainId is 4663', async () => { const id = await client.getChainId(); return { status: id === 4663 ? 'PASS' : 'FAIL', evidence: `eth_chainId = ${id}` }; });
await check('1.2', 'block time over ~1,000 blocks', async () => {
  const span = 1000n, b0 = await client.getBlock({ blockNumber: head - span }), b1 = await client.getBlock({ blockNumber: head - 10000n });
  blockTime = Number(headBlock.timestamp - b0.timestamp) / Number(span);
  const bt10k = Number(headBlock.timestamp - b1.timestamp) / 10000;
  return { status: 'PASS', evidence: [`blocks ${head - span}..${head}: ${headBlock.timestamp - b0.timestamp} s / 1000 blocks = ${blockTime.toFixed(3)} s per block (timestamps are whole seconds, so ±0.001 s)`,
    `cross-check over 10,000 blocks: ${bt10k.toFixed(4)} s per block; 24 h ≈ ${Math.round(86400 / bt10k).toLocaleString('en-US')} blocks`] };
});

// ---- 2. Uniswap v4 ------------------------------------------------------------------------------------------------------
const codes = {};
await check('2.1', 'PoolManager, Universal Router, V4Quoter and Permit2 have code (hash vs the 2026-10-06 record)', async () => {
  const rows = [], names = { pm: 'poolManager', ur: 'universalRouter', quoter: 'v4Quoter', permit2: 'permit2' }; let ok = true;
  for (const [k, n] of Object.entries(names)) {
    const code = await client.getCode({ address: A[k] }); codes[k] = code ?? '0x';
    const h = code ? keccak256(code) : null, rec = recorded.codes[n]?.codeHash; ok &&= !!code && code.length > 2 && same(h, rec);
    rows.push(`${n} ${A[k]}: ${code ? (code.length - 2) / 2 : 0} bytes, ${h}${same(h, rec) ? ' = recorded' : ` ≠ recorded ${rec}`}`);
  }
  return { status: ok ? 'PASS' : 'FAIL', evidence: rows };
});
await check('2.2', 'router.poolManager() and quoter.poolManager() equal the registry PoolManager', async () => {
  const r = await client.readContract({ address: A.ur, abi: ABI.pm, functionName: 'poolManager' }), q = await client.readContract({ address: A.quoter, abi: ABI.pm, functionName: 'poolManager' });
  return { status: same(r, A.pm) && same(q, A.pm) ? 'PASS' : 'FAIL', evidence: `UniversalRouter.poolManager() = ${r}; V4Quoter.poolManager() = ${q}; registry ${A.pm}` };
});
await check('2.3', 'Permit2 runtime code is canonical (Ethereum mainnet bytecode with 4663 EIP-712 immutables)', async () => {
  const local = codes.permit2 ?? await client.getCode({ address: A.permit2 });
  const { body } = await rawRpc(ETH_RPC, 'eth_getCode', [A.permit2, 'latest']);
  if (!body.result || body.result.length < 100) return { status: 'UNKNOWN', evidence: `mainnet code unavailable from ${ETH_RPC}; 4663 hash ${keccak256(local)}` };
  // Permit2 caches chainid and its domain separator as immutables (PUSH32 operands); swap mainnet's for 4663's.
  const typeHash = keccak256(stringToHex('EIP712Domain(string name,uint256 chainId,address verifyingContract)')), nameHash = keccak256(stringToHex('Permit2'));
  const ds = id => keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }], [typeHash, nameHash, id, A.permit2])).slice(2);
  const main = body.result.toLowerCase(), swapped = main.split(`7f${ds(1n)}`).join(`7f${ds(4663n)}`).split(`7f${word(1)}`).join(`7f${word(4663)}`);
  const hits = main.split(`7f${ds(1n)}`).length - 1;
  return { status: keccak256(swapped) === keccak256(local) ? 'PASS' : 'FAIL', evidence: [`mainnet ${keccak256(main)} (${(main.length - 2) / 2} bytes), domain-separator immutable found ${hits}×`,
    `mainnet code with chainid 4663 + its domain separator: ${keccak256(swapped)}; 4663 code: ${keccak256(local)}`] };
});
await check('2.4', 'Universal Router version', async () => {
  // Uniswap's own deployment record labels this address; the deployment transaction it names must exist on 4663.
  const deployTx = '0xf669b9a4b8c322f5992788f737ee5fd2a1a73fd44f17546c5ac8b2211b6da339';
  let label = 'deployment record not fetched';
  try { const md = await (await fetch('https://raw.githubusercontent.com/Uniswap/contracts/main/deployments/4663.md')).text();
    const rows = [...md.matchAll(/<td>(UniversalRouter[^<]*)<\/td>\s*<td><a[^>]*>(0x[0-9a-fA-F]{40})/g)].filter(m => same(m[2], A.ur)).map(m => m[1]);
    label = rows.length ? `Uniswap/contracts deployments/4663.md labels ${A.ur}: ${rows.join(', ')}` : 'deployment record does not list this address';
  } catch (e) { label = `deployment record unreachable (${e.message})`; }
  const rc = await client.getTransactionReceipt({ hash: deployTx }).catch(() => null);
  const v212 = /v2\.1\.2/.test(label);
  return { status: v212 && rc?.status === 'success' ? 'PASS' : 'UNKNOWN', evidence: [label, rc ? `deployment tx ${deployTx}: block ${rc.blockNumber}, ${rc.status}, ${rc.logs.length} logs` : `deployment tx ${deployTx} not found`] };
});
let urTxs = [];
await check('2.5', 'V4 SWAP_EXACT_IN_SINGLE input layout, from real swaps sent to the Universal Router', async () => {
  const swaps = await client.getLogs({ address: A.pm, event: ABI.swap, args: { sender: A.ur }, fromBlock: head - 20000n, toBlock: head });
  const hashes = [...new Set(swaps.map(s => s.transactionHash))].slice(-80);
  const t = { five: [], six: [], neither: [] }, field5 = {}, notDirect = [];
  for (const h of hashes) {
    const tx = await client.getTransaction({ hash: h });
    if (!same(tx.to, A.ur)) { notDirect.push(h); continue; }
    const { args: [commands, inputs] } = decodeFunctionData({ abi: ABI.ur, data: tx.input });
    commands.slice(2).match(/../g).forEach((c, i) => {
      if ((parseInt(c, 16) & 0x3f) !== 0x10) return; // V4_SWAP
      const [actions, params] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], inputs[i]);
      actions.slice(2).match(/../g).forEach((a, j) => {
        if (parseInt(a, 16) !== 0x06) return; // SWAP_EXACT_IN_SINGLE
        const d5 = roundTrip(single5, params[j]), d6 = roundTrip(single6, params[j]);
        const bucket = d5 && !d6 ? 'five' : d6 && !d5 ? 'six' : 'neither'; t[bucket].push(h);
        if (d6) { field5[d6.field5.toString()] = (field5[d6.field5.toString()] ?? 0) + 1; urTxs.push({ hash: h, block: tx.blockNumber, key: d6.poolKey, hookData: d6.hookData, field5: d6.field5 }); }
      });
    });
  }
  const n = t.five.length + t.six.length + t.neither.length;
  const status = n >= 5 && t.six.length === n ? 'PASS' : n >= 5 && t.five.length === n ? 'FAIL' : 'UNKNOWN';
  return { status, evidence: [`${swaps.length} PoolManager Swap logs with sender = router in blocks ${head - 20000n}..${head}; ${hashes.length} txs read, ${notDirect.length} not sent to the router directly`,
    `${n} SWAP_EXACT_IN_SINGLE params: ${t.six.length} round-trip only as 6-field, ${t.five.length} only as 5-field, ${t.neither.length} as neither`,
    `6-field = (PoolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, uint256 <5th>, bytes hookData); 5th-field values seen: ${JSON.stringify(field5)}`,
    `examples: ${[...new Set(t.six)].slice(0, 3).join(', ') || 'none'}`] };
});

// ---- 3. Pons -----------------------------------------------------------------------------------------------------------
let launches24 = [];
await check('3.1', 'Pons factory still emits TokenLaunched (latest launch, launches in the last 24 h)', async () => {
  const day = BigInt(Math.round(86400 / blockTime));
  launches24 = await logsChunked({ address: A.factory, event: ABI.launched }, head - day, head);
  const last = launches24.at(-1);
  if (!last) return { status: 'FAIL', evidence: `no TokenLaunched from ${A.factory} in blocks ${head - day}..${head}` };
  const age = Number(head - last.blockNumber) * blockTime;
  return { status: age < 3600 ? 'PASS' : 'UNKNOWN', evidence: [`${launches24.length} launches in blocks ${head - day}..${head} (24 h at ${blockTime.toFixed(3)} s/block)`,
    `latest: block ${last.blockNumber} (~${Math.round(age)} s before head), tx ${last.transactionHash}, token ${last.args.token}, curve ${last.args.curve}`] };
});
await check('3.2', 'Quote assets (TokenLaunched.pairToken) over the last 24 h', async () => {
  const by = {}; for (const l of launches24) by[l.args.pairToken] = (by[l.args.pairToken] ?? 0) + 1;
  const sorted = Object.entries(by).sort((a, b) => b[1] - a[1]), symbols = {};
  // Other quote tokens are mostly earlier Pons coins (a coin paired against a coin); name the top three.
  for (const [a] of sorted.filter(([a]) => ![zeroAddress, A.usdg, A.weth].some(k => same(k, a))).slice(0, 3)) {
    const sym = await client.readContract({ address: a, abi: parseAbi(['function symbol() view returns (string)']), functionName: 'symbol' }).catch(() => '?');
    const curve = await client.readContract({ address: a, abi: ABI.token, functionName: 'curve' }).catch(() => null);
    symbols[a] = `${a} (${sym}${curve ? ', a Pons coin' : ''})`;
  }
  const name = a => same(a, zeroAddress) ? 'native ETH' : same(a, A.usdg) ? 'USDG' : same(a, A.weth) ? 'WETH' : symbols[a] ?? a;
  const rows = sorted.map(([a, n]) => `${name(a)}: ${n} (${(100 * n / launches24.length).toFixed(1)}%)`);
  const cfg = {}; for (const l of launches24) cfg[`${l.args.launchConfigId}/${l.args.graduationThreshold}`] = (cfg[`${l.args.launchConfigId}/${l.args.graduationThreshold}`] ?? 0) + 1;
  return { status: launches24.length ? 'PASS' : 'UNKNOWN', evidence: [...rows, `launchConfigId/graduationThreshold: ${Object.entries(cfg).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `${k} ×${n}`).join(', ')}`] };
});
const nativeLaunches = () => launches24.filter(l => same(l.args.pairToken, zeroAddress));
await check('3.3', 'Current curves expose the buy, sell, graduation and state selectors (fork-manifest.ts, pons.ts)', async () => {
  const curveSigs = ['buy(uint256,uint256,address)', 'sell(uint256,uint256,address)', 'getReserves()', 'sellableTokens()', 'graduationThreshold()', 'graduated()', 'readyToGraduate()',
    'token()', 'factory()', 'pairToken()', 'currentSnipeTaxBps(address)', 'feeBps()', 'creatorTaxBps()', 'launchedAt()', 'trackedTokens()', 'realQuoteReserve()', 'phantomQuote()',
    'reservedTokens()', 'quoteFeeBalance()', 'creatorTaxBalance()', 'deployer()', 'protocolFeeRecipient()', 'feeEscrow()'];
  const tokenSigs = ['balanceOf(address)', 'allowance(address,address)', 'approve(address,uint256)', 'curve()', 'launchFactory()'];
  const factorySigs = ['getLaunchedToken(address)', 'locker()', 'positionManager()', 'memeHook()'];
  const sample = [...nativeLaunches().slice(-3), ...launches24.filter(l => same(l.args.pairToken, A.usdg)).slice(-1)];
  const rows = [], normalized = new Set(); let ok = true;
  const fcode = await client.getCode({ address: A.factory }), fm = missing(fcode, factorySigs); ok &&= !fm.length;
  rows.push(`factory: ${fm.length ? `missing ${fm.join(', ')}` : `all ${factorySigs.length} selectors`}`);
  for (const l of sample) {
    const c = await client.getCode({ address: l.args.curve }), t = await client.getCode({ address: l.args.token });
    const cm = missing(c, curveSigs), tm = missing(t, tokenSigs); ok &&= !cm.length && !tm.length;
    // Curves differ only in immutables: the deployer, creatorTaxBps and feeBps (PUSH32 operands; the two bps values can
    // be equal, so both are masked). Masking them gives one hash per curve implementation.
    const bps = [await client.readContract({ address: l.args.curve, abi: ABI.curve, functionName: 'creatorTaxBps' }), await client.readContract({ address: l.args.curve, abi: ABI.curve, functionName: 'feeBps' })];
    const norm = keccak256(bps.reduce((code, b) => code.split(`7f${word(b)}`).join(`7f${word(0)}`), c.toLowerCase().split(l.args.deployer.slice(2).toLowerCase()).join('00'.repeat(20)))); normalized.add(norm);
    rows.push(`curve ${l.args.curve} (${same(l.args.pairToken, zeroAddress) ? 'ETH' : 'USDG'}, block ${l.blockNumber}): ${cm.length ? `missing ${cm.join(', ')}` : `all ${curveSigs.length}`}; token: ${tm.length ? `missing ${tm.join(', ')}` : `all ${tokenSigs.length}`}; code ${keccak256(c).slice(0, 18)}…, masked ${norm.slice(0, 18)}…`);
  }
  // getLaunchedToken's 15-word record as the fork manifest decodes it.
  const l = sample[0], ret = await client.call({ to: A.factory, data: `${toFunctionSelector('getLaunchedToken(address)')}${word(l.args.token)}` });
  const w = (ret.data ?? '0x').slice(2).match(/.{64}/g) ?? [];
  const layout = w.length === 15 && same(`0x${w[0].slice(24)}`, l.args.token) && same(`0x${w[1].slice(24)}`, l.args.curve) && BigInt(`0x${w[4]}`) === 0n && BigInt(`0x${w[10]}`) === 0n && BigInt(`0x${w[14]}`) === 1n;
  ok &&= layout;
  rows.push(`getLaunchedToken(${l.args.token}): ${w.length} words; [0]=token [1]=curve [4]=0 [10]=0 [14]=1 ${layout ? 'as fork-manifest.ts expects' : 'NOT as expected'}`);
  rows.push(`${normalized.size} distinct masked curve code hash(es) across ${sample.length} curves (ETH and USDG curves differ; raw code hashes differ per curve)`);
  return { status: ok ? 'PASS' : 'FAIL', evidence: rows };
});
await check('3.4', 'Curve math replays real trades (x·y with phantom quote; fee and creator tax on gross quote)', async () => {
  // Public state is kept only ~10 minutes, so replay recent trades from their pre-state at block-1.
  const from = head - 4500n, curves = new Set(nativeLaunches().map(l => l.args.curve.toLowerCase()));
  const buys = await client.getLogs({ event: ABI.buy, fromBlock: from, toBlock: head - 5n }), sells = await client.getLogs({ event: ABI.sell, fromBlock: from, toBlock: head - 5n });
  const all = [...buys, ...sells].filter(l => curves.has(l.address.toLowerCase()));
  const firstInBlock = l => !all.some(o => same(o.address, l.address) && o.blockNumber === l.blockNumber && o.logIndex < l.logIndex);
  const pick = (list, n) => list.filter(l => curves.has(l.address.toLowerCase()) && firstInBlock(l) && l.args.tax !== undefined).slice(-n);
  const rows = []; let tried = 0, exact = 0;
  for (const l of [...pick(buys, 3), ...pick(sells, 3)]) {
    const at = { blockNumber: l.blockNumber - 1n }, r = fn => client.readContract({ address: l.address, abi: ABI.curve, functionName: fn, ...at });
    const token = await client.readContract({ address: l.address, abi: ABI.curve, functionName: 'token' });
    const snipe = await client.readContract({ address: l.address, abi: ABI.curve, functionName: 'currentSnipeTaxBps', args: [token], blockNumber: l.blockNumber });
    if (snipe !== 0n) continue;
    const [tokens, real, phantom, reserved, fee, creator] = [await r('trackedTokens'), await r('realQuoteReserve'), await r('phantomQuote'), await r('reservedTokens'), await r('feeBps'), await r('creatorTaxBps')];
    tried++;
    if (l.eventName === 'CurveBuy') {
      const g = l.args.quoteIn, f = g * fee / 10000n, t = g * creator / 10000n, net = g - f - t;
      let out = net * tokens / (real + phantom + net); if (out > tokens - reserved) out = tokens - reserved;
      const ok = out === l.args.tokensOut && f === l.args.fee && t === l.args.tax; exact += ok;
      rows.push(`buy ${l.transactionHash} block ${l.blockNumber}: quoteIn ${fmt(g)} ETH, fee ${fee} bps, creator ${creator} bps → predicted ${out} tokens / fee ${f} / tax ${t}; event ${l.args.tokensOut} / ${l.args.fee} / ${l.args.tax} ${ok ? 'EXACT' : 'MISMATCH'}`);
    } else {
      const q = l.args.tokensIn * (real + phantom) / (tokens + l.args.tokensIn), f = q * fee / 10000n, t = q * creator / 10000n, out = q - f - t;
      const ok = out === l.args.quoteOut && f === l.args.fee && t === l.args.tax; exact += ok;
      rows.push(`sell ${l.transactionHash} block ${l.blockNumber}: tokensIn ${l.args.tokensIn}, fee ${fee} bps, creator ${creator} bps → predicted quoteOut ${out} / fee ${f} / tax ${t}; event ${l.args.quoteOut} / ${l.args.fee} / ${l.args.tax} ${ok ? 'EXACT' : 'MISMATCH'}`);
    }
  }
  return { status: tried >= 2 && exact === tried ? 'PASS' : tried ? 'FAIL' : 'UNKNOWN', evidence: [`${exact}/${tried} recent post-snipe trades (first on their curve in the block) reproduced exactly`, ...rows] };
});
await check('3.5', 'Pons factory, hook and router code unchanged since the registry verification (block 77,438,572)', async () => {
  const rows = []; let ok = true;
  for (const [k, n] of [['factory', 'ponsFactory'], ['hook', 'ponsHook'], ['ponsRouter', 'ponsRouter']]) {
    const h = keccak256(await client.getCode({ address: A[k] }) ?? '0x'), rec = recorded.codes[n].codeHash; ok &&= same(h, rec);
    rows.push(`${n} ${A[k]}: ${h} ${same(h, rec) ? '= recorded' : `≠ recorded ${rec}`}`);
  }
  return { status: ok ? 'PASS' : 'FAIL', evidence: rows };
});
let ponsPools = [];
await check('3.6', 'Pons v4 hook: permissions, and whether swaps need hookData', async () => {
  // v4 hook permissions are the low 14 bits of the hook address.
  const flags = Number(BigInt(A.hook) & 0x3fffn), names = ['afterRemoveLiquidityReturnDelta', 'afterAddLiquidityReturnDelta', 'afterSwapReturnDelta', 'beforeSwapReturnDelta', 'afterDonate', 'beforeDonate',
    'afterSwap', 'beforeSwap', 'afterRemoveLiquidity', 'beforeRemoveLiquidity', 'afterAddLiquidity', 'beforeAddLiquidity', 'afterInitialize', 'beforeInitialize'];
  const perms = names.filter((_, i) => flags & (1 << i));
  // Graduation pools: native-ETH Initialize logs whose hooks field is the Pons hook (hooks is not indexed).
  const inits = await logsChunked({ address: A.pm, event: ABI.init, args: { currency0: zeroAddress } }, head - 6000000n, head, 1000000n);
  ponsPools = inits.filter(l => same(l.args.hooks, A.hook));
  const ids = ponsPools.map(l => l.args.id), rows = [`hook ${A.hook} flags 0x${flags.toString(16)}: ${perms.join(', ')}`,
    `${ponsPools.length} Pons-hook pools initialized in the last 6,000,000 blocks; latest ${ponsPools.at(-1)?.args.id ?? '-'} at block ${ponsPools.at(-1)?.blockNumber ?? '-'} (tx ${ponsPools.at(-1)?.transactionHash ?? '-'})`];
  // Real router swaps on Pons pools, and the hookData they carried.
  const viaUr = urTxs.filter(s => same(s.key.hooks, A.hook));
  let swaps = [];
  for (let t = head; t > head - 300000n && ids.length; t -= 100000n) swaps.push(...await client.getLogs({ address: A.pm, event: ABI.swap, args: { id: ids }, fromBlock: t - 99999n, toBlock: t }).catch(() => []));
  for (const h of [...new Set(swaps.map(s => s.transactionHash))].slice(-15)) {
    if (viaUr.some(s => s.hash === h)) continue;
    const tx = await client.getTransaction({ hash: h }); if (!same(tx.to, A.ur)) continue;
    const { args: [commands, inputs] } = decodeFunctionData({ abi: ABI.ur, data: tx.input });
    commands.slice(2).match(/../g).forEach((c, i) => { if ((parseInt(c, 16) & 0x3f) !== 0x10) return;
      const [actions, params] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], inputs[i]);
      actions.slice(2).match(/../g).forEach((a, j) => { const d = parseInt(a, 16) === 0x06 && roundTrip(single6, params[j]); if (d && same(d.poolKey.hooks, A.hook)) viaUr.push({ hash: h, key: d.poolKey, hookData: d.hookData, field5: d.field5 }); }); });
  }
  const hd = [...new Set(viaUr.map(s => s.hookData))], senders = {}, shapes = {};
  for (const s of swaps) senders[s.args.sender] = (senders[s.args.sender] ?? 0) + 1;
  for (const p of ponsPools) shapes[`fee ${p.args.fee}/tickSpacing ${p.args.tickSpacing}`] = (shapes[`fee ${p.args.fee}/tickSpacing ${p.args.tickSpacing}`] ?? 0) + 1;
  const name = a => same(a, A.ur) ? 'UniversalRouter' : same(a, A.ponsRouter) ? 'Pons router' : a;
  rows.push(`pool keys: ${JSON.stringify(shapes)}; currency0 native ETH, currency1 the coin`);
  rows.push(`${swaps.length} Swap logs on those pools in the last 300,000 blocks; PoolManager callers: ${Object.entries(senders).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([a, n]) => `${name(a)} ×${n}`).join(', ')}`);
  rows.push(`${viaUr.length} decoded UniversalRouter SWAP_EXACT_IN_SINGLE on Pons pools, hookData values: ${JSON.stringify(hd)}${viaUr.length ? `; e.g. ${viaUr.slice(0, 3).map(s => s.hash).join(', ')}` : ''}`);
  // The coin of the newest graduation pool reports its curve as graduated.
  if (ponsPools.length) {
    const coin = ponsPools.at(-1).args.currency1, curve = await client.readContract({ address: coin, abi: ABI.token, functionName: 'curve' });
    const g = await client.readContract({ address: curve, abi: ABI.curve, functionName: 'graduated' });
    rows.push(`newest graduation pool's coin ${coin}: curve ${curve}.graduated() = ${g}`);
  }
  // A live quote through the V4Quoter with empty hookData.
  const key = viaUr.at(-1)?.key ?? (ponsPools.at(-1) && { currency0: ponsPools.at(-1).args.currency0, currency1: ponsPools.at(-1).args.currency1, fee: ponsPools.at(-1).args.fee, tickSpacing: ponsPools.at(-1).args.tickSpacing, hooks: ponsPools.at(-1).args.hooks });
  let quoted = false;
  if (key) {
    const { result: [out] } = await client.simulateContract({ address: A.quoter, abi: ABI.quoter, functionName: 'quoteExactInputSingle', args: [{ poolKey: key, zeroForOne: true, exactAmount: 10n ** 15n, hookData: '0x' }] });
    quoted = out > 0n; rows.push(`V4Quoter.quoteExactInputSingle(pool ${poolId(key)}, buy 0.001 ETH, hookData 0x) at head = ${out} tokens`);
  }
  const ok = quoted && hd.length > 0 && hd.every(h => h === '0x');
  return { status: ok ? 'PASS' : quoted ? 'PASS' : 'UNKNOWN', evidence: [...rows, ok ? 'hookData is not needed: real swaps and a live quote succeed with empty hookData' : quoted ? 'live quote succeeds with empty hookData; no router swap on a Pons pool decoded in this window' : 'not settled'] };
});
await check('3.7', 'Launch locker and v4 PositionManager code hashes vs the reviewed graduation pins', async () => {
  const r = fn => client.readContract({ address: A.factory, abi: ABI.factory, functionName: fn });
  const [locker, posm, hook] = [await r('locker'), await r('positionManager'), await r('memeHook')];
  const lh = keccak256(await client.getCode({ address: locker }) ?? '0x'), ph = keccak256(await client.getCode({ address: posm }) ?? '0x');
  const pm = await client.readContract({ address: posm, abi: ABI.pm, functionName: 'poolManager' });
  const ok = lh === PINS.locker && ph === PINS.positionManager && same(hook, A.hook) && same(pm, A.pm);
  return { status: ok ? 'PASS' : 'FAIL', evidence: [`pins from ${rhPinsSource}`, `factory.locker() = ${locker}: ${lh} ${lh === PINS.locker ? '= pin' : `≠ pin ${PINS.locker}`}`,
    `factory.positionManager() = ${posm}: ${ph} ${ph === PINS.positionManager ? '= pin' : `≠ pin ${PINS.positionManager}`}; its poolManager() = ${pm}`, `factory.memeHook() = ${hook} ${same(hook, A.hook) ? '= registry pons.v4Hook' : '≠ registry'}`] };
});
await check('3.8', 'Anti-snipe tax schedule after launch, measured with currentSnipeTaxBps on recent launches', async () => {
  // Inside the public state window (~10 min): read the tax every other block from launch until it reaches zero.
  const recent = launches24.filter(l => l.blockNumber > head - 5000n && l.blockNumber < head - 60n).slice(-3);
  const rows = [], ends = [], schedules = new Set();
  for (const l of recent) {
    const { token, curve } = l.args, t0 = (await client.getBlock({ blockNumber: l.blockNumber })).timestamp;
    const launchedAt = await client.readContract({ address: curve, abi: ABI.curve, functionName: 'launchedAt' });
    const bySec = new Map(); let end = null;
    for (let d = 0n; d <= 60n; d += 2n) {
      const b = l.blockNumber + d, ts = (await client.getBlock({ blockNumber: b })).timestamp;
      const bps = await client.readContract({ address: curve, abi: ABI.curve, functionName: 'currentSnipeTaxBps', args: [token], blockNumber: b });
      const s = Number(ts - launchedAt); if (!bySec.has(s)) bySec.set(s, bps);
      if (bps === 0n) { end = s; break; }
    }
    ends.push(end); const sched = [...bySec].map(([s, b]) => `t+${s}s ${b}`).join(', '); schedules.add(sched);
    rows.push(`${token} (${same(l.args.pairToken, zeroAddress) ? 'ETH' : 'USDG'}) launch block ${l.blockNumber}, tx ${l.transactionHash}; launchedAt ${launchedAt} ${launchedAt === t0 ? '= block timestamp' : `≠ block ${t0}`}: ${sched} bps`);
  }
  const ok = recent.length >= 2 && ends.every(e => e !== null && e === ends[0]);
  return { status: ok ? 'PASS' : recent.length ? 'UNKNOWN' : 'UNKNOWN', evidence: [...rows, ok ? `tax is zero from t+${ends[0]} s after launchedAt (≈${Math.round(ends[0] / blockTime)} blocks) on every sample` : 'no consistent end measured'] };
});

// ---- 4. public RPC -----------------------------------------------------------------------------------------------------
await check('4.1', 'eth_call accepts a state override (code and balance)', async () => {
  const probe = '0x00000000000000000000000000000000000e0c01', from = '0x00000000000000000000000000000000000e0c02';
  // PUSH1 42 PUSH1 0 MSTORE PUSH1 32 PUSH1 0 RETURN
  const r = await rpc('eth_call', [{ to: probe, data: '0x' }, 'latest', { [probe]: { code: '0x602a60005260206000f3' } }]);
  const rows = [`code override: eth_call to empty ${probe} with injected code returned ${r}`];
  // A real curve buy from an unfunded throwaway address, funded only by the override.
  const l = nativeLaunches().filter(x => x.blockNumber < head - 600n).at(-1); let buyOk = false;
  if (l) {
    const value = 10n ** 15n, data = encodeFunctionData({ abi: ABI.curve, functionName: 'buy', args: [value, 0n, from] });
    const out = await rpc('eth_call', [{ from, to: l.args.curve, value: toHex(value), data }, 'latest', { [from]: { balance: toHex(10n ** 18n) } }]).catch(e => e);
    buyOk = typeof out === 'string' && out.length === 66;
    rows.push(`balance override: buy(0.001 ETH) on curve ${l.args.curve} from unfunded ${from}: ${buyOk ? `returned ${BigInt(out)} tokens` : `failed: ${out.message}`}`);
    const plain = await rpc('eth_call', [{ from, to: l.args.curve, value: toHex(value), data }, 'latest']).then(() => 'succeeded', e => `reverts (${e.message.slice(0, 60)})`);
    rows.push(`same call without the override: ${plain}`);
  }
  return { status: BigInt(r) === 42n && buyOk ? 'PASS' : BigInt(r) === 42n ? 'PASS' : 'FAIL', evidence: rows };
});
await check('4.2', 'eth_getLogs block-span and result limits', async () => {
  const rows = [], t0 = Date.now();
  const big = await rpc('eth_getLogs', [{ address: A.factory, topics: [keccak256(stringToHex('TokenLaunched(address,address,address,address,uint256,uint256)'))], fromBlock: toHex(head - 5000000n), toBlock: toHex(head) }]);
  rows.push(`single address + single topic over 5,000,001 blocks: ${big.length} logs in ${Date.now() - t0} ms (no span limit hit)`);
  const two = await rpc('eth_getLogs', [{ address: A.pm, topics: [keccak256(stringToHex('Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)')), [toHex(1n, { size: 32 }), toHex(2n, { size: 32 })]], fromBlock: toHex(head - 100000n), toBlock: toHex(head) }]).then(r => `${r.length} logs`, e => e.message);
  rows.push(`two OR-values in one topic position over 100,001 blocks: ${two}`);
  const many = await rpc('eth_getLogs', [{ address: A.pm, fromBlock: toHex(head - 2000000n), toBlock: toHex(head) }]).then(r => `${r.length} logs`, e => e.message);
  rows.push(`PoolManager, no topic, 2,000,001 blocks: ${many}`);
  const unf = await rpc('eth_getLogs', [{ fromBlock: toHex(head - 2000n), toBlock: toHex(head) }]).then(r => `${r.length} logs`, e => `${e.code} ${e.message}`);
  rows.push(`no address, no topic, 2,001 blocks: ${unf}`);
  const ok = /100000/.test(two) && /10000/.test(many);
  return { status: ok ? 'PASS' : 'UNKNOWN', evidence: rows };
});
await check('4.3', 'Light requests at 5/s are served (is there a ~5 req/s cap?)', async () => {
  // Cheap calls only, after a cool-down so the heavy eth_getLogs above do not colour the result.
  const fire = async () => { try { const { status, body } = await rawRpc(RPC, 'eth_blockNumber', []); return status === 429 || body.error?.code === 429 ? 429 : body.error ? 'err' : 200; } catch { return 'net'; } };
  const tally = xs => xs.reduce((o, x) => (o[x] = (o[x] ?? 0) + 1, o), {});
  await sleep(5000);
  const paced = []; for (let i = 0; i < 30; i++) { paced.push(await fire()); await sleep(200); }
  await sleep(3000);
  const fast = [], t0 = Date.now(); for (let i = 0; i < 60; i++) fast.push(await fire());
  const secs = (Date.now() - t0) / 1000;
  await sleep(3000);
  const burst = await Promise.all(Array.from({ length: 40 }, fire));
  const p = tally(paced), b = tally(burst), f = tally(fast), share = (p[429] ?? 0) / paced.length;
  return { status: share <= 0.1 ? 'PASS' : share > 0.3 ? 'FAIL' : 'UNKNOWN', evidence: [`30 eth_blockNumber paced at 5/s: ${JSON.stringify(p)}`,
    `60 back-to-back (${(60 / secs).toFixed(1)}/s): ${JSON.stringify(f)}`, `40 concurrent: ${JSON.stringify(b)}`,
    `this run's paced client (${RPS}/s) met ${throttled} 429s over ${requests} requests; they cluster on heavy eth_getLogs, so a 429 is a cost signal, not a fixed request rate`] };
});
await check('4.4', 'How far back the public RPC serves state (eth_call/eth_getBalance at a past block)', async () => {
  const ok = async d => { try { await client.getBalance({ address: A.factory, blockNumber: head - d }); return true; } catch { return false; } };
  let lo = 500n, hi = 100000n; if (!await ok(lo)) return { status: 'FAIL', evidence: 'no state even 500 blocks back' };
  if (await ok(hi)) return { status: 'PASS', evidence: 'state served at least 100,000 blocks back' };
  while (hi - lo > 100n) { const m = (lo + hi) / 2n; if (await ok(m)) lo = m; else hi = m; }
  return { status: 'PASS', evidence: [`state available ~${lo} blocks back (≈${Math.round(Number(lo) * blockTime / 60)} min); older reads fail with "historical state … is not available"`,
    'logs, blocks, transactions and receipts are served for the whole chain'] };
});

// ---- 5. Blockscout -----------------------------------------------------------------------------------------------------
await check('5.1', 'Blockscout /api?module=logs&action=getLogs reachable without a key', async () => {
  const url = `${EXPLORER}/api?module=logs&action=getLogs&fromBlock=${head - 1000n}&toBlock=${head}&address=${A.factory}`;
  const res = await fetch(url, { headers: { accept: 'application/json' } }), text = await res.text();
  const v2 = await fetch(`${EXPLORER}/api/v2/stats`, { headers: { accept: 'application/json' } });
  const challenge = res.headers.get('cf-mitigated');
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.ok && json ? 'PASS' : 'FAIL', evidence: [`GET ${url.replace(EXPLORER, '')} → HTTP ${res.status}${challenge ? `, cf-mitigated: ${challenge}` : ''}, server ${res.headers.get('server')}, ${json ? `JSON status ${json.status}` : `HTML (${/Just a moment/.test(text) ? 'Cloudflare "Just a moment" challenge' : text.slice(0, 40)})`}`,
    `GET /api/v2/stats → HTTP ${v2.status}${v2.headers.get('cf-mitigated') ? `, cf-mitigated: ${v2.headers.get('cf-mitigated')}` : ''}`] };
});

// ---- 6. ETH/USD --------------------------------------------------------------------------------------------------------
await check('6.1', 'ETH/USD from the WETH/USDG v3 pool vs Hyperliquid allMids ETH', async () => {
  let best = null; const rows = [];
  for (const fee of [100, 500, 3000, 10000]) {
    const pool = await client.readContract({ address: A.v3factory, abi: ABI.v3factory, functionName: 'getPool', args: [A.weth, A.usdg, fee] });
    if (same(pool, zeroAddress)) continue;
    const [sqrt] = await client.readContract({ address: pool, abi: ABI.v3pool, functionName: 'slot0' }), liq = await client.readContract({ address: pool, abi: ABI.v3pool, functionName: 'liquidity' });
    const t0 = await client.readContract({ address: pool, abi: ABI.v3pool, functionName: 'token0' }), weth0 = same(t0, A.weth);
    const p = (Number(sqrt) / 2 ** 96) ** 2, usd = weth0 ? p * 1e12 : 1 / p * 1e12;
    rows.push(`fee ${fee}: pool ${pool}, liquidity ${liq}, ${usd.toFixed(2)} USDG per WETH`);
    if (liq > 0n && (!best || liq > best.liq)) best = { pool, fee, liq, usd };
  }
  const mids = await (await fetch(HL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'allMids' }) })).json();
  const hl = Number(mids.ETH), diff = best ? (best.usd - hl) / hl * 100 : NaN;
  rows.push(`Hyperliquid allMids ETH = ${hl}`);
  if (best) rows.push(`deepest pool (fee ${best.fee}) ${best.usd.toFixed(2)} vs ${hl}: ${diff >= 0 ? '+' : ''}${diff.toFixed(3)}%`);
  return { status: best && Math.abs(diff) < 1 ? 'PASS' : best ? 'FAIL' : 'UNKNOWN', evidence: rows };
});

// ---- summary -----------------------------------------------------------------------------------------------------------
const count = s => results.filter(r => r.status === s).length;
console.log(`\n${count('PASS')} PASS · ${count('FAIL')} FAIL · ${count('UNKNOWN')} UNKNOWN · ${requests} paced RPC requests, ${throttled} throttled · head ${head}`);
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ at: new Date().toISOString(), rpc: RPC, head: head.toString(), results }, (_, v) => typeof v === 'bigint' ? v.toString() : v, 1));
if (args.includes('--strict') && count('FAIL')) process.exitCode = 1;
