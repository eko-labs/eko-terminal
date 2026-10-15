import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, runMigrations } from '../src/db/client.js';
import { eq } from 'drizzle-orm';
import { TradeQuoteSchema, TradeOrderSchema, type TradeQuote, type ActualOrderBinding, type Verdict } from '@eko/shared';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { accounts, tradeQuotes, tradeOrders, tradingAllowlist } from '../src/db/schema.js';
import { v3TradeBackend } from '../src/exec/trade-backend.js';
import { ChainQuoteError } from '../src/exec/v3-routes.js';
import { preparationError, TradeService, type TradeBackend, type RetainedTrade } from '../src/exec/trades.js';
import { currentVerdictGate } from '../src/exec/live-trade.js';
import { TradeAccessService } from '../src/exec/trade-access.js';
import { FlagService } from '../src/flags/service.js';
import { ScreeningError } from '../src/sanctions/service.js';
import { createDemoToken } from '../src/http/v1/demo.js';
import { agent, actualRequest, binding, deps, observationFor, stateFor, wallet } from '../../../packages/policy/test/actual-fixtures.js';
import { NOW, policy, verdict as legacyVerdict } from '../../../packages/policy/test/fixtures.js';
import { cachedGuard, guardFixture } from '../../../packages/policy/test/guard-fixtures.js';

// Offline acquisition fixtures, never live acceptance or fork evidence.
const origin = 'https://app.eko.example';
const secret = 'trade-api-fixture-placeholder'.repeat(2);
const cfg = loadConfig({ NODE_ENV: 'test', PGLITE_DIR: ':memory:', PUBLIC_ORIGIN: origin,
  SESSION_SECRET: secret, DEMO_SECRET: secret, LIVE_TRADING_ENABLED: 'true' });
let built: Awaited<ReturnType<typeof buildApp>>;
let owner: { id: string; wallet: string };
let other: typeof owner;
let cookie: string;
let at = NOW;
let enabled = true;
let denial = '';
let criticalStale = false;
let changed = false;
let high = false;
let fee = false;
let executable = true;
let warnings: TradeQuote['guard']['checks'] = [];
let acquisitionAdvance = 0;
let measuredUsd = 100;
let approvals: TradeQuote['approvals'] = [];
let currentVerdict: Verdict | null = null, scanPending = false;
let allowance: string | null = null;
const screen = { assertWallet: vi.fn(async () => { if (denial) throw new ScreeningError(denial === 'sanctioned' ? 'sanctioned' : 'stale_data'); }) };
const backend: TradeBackend = {
  quote: vi.fn(async (_owner, input, id) => {
    const b = binding({ ...policy, mode: input.riskMode! });
    b.side = input.side; b.tx.value = input.side === 'buy' ? b.amountIn : '0';
    const req = actualRequest({ ...policy, mode: input.riskMode! });
    req.clientOrderRef = id; req.order = { ...req.order, execution: b, side: input.side,
      tx: { to: b.tx.to, data: b.tx.data, value: b.tx.value } };
    const quote: TradeQuote = { id, coin: b.coin, side: input.side, amountUsd: input.amountUsd, binding: true,
      ...(input.account ? { account: input.account } : {}), amountIn: b.amountIn, valueWei: b.tx.value,
      networkFeeUsd: 0.02, route: { venue: 'uniswap_v3', executable }, expectedOut: b.amountIn, minOut: b.minOut,
      priceImpactBps: 10, buyTaxPct: 0, sellTaxPct: 0, exitCostPct: 1,
      fee: fee ? { bps: 50, usd: 0.5, destination: 'burn_wallet' } : { bps: 0, usd: 0, destination: null },
      approvals, guard: { decision: warnings.length ? 'warn' : 'allow', checks: warnings },
      expiresAt: new Date(at + 20_000).toISOString(), asOfBlock: Number(b.cursor.blockNumber) };
    return { quote, checked: input.account ? req : null };
  }),
  capture: vi.fn(async (retained: RetainedTrade) => {
    const b = retained.checked!.order.execution!;
    const state = { ...stateFor(b), observedAtMs: at, criticalCheckedAtMs: criticalStale ? at - 5001 : at };
    if (changed) state.stateFingerprint = `0x${'22'.repeat(32)}`;
    return { request: retained.checked!, agent, policy: { ...policy, mode: retained.input.riskMode! },
      deps: currentVerdict ? { ...deps, verdictFor: () => currentVerdict!, buyVerdictGate: currentVerdictGate(scanPending) }
        : high ? { ...deps, verdictFor: () => cachedGuard(guardFixture('high')) } : deps,
      state, admission: { status: 'allowed' as const }, quoteClocks: { quotedAtMs: retained.quotedAt.getTime(), expiresAtMs: retained.expiresAt.getTime() } };
  }),
  probe: { observe: vi.fn(async (b: ActualOrderBinding, state, now) => {
    at += acquisitionAdvance;
    return { ...observationFor(b), state, refreshedAtMs: now, notionalUsd: measuredUsd, allowanceBefore: allowance ?? b.amountIn };
  }) },
};
let access: TradeAccessService;
const service = () => new TradeService(built.ctx.dbh.db, access, screen, backend, () => at);
const quote = (patch = {}) => service().quote(owner, { coin: binding().coin, account: wallet,
  side: 'buy', amountUsd: 100, slippageBps: 100, riskMode: 'balanced', ...patch });
