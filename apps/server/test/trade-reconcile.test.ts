// Offline fixture backends only; no accepted production acquisition or fork evidence.
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, type Hex } from 'viem';
import { TradeOrderSchema, WsEventSchema, type TradeQuote } from '@eko/shared';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { accounts, auditLog, featureFlags, tradeOrders, tradeQuotes, tradeGuardMisses } from '../src/db/schema.js';
import { TradeService, type TradeBackend, type RetainedTrade } from '../src/exec/trades.js';
import { decodeV3Fill, type TradeReceipt, type TradeReconciliationBackend, type PostFillEvidence } from '../src/exec/trade-reconcile.js';
import { FlagService, FLAG_CACHE_MS } from '../src/flags/service.js';
import { IncidentService } from '../src/obs/incidents.js';
import { createDemoToken } from '../src/http/v1/demo.js';
import { Hub } from '../src/ws/hub.js';
import { openDb, runMigrations } from '../src/db/client.js';
import { ERC20_ABI, POOL_ABI, ROUTER_ABI } from '../src/exec/v3-routes.js';
import { binding, actualRequest, wallet } from '../../../packages/policy/test/actual-fixtures.js';

const origin = 'https://app.eko.example';
const secret = 'reconcile-fixture-placeholder'.repeat(2);
const cfg = loadConfig({ NODE_ENV: 'test', PGLITE_DIR: ':memory:', PUBLIC_ORIGIN: origin,
  SESSION_SECRET: secret, DEMO_SECRET: secret, LIVE_TRADING_ENABLED: 'true' });
const blockHash = `0x${'12'.repeat(32)}` as Hex;
const pool = `0x${'34'.repeat(20)}` as Hex;
const units = '10000000000000000000000001';
let built: Awaited<ReturnType<typeof buildApp>>;
let service: TradeService;
let owner: { id: string; wallet: string }, other: typeof owner;
let cookie: string, otherCookie: string;
let at = Date.now();
let current: RetainedTrade;
let tx: NonNullable<Awaited<ReturnType<TradeReconciliationBackend['transaction']>>>;
let receipt: TradeReceipt | null;
let outcome: PostFillEvidence['status'] = 'passed';
const events: { owner: string; order: unknown }[] = [];
const reconciliation: TradeReconciliationBackend = {
  supports: vi.fn(() => true),
  receipt: vi.fn(async () => receipt), transaction: vi.fn(async () => tx),
  decodeFill: vi.fn(async () => ({ filledIn: units, filledOut: (BigInt(units) - 5n).toString() })),
  postFillSell: vi.fn(async (_r, r, fill): Promise<PostFillEvidence> => ({ status: outcome, origin: outcome === 'unavailable' ? 'unavailable' : 'measured',
    chainId: 4663, account: wallet, txHash: r.transactionHash, blockHash: r.blockHash, blockNumber: r.blockNumber.toString(),
    amount: fill.filledOut, checkedAt: new Date(at).toISOString(), evidenceIds: outcome === 'unavailable' ? [] : ['fixture-replay'],
    code: outcome === 'failed' ? 'sell_failed' : outcome === 'unavailable' ? 'sim_unavailable' : 'sell_ok' })),
};
const backend = { reconciliation } as TradeBackend;
const call = (method: 'GET' | 'POST', url: string, payload?: object, session = cookie, from = origin) =>
  built.app.inject({ method, url: `/v1/trade/${url}`, headers: { cookie: session, origin: from }, ...(payload ? { payload } : {}) });
