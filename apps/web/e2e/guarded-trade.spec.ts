import { expect, type Page } from '@playwright/test';
import { test } from './helpers';

/** Browser flow/wallet-spy fixtures, not live provider or chain evidence. No real keys are used. */
async function run(page: Page, scenario: string) {
  return page.evaluate(async scenario => {
    const flowPath = '/src/lib/tradeFlow.ts', apiPath = '/src/lib/api.ts', clientPath = '/src/lib/guardedTradeClient.ts', fixturePath = '/src/mocks/fixtures.ts';
    const { GuardedTradeFlow } = await import(flowPath) as typeof import('../src/lib/tradeFlow');
    const { createApi } = await import(apiPath) as typeof import('../src/lib/api');
    const { createGuardedTradeClient } = await import(clientPath) as typeof import('../src/lib/guardedTradeClient');
    const { createTradeQuote, createPublicConfig } = await import(fixturePath) as typeof import('../src/mocks/fixtures');
    const address = '0x00000000000000000000000000000000000000aa' as const, router = '0x00000000000000000000000000000000000000bb' as const;
    const hash = `0x${'ab'.repeat(32)}`, requests: string[] = [], walletRequests: string[] = [], approvalSteps: unknown[] = [], now = Date.now();
    let quote: import('@eko/shared').TradeQuote = { ...createTradeQuote(), id: 'displayed', account: address, binding: true, amountUsd: 100, approvals: [], amountIn: '100', valueWei: '0',
      fee: { bps: 0 as const, usd: 0, destination: null }, route: { venue: 'uniswap_v3' as const, executable: true }, expiresAt: new Date(now + 15000).toISOString(),
      guard: { decision: 'allow' as 'allow' | 'warn' | 'refuse', checks: [] as import('@eko/shared').TradeQuote['guard']['checks'] } };
    if (scenario === 'hard') quote.guard.decision = 'refuse';
    if (scenario === 'not_allowlisted') quote.guard = { decision: 'refuse', checks: [{ status: 'refuse', code: 'not_allowlisted', label: 'Admission' }] };
    if (scenario === 'quote_only') quote.route.executable = false;
    if (scenario === 'approved') quote.approvals = [{ token: address, spender: router, amount: '100', kind: 'erc20' }];
    if (scenario === 'warning') quote.guard = { decision: 'warn', checks: [{ status: 'warn', code: 'tax', label: 'Tax' }] };
    const input: import('@eko/shared').TradeQuoteRequest = { coin: quote.coin, side: quote.side, amountUsd: 100, slippageBps: 50, account: address };
    let quoteNumber = 0, orders = 0, order: import('@eko/shared').TradeOrder | null = null;
    const client = createGuardedTradeClient(createApi('/v1', async (url, init) => {
      requests.push(url); const body = init.body ? JSON.parse(String(init.body)) : {};
      let result: unknown;
      if (url.endsWith('/quote')) result = { ...quote, id: `refreshed-${++quoteNumber}` };
      else if (url === '/v1/trade/order') {
        order = { id: 'fixture-order', quoteId: body.quoteId, coin: quote.coin, side: quote.side, feeBps: 0, status: 'awaiting_signature', createdAt: new Date(now).toISOString() }; orders++;
        result = { order, tx: { chainId: 4663, to: router, data: '0xabcd', value: '0' } };
      } else if (url.endsWith('/submitted')) { order = { ...order!, status: 'submitted', txHash: hash }; result = { order }; }
      else if (url.endsWith('/rejected')) { order = { ...order!, status: 'rejected' }; result = { order }; }
      else { order = { ...order!, status: scenario === 'reject' ? 'rejected' : 'confirmed', filledIn: '98', filledOut: '92' }; result = { order }; }
      return new Response(JSON.stringify(result));
    }).parse);
    const env: import('../src/lib/tradeFlow').GuardedEnv = {
      current: () => ({ accountId: 'sample-browser', wallet: { address, chainId: 4663 }, verifiedWallet: address,
        config: { ...createPublicConfig(), trading: { liveEnabled: scenario !== 'paused', maxTradeUsd: 250, routers: [router], spenders: [router] } } }),
      client, now: () => Date.now(), storage: localStorage,
      approve: async (step, account, check) => { check(); approvalSteps.push({ ...step, account }); walletRequests.push('approve'); quote = { ...quote, approvals: [] }; return hash; },
      send: async (_tx, _account, check) => { check(); walletRequests.push('send'); if (scenario === 'reject') throw Object.assign(new Error('User rejected'), { code: 4001 }); return hash; },
      onOrder: () => undefined, onPhase: () => undefined, mismatch: () => undefined,
    };
    const flow = new GuardedTradeFlow(env);
    let errorCode: string | undefined, final: import('@eko/shared').TradeOrder | null = null;
    try { await flow.execute({ input, quote, acknowledged: [], requestedAt: now }); }
    catch (error) {
      const e = error as import('../src/lib/tradeFlow').TradeFlowError; errorCode = e.code;
      if (scenario === 'warning') {
        await flow.execute({ input, quote, acknowledged: ['tax'], requestedAt: now }).catch(async error => {
          const changed = error as import('../src/lib/tradeFlow').TradeFlowError;
          await flow.execute({ input, quote: changed.quote!, acknowledged: ['tax'], requestedAt: changed.requestedAt });
        });
      }
    }
    if (orders) final = await new GuardedTradeFlow(env).recover();
    return { errorCode, orders, requests, walletRequests, approvalSteps, final };
  }, scenario);
}
for (const scenario of ['hard', 'paused', 'not_allowlisted', 'quote_only']) test(`${scenario}: zero wallet requests`, async ({ page }) => {
  await page.goto('/radar'); const result = await run(page, scenario);
  expect(result.walletRequests).toEqual([]); expect(result.orders).toBe(0);
});
test('warning acknowledgement, clean confirmation and reload recovery', async ({ page }) => {
  await page.goto('/radar'); const result = await run(page, 'warning');
  expect(result.errorCode).toBe('needs_ack'); expect(result.walletRequests).toEqual(['send']); expect(result.orders).toBe(1);
  expect(result.final).toMatchObject({ status: 'confirmed', filledIn: '98', filledOut: '92' });
});
test('rejection recovers with no duplicate order or wallet request', async ({ page }) => {
  await page.goto('/radar'); const result = await run(page, 'reject');
  expect(result.errorCode).toBe('user_rejected'); expect(result.orders).toBe(1); expect(result.walletRequests).toEqual(['send']); expect(result.final?.status).toBe('rejected');
});

test('approved clean trade confirms exact approval and reconciles actual fill', async ({ page }) => {
  await page.goto('/radar'); const result = await run(page, 'approved');
  expect(result.walletRequests).toEqual(['approve', 'send']); expect(result.orders).toBe(1);
  expect(result.approvalSteps).toEqual([{ token: '0x00000000000000000000000000000000000000aa', spender: '0x00000000000000000000000000000000000000bb', amount: '100', kind: 'erc20', account: '0x00000000000000000000000000000000000000aa' }]);
  expect(result.final).toMatchObject({ status: 'confirmed', filledIn: '98', filledOut: '92' });
});
