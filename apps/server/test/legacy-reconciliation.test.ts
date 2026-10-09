import { RpcGuardError } from '@eko/chain';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Quote } from '@eko/shared';
import { openDb, runMigrations } from '../src/db/client.js';
import { accounts, fills, orders, positions } from '../src/db/schema.js';
import { ExecutionService } from '../src/exec/service.js';
import type { ExecutionAdapter } from '../src/exec/types.js';

const wallet = `0x${'11'.repeat(20)}`, router = `0x${'22'.repeat(20)}`;
let sequence = 0, hash: string;
let now = Date.parse('2026-10-03T12:00:00Z');
let dbh: Awaited<ReturnType<typeof openDb>>, accountId: string, service: ExecutionService;
const receipt = vi.fn(), transaction = vi.fn(), parseSwap = vi.fn(), onOrder = vi.fn(), onPortfolio = vi.fn();
beforeAll(async () => { dbh = await openDb({ pgliteDir: ':memory:' }); await runMigrations(dbh); });
afterAll(async () => { await dbh?.close(); });
beforeEach(async () => {
  vi.clearAllMocks();now=Date.parse('2026-10-03T12:00:00Z');
  hash = `0x${(++sequence).toString(16).padStart(64, '0')}`;
  const [account] = await dbh.db.insert(accounts).values({ kind: 'wallet' }).returning(); accountId = account!.id;
  receipt.mockResolvedValue({ status: 'success', logs: [], gasUsed: 20_000n, effectiveGasPrice: 1_000_000_000n });
  transaction.mockResolvedValue({ from: wallet, to: router, input: '0xabcd', value: 0n });
  parseSwap.mockReturnValue({ baseQty: 1, quoteQty: 2000, price: 2000 });
  const adapter = { receipt, transaction, parseSwap } as unknown as ExecutionAdapter;
  service = new ExecutionService(dbh.db, {} as never, {} as never, {} as never,
    { live: adapter, testnet: adapter }, { liveEnabled: false, paperFeeBps: 0 }, { onOrder, onPortfolio }, () => now);
});
async function seed(side: 'buy' | 'sell' = 'buy', status = 'submitted', submittedAt = new Date(now)) {
  const quote = { tx: { swap: { to: router, data: '0xabcd', value: '0' } } } as unknown as Quote;
  const [row] = await dbh.db.insert(orders).values({ accountId, mode: 'live', market: 'ETH-USD', side, network: 'robinhood-mainnet',
    venue: 'uniswap-v3', walletAddress: wallet, assetIn: side === 'buy' ? 'USDG' : 'ETH', assetOut: side === 'buy' ? 'ETH' : 'USDG',
    amountIn: side === 'buy' ? 2000 : 1, expectedOut: side === 'buy' ? 1 : 2000, minOut: 0, quotePrice: 2000,
    slippageBps: 50, quote, status, idempotencyKey: 'fixture-reconciliation', txHash: hash, submittedAt, createdAt: new Date(now - 240_000) }).returning();
  return row!.id;
}
async function order(id: string) { return (await dbh.db.select().from(orders).where(eq(orders.id, id)))[0]!; }

describe('retained submitted-order reconciliation', () => {
  it('records receipt amounts/gas and updates a position once, even with concurrent passes', async () => {
    const id = await seed();
    await Promise.all([service.reconcile(), service.reconcile()]); await service.reconcile();
    expect(await order(id)).toMatchObject({ status: 'confirmed', filledIn: 2000, filledOut: 1, fillPrice: 2000, feePaid: .00002, feeAsset: 'ETH', errorCode: null, gasUsed: '20000' });
    expect((await dbh.db.select().from(fills).where(eq(fills.orderId, id)))).toHaveLength(1);
    expect((await dbh.db.select().from(positions).where(eq(positions.accountId, accountId)))[0]).toMatchObject({ quantity: 1, costBasis: 2000, avgCost: 2000 });
    expect(onOrder).toHaveBeenCalledOnce(); expect(onPortfolio).toHaveBeenCalledExactlyOnceWith(accountId, 'live');
    expect(transaction).toHaveBeenCalledOnce();
  });
  it('marks missing swap amounts as estimated and accounts sell proceeds without negative inventory', async () => {
    parseSwap.mockReturnValue(null); const id = await seed('sell');
    await service.reconcile();
    expect(await order(id)).toMatchObject({ status: 'confirmed', filledIn: 1, filledOut: 2000, errorCode: 'fill_estimated' });
    expect((await dbh.db.select().from(positions).where(eq(positions.accountId, accountId)))[0]).toMatchObject({ quantity: 0, costBasis: 0 });
    expect((await dbh.db.select().from(fills).where(eq(fills.orderId, id)))[0]).toMatchObject({ side: 'sell', baseQty: 1, quoteQty: 2000 });
  });
  it.each(['sender', 'router', 'value', 'missing transaction', 'revert'])('refuses %s without recording a fill', async failure => {
    const id = await seed();
    if (failure === 'sender') transaction.mockResolvedValue({ from: router, to: router, input: '0xabcd', value: 0n });
    if (failure === 'router') transaction.mockResolvedValue({ from: wallet, to: wallet, input: '0xabcd', value: 0n });
    if (failure === 'value') transaction.mockResolvedValue({ from: wallet, to: router, input: '0xabcd', value: 1n });
    if (failure === 'missing transaction') transaction.mockResolvedValue(null);
    if (failure === 'revert') receipt.mockResolvedValue({ status: 'reverted' });
    await service.reconcile();
    expect(await order(id)).toMatchObject({ status: 'failed', errorCode: failure === 'revert' ? 'reverted' : 'tx_mismatch' });
    expect(await dbh.db.select().from(fills).where(eq(fills.orderId, id))).toEqual([]);
    expect(await dbh.db.select().from(positions).where(eq(positions.accountId, accountId))).toEqual([]);
    expect(parseSwap).not.toHaveBeenCalled(); expect(onPortfolio).not.toHaveBeenCalled();
  });
  it('waits for recent missing receipts, then fails after thirty minutes', async () => {
    receipt.mockResolvedValue(null); const id = await seed();
    await service.reconcile(); expect((await order(id)).status).toBe('submitted');
    await dbh.db.update(orders).set({ submittedAt: new Date(now - 1_800_001) }).where(eq(orders.id, id));
    await service.reconcile(); expect(await order(id)).toMatchObject({ status: 'failed', errorCode: 'not_found' });
    expect(transaction).not.toHaveBeenCalled(); expect(onOrder).toHaveBeenCalledOnce();
  });
  it('parks submitted orders until the provider retry time and resumes without losing durable work',async()=>{
    const id=await seed(),retryAt=now+60_000;
    receipt.mockRejectedValueOnce(new RpcGuardError('provider_balance_exceeded','provider_balance_exceeded',true,retryAt));
    await service.reconcile();
    for(let i=0;i<10;i++)await service.reconcile();
    expect(receipt).toHaveBeenCalledTimes(1);expect((await order(id)).status).toBe('submitted');
    now=retryAt;await service.reconcile();expect((await order(id)).status).toBe('confirmed');
  });
  it('expires unsigned orders without querying a receipt', async () => {
    const id = await seed('buy', 'awaiting_signature'); await service.reconcile();
    expect(await order(id)).toMatchObject({ status: 'expired', errorCode: 'not_signed' });
    expect(receipt).not.toHaveBeenCalled(); expect(onOrder).toHaveBeenCalledOnce();
    expect(service.modeNetwork('testnet')).toBe('robinhood-testnet');
  });
});
