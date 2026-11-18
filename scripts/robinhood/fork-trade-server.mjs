/**
 * Robinhood Chain trading through EKO's own server, end to end, on a local anvil fork of 4663. Nothing touches mainnet
 * but reads; every key is a throwaway made here.
 *
 *   node scripts/robinhood/fork-trade-server.mjs
 *
 * 1. Picks two native-ETH Pons coins launched within the last WINDOW_BLOCKS (default 260,000, about 7 hours) from the
 *    public RPC: the newest still on its curve, and the newest that graduated into its Pons v4 pool. (Graduation cannot
 *    be forced on a fork: a direct curve buy-out closes the curve, but the factory's graduate(token) reverts for an
 *    outside caller; on mainnet a keeper contract graduates.)
 * 2. Starts the edge (apps/edge, EKO_CHAIN=robinhood) with every RPC lane on a local relay. The relay first forwards to the
 *    public RPC while the edge replays the window (that takes minutes, and the public RPC keeps only about nine minutes of
 *    state, so a fork made before the replay would have gone stale). Once the edge is at the head and follows both coins,
 *    it starts `anvil --fork-url $ROBINHOOD_RPC --chain-id 4663 --port 8548 --silent` (or uses FORK_RPC), mines a few
 *    blocks and points the relay at the fork: from then on the edge, the wallet and this script all see the fork.
 * 3. As a signed-in wallet (SIWE on chain 4663), for each coin: quote a $1 buy, place the order, sign and send the returned
 *    transaction, report it submitted and poll the order until it settles; then the same for a sell of about half,
 *    sending the exact approvals the quote asks for first.
 * 4. Compares each settled order's filledIn / filledOut with the wallet's real ETH change (gas included) and coin change,
 *    to the wei. Prints MATCH or MISMATCH per figure; exits 1 on any mismatch.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const EDGE = fileURLToPath(new URL('../../apps/edge/', import.meta.url));
const req = createRequire(join(EDGE, 'package.json'));
const viem = await import(pathToFileURL(req.resolve('viem')).href);
const { privateKeyToAccount, generatePrivateKey } = await import(pathToFileURL(req.resolve('viem/accounts')).href);
const { createSiweMessage } = await import(pathToFileURL(req.resolve('viem/siwe')).href);

const UPSTREAM = process.env.ROBINHOOD_RPC ?? 'https://rpc.mainnet.chain.robinhood.com';
const PORT = 8548, RELAY_PORT = 8549, EDGE_PORT = Number(process.env.EDGE_PORT ?? 8092), EDGE_URL = `http://127.0.0.1:${EDGE_PORT}`;
const FORK = process.env.FORK_RPC ?? `http://127.0.0.1:${PORT}`, RELAY = `http://127.0.0.1:${RELAY_PORT}`;
/** The edge replays this many blocks at start; both coins must launch inside it. */
const WINDOW = BigInt(process.env.WINDOW_BLOCKS ?? 260_000);
const children = [];
const stop = () => { for (const c of children) c.kill(); };
process.on('exit', stop);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);

// Registry addresses (packages/chain/addresses.4663.yaml).
const A = {
  factory: '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e', hook: '0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044',
  poolManager: '0x8366a39CC670B4001A1121B8F6A443A643e40951', permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
};
const chainOf = (url) => viem.defineChain({ id: 4663, name: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [url] } } });
const upstream = viem.createPublicClient({ chain: chainOf(UPSTREAM), transport: viem.http(UPSTREAM, { retryCount: 8, retryDelay: 1500 }) });
const head = await upstream.getBlockNumber(), headTs = Number((await upstream.getBlock()).timestamp);

const curveAbi = viem.parseAbi(['function graduated() view returns (bool)', 'function readyToGraduate() view returns (bool)', 'function sellableTokens() view returns (uint256)',
  'function getReserves() view returns (uint256, uint256)', 'function currentSnipeTaxBps(address) view returns (uint256)']);
const erc20 = viem.parseAbi(['function balanceOf(address) view returns (uint256)', 'function symbol() view returns (string)', 'function approve(address, uint256) returns (bool)']);
const permit2Abi = viem.parseAbi(['function approve(address token, address spender, uint160 amount, uint48 expiration)']);
const launched = viem.parseAbiItem('event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)');
const initialized = viem.parseAbiItem('event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)');
const openCurve = async (c, l) => {
  const read = (functionName, args = []) => c.readContract({ address: l.args.curve, abi: curveAbi, functionName, args });
  const [g, ready, sellable, [, tokens], snipe] = await Promise.all([read('graduated'), read('readyToGraduate'), read('sellableTokens'), read('getReserves'), read('currentSnipeTaxBps', [l.args.token])]);
  return !g && !ready && snipe === 0n && sellable > tokens / 4n;
};

