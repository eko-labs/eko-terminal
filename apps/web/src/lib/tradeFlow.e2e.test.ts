import { describe, expect, it, vi } from 'vitest';
import type { PublicConfig, TradeOrder, TradeQuote, UnsignedTx } from '@eko/shared';
import { createTradeQuote, createPublicConfig } from '../mocks/fixtures';
import { GuardedTradeFlow, TradeFlowError, materiallyChanged, type GuardedEnv } from './tradeFlow';
import { createGuardedTradeClient } from './guardedTradeClient';
import { createApi } from './api';
import type { TradeHandoff } from '../components/trade/TradeContext';

// Offline end-to-end transport/flow/wallet spies. No provider, RPC, keys, funds or ports.
const account = '0x00000000000000000000000000000000000000aa', router = '0x00000000000000000000000000000000000000bb';
const hash = `0x${'ab'.repeat(32)}`;
function setup() {
  let now = 1000000;
  const storage = new Map<string, string>(), calls: { path: string; body: any }[] = [];
  let quote: TradeQuote = { ...createTradeQuote(), id: 'quote-displayed', binding: true, account, amountUsd: 100, amountIn: '900719925474099312345', valueWei: '0',
    approvals: [], fee: { bps: 0, usd: 0, destination: null }, route: { venue: 'uniswap_v3', executable: true }, guard: { decision: 'allow', checks: [] }, expiresAt: new Date(now + 15000).toISOString() };
  let order: TradeOrder | null = null, orderCount = 0, dropped = '', quoteNumber = 0;
  const bodies = new Map<string, { order: TradeOrder; body: string }>();
  let tx: UnsignedTx = { chainId: 4663, to: router, data: '0xabcd', value: '0' };
  const state: ReturnType<GuardedEnv['current']> = { wallet: { address: account, chainId: 4663 }, accountId: 'sample-account', verifiedWallet: account,
    config: { ...createPublicConfig(), trading: { liveEnabled: true, maxTradeUsd: 250, routers: [router], spenders: [router] } } };
  const client = createGuardedTradeClient(createApi('/v1', async (url, init) => {
    const path = url.replace('/v1', ''), body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ path, body });
    let result: unknown;
    if (path === '/trade/quote') result = { ...quote, id: `quote-${++quoteNumber}` };
    else if (path === '/trade/order') {
      const existing = bodies.get(body.idempotencyKey);
      if (existing && existing.body !== JSON.stringify(body)) return new Response(JSON.stringify({ error: 'conflict', message: 'Conflicting order' }), { status: 409 });
      if (!existing) {
        order = { id: `order-${++orderCount}`, quoteId: body.quoteId, coin: quote.coin, side: quote.side, feeBps: quote.fee.bps, status: 'awaiting_signature', createdAt: new Date(now).toISOString() };
        bodies.set(body.idempotencyKey, { order, body: JSON.stringify(body) });
      } else order = existing.order;
      result = { order, tx };
    // The server's v1 contract (apps/server/src/http/v1/trade.ts): callbacks and detail return the TradeOrder itself.
    } else if (path.endsWith('/submitted')) { order = { ...order!, status: 'submitted', txHash: body.txHash }; result = order; }
    else if (path.endsWith('/rejected')) { order = { ...order!, status: 'rejected', errorCode: body.code }; result = order; }
    else if (init.method === 'GET' && path === `/trade/orders/${order?.id}`) result = order;
    else return new Response(JSON.stringify({ error: 'not_found', message: 'Unknown fixture route' }), { status: 404 });
    if (dropped === path) { dropped = ''; throw new Error('Fixture connection lost after server persistence'); }
    return new Response(JSON.stringify(result));
  }).parse);
  const env: GuardedEnv = {
    current: () => state, client, storage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => { storage.set(k, v); }, removeItem: k => { storage.delete(k); } }, now: () => now,
    approve: vi.fn(async (_step, _account, check) => { check(); return hash; }), send: vi.fn(async (_tx, _account, check) => { check(); return hash; }),
    onPhase: vi.fn(), onOrder: vi.fn(), mismatch: vi.fn(),
  };
  const handoff = (): TradeHandoff => ({ quote, input: { coin: quote.coin, side: quote.side, amountUsd: quote.amountUsd, slippageBps: 50, account }, acknowledged: [], requestedAt: now });
  return { env, calls, storage, state, handoff, flow: new GuardedTradeFlow(env), setQuote: (q: Partial<TradeQuote>) => { quote = { ...quote, ...q }; }, setTx: (q: Partial<UnsignedTx>) => { tx = { ...tx, ...q }; },
    drop: (path: string) => { dropped = path; }, count: () => orderCount, advance: (ms: number) => { now += ms; }, settle: (status: TradeOrder['status']) => { order = { ...order!, status, filledIn: '91', filledOut: '82' }; } };
}
async function refusal(promise: Promise<unknown>, code?: string) {
  const error = await promise.catch(e => e);
  expect(error).toBeInstanceOf(TradeFlowError);
  if (code) expect((error as TradeFlowError).code).toBe(code);
  return error as TradeFlowError;
}
describe('guarded v1 flow: offline wallet-spy end-to-end', () => {
  it.each(['hard', 'paused', 'not_allowlisted', 'quote_only', 'indicative', 'fee_destination', 'cap', 'expired', 'wrong_account', 'wrong_chain'])( '%s never requests the wallet or creates an order', async scenario => {
    const f = setup();
    if (scenario === 'hard') f.setQuote({ guard: { decision: 'refuse', checks: [] } });
    if (scenario === 'paused') f.state.config!.trading.liveEnabled = false;
    if (scenario === 'not_allowlisted') f.setQuote({ guard: { decision: 'refuse', checks: [{ code: 'not_allowlisted', status: 'refuse', label: 'Admission' }] } });
    if (scenario === 'quote_only') f.setQuote({ route: { executable: false, venue: 'uniswap_v4' } });
    if (scenario === 'indicative') f.setQuote({ binding: false });
    if (scenario === 'fee_destination') f.setQuote({ fee: { bps: 50, usd: .5, destination: 'burn_engine' } });
    if (scenario === 'cap') f.state.config!.trading.maxTradeUsd = 25;
    if (scenario === 'expired') f.advance(15000);
    if (scenario === 'wrong_account') f.state.verifiedWallet = router;
    if (scenario === 'wrong_chain') f.state.wallet!.chainId = 1;
    await refusal(f.flow.execute(f.handoff()));
    expect(f.env.approve).not.toHaveBeenCalled(); expect(f.env.send).not.toHaveBeenCalled(); expect(f.count()).toBe(0);
  });
  it('revalidates current admission on bound refresh before any approval', async () => {
    const f = setup(), displayed = f.handoff();
    f.setQuote({ guard: { decision: 'refuse', checks: [{ code: 'not_allowlisted', label: 'Admission', status: 'refuse' }] } });
    await refusal(f.flow.execute(displayed)); expect(f.env.send).not.toHaveBeenCalled(); expect(f.count()).toBe(0);
  });
  it('warnings require fresh per-quote acknowledgement and then execute exactly that quote', async () => {
    const f = setup(); f.setQuote({ guard: { decision: 'warn', checks: [{ code: 'tax', label: 'Tax', status: 'warn' }] } });
    const first = await refusal(f.flow.execute(f.handoff()), 'needs_ack'); expect(f.calls).toHaveLength(0);
    const next = await refusal(f.flow.execute({ ...f.handoff(), acknowledged: ['tax'] }), 'needs_ack');
    expect(next.quote!.id).not.toBe(first.quote!.id); expect(f.env.send).not.toHaveBeenCalled();
    const order = await f.flow.execute({ ...f.handoff(), quote: next.quote!, acknowledged: ['tax'], requestedAt: next.requestedAt });
    expect(order.status).toBe('submitted'); expect(f.calls.find(c => c.path === '/trade/order')!.body).toMatchObject({ quoteId: next.quote!.id, acknowledged: ['tax'] });
  });
  it('exact approval confirms, refreshes, signs once and reconciles actual fill', async () => {
    const f = setup(); f.setQuote({ approvals: [{ token: account, spender: router, amount: f.handoff().quote.amountIn, kind: 'erc20' }] });
    f.env.approve = vi.fn(async (step, address, check) => { check(); expect(step.amount).toBe('900719925474099312345'); expect(address).toBe(account); f.setQuote({ approvals: [] }); return hash; });
    const order = await f.flow.execute(f.handoff());
    expect(order.status).toBe('submitted'); expect(f.env.approve).toHaveBeenCalledOnce(); expect(f.env.send).toHaveBeenCalledOnce();
    expect(f.calls.map(c => c.path)).toEqual(['/trade/quote', '/trade/quote', '/trade/order', '/trade/order/order-1/submitted']);
    f.settle('confirmed'); expect(await f.flow.recover()).toMatchObject({ status: 'confirmed', filledIn: '91', filledOut: '82' });
    expect(f.env.onOrder).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'confirmed', filledOut: '82' }));
  });
  it('an order refused for a missing allowance after the re-quote sends no swap and names the approval', async () => {
    const f = setup(); f.setQuote({ approvals: [{ token: account, spender: router, amount: f.handoff().quote.amountIn, kind: 'erc20' }] });
    f.env.approve = vi.fn(async (_step, _address, check) => { check(); f.setQuote({ approvals: [] }); return hash; });
    f.env.client.order = async () => { throw Object.assign(new Error('Approve first'), { code: 'approval_required' }); };
    const error = await refusal(f.flow.execute(f.handoff()), 'approval_required');
    expect(error.sent).toBe('approval'); expect(f.env.approve).toHaveBeenCalledOnce(); expect(f.env.send).not.toHaveBeenCalled();
  });
  it.each(['spender', 'amount', 'unlimited', 'permit2', 'token', 'expiration'] )('invalid %s approval makes zero wallet requests', async kind => {
    const f = setup(); const step: TradeQuote['approvals'][number] = { token: account, spender: router, amount: f.handoff().quote.amountIn, kind: 'erc20' };
    if (kind === 'spender') step.spender = account;
    if (kind === 'amount') step.amount = '1';
    if (kind === 'unlimited') step.amount = ((1n << 256n) - 1n).toString();
    if (kind === 'permit2') step.kind = 'permit2';
    if (kind === 'token') step.token = '0xinvalid';
    if (kind === 'expiration') step.expiration = 999999999;
    f.setQuote({ approvals: [step] }); await refusal(f.flow.execute(f.handoff())); expect(f.env.approve).not.toHaveBeenCalled(); expect(f.env.send).not.toHaveBeenCalled();
  });
  it.each(['router', 'chain', 'value', 'data'])('invalid %s swap makes zero swap requests', async kind => {
    const f = setup();
    if (kind === 'router') f.setTx({ to: account });
    if (kind === 'chain') f.setTx({ chainId: 1 as 4663 });
    if (kind === 'value') f.setTx({ value: '1' });
    if (kind === 'data') f.setTx({ data: '0xabc' });
    await refusal(f.flow.execute(f.handoff())); expect(f.env.send).not.toHaveBeenCalled();
  });
  it('a Pons-curve sell approves and trades the quote’s own curve, and only that curve', async () => {
    const curve = '0x00000000000000000000000000000000000000c1';
    const f = setup(), amount = f.handoff().quote.amountIn, coin = f.handoff().quote.coin;
    f.setQuote({ side: 'sell', route: { venue: 'pons_curve', poolId: curve, executable: true }, approvals: [{ token: coin, spender: curve, amount, kind: 'erc20' }] });
    f.setTx({ to: curve });
    f.env.approve = vi.fn(async (step, _address, check) => { check(); expect(step).toMatchObject({ token: coin, spender: curve }); f.setQuote({ approvals: [] }); return hash; });
    expect((await f.flow.execute(f.handoff())).status).toBe('submitted');
    expect(f.env.approve).toHaveBeenCalledOnce(); expect(f.env.send).toHaveBeenCalledWith(expect.objectContaining({ to: curve }), account, expect.any(Function));
    for (const [step, tx] of [[{ spender: account }, {}], [{ token: account }, {}], [{}, { to: '0x00000000000000000000000000000000000000c2' }]] as const) {
      const g = setup();
      g.setQuote({ side: 'sell', route: { venue: 'pons_curve', poolId: curve, executable: true }, approvals: [{ token: coin, spender: curve, amount, kind: 'erc20', ...step }] });
      g.setTx({ to: curve, ...tx });
      g.env.approve = vi.fn(async (_s, _a, check) => { check(); g.setQuote({ approvals: [] }); return hash; });
      await refusal(g.flow.execute(g.handoff())); expect(g.env.send).not.toHaveBeenCalled();
    }
  });
  it('a Uniswap v4 sell approves the coin to Permit2 and Permit2 to the router (exact, expiring), then trades through the router', async () => {
    const ur = '0x00000000000000000000000000000000000000d1', permit2 = '0x00000000000000000000000000000000000000d2';
    const v4 = (f: ReturnType<typeof setup>, changes: { erc20?: Record<string, unknown>; permit2?: Record<string, unknown> } = {}) => {
      const amount = f.handoff().quote.amountIn, coin = f.handoff().quote.coin, expiration = Math.floor(1000000 / 1000) + 1800;
      f.state.config!.trading = { ...f.state.config!.trading, routers: [router, ur], spenders: [router, permit2], permit2 };
      f.setQuote({ side: 'sell', route: { venue: 'uniswap_v4', poolId: `0x${'ab'.repeat(32)}`, executable: true }, approvals: [
        { token: coin, spender: permit2, amount, kind: 'erc20', ...changes.erc20 }, { token: coin, spender: ur, amount, kind: 'permit2', expiration, ...changes.permit2 }] as TradeQuote['approvals'] });
      f.setTx({ to: ur });
      const steps: TradeQuote['approvals'] = [];
      f.env.approve = vi.fn(async (step, _a, check) => { check(); steps.push(step); if (steps.length === 2) f.setQuote({ approvals: [] }); return hash; });
      return steps;
    };
    const f = setup(), steps = v4(f);
    expect((await f.flow.execute(f.handoff())).status).toBe('submitted');
    expect(steps.map(s => [s.kind, s.spender])).toEqual([['erc20', permit2], ['permit2', ur]]);
    expect(f.env.send).toHaveBeenCalledWith(expect.objectContaining({ to: ur }), account, expect.any(Function));
    for (const changes of [{ permit2: { expiration: Math.floor(1000000 / 1000) + 1801 } }, { permit2: { expiration: undefined } }, { permit2: { spender: permit2 } },
      { permit2: { token: account } }, { permit2: { amount: '1' } }, { erc20: { spender: ur } }]) {
      const g = setup(); v4(g, changes);
      await refusal(g.flow.execute(g.handoff())); expect(g.env.approve).not.toHaveBeenCalled(); expect(g.env.send).not.toHaveBeenCalled();
    }
    const h = setup(); v4(h); delete h.state.config!.trading.permit2;
    await refusal(h.flow.execute(h.handoff()), 'no_route'); expect(h.env.approve).not.toHaveBeenCalled();
  });
  it('a lost creation response retries the exact body/key after reload with one server order', async () => {
    const f = setup(); f.drop('/trade/order'); await refusal(f.flow.execute(f.handoff()));
    const second = new GuardedTradeFlow(f.env); await second.execute(f.handoff());
    const orders = f.calls.filter(c => c.path === '/trade/order'); expect(orders[1].body).toEqual(orders[0].body); expect(f.count()).toBe(1); expect(f.env.send).toHaveBeenCalledOnce();
  });
  it('submission report loss replays only the hash after reload', async () => {
    const f = setup(); f.drop('/trade/order/order-1/submitted'); const error = await refusal(f.flow.execute(f.handoff())); expect(error.sent).toBe('swap');
    const reloaded = new GuardedTradeFlow(f.env); expect((await reloaded.recover())!.status).toBe('submitted'); await reloaded.execute(f.handoff());
    expect(f.count()).toBe(1); expect(f.env.send).toHaveBeenCalledOnce();
  });
  it('rejection callback loss replays without a second order or signature', async () => {
    const f = setup(); f.env.send = vi.fn(async () => { throw Object.assign(new Error('Rejected'), { code: 4001 }); });
    f.drop('/trade/order/order-1/rejected'); const error = await refusal(f.flow.execute(f.handoff())); expect(error.sent).toBe('none');
    expect((await new GuardedTradeFlow(f.env).recover())!.status).toBe('rejected'); expect(f.count()).toBe(1); expect(f.env.send).toHaveBeenCalledOnce();
  });
  it('an unknown wallet error never signs again after reload', async () => {
    const f = setup(); f.env.send = vi.fn(async () => { throw new Error('Wallet connection lost'); });
    const error = await refusal(f.flow.execute(f.handoff())); expect(error.sent).toBe('unknown');
    await refusal(new GuardedTradeFlow(f.env).recover(), 'recovery_pending');
    await refusal(new GuardedTradeFlow(f.env).execute(f.handoff()), 'recovery_pending'); expect(f.count()).toBe(1); expect(f.env.send).toHaveBeenCalledOnce();
  });
  it('chain/account change during order creation blocks the wallet and hides old feedback', async () => {
    const f = setup(); const order = f.env.client.order;
    f.env.client.order = async b => { const result = await order(b); f.state.wallet!.chainId = 1; return result; };
    await refusal(f.flow.execute(f.handoff())); expect(f.env.send).not.toHaveBeenCalled(); expect(f.env.onOrder).not.toHaveBeenCalled();
  });
  it('a change just before the wallet request is rechecked by the signing primitive', async () => {
    const f = setup(); f.env.send = vi.fn(async (_tx, _account, check) => { f.state.config!.trading.routers = []; check(); return hash; });
    await refusal(f.flow.execute(f.handoff()), 'calldata_mismatch'); expect(f.env.mismatch).toHaveBeenCalledOnce();
  });
  it('account changes preserve original-scope hashes and cannot replay them as another account', async () => {
    const f = setup(); f.drop('/trade/order/order-1/submitted'); await refusal(f.flow.execute(f.handoff()));
    f.state.accountId = 'other-account'; expect(await new GuardedTradeFlow(f.env).recover()).toBeNull();
    f.state.accountId = 'sample-account'; expect((await new GuardedTradeFlow(f.env).recover())!.status).toBe('submitted'); expect(f.env.send).toHaveBeenCalledOnce();
  });
  it('materially changed numbers require a second tap showing the refreshed quote', async () => {
    const f = setup(), displayed = f.handoff(); f.setQuote({ exitCostPct: displayed.quote.exitCostPct + 20 });
    const error = await refusal(f.flow.execute(displayed), 'quote_changed'); expect(f.env.send).not.toHaveBeenCalled();
    await f.flow.execute({ ...displayed, quote: error.quote!, requestedAt: error.requestedAt }); expect(f.env.send).toHaveBeenCalledOnce();
  });
  it('concurrent taps use the same lock and make one order', async () => {
    const f = setup(); const promise = f.flow.execute(f.handoff()); await refusal(f.flow.execute(f.handoff()), 'busy'); await promise; expect(f.count()).toBe(1);
  });
  it('15-second request clock and expiry are checked again after approvals', async () => {
    const f = setup(); f.setQuote({ approvals: [{ token: account, spender: router, amount: f.handoff().quote.amountIn, kind: 'erc20' }] });
    f.env.approve = vi.fn(async (_step, _account, check) => { check(); f.advance(15000); f.setQuote({ approvals: [] }); return hash; });
    const error = await refusal(f.flow.execute(f.handoff())); expect(error.sent).toBe('approval'); expect(f.env.send).not.toHaveBeenCalled();
  });
  it('approval-only failure says that approval was sent', async () => {
    const f = setup(); f.setQuote({ approvals: [{ token: account, spender: router, amount: f.handoff().quote.amountIn, kind: 'erc20' }] });
    const error = await refusal(f.flow.execute(f.handoff()), 'approval_pending'); expect(error.sent).toBe('approval'); expect(error.message).toContain('No swap was sent');
  });
  it('storage unavailable prevents wallet requests', async () => {
    const f = setup(); f.env.storage.setItem = () => { throw new Error('Storage blocked'); };
    await refusal(f.flow.execute(f.handoff()), 'recovery_unavailable'); expect(f.env.send).not.toHaveBeenCalled();
  });
  it('orders channel reconciliation ignores unrelated orders and prevents status regression', async () => {
    const f = setup(); const submitted = await f.flow.execute(f.handoff());
    expect(f.flow.reconcile({ ...submitted, id: 'unrelated-order', status: 'confirmed' })).toBe(false);
    expect(f.flow.reconcile({ ...submitted, status: 'awaiting_signature' })).toBe(false);
    expect(f.flow.reconcile({ ...submitted, status: 'confirmed', filledIn: '98', filledOut: '92' })).toBe(true);
    expect(f.env.onOrder).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'confirmed', filledOut: '92' }));
    expect(f.storage.size).toBe(0);
  });
  it('approval rejection after an earlier confirmed approval retains approval-only disclosure', async () => {
    const f = setup(); f.setQuote({ approvals: [{ token: account, spender: router, amount: f.handoff().quote.amountIn, kind: 'erc20' }] });
    f.env.approve = vi.fn(async (_step, _account, check) => { check(); f.setQuote({ approvals: [] }); return hash; });
    f.env.send = vi.fn(async () => { throw Object.assign(new Error('User rejected'), { code: 4001 }); });
    expect((await refusal(f.flow.execute(f.handoff()), 'user_rejected')).sent).toBe('approval');
  });
  it('expiry after a lost creation response releases only the never-signed intent', async () => {
    const f = setup(); f.drop('/trade/order'); await refusal(f.flow.execute(f.handoff())); f.advance(15000);
    await refusal(new GuardedTradeFlow(f.env).execute(f.handoff()), 'quote_expired'); expect(f.storage.size).toBe(0); expect(f.env.send).not.toHaveBeenCalled();
  });
  it('wallet changes while an approval is confirming prevent the swap', async () => {
    const f = setup(); f.setQuote({ approvals: [{ token: account, spender: router, amount: f.handoff().quote.amountIn, kind: 'erc20' }] });
    f.env.approve = vi.fn(async (_step, _account, check) => { check(); f.state.wallet!.address = router; f.setQuote({ approvals: [] }); return hash; });
    expect((await refusal(f.flow.execute(f.handoff()))).sent).toBe('approval'); expect(f.env.send).not.toHaveBeenCalled();
  });
  it('a reconnect response arriving after submission cannot restore the ready signing stage', async () => {
    const f = setup(); let resume!: () => void;
    const delayed = new Promise<void>(resolve => { resume = resolve; });
    let recovery: Promise<TradeOrder | null>;
    const detail = f.env.client.detail;
    f.env.client.detail = async id => { const old = await detail(id); await delayed; return old; };
    f.env.send = vi.fn(async (_tx, _account, check) => { check(); recovery = f.flow.recover(); return hash; });
    await f.flow.execute(f.handoff()); resume(); await recovery!;
    await new GuardedTradeFlow(f.env).execute(f.handoff());
    expect(f.env.send).toHaveBeenCalledOnce(); expect(f.count()).toBe(1);
  });
  it('confirmation arriving before the submission HTTP response cannot be overwritten', async () => {
    const f = setup(); const submitted = f.env.client.submitted;
    f.env.client.submitted = async (id, txHash) => {
      const old = await submitted(id, txHash); f.flow.reconcile({ ...old, status: 'confirmed', filledOut: '92' }); return old;
    };
    await f.flow.execute(f.handoff());
    expect(f.storage.size).toBe(0); expect(f.env.onOrder).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'confirmed' }));
  });
  it('material comparisons include the zero baseline and exact 25 percent boundary', () => {
    const f = setup(), q = f.handoff().quote; q.exitCostPct = 4; q.priceImpactBps = 0;
    expect(materiallyChanged(q, { ...q, exitCostPct: 5 })).toBe(false);
    expect(materiallyChanged(q, { ...q, exitCostPct: 5.01 })).toBe(true);
    expect(materiallyChanged(q, { ...q, priceImpactBps: 1 })).toBe(true);
  });
});
