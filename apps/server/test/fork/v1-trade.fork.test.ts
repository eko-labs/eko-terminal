/**
 * End-to-end v1 trade API (`/v1/trade/*`) against a local fork of Robinhood Chain mainnet (chain 4663).
 *
 * The real server (`buildApp`, fresh in-memory database) installs its production trade backend from configuration
 * (LIVE_TRADING_ENABLED, the pinned-block RPC and ANVIL_FORK_URL): it quotes through the Uniswap v3 adapter, admits
 * through the access, sanctions, sell-check and policy code, measures every quote and order on the simulation host,
 * returns unsigned bytes, and its reconcile worker confirms fills from receipts. A key generated at test time signs; it
 * is funded with fork-only ETH by `anvil_setBalance`. No real funds, wallets or keys, and no paid RPC: Anvil forks the
 * public RPC only. Admission runs on the current verdict with no Guard v2 release, as at launch. `v1-trade-harness.ts`
 * lists the only test seams (indexer and engine rows, Anvil's L2-only gas, the retrying relay). Pons coins are real ones
 * at the fork block, traded under the presets as production runs them: two open native curves and one coin that
 * graduated to its v4 pool.
 *
 * Anvil processes on fixed ports: the trading chain (8547, forked from the public RPC through a retrying loopback relay
 * on 8546, one block per second like a live chain) and one simulation host per server (8548, 8549; each started with `--fork-url` to the trading chain and
 * reset to each order's block). The public RPC keeps only about 6,000 blocks (~12 minutes) of state, so the fork pins
 * a block just behind the current head unless FORK_BLOCK_NUMBER names one still inside that window. All processes are
 * killed in afterAll, on process exit and by a 14-minute watchdog.
 *
 * Requires Anvil (Foundry). Run:  pnpm --filter @eko/server test:fork
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPublicClient, createWalletClient, erc20Abi, http, parseEther, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { robinhood } from 'viem/chains';
import { NETWORKS, SIWE_STATEMENT, SiweNonceSchema, TradeOrderSchema, TradeQuoteSchema, UnsignedTxSchema,
  type TradeOrder, type TradeQuote, type UnsignedTx } from '@eko/shared';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { tradeOrders } from '../../src/db/schema.js';
import { SellGuard } from '../../src/exec/sell-guard.js';
import { seedSanctions } from '../sanctions-fixture.js';
import { liveTradeSources } from '../../src/exec/live-trade.js';
import { indexedPonsCurves, PONS_CURVE_ABI, ponsTradeCall, quotePonsTrade, readPonsCurve, type PonsTradeSources } from '../../src/exec/pons-routes.js';
import { PERMIT2, PERMIT2_ABI, readV4Pool, V4_ROUTER } from '../../src/exec/v4-routes.js';
import { ponsGraduationLock } from '../../src/exec/pons-graduation.js';
import { anvilNetworkFeeWei, findGraduatedPons, findOpenPonsLaunches, forkLog, ROUTER, seedIndexedState, setScanPending, setStoredSellCheck, setVerdict,
  startPublicRpcRelay, USDG, warmForkState, warmPons, WETH, type PonsSeed } from './v1-trade-harness.js';

const ANVIL = process.env.ANVIL_BIN ?? 'anvil';
const RELAY_PORT = 8546, CHAIN_PORT = 8547, SIM_PORT = 8548, SIM_B_PORT = 8549;
const CHAIN_RPC = `http://127.0.0.1:${CHAIN_PORT}`;
const PUBLIC_RPC = NETWORKS['robinhood-mainnet'].publicRpcUrl;
const RUN_LIMIT_MS = 14 * 60_000;
const ORIGIN = 'https://app.eko.example';
const SECRET = 'fork-v1-trade-placeholder'.repeat(2);

const chain = { ...robinhood, rpcUrls: { default: { http: [CHAIN_RPC] } } };
// First reads of an untouched slot wait on the rate-limited public RPC, so the test's own clients allow a minute.
const transport = () => http(CHAIN_RPC, { retryCount: 0, timeout: 60_000 });
const rpc = createPublicClient({ chain, transport: transport() });
const patient = createPublicClient({ chain, transport: http(CHAIN_RPC, { retryCount: 0, timeout: 180_000 }) });
const trader = privateKeyToAccount(generatePrivateKey());
const other = privateKeyToAccount(generatePrivateKey());
const admin = privateKeyToAccount(generatePrivateKey());
// Buys out a Pons curve on the fork so it graduates (fork-only ETH).
const whale = privateKeyToAccount(generatePrivateKey());
const traderWallet = createWalletClient({ account: trader, chain, transport: transport() });
const otherWallet = createWalletClient({ account: other, chain, transport: transport() });
const whaleWallet = createWalletClient({ account: whale, chain, transport: transport() });

const children: ChildProcess[] = [];
const killAnvils = () => { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); };
process.once('exit', killAnvils);
const watchdog = setTimeout(() => { killAnvils(); console.error('v1 trade fork run exceeded its time limit'); process.exit(1); }, RUN_LIMIT_MS);
watchdog.unref();

interface Server { built: Awaited<ReturnType<typeof buildApp>>; cookie: string }
let srv: Server;
let primary: Server;
let forkBlock: bigint;
let relay: Awaited<ReturnType<typeof startPublicRpcRelay>> | undefined;
/** Two open native curves (a buy and sell; a buyout that graduates the curve) and a coin that graduated before the fork block. */
let pons: { open: PonsSeed[]; graduated: PonsSeed | null } = { open: [], graduated: null };
let forkEthUsd: number;

const portFree = (port: number) => new Promise<boolean>(resolve => {
  const socket = createConnection({ host: '127.0.0.1', port });
  socket.once('connect', () => { socket.destroy(); resolve(false); });
  socket.once('error', () => resolve(true));
});
async function startAnvil(port: number, args: string[], expectedBlock?: bigint) {
  // Never attach to a process this run did not start.
  if (!await portFree(port)) throw new Error(`Port ${port} is already in use; stop the other Anvil first`);
  const child = spawn(ANVIL, ['--host', '127.0.0.1', '--port', String(port), '--silent', '--no-storage-caching', ...args], { stdio: 'ignore' });
  children.push(child);
  let failure: Error | undefined;
  child.once('error', error => { failure = error; });
  const client = createPublicClient({ transport: http(`http://127.0.0.1:${port}`, { retryCount: 0 }) });
  await waitFor(async () => {
    if (failure) throw failure;
    if (child.exitCode !== null) throw new Error(`Anvil on ${port} exited with code ${child.exitCode}`);
    try { return await client.getChainId() === 4663 && (expectedBlock === undefined || await client.getBlockNumber() >= expectedBlock) ? true : null; }
    catch { return null; }
  }, 60_000, 250);
}
async function waitFor<T>(fn: () => Promise<T | null>, ms: number, every = 1000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - started > ms) throw new Error('timed out');
    await new Promise(resolve => setTimeout(resolve, every));
  }
}