// Launches in the window (native ETH only), newest first.
const launches = [];
for (let to = head; to > head - WINDOW; to -= 20_000n) {
  const from = to - 19_999n > head - WINDOW ? to - 19_999n : head - WINDOW + 1n;
  launches.push(...await upstream.getLogs({ address: A.factory, event: launched, fromBlock: from, toBlock: to }));
}
const native = launches.filter(l => l.args.pairToken === viem.zeroAddress).sort((x, y) => Number(y.blockNumber - x.blockNumber));
let curveCoin = null;
for (const l of native) {
  // Launched over two minutes ago (well past the 3-second snipe tax) and still open, with most of its supply unsold.
  if (headTs - Number((await upstream.getBlock({ blockNumber: l.blockNumber })).timestamp) < 120 || !await openCurve(upstream, l).catch(() => false)) continue;
  curveCoin = { token: l.args.token, curve: l.args.curve, launchBlock: l.blockNumber, log: l }; break;
}
if (!curveCoin) throw new Error('No open native-ETH curve launched inside the window');
let graduated = null;
{
  const pools = await upstream.getLogs({ address: A.poolManager, event: initialized, args: { currency0: viem.zeroAddress }, fromBlock: head - WINDOW + 1n, toBlock: head });
  for (const p of pools.filter(p => p.args.hooks.toLowerCase() === A.hook.toLowerCase()).reverse()) {
    const l = native.find(x => x.args.token.toLowerCase() === p.args.currency1.toLowerCase());
    if (l) { graduated = { token: l.args.token, curve: l.args.curve, launchBlock: l.blockNumber, how: `graduated on mainnet at block ${p.blockNumber}` }; break; }
  }
  if (!graduated) throw new Error(`No Pons coin both launched and graduated in the last ${WINDOW} blocks: raise WINDOW_BLOCKS`);
}

// The relay: JSON-RPC forwarded to `target` (the public RPC, then the fork).
let target = UPSTREAM;
const relay = createServer((rq, rs) => {
  const chunks = [];
  rq.on('data', c => chunks.push(c));
  rq.on('end', async () => {
    try {
      const res = await fetch(target, { method: 'POST', headers: { 'content-type': 'application/json' }, body: Buffer.concat(chunks) });
      rs.writeHead(res.status, { 'content-type': 'application/json' }); rs.end(Buffer.from(await res.arrayBuffer()));
    } catch (e) { rs.writeHead(502); rs.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: String(e).slice(0, 200) } })); }
  });
});
await new Promise(r => relay.listen(RELAY_PORT, '127.0.0.1', r));
process.on('exit', () => relay.close());

// The edge: every RPC lane is the relay, at the public RPC's safe pace; it replays from before both launches.
const backfill = head - (curveCoin.launchBlock < graduated.launchBlock ? curveCoin.launchBlock : graduated.launchBlock) + 200n;
const dir = mkdtempSync(join(tmpdir(), 'eko-fork-edge-'));
const edge = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], { cwd: EDGE, stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env,
  EKO_CHAIN: 'robinhood', RPC_HTTP_URL: RELAY, RPC_PUBLIC_HTTP_URL: RELAY, RPC_RELAY_URL: RELAY,
  RPC_PUBLIC_MAX_RPM: process.env.EDGE_RPM ?? '180', RPC_PAID_MAX_RPM: process.env.EDGE_RPM ?? '120',
  RPC_USAGE_DIR: join(dir, 'usage'), HISTORY_DB: join(dir, 'history.db'), HISTORIAN: 'off', COLUMNS_SNAPSHOT: 'off', PORT: String(EDGE_PORT), HOST: '127.0.0.1',
  BACKFILL_BLOCKS: String(backfill), POLL_MS: '1000', MAX_TRADE_USD: '250', TRUST_PROXY_HOPS: '0' } });
children.push(edge);
let edgeLog = '';
edge.stdout.on('data', (d) => { edgeLog += d; if (process.env.EDGE_LOG) process.stdout.write(d); });
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