async function seed(side: 'buy' | 'sell' = 'buy') {
  const id = randomUUID(), b = binding(); b.side = side;
  const quote: TradeQuote = { id, coin: b.coin, side, amountUsd: 100, binding: true, account: wallet,
    amountIn: units, valueWei: b.tx.value, networkFeeUsd: 0, route: { venue: 'uniswap_v3', poolId: pool, executable: true },
    expectedOut: '777', minOut: '1', priceImpactBps: 0, buyTaxPct: 0, sellTaxPct: 0, exitCostPct: 0,
    fee: { bps: 0, usd: 0, destination: null }, approvals: [], guard: { decision: 'allow', checks: [] },
    expiresAt: new Date(at + 15_000).toISOString(), asOfBlock: 12 };
  current = { id, accountId: owner.id, wallet, input: { coin: b.coin, side, amountUsd: 100, slippageBps: 100, account: wallet },
    quote, checked: { ...actualRequest(), order: { ...actualRequest().order, execution: b } },
    quotedAt: new Date(at), expiresAt: new Date(at + 15_000), createdAt: new Date(at) };
  await built.ctx.dbh.db.insert(tradeQuotes).values(current);
  const [order] = await built.ctx.dbh.db.insert(tradeOrders).values({ accountId: owner.id, quoteId: id,
    idempotencyKey: id, requestBody: '{}', orderHash: 'fixture-order', coin: b.coin, side, feeBps: 0, createdAt: new Date(at) }).returning();
  const hash = `0x${id.replaceAll('-', '').repeat(2)}` as Hex;
  tx = { hash, chainId: 4663, from: wallet, to: b.tx.to, input: b.tx.data, value: BigInt(b.tx.value), blockHash };
  receipt = { transactionHash: hash, blockNumber: 22n, blockHash, status: 'success', logs: [] };
  return { order: order!, hash };
}
beforeAll(async () => {
  built = await buildApp(cfg, { startBackground: false, tradeBackend: backend });
  const rows = await built.ctx.dbh.db.insert(accounts).values([{ kind: 'wallet', walletAddress: wallet },
    { kind: 'wallet', walletAddress: `0x${'ef'.repeat(20)}` }]).returning();
  owner = { id: rows[0]!.id, wallet }; other = { id: rows[1]!.id, wallet: rows[1]!.walletAddress! };
  cookie = `eko_sid=${encodeURIComponent(built.app.signCookie(await built.ctx.auth.createSession(owner.id)))}`;
  otherCookie = `eko_sid=${encodeURIComponent(built.app.signCookie(await built.ctx.auth.createSession(other.id)))}`;
  service = new TradeService(built.ctx.dbh.db, built.ctx.tradeAccess, built.ctx.sanctions, backend, () => at,
    { incidents: built.ctx.incidents, onOrder: (id, order) => events.push({ owner: id, order }) });
  vi.spyOn(built.ctx.exec, 'tradeSubmitted').mockImplementation((o, id, hash) => service.submitted(o, id, hash));
  vi.spyOn(built.ctx.exec, 'tradeRejected').mockImplementation((o, id, code) => service.rejected(o, id, code));
  vi.spyOn(built.ctx.exec, 'tradeDetail').mockImplementation((o, id) => service.detail(o, id));
  vi.spyOn(built.ctx.exec, 'tradeHistory').mockImplementation((o, limit, cursor) => service.history(o, limit, cursor));
});
afterAll(async () => { await built.close(); });
beforeEach(async () => {
  vi.clearAllMocks(); events.length = 0; outcome = 'passed';
  await built.ctx.dbh.db.delete(tradeGuardMisses);
  await built.ctx.dbh.db.delete(tradeOrders); await built.ctx.dbh.db.delete(tradeQuotes);
  await built.ctx.dbh.db.delete(auditLog);
  await built.ctx.dbh.db.insert(featureFlags).values({ key: 'trading_live', enabled: true, audience: 'public' })
    .onConflictDoUpdate({ target: featureFlags.key, set: { enabled: true } });
});