const order = (id: string, patch = {}) => ({ quoteId: id, idempotencyKey: `ik_${id}`, acknowledged: [] as string[], ...patch });
const call = (path: string, payload: object, session = cookie, from = origin) => built.app.inject({ method: 'POST', url: `/v1/trade/${path}`, headers: { cookie: session, origin: from }, payload });
beforeAll(async () => {
  built = await buildApp(cfg, { startBackground: false, tradeBackend: backend });
  const rows = await built.ctx.dbh.db.insert(accounts).values([{ kind: 'wallet', walletAddress: wallet },
    { kind: 'wallet', walletAddress: `0x${'ef'.repeat(20)}` }]).returning();
  owner = { id: rows[0]!.id, wallet }; other = { id: rows[1]!.id, wallet: rows[1]!.walletAddress! };
  cookie = `eko_sid=${encodeURIComponent(built.app.signCookie(await built.ctx.auth.createSession(owner.id)))}`;
  await built.ctx.dbh.db.insert(tradingAllowlist).values({ wallet, role: 'beta_user', capUsd: 100, addedBy: owner.id });
  vi.spyOn(built.ctx.exec, 'tradeQuote').mockImplementation((o, i) => service().quote(o, i));
  vi.spyOn(built.ctx.exec, 'tradeOrder').mockImplementation((o, i) => service().order(o, i));
  access = new TradeAccessService(cfg, new FlagService(async () => [{ key: 'trading_live', enabled, audience: 'public' }]), async w =>
    (await built.ctx.dbh.db.select().from(tradingAllowlist).where(eq(tradingAllowlist.wallet, w)))[0], () => at);
});
afterAll(async () => { await built.close(); });
beforeEach(() => { at = NOW; enabled = true; denial = ''; criticalStale = changed = high = fee = false; executable = true; warnings = []; acquisitionAdvance = 0; measuredUsd = 100; approvals = []; allowance = null; currentVerdict = null; scanPending = false; });