let cookie = '';
async function api(method, path, body) {
  const res = await fetch(EDGE_URL + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const json = await res.json().catch(() => null);
  return { status: res.status, json, headers: res.headers };
}
const following = async () => {
  const h = await api('GET', '/health').catch(() => null);
  return !!h?.json?.ok && h.json.lagBlocks < 50 && (await api('GET', `/v1/coins/${curveCoin.token}`)).status === 200 && (await api('GET', `/v1/coins/${graduated.token}`)).status === 200;
};
const started = Date.now();
for (let i = 0; !await following(); i++) {
  if (i > 3600) throw new Error(`The edge did not follow both coins in time:\n${edgeLog.slice(-2000)}`);
  await sleep(1000);
}
log(`edge replayed ${backfill} blocks from the public RPC in ${Math.round((Date.now() - started) / 1000)} s`);

// Now the fork, fresh: the relay switches to it, and the edge follows its blocks.
if (!process.env.FORK_RPC) children.push(spawn('anvil', ['--fork-url', UPSTREAM, '--chain-id', '4663', '--port', String(PORT), '--silent'], { stdio: 'inherit' }));
const chain = chainOf(FORK);
const client = viem.createPublicClient({ chain, transport: viem.http(FORK, { retryCount: 6 }) });
for (let i = 0; ; i++) { try { await client.getChainId(); break; } catch { if (i > 120) throw new Error(`No fork at ${FORK}`); await sleep(500); } }
await client.request({ method: 'anvil_mine', params: ['0x3'] });
const forkHead = await client.getBlockNumber();
target = FORK;
// The edge may have read a few public blocks past the fork point while anvil started: mine past them, so every block of
// the fork it follows from now on is new to it.
{
  const cursor = BigInt((await api('GET', '/health')).json.cursor);
  if (cursor >= forkHead) await client.request({ method: 'anvil_mine', params: [viem.toHex(cursor - forkHead + 3n)] });
}
if (!await openCurve(client, curveCoin.log)) throw new Error('The curve coin closed before the fork');
for (let i = 0; ; i++) {
  const h = (await api('GET', '/health')).json;
  if (h?.head >= Number(forkHead) && h.lagBlocks < 5 && await following()) break;
  if (i > 300) throw new Error(`The edge did not follow the fork:\n${edgeLog.slice(-2000)}`);
  await sleep(1000);
}

// A throwaway wallet with 1 ETH, signed in with SIWE on chain 4663.
const account = privateKeyToAccount(generatePrivateKey());
await client.request({ method: 'anvil_setBalance', params: [account.address, viem.toHex(10n ** 18n)] });
const wallet = viem.createWalletClient({ account, chain, transport: viem.http(FORK) });
{
  const n = (await api('POST', '/v1/auth/siwe/nonce')).json;
  const message = createSiweMessage({ domain: n.domain, address: account.address, statement: 'Sign in to EKO.', uri: n.uri, version: '1', chainId: 4663, nonce: n.nonce,
    issuedAt: new Date(n.issuedAt), expirationTime: new Date(n.expirationTime) });
  const r = await api('POST', '/v1/auth/siwe/verify', { message, signature: await account.signMessage({ message }) });
  if (r.status !== 200) throw new Error(`Sign-in failed: ${r.status} ${JSON.stringify(r.json)}`);
  cookie = String(r.headers.get('set-cookie')).split(';')[0];
  const config = (await api('GET', '/v1/config')).json;
  log(`edge ${EDGE_URL} on fork ${FORK} (of ${UPSTREAM}, forked at block ${forkHead}): chain ${config.chain.key} ${config.chain.id}; routers ${config.trading.routers}; spenders ${config.trading.spenders}`);
  log(`signed in as ${account.address} (throwaway, 1 ETH from anvil_setBalance)`);
}

const eth = (blockNumber) => client.getBalance({ address: account.address, blockNumber });
const coinBal = (token, blockNumber) => client.readContract({ address: token, abi: erc20, functionName: 'balanceOf', args: [account.address], blockNumber });
async function send(tx) {
  const hash = await wallet.sendTransaction({ account, to: tx.to, data: tx.data, value: BigInt(tx.value) });
  const r = await client.waitForTransactionReceipt({ hash });
  return { hash, receipt: r, gas: r.gasUsed * r.effectiveGasPrice };
}
let mismatches = 0;
const compare = (label, got, want) => {
  const ok = got !== undefined && got !== null && BigInt(got) === want;
  if (!ok) mismatches++;
  log(`  ${ok ? 'MATCH   ' : 'MISMATCH'} ${label}: order ${got ?? 'absent'} / wallet ${want}`);
};

async function trade(label, coin, side, amountUsd) {
  let q = (await api('POST', '/v1/trade/quote', { coin: coin.token, side, amountUsd, slippageBps: 300 })).json;
  if (!q?.id) throw new Error(`${label} ${side} quote: ${JSON.stringify(q)}`);
  for (const ap of q.approvals) {
    const tx = ap.kind === 'erc20' ? { to: ap.token, value: '0', data: viem.encodeFunctionData({ abi: erc20, functionName: 'approve', args: [ap.spender, BigInt(ap.amount)] }) }
      : { to: A.permit2, value: '0', data: viem.encodeFunctionData({ abi: permit2Abi, functionName: 'approve', args: [ap.token, ap.spender, BigInt(ap.amount), ap.expiration] }) };
    const r = await send(tx);
    log(`  approval ${ap.kind} ${ap.amount} to ${ap.spender}: ${r.receipt.status} ${r.hash}`);
  }
  // A fresh quote now that the approvals are in place (it asks for none).
  if (q.approvals.length) { q = (await api('POST', '/v1/trade/quote', { coin: coin.token, side, amountUsd, slippageBps: 300 })).json; if (q.approvals?.length) throw new Error(`${label} still needs approvals`); }
  const warn = q.guard.checks.filter(c => c.status === 'warn').map(c => c.code);
  const o = await api('POST', '/v1/trade/order', { quoteId: q.id, idempotencyKey: `${label}-${side}-${Date.now()}`, acknowledged: warn });
  if (o.status !== 200) throw new Error(`${label} ${side} order: ${o.status} ${JSON.stringify(o.json)}`);
  const { order, tx } = o.json;
  if (tx.chainId !== 4663) throw new Error(`transaction for chain ${tx.chainId}`);
  const s = await send(tx);
  const block = s.receipt.blockNumber;
  const [e0, e1, c0, c1] = await Promise.all([eth(block - 1n), eth(block), coinBal(coin.token, block - 1n), coinBal(coin.token, block)]);
  await api('POST', `/v1/trade/order/${order.id}/submitted`, { txHash: s.hash });
  let settled;
  for (let i = 0; i < 120; i++) { settled = (await api('GET', `/v1/trade/orders/${order.id}`)).json; if (!['awaiting_signature', 'submitted'].includes(settled.status)) break; await sleep(1000); }
  log(`  ${side} $${amountUsd} via ${q.route.venue} (${q.route.poolId}): order ${order.id} ${settled.status}; tx ${s.hash} gas ${s.receipt.gasUsed}; quoted out ${q.expectedOut}, min ${q.minOut}; guard ${q.guard.decision}${warn.length ? ` (${warn})` : ''}`);
  if (settled.status !== 'confirmed') { mismatches++; log(`  MISMATCH ${label} ${side}: order ${settled.status} ${settled.errorCode ?? ''}`); return 0n; }
  if (side === 'buy') {
    compare(`${label} buy filledIn = ETH spent, gas excluded`, settled.filledIn, e0 - e1 - s.gas);
    compare(`${label} buy filledOut = coin received`, settled.filledOut, c1 - c0);
  } else {
    compare(`${label} sell filledIn = coin sent`, settled.filledIn, c0 - c1);
    compare(`${label} sell filledOut = ETH received, gas added back`, settled.filledOut, e1 - e0 + s.gas);
  }
  return c1 - c0;
}

try {
  for (const [label, coin] of [['curve', curveCoin], ['graduated', graduated]]) {
    const symbol = await client.readContract({ address: coin.token, abi: erc20, functionName: 'symbol' }).catch(() => '?');
    log(`\n${label}: ${symbol} ${coin.token}, curve ${coin.curve}, launched at block ${coin.launchBlock}${coin.how ? `; ${coin.how}` : ''}`);
    const card = (await api('GET', `/v1/coins/${coin.token}`)).json;
    log(`  card: stage ${card.identity.stage}, pool ${card.identity.pools[0].venue}, verdict ${card.verdict.level}, exit cost ${card.tradeability.exitCostPct.usd1k}%`);
    await trade(label, coin, 'buy', 1);
    // About half: the server sizes a sell in dollars at the last trade's price (our buy), capped at the balance.
    await trade(label, coin, 'sell', 0.5);
  }
} catch (e) { mismatches++; log(`ERROR ${e.stack ?? e}\n${edgeLog.slice(-1500)}`); }
log(mismatches ? `\n${mismatches} MISMATCH(ES)` : '\nEvery settled order matches the wallet\'s balance changes to the wei.');
stop();
process.exit(mismatches ? 1 : 0);