describe('076 submitted orders and post-fill incidents', () => {
  it('uses strict owner-scoped HTTP detail/history/submission/rejection, origin and demo/auth checks', async () => {
    const { order, hash } = await seed();
    expect((await call('GET', `orders/${order.id}`, undefined, otherCookie)).statusCode).toBe(404);
    expect((await call('GET', 'orders', undefined, otherCookie)).json().rows).toEqual([]);
    expect((await call('POST', `order/${order.id}/submitted`, { txHash: hash }, otherCookie)).statusCode).toBe(404);
    expect((await call('POST', `order/${order.id}/rejected`, { code: 'user_rejected' }, otherCookie)).statusCode).toBe(404);
    expect((await call('GET', 'orders', undefined, '')).statusCode).toBe(401);
    const demo = createDemoToken(['approvals'], secret);
    expect((await built.app.inject({ method: 'GET', url: '/v1/trade/orders', headers: { cookie: `${cookie}; eko_demo=${demo}` } })).statusCode).toBe(403);
    expect((await call('POST', `order/${order.id}/submitted`, { txHash: hash }, cookie, 'https://else.example')).statusCode).toBe(403);
    expect((await call('POST', `order/${order.id}/submitted`, { txHash: '0x12' })).statusCode).toBe(422);
    const submitted = await call('POST', `order/${order.id}/submitted`, { txHash: hash });
    expect(submitted.statusCode).toBe(200); expect(submitted.headers['cache-control']).toBe('private, no-store');
    expect(TradeOrderSchema.parse(submitted.json()).status).toBe('submitted');
    expect((await call('POST', `order/${order.id}/rejected`, { code: 'user_rejected' })).json().status).toBe('submitted');
    expect((await call('GET', `orders/${order.id}`)).json().txHash).toBe(hash);
    const page = (await call('GET', 'orders?limit=1')).json(); expect(page.rows).toHaveLength(1);
    expect(Object.keys(page.rows[0])).not.toContain('accountId');
    const next = await seed();
    expect((await call('POST', `order/${next.order.id}/rejected`, { code: 'user_rejected' })).json().status).toBe('rejected');
    expect((await call('POST', `order/${next.order.id}/submitted`, { txHash: next.hash })).statusCode).toBe(409);
  });
  it('serializes duplicate hashes and rejects conflicts, including another order reusing a hash', async () => {
    const a = await seed();
    await Promise.all([service.submitted(owner, a.order.id, a.hash), service.submitted(owner, a.order.id, a.hash)]);
    expect(events).toHaveLength(1);
    await expect(service.submitted(owner, a.order.id, blockHash)).rejects.toMatchObject({ code: 'conflict' });
    const b = await seed();
    await expect(service.submitted(owner, b.order.id, a.hash)).rejects.toMatchObject({ code: 'conflict' });
    await expect(service.submitted({ ...owner, wallet: other.wallet }, b.order.id, b.hash)).rejects.toMatchObject({ code: 'wallet_mismatch' });
  });
  it.each(['from', 'chain', 'to', 'input', 'value', 'hash', 'block'] as const)('refuses spoofed %s before decoding logs', async field => {
    const a = await seed(); await service.submitted(owner, a.order.id, a.hash);
    if (field === 'from' || field === 'to') tx[field] = other.wallet;
    if (field === 'chain') tx.chainId = 1;
    if (field === 'input') tx.input = '0xabcd';
    if (field === 'value') tx.value += 1n;
    if (field === 'hash') tx.hash = blockHash;
    if (field === 'block') tx.blockHash = null;
    await service.reconcile();
    expect(await service.detail(owner, a.order.id)).toMatchObject({ status: 'failed', errorCode: 'tx_mismatch' });
    expect(reconciliation.decodeFill).not.toHaveBeenCalled();
  });
  it('refuses reverts and missing swap logs, without estimating a fill', async () => {
    const a = await seed(); await service.submitted(owner, a.order.id, a.hash); receipt!.status = 'reverted';
    await service.reconcile(); expect((await service.detail(owner, a.order.id)).errorCode).toBe('reverted');
    const b = await seed(); await service.submitted(owner, b.order.id, b.hash);
    vi.mocked(reconciliation.decodeFill).mockResolvedValueOnce(null);
    await service.reconcile(); expect(await service.detail(owner, b.order.id)).toMatchObject({ status: 'failed', errorCode: 'missing_swap_logs' });
    expect((await service.detail(owner, b.order.id)).filledOut).toBeUndefined();
  });
  it('confirms decoded raw amounts once across concurrent reconciler instances; sells omit buy replay', async () => {
    const a = await seed('sell'); await service.submitted(owner, a.order.id, a.hash);
    const replica = new TradeService(built.ctx.dbh.db, built.ctx.tradeAccess, built.ctx.sanctions, backend, () => at,
      { onOrder: (id, order) => events.push({ owner: id, order }) });
    await Promise.all([service.reconcile(), replica.reconcile()]); await service.reconcile();
    expect(await service.detail(owner, a.order.id)).toMatchObject({ status: 'confirmed', filledIn: units, filledOut: (BigInt(units) - 5n).toString() });
    expect(events.filter(e => (e.order as { status: string }).status === 'confirmed')).toHaveLength(1);
    expect(reconciliation.postFillSell).not.toHaveBeenCalled();
  });
  it('retains a decoded zero-delivery buy and records its observed sell failure', async () => {
    const a = await seed(); await service.submitted(owner, a.order.id, a.hash); outcome = 'failed';
    vi.mocked(reconciliation.decodeFill).mockResolvedValueOnce({ filledIn: units, filledOut: '0' });
    await service.reconcile();
    expect(await service.detail(owner, a.order.id)).toMatchObject({ status: 'confirmed', filledIn: units, filledOut: '0' });
    expect((await built.ctx.dbh.db.select().from(tradeGuardMisses))[0]).toMatchObject({ orderId: a.order.id });
    expect(await built.ctx.tradeAccess.liveEnabled()).toBe(false);
  });
  it('persists unavailable replay and retries, never counting provider outages as guard misses', async () => {
    const a = await seed(); await service.submitted(owner, a.order.id, a.hash); outcome = 'unavailable';
    await service.reconcile();
    expect((await built.ctx.dbh.db.select().from(tradeOrders))[0]!.postFillEvidence?.status).toBe('unavailable');
    expect(await built.ctx.dbh.db.select().from(tradeGuardMisses)).toEqual([]);
    expect(await built.ctx.flags.isOpsOn('trading_live')).toBe(true);
    outcome = 'passed'; await service.reconcile();
    expect((await built.ctx.dbh.db.select().from(tradeOrders))[0]!.postFillEvidence?.status).toBe('passed');
    await service.reconcile(); expect(reconciliation.postFillSell).toHaveBeenCalledTimes(2);
  });
  it('atomically stops live trading and queues each observed miss once despite repeated reconciliation and failed paging', async () => {
    const flags = new FlagService(() => built.ctx.dbh.db.select().from(featureFlags), '', () => at);
    await flags.all(); expect(await flags.isOpsOn('trading_live')).toBe(true);
    const a = await seed(); await service.submitted(owner, a.order.id, a.hash); outcome = 'failed';
    await Promise.all([service.reconcile(), service.reconcile()]); await service.reconcile();
    expect(await flags.isOpsOn('trading_live')).toBe(false); at += FLAG_CACHE_MS;
    expect(await flags.isOpsOn('trading_live')).toBe(false);
    let queue = await built.ctx.dbh.db.select().from(tradeGuardMisses); expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ orderId: a.order.id, status: 'pending', payload: { scoreboardKind: 'honeypots_missed', receiptPublication: 'pending' } });
    expect((await built.ctx.dbh.db.select().from(tradeOrders))[0]!.postFillEvidence).toMatchObject({ status: 'failed', origin: 'measured', amount: (BigInt(units) - 5n).toString() });
    expect((await built.ctx.dbh.db.select().from(auditLog)).filter(r => r.action === 'ops.incident')).toHaveLength(1);
    const b = await seed(); await service.submitted(owner, b.order.id, b.hash); await service.reconcile();
    queue = await built.ctx.dbh.db.select().from(tradeGuardMisses); expect(queue).toHaveLength(2);
    expect(await flags.isOpsOn('trading_live')).toBe(false);
  });
  it('rejects mismatched replay evidence without triggering a guard miss', async () => {
    const a = await seed(); await service.submitted(owner, a.order.id, a.hash);
    vi.mocked(reconciliation.postFillSell).mockResolvedValueOnce({ status: 'failed', origin: 'measured', chainId: 4663,
      account: wallet, txHash: a.hash, blockHash, blockNumber: '22', amount: '1', checkedAt: new Date(at).toISOString(),
      evidenceIds: ['fixture-replay'], code: 'sell_failed' });
    await service.reconcile();
    expect((await built.ctx.dbh.db.select().from(tradeOrders))[0]!.postFillEvidence?.status).toBe('unavailable');
    expect(await built.ctx.dbh.db.select().from(tradeGuardMisses)).toEqual([]);
    expect(await built.ctx.tradeAccess.liveEnabled()).toBe(true);
  });
  it('uses the production ExecutionService loop and preserves the stop when paging fails', async () => {
    const a = await seed(); await service.submitted(owner, a.order.id, a.hash); outcome = 'failed';
    await built.ctx.exec.reconcile();
    expect((await service.detail(owner, a.order.id)).status).toBe('confirmed');
    expect(await built.ctx.tradeAccess.liveEnabled()).toBe(false);
    const b = await seed(); await service.submitted(owner, b.order.id, b.hash);
    const incidents = new IncidentService(built.ctx.dbh.db, { page: async () => { throw new Error('fixture unavailable'); } });
    const failingSink = new TradeService(built.ctx.dbh.db, built.ctx.tradeAccess, built.ctx.sanctions, backend, () => at, { incidents });
    await failingSink.reconcile();
    expect((await built.ctx.dbh.db.select().from(auditLog)).some(r => r.action === 'ops.incident_delivery' &&
      (r.data as { channel: string; outcome: string }).channel === 'page' && (r.data as { outcome: string }).outcome === 'failed')).toBe(true);
    expect(await built.ctx.tradeAccess.liveEnabled()).toBe(false);
  });
  it('leaves unaccepted routes, absent backends and unavailable receipts pending', async () => {
    const a = await seed(); await service.submitted(owner, a.order.id, a.hash);
    vi.mocked(reconciliation.supports).mockReturnValueOnce(false);
    await service.reconcile(); expect(reconciliation.receipt).not.toHaveBeenCalled();
    receipt = null; await service.reconcile();
    expect((await service.detail(owner, a.order.id)).status).toBe('submitted');
    const unavailable = new TradeService(built.ctx.dbh.db, built.ctx.tradeAccess, built.ctx.sanctions);
    await unavailable.reconcile();
    expect((await service.detail(owner, a.order.id)).status).toBe('submitted');
  });
  it('isolates typed orders WS events and per-account sequences, refusing anonymous/public fanout', async () => {
    class Socket extends EventEmitter { readyState = 1; bufferedAmount = 0; sent: unknown[] = []; send(s: string) { this.sent.push(JSON.parse(s)); } }
    const hub = new Hub(), a = new Socket(), b = new Socket(), anon = new Socket();
    hub.addV1(a as never, owner.id); hub.addV1(b as never, other.id); hub.addV1(anon as never);
    for (const s of [a, b, anon]) s.emit('message', JSON.stringify({ op: 'sub', ch: ['orders'] }));
    const order = await service.detail(owner, (await seed()).order.id);
    hub.publish('orders', 'order', order); expect(a.sent.filter((e: any) => e.t === 'ev')).toEqual([]);
    hub.publishOrder(owner.id, order);
    expect(a.sent.filter((e: any) => e.t === 'ev')).toHaveLength(1);
    expect(b.sent.filter((e: any) => e.t === 'ev')).toEqual([]); expect(anon.sent.filter((e: any) => e.t === 'ev')).toEqual([]);
    expect(WsEventSchema.safeParse(a.sent.at(-1)).success).toBe(true);
    expect(a.sent.at(-1)).toMatchObject({ seq: 1, ch: 'orders', kind: 'order' });
    expect(anon.sent.at(-1)).toMatchObject({ t: 'err', code: 'not_found' });
  });
  it('reopens a migrated durable submitted order and reconciles with a new service instance', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eko-076-restart-'));
    let handle = await openDb({ pgliteDir: dir });
    try {
      await runMigrations(handle); const a = await seed();
      await handle.db.insert(accounts).values({ id: owner.id, kind: 'wallet', walletAddress: wallet });
      await handle.db.insert(tradeQuotes).values(current);
      await handle.db.insert(tradeOrders).values(a.order);
      const make = () => new TradeService(handle.db, built.ctx.tradeAccess, built.ctx.sanctions, backend);
      await make().submitted(owner, a.order.id, a.hash); await handle.close();
      handle = await openDb({ pgliteDir: dir }); await runMigrations(handle);
      await make().reconcile(); expect((await make().detail(owner, a.order.id)).status).toBe('confirmed');
    } finally { await handle.close(); await rm(dir, { recursive: true, force: true }); }
  });
});