const cookieOf = (response: { cookies: { name: string; value: string }[] }) => `eko_sid=${response.cookies.find(c => c.name === 'eko_sid')!.value}`;
const inject = (built: Server['built'], session: string, method: 'GET' | 'POST' | 'PUT', path: string, payload?: object) =>
  built.app.inject({ method, url: `/v1${path}`, headers: { cookie: session, origin: ORIGIN }, ...(payload ? { payload } : {}) });
const api = (session: string, method: 'GET' | 'POST' | 'PUT', path: string, payload?: object) => inject(srv.built, session, method, path, payload);
async function signIn(built: Server['built'], wallet: PrivateKeyAccount) {
  const guest = cookieOf(await built.app.inject('/v1/me'));
  const challenge = SiweNonceSchema.parse((await inject(built, guest, 'POST', '/auth/siwe/nonce')).json());
  const message = createSiweMessage({ domain: challenge.domain, uri: challenge.uri, address: wallet.address, chainId: 4663,
    nonce: challenge.nonce, version: '1', statement: SIWE_STATEMENT, issuedAt: new Date(challenge.issuedAt), expirationTime: new Date(challenge.expirationTime) });
  const verified = await inject(built, guest, 'POST', '/auth/siwe/verify', { message, signature: await wallet.signMessage({ message }) });
  expect(verified.statusCode, verified.body).toBe(200);
  return cookieOf(verified);
}
const tradingLive = async (built: Server['built'], enabled: boolean) => {
  const response = await inject(built, await signIn(built, admin), 'PUT', '/admin/trading/live', { enabled });
  expect(response.statusCode, response.body).toBe(200);
};

/** A production-configured server on its own simulation host; Anvil's gas is the only code seam. */
async function startServer(simPort: number, sellCheck: boolean): Promise<Server & { indexed: Awaited<ReturnType<typeof seedIndexedState>> }> {
  await startAnvil(simPort, ['--fork-url', CHAIN_RPC, '--no-rate-limit']);
  let built: Server['built'] | undefined;
  const cfg = loadConfig({
    NODE_ENV: 'test', APP_ROLE: 'api', PGLITE_DIR: ':memory:', PUBLIC_ORIGIN: ORIGIN, SESSION_SECRET: SECRET, DEMO_SECRET: SECRET,
    MARKET_DATA_SOURCE: 'onchain', LEGACY_API: 'false', LEGACY_SIGNALS: 'false', RUN_WORKER: 'false',
    // Every chain read, including "paid"-routed pinned-block reads, goes to the local fork; probes go to the sim host.
    RH_MAINNET_RPC_URL: CHAIN_RPC, RPC_HTTP_URL: CHAIN_RPC, RPC_PUBLIC_HTTP_URL: CHAIN_RPC, RH_TESTNET_RPC_URL: 'http://127.0.0.1:9',
    RPC_PAID_MAX_RPM: '60000', RPC_PUBLIC_MAX_RPM: '60000', ANVIL_FORK_URL: `http://127.0.0.1:${simPort}`,
    // Public-launch admission: no allowlist, the published cap schedule started an hour ago, zero fee.
    LIVE_TRADING_ENABLED: 'true', TRADING_ALLOWLIST_ONLY: 'false', TRADE_CAPS_FROM: new Date(Date.now() - 3_600_000).toISOString(),
    FEE_BPS_DEFAULT: '0', SELL_CHECK_ENABLED: String(sellCheck), ADMIN_WALLETS: admin.address,
  } as NodeJS.ProcessEnv);
  built = await buildApp(cfg, { startBackground: false,
    tradeOverrides: { sources: { networkFeeWei: anvilNetworkFeeWei(() => built!.ctx.chains.get('robinhood-mainnet')) } } });
  // Production-shaped data: OFAC snapshot, indexed tokens/pools/ETH price, Guard verdicts and the runtime switch.
  await seedSanctions(built.ctx.dbh.chain);
  await built.ctx.dbh.chain.ensurePartitions(new Date());
  const seeds = [...pons.open, ...(pons.graduated ? [pons.graduated] : [])];
  const indexed = await seedIndexedState(built.ctx.dbh.chain.sql, patient, forkBlock, { pons: seeds });
  // Current verdicts as the engines publish them (Radar), the Pons coins included.
  for (const coin of [USDG, WETH, ...seeds.map(p => p.coin)]) await setVerdict(built.ctx.dbh.chain.sql, coin, 'clear', forkBlock);
  await tradingLive(built, true);
  const server = { built, cookie: await signIn(built, trader), indexed };
  // The worker role's reconcile loop (1.5 s ticks), as `APP_ROLE=worker` starts it.
  built.ctx.exec.start();
  return server;
}
/** Repeat a small buy quote until it binds: every leg of the probe has then run once against this fork. */
async function warmApi(server: Server) {
  let last = '';
  await waitFor(async () => {
    const buy = await inject(server.built, server.cookie, 'POST', '/trade/quote', { coin: USDG, side: 'buy', amountUsd: 5, slippageBps: 50, account: trader.address });
    last = `${buy.statusCode} ${buy.statusCode === 200 ? JSON.stringify({ binding: buy.json().binding, guard: buy.json().guard }) : buy.body.slice(0, 300)}`;
    forkLog('warm-up quote', last);
    return buy.statusCode === 200 && (buy.json() as TradeQuote).binding ? true : null;
  }, 180_000, 2_000).catch(error => { throw new Error(`Fork warm-up did not converge: ${last}`, { cause: error }); });
}