describe('075 durable guarded trade intents', () => {
  it('uses the supported v3 adapter and trusted acquisition; construction alone stays quote-only', async () => {
    const input = { coin: binding().coin, account: wallet, side: 'buy' as const, amountUsd: 100, slippageBps: 100, riskMode: 'balanced' as const };
    const adapter = { quoteTrade: vi.fn(async () => ({ ...((await backend.quote(owner, input, 'adapter-fixture')).quote), tx: binding().tx })) };
    let accepted = true;
    const integrated = v3TradeBackend(adapter, { pools: async () => [], priceUsd: async () => null, networkFeeWei: async () => null }, {
      capture: backend.capture, probe: backend.probe,
      quote: async (o, i, route, id) => {
        expect(route.tx).toEqual(binding().tx);
        const result = await backend.quote(o, i, id);
        return { checked: result.checked, accepted, guard: result.quote.guard, buyTaxPct: 0, sellTaxPct: 0, exitCostPct: 1 };
      },
    });
    const routed = new TradeService(built.ctx.dbh.db, access, screen, integrated, () => at);
    const q = await routed.quote(owner, input);
    expect(adapter.quoteTrade).toHaveBeenCalledWith(input, expect.any(Object));
    expect(q).not.toHaveProperty('tx');
    expect((await routed.order(owner, order(q.id))).tx).toEqual(binding().tx);
    accepted = false; const pending = await routed.quote(owner, input);
    expect(pending).toMatchObject({ binding: false, route: { executable: false } });
    await expect(routed.order(owner, order(pending.id))).rejects.toMatchObject({ code: 'no_route' });
    adapter.quoteTrade.mockRejectedValueOnce(new ChainQuoteError('no_route', 'provider-details'));
    await expect(routed.quote(owner, input)).rejects.toMatchObject({ code: 'no_route', message: 'Route quote unavailable or refused' });
    adapter.quoteTrade.mockRejectedValueOnce(new Error('provider-details'));
    await expect(routed.quote(owner, input)).rejects.toMatchObject({ code: 'sim_unavailable', message: 'Trade acquisition is unavailable' });
  });
  it('re-runs the sell check on every buy quote and refuses a coin whose sell fails before route acquisition', async () => {
    const result = (status: string) => ({ status, coin: binding().coin, block: 1, route: null, ethUsd: 2000, probes: [], requests: 1, exit100: null, exit1k: null }) as never;
    let next = 'refused';
    const sellGuard = { check: vi.fn(async () => { if (next === 'throw') throw new Error('provider-details'); return result(next); }), refused: vi.fn(async () => {}) };
    const guarded = new TradeService(built.ctx.dbh.db, access, screen, backend, () => at, { sellGuard });
    const input = { coin: binding().coin, account: wallet, side: 'buy' as const, amountUsd: 100, slippageBps: 100, riskMode: 'balanced' as const };
    const acquired = vi.mocked(backend.quote).mock.calls.length;
    await expect(guarded.quote(owner, input)).rejects.toMatchObject({ code: 'guard_refused', message: expect.stringContaining('could not be sold back') });
    expect(sellGuard.check).toHaveBeenCalledWith(input.coin, 100);
    expect(sellGuard.refused).toHaveBeenCalledTimes(1);
    next = 'buy_failed'; await expect(guarded.quote(owner, input)).rejects.toMatchObject({ code: 'guard_refused' });
    for (const failure of ['unavailable', 'unsupported', 'throw']) { next = failure; await expect(guarded.quote(owner, input)).rejects.toMatchObject({ code: 'sim_unavailable' }); }
    // Only failed sells are counted, and no refused or unchecked quote reached acquisition or was retained.
    expect(sellGuard.refused).toHaveBeenCalledTimes(1);
    expect(vi.mocked(backend.quote).mock.calls.length).toBe(acquired);
    next = 'sellable'; expect(await guarded.quote(owner, input)).toMatchObject({ binding: true });
    // Sells reduce risk and never run the sell check.
    const checks = sellGuard.check.mock.calls.length;
    await guarded.quote(owner, { ...input, side: 'sell' });
    expect(sellGuard.check.mock.calls.length).toBe(checks);
  });
  it('retains owner, exact inputs and original 15s clocks for another service/replica, with zero fees', async () => {
    const q = await quote(); expect(TradeQuoteSchema.parse(q)).toMatchObject({ binding: true, fee: { bps: 0, usd: 0, destination: null } });
    expect(Date.parse(q.expiresAt)).toBe(NOW + 15000);
    const [stored] = await built.ctx.dbh.db.select().from(tradeQuotes).where(eq(tradeQuotes.id, q.id));
    expect(stored).toMatchObject({ accountId: owner.id, wallet, input: { riskMode: 'balanced', slippageBps: 100 }, checked: { order: { execution: { amountIn: q.amountIn } } } });
    const result = await service().order(owner, order(q.id));
    expect(TradeOrderSchema.parse(result.order)).toMatchObject({ quoteId: q.id, status: 'awaiting_signature', feeBps: 0 });
    expect(result.tx).toEqual(binding().tx);
    const repeat = await service().order(owner, order(q.id));
    expect(repeat).toEqual({ ...result, duplicate: true });
    await expect(service().order(owner, order(q.id, { acknowledged: ['different-warning'] }))).rejects.toMatchObject({ code: 'conflict' });
    await expect(service().order(owner, order(q.id, { idempotencyKey: 'different-key' }))).rejects.toMatchObject({ code: 'conflict' });
  });
  it('looks up a persisted quote after closing and reopening the database with fresh service instances', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eko-075-restart-'));
    let handle = await openDb({ pgliteDir: dir });
    try {
      await runMigrations(handle);
      await handle.db.insert(accounts).values({ id: owner.id, kind: 'wallet', walletAddress: wallet });
      const before = new TradeService(handle.db, access, screen, backend, () => at);
      const q = await before.quote(owner, { coin: binding().coin, account: wallet, side: 'buy', amountUsd: 100, slippageBps: 100, riskMode: 'balanced' });
      await handle.close();
      handle = await openDb({ pgliteDir: dir });
      const after = new TradeService(handle.db, access, screen, { ...backend }, () => at);
      expect((await after.order(owner, order(q.id))).order.quoteId).toBe(q.id);
    } finally { await handle.close(); await rm(dir, { recursive: true, force: true }); }
  });
  it('serializes concurrent duplicates and conflicting quote/key claims in durable constraints', async () => {
    const q = await quote(); const replicas = [service(), service()];
    const results = await Promise.all(replicas.map(s => s.order(owner, order(q.id))));
    expect(results[0]!.order.id).toBe(results[1]!.order.id);
    expect(results.map(r => r.duplicate).sort()).toEqual([false, true]);
    const qs = await Promise.all([quote(), quote()]);
    const settled = await Promise.allSettled(qs.map(q => service().order(owner, order(q.id, { idempotencyKey: 'shared-conflicting-key' }))));
    expect(settled.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(settled.find(r => r.status === 'rejected')).toMatchObject({ reason: { code: 'conflict' } });
  });
  it('accepts the exact 15-second boundary only with fresh critical/account checks; refuses one ms later and expiry during acquisition', async () => {
    const q = await quote(); at += 15000;
    expect((await service().order(owner, order(q.id))).tx).toBeDefined();
    at++; await expect(service().order(owner, order(q.id))).rejects.toMatchObject({ code: 'quote_expired' });
    at = NOW; const racing = await quote(); acquisitionAdvance = 15001;
    await expect(service().order(owner, order(racing.id))).rejects.toMatchObject({ code: 'quote_expired' });
  });
  it('requires all and only this quote’s warnings, including on retries', async () => {
    warnings = [{ code: 'tax_control', status: 'warn', label: 'Tax can change' }];
    const q = await quote();
    await expect(service().order(owner, order(q.id))).rejects.toMatchObject({ code: 'guard_refused' });
    await expect(service().order(owner, order(q.id, { acknowledged: ['other'] }))).rejects.toMatchObject({ code: 'bad_request' });
    await expect(service().order(owner, order(q.id, { acknowledged: ['tax_control', 'tax_control'] }))).rejects.toMatchObject({ code: 'bad_request' });
    expect((await service().order(owner, order(q.id, { acknowledged: ['tax_control'] }))).tx).toBeDefined();
    const next = await quote(); await expect(service().order(owner, order(next.id))).rejects.toMatchObject({ code: 'guard_refused' });
  });
  it('refuses indicative and quote-only routes, missing ownership, wrong wallet and unavailable acquisition', async () => {
    const indicative = await quote({ account: undefined }); expect(indicative.binding).toBe(false);
    await expect(service().order(owner, order(indicative.id))).rejects.toMatchObject({ code: 'quote_changed' });
    const q = await quote(); await expect(service().order(other, order(q.id))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(service().order({ ...owner, wallet: other.wallet }, order(q.id))).rejects.toMatchObject({ code: 'wallet_mismatch' });
    await expect(service().order(owner, order('00000000-0000-4000-8000-000000000001'))).rejects.toMatchObject({ code: 'not_found' });
    await expect(quote({ account: other.wallet })).rejects.toMatchObject({ code: 'wallet_mismatch' });
    executable = false; const unavailable = await quote();
    await expect(service().order(owner, order(unavailable.id))).rejects.toMatchObject({ code: 'no_route' });
    await expect(new TradeService(built.ctx.dbh.db, access, screen).quote(owner, { coin: q.coin, side: 'buy', amountUsd: 100, slippageBps: 100 })).rejects.toMatchObject({ code: 'sim_unavailable' });
    fee = true; await expect(quote()).rejects.toMatchObject({ code: 'no_route' });
  });
  it.each(['paused', 'cap', 'allowlist', 'sanctioned', 'screening', 'critical', 'high', 'changed'] as const)('rechecks %s before returning bytes on duplicate orders', async kind => {
    const q = await quote(); await service().order(owner, order(q.id));
    let code = 'guard_refused';
    if (kind === 'paused') { enabled = false; code = 'trading_paused'; }
    if (kind === 'sanctioned') { denial = 'sanctioned'; code = 'sanctioned'; }
    if (kind === 'screening') { denial = 'stale_data'; code = 'stale_data'; }
    if (kind === 'critical') { criticalStale = true; code = 'stale_data'; }
    if (kind === 'high') high = true;
    if (kind === 'changed') { changed = true; code = 'quote_changed'; }
    if (kind === 'cap') { cfg.TRADE_MAX_USD = 99; code = 'trade_cap_exceeded'; }
    if (kind === 'allowlist') { await built.ctx.dbh.db.delete(tradingAllowlist).where(eq(tradingAllowlist.wallet, wallet)); code = 'not_allowlisted'; }
    try { await expect(service().order(owner, order(q.id))).rejects.toMatchObject({ code }); }
    finally { cfg.TRADE_MAX_USD = undefined; if (kind === 'allowlist') await built.ctx.dbh.db.insert(tradingAllowlist).values({ wallet, role: 'beta_user', capUsd: 100, addedBy: owner.id }); }
  });
  it('keeps an approval-only shortfall binding with its exact approval listed; orders wait for the allowance', async () => {
    allowance = '0'; approvals = [{ token: binding().coin, spender: binding().tx.to, amount: binding().amountIn, kind: 'erc20' }];
    const q = await quote({ side: 'sell' });
    expect(q).toMatchObject({ binding: true, guard: { decision: 'allow', checks: [] }, approvals });
    await expect(service().order(owner, order(q.id))).rejects.toMatchObject({ code: 'approval_required' });
    expect(await built.ctx.dbh.db.select().from(tradeOrders).where(eq(tradeOrders.quoteId, q.id))).toHaveLength(0);
    // The wallet approved exactly: the next quote lists nothing and the order returns bytes.
    allowance = null; approvals = [];
    const next = await quote({ side: 'sell' });
    expect(next).toMatchObject({ binding: true, approvals: [] });
    expect((await service().order(owner, order(next.id))).tx).toBeDefined();
    // A shortfall the quote does not list gives the wallet nothing to act on, so it stays a refusal.
    allowance = '0';
    expect(await quote({ side: 'sell' })).toMatchObject({ binding: false, guard: { decision: 'refuse', checks: [expect.objectContaining({ code: 'token_approval_required' })] } });
  });
  it('admits buys on the current verdict without Guard v2; a scan in progress is a retryable refusal; sells ignore the verdict', async () => {
    currentVerdict = { ...legacyVerdict, coin: binding().coin, level: 'monitor' };
    const admitted = await quote();
    expect(admitted).toMatchObject({ binding: true, guard: { decision: 'allow', checks: [] } });
    expect((await service().order(owner, order(admitted.id))).tx).toBeDefined();
    scanPending = true;
    const scanning = await quote();
    expect(scanning).toMatchObject({ binding: false, guard: { decision: 'refuse', checks: [{ code: 'scanning', status: 'refuse', label: expect.stringMatching(/still scanning/) }] } });
    // A quote admitted before the rescan was requested cannot be ordered until it finishes; the refusal is retryable.
    scanPending = false; const before = await quote(); scanPending = true;
    await expect(service().order(owner, order(before.id))).rejects.toMatchObject({ code: 'stale_data' });
    expect(preparationError('scanning')).toBe('stale_data');
    currentVerdict = { ...legacyVerdict, coin: binding().coin, level: 'danger' }; scanPending = false;
    expect(await quote()).toMatchObject({ binding: false, guard: { checks: [expect.objectContaining({ code: 'guard_danger' })] } });
    // Holders can always exit: a Danger verdict never reaches a sell.
    expect(await quote({ side: 'sell' })).toMatchObject({ binding: true, guard: { decision: 'allow' } });
  });
  it('requires a sell check for every live buy, never for sells', async () => {
    const strict = new TradeService(built.ctx.dbh.db, access, screen, backend, () => at, { requireSellCheck: true });
    const input = { coin: binding().coin, account: wallet, side: 'buy' as const, amountUsd: 100, slippageBps: 100, riskMode: 'balanced' as const };
    await expect(strict.quote(owner, input)).rejects.toMatchObject({ code: 'sim_unavailable', message: expect.stringContaining('sell check') });
    expect(await strict.quote(owner, { ...input, side: 'sell' })).toMatchObject({ binding: true });
  });
  it('names the missing live configuration when no acquisition backend is installed', async () => {
    const unconfigured = new TradeService(built.ctx.dbh.db, access, screen, undefined, () => at, { unavailable: 'Live trade quotes are not configured on this server' });
    await expect(unconfigured.quote(owner, { coin: binding().coin, account: wallet, side: 'buy', amountUsd: 100, slippageBps: 100, riskMode: 'balanced' }))
      .rejects.toMatchObject({ code: 'sim_unavailable', message: 'Live trade quotes are not configured on this server' });
  });
  it('caps the fresh measured actual size even when the request declared a smaller notional', async () => {
    const q = await quote(); measuredUsd = 101;
    await expect(service().order(owner, order(q.id))).rejects.toMatchObject({ code: 'trade_cap_exceeded' });
    expect(await built.ctx.dbh.db.select().from(tradeOrders).where(eq(tradeOrders.quoteId, q.id))).toHaveLength(0);
  });
  it('keeps paused quotes informational with verdict/fees; critical unavailable checks never create orders', async () => {
    enabled = false; const q = await quote(); expect(q).toMatchObject({ binding: false, guard: { decision: 'refuse' }, fee: { bps: 0 } });
    enabled = true; criticalStale = true; const stale = await quote(); expect(stale).toMatchObject({ binding: false, guard: { decision: 'refuse' } });
    await expect(service().order(owner, order(stale.id))).rejects.toMatchObject({ code: 'guard_refused' });
    expect(await built.ctx.dbh.db.select().from(tradeOrders).where(eq(tradeOrders.quoteId, stale.id))).toHaveLength(0);
  });
  it('registers strict HTTP routes with auth/origin/demo checks and bounded CA-8 errors', async () => {
    expect((await call('quote', { coin: wallet, side: 'buy', amountUsd: -1, slippageBps: 50 })).statusCode).toBe(422);
    expect((await call('quote', { coin: wallet, side: 'buy', amountUsd: 1, slippageBps: 50, checked: {} })).statusCode).toBe(422);
    expect((await call('order', order('00000000-0000-4000-8000-000000000001'), '')).statusCode).toBe(401);
    expect((await call('order', order('00000000-0000-4000-8000-000000000001'), cookie, 'https://evil.example')).statusCode).toBe(403);
    const demo = `${cookie}; eko_demo=${createDemoToken(['approvals'], secret)}`;
    expect((await call('order', order('00000000-0000-4000-8000-000000000001'), demo)).json().error).toBe('forbidden');
    // Router delegates to the same durable service, using offline acquisition fixtures.
    const response = await call('quote', { coin: binding().coin, account: wallet, side: 'buy', amountUsd: 100, slippageBps: 100 });
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.statusCode).toBe(200); expect(response.json()).toMatchObject({ binding: true, guard: { decision: 'allow' } });
    const q = response.json() as TradeQuote;
    expect((await call('order', order(q.id))).statusCode).toBe(201);
    expect((await call('order', order(q.id))).statusCode).toBe(200);
    expect((await call('order', order(q.id, { acknowledged: ['different'] }))).statusCode).toBe(409);
  });
});