it('decodes the indexed v3 pool and net recipient transfers; refuses unrelated/missing/wrong-direction logs', async () => {
  await seed(); const coin = current.quote.coin;
  const quoteToken = `0x${'56'.repeat(20)}` as Hex;
  const setCall = (side: 'buy' | 'sell', native = false) => {
    const calls = [encodeFunctionData({ abi: ROUTER_ABI, functionName: 'exactInputSingle', args: [{
      tokenIn: side === 'buy' ? quoteToken : coin, tokenOut: side === 'buy' ? coin : quoteToken,
      fee: 3000, recipient: native ? `0x${'0'.repeat(39)}2` : wallet, amountIn: 100n, amountOutMinimum: 1n, sqrtPriceLimitX96: 0n,
    }] })];
    if (native) calls.push(encodeFunctionData({ abi: ROUTER_ABI, functionName: 'unwrapWETH9', args: [1n, wallet] }));
    current.checked!.order.execution!.tx.data = encodeFunctionData({ abi: ROUTER_ABI, functionName: 'multicall', args: [1000n, calls] });
  };
  setCall('buy');
  const coin0 = true;
  const swap = { address: pool, topics: encodeEventTopics({ abi: POOL_ABI, eventName: 'Swap', args: { sender: wallet, recipient: wallet } }),
    data: encodeAbiParameters([{ type: 'int256' }, { type: 'int256' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }], [-100n, 99n, 1n, 1n, 0]) };
  const transfer = { address: coin, topics: encodeEventTopics({ abi: ERC20_ABI, eventName: 'Transfer', args: { from: pool, to: wallet } }),
    data: encodeAbiParameters([{ type: 'uint256' }], [90n]) };
  const logs = [swap, transfer].map((l, logIndex) => ({ ...l, logIndex, transactionHash: receipt!.transactionHash, blockHash, removed: false })) as TradeReceipt['logs'];
  const r = { ...receipt!, logs };
  const sources = { pools: async () => [{ address: pool, currency0: coin0 ? coin : quoteToken, currency1: coin0 ? quoteToken : coin, fee: 3000 }],
    priceUsd: async () => null, networkFeeWei: async () => null };
  expect(await decodeV3Fill(current, r, sources)).toEqual({ filledIn: '99', filledOut: '90' });
  const zeroDelivered = { ...logs[1]!, data: encodeAbiParameters([{ type: 'uint256' }], [0n]) };
  expect(await decodeV3Fill(current, { ...r, logs: [logs[0]!, zeroDelivered] }, sources)).toEqual({ filledIn: '99', filledOut: '0' });
  expect(await decodeV3Fill(current, { ...r, logs: [logs[1]!] }, sources)).toBeNull();
  expect(await decodeV3Fill(current, { ...r, logs: [logs[0]!] }, sources)).toBeNull();
  expect(await decodeV3Fill(current, { ...r, logs: [...logs, logs[0]!] }, sources)).toBeNull();
  expect(await decodeV3Fill(current, r, { ...sources, pools: async () => [] })).toBeNull();
  current.quote.side = 'sell'; setCall('sell'); expect(await decodeV3Fill(current, r, sources)).toBeNull();
  const soldLogs = [
    { ...logs[0]!, data: encodeAbiParameters([{ type: 'int256' }, { type: 'int256' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }], [100n, -99n, 1n, 1n, 0]) },
    { ...logs[1]!, topics: encodeEventTopics({ abi: ERC20_ABI, eventName: 'Transfer', args: { from: wallet, to: pool } }),
      data: encodeAbiParameters([{ type: 'uint256' }], [105n]) },
    { ...logs[1]!, address: quoteToken, topics: encodeEventTopics({ abi: ERC20_ABI, eventName: 'Transfer', args: { from: pool, to: wallet } }),
      data: encodeAbiParameters([{ type: 'uint256' }], [98n]) },
  ] as TradeReceipt['logs'];
  expect(await decodeV3Fill(current, { ...r, logs: soldLogs }, sources)).toEqual({ filledIn: '105', filledOut: '98' });
  expect(await decodeV3Fill(current, { ...r, logs: soldLogs.slice(0, 2) }, sources)).toBeNull();
  // Native-out uses the router's observed unwrap amount, with the wallet recipient bound in calldata.
  setCall('sell', true);
  const withdrawal = { ...logs[1]!, address: quoteToken,
    topics: encodeEventTopics({ abi: [{ type: 'event', name: 'Withdrawal', inputs: [{ name: 'src', type: 'address', indexed: true }, { name: 'wad', type: 'uint256', indexed: false }] }], eventName: 'Withdrawal', args: { src: wallet } }),
    data: encodeAbiParameters([{ type: 'uint256' }], [99n]) } as TradeReceipt['logs'][number];
  expect(await decodeV3Fill(current, { ...r, logs: [...soldLogs.slice(0, 2), withdrawal] }, sources)).toEqual({ filledIn: '105', filledOut: '99' });
  // Robinhood Chain's WETH has no Withdrawal event: SwapRouter02's unwrap burns the router's WETH instead.
  const burn = (from: Hex, amount: bigint) => ({ ...logs[1]!, address: quoteToken,
    topics: encodeEventTopics({ abi: ERC20_ABI, eventName: 'Transfer', args: { from, to: `0x${'0'.repeat(40)}` } }),
    data: encodeAbiParameters([{ type: 'uint256' }], [amount]) }) as TradeReceipt['logs'][number];
  expect(await decodeV3Fill(current, { ...r, logs: [...soldLogs.slice(0, 2), burn(wallet, 99n)] }, sources)).toEqual({ filledIn: '105', filledOut: '99' });
  // Both events for one unwrap count once; a burn by any other address is not the router's unwrap.
  expect(await decodeV3Fill(current, { ...r, logs: [...soldLogs.slice(0, 2), burn(wallet, 99n), withdrawal] }, sources)).toEqual({ filledIn: '105', filledOut: '99' });
  expect(await decodeV3Fill(current, { ...r, logs: [...soldLogs.slice(0, 2), burn(pool, 99n)] }, sources)).toBeNull();
  // The unwrap can never report more than the pool paid out.
  expect(await decodeV3Fill(current, { ...r, logs: [...soldLogs.slice(0, 2), burn(wallet, 100n)] }, sources)).toBeNull();
});