type QuoteBody = { coin: Address; side: 'buy' | 'sell'; amountUsd: number; slippageBps?: number; riskMode?: 'safe' | 'balanced' | 'degen' };
const quoteResponse = (body: QuoteBody) => api(srv.cookie, 'POST', '/trade/quote', { slippageBps: 50, account: trader.address, ...body });
async function quote(body: QuoteBody): Promise<TradeQuote> {
  const response = await quoteResponse(body);
  expect(response.statusCode, response.body).toBe(200);
  const q = TradeQuoteSchema.parse(response.json());
  forkLog('quote', body.side, body.amountUsd, q.binding, q.approvals, q.guard.checks);
  return q;
}
const orderResponse = (q: TradeQuote, idempotencyKey: string) => api(srv.cookie, 'POST', '/trade/order', { quoteId: q.id, idempotencyKey, acknowledged: [] });
async function order(q: TradeQuote, idempotencyKey: string) {
  const response = await orderResponse(q, idempotencyKey);
  expect(response.statusCode, response.body).toBe(201);
  const body = response.json() as { order: TradeOrder; tx: UnsignedTx };
  return { order: TradeOrderSchema.parse(body.order), tx: UnsignedTxSchema.parse(body.tx), raw: body };
}
async function submitted(id: string, txHash: Hex) {
  const response = await api(srv.cookie, 'POST', `/trade/order/${id}/submitted`, { txHash });
  expect(response.statusCode, response.body).toBe(200);
  return TradeOrderSchema.parse(response.json());
}
const detail = async (id: string) => TradeOrderSchema.parse((await api(srv.cookie, 'GET', `/trade/orders/${id}`)).json());
const settled = (id: string) => waitFor(async () => {
  const o = await detail(id);
  return o.status === 'submitted' || o.status === 'awaiting_signature' ? null : o;
}, 90_000);
const send = async (tx: UnsignedTx, from = traderWallet, gas?: bigint) => {
  const hash = await from.sendTransaction({ to: tx.to, data: tx.data, value: BigInt(tx.value), ...(gas ? { gas } : {}) });
  return { hash, receipt: await rpc.waitForTransactionReceipt({ hash }) };
};
const balanceOf = (token: Address, who: Address = trader.address) => rpc.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [who] });
const allowanceOf = (token: Address, spender: Address = ROUTER) => rpc.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [trader.address, spender] });
/** Send the exact approval and return its network fee in wei. */
async function approveExact(token: Address, amount: bigint, spender: Address = ROUTER) {
  const hash = await traderWallet.writeContract({ address: token, abi: erc20Abi, functionName: 'approve', args: [spender, amount] });
  const receipt = await rpc.waitForTransactionReceipt({ hash });
  expect(receipt.status).toBe('success');
  expect(await allowanceOf(token, spender)).toBe(amount);
  return receipt.gasUsed * receipt.effectiveGasPrice;
}
const refusalCodes = (q: TradeQuote) => q.guard.checks.filter(c => c.status === 'refuse').map(c => c.code);

/**
 * The web app's guarded sequence (apps/web/src/lib/tradeFlow.ts): a wallet-bound quote; each listed approval checked
 * as exact and sent; a fresh quote that must list none (else `approval_pending`); then order, sign and report.
 */
async function tradeLikeTheWebApp(body: QuoteBody, idempotencyKey: string, target: Address = ROUTER) {
  let q = await quote(body);
  expect(q, JSON.stringify(q.guard)).toMatchObject({ binding: true, route: { executable: true }, guard: { decision: 'allow' } });
  const approved = q.approvals;
  let approvalFeeWei = 0n;
  for (const step of q.approvals) {
    expect(step).toMatchObject({ amount: q.amountIn });
    // v3 and Pons curves: one exact ERC-20 approval to the target. Uniswap v4: ERC-20 to Permit2, then Permit2 to the router.
    if (step.kind === 'permit2') {
      expect(step).toMatchObject({ token: q.coin, spender: target, expiration: expect.any(Number) });
      const hash = await traderWallet.writeContract({ address: PERMIT2, abi: PERMIT2_ABI, functionName: 'approve', args: [step.token, step.spender, BigInt(step.amount), step.expiration!] });
      const receipt = await rpc.waitForTransactionReceipt({ hash });
      expect(receipt.status).toBe('success');
      approvalFeeWei += receipt.gasUsed * receipt.effectiveGasPrice;
    } else {
      expect(step).toMatchObject({ spender: target === V4_ROUTER ? PERMIT2 : target, kind: 'erc20' });
      approvalFeeWei += await approveExact(step.token, BigInt(step.amount), step.spender);
    }
  }
  if (q.approvals.length) {
    q = await quote(body);
    expect(q, JSON.stringify(q.guard)).toMatchObject({ binding: true, approvals: [] });
  }
  const placed = await order(q, idempotencyKey);
  expect(placed.tx).toMatchObject({ chainId: 4663, to: target, value: q.valueWei });
  const sent = await send(placed.tx);
  expect(sent.receipt.status).toBe('success');
  expect(await submitted(placed.order.id, sent.hash)).toMatchObject({ status: 'submitted', txHash: sent.hash.toLowerCase() });
  return { q, approved, approvalFeeWei, placed, ...sent };
}

describe('v1 trade API on a Robinhood Chain mainnet fork', () => {
  beforeAll(async () => {
    const pinned = process.env.FORK_BLOCK_NUMBER;
    if (pinned !== undefined && !/^[1-9][0-9]*$/.test(pinned)) throw new Error('FORK_BLOCK_NUMBER must be a positive block number');
    forkBlock = pinned ? BigInt(pinned) : await createPublicClient({ transport: http(PUBLIC_RPC, { retryCount: 1 }) }).getBlockNumber() - 30n;
    // The public RPC answers 429 to bursts: stay near 5 requests per second, through the retrying loopback relay.
    if (!await portFree(RELAY_PORT)) throw new Error(`Port ${RELAY_PORT} is already in use`);
    relay = await startPublicRpcRelay(RELAY_PORT, PUBLIC_RPC);
    await startAnvil(CHAIN_PORT, ['--fork-url', relay.url, '--fork-block-number', forkBlock.toString(), '--block-time', '1',
      '--retries', '12', '--fork-retry-backoff', '5000', '--compute-units-per-second', '80'], forkBlock);
    for (const [who, eth] of [[trader.address, '5'], [other.address, '2'], [whale.address, '10']] as const)
      await rpc.request({ method: 'anvil_setBalance' as never, params: [who, `0x${parseEther(eth).toString(16)}`] as never });
    pons = { open: await findOpenPonsLaunches(patient, forkBlock, 2), graduated: await findGraduatedPons(patient, forkBlock) };
    forkLog('pons coins', pons);
    const started = await startServer(SIM_PORT, true);
    srv = primary = started;
    forkEthUsd = started.indexed.ethUsd;
    const sellGuard = new SellGuard(started.built.ctx.dbh.chain, { getBlockNumber: () => patient.getBlockNumber(), request: input => patient.request(input as never) });
    await warmForkState(patient, started.indexed.pools, started.indexed.ethUsd, (coin, usd) => sellGuard.check(coin, usd));
    await warmPons(patient, [...pons.open, ...(pons.graduated ? [pons.graduated] : [])], trader.address, (coin, usd) => sellGuard.check(coin, usd));
    await warmApi(primary);
  }, 600_000);

  afterAll(async () => {
    primary?.built.ctx.exec.stop();
    await primary?.built.close();
    killAnvils();
    await relay?.close();
    clearTimeout(watchdog);
  });

  it('native ETH → USDG (v1 buy of USDG) on the current verdict alone: quote, order, sign, submit, reconcile the fill', async () => {
    // No Guard v2 release or assessment exists: admission uses the current (Radar) verdict.
    expect(Number((await srv.built.ctx.dbh.chain.sql.query<{ n: string }>('SELECT count(*) AS n FROM guard_verdict_revisions')).rows[0]!.n)).toBe(0);
    const before = await balanceOf(USDG);
    const q = await quote({ coin: USDG, side: 'buy', amountUsd: 20 });
    expect(q, JSON.stringify(q.guard)).toMatchObject({ coin: USDG, side: 'buy', binding: true, account: trader.address.toLowerCase(), approvals: [],
      route: { venue: 'uniswap_v3', executable: true }, fee: { bps: 0, usd: 0, destination: null }, guard: { decision: 'allow' } });
    expect(q).not.toHaveProperty('tx');
    expect(q.valueWei).toBe(q.amountIn);
    expect(BigInt(q.minOut)).toBe(BigInt(q.expectedOut) * 9950n / 10_000n);
    expect(Date.parse(q.expiresAt) - Date.now()).toBeLessThanOrEqual(15_000);

    const placed = await order(q, 'fork-v1-native-buy-0001');
    expect(placed.order).toMatchObject({ quoteId: q.id, status: 'awaiting_signature', coin: USDG, side: 'buy', feeBps: 0 });
    expect(placed.tx).toMatchObject({ chainId: 4663, to: ROUTER, value: q.valueWei });
    // A repeated click returns the same intent and bytes, with 200 instead of 201.
    const repeat = await orderResponse(q, 'fork-v1-native-buy-0001');
    expect(repeat.statusCode).toBe(200);
    expect(repeat.json()).toEqual(placed.raw);

    const { hash, receipt } = await send(placed.tx);
    expect(receipt.status).toBe('success');
    expect(await submitted(placed.order.id, hash)).toMatchObject({ status: 'submitted', txHash: hash.toLowerCase() });
    const done = await settled(placed.order.id);
    expect(done, JSON.stringify(done)).toMatchObject({ status: 'confirmed', txHash: hash.toLowerCase(), filledIn: q.amountIn });
    expect(BigInt(done.filledOut!)).toBeGreaterThanOrEqual(BigInt(q.minOut));
    expect(await balanceOf(USDG) - before).toBe(BigInt(done.filledOut!));
    // Bought amounts get the measured post-fill sell replay at the fill block.
    const [row] = await srv.built.ctx.dbh.db.select().from(tradeOrders).where(eq(tradeOrders.id, placed.order.id));
    expect(row!.postFillEvidence).toMatchObject({ status: 'passed', origin: 'measured', amount: done.filledOut, txHash: hash.toLowerCase() });
    const history = await api(srv.cookie, 'GET', '/trade/orders');
    expect((history.json() as { rows: TradeOrder[] }).rows.map(o => o.id)).toContain(placed.order.id);
  }, 120_000);

  it('a holder sells a Danger coin (USDG → native ETH) as the web app runs it: exact approval, re-quote, order, confirm', async () => {
    // Holders can always exit: the coin is now rated Danger, which refuses buys and never sells.
    const sql = srv.built.ctx.dbh.chain.sql;
    await setVerdict(sql, USDG, 'danger', forkBlock, [{ id: 'honeypot', level: 'danger', confidence: 1, evidence: [] }]);
    try { await sellDangerCoin(); } finally { await setVerdict(sql, USDG, 'clear', forkBlock); }
  }, 120_000);

  async function sellDangerCoin() {
    expect(refusalCodes(await quote({ coin: USDG, side: 'buy', amountUsd: 5 }))).toEqual(['guard_danger']);
    // Before the approval the quote is binding and actionable: the exact approval is its next step.
    const first = await quote({ coin: USDG, side: 'sell', amountUsd: 10 });
    expect(first).toMatchObject({ binding: true, amountIn: '10000000', guard: { decision: 'allow', checks: [] },
      approvals: [{ token: USDG, spender: ROUTER, amount: '10000000', kind: 'erc20' }] });
    // An order before the allowance is on chain gets no bytes.
    const early = await orderResponse(first, 'fork-v1-sell-0000');
    expect(early.statusCode).toBe(422);
    expect(early.json()).toMatchObject({ error: 'approval_required' });

    const [usdgBefore, ethBefore] = await Promise.all([balanceOf(USDG), rpc.getBalance({ address: trader.address })]);
    const { q, approved, placed, receipt } = await tradeLikeTheWebApp({ coin: USDG, side: 'sell', amountUsd: 10 }, 'fork-v1-sell-0001');
    expect(approved).toEqual(first.approvals);
    const done = await settled(placed.order.id);
    expect(done, JSON.stringify(done)).toMatchObject({ status: 'confirmed', filledIn: q.amountIn });
    expect(BigInt(done.filledOut!)).toBeGreaterThanOrEqual(BigInt(q.minOut));
    expect(usdgBefore - await balanceOf(USDG)).toBe(BigInt(q.amountIn));
    // Native ETH received equals the decoded fill (the router unwrapped WETH to the wallet); the approval and swap gas
    // are separate, and the exact approval is fully used.
    const swapGas = receipt.gasUsed * receipt.effectiveGasPrice;
    const ethAfter = await rpc.getBalance({ address: trader.address });
    expect(ethAfter + swapGas - ethBefore).toBeLessThanOrEqual(BigInt(done.filledOut!));
    expect(ethAfter + swapGas - ethBefore).toBeGreaterThan(BigInt(done.filledOut!) - parseEther('0.0001'));
    expect(await allowanceOf(USDG)).toBe(0n);
  }

  it('a wallet rejection is recorded as rejected and nothing is submitted', async () => {
    const nonce = await rpc.getTransactionCount({ address: trader.address });
    const q = await quote({ coin: USDG, side: 'buy', amountUsd: 5 });
    const placed = await order(q, 'fork-v1-reject-0001');
    const rejected = await api(srv.cookie, 'POST', `/trade/order/${placed.order.id}/rejected`, { code: 'user_rejected' });
    expect(rejected.statusCode).toBe(200);
    expect(TradeOrderSchema.parse(rejected.json())).toMatchObject({ status: 'rejected', errorCode: 'user_rejected' });
    // A hash reported afterwards is refused, and reconciliation never touches the rejected intent.
    const late = await api(srv.cookie, 'POST', `/trade/order/${placed.order.id}/submitted`, { txHash: `0x${'ab'.repeat(32)}` });
    expect(late.statusCode).toBe(409);
    await new Promise(resolve => setTimeout(resolve, 3_500));
    expect(await detail(placed.order.id)).not.toHaveProperty('txHash');
    expect((await detail(placed.order.id)).status).toBe('rejected');
    expect(await rpc.getTransactionCount({ address: trader.address })).toBe(nonce);
  }, 90_000);

  it('the order transaction reverting on chain is reconciled as failed, never as a trade', async () => {
    await approveExact(USDG, 5_000_000n);
    const q = await quote({ coin: USDG, side: 'sell', amountUsd: 5 });
    expect(q).toMatchObject({ binding: true, approvals: [] });
    const placed = await order(q, 'fork-v1-revert-0001');
    // The wallet revokes the allowance before signing; the exact order bytes then revert in the router.
    await approveExact(USDG, 0n);
    const before = await balanceOf(USDG);
    const { hash, receipt } = await send(placed.tx, traderWallet, 500_000n);
    expect(receipt.status).toBe('reverted');
    await submitted(placed.order.id, hash);
    const done = await settled(placed.order.id);
    expect(done).toMatchObject({ status: 'failed', errorCode: 'reverted' });
    expect(done).not.toHaveProperty('filledIn');
    expect(done).not.toHaveProperty('filledOut');
    expect(await balanceOf(USDG)).toBe(before);
  }, 90_000);

  it('a hash from a different sender is not accepted as the order fill, even with identical bytes', async () => {
    const q = await quote({ coin: USDG, side: 'buy', amountUsd: 5 });
    const placed = await order(q, 'fork-v1-sender-0001');
    // Another wallet broadcasts the exact order transaction (same router, calldata and value).
    const { hash, receipt } = await send(placed.tx, otherWallet);
    expect(receipt.status).toBe('success');
    await submitted(placed.order.id, hash);
    const done = await settled(placed.order.id);
    expect(done).toMatchObject({ status: 'failed', errorCode: 'tx_mismatch' });
    expect(done).not.toHaveProperty('filledOut');
  }, 90_000);

  it('current-verdict admission: Danger refuses, an unscanned or rescanning coin refuses as retryable, other levels trade', async () => {
    const sql = srv.built.ctx.dbh.chain.sql;
    const refusal = async (code: string, key: string) => {
      const q = await quote({ coin: USDG, side: 'buy', amountUsd: 5 });
      expect(q, code).toMatchObject({ binding: false, guard: { decision: 'refuse' } });
      expect(refusalCodes(q)).toEqual([code]);
      const refused = await orderResponse(q, key);
      expect(refused.statusCode).toBe(422);
      expect(refused.json()).toMatchObject({ error: 'guard_refused' });
      return q;
    };
    try {
      await setVerdict(sql, USDG, 'danger', forkBlock);
      await refusal('guard_danger', 'fork-v1-guard-danger');
      // Never scanned: a retryable "scanning" refusal, not a Guard v2 gap.
      await setVerdict(sql, USDG, null, forkBlock);
      expect((await refusal('scanning', 'fork-v1-guard-unscanned')).guard.checks[0]!.label).toMatch(/still scanning/);
      await setVerdict(sql, USDG, 'pending', forkBlock);
      await refusal('scanning', 'fork-v1-guard-pending');
      // A requested rescan supersedes the stored verdict until it finishes.
      await setVerdict(sql, USDG, 'clear', forkBlock);
      await setScanPending(sql, USDG, true);
      await refusal('scanning', 'fork-v1-guard-rescan');
      await setScanPending(sql, USDG, false);
      // Monitor is admitted with no waiting period.
      await setVerdict(sql, USDG, 'monitor', forkBlock);
      expect(await quote({ coin: USDG, side: 'buy', amountUsd: 5 })).toMatchObject({ binding: true, guard: { decision: 'allow', checks: [] } });
      // A recent stored sell-check reading is used before a probe: a refused sell refuses the buy.
      await setStoredSellCheck(sql, USDG, 'refused', forkBlock);
      const unsellable = await quoteResponse({ coin: USDG, side: 'buy', amountUsd: 5 });
      expect(unsellable.statusCode).toBe(422);
      expect(unsellable.json()).toMatchObject({ error: 'guard_refused', message: expect.stringContaining('could not be sold back') });
    } finally {
      await setStoredSellCheck(sql, USDG, null, forkBlock);
      await setScanPending(sql, USDG, false);
      await setVerdict(sql, USDG, 'clear', forkBlock);
    }
    // The sell check measures exits on native-ETH routes only: a coin quoted against USDG is refused, fail closed.
    const unchecked = await quoteResponse({ coin: WETH, side: 'buy', amountUsd: 5 });
    expect(unchecked.statusCode).toBe(503);
    expect(unchecked.json()).toMatchObject({ error: 'sim_unavailable' });
  }, 120_000);

  describe('Pons bonding curves', () => {
    const ponsSources = (): PonsTradeSources => {
      const chainClient = () => srv.built.ctx.chains.get('robinhood-mainnet'), sql = () => srv.built.ctx.dbh.chain.sql;
      return { curve: indexedPonsCurves(sql()), priceUsd: liveTradeSources(chainClient, sql).priceUsd, networkFeeWei: anvilNetworkFeeWei(chainClient) };
    };
    /** Repeat a Balanced curve buy quote until it binds: every leg of the curve probe has then run once on this fork. */
    async function warmCurve(coin: Address) {
      let last = '';
      await waitFor(async () => {
        const buy = await quoteResponse({ coin, side: 'buy', amountUsd: 5, riskMode: 'balanced' });
        last = `${buy.statusCode} ${buy.statusCode === 200 ? JSON.stringify({ binding: buy.json().binding, guard: buy.json().guard }) : buy.body.slice(0, 300)}`;
        forkLog('pons warm-up quote', coin, last);
        return buy.statusCode === 200 && (buy.json() as TradeQuote).binding ? true : null;
      }, 180_000, 2_000).catch(error => { throw new Error(`Pons warm-up did not converge: ${last}`, { cause: error }); });
    }
    beforeAll(async () => {
      expect(pons.open.length, 'two open native Pons curves in the scanned range').toBe(2);
      for (const p of pons.open) await warmCurve(p.coin);
    }, 400_000);

    it('a curve buy under the Balanced preset, then a sell of what it bought, both confirmed with the actual fills and a 0% fee', async () => {
      const [a] = pons.open as [PonsSeed];
      // Judged by its exact round trip, not depth (a fresh curve's ±2% depth is far below every pool floor): above
      // Careful's 5% ceiling, within Balanced's 10%. The quote shows the exit cost before anything is signed.
      const careful = await quote({ coin: a.coin, side: 'buy', amountUsd: 5, riskMode: 'safe' });
      expect(careful).toMatchObject({ binding: false, route: { venue: 'pons_curve', poolId: a.curve, executable: true }, fee: { bps: 0, usd: 0, destination: null } });
      expect(careful.exitCostPct).toBeGreaterThan(5);
      expect(careful.exitCostPct).toBeLessThan(10);
      expect(careful.guard.checks).toEqual([{ code: 'round_trip_cost', status: 'refuse', label: expect.stringMatching(/Exit cost/), value: careful.exitCostPct }]);

      const coinBefore = await balanceOf(a.coin), ethBefore = await rpc.getBalance({ address: trader.address });
      const buy = await tradeLikeTheWebApp({ coin: a.coin, side: 'buy', amountUsd: 5, riskMode: 'balanced' }, 'fork-v1-pons-buy-0001', a.curve);
      expect(buy.q).toMatchObject({ route: { venue: 'pons_curve', poolId: a.curve, executable: true }, approvals: [], valueWei: buy.q.amountIn,
        fee: { bps: 0, usd: 0, destination: null }, exitCostPct: careful.exitCostPct });
      // The quote shows the curve's own creator tax (it varies per launch, zero included).
      const terms = await readPonsCurve(patient, a.coin, a.curve, BigInt(buy.q.asOfBlock));
      expect(buy.q).toMatchObject({ buyTaxPct: Number(terms.creatorTaxBps) / 100, sellTaxPct: Number(terms.creatorTaxBps) / 100 });
      const bought = await settled(buy.placed.order.id);
      expect(bought, JSON.stringify(bought)).toMatchObject({ status: 'confirmed', feeBps: 0, filledIn: buy.q.amountIn });
      // Nothing else trades this curve on the fork, so the curve math predicted the fill to the token.
      expect(bought.filledOut).toBe(buy.q.expectedOut);
      expect(await balanceOf(a.coin) - coinBefore).toBe(BigInt(bought.filledOut!));
      const swapGas = buy.receipt.gasUsed * buy.receipt.effectiveGasPrice;
      expect(ethBefore - await rpc.getBalance({ address: trader.address }) - swapGas).toBe(BigInt(bought.filledIn!));
      const [row] = await srv.built.ctx.dbh.db.select().from(tradeOrders).where(eq(tradeOrders.id, buy.placed.order.id));
      expect(row!.postFillEvidence).toMatchObject({ status: 'passed', origin: 'measured', amount: bought.filledOut, txHash: buy.hash.toLowerCase() });

      // Sell nearly all of it back at the preset policy (sells have no depth or cost floor), sized at the curve's marginal price.
      const held = await balanceOf(a.coin);
      const s = await readPonsCurve(patient, a.coin, a.curve, await patient.getBlockNumber());
      const amountUsd = Math.floor(Number(held) * Number(s.quoteReserve) / Number(s.tokenReserve) / 1e18 * forkEthUsd * 0.95 * 100) / 100;
      const first = await quote({ coin: a.coin, side: 'sell', amountUsd });
      expect(first).toMatchObject({ binding: true, route: { venue: 'pons_curve', poolId: a.curve }, approvals: [{ token: a.coin, spender: a.curve, amount: first.amountIn, kind: 'erc20' }] });
      expect(BigInt(first.amountIn)).toBeLessThanOrEqual(held);
      expect(BigInt(first.amountIn) * 10n).toBeGreaterThan(held * 8n);
      const early = await orderResponse(first, 'fork-v1-pons-sell-0000');
      expect(early.statusCode).toBe(422);
      expect(early.json()).toMatchObject({ error: 'approval_required' });

      const ethMid = await rpc.getBalance({ address: trader.address });
      const sell = await tradeLikeTheWebApp({ coin: a.coin, side: 'sell', amountUsd }, 'fork-v1-pons-sell-0001', a.curve);
      expect(sell.approved).toEqual(first.approvals);
      const sold = await settled(sell.placed.order.id);
      expect(sold, JSON.stringify(sold)).toMatchObject({ status: 'confirmed', feeBps: 0, filledIn: sell.q.amountIn, filledOut: sell.q.expectedOut });
      expect(held - await balanceOf(a.coin)).toBe(BigInt(sell.q.amountIn));
      // The native ETH the wallet received is exactly the decoded fill (the curve's quoteOut); approval and swap gas are separate.
      const gas = sell.receipt.gasUsed * sell.receipt.effectiveGasPrice + sell.approvalFeeWei;
      expect(await rpc.getBalance({ address: trader.address }) + gas - ethMid).toBe(BigInt(sold.filledOut!));
      expect(await allowanceOf(a.coin, a.curve)).toBe(0n);
    }, 240_000);

    it('a curve quote taken just before graduation is refused at order time; the coin then routes to the pools, never the dead curve', async () => {
      const [, b] = pons.open as [PonsSeed, PonsSeed];
      // Another wallet's buy larger than the curve's remaining tokens: clamped, refunded, and the curve graduates in it.
      const buyout = { to: b.curve, data: ponsTradeCall({ side: 'buy', amountIn: parseEther('8'), minOut: 1n, recipient: whale.address }), value: parseEther('8'), gas: 25_000_000n };
      const stale = await quote({ coin: b.coin, side: 'buy', amountUsd: 5, riskMode: 'balanced' });
      expect(stale, JSON.stringify(stale.guard)).toMatchObject({ binding: true, route: { venue: 'pons_curve', poolId: b.curve, executable: true } });
      const hash = await whaleWallet.sendTransaction(buyout);
      expect((await rpc.waitForTransactionReceipt({ hash, pollingInterval: 250 })).status).toBe('success');
      const refused = await orderResponse(stale, 'fork-v1-pons-graduated-0001');
      expect(await rpc.readContract({ address: b.curve, abi: PONS_CURVE_ABI, functionName: 'graduated' })).toBe(true);
      expect(refused.statusCode, refused.body).toBe(422);
      expect(refused.json()).toMatchObject({ error: 'quote_changed' });
      // The re-quote reads the graduated curve and hands the coin to the pool routes; this coin has no pool on the fork yet.
      await expect(quotePonsTrade(srv.built.ctx.chains.get('robinhood-mainnet'), { coin: b.coin, side: 'sell', amountUsd: 5, slippageBps: 50 }, ponsSources()))
        .rejects.toMatchObject({ reason: 'graduated' });
      const requote = await quoteResponse({ coin: b.coin, side: 'sell', amountUsd: 5 });
      expect(requote.statusCode).toBe(422);
      expect(requote.json()).toMatchObject({ error: 'no_route' });
    }, 180_000);

    it('a coin that graduated before the fork block is bought (Balanced) and sold on its locked v4 pool, never the dead curve', async () => {
      const g = pons.graduated;
      expect(g, 'a native Pons coin graduated to its Pons-hook v4 pool in the scanned range').not.toBeNull();
      const pool = g!.graduated!;
      expect(await rpc.readContract({ address: g!.curve, abi: PONS_CURVE_ABI, functionName: 'graduated' })).toBe(true);
      // The indexer's graduation record hands the coin to the pools without touching the curve; it has no v3 pool, so v4.
      await expect(quotePonsTrade(srv.built.ctx.chains.get('robinhood-mainnet'), { coin: g!.coin, side: 'sell', amountUsd: 5, slippageBps: 50 }, ponsSources()))
        .rejects.toMatchObject({ reason: 'graduated' });

      // Its graduation position is proven locked at the block (the Pons locker owns it), so like the curve the buy is judged by
      // its exact simulated round trip, not the ±2% depth floor (a graduated pool holds a few ETH): above Careful's 5%
      // ceiling, within Balanced's 10%. The quote shows that measured exit cost before anything is signed.
      expect(await ponsGraduationLock(patient, g!.coin, { id: pool.pool, key: pool.key }, pool.pool, await patient.getBlockNumber()))
        .toMatchObject({ locked: true, liquidity: expect.any(BigInt) });
      let careful: TradeQuote | null = null;
      await waitFor(async () => {
        const r = await quoteResponse({ coin: g!.coin, side: 'buy', amountUsd: 5, riskMode: 'safe' });
        forkLog('graduated careful buy quote', r.statusCode, r.body.slice(0, 400));
        careful = r.statusCode === 200 ? TradeQuoteSchema.parse(r.json()) : null;
        return careful && refusalCodes(careful).join() === 'round_trip_cost' ? true : null;
      }, 120_000, 2_000);
      expect(careful).toMatchObject({ binding: false, route: { venue: 'uniswap_v4', poolId: pool.pool.toLowerCase(), executable: true }, fee: { bps: 0, usd: 0, destination: null } });
      expect(careful!.exitCostPct).toBeGreaterThan(5);
      expect(careful!.exitCostPct).toBeLessThan(10);
      expect(careful!.guard.checks).toEqual([{ code: 'round_trip_cost', status: 'refuse', label: expect.stringMatching(/Exit cost/), value: careful!.exitCostPct }]);

      const coinBefore = await balanceOf(g!.coin), ethBefore = await rpc.getBalance({ address: trader.address });
      const buy = await tradeLikeTheWebApp({ coin: g!.coin, side: 'buy', amountUsd: 5, riskMode: 'balanced' }, 'fork-v1-v4-buy-0001', V4_ROUTER);
      expect(buy.q).toMatchObject({ route: { venue: 'uniswap_v4', poolId: pool.pool.toLowerCase(), executable: true }, approvals: [], valueWei: buy.q.amountIn,
        fee: { bps: 0, usd: 0, destination: null } });
      expect(buy.q.exitCostPct).toBeCloseTo(careful!.exitCostPct, 1);
      const bought = await settled(buy.placed.order.id);
      expect(bought, JSON.stringify(bought)).toMatchObject({ status: 'confirmed', feeBps: 0, filledIn: buy.q.amountIn });
      expect(BigInt(bought.filledOut!)).toBeGreaterThanOrEqual(BigInt(buy.q.minOut));
      // Exact fills: the coin the wallet received and the ETH it paid are the decoded fill.
      expect(await balanceOf(g!.coin) - coinBefore).toBe(BigInt(bought.filledOut!));
      expect(ethBefore - await rpc.getBalance({ address: trader.address }) - buy.receipt.gasUsed * buy.receipt.effectiveGasPrice).toBe(BigInt(bought.filledIn!));
      const [row] = await srv.built.ctx.dbh.db.select().from(tradeOrders).where(eq(tradeOrders.id, buy.placed.order.id));
      expect(row!.postFillEvidence).toMatchObject({ status: 'passed', origin: 'measured', amount: bought.filledOut, txHash: buy.hash.toLowerCase() });

      // Sell nearly all of what it bought back on the v4 pool (sells have no depth or cost floor): exact Permit2 approvals,
      // re-quote, order, confirm.
      const held = await balanceOf(g!.coin);
      expect(held).toBeGreaterThanOrEqual(BigInt(bought.filledOut!));
      const s = await readV4Pool(patient, pool.pool, await patient.getBlockNumber());
      const amountUsd = Math.floor(Number(held) * 2 ** 192 / Number(s.sqrtPriceX96) ** 2 / 1e18 * forkEthUsd * 0.85 * 100) / 100;
      const first = await quote({ coin: g!.coin, side: 'sell', amountUsd });
      expect(first).toMatchObject({ binding: true, route: { venue: 'uniswap_v4', poolId: pool.pool.toLowerCase() }, approvals: [
        { token: g!.coin, spender: PERMIT2, amount: first.amountIn, kind: 'erc20' },
        { token: g!.coin, spender: V4_ROUTER, amount: first.amountIn, kind: 'permit2', expiration: expect.any(Number) }] });
      expect(BigInt(first.amountIn)).toBeLessThanOrEqual(held);
      const early = await orderResponse(first, 'fork-v1-v4-sell-0000');
      expect(early.statusCode).toBe(422);
      expect(early.json()).toMatchObject({ error: 'approval_required' });

      const ethMid = await rpc.getBalance({ address: trader.address });
      const sell = await tradeLikeTheWebApp({ coin: g!.coin, side: 'sell', amountUsd }, 'fork-v1-v4-sell-0001', V4_ROUTER);
      expect(sell.approved.map(a => a.kind)).toEqual(['erc20', 'permit2']);
      const sold = await settled(sell.placed.order.id);
      expect(sold, JSON.stringify(sold)).toMatchObject({ status: 'confirmed', feeBps: 0, filledIn: sell.q.amountIn });
      expect(BigInt(sold.filledOut!)).toBeGreaterThanOrEqual(BigInt(sell.q.minOut));
      expect(held - await balanceOf(g!.coin)).toBe(BigInt(sell.q.amountIn));
      // The native ETH the wallet received is exactly the decoded fill (the router's WETH unwrap); approval and swap gas are separate.
      const gas = sell.receipt.gasUsed * sell.receipt.effectiveGasPrice + sell.approvalFeeWei;
      expect(await rpc.getBalance({ address: trader.address }) + gas - ethMid).toBe(BigInt(sold.filledOut!));
      const [permit2Left] = await rpc.readContract({ address: PERMIT2, abi: PERMIT2_ABI, functionName: 'allowance', args: [trader.address, g!.coin, V4_ROUTER] });
      expect(permit2Left).toBe(0n);
    }, 240_000);
  });

  it('admission: the runtime switch and the published cap refuse at quote and order time', async () => {
    const q = await quote({ coin: USDG, side: 'buy', amountUsd: 5 });
    expect(q.binding).toBe(true);
    await tradingLive(srv.built, false);
    try {
      const paused = await quote({ coin: USDG, side: 'buy', amountUsd: 5 });
      expect(paused.binding).toBe(false);
      expect(refusalCodes(paused)).toContain('trading_paused');
      const refused = await orderResponse(q, 'fork-v1-paused-0001');
      expect(refused.statusCode).toBe(422);
      expect(refused.json()).toMatchObject({ error: 'trading_paused' });
    } finally { await tradingLive(srv.built, true); }
    const over = await quote({ coin: USDG, side: 'buy', amountUsd: 300 });
    expect(over.binding).toBe(false);
    expect(refusalCodes(over)).toContain('trade_cap_exceeded');
  }, 120_000);

  // The quote-time sell check has no native-ETH route for WETH (above), so a buy paid in USDG runs on a second server with
  // SELL_CHECK_ENABLED=false and its own simulation host, admitted on a stored sellable reading (stored readings are
  // what the API uses when it does not probe). The per-order round trip below still measures the exit.
  describe('a buy paid in a token, without the sell check', () => {
    let secondary: Server;
    beforeAll(async () => {
      primary.built.ctx.exec.stop();
      secondary = await startServer(SIM_B_PORT, false);
      srv = secondary;
      await setStoredSellCheck(secondary.built.ctx.dbh.chain.sql, USDG, 'sellable', forkBlock);
      await warmApi(secondary);
    }, 240_000);
    afterAll(async () => {
      srv = primary;
      secondary?.built.ctx.exec.stop();
      await secondary?.built.close();
    });

    it('WETH bought with USDG as the web app runs it: exact USDG approval, re-quote, order, confirm', async () => {
      await setStoredSellCheck(srv.built.ctx.dbh.chain.sql, WETH, 'sellable', forkBlock);
      const first = await quote({ coin: WETH, side: 'buy', amountUsd: 3 });
      expect(first).toMatchObject({ binding: true, valueWei: '0', guard: { decision: 'allow', checks: [] },
        approvals: [{ token: USDG, spender: ROUTER, amount: '3000000', kind: 'erc20' }] });
      const early = await orderResponse(first, 'fork-v1-token-buy-0000');
      expect(early.statusCode).toBe(422);
      expect(early.json()).toMatchObject({ error: 'approval_required' });

      const [usdgBefore, wethBefore] = await Promise.all([balanceOf(USDG), balanceOf(WETH)]);
      const { q, approved, placed, hash } = await tradeLikeTheWebApp({ coin: WETH, side: 'buy', amountUsd: 3 }, 'fork-v1-token-buy-0001');
      expect(approved).toEqual(first.approvals);
      const done = await settled(placed.order.id);
      expect(done, JSON.stringify(done)).toMatchObject({ status: 'confirmed', filledIn: q.amountIn });
      expect(BigInt(done.filledOut!)).toBeGreaterThanOrEqual(BigInt(q.minOut));
      expect(usdgBefore - await balanceOf(USDG)).toBe(BigInt(q.amountIn));
      expect(await balanceOf(WETH) - wethBefore).toBe(BigInt(done.filledOut!));
      expect(await allowanceOf(USDG)).toBe(0n);
      const [row] = await srv.built.ctx.dbh.db.select().from(tradeOrders).where(eq(tradeOrders.id, placed.order.id));
      expect(row!.postFillEvidence).toMatchObject({ status: 'passed', origin: 'measured', amount: done.filledOut, txHash: hash.toLowerCase() });
    }, 120_000);
  });
});
